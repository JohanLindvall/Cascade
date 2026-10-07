// SPDX-License-Identifier: MIT

package service

// The service is where rtorrent's quirks are worked around, so what these pin
// is mostly what must *not* reach rtorrent: an erase before the data path was
// checked, a load of something unfetchable, an unlimit that would conjure a
// throttle group, a setter without its empty-string target. The restart half
// of "recheck & restart" is a pure decision fed by d.hashing readings, with
// its own timing traps below.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent/rtorrenttest"
	"github.com/JohanLindvall/Cascade/server/internal/store"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

var hash = strings.Repeat("A", 40)

var ctx = context.Background()

func backend(extra ...string) *rtorrenttest.FakeClient {
	return rtorrenttest.New(rtorrenttest.Answers{
		"system.listMethods":            rtorrenttest.MethodList(extra...),
		"system.client_version":         "0.16.20",
		"system.library_version":        "0.16.20",
		"system.api_version":            "12",
		"throttle.global_down.rate":     1200,
		"throttle.global_up.rate":       300,
		"throttle.global_down.total":    5000,
		"throttle.global_up.total":      2000,
		"throttle.global_down.max_rate": 0,
		"throttle.global_up.max_rate":   1024,
		"network.listen.port":           50000,
		"directory.default":             "/downloads",
		"protocol.pex":                  1,
		"d.multicall2":                  []any{},
	})
}

func testConfig(t *testing.T, change func(*config.Config)) config.Config {
	t.Helper()
	root := t.TempDir()
	downloads := filepath.Join(root, "downloads")
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Host:             "127.0.0.1",
		BasePath:         "/",
		WebRoot:          filepath.Join(root, "web"),
		StateFile:        filepath.Join(root, "state.json"),
		DownloadDir:      downloads,
		DeleteRoots:      []string{downloads},
		AllowRawRPC:      true,
		AllowDataDelete:  true,
		MaxUploadBytes:   1024 * 1024,
		PollInterval:     time.Second,
		StatePollMs:      500,
		LogFile:          filepath.Join(root, "rtorrent.log"),
		LogLevel:         "info",
		BootSettingsFile: filepath.Join(root, "boot-settings.json"),
		Gamify:           true,
	}
	if change != nil {
		change(&cfg)
	}
	return cfg
}

type subject struct {
	*Service
	cfg   config.Config
	store *store.Store
}

func newService(t *testing.T, client *rtorrenttest.FakeClient, change func(*config.Config)) subject {
	t.Helper()
	cfg := testConfig(t, change)
	st := store.Open(filepath.Join(t.TempDir(), "state.json"))
	return subject{New(cfg, st, client), cfg, st}
}

// status is the HTTP status an error would reach the client with.
func status(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		return 200
	}
	var failure *httperr.Error
	if errors.As(err, &failure) {
		return failure.Status
	}
	t.Fatalf("not an HTTP error: %v", err)
	return 0
}

func params(calls []rtorrent.Call, i int) []any {
	if i >= len(calls) {
		return nil
	}
	return calls[i].Params
}

func methodsOf(calls []rtorrent.Call, prefix string) []string {
	out := []string{}
	for _, c := range calls {
		if strings.HasPrefix(c.Method, prefix) {
			out = append(out, c.Method)
		}
	}
	return out
}

func TestSimultaneousThrottleEditsPreserveTheOtherLimit(t *testing.T) {
	s := newService(t, backend(), nil)
	if err := s.SaveThrottle(ctx, contracts.ThrottleGroup{Name: "group", Up: 1024, Down: 2048}); err != nil {
		t.Fatal(err)
	}
	up, down := int64(4096), int64(8192)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = s.PatchThrottle(ctx, "group", &up, nil) }()
	go func() { defer wg.Done(); _ = s.PatchThrottle(ctx, "group", nil, &down) }()
	wg.Wait()
	if got := s.store.Throttles(); !reflect.DeepEqual(got, []contracts.ThrottleGroup{{Name: "group", Up: 4096, Down: 8192}}) {
		t.Fatalf("%v", got)
	}
}

/* ----------------------------- pending restarts ----------------------------- */

func reading(n float64) *float64 { return &n }

func TestTheOrdinaryArcIsQueuedCheckingFinishedStartedOnce(t *testing.T) {
	var p pendingRestarts
	now := time.Now()
	p.add(hash, now)
	for i, c := range []struct {
		hashing *float64
		want    restartStep
	}{
		{reading(1), restartWait},  // queued counts as running
		{reading(3), restartWait},  // checking
		{reading(0), restartStart}, // first zero after that: done
		{reading(0), restartDrop},  // never twice
	} {
		if got := p.step(hash, c.hashing, now); got != c.want {
			t.Fatalf("step %d: %v, want %v", i, got, c.want)
		}
	}
	if p.size() != 0 {
		t.Fatal("still pending")
	}
}

func TestACheckFasterThanThePollStillRestartsAfterTheZeroFloor(t *testing.T) {
	var p pendingRestarts
	now := time.Now()
	p.add(hash, now)
	for i := 1; i < restartZeroReadsFloor; i++ {
		if got := p.step(hash, reading(0), now); got != restartWait {
			t.Fatalf("zero reading %d must still wait, got %v", i, got)
		}
	}
	if got := p.step(hash, reading(0), now); got != restartStart {
		t.Fatalf("got %v", got)
	}
}

func TestASlowQueueDoesNotTripTheFloorOnceHashingIsSeen(t *testing.T) {
	var p pendingRestarts
	now := time.Now()
	p.add(hash, now)
	for i, c := range []struct {
		hashing float64
		want    restartStep
	}{{0, restartWait}, {0, restartWait}, {2, restartWait}, {0, restartStart}} {
		if got := p.step(hash, reading(c.hashing), now); got != c.want {
			t.Fatalf("step %d: %v, want %v", i, got, c.want)
		}
	}
}

func TestATorrentThatCannotBeAskedIsDroppedNotRestarted(t *testing.T) {
	var p pendingRestarts
	p.add(hash, time.Now())
	if got := p.step(hash, nil, time.Now()); got != restartDrop || p.size() != 0 {
		t.Fatalf("%v, %d pending", got, p.size())
	}
}

func TestAWaitPastTheCeilingExpires(t *testing.T) {
	var p pendingRestarts
	start := time.Unix(1, 0)
	p.add(hash, start)
	if got := p.step(hash, reading(2), start.Add(time.Second)); got != restartWait {
		t.Fatalf("%v", got)
	}
	if got := p.step(hash, reading(2), start.Add(restartMaxAge+time.Millisecond)); got != restartDrop {
		t.Fatalf("%v", got)
	}
}

func TestAnUnknownHashAnswersDropAndDisturbsNothing(t *testing.T) {
	var p pendingRestarts
	p.add(hash, time.Now())
	if got := p.step(strings.Repeat("B", 40), reading(0), time.Now()); got != restartDrop || p.size() != 1 {
		t.Fatalf("%v, %d pending", got, p.size())
	}
}

func TestLogScopesPassOnlyTheCatalogInCatalogOrderOnce(t *testing.T) {
	if got := SanitizeLogScopes([]string{"tracker_debug", "debug", "tracker_debug", "made_up"}); !reflect.DeepEqual(got, []string{"debug", "tracker_debug"}) {
		t.Errorf("%v", got)
	}
	if got := SanitizeLogScopes(nil); got == nil || len(got) != 0 {
		t.Errorf("%#v", got)
	}
	if got := SanitizeLogScopes(LogScopes); !reflect.DeepEqual(got, LogScopes) {
		t.Errorf("%v", got)
	}
}

func TestSerialTasksOrderAResourceAndReleaseOnFailure(t *testing.T) {
	var tasks serialTasks
	var mu sync.Mutex
	events := []string{}
	record := func(event string) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	}
	gate := make(chan struct{})
	firstStarted := make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- tasks.run("a", func() error { record("first"); close(firstStarted); <-gate; return errors.New("failed") })
	}()
	<-firstStarted
	second := make(chan error, 1)
	go func() { second <- tasks.run("a", func() error { record("second"); return nil }) }()
	if err := tasks.run("b", func() error { record("independent"); return nil }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	if !reflect.DeepEqual(events, []string{"first", "independent"}) {
		t.Fatalf("before release: %v", events)
	}
	mu.Unlock()
	close(gate)
	if err := <-first; err == nil || err.Error() != "failed" {
		t.Fatalf("first: %v", err)
	}
	if err := <-second; err != nil {
		t.Fatalf("second: %v", err)
	}
	if !reflect.DeepEqual(events, []string{"first", "independent", "second"}) {
		t.Fatalf("after: %v", events)
	}
}

/* --------------------------------- reads --------------------------------- */

func TestStatusReadsTheGaugesByCommandAndTheDownloadDirectory(t *testing.T) {
	s := newService(t, backend(), nil)
	result, err := s.status(ctx, []contracts.Torrent{})
	if err != nil {
		t.Fatal(err)
	}
	if result.DownRate != 1200 || result.UpRate != 300 || result.DownTotal != 5000 || result.UpLimit != 1024 ||
		result.ListenPort != 50000 || result.DownloadDir != "/downloads" || result.DHTNodes != 0 {
		t.Errorf("%+v", result)
	}
	if result.Backend.ClientVersion != "0.16.20" || !result.Backend.Supports["labels"] {
		t.Errorf("%+v", result.Backend)
	}
	if result.Policy != (contracts.Policy{RawRPC: true, DeleteData: true}) || !result.Connected {
		t.Errorf("%+v", result.Policy)
	}
	if result.StatePollMs != 500 || result.StatePollDefaultMs != 500 || result.DiskFree == nil {
		t.Errorf("poll %d/%d disk %v", result.StatePollMs, result.StatePollDefaultMs, result.DiskFree)
	}
}

func TestStatusReportsThePolicyTheServerEnforces(t *testing.T) {
	s := newService(t, backend(), func(c *config.Config) { c.AllowRawRPC, c.AllowDataDelete = false, false })
	result, err := s.status(ctx, []contracts.Torrent{})
	if err != nil || result.Policy != (contracts.Policy{}) {
		t.Fatalf("%+v %v", result.Policy, err)
	}
}

func TestThePollIntervalPreferenceOverridesTheServerDefault(t *testing.T) {
	s := newService(t, backend(), nil)
	s.store.UpdatePreferences(map[string]any{"statePollMs": float64(2000)})
	result, err := s.status(ctx, []contracts.Torrent{})
	if err != nil || result.StatePollMs != 2000 || result.StatePollDefaultMs != 500 {
		t.Fatalf("%d/%d %v", result.StatePollMs, result.StatePollDefaultMs, err)
	}
}

func TestDHTStatisticsAreOnlyAskedForWhenTheBackendHasThem(t *testing.T) {
	for want, answer := range map[int64]map[string]any{
		// What 0.16.25 answered with DHT running (0.9.8 has the same keys):
		// the routing table's node count is "nodes".
		73: {"active": 1, "buckets": 14, "bytes_read": 0, "bytes_written": 0, "cycle": 2, "dht": "on", "errors_caught": 2,
			"errors_received": 6, "nodes": 73, "peers": 0, "peers_max": 0, "queries_received": 3, "queries_sent": 263,
			"replies_received": 121, "throttle": "", "torrents": 0},
		// With DHT off rtorrent leaves the counters out altogether.
		0: {"active": 0, "dht": "off", "throttle": ""},
	} {
		client := backend("dht.statistics").Answer("dht.statistics", answer)
		result, err := newService(t, client, nil).status(ctx, []contracts.Torrent{})
		if err != nil || result.DHTNodes != want || len(client.CallsTo("dht.statistics")) != 1 {
			t.Fatalf("%d, want %d: %v", result.DHTNodes, want, err)
		}
	}
	bare := backend()
	if _, err := newService(t, bare, nil).status(ctx, []contracts.Torrent{}); err != nil {
		t.Fatal(err)
	}
	if len(bare.CallsTo("dht.statistics")) != 0 {
		t.Fatal("asked a backend without it")
	}
}

func TestSettingsReadOnlyWhatThisBackendCanReportDecodedByKind(t *testing.T) {
	s := newService(t, backend(), nil)
	settings, err := s.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if settings["pex"] != true || settings["uploadRate"] != int64(1024) || settings["downloadRate"] != int64(0) {
		t.Errorf("%v", settings)
	}
	for _, key := range []string{"maxPeers", "encryption"} { // no getter here / write-only
		if _, ok := settings[key]; ok {
			t.Errorf("%s was read", key)
		}
	}
}

func TestConcurrentStateReadersShareOneSnapshotAndOneFold(t *testing.T) {
	release := make(chan struct{})
	var reads atomic.Int32
	client := backend().Answer("d.multicall2", func([]any) any {
		reads.Add(1)
		<-release
		return []any{[]any{hash, "example"}}
	})
	s := newService(t, client, nil)
	results := make(chan contracts.StateResponse, 2)
	for range 2 {
		go func() {
			state, err := s.State(ctx)
			if err != nil {
				t.Error(err)
			}
			results <- state
		}()
	}
	time.Sleep(100 * time.Millisecond) // both readers are in, one of them waiting
	close(release)
	a, b := <-results, <-results
	if !reflect.DeepEqual(a, b) || reads.Load() != 1 {
		t.Fatalf("%d reads", reads.Load())
	}
	if s.store.Stats().EverAdded != 1 || !a.Status.Connected || len(a.Torrents) != 1 || a.Torrents[0].Name != "example" {
		t.Fatalf("%+v", a)
	}
}

func TestAFilteredViewNeverPrunesTheBookkeeping(t *testing.T) {
	client := backend().Answer("d.multicall2", []any{[]any{hash, "example"}})
	s := newService(t, client, nil)
	if _, err := s.Torrents(ctx, "main"); err != nil {
		t.Fatal(err)
	}
	added := s.store.AddedAt(hash, 1)
	client.Answer("d.multicall2", []any{})
	if _, err := s.Torrents(ctx, "stopped"); err != nil {
		t.Fatal(err)
	}
	if s.store.AddedAt(hash, 2) != added {
		t.Fatal("a filtered view forgot the torrent")
	}
}

/* --------------------------------- writes -------------------------------- */

func TestUpdateSettingsSendsEachSetterWithTheEmptyTargetAndSkipsTheUnsupported(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if err := s.UpdateSettings(ctx, map[string]any{"downloadRate": float64(2048), "pex": false, "dhtMode": "auto"}); err != nil {
		t.Fatal(err)
	}
	if got := params(client.CallsTo("throttle.global_down.max_rate.set"), 0); !reflect.DeepEqual(got, []any{"", int64(2048)}) {
		t.Errorf("%#v", got)
	}
	if got := params(client.CallsTo("protocol.pex.set"), 0); !reflect.DeepEqual(got, []any{"", int64(0)}) {
		t.Errorf("%#v", got)
	}
	if len(client.CallsTo("dht.mode.set")) != 0 {
		t.Error("an unsupported setter was called")
	}
}

func TestStartupSettingsAreAppliedThroughTheSameFilter(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if err := os.WriteFile(s.cfg.BootSettingsFile, []byte(`{"downloadRate":4096,"dhtMode":"off"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.applyBootSettings(ctx); err != nil {
		t.Fatal(err)
	}
	if got := params(client.CallsTo("throttle.global_down.max_rate.set"), 0); !reflect.DeepEqual(got, []any{"", int64(4096)}) {
		t.Fatalf("%#v", got)
	}
	// A malformed file is skipped, not fatal.
	_ = os.WriteFile(s.cfg.BootSettingsFile, []byte(`[1,2]`), 0o644)
	if err := s.applyBootSettings(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestAnUnknownActionIsA400AndReachesNothing(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if got := status(t, s.Action(ctx, hash, "explode")); got != 400 || len(client.CallsTo("d.stop")) != 0 {
		t.Fatalf("%d", got)
	}
}

func TestStartOpensThenStartsAndAnnounceIsRefusedWhereMissing(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if err := s.Action(ctx, hash, "start"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(params(client.CallsTo("d.open"), 0), []any{hash}) || !reflect.DeepEqual(params(client.CallsTo("d.start"), 0), []any{hash}) {
		t.Fatalf("%v", client.Calls())
	}
	if got := status(t, s.Action(ctx, hash, "announce")); got != 501 || len(client.CallsTo("d.tracker_announce")) != 0 {
		t.Fatalf("%d", got)
	}
}

func TestRecheckClearsTheStaleMessageAndRegistersTheRestart(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if err := s.Action(ctx, hash, "recheck-restart"); err != nil {
		t.Fatal(err)
	}
	if len(client.CallsTo("d.check_hash")) != 1 || !reflect.DeepEqual(params(client.CallsTo("d.message.set"), 0), []any{hash, ""}) {
		t.Fatalf("%v", client.Calls())
	}
	if !s.pendingRestarts.has(hash) {
		t.Fatal("the restart was not registered")
	}
}

func TestRecheckClearsTheOldMessageBeforeAskingForTheCheck(t *testing.T) {
	client := backend()
	if err := newService(t, client, nil).Action(ctx, hash, "recheck"); err != nil {
		t.Fatal(err)
	}
	methods := methodsOf(client.Calls(), "d.")
	stop, clear, check := slices.Index(methods, "d.stop"), slices.Index(methods, "d.message.set"), slices.Index(methods, "d.check_hash")
	if stop < 0 || stop > clear || clear > check {
		t.Fatalf("%v", methods)
	}
}

func TestRecheckAndRestartStartsTheTorrentWhenTheCheckEnds(t *testing.T) {
	var readings atomic.Int32
	client := backend("d.hashing").Answer("d.hashing", func([]any) any {
		if readings.Add(1) == 1 {
			return 1 // the first poll sees the check running
		}
		return 0
	})
	s := newService(t, client, func(c *config.Config) { c.PollInterval, c.Gamify = time.Millisecond, false })
	if err := s.Action(ctx, hash, "recheck-restart"); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Stop()
	deadline := time.Now().Add(2 * time.Second)
	for len(client.CallsTo("d.start")) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := methodsOf(client.Calls(), "d.open"); len(got) != 1 || len(client.CallsTo("d.start")) != 1 {
		t.Fatalf("%v", methodsOf(client.Calls(), "d."))
	}
}

func TestStoppingOrRecheckingAgainCancelsAPendingRestart(t *testing.T) {
	for _, action := range []string{"stop", "pause", "recheck"} {
		client := backend("d.pause", "d.hashing").Answer("d.hashing", 0)
		s := newService(t, client, func(c *config.Config) { c.PollInterval, c.Gamify = time.Millisecond, false })
		if err := s.Action(ctx, hash, "recheck-restart"); err != nil {
			t.Fatal(err)
		}
		if err := s.Action(ctx, hash, action); err != nil {
			t.Fatal(err)
		}
		s.Start()
		time.Sleep(25 * time.Millisecond)
		s.Stop()
		if len(client.CallsTo("d.start")) != 0 || len(client.CallsTo("d.hashing")) != 0 {
			t.Errorf("%s: %v", action, methodsOf(client.Calls(), "d."))
		}
	}
}

func TestALinkRtorrentCouldNotFetchIsRefusedBeforeAnyLoad(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	for _, link := range []string{"not a link", "file:///etc/passwd"} {
		if got := status(t, s.AddTorrentURL(ctx, link, contracts.LoadOptions{Start: true})); got != 400 {
			t.Errorf("%s: %d", link, got)
		}
	}
	if got := status(t, s.AddTorrentURL(ctx, "magnet:?dn=no+hash", contracts.LoadOptions{Start: true})); got != 400 {
		t.Errorf("a magnet without a hash: %d", got)
	}
	if len(client.CallsTo("load.start")) != 0 {
		t.Fatal("something was loaded")
	}
}

func TestAMagnetLoadIsConfirmedByItsOwnHashWithTheLabelEncoded(t *testing.T) {
	client := loadedBy(backend(), "load.start", hash)
	s := newService(t, client, nil)
	err := s.AddTorrentURL(ctx, "magnet:?xt=urn:btih:"+strings.ToLower(hash), contracts.LoadOptions{
		Start: true, Label: "tv shows", Directory: "/downloads/tv",
	})
	if err != nil {
		t.Fatal(err)
	}
	load := params(client.CallsTo("load.start"), 0)
	if len(load) != 4 || load[0] != "" { // the target argument, quirk 1
		t.Fatalf("%#v", load)
	}
	if want := []any{`d.directory.set="/downloads/tv"`, `d.custom1.set="tv%20shows"`}; !reflect.DeepEqual(load[2:], want) {
		t.Fatalf("%#v", load[2:])
	}
}

// fastClock makes every wait of the service time out after a few polls.
func fastClock(s subject) {
	var ticks atomic.Int64
	start := time.Now()
	s.now = func() time.Time { return start.Add(time.Duration(ticks.Add(1)) * time.Second) }
}

func TestAMagnetRtorrentNeverListsIsA502NamingTheHash(t *testing.T) {
	client := backend().Answer("d.hash", &xmlrpc.Fault{Code: -501, Message: "Could not find info-hash."})
	s := newService(t, client, nil)
	fastClock(s)
	err := s.AddTorrentURL(ctx, "magnet:?xt=urn:btih:"+hash, contracts.LoadOptions{Start: true})
	if status(t, err) != 502 || !strings.Contains(err.Error(), hash) {
		t.Fatalf("%v", err)
	}
}

func TestAURLLoadIsConfirmedByANewHashAppearing(t *testing.T) {
	var loaded atomic.Bool
	client := backend().
		Answer("load.start", func([]any) any { loaded.Store(true); return 0 }).
		Answer("d.multicall2", func([]any) any {
			if loaded.Load() {
				return []any{[]any{hash}}
			}
			return []any{}
		})
	s := newService(t, client, nil)
	if err := s.AddTorrentURL(ctx, "https://example.test/a.torrent", contracts.LoadOptions{Start: true}); err != nil {
		t.Fatal(err)
	}
	// Nothing new appearing is a 502 that admits it may still be slow.
	stale := newService(t, backend(), nil)
	fastClock(stale)
	err := stale.AddTorrentURL(ctx, "https://example.test/b.torrent", contracts.LoadOptions{Start: true})
	if status(t, err) != 502 || !strings.Contains(err.Error(), "within 10s") {
		t.Fatalf("%v", err)
	}
}

func TestAnUploadThatIsNotATorrentIsA400AndNeverReachesLoadRaw(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if got := status(t, s.AddTorrentFile(ctx, []byte("junk"), contracts.LoadOptions{Start: true})); got != 400 {
		t.Fatalf("%d", got)
	}
	if len(client.CallsTo("load.raw_start")) != 0 {
		t.Fatal("junk was loaded")
	}
}

/* -------------------------------- removal -------------------------------- */

func TestDataOutsideTheDeleteRootsIsRefusedBeforeTheErase(t *testing.T) {
	client := backend().Answer("d.base_path", "/etc")
	s := newService(t, client, nil)
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 || len(client.CallsTo("d.erase")) != 0 {
		t.Fatalf("%d; erase must not run for a refused path", got)
	}
}

func TestTheDataRootItselfIsNeverDeleted(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	client.Answer("d.base_path", s.cfg.DownloadDir)
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 || len(client.CallsTo("d.erase")) != 0 {
		t.Fatalf("%d", got)
	}
}

func TestDataInsideARootIsErasedAndRemovedAndTheBookkeepingForgotten(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	release := filepath.Join(s.cfg.DownloadDir, "release")
	if err := os.Mkdir(release, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(release, "a.bin"), []byte("x"), 0o644)
	client.Answer("d.base_path", release)
	s.store.AddedAt(hash, 1)
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if len(client.CallsTo("d.erase")) != 1 {
		t.Fatal("not erased")
	}
	if _, err := os.Stat(release); !os.IsNotExist(err) {
		t.Fatal("the data is still there")
	}
	if s.store.AddedAt(hash, 9) != 9 {
		t.Fatal("the bookkeeping was kept")
	}
}

func TestDataDeletionCanBeSwitchedOffEntirely(t *testing.T) {
	client := backend()
	s := newService(t, client, func(c *config.Config) { c.AllowDataDelete = false })
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 || len(client.CallsTo("d.base_path")) != 0 {
		t.Fatalf("%d", got)
	}
	if err := s.Remove(ctx, hash, false); err != nil || len(client.CallsTo("d.erase")) != 1 {
		t.Fatalf("plain removal: %v", err)
	}
}

func TestAnAncestorSymlinkOutsideTheRootsIsRefusedBeforeErasing(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	outside := filepath.Join(filepath.Dir(s.cfg.DownloadDir), "outside")
	_ = os.Mkdir(outside, 0o755)
	_ = os.WriteFile(filepath.Join(outside, "keep"), []byte("important"), 0o644)
	if err := os.Symlink(outside, filepath.Join(s.cfg.DownloadDir, "link")); err != nil {
		t.Fatal(err)
	}
	client.Answer("d.base_path", filepath.Join(s.cfg.DownloadDir, "link", "keep"))
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 || len(client.CallsTo("d.erase")) != 0 {
		t.Fatalf("%d", got)
	}
	if data, _ := os.ReadFile(filepath.Join(outside, "keep")); string(data) != "important" {
		t.Fatal("the file outside was touched")
	}
	client.Answer("d.base_path", filepath.Join(s.cfg.DownloadDir, "link", "missing"))
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 {
		t.Fatalf("a missing file under the link: %d", got)
	}
}

func TestASymlinkAliasOfARootCannotDeleteTheRootButFilesWithinWork(t *testing.T) {
	client := backend()
	base := newService(t, client, nil)
	alias := filepath.Join(filepath.Dir(base.cfg.DownloadDir), "alias")
	if err := os.Symlink(base.cfg.DownloadDir, alias); err != nil {
		t.Fatal(err)
	}
	cfg := base.cfg
	cfg.DeleteRoots = []string{alias}
	s := New(cfg, base.store, client)
	client.Answer("d.base_path", alias)
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 {
		t.Fatalf("%d", got)
	}
	_ = os.WriteFile(filepath.Join(alias, "file"), []byte("x"), 0o644)
	client.Answer("d.base_path", filepath.Join(alias, "file"))
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(base.cfg.DownloadDir, "file")); !os.IsNotExist(err) {
		t.Fatal("the file is still there")
	}
}

func TestChangingADirectoryClosesFirstAndLeavesItStopped(t *testing.T) {
	client := backend("d.directory.set", "d.save_full_session")
	s := newService(t, client, nil)
	if err := s.SetDirectory(ctx, hash, "/downloads/moved"); err != nil {
		t.Fatal(err)
	}
	var got []rtorrent.Call
	for _, c := range client.Calls() {
		if strings.HasPrefix(c.Method, "d.") {
			got = append(got, c)
		}
	}
	want := []rtorrent.Call{
		{Method: "d.stop", Params: []any{hash}},
		{Method: "d.close", Params: []any{hash}},
		{Method: "d.directory.set", Params: []any{hash, "/downloads/moved"}},
		{Method: "d.save_full_session", Params: []any{hash}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	unsupported := backend()
	if code := status(t, newService(t, unsupported, nil).SetDirectory(ctx, hash, "/downloads/moved")); code != 501 || len(unsupported.CallsTo("d.stop")) != 0 {
		t.Fatalf("%d", code)
	}
}

/* ------------------------------- throttles ------------------------------- */

func TestAThrottleGroupIsCreatedAndRememberedAndDeletingUnlimitsIt(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if err := s.SaveThrottle(ctx, contracts.ThrottleGroup{Name: "slow", Up: 1024, Down: 4096}); err != nil {
		t.Fatal(err)
	}
	if got := params(client.CallsTo("throttle.up"), 0); !reflect.DeepEqual(got, []any{"", "slow", "1"}) {
		t.Fatalf("%#v", got)
	}
	if got := s.store.Throttles(); !reflect.DeepEqual(got, []contracts.ThrottleGroup{{Name: "slow", Up: 1024, Down: 4096}}) {
		t.Fatalf("%v", got)
	}
	if err := s.DeleteThrottle(ctx, "slow"); err != nil {
		t.Fatal(err)
	}
	if got := params(client.CallsTo("throttle.up"), 1); !reflect.DeepEqual(got, []any{"", "slow", "0"}) {
		t.Fatalf("%#v", got)
	}
	if len(s.store.Throttles()) != 0 {
		t.Fatal("still remembered")
	}
}

func TestGroupRatesRoundUpToKiBAndInvalidRatesNeverReachRtorrent(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if err := s.SaveThrottle(ctx, contracts.ThrottleGroup{Name: "small", Up: 800, Down: 1025}); err != nil {
		t.Fatal(err)
	}
	if got := s.store.Throttles(); !reflect.DeepEqual(got, []contracts.ThrottleGroup{{Name: "small", Up: 1024, Down: 2048}}) {
		t.Fatalf("%v", got)
	}
	if got := params(client.CallsTo("throttle.down"), 0); !reflect.DeepEqual(got, []any{"", "small", "2"}) {
		t.Fatalf("%#v", got)
	}
	for _, group := range []contracts.ThrottleGroup{{Name: "bad", Up: -1}, {Name: "NULL", Up: 1}, {Name: "has space"}, {Name: strings.Repeat("x", 33)}} {
		if got := status(t, s.SaveThrottle(ctx, group)); got != 400 {
			t.Errorf("%+v: %d", group, got)
		}
	}
	if len(client.CallsTo("throttle.up")) != 1 {
		t.Fatal("an invalid group reached rtorrent")
	}
}

func TestAFailedThrottleDeletionKeepsTheGroupForRetry(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	s.store.UpsertThrottle(contracts.ThrottleGroup{Name: "slow", Up: 1024, Down: 1024})
	client.Answer("throttle.down", &xmlrpc.Fault{Code: -1, Message: "refused"})
	if err := s.DeleteThrottle(ctx, "slow"); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("%v", err)
	}
	if len(s.store.Throttles()) != 1 {
		t.Fatal("the group was forgotten")
	}
}

func TestDeletingAGroupTheStoreNeverSavedIsA404(t *testing.T) {
	client := backend()
	s := newService(t, client, nil)
	if got := status(t, s.DeleteThrottle(ctx, "phantom")); got != 404 || len(client.CallsTo("throttle.up")) != 0 {
		t.Fatalf("%d", got)
	}
	if got := status(t, s.PatchThrottle(ctx, "phantom", nil, nil)); got != 404 {
		t.Fatalf("patch: %d", got)
	}
}

func TestThrottleRatesAreReadPerGroup(t *testing.T) {
	client := backend("throttle.up.rate", "throttle.down.rate").Answer("throttle.up.rate", 1024).Answer("throttle.down.rate", 2048)
	s := newService(t, client, nil)
	if err := s.SaveThrottle(ctx, contracts.ThrottleGroup{Name: "__proto__"}); err != nil {
		t.Fatal(err)
	}
	rates, err := s.ThrottleRates(ctx)
	if err != nil || !reflect.DeepEqual(rates, map[string]contracts.ThrottleRate{"__proto__": {Up: 1024, Down: 2048}}) {
		t.Fatalf("%v %v", rates, err)
	}
}

func TestAFailedThrottleAssignmentRestoresARunningTorrent(t *testing.T) {
	client := backend("d.is_active", "d.throttle_name.set", "d.save_full_session").
		Answer("d.is_active", 1).
		Answer("d.throttle_name.set", &xmlrpc.Fault{Code: -1, Message: "no such group"})
	err := newService(t, client, nil).SetTorrentThrottle(ctx, hash, "missing")
	if err == nil || !strings.Contains(err.Error(), "no such group") {
		t.Fatalf("%v", err)
	}
	if got := methodsOf(client.Calls(), "d."); !reflect.DeepEqual(got, []string{"d.is_active", "d.stop", "d.throttle_name.set", "d.start"}) {
		t.Fatalf("%v", got)
	}
}

/* ------------------------------- log scopes ------------------------------ */

func TestLogScopesKeepWhatTookNameWhatWasRefusedAndLowerHonestly(t *testing.T) {
	client := backend().Answer("log.add_output", func(p []any) (any, error) {
		if p[1] == "tracker_debug" {
			return nil, &xmlrpc.Fault{Code: -1, Message: "no such group"}
		}
		return 0, nil
	})
	s := newService(t, client, func(c *config.Config) { c.LogLevel = "info,notice" })

	raised, err := s.SetLogScopes(ctx, []string{"debug", "tracker_debug", "made_up"})
	if err != nil || !reflect.DeepEqual(raised.Failed, []string{"tracker_debug"}) {
		t.Fatalf("%+v %v", raised, err)
	}
	if !reflect.DeepEqual(s.store.LogScopes(), []string{"debug"}) {
		t.Fatalf("%v", s.store.LogScopes())
	}
	if state := s.LogScopes(); !reflect.DeepEqual(state.Boot, []string{"info", "notice"}) || !reflect.DeepEqual(state.Extra, []string{"debug"}) {
		t.Fatalf("%+v", state)
	}

	// Switching debug off cannot detach it: the answer says so.
	lowered, err := s.SetLogScopes(ctx, []string{})
	if err != nil || !reflect.DeepEqual(lowered.StillActive, []string{"debug"}) || len(s.store.LogScopes()) != 0 {
		t.Fatalf("%+v %v", lowered, err)
	}

	// Raising it again is a no-op on the wire: it is already attached.
	before := len(client.CallsTo("log.add_output"))
	if _, err := s.SetLogScopes(ctx, []string{"debug"}); err != nil {
		t.Fatal(err)
	}
	if len(client.CallsTo("log.add_output")) != before {
		t.Fatal("attached twice")
	}
}

func TestLogScopesAreRefusedWithoutLogAddOutput(t *testing.T) {
	listed := slices.DeleteFunc(rtorrenttest.MethodList(), func(name any) bool { return name == "log.add_output" })
	s := newService(t, rtorrenttest.New(rtorrenttest.Answers{"system.listMethods": listed}), nil)
	if _, err := s.SetLogScopes(ctx, []string{"debug"}); status(t, err) != 501 {
		t.Fatalf("%v", err)
	}
}

/* ---------------------------------- log ---------------------------------- */

func TestTheLogTailReadsTheEndAndDropsACutFirstLine(t *testing.T) {
	s := newService(t, backend(), nil)
	if rows, err := s.Log(ctx, 10); err != nil || rows == nil || len(rows) != 0 {
		t.Fatalf("no file yet: %#v %v", rows, err)
	}
	var lines []string
	for i := range 20 {
		lines = append(lines, "1788015928 I line "+strings.Repeat("x", i))
	}
	_ = os.WriteFile(s.cfg.LogFile, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	if rows, err := s.Log(ctx, 3); err != nil || !reflect.DeepEqual(rows, lines[17:]) {
		t.Fatalf("%v %v", rows, err)
	}
	// Past the tail window the first row is cut mid-line and dropped.
	long := strings.Repeat("y", logTailBytes)
	_ = os.WriteFile(s.cfg.LogFile, []byte(long+"\nkept one\nkept two\n"), 0o644)
	if rows, err := s.Log(ctx, 10); err != nil || !reflect.DeepEqual(rows, []string{"kept one", "kept two"}) {
		t.Fatalf("%d rows, %v", len(rows), err)
	}
}

/* -------------------------------- helpers -------------------------------- */

func TestEncodeURIComponentIsTheBrowsers(t *testing.T) {
	for in, want := range map[string]string{
		"tv shows": "tv%20shows", "a/b?c=d&e": "a%2Fb%3Fc%3Dd%26e", "-_.!~*'()": "-_.!~*'()",
		"räksmörgås": "r%C3%A4ksm%C3%B6rg%C3%A5s", "100%": "100%25",
	} {
		if got := encodeURIComponent(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if got := escapeArg(`a"b\c`); got != `a\"b\\c` {
		t.Errorf("escapeArg: %q", got)
	}
}
