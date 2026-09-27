package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/store"
	"github.com/JohanLindvall/Cascade/server/internal/torrentfile"
)

/* --------------------------------- add --------------------------------- */

// AddTorrentFile loads a .torrent and confirms it landed.
func (s *Service) AddTorrentFile(ctx context.Context, data []byte, options contracts.LoadOptions) error {
	return s.loads.run("session", func() error { return s.loadTorrentFile(ctx, data, options) })
}

func (s *Service) loadTorrentFile(ctx context.Context, data []byte, options contracts.LoadOptions) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	// rtorrent reports success for anything, so reject junk before handing
	// it over — otherwise a mistyped file just vanishes.
	parsed, err := torrentfile.Parse(data)
	if err != nil {
		return httperr.New(http.StatusBadRequest, err.Error())
	}
	dialect := s.caps.Dialect()
	method := dialect.LoadRaw
	if options.Start {
		method = dialect.LoadRawStart
	}
	params := append([]any{"", data}, s.loadCommands(options)...)
	if _, err := s.client.Call(ctx, method, params...); err != nil {
		return err
	}
	// load.* is queued rather than immediate, so confirm the torrent
	// actually landed instead of assuming it did.
	landed, err := s.waitForTorrent(ctx, parsed.InfoHash, 3*time.Second)
	if err != nil {
		return err
	}
	if !landed {
		name := parsed.Name
		if name == "" {
			name = parsed.InfoHash
		}
		return httperr.Newf(http.StatusBadGateway, `rtorrent did not accept "%s" — see the rtorrent log`, name)
	}
	return nil
}

// waitForTorrent polls briefly for a hash to appear in the session.
func (s *Service) waitForTorrent(ctx context.Context, hash string, timeout time.Duration) (bool, error) {
	deadline := s.now().Add(timeout)
	for {
		results, err := s.client.MulticallSettled(ctx, []rtorrent.Call{call("d.hash", hash)})
		if err != nil {
			return false, err
		}
		if results[0].Err == nil && strings.ToUpper(rtorrent.Text(results[0].Value)) == hash {
			return true, nil
		}
		if !s.now().Before(deadline) {
			return false, nil
		}
		if err := sleep(ctx, 150*time.Millisecond); err != nil {
			return false, err
		}
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var (
	fetchable = regexp.MustCompile(`(?i)^(magnet:\?|https?://|ftp://)`)
	magnet    = regexp.MustCompile(`(?i)^magnet:`)
)

// AddTorrentURL loads a magnet link or a torrent URL and confirms it landed.
func (s *Service) AddTorrentURL(ctx context.Context, url string, options contracts.LoadOptions) error {
	// URL loads have no known hash. Concurrent additions through this service
	// must not satisfy another URL's "a new torrent appeared" confirmation.
	return s.loads.run("session", func() error { return s.loadTorrentURL(ctx, url, options) })
}

func (s *Service) loadTorrentURL(ctx context.Context, url string, options contracts.LoadOptions) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	// load.* silently queues whatever it is given; a link rtorrent cannot
	// fetch would just vanish, so refuse anything that is not fetchable up
	// front.
	link := strings.TrimSpace(url)
	if !fetchable.MatchString(link) {
		return httperr.Newf(http.StatusBadRequest,
			`"%s" is not a magnet link or a torrent URL (magnet:, http(s):, ftp:)`, prefix(link, 80))
	}
	dialect := s.caps.Dialect()
	method := dialect.LoadURL
	if options.Start {
		method = dialect.LoadURLStart
	}
	params := append([]any{"", link}, s.loadCommands(options)...)

	// A magnet carries its own info hash, so the load can be confirmed
	// exactly. For a fetched URL there is nothing to compare against, so note
	// what the session held first and watch for something new to appear.
	wanted := torrentfile.MagnetInfoHash(link)
	if magnet.MatchString(link) && wanted == "" {
		return httperr.New(http.StatusBadRequest, "magnet link must contain a valid xt=urn:btih: info hash")
	}
	if wanted != "" {
		if _, err := s.client.Call(ctx, method, params...); err != nil {
			return err
		}
		landed, err := s.waitForTorrent(ctx, wanted, 3*time.Second)
		if err != nil || landed {
			return err
		}
		return httperr.Newf(http.StatusBadGateway, "rtorrent did not accept the magnet for %s — see the rtorrent log", wanted)
	}

	before, err := s.sessionHashes(ctx)
	if err != nil {
		return err
	}
	if _, err := s.client.Call(ctx, method, params...); err != nil {
		return err
	}
	// rtorrent has to fetch the file first, so allow longer than a raw
	// upload. The wait is bounded, so the wording admits that a slow fetch
	// may still land rather than claiming the link is definitely broken.
	appeared, err := s.waitForNewTorrent(ctx, before, 10*time.Second)
	if err != nil || appeared {
		return err
	}
	return httperr.Newf(http.StatusBadGateway,
		`rtorrent loaded nothing from "%s" within 10s — the link may need a login, may not point at a .torrent, `+
			`or may already be loaded. Check the rtorrent log; if it was merely slow it may still appear.`, prefix(link, 120))
}

// prefix is at most n characters of text.
func prefix(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n])
}

// sessionHashes is every info hash currently in the session.
func (s *Service) sessionHashes(ctx context.Context) (map[string]bool, error) {
	dialect := s.caps.Dialect()
	rows, err := s.client.FieldMulticall(ctx, dialect.DownloadMulticall, dialect.DownloadMulticallPrefix("main"), []string{"d.hash"})
	if err != nil {
		return nil, err
	}
	hashes := make(map[string]bool, len(rows))
	for _, row := range rows {
		hashes[strings.ToUpper(rtorrent.Text(row["d.hash"]))] = true
	}
	return hashes, nil
}

// waitForNewTorrent polls until a hash the session did not have before
// turns up.
func (s *Service) waitForNewTorrent(ctx context.Context, before map[string]bool, timeout time.Duration) (bool, error) {
	deadline := s.now().Add(timeout)
	for {
		hashes, err := s.sessionHashes(ctx)
		if err != nil {
			return false, err
		}
		for hash := range hashes {
			if !before[hash] {
				return true, nil
			}
		}
		if !s.now().Before(deadline) {
			return false, nil
		}
		if err := sleep(ctx, 250*time.Millisecond); err != nil {
			return false, err
		}
	}
}

func (s *Service) loadCommands(options contracts.LoadOptions) []any {
	commands := []any{}
	if options.Directory != "" {
		commands = append(commands, `d.directory.set="`+escapeArg(options.Directory)+`"`)
	}
	if options.Label != "" && s.caps.Supports("labels") {
		commands = append(commands, `d.custom1.set="`+escapeArg(encodeURIComponent(options.Label))+`"`)
	}
	return commands
}

// escapeArg quotes for rtorrent's command parser, which uses double quotes
// around loading commands.
func escapeArg(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`)
}

// encodeURIComponent is the browser's: labels live URL-encoded in d.custom1
// (the ruTorrent convention), and other clients decode them the same way.
func encodeURIComponent(text string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(text); i++ {
		c := text[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

/* ------------------------------- actions ------------------------------- */

// Action starts, stops, pauses, resumes, rechecks or announces a torrent.
func (s *Service) Action(ctx context.Context, hash, action string) error {
	return s.torrentWrites.run(hash, func() error { return s.performAction(ctx, hash, action) })
}

func (s *Service) performAction(ctx context.Context, hash, action string) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	var calls []rtorrent.Call
	switch action {
	case "start":
		calls = append(calls, call("d.open", hash), call("d.start", hash))
	case "stop":
		calls = append(calls, call("d.stop", hash), call("d.close", hash))
	case "pause":
		calls = append(calls, call("d.pause", hash))
	case "resume":
		calls = append(calls, call("d.resume", hash))
	case "recheck", "recheck-restart":
		calls = append(calls, call("d.stop", hash))
		// A stale error ("registered as completed, but hash check returned
		// unfinished chunks") outranks everything in the status derivation,
		// so left in place it hides the very check the user just started.
		// The check writes its own message if it fails again.
		if s.caps.Has("d.message.set") {
			calls = append(calls, call("d.message.set", hash, ""))
		}
		calls = append(calls, call("d.check_hash", hash))
	case "announce":
		if !s.caps.Supports("trackerAnnounce") {
			return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.tracker_announce")
		}
		calls = append(calls, call("d.tracker_announce", hash))
	default:
		return httperr.Newf(http.StatusBadRequest, `unknown action "%s"`, action)
	}
	for _, c := range calls {
		if !s.caps.Has(c.Method) {
			return httperr.Newf(http.StatusNotImplemented, "this rtorrent build does not expose %s", c.Method)
		}
	}
	if action != "announce" {
		s.pendingRestarts.cancel(hash)
	}
	// Lifecycle commands must be separate, ordered requests (rtorrent 0.15.2
	// can crash when lifecycle changes and setters share a multicall).
	for _, c := range calls {
		if _, err := s.client.Call(ctx, c.Method, c.Params...); err != nil {
			return err
		}
	}
	// The restart half cannot happen here: the check runs for as long as the
	// disk takes, far past this request. The poll tick watches for the end.
	if action == "recheck-restart" {
		s.pendingRestarts.add(hash, s.now())
	}
	return nil
}

// processPendingRestarts starts whatever finished its recheck since the last
// tick — the second half of "recheck & restart". Reads and starts share the
// torrent's mutation queue so a later stop cannot be overtaken. Starts remain
// separate calls (quirk 5: lifecycle mixes in one multicall have segfaulted
// rtorrent).
func (s *Service) processPendingRestarts(ctx context.Context) error {
	if s.pendingRestarts.size() == 0 {
		return nil
	}
	for _, hash := range s.pendingRestarts.hashes() {
		err := s.torrentWrites.run(hash, func() error {
			if !s.pendingRestarts.has(hash) {
				return nil
			}
			results, err := s.client.MulticallSettled(ctx, []rtorrent.Call{call("d.hashing", hash)})
			if err != nil {
				return err
			}
			var hashing *float64
			if results[0].Err == nil {
				reading := results[0].Number()
				hashing = &reading
			}
			if s.pendingRestarts.step(hash, hashing, s.now()) != restartStart {
				return nil
			}
			_, err = s.client.Call(ctx, "d.open", hash)
			if err == nil {
				_, err = s.client.Call(ctx, "d.start", hash)
			}
			if err != nil {
				log.Printf("[cascade] recheck finished but %s would not start: %v", hash, err)
			} else {
				log.Printf("[cascade] recheck finished, restarted %s", hash)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Remove erases a torrent, and with deleteData its data as well — only inside
// the data roots.
func (s *Service) Remove(ctx context.Context, hash string, deleteData bool) error {
	return s.torrentWrites.run(hash, func() error { return s.removeTorrent(ctx, hash, deleteData) })
}

func (s *Service) removeTorrent(ctx context.Context, hash string, deleteData bool) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	dataPath := ""
	if deleteData {
		if !s.cfg.AllowDataDelete {
			return httperr.New(http.StatusForbidden, "deleting torrent data is disabled (CASCADE_ALLOW_DATA_DELETE=0)")
		}
		basePath, err := s.client.Call(ctx, "d.base_path", hash)
		if err != nil {
			return err
		}
		// Refused before the torrent is erased: rejecting the path afterwards
		// left the metadata gone and the data behind — the one combination the
		// user did not ask for. An empty base path (never started) has nothing
		// to check or delete.
		if base := rtorrent.Text(basePath); base != "" {
			if dataPath, err = assertDeletable(base, s.cfg.DeleteRoots); err != nil {
				return err
			}
		}
	}
	if _, err := s.client.Call(ctx, "d.erase", hash); err != nil {
		return err
	}
	s.pendingRestarts.cancel(hash)
	s.store.Forget(hash)
	if dataPath != "" {
		if _, err := assertDeletable(dataPath, s.cfg.DeleteRoots); err != nil {
			return err
		}
		return os.RemoveAll(dataPath)
	}
	return nil
}

func (s *Service) SetPriority(ctx context.Context, hash string, priority int64) error {
	_, err := s.client.Call(ctx, "d.priority.set", hash, priority)
	return err
}

func (s *Service) SetLabel(ctx context.Context, hash, label string) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("labels") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.custom1")
	}
	_, err := s.client.Call(ctx, "d.custom1.set", hash, encodeURIComponent(label))
	return err
}

// SetTorrentThrottle assigns a torrent to a throttle group.
func (s *Service) SetTorrentThrottle(ctx context.Context, hash, name string) error {
	return s.torrentWrites.run(hash, func() error { return s.changeTorrentThrottle(ctx, hash, name) })
}

func (s *Service) changeTorrentThrottle(ctx context.Context, hash, name string) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("perTorrentThrottle") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.throttle_name")
	}
	// rtorrent rejects a throttle change while the download is running
	// ("Cannot set throttle on active download"), so bounce it around the
	// set. These go out as separate requests on purpose: batching
	// stop/set/start into one system.multicall segfaults rtorrent 0.15.2.
	state, err := s.client.Call(ctx, "d.is_active", hash)
	if err != nil {
		return err
	}
	wasActive := rtorrent.Number(state) != 0
	if wasActive {
		if _, err := s.client.Call(ctx, "d.stop", hash); err != nil {
			return err
		}
	}
	if _, err := s.client.Call(ctx, "d.throttle_name.set", hash, name); err != nil {
		if wasActive {
			_, _ = s.client.Call(ctx, "d.start", hash)
		}
		return err
	}
	if wasActive {
		if _, err := s.client.Call(ctx, "d.start", hash); err != nil {
			return err
		}
	}
	_, err = s.client.Call(ctx, "d.save_full_session", hash)
	return err
}

// SetTorrentSlots sets a torrent's upload and download slot limits; a nil
// count is left as it is.
func (s *Service) SetTorrentSlots(ctx context.Context, hash string, uploads, downloads *int64) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if (uploads != nil && !s.caps.Supports("perTorrentMaxUploads")) ||
		(downloads != nil && !s.caps.Supports("perTorrentMaxDownloads")) {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support the requested per-torrent slot setting")
	}
	var calls []rtorrent.Call
	if uploads != nil {
		calls = append(calls, call("d.uploads_max.set", hash, *uploads))
	}
	if downloads != nil {
		calls = append(calls, call("d.downloads_max.set", hash, *downloads))
	}
	if len(calls) == 0 {
		return nil
	}
	_, err := s.client.Multicall(ctx, calls)
	return err
}

// SetDirectory moves where a torrent's data is looked for. The data itself
// is not moved.
func (s *Service) SetDirectory(ctx context.Context, hash, directory string) error {
	return s.torrentWrites.run(hash, func() error {
		if err := s.caps.Ensure(ctx); err != nil {
			return err
		}
		if !s.caps.Supports("perTorrentDirectory") {
			return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support changing a torrent directory")
		}
		// Close before changing paths: rtorrent refuses an open download whose
		// files were moved, and frozen file paths must be rebuilt on next
		// open. Leave it stopped so the owner can move the data and recheck
		// it first.
		if err := s.performAction(ctx, hash, "stop"); err != nil {
			return err
		}
		if _, err := s.client.Call(ctx, "d.directory.set", hash, directory); err != nil {
			return err
		}
		_, err := s.client.Call(ctx, "d.save_full_session", hash)
		return err
	})
}

func (s *Service) SetFilePriority(ctx context.Context, hash string, index int, priority int64) error {
	_, err := s.client.Multicall(ctx, []rtorrent.Call{
		call("f.priority.set", hash+":f"+strconv.Itoa(index), priority),
		call("d.update_priorities", hash),
	})
	return err
}

func (s *Service) SetTrackerEnabled(ctx context.Context, hash string, index int, enabled bool) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("trackerToggle") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose t.is_enabled.set")
	}
	flag := 0
	if enabled {
		flag = 1
	}
	_, err := s.client.Call(ctx, "t.is_enabled.set", hash+":t"+strconv.Itoa(index), flag)
	return err
}

func (s *Service) AddTracker(ctx context.Context, hash, url string, group int64) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("trackerInsert") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.tracker.insert")
	}
	_, err := s.client.Multicall(ctx, []rtorrent.Call{
		call("d.tracker.insert", hash, max(0, group), url),
		call("d.save_full_session", hash),
	})
	return err
}

/* ------------------------------- settings ------------------------------- */

// Settings reads every global setting this backend can report.
func (s *Service) Settings(ctx context.Context) (map[string]any, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	usable := rtorrent.ReadableSettings(s.caps.Resolve)
	calls := make([]rtorrent.Call, len(usable))
	for i, setting := range usable {
		calls[i] = call(setting.Getter)
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	settings := map[string]any{}
	for i, setting := range usable {
		if results[i].Err == nil {
			settings[setting.Key] = rtorrent.DecodeSettingValue(setting.Key, results[i].Value)
		}
	}
	return settings, nil
}

// UpdateSettings applies a settings patch through whatever setters this
// backend has.
func (s *Service) UpdateSettings(ctx context.Context, patch any) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	calls, err := rtorrent.SettingEntries(patch, s.caps.Resolve)
	if err != nil || len(calls) == 0 {
		return err
	}
	_, err = s.client.Multicall(ctx, calls)
	return err
}

/* ---------------------------- throttle groups --------------------------- */

// throttleCalls sets a group's rates. Unlike the global .max_rate.set,
// throttle.up/down take whole KiB/s strings.
func throttleCalls(group contracts.ThrottleGroup) ([]rtorrent.Call, error) {
	normalized, err := store.NormalizeThrottle(group)
	if err != nil {
		return nil, err
	}
	return []rtorrent.Call{
		call("throttle.up", "", group.Name, strconv.FormatInt(normalized.Up/1024, 10)),
		call("throttle.down", "", group.Name, strconv.FormatInt(normalized.Down/1024, 10)),
	}, nil
}

func (s *Service) throttle(name string) (contracts.ThrottleGroup, bool) {
	for _, group := range s.store.Throttles() {
		if group.Name == name {
			return group, true
		}
	}
	return contracts.ThrottleGroup{}, false
}

func (s *Service) SaveThrottle(ctx context.Context, group contracts.ThrottleGroup) error {
	return s.throttleWrites.run(group.Name, func() error { return s.writeThrottle(ctx, group) })
}

// PatchThrottle changes a saved group's rates; a nil rate is left as it is.
func (s *Service) PatchThrottle(ctx context.Context, name string, up, down *int64) error {
	return s.throttleWrites.run(name, func() error {
		group, ok := s.throttle(name)
		if !ok {
			return httperr.Newf(http.StatusNotFound, `no throttle group named "%s"`, name)
		}
		if up != nil {
			group.Up = *up
		}
		if down != nil {
			group.Down = *down
		}
		return s.writeThrottle(ctx, group)
	})
}

func (s *Service) writeThrottle(ctx context.Context, group contracts.ThrottleGroup) error {
	normalized, err := store.NormalizeThrottle(group)
	if err != nil {
		return err
	}
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("throttleGroups") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support throttle groups")
	}
	calls, err := throttleCalls(normalized)
	if err != nil {
		return err
	}
	if _, err := s.client.Multicall(ctx, calls); err != nil {
		return err
	}
	s.store.UpsertThrottle(normalized)
	return nil
}

func (s *Service) DeleteThrottle(ctx context.Context, name string) error {
	return s.throttleWrites.run(name, func() error {
		if err := s.caps.Ensure(ctx); err != nil {
			return err
		}
		// throttle.up creates a group it does not know, so unlimiting a name
		// the store never saved would conjure one up rather than remove
		// anything.
		if _, ok := s.throttle(name); !ok {
			return httperr.Newf(http.StatusNotFound, `no throttle group named "%s"`, name)
		}
		if s.caps.Supports("throttleGroups") {
			// rtorrent cannot drop a throttle group at runtime; unlimit it
			// instead so torrents still assigned to it are no longer
			// restricted.
			if _, err := s.client.Multicall(ctx, []rtorrent.Call{
				call("throttle.up", "", name, "0"),
				call("throttle.down", "", name, "0"),
			}); err != nil {
				return err
			}
		}
		s.store.RemoveThrottle(name)
		return nil
	})
}

// ThrottleRates is each saved group's current throughput.
func (s *Service) ThrottleRates(ctx context.Context) (map[string]contracts.ThrottleRate, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rates := map[string]contracts.ThrottleRate{}
	groups := s.store.Throttles()
	if len(groups) == 0 || !s.caps.Has("throttle.up.rate") || !s.caps.Has("throttle.down.rate") {
		return rates, nil
	}
	calls := make([]rtorrent.Call, 0, 2*len(groups))
	for _, group := range groups {
		calls = append(calls, call("throttle.up.rate", "", group.Name), call("throttle.down.rate", "", group.Name))
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	for i, group := range groups {
		rates[group.Name] = contracts.ThrottleRate{
			Up:   int64(results[2*i].Number()),
			Down: int64(results[2*i+1].Number()),
		}
	}
	return rates, nil
}

/* --------------------------------- log --------------------------------- */

const logTailBytes = 512 * 1024

// Log is the tail of the rtorrent log. It reads only the end — the log grows
// without bound.
func (s *Service) Log(_ context.Context, lines int) ([]string, error) {
	file, err := os.Open(s.cfg.LogFile)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	start := max(0, info.Size()-logTailBytes)
	data, err := io.ReadAll(io.NewSectionReader(file, start, info.Size()-start))
	if err != nil {
		return nil, err
	}
	rows := []string{}
	for _, row := range strings.Split(strings.ToValidUTF8(string(data), "\uFFFD"), "\n") {
		if row != "" {
			rows = append(rows, row)
		}
	}
	if start > 0 && len(rows) > 0 {
		rows = rows[1:] // The first row is almost certainly cut mid-line.
	}
	if lines = max(0, lines); len(rows) > lines {
		rows = rows[len(rows)-lines:]
	}
	return rows, nil
}
