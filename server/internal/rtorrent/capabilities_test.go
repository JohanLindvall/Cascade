// SPDX-License-Identifier: MIT

package rtorrent_test

// The capability probe is what lets one UI drive rtorrent 0.9.8 and 0.16.x:
// it picks command names from system.listMethods and turns them into the
// supports map the UI greys controls out by. These pin the dialect choices
// and the map against scripted command tables.

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent/rtorrenttest"
)

var fields = rtorrent.FieldLists{
	Torrent: rtorrent.TorrentFields,
	File:    rtorrent.FileFields,
	Peer:    rtorrent.PeerFields,
	Tracker: rtorrent.TrackerFields,
}

func backend(methods []string, extra rtorrenttest.Answers) *rtorrenttest.FakeClient {
	answers := rtorrenttest.Answers{
		"system.listMethods":     methods,
		"system.client_version":  "0.15.2",
		"system.library_version": "0.15.2",
		"system.api_version":     "11",
	}
	for method, answer := range extra {
		answers[method] = answer
	}
	return rtorrenttest.New(answers)
}

func ensure(t *testing.T, caps *rtorrent.Capabilities) {
	t.Helper()
	if err := caps.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestAModernBackendGetsMulticall2AndTheVerboseLoaders(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2", "load.raw_start_verbose", "load.raw_verbose",
		"load.verbose", "load.start_verbose", "d.hash", "d.name"}, nil), fields)
	ensure(t, caps)
	dialect, info := caps.Dialect(), caps.Info()
	if !caps.Ready() || dialect.DownloadMulticall != "d.multicall2" ||
		!reflect.DeepEqual(dialect.DownloadMulticallPrefix("main"), []any{"", "main"}) ||
		dialect.LoadRawStart != "load.raw_start_verbose" || dialect.LoadURL != "load.verbose" {
		t.Fatalf("dialect %#v", dialect)
	}
	if info.Flavor != "modern dialect (0.9.7+)" || info.ClientVersion != "0.15.2" || info.MethodCount != 7 {
		t.Fatalf("info %#v", info)
	}
}

func TestALegacyBackendFallsBackToDMulticallWithTheViewFirst(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall", "load.raw_start", "d.hash"}, nil), fields)
	ensure(t, caps)
	dialect := caps.Dialect()
	if dialect.DownloadMulticall != "d.multicall" ||
		!reflect.DeepEqual(dialect.DownloadMulticallPrefix("main"), []any{"main"}) ||
		dialect.LoadRawStart != "load.raw_start" {
		t.Fatalf("dialect %#v", dialect)
	}
	if flavor := caps.Info().Flavor; flavor != "legacy dialect (pre-0.9.7)" {
		t.Fatalf("flavor %q", flavor)
	}
}

func TestFieldListsAreFilteredToWhatTheBackendImplements(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2", "d.hash", "d.name", "f.path", "p.address"}, nil), fields)
	ensure(t, caps)
	dialect := caps.Dialect()
	for name, c := range map[string]struct{ got, want []string }{
		"torrent": {dialect.TorrentFields, []string{"d.hash", "d.name"}},
		"file":    {dialect.FileFields, []string{"f.path"}},
		"peer":    {dialect.PeerFields, []string{"p.address"}},
		"tracker": {dialect.TrackerFields, []string{}},
	} {
		if !reflect.DeepEqual(c.got, c.want) {
			t.Errorf("%s fields %#v, want %#v", name, c.got, c.want)
		}
	}
}

func TestABackendExposingNoTorrentFieldGetsTheFullListToFaultLoudly(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2"}, nil), fields)
	ensure(t, caps)
	if got := caps.Dialect().TorrentFields; !reflect.DeepEqual(got, rtorrent.TorrentFields) {
		t.Fatalf("got %v", got)
	}
}

func TestSupportsCoversFeaturesAndEverySettingKey(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2", "d.custom1.set",
		"throttle.global_up.max_rate.set", "network.port_range.set"}, nil), fields)
	ensure(t, caps)
	for feature, want := range map[string]bool{
		"labels":         true,
		"throttleGroups": false,
		"uploadRate":     true,
		"downloadRate":   false,
		// An alternate setter name (the pre-0.16 one here) is enough.
		"portRange": true,
		// Read-only settings never claim support.
		"sessionDirectory":  false,
		"never-heard-of-it": false,
	} {
		if got := caps.Supports(feature); got != want {
			t.Errorf("Supports(%q) = %v", feature, got)
		}
	}
	if !caps.Has("d.custom1.set") {
		t.Fatal("Has is wrong")
	}
	supports := caps.Info().Supports
	for _, key := range rtorrent.SettingKeys {
		if _, ok := supports[key]; !ok {
			t.Errorf("no supports entry for the setting %s", key)
		}
	}
}

func TestCompositeFeaturesNeedAllTheirCommandsAndMalformedProbesAreNotCached(t *testing.T) {
	client := backend([]string{"throttle.up"}, nil)
	caps := rtorrent.NewCapabilities(client, fields)
	ensure(t, caps)
	if caps.Supports("throttleGroups") {
		t.Fatal("half the throttle commands claimed the feature")
	}
	client.Answer("system.listMethods", "broken")
	caps.Invalidate()
	if err := caps.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "invalid system.listMethods") {
		t.Fatalf("got %v", err)
	}
	if caps.Ready() {
		t.Fatal("a failed probe left the capabilities ready")
	}
	client.Answer("system.listMethods", []string{"throttle.up", "throttle.down"})
	ensure(t, caps)
	if !caps.Supports("throttleGroups") {
		t.Fatal("the recovered probe did not see both commands")
	}
}

func TestSystemCapabilitiesFillsInTheRPCFacility(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2", "system.capabilities"}, rtorrenttest.Answers{
		"system.capabilities": map[string]any{"facility": "xmlrpc-c", "version_major": 1, "version_minor": 51, "version_point": 8},
	}), fields)
	ensure(t, caps)
	if got := caps.Info().RPCFacility; got != "xmlrpc-c 1.51.8" {
		t.Fatalf("got %q", got)
	}
}

func TestAVersionProbeThatFaultsReadsAsUnknown(t *testing.T) {
	caps := rtorrent.NewCapabilities(rtorrenttest.New(rtorrenttest.Answers{"system.listMethods": []string{"d.multicall2"}}), fields)
	ensure(t, caps)
	if info := caps.Info(); info.ClientVersion != "unknown" || info.RPCFacility != "" {
		t.Fatalf("info %#v", info)
	}
}

func TestEnsureProbesOnceAndSharesTheProbeInFlight(t *testing.T) {
	client := backend([]string{"d.multicall2"}, nil)
	caps := rtorrent.NewCapabilities(client, fields)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := caps.Ensure(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if n := len(client.CallsTo("system.listMethods")); n != 1 {
		t.Fatalf("%d probes", n)
	}
	ensure(t, caps)
	if n := len(client.CallsTo("system.listMethods")); n != 1 {
		t.Fatalf("%d probes after a fresh one stood", n)
	}
	caps.Invalidate()
	ensure(t, caps)
	if n := len(client.CallsTo("system.listMethods")); n != 2 {
		t.Fatalf("%d probes after invalidate", n)
	}
}

// probeHeldOpen scripts a system.listMethods that reports the probe under way
// on started and answers only once release is closed, so a test orders itself
// against the probe by what it has done rather than by how long it has had.
func probeHeldOpen(methods ...any) (client *rtorrenttest.FakeClient, started <-chan struct{}, release chan struct{}) {
	running := make(chan struct{}, 1)
	release = make(chan struct{})
	client = backend([]string{"d.multicall2"}, nil)
	client.Answer("system.listMethods", func([]any) (any, error) {
		select {
		case running <- struct{}{}:
		default:
		}
		<-release
		return methods, nil
	})
	return client, running, release
}

func TestACallerThatGivesUpDoesNotSinkTheSharedProbe(t *testing.T) {
	client, started, release := probeHeldOpen("d.multicall2")
	caps := rtorrent.NewCapabilities(client, fields)
	impatient, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { first <- caps.Ensure(impatient) }()
	second := make(chan error, 1)
	// The impatient caller is the one that started the probe.
	<-started
	go func() { second <- caps.Ensure(context.Background()) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("the impatient caller got %v", err)
	}
	close(release)
	if err := <-second; err != nil || !caps.Ready() {
		t.Fatalf("the patient caller got %v", err)
	}
}

func TestAnInvalidateDuringAProbeIsNotUndoneByIt(t *testing.T) {
	client, started, release := probeHeldOpen("d.multicall2", "log.add_output")
	caps := rtorrent.NewCapabilities(client, fields)
	done := make(chan error, 1)
	go func() { done <- caps.Ensure(context.Background()) }()
	// Once it asks for the command table the probe has its generation; an
	// Invalidate any earlier would simply precede it.
	<-started
	// The connection dropped while the probe was out: what it brings back
	// predates the drop.
	caps.Invalidate()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if caps.Ready() {
		t.Fatal("a probe from before the invalidate marked the backend ready")
	}
	if !caps.Supports("logScopes") {
		t.Fatal("its answers were not kept for the callers that waited on it")
	}
	ensure(t, caps)
	if n := len(client.CallsTo("system.listMethods")); n != 2 || !caps.Ready() {
		t.Fatalf("%d probes, ready %v", n, caps.Ready())
	}
}

func TestAProbeThatFailsPartWayKeepsTheLastGoodAnswers(t *testing.T) {
	client := &flakyMulticall{FakeClient: backend([]string{"d.multicall2", "log.add_output"}, nil)}
	caps := rtorrent.NewCapabilities(client, fields)
	ensure(t, caps)
	caps.Invalidate()
	// The command table answers, then the version multicall does not.
	client.Answer("system.listMethods", []any{"d.multicall"})
	client.broken.Store(true)
	if err := caps.Ensure(context.Background()); err == nil {
		t.Fatal("the probe did not fail")
	}
	if caps.Has("d.multicall") || !caps.Has("d.multicall2") ||
		caps.Dialect().DownloadMulticall != "d.multicall2" || !caps.Supports("logScopes") {
		t.Fatal("a failed probe left half its answers behind")
	}
}

// flakyMulticall is a backend whose multicalls can be made to fail.
type flakyMulticall struct {
	*rtorrenttest.FakeClient
	broken atomic.Bool
}

func (f *flakyMulticall) MulticallSettled(ctx context.Context, calls []rtorrent.Call) ([]rtorrent.Result, error) {
	if f.broken.Load() {
		return nil, errors.New("connection reset")
	}
	return f.FakeClient.MulticallSettled(ctx, calls)
}

func TestMethodNamesIsSortedForTheConsole(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"z.last", "a.first", "d.multicall2"}, nil), fields)
	ensure(t, caps)
	if got := caps.MethodNames(); !reflect.DeepEqual(got, []string{"a.first", "d.multicall2", "z.last"}) {
		t.Fatalf("got %v", got)
	}
}

func TestResolvePicksTheFirstImplementedCandidate(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2", "network.port_range.set"}, nil), fields)
	ensure(t, caps)
	if got := caps.Resolve("network.listen.port.range.set", "network.port_range.set"); got != "network.port_range.set" {
		t.Fatalf("got %q", got)
	}
	if got := caps.Resolve("nope"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestAccessorsHandOutCopies(t *testing.T) {
	caps := rtorrent.NewCapabilities(backend([]string{"d.multicall2", "d.hash", "d.custom1.set"}, nil), fields)
	ensure(t, caps)
	caps.Info().Supports["labels"] = false
	caps.Dialect().TorrentFields[0] = "d.oops"
	if !caps.Supports("labels") || caps.Dialect().TorrentFields[0] != "d.hash" {
		t.Fatal("a caller changed the capabilities through what it was handed")
	}
}
