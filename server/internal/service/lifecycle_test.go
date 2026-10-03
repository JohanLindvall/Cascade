package service

import (
	"context"
	"errors"
	"os"
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
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// A backend whose pid a test can change and whose rate reading a test can
// break, as an rtorrent restart and a passing hiccup look from here.
type session struct {
	*rtorrenttest.FakeClient
	pid    atomic.Int64
	broken atomic.Bool
}

func newSession(t *testing.T, withPID bool) *session {
	t.Helper()
	b := &session{FakeClient: backend("throttle.global_down.rate", "throttle.global_up.rate")}
	b.pid.Store(100)
	if withPID {
		b.Answer("system.pid", func([]any) any { return b.pid.Load() })
	}
	b.Answer("throttle.global_down.rate", func([]any) (any, error) {
		if b.broken.Load() {
			return nil, &xmlrpc.Fault{Code: -1, Message: "busy"}
		}
		return 1200, nil
	})
	return b
}

// stagedService is a service with startup settings, a throttle group and a
// log scope to put back, and the gamification off so a tick does no more
// than the housekeeping under test.
func stagedService(t *testing.T, client *session) subject {
	t.Helper()
	s := newService(t, client.FakeClient, func(c *config.Config) { c.Gamify = false })
	if err := os.WriteFile(s.cfg.BootSettingsFile, []byte(`{"downloadRate":4096}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s.store.UpsertThrottle(contracts.ThrottleGroup{Name: "slow", Up: 1024, Down: 1024})
	s.store.SetLogScopes([]string{"debug"})
	return s
}

func reapplied(client *session) (settings, throttles, scopes int) {
	return len(client.CallsTo("throttle.global_down.max_rate.set")), len(client.CallsTo("throttle.up")), len(client.CallsTo("log.add_output"))
}

func TestAPassingFailurePutsNothingBackButARestartPutsEverythingBack(t *testing.T) {
	client := newSession(t, true)
	s := stagedService(t, client)
	s.tick(ctx)
	if settings, throttles, scopes := reapplied(client); settings != 1 || throttles != 1 || scopes != 1 {
		t.Fatalf("first contact applied %d settings, %d groups, %d scopes", settings, throttles, scopes)
	}

	// A hiccup against the same rtorrent: the startup settings must not be
	// applied over whatever the UI changed since.
	client.broken.Store(true)
	s.tick(ctx)
	client.broken.Store(false)
	s.tick(ctx)
	if settings, throttles, scopes := reapplied(client); settings != 1 || throttles != 1 || scopes != 1 {
		t.Fatalf("a passing failure re-applied %d settings, %d groups, %d scopes", settings, throttles, scopes)
	}

	// A new pid is a restarted rtorrent, which has forgotten all three.
	client.pid.Store(200)
	s.tick(ctx)
	if settings, throttles, scopes := reapplied(client); settings != 2 || throttles != 2 || scopes != 2 {
		t.Fatalf("a restart re-applied %d settings, %d groups, %d scopes", settings, throttles, scopes)
	}
}

func TestWithoutSystemPidLosingContactCountsAsARestart(t *testing.T) {
	client := newSession(t, false)
	s := stagedService(t, client)
	s.tick(ctx)
	s.tick(ctx) // steady: nothing again
	if settings, _, _ := reapplied(client); settings != 1 {
		t.Fatalf("applied %d times while steady", settings)
	}
	client.broken.Store(true)
	s.tick(ctx)
	client.broken.Store(false)
	s.tick(ctx)
	if settings, throttles, scopes := reapplied(client); settings != 2 || throttles != 2 || scopes != 2 {
		t.Fatalf("after lost contact: %d settings, %d groups, %d scopes", settings, throttles, scopes)
	}
}

func TestARestartRefreshesCapabilitiesWithoutAConnectionFailure(t *testing.T) {
	client := newSession(t, true)
	s := stagedService(t, client)
	s.tick(ctx)
	before := len(client.CallsTo("system.listMethods"))
	if s.caps.Supports("portRange") {
		t.Fatal("the first backend unexpectedly supports portRange")
	}
	client.Answer("system.listMethods", rtorrenttest.MethodList("network.listen.port.range.set"))
	if err := os.WriteFile(s.cfg.BootSettingsFile, []byte(`{"portRange":"50001-50001"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	client.pid.Store(200)
	s.tick(ctx)
	if len(client.CallsTo("system.listMethods")) != before+1 || !s.caps.Supports("portRange") {
		t.Fatal("the new process kept the old capability table")
	}
	if len(client.CallsTo("network.listen.port.range.set")) != 1 {
		t.Fatal("the new process's startup setting was silently skipped")
	}
}

func TestAStepThatFailsIsTriedAgainOnTheNextTick(t *testing.T) {
	client := newSession(t, true)
	s := stagedService(t, client)
	refuse := atomic.Bool{}
	refuse.Store(true)
	client.Answer("throttle.up", func([]any) (any, error) {
		if refuse.Load() {
			return nil, &xmlrpc.Fault{Code: -1, Message: "not now"}
		}
		return 0, nil
	})
	s.tick(ctx)
	if s.throttlesApplied.Load() || s.logScopesApplied.Load() {
		t.Fatal("a failed step was recorded as done, or the next one ran after it")
	}
	refuse.Store(false)
	s.tick(ctx)
	if !s.throttlesApplied.Load() || !s.logScopesApplied.Load() || !s.bootSettingsApplied.Load() {
		t.Fatal("the failed step was not tried again")
	}
	if settings, _, _ := reapplied(client); settings != 1 {
		t.Fatalf("the startup settings were applied %d times", settings)
	}
}

// dropsOnce is a backend that loses the next batch carrying one command
// before rtorrent sees it, as a failed dial looks from here.
type dropsOnce struct {
	*rtorrenttest.FakeClient
	method string
	armed  atomic.Bool
}

func (c *dropsOnce) Multicall(ctx context.Context, calls []rtorrent.Call) ([]any, error) {
	carries := slices.ContainsFunc(calls, func(call rtorrent.Call) bool { return call.Method == c.method })
	if carries && c.armed.CompareAndSwap(true, false) {
		return nil, httperr.Backend("rtorrent closed the SCGI connection on fake without responding")
	}
	return c.FakeClient.Multicall(ctx, calls)
}

func TestStartupSettingsThatGotNoAnswerAreSentAgain(t *testing.T) {
	client := newSession(t, true)
	staged := stagedService(t, client)
	lossy := &dropsOnce{FakeClient: client.FakeClient, method: "throttle.global_down.max_rate.set"}
	lossy.armed.Store(true)
	s := New(staged.cfg, staged.store, lossy)
	s.tick(ctx)
	if s.bootSettingsApplied.Load() {
		t.Fatal("startup settings that got no answer were recorded as applied")
	}
	// The same pid: nothing resets the step, so only the failure itself may
	// have left it to do.
	s.tick(ctx)
	if settings, throttles, scopes := reapplied(client); settings != 1 || throttles != 1 || scopes != 1 || !s.bootSettingsApplied.Load() {
		t.Fatalf("after the retry: %d settings, %d groups, %d scopes", settings, throttles, scopes)
	}
}

func TestStartupSettingsThatAreRefusedAreNotSentAgain(t *testing.T) {
	for name, c := range map[string]struct {
		boot string
		sent int
	}{
		"rtorrent faults the setter": {`{"downloadRate":4096}`, 1},
		"a value the table rejects":  {`{"downloadRate":-5}`, 0},
	} {
		t.Run(name, func(t *testing.T) {
			client := newSession(t, true)
			client.Answer("throttle.global_down.max_rate.set", &xmlrpc.Fault{Code: -503, Message: "Wrong object type"})
			s := stagedService(t, client)
			if err := os.WriteFile(s.cfg.BootSettingsFile, []byte(c.boot), 0o644); err != nil {
				t.Fatal(err)
			}
			s.tick(ctx)
			s.tick(ctx)
			// Refused once and logged; the steps after it still ran.
			if settings, throttles, scopes := reapplied(client); settings != c.sent || throttles != 1 || scopes != 1 || !s.bootSettingsApplied.Load() {
				t.Fatalf("%d settings, %d groups, %d scopes", settings, throttles, scopes)
			}
		})
	}
}

func TestStopWaitsForTheLoopAndStartCanFollow(t *testing.T) {
	client := newSession(t, true)
	s := newService(t, client.FakeClient, func(c *config.Config) { c.PollInterval, c.Gamify = time.Millisecond, false })
	s.Start()
	s.Start() // a second Start is a no-op, not a second loop
	deadline := time.Now().Add(2 * time.Second)
	for len(client.CallsTo("throttle.global_up.rate")) < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	s.Stop()
	before := len(client.Calls())
	time.Sleep(20 * time.Millisecond)
	if after := len(client.Calls()); after != before {
		t.Fatalf("%d calls after Stop returned", after-before)
	}
	s.Stop() // stopping twice is harmless
	s.Start()
	defer s.Stop()
	for len(client.Calls()) == before && time.Now().Before(deadline.Add(time.Second)) {
		time.Sleep(time.Millisecond)
	}
	if len(client.Calls()) == before {
		t.Fatal("no tick after starting again")
	}
}

// stalls is a backend whose torrent listing hangs until its caller gives up
// or the test lets it go, as a busy rtorrent's does.
type stalls struct {
	*rtorrenttest.FakeClient
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func newStalls(t *testing.T, fake *rtorrenttest.FakeClient) *stalls {
	c := &stalls{FakeClient: fake, entered: make(chan struct{}, 1), release: make(chan struct{})}
	t.Cleanup(c.letGo)
	return c
}

func (c *stalls) letGo() { c.once.Do(func() { close(c.release) }) }

func (c *stalls) FieldMulticall(ctx context.Context, method string, leading []any, fields []string) ([]rtorrent.Row, error) {
	if strings.HasPrefix(method, "d.multicall") {
		select {
		case c.entered <- struct{}{}:
		default:
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.release:
		}
	}
	return c.FakeClient.FieldMulticall(ctx, method, leading, fields)
}

func TestStopAbandonsTheCountersReadInFlight(t *testing.T) {
	client := newSession(t, true)
	base := newService(t, client.FakeClient, func(c *config.Config) { c.PollInterval, c.Gamify = time.Millisecond, true })
	stall := newStalls(t, client.FakeClient)
	s := New(base.cfg, base.store, stall)
	s.Start()
	select {
	case <-stall.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the loop never read the list for the counters")
	}
	stopped := make(chan struct{})
	go func() { s.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop waited for the counters read")
	}
}

func TestTheLoopDoesNotWaitOnAReadSomeoneElseStarted(t *testing.T) {
	client := newSession(t, true)
	base := newService(t, client.FakeClient, func(c *config.Config) { c.Gamify = true })
	stall := newStalls(t, client.FakeClient)
	s := New(base.cfg, base.store, stall)
	page := make(chan error, 1)
	go func() { _, err := s.Torrents(ctx, "main"); page <- err }()
	<-stall.entered
	ticked := make(chan struct{})
	go func() { s.tick(ctx); close(ticked) }()
	select {
	case <-ticked:
	case <-time.After(2 * time.Second):
		t.Fatal("the tick waited on a page's read")
	}
	stall.letGo()
	if err := <-page; err != nil {
		t.Fatal(err)
	}
	// That read updated the counters; the tick did not ask for a second.
	if n := len(client.CallsTo("d.multicall2")); n != 1 {
		t.Fatalf("%d listings", n)
	}
}

func TestRateSamplesAreKeptForTheGraphAndCapped(t *testing.T) {
	client := newSession(t, true)
	s := newService(t, client.FakeClient, func(c *config.Config) { c.Gamify = true })
	for range historyLength + 5 {
		if err := s.sampleRates(ctx); err != nil {
			t.Fatal(err)
		}
	}
	s.mu.Lock()
	n, last := len(s.history), s.history[len(s.history)-1]
	s.mu.Unlock()
	if n != historyLength || last.Down != 1200 {
		t.Fatalf("%d samples, last %+v", n, last)
	}
	if s.store.Stats().PeakDownRate != 1200 {
		t.Fatal("the peak rate was not recorded")
	}
}

// cancelAware is a backend that refuses to be asked anything under a
// context already cancelled, as the real client does. Every entry point
// checks: the fake's own methods call one another directly, so an override
// of Call alone never sees a multicall.
type cancelAware struct{ *rtorrenttest.FakeClient }

func (c cancelAware) Call(ctx context.Context, method string, params ...any) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.FakeClient.Call(ctx, method, params...)
}

func (c cancelAware) Multicall(ctx context.Context, calls []rtorrent.Call) ([]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.FakeClient.Multicall(ctx, calls)
}

func (c cancelAware) MulticallSettled(ctx context.Context, calls []rtorrent.Call) ([]rtorrent.Result, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.FakeClient.MulticallSettled(ctx, calls)
}

func (c cancelAware) FieldMulticall(ctx context.Context, method string, leading []any, fields []string) ([]rtorrent.Row, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.FakeClient.FieldMulticall(ctx, method, leading, fields)
}

func TestAChangeIsSeenThroughWhenItsCallerGivesUp(t *testing.T) {
	// f.multicall is there to be answered, so only the cancelled context can
	// fail the read below.
	fake := backend("d.is_active", "d.throttle_name.set", "d.save_full_session", "f.multicall").
		Answer("d.is_active", 1).Answer("f.multicall", []any{})
	base := newService(t, fake, nil)
	s := New(base.cfg, base.store, cancelAware{fake})

	gone, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.SetTorrentThrottle(gone, hash, "slow"); err != nil {
		t.Fatal(err)
	}
	// Stopped, set and started again: never left stopped halfway.
	if got := methodsOf(fake.Calls(), "d."); strings.Join(got, " ") != "d.is_active d.stop d.throttle_name.set d.start d.save_full_session" {
		t.Fatalf("%v", got)
	}
	// A read, by contrast, gives up with its caller.
	if _, err := s.Files(gone, hash); !errors.Is(err, context.Canceled) {
		t.Fatalf("a read for a caller that had gone: %v", err)
	}
	if _, err := s.Files(ctx, hash); err != nil {
		t.Fatalf("the same read for a caller still there: %v", err)
	}
}

func TestASharedReadThatPanicsReleasesItsWaiters(t *testing.T) {
	var f flight[int]
	release := make(chan struct{})
	started := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { _ = recover() }()
		_, _ = f.do(func() (int, error) { close(started); <-release; panic("boom") })
	}()
	<-started
	waiter := make(chan error, 1)
	go func() {
		_, err := f.do(func() (int, error) { return 1, nil })
		waiter <- err
	}()
	time.Sleep(20 * time.Millisecond) // the waiter has joined the read in flight
	close(release)
	wg.Wait()
	select {
	case err := <-waiter:
		if err == nil {
			t.Fatal("a waiter of a panicked read got an answer")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a waiter of a panicked read never returned")
	}
	if n, err := f.do(func() (int, error) { return 7, nil }); n != 7 || err != nil {
		t.Fatalf("the next read got %d %v", n, err)
	}
}
