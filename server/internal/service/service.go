// Package service is all of Cascade's application behaviour, expressed in
// terms of rtorrent commands chosen through the capability probe.
package service

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/game"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/store"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	lightning "github.com/JohanLindvall/lightning/pkg/json"
)

const historyLength = 180

// LogScopes are the log scopes the UI may attach at runtime, which is also
// the input allowlist: rtorrent faults on a name it does not know, and there
// is no reason to let arbitrary strings ride to it.
//
// This is a union across the supported releases, because the subsystem
// groups moved — measured against real builds rather than guessed at: 0.9.8
// has connection/dht/peer/tracker_debug and no tracker_events, while 0.16.20
// dropped those four and offers tracker_events instead; the six severities
// plus storage_debug, torrent_debug and rpc_events exist in both. There is no
// command that lists groups and attaching is the only probe (and cannot be
// undone), so the offer is the union and a scope this build refuses is
// reported by name rather than sinking the batch.
var LogScopes = []string{
	"critical",
	"error",
	"warn",
	"notice",
	"info",
	"debug",
	"connection_debug",
	"dht_debug",
	"peer_debug",
	"rpc_events",
	"storage_debug",
	"torrent_debug",
	"tracker_debug",
	"tracker_events",
}

// SanitizeLogScopes keeps the known scopes of a request, in catalog order,
// deduplicated.
func SanitizeLogScopes(input []string) []string {
	out := []string{}
	for _, scope := range LogScopes {
		if slices.Contains(input, scope) {
			out = append(out, scope)
		}
	}
	return out
}

// Service is Cascade's application behaviour; it implements httpapi.Service.
type Service struct {
	cfg    config.Config
	store  *store.Store
	client rtorrent.Client
	caps   *rtorrent.Capabilities

	mu      sync.Mutex
	history []contracts.RateSample
	// Scopes attached to the log during this rtorrent session. Cleared when
	// the connection drops: a restarted rtorrent has forgotten them.
	attachedScopes map[string]bool

	polling             chan struct{} // closed to stop the poller; nil while stopped
	bootSettingsApplied atomic.Bool
	throttlesApplied    atomic.Bool
	logScopesApplied    atomic.Bool
	lastGameUpdate      atomic.Int64 // unix milliseconds

	pendingRestarts pendingRestarts
	torrentWrites   serialTasks
	throttleWrites  serialTasks
	loads           serialTasks
	stateRead       flight[contracts.StateResponse]
	torrentRead     flight[[]contracts.Torrent]

	now func() time.Time
}

// New builds the service. The client defaults to the configured SCGI
// endpoint; tests pass a scripted one.
func New(cfg config.Config, st *store.Store, client rtorrent.Client) *Service {
	if client == nil {
		client = rtorrent.NewClient(cfg.SCGI, nil)
	}
	return &Service{
		cfg:    cfg,
		store:  st,
		client: client,
		caps: rtorrent.NewCapabilities(client, rtorrent.FieldLists{
			Torrent: rtorrent.TorrentFields,
			File:    rtorrent.FileFields,
			Peer:    rtorrent.PeerFields,
			Tracker: rtorrent.TrackerFields,
		}),
		history:        []contracts.RateSample{},
		attachedScopes: map[string]bool{},
		now:            time.Now,
	}
}

// call is one command; a nil params list still goes out as an empty one.
func call(method string, params ...any) rtorrent.Call {
	if params == nil {
		params = []any{}
	}
	return rtorrent.Call{Method: method, Params: params}
}

/* ------------------------------ lifecycle ------------------------------ */

// Start samples rates and runs the housekeeping on a timer. Ticks are chained
// rather than scheduled on an interval: a slow or hung rtorrent (the SCGI
// timeout is 30s) would otherwise stack a tick per interval behind the
// request queue.
func (s *Service) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.polling != nil {
		return
	}
	stop := make(chan struct{})
	s.polling = stop
	go func() {
		for {
			s.tick()
			select {
			case <-stop:
				return
			case <-time.After(s.cfg.PollInterval):
			}
		}
	}()
}

// Stop ends the housekeeping; a tick in flight finishes on its own.
func (s *Service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.polling != nil {
		close(s.polling)
		s.polling = nil
	}
}

func (s *Service) tick() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	err := func() error {
		if err := s.sampleRates(ctx); err != nil {
			return err
		}
		if !s.bootSettingsApplied.Load() {
			if err := s.applyBootSettings(ctx); err != nil {
				return err
			}
		}
		if !s.throttlesApplied.Load() {
			if err := s.reapplyThrottles(ctx); err != nil {
				return err
			}
		}
		if !s.logScopesApplied.Load() {
			if err := s.reapplyLogScopes(ctx); err != nil {
				return err
			}
		}
		if err := s.processPendingRestarts(ctx); err != nil {
			return err
		}
		// Keep lifetime counters moving even when no browser is watching.
		if s.cfg.Gamify && s.now().UnixMilli()-s.lastGameUpdate.Load() > 30_000 {
			if _, err := s.Torrents(ctx, "main"); err != nil {
				return err
			}
		}
		return nil
	}()
	if err != nil {
		// Whatever failed, rtorrent may have restarted underneath: everything
		// it forgets on a restart is put back once it answers again.
		s.throttlesApplied.Store(false)
		s.bootSettingsApplied.Store(false)
		s.logScopesApplied.Store(false)
		s.mu.Lock()
		clear(s.attachedScopes)
		s.mu.Unlock()
		s.caps.Invalidate()
	}
}

func (s *Service) sampleRates(ctx context.Context) error {
	results, err := s.client.Multicall(ctx, []rtorrent.Call{
		call("throttle.global_down.rate"),
		call("throttle.global_up.rate"),
	})
	if err != nil {
		return err
	}
	down, up := int64(rtorrent.Number(results[0])), int64(rtorrent.Number(results[1]))
	s.mu.Lock()
	s.history = append(s.history, contracts.RateSample{T: s.now().Unix(), Down: down, Up: up})
	if over := len(s.history) - historyLength; over > 0 {
		s.history = append([]contracts.RateSample(nil), s.history[over:]...)
	}
	s.mu.Unlock()
	if s.cfg.Gamify {
		s.store.RecordRates(float64(down), float64(up))
	}
	return nil
}

// applyBootSettings applies the settings passed as docker env vars.
//
// These deliberately do not go into rtorrent.rc: rtorrent aborts on an
// unknown command in its config file, and the available commands differ
// between 0.9.x, 0.10.x and 0.15.x. Routing them through UpdateSettings means
// the capability probe silently drops whatever this build lacks.
func (s *Service) applyBootSettings(ctx context.Context) error {
	s.bootSettingsApplied.Store(true)
	raw, err := os.ReadFile(s.cfg.BootSettingsFile)
	if err != nil {
		return nil // Nothing to apply.
	}
	parsed, err := lightning.DecodeAny(raw)
	if err != nil {
		log.Printf("[cascade] ignoring malformed %s: %v", s.cfg.BootSettingsFile, err)
		return nil
	}
	patch, err := validate.Record(parsed, "startup settings")
	if err != nil {
		log.Printf("[cascade] ignoring malformed %s: %v", s.cfg.BootSettingsFile, err)
		return nil
	}
	if len(patch) == 0 {
		return nil
	}
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	unsupported := rtorrent.UnsupportedSettingKeys(keys, s.caps.Resolve)
	if err := s.UpdateSettings(ctx, patch); err != nil {
		log.Printf("[cascade] could not apply startup settings: %v", err)
		return nil
	}
	log.Printf("[cascade] applied %d startup setting(s) from the environment", len(keys)-len(unsupported))
	if len(unsupported) > 0 {
		log.Printf("[cascade] rtorrent %s does not support: %s", s.caps.Info().ClientVersion, strings.Join(unsupported, ", "))
	}
	return nil
}

// reapplyThrottles puts our throttle groups back: rtorrent drops them on
// restart.
func (s *Service) reapplyThrottles(ctx context.Context) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("throttleGroups") {
		s.throttlesApplied.Store(true)
		return nil
	}
	groups := s.store.Throttles()
	errs := make([]error, len(groups))
	var wg sync.WaitGroup
	for i, group := range groups {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = s.throttleWrites.run(group.Name, func() error {
				current, ok := s.throttle(group.Name)
				if !ok {
					return nil
				}
				calls, err := throttleCalls(current)
				if err == nil {
					_, err = s.client.Multicall(ctx, calls)
				}
				return err
			})
		}()
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return err
	}
	s.throttlesApplied.Store(true)
	return nil
}

// reapplyLogScopes puts the UI's log scopes back: rtorrent forgets runtime
// log outputs on restart.
func (s *Service) reapplyLogScopes(ctx context.Context) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	s.logScopesApplied.Store(true)
	if !s.caps.Supports("logScopes") {
		return nil
	}
	extra := SanitizeLogScopes(s.store.LogScopes())
	if len(extra) == 0 {
		return nil
	}
	failed, err := s.attachScopes(ctx, extra)
	if err != nil {
		return err
	}
	if len(failed) > 0 {
		// Kept in the store all the same: a scope this build refuses may be
		// one the next build accepts, and losing the owner's choice over a
		// version change would be the quieter, worse failure.
		log.Printf("[cascade] this rtorrent has no log scope(s): %s", strings.Join(failed, ", "))
	}
	return nil
}

var scopeSeparators = regexp.MustCompile(`[,\s]+`)

// LogScopes is the log's scope state.
func (s *Service) LogScopes() contracts.LogScopeState {
	// What RT_LOG_LEVEL baked into rtorrent.rc at container start — shown as
	// fixed, since the rc reasserts it on every rtorrent start.
	boot := []string{}
	for _, scope := range scopeSeparators.Split(s.cfg.LogLevel, -1) {
		if scope = strings.TrimSpace(scope); scope != "" {
			boot = append(boot, scope)
		}
	}
	return contracts.LogScopeState{
		Boot:      boot,
		Extra:     SanitizeLogScopes(s.store.LogScopes()),
		Available: slices.Clone(LogScopes),
		Supported: s.caps.Supports("logScopes"),
	}
}

// SetLogScopes sets the scopes raised on top of RT_LOG_LEVEL.
//
// Raising is live: log.add_output attaches a scope to the running log.
// Lowering is not — rtorrent has no command to detach one — so a removed
// scope keeps writing until rtorrent restarts, and is simply not put back
// afterwards. The dialog says as much rather than pretending.
func (s *Service) SetLogScopes(ctx context.Context, requested []string) (contracts.LogScopeChange, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return contracts.LogScopeChange{}, err
	}
	if !s.caps.Supports("logScopes") {
		return contracts.LogScopeChange{}, httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose log.add_output")
	}
	scopes := SanitizeLogScopes(requested)
	previous := s.store.LogScopes()
	// A scope this build refuses must not sink the rest: the subsystem groups
	// differ between releases (see LogScopes), so one stale name is ordinary,
	// not exceptional. What took is kept; what did not is named.
	failed, err := s.attachScopes(ctx, scopes)
	if err != nil {
		return contracts.LogScopeChange{}, err
	}
	kept := []string{}
	for _, scope := range scopes {
		if !slices.Contains(failed, scope) {
			kept = append(kept, scope)
		}
	}
	s.store.SetLogScopes(kept)
	// What was on and stays on for this rtorrent session despite being
	// switched off — there is nothing to detach it with.
	stillActive := []string{}
	s.mu.Lock()
	for _, scope := range previous {
		if !slices.Contains(scopes, scope) && s.attachedScopes[scope] && !slices.Contains(stillActive, scope) {
			stillActive = append(stillActive, scope)
		}
	}
	s.mu.Unlock()
	return contracts.LogScopeChange{LogScopeState: s.LogScopes(), StillActive: stillActive, Failed: failed}, nil
}

// attachScopes attaches scopes to the running log and returns the ones this
// build refused.
func (s *Service) attachScopes(ctx context.Context, scopes []string) ([]string, error) {
	s.mu.Lock()
	missing := []string{}
	for _, scope := range scopes {
		if !s.attachedScopes[scope] {
			missing = append(missing, scope)
		}
	}
	s.mu.Unlock()
	failed := []string{}
	if len(missing) == 0 {
		return failed, nil
	}
	calls := make([]rtorrent.Call, len(missing))
	for i, scope := range missing {
		// "cascade" is the output the entrypoint opened in rtorrent.rc.
		calls[i] = call("log.add_output", "", scope, "cascade")
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, scope := range missing {
		if results[i].Err != nil {
			failed = append(failed, scope)
		} else {
			s.attachedScopes[scope] = true
		}
	}
	return failed, nil
}

/* -------------------------------- reads -------------------------------- */

// Ready reports whether rtorrent has answered the capability probe.
func (s *Service) Ready() bool { return s.caps.Ready() }

func (s *Service) EnsureCapabilities(ctx context.Context) error { return s.caps.Ensure(ctx) }

func (s *Service) MethodNames() []string { return s.caps.MethodNames() }

func (s *Service) Client() rtorrent.Client { return s.client }

// State is what the UI shows: the list, the global status, the throttle
// groups and the game. Several pages can ask together; they share one read.
func (s *Service) State(ctx context.Context) (contracts.StateResponse, error) {
	// The shared read outlives any one caller that gives up on it.
	shared := context.WithoutCancel(ctx)
	return s.stateRead.do(func() (contracts.StateResponse, error) {
		if err := s.caps.Ensure(shared); err != nil {
			return contracts.StateResponse{}, err
		}
		torrents, err := s.Torrents(shared, "main")
		if err != nil {
			return contracts.StateResponse{}, err
		}
		status, err := s.status(shared, torrents)
		if err != nil {
			return contracts.StateResponse{}, err
		}
		return contracts.StateResponse{
			Status:    status,
			Torrents:  torrents,
			Throttles: s.store.Throttles(),
			Game:      s.Game(),
		}, nil
	})
}

// updateGame folds the current list into the lifetime stats and unlocks
// what is earned.
func (s *Service) updateGame(torrents []contracts.Torrent) {
	if !s.cfg.Gamify {
		return
	}
	now := s.now()
	s.lastGameUpdate.Store(now.UnixMilli())
	s.store.RecordTorrents(torrents)
	for _, id := range game.NewlyUnlocked(s.store.Stats(), s.store.UnlockedAchievements()) {
		s.store.Unlock(id, now.Unix())
	}
}

func (s *Service) Game() contracts.GameState {
	return game.BuildState(s.store.Stats(), s.store.UnlockedAchievements(), s.cfg.Gamify)
}

// Torrents lists a view. The main view is shared among concurrent readers,
// and only it may drive the bookkeeping.
func (s *Service) Torrents(ctx context.Context, view string) ([]contracts.Torrent, error) {
	if view != "main" {
		return s.readTorrents(ctx, view)
	}
	shared := context.WithoutCancel(ctx)
	return s.torrentRead.do(func() ([]contracts.Torrent, error) { return s.readTorrents(shared, view) })
}

func (s *Service) readTorrents(ctx context.Context, view string) ([]contracts.Torrent, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	dialect := s.caps.Dialect()
	rows, err := s.client.FieldMulticall(ctx, dialect.DownloadMulticall, dialect.DownloadMulticallPrefix(view), dialect.TorrentFields)
	if err != nil {
		return nil, err
	}
	seenAt := s.now().Unix()
	live := make(map[string]bool, len(rows))
	torrents := make([]contracts.Torrent, 0, len(rows))
	for _, row := range rows {
		hash := rtorrent.Text(row["d.hash"])
		live[hash] = true
		torrents = append(torrents, rtorrent.MapTorrent(row, s.store.AddedAt(hash, seenAt)))
	}
	// Only the complete list may drive pruning: a filtered view would look
	// like every other torrent had been removed and erase its bookkeeping.
	if view == "main" {
		s.store.Prune(live)
		s.updateGame(torrents)
	}
	return torrents, nil
}

// Status is the global status on its own.
func (s *Service) Status(ctx context.Context) (contracts.GlobalStatus, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return contracts.GlobalStatus{}, err
	}
	torrents, err := s.Torrents(ctx, "main")
	if err != nil {
		return contracts.GlobalStatus{}, err
	}
	return s.status(ctx, torrents)
}

func (s *Service) status(ctx context.Context, torrents []contracts.Torrent) (contracts.GlobalStatus, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return contracts.GlobalStatus{}, err
	}
	methods := []string{
		"throttle.global_down.rate",
		"throttle.global_up.rate",
		"throttle.global_down.total",
		"throttle.global_up.total",
		"throttle.global_down.max_rate",
		"throttle.global_up.max_rate",
		"network.listen.port",
		"directory.default",
	}
	if s.caps.Supports("dhtStatistics") {
		methods = append(methods, "dht.statistics")
	}
	calls := make([]rtorrent.Call, len(methods))
	for i, method := range methods {
		calls[i] = call(method)
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return contracts.GlobalStatus{}, err
	}
	// Answers are looked up by command rather than by position, so an entry
	// added above another cannot silently shift it into the wrong slot.
	answer := func(method string) rtorrent.Result {
		if i := slices.Index(methods, method); i >= 0 && i < len(results) {
			return results[i]
		}
		return rtorrent.Result{Err: errors.New("not asked")}
	}
	number := func(method string) int64 { return int64(answer(method).Number()) }

	var dhtNodes int64
	if dht := answer("dht.statistics"); dht.Err == nil {
		if stats, ok := dht.Value.(map[string]any); ok {
			dhtNodes = int64(rtorrent.Number(stats["active_nodes"]))
		}
	}
	downloadDir := ""
	if directory := answer("directory.default"); directory.Err == nil {
		switch v := directory.Value.(type) {
		case []byte:
			downloadDir = string(v)
		case string:
			downloadDir = v
		}
	}
	active := 0
	for _, t := range torrents {
		if t.Status == contracts.StatusDownloading || t.Status == contracts.StatusSeeding {
			active++
		}
	}
	statePollMs := s.cfg.StatePollMs
	if preferred := s.store.Preferences().StatePollMs; preferred != nil {
		statePollMs = *preferred
	}
	s.mu.Lock()
	history := slices.Clone(s.history)
	s.mu.Unlock()
	return contracts.GlobalStatus{
		// A successful read proves the connection is up even before the first
		// background tick or just after recovery.
		Connected:          true,
		DownRate:           number("throttle.global_down.rate"),
		UpRate:             number("throttle.global_up.rate"),
		DownTotal:          number("throttle.global_down.total"),
		UpTotal:            number("throttle.global_up.total"),
		DownLimit:          number("throttle.global_down.max_rate"),
		UpLimit:            number("throttle.global_up.max_rate"),
		TorrentCount:       len(torrents),
		ActiveCount:        active,
		DHTNodes:           dhtNodes,
		ListenPort:         number("network.listen.port"),
		DiskFree:           freeSpace(s.cfg.DownloadDir),
		DownloadDir:        downloadDir,
		Policy:             contracts.Policy{RawRPC: s.cfg.AllowRawRPC, DeleteData: s.cfg.AllowDataDelete},
		StatePollMs:        statePollMs,
		StatePollDefaultMs: s.cfg.StatePollMs,
		Backend:            s.BackendSummary(),
		History:            history,
	}, nil
}

func (s *Service) BackendSummary() contracts.BackendSummary {
	info := s.caps.Info()
	return contracts.BackendSummary{
		ClientVersion:  info.ClientVersion,
		LibraryVersion: info.LibraryVersion,
		APIVersion:     info.APIVersion,
		Flavor:         info.Flavor,
		MethodCount:    info.MethodCount,
		RPCFacility:    info.RPCFacility,
		Endpoint:       s.client.Endpoint(),
		Supports:       info.Supports,
	}
}

func (s *Service) Files(ctx context.Context, hash string) ([]contracts.TorrentFile, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.client.FieldMulticall(ctx, "f.multicall", []any{hash, ""}, s.caps.Dialect().FileFields)
	if err != nil {
		return nil, err
	}
	files := make([]contracts.TorrentFile, len(rows))
	for i, row := range rows {
		files[i] = rtorrent.MapFile(row, i)
	}
	return files, nil
}

func (s *Service) Peers(ctx context.Context, hash string) ([]contracts.Peer, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.client.FieldMulticall(ctx, "p.multicall", []any{hash, ""}, s.caps.Dialect().PeerFields)
	if err != nil {
		return nil, err
	}
	peers := make([]contracts.Peer, len(rows))
	for i, row := range rows {
		peers[i] = rtorrent.MapPeer(row)
	}
	return peers, nil
}

func (s *Service) Trackers(ctx context.Context, hash string) ([]contracts.Tracker, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.client.FieldMulticall(ctx, "t.multicall", []any{hash, ""}, s.caps.Dialect().TrackerFields)
	if err != nil {
		return nil, err
	}
	trackers := make([]contracts.Tracker, len(rows))
	for i, row := range rows {
		trackers[i] = rtorrent.MapTracker(row, i)
	}
	return trackers, nil
}

// TrackerHosts is the primary tracker host per torrent, used for the sidebar
// grouping.
func (s *Service) TrackerHosts(ctx context.Context, hashes []string) (map[string]string, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	hosts := make(map[string]string, len(hashes))
	if len(hashes) == 0 {
		return hosts, nil
	}
	calls := make([]rtorrent.Call, len(hashes))
	for i, hash := range hashes {
		calls[i] = call("t.multicall", hash, "", "t.url=")
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	for i, hash := range hashes {
		rows, ok := results[i].Value.([]any)
		if results[i].Err != nil || !ok || len(rows) == 0 {
			hosts[hash] = "unknown"
			continue
		}
		url := rtorrent.Text(rows[0])
		if first, isRow := rows[0].([]any); isRow {
			url = ""
			if len(first) > 0 {
				url = rtorrent.Text(first[0])
			}
		}
		hosts[hash] = rtorrent.TrackerHost(url)
	}
	return hosts, nil
}
