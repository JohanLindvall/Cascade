// SPDX-License-Identifier: MIT

package httpapi

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// The routes the contract tests do not already reach, each checked for what
// it asks of the service and what it answers.

func (s *stubService) Status(context.Context) (contracts.GlobalStatus, error) {
	return contracts.GlobalStatus{Connected: true, History: []contracts.RateSample{}}, s.record("status")
}
func (s *stubService) BackendSummary() contracts.BackendSummary {
	return contracts.BackendSummary{ClientVersion: "0.16.24", Supports: map[string]bool{}}
}
func (s *stubService) Torrents(_ context.Context, view string) ([]contracts.Torrent, error) {
	return []contracts.Torrent{}, s.record("torrents", view)
}
func (s *stubService) Files(_ context.Context, hash string) ([]contracts.TorrentFile, error) {
	return []contracts.TorrentFile{{Path: "a.bin"}}, s.record("files", hash)
}
func (s *stubService) Peers(_ context.Context, hash string) ([]contracts.Peer, error) {
	return []contracts.Peer{}, s.record("peers", hash)
}
func (s *stubService) Trackers(_ context.Context, hash string) ([]contracts.Tracker, error) {
	return []contracts.Tracker{}, s.record("trackers", hash)
}
func (s *stubService) TrackerHosts(_ context.Context, hashes []string) (map[string]string, error) {
	hosts := map[string]string{}
	for _, hash := range hashes {
		hosts[hash] = "tracker.example"
	}
	return hosts, s.record("trackerHosts", hashes)
}
func (s *stubService) SetTorrentThrottle(_ context.Context, hash, name string) error {
	return s.record("setTorrentThrottle", hash, name)
}
func (s *stubService) SetTorrentSlots(_ context.Context, hash string, uploads, downloads *int64) error {
	return s.record("setTorrentSlots", hash, *uploads, downloads)
}
func (s *stubService) SetDirectory(_ context.Context, hash, directory string) error {
	return s.record("setDirectory", hash, directory)
}

// RefuseDirectoryChange fails only as fail says: the other hash is a torrent
// whose changes fault (setDirectory, after the stop), not one refused before.
func (s *stubService) RefuseDirectoryChange(_ context.Context, hash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, stubCall{"refuseDirectoryChange", []any{hash}})
	return s.fail["refuseDirectoryChange"]
}
func (s *stubService) SetTrackerEnabled(_ context.Context, hash string, index int, enabled bool) error {
	return s.record("setTrackerEnabled", hash, index, enabled)
}
func (s *stubService) Settings(context.Context) (map[string]any, error) {
	return map[string]any{"pex": true}, s.record("settings")
}
func (s *stubService) UpdateSettings(_ context.Context, patch any) error {
	return s.record("updateSettings", patch)
}
func (s *stubService) SaveThrottle(_ context.Context, group contracts.ThrottleGroup) error {
	return s.record("saveThrottle", group)
}
func (s *stubService) PatchThrottle(_ context.Context, name string, up, down *int64) error {
	return s.record("patchThrottle", name, up != nil, down != nil)
}
func (s *stubService) DeleteThrottle(_ context.Context, name string) error {
	return s.record("deleteThrottle", name)
}
func (s *stubService) ThrottleRates(context.Context) (map[string]contracts.ThrottleRate, error) {
	return map[string]contracts.ThrottleRate{"slow": {Up: 1, Down: 2}}, s.record("throttleRates")
}
func (s *stubService) Log(_ context.Context, lines int) ([]string, error) {
	return []string{"a line"}, s.record("log", lines)
}
func (s *stubService) SetLogScopes(_ context.Context, scopes []string) (contracts.LogScopeChange, error) {
	return contracts.LogScopeChange{LogScopeState: s.LogScopes(), StillActive: []string{}, Failed: []string{}},
		s.record("setLogScopes", scopes)
}

func (c *stubClient) MulticallSettled(_ context.Context, calls []rtorrent.Call) ([]rtorrent.Result, error) {
	return []rtorrent.Result{{Value: "the help"}, {Value: []any{[]any{"string", "string"}}}},
		c.s.record("multicallSettled", len(calls))
}

func (c *stubClient) Raw(_ context.Context, body []byte) ([]byte, error) {
	return []byte("<methodResponse/>"), c.s.record("raw", string(body))
}

func wantCall(t *testing.T, s *stubService, method string, args ...any) {
	t.Helper()
	calls := s.callsTo(method)
	if len(calls) == 0 {
		t.Fatalf("%s was not called", method)
	}
	if got := calls[len(calls)-1].args; !reflect.DeepEqual(got, args) {
		t.Fatalf("%s(%#v), want %#v", method, got, args)
	}
}

func TestReadsReachTheServiceAndAnswerJSON(t *testing.T) {
	h := boot(t, nil)
	for _, c := range []struct {
		path, method string
		args         []any
		want         string
	}{
		{"/api/status", "status", nil, `"connected":true`},
		{"/api/torrents", "torrents", []any{"main"}, `[]`},
		{"/api/torrents?view=stopped", "torrents", []any{"stopped"}, `[]`},
		{"/api/torrents?view=a&view=b", "torrents", []any{"main"}, `[]`}, // a list is no view
		{"/api/torrents/" + strings.ToLower(hash) + "/files", "files", []any{hash}, `"path":"a.bin"`},
		{"/api/torrents/" + hash + "/peers", "peers", []any{hash}, `[]`},
		{"/api/torrents/" + hash + "/trackers", "trackers", []any{hash}, `[]`},
		{"/api/trackers?hashes=" + hash + ",junk," + strings.ToLower(hash) + "," + other, "trackerHosts",
			[]any{[]string{hash, other}}, `"` + hash + `":"tracker.example"`},
		{"/api/settings", "settings", nil, `{"pex":true}`},
		{"/api/throttles", "throttleRates", nil, `"groups":[],"rates":{"slow":{"up":1,"down":2}}`},
		{"/api/log", "log", []any{300}, `{"lines":["a line"]}`},
		{"/api/log?lines=5000", "log", []any{2000}, `a line`},
		{"/api/log?lines=-5", "log", []any{1}, `a line`},
		{"/api/log?lines=2.9", "log", []any{2}, `a line`},
		{"/api/log?lines=junk", "log", []any{300}, `a line`},
	} {
		r := send(t, "GET", h.base+c.path, "", nil)
		if r.status != 200 || !strings.Contains(string(r.raw), c.want) {
			t.Errorf("%s: %d %s", c.path, r.status, r.raw)
			continue
		}
		wantCall(t, h.service, c.method, c.args...)
	}
	for path, want := range map[string]string{
		"/api/capabilities": `"clientVersion":"0.16.24"`,
		"/api/game":         `"enabled":true`,
		"/api/prefs":        `"theme":"system"`,
		"/api/log/scopes":   `"supported":true`,
		"/api/rpc/methods":  `{"methods":["a","b"]}`,
	} {
		if r := send(t, "GET", h.base+path, "", nil); r.status != 200 || !strings.Contains(string(r.raw), want) {
			t.Errorf("%s: %d %s", path, r.status, r.raw)
		}
	}
}

func TestPreferencesAreSanitizedAndKept(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "PATCH", h.base+"/api/prefs", `{"theme":"retro","sortKey":"nonsense","statePollMs":1000}`, nil)
	if r.status != 200 || r.body["theme"] != "retro" || r.body["sortKey"] != "addedAt" || r.body["statePollMs"] != float64(1000) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if again := send(t, "GET", h.base+"/api/prefs", "", nil); again.body["theme"] != "retro" {
		t.Fatalf("%s", again.raw)
	}
}

func TestPatchAppliesEveryNamedFieldInOrder(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "PATCH", h.base+"/api/torrents/"+hash,
		`{"priority":2,"label":" tv ","throttle":"slow","directory":"/downloads/x","maxUploads":4}`, nil)
	if r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	// Whether the directory may change at all is asked before anything is.
	want := []string{"refuseDirectoryChange", "setPriority", "setLabel", "setTorrentThrottle", "setDirectory", "setTorrentSlots"}
	if order := methods(h.service); !reflect.DeepEqual(order, want) {
		t.Fatalf("%v", order)
	}
	wantCall(t, h.service, "refuseDirectoryChange", hash)
	wantCall(t, h.service, "setLabel", hash, "tv")
	wantCall(t, h.service, "setTorrentSlots", hash, int64(4), (*int64)(nil))
	if r := send(t, "PATCH", h.base+"/api/torrents/"+hash, `{"directory":"  "}`, nil); r.status != 400 {
		t.Fatalf("a blank directory: %d", r.status)
	}
}

// methods is what the stub was asked, in order.
func methods(s *stubService) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	order := []string{}
	for _, c := range s.calls {
		order = append(order, c.method)
	}
	return order
}

// A magnet still fetching its metadata cannot have its directory changed: a
// 409, which leaves the stream alone, as a refusal that changed nothing.
// Coming after the fields ahead of the directory, it left them changed —
// priority, label, throttle group (that one stopping and restarting the
// magnet) — with no page told until the stream's next read. It is asked
// before the first of them.
func TestADirectoryRefusedForItsTorrentChangesNoOtherField(t *testing.T) {
	h := boot(t, nil)
	const fetching = "this torrent is still fetching its metadata"
	h.service.fail = map[string]error{"refuseDirectoryChange": httperr.New(http.StatusConflict, fetching)}
	r := send(t, "PATCH", h.base+"/api/torrents/"+hash,
		`{"priority":3,"label":"tv","throttle":"slow","directory":"/downloads/x","maxUploads":4}`, nil)
	if r.status != 409 || r.body["error"] != fetching {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if got := methods(h.service); !reflect.DeepEqual(got, []string{"refuseDirectoryChange"}) {
		t.Fatalf("asked %v", got)
	}
	// A patch without a directory has nothing to be refused for.
	if r := send(t, "PATCH", h.base+"/api/torrents/"+hash, `{"priority":3,"label":"tv","throttle":"slow"}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if got, want := methods(h.service), []string{"refuseDirectoryChange", "setPriority", "setLabel", "setTorrentThrottle"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("asked %v", got)
	}
}

func TestRemovalTakesDeleteDataFromTheQueryOrTheBody(t *testing.T) {
	h := boot(t, nil)
	for query, want := range map[string]any{"": false, "?deleteData=true": true, "?deleteData=0": false} {
		if r := send(t, "DELETE", h.base+"/api/torrents/"+hash+query, "", nil); r.status != 200 {
			t.Fatalf("%s: %d %s", query, r.status, r.raw)
		}
		wantCall(t, h.service, "remove", hash, want)
	}
	for _, query := range []string{"?deleteData=perhaps", "?deleteData=1&deleteData=0", "?deleteData"} {
		if r := send(t, "DELETE", h.base+"/api/torrents/"+hash+query, "", nil); r.status != 400 {
			t.Errorf("%s: %d", query, r.status)
		}
	}
	r := send(t, "POST", h.base+"/api/torrents/remove", `{"hashes":["`+hash+`"],"deleteData":true}`, nil)
	if r.status != 200 || r.body["ok"] != true {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "remove", hash, true)
	if r := send(t, "POST", h.base+"/api/torrents/remove", `{"hashes":["`+hash+`"],"deleteData":"x"}`, nil); r.status != 400 {
		t.Fatalf("%d", r.status)
	}
}

func TestTrackersAreToggledByIndex(t *testing.T) {
	h := boot(t, nil)
	if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/trackers/2/enabled", `{"enabled":false}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "setTrackerEnabled", hash, 2, false)
	for _, body := range []string{`{}`, `{"enabled":"maybe"}`} {
		if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/trackers/2/enabled", body, nil); r.status != 400 {
			t.Errorf("%s: %d", body, r.status)
		}
	}
	if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/trackers", `{"url":"udp://t.example:6969/announce","group":3}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "addTracker", hash, "udp://t.example:6969/announce", int64(3))
}

func TestSettingsAreWrittenThenReadBack(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/settings", `{"pex":false}`, nil)
	if r.status != 200 || r.body["pex"] != true {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "updateSettings", map[string]any{"pex": false})
}

func TestThrottleGroupsAreSavedPatchedAndDeleted(t *testing.T) {
	h := boot(t, nil)
	if r := send(t, "POST", h.base+"/api/throttles", `{"name":"slow","up":1024,"down":"2048"}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "saveThrottle", contracts.ThrottleGroup{Name: "slow", Up: 1024, Down: 2048})
	for _, body := range []string{`{"name":"","up":0,"down":0}`, `{"name":"x","up":-1,"down":0}`, `{"name":"x","up":0}`} {
		if r := send(t, "POST", h.base+"/api/throttles", body, nil); r.status != 400 {
			t.Errorf("%s: %d", body, r.status)
		}
	}
	if r := send(t, "PATCH", h.base+"/api/throttles/slow", `{"down":0}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "patchThrottle", "slow", false, true)
	for _, body := range []string{`{}`, ``, `{"up":"fast"}`} {
		r := send(t, "PATCH", h.base+"/api/throttles/slow", body, nil)
		if r.status != 400 {
			t.Errorf("%q: %d %s", body, r.status, r.raw)
		}
	}
	if r := send(t, "DELETE", h.base+"/api/throttles/slow%2Egroup", "", nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "deleteThrottle", "slow.group") // path segments are decoded
}

func TestLogScopesAreSetByName(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/log/scopes", `{"scopes":["debug"]}`, nil)
	if r.status != 200 || r.body["supported"] != true || !reflect.DeepEqual(r.body["failed"], []any{}) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "setLogScopes", []string{"debug"})
}

func TestAMagnetOrURLIsAddedFromJSON(t *testing.T) {
	h := boot(t, nil)
	if r := send(t, "POST", h.base+"/api/torrents/url", `{"url":" magnet:?xt=urn:btih:`+hash+` ","start":false}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "addTorrentUrl", "magnet:?xt=urn:btih:"+hash, contracts.LoadOptions{})
	for _, body := range []string{`{}`, `{"url":"x","start":"perhaps"}`, `{"url":"x","label":7}`} {
		if r := send(t, "POST", h.base+"/api/torrents/url", body, nil); r.status != 400 {
			t.Errorf("%s: %d", body, r.status)
		}
	}
}

func TestRawRPCHelpAndFaults(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/rpc/help", `{"method":"d.name"}`, nil)
	if r.status != 200 || r.body["help"] != "the help" || !reflect.DeepEqual(r.body["signature"], []any{[]any{"string", "string"}}) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	// A fault is an answer to the console, not a failure.
	fault := boot(t, nil)
	fault.service.state = nil
	client := &faultingClient{}
	fault.server.svc = &clientStub{stubService: fault.service, client: client}
	r = send(t, "POST", fault.base+"/api/rpc", `{"method":"no.such"}`, nil)
	if r.status != 200 || r.body["ok"] != false || r.body["fault"].(map[string]any)["code"] != float64(-506) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	// Base64 values travel as {"$base64": …}.
	if got := jsonSafe([]any{[]byte("hi"), map[string]any{"k": []byte{0}}}); !reflect.DeepEqual(got,
		[]any{map[string]string{"$base64": "aGk="}, map[string]any{"k": map[string]string{"$base64": "AA=="}}}) {
		t.Fatalf("%#v", got)
	}
}

type faultingClient struct{ rtorrent.Client }

func (faultingClient) Call(context.Context, string, ...any) (any, error) {
	return nil, &xmlrpc.Fault{Code: -506, Message: "Method 'no.such' not defined"}
}

type clientStub struct {
	*stubService
	client rtorrent.Client
}

func (c *clientStub) Client() rtorrent.Client { return c.client }

func TestRPC2PassesXMLThroughAndBuildsItFromJSON(t *testing.T) {
	h := boot(t, nil)
	call := `<?xml version="1.0"?><methodCall><methodName>system.client_version</methodName></methodCall>`
	r := do(t, "POST", h.base+"/RPC2", strings.NewReader(call), map[string]string{"Content-Type": "text/xml"})
	if r.status != 200 || string(r.raw) != "<methodResponse/>" || !strings.HasPrefix(r.header.Get("Content-Type"), "text/xml") {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "raw", call)
	r = send(t, "POST", h.base+"/RPC2", `{"method":"d.name","params":["`+hash+`"]}`, nil)
	if r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	built := h.service.callsTo("raw")[1].args[0].(string)
	if !strings.Contains(built, "<methodName>d.name</methodName>") || !strings.Contains(built, hash) {
		t.Fatalf("%s", built)
	}
	for _, c := range []struct{ kind, body string }{
		{"text/plain", call},
		{"text/xml", ""},
		{"application/json", `[1]`},
		{"application/json", `{"params":[]}`},
	} {
		if r := do(t, "POST", h.base+"/RPC2", strings.NewReader(c.body), map[string]string{"Content-Type": c.kind}); r.status != 400 {
			t.Errorf("%s %q: %d", c.kind, c.body, r.status)
		}
	}
}

func TestAChangeCarriesThroughWhenTheClientGoesAway(t *testing.T) {
	h := boot(t, nil)
	finished := make(chan error, 1)
	slow := func(ctx context.Context) {
		time.Sleep(300 * time.Millisecond) // the client has long given up
		finished <- ctx.Err()
	}
	h.service.onAction = slow
	h.server.svc = &clientStub{stubService: h.service, client: slowRaw{onRaw: slow}}
	client := &http.Client{Timeout: 50 * time.Millisecond}
	// Both ways in: the API, and /RPC2, where an *arr app's d.erase or load
	// comes through.
	call := `<?xml version="1.0"?><methodCall><methodName>d.erase</methodName></methodCall>`
	for _, path := range []string{"/api/torrents/" + hash + "/action/stop", "/RPC2"} {
		req, _ := http.NewRequest("POST", h.base+path, strings.NewReader(call))
		req.Header.Set("Content-Type", "text/xml")
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			t.Fatalf("%s: the request should have timed out on the client", path)
		}
		select {
		case err := <-finished:
			if err != nil {
				t.Fatalf("%s: the change ran under a cancelled context: %v", path, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s: the change never ran to its end", path)
		}
	}
}

// slowRaw hands the context a raw call ran under to a hook.
type slowRaw struct {
	rtorrent.Client
	onRaw func(context.Context)
}

func (c slowRaw) Raw(ctx context.Context, _ []byte) ([]byte, error) {
	c.onRaw(ctx)
	return []byte("<methodResponse/>"), nil
}

func TestOnlyARequestRefusedAsSentLeavesTheStreamAlone(t *testing.T) {
	h := boot(t, nil)
	source := &changing{}
	h.service.state = source.state
	h.service.fail = map[string]error{
		"setTorrentThrottle": &xmlrpc.Fault{Code: -501, Message: "Could not find info-hash"},
		"addTorrentUrl":      httperr.New(http.StatusConflict, `"a" is already loaded`),
	}
	resp := raw(t, h.base+"/api/stream", nil)
	events := bufio.NewReader(resp.Body)
	if name, _ := readEvent(t, events); name != "snapshot" {
		t.Fatalf("got %s", name)
	}
	source.set(7)
	reads := source.readCount()
	// Refused before it changed anything: rtorrent is not read again for it.
	for _, c := range []struct {
		method, path, body string
		status             int
	}{
		{"POST", "/api/torrents/not-a-hash/action/start", "", 400},
		{"PATCH", "/api/torrents/" + hash, `{"priority":"high"}`, 400},
		{"POST", "/api/torrents/action/start", `{"hashes":`, 400},
		{"POST", "/api/no/such/thing", "{}", 404},
		{"POST", "/api/torrents/url", `{"url":"magnet:?xt=urn:btih:` + hash + `"}`, 409},
	} {
		if r := send(t, c.method, h.base+c.path, c.body, nil); r.status != c.status {
			t.Fatalf("%s %s: %d %s", c.method, c.path, r.status, r.raw)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if got := source.readCount(); got != reads {
		t.Fatalf("a refused request read the state: %d reads, then %d", reads, got)
	}
	if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/action/start", "", nil); r.status != 200 {
		t.Fatalf("%d", r.status)
	}
	if name, data := readEvent(t, events); name != "delta" || !strings.Contains(data, `"upRate":7`) {
		t.Fatalf("%s %s", name, data)
	}
	// A failure that may have followed a change shows it at once as well.
	// The state is read once a minute here: only a wake reads it this soon.
	for i, c := range []struct {
		name, method, path, body string
		fail                     error
		status                   int
	}{
		// The torrent is erased, then its data cannot be deleted.
		{"a 500 after the erase", "DELETE", "/api/torrents/" + hash + "?deleteData=true", "",
			httperr.New(http.StatusInternalServerError, "the torrent was removed, but its data could not be deleted"), 500},
		// The data path moved out of the roots between the two checks.
		{"a 403 after the erase", "DELETE", "/api/torrents/" + hash + "?deleteData=true", "",
			httperr.New(http.StatusForbidden, "refusing to delete"), 403},
		// The priority took; the throttle change faulted (see fail above).
		{"a fault after the first field", "PATCH", "/api/torrents/" + hash, `{"priority":3,"throttle":"slow"}`, nil, 502},
		// Stopped and closed, then d.directory.set faulted.
		{"a fault after the stop", "PATCH", "/api/torrents/" + other, `{"directory":"/downloads/x"}`, nil, 502},
	} {
		if c.fail != nil {
			h.service.mu.Lock()
			h.service.fail["remove"] = c.fail
			h.service.mu.Unlock()
		}
		rate := int64(100 + i)
		source.set(rate)
		if r := send(t, c.method, h.base+c.path, c.body, nil); r.status != c.status {
			t.Fatalf("%s: %d %s", c.name, r.status, r.raw)
		}
		if name, data := readEvent(t, events); name != "delta" || !strings.Contains(data, fmt.Sprintf(`"upRate":%d`, rate)) {
			t.Fatalf("%s: %s %s", c.name, name, data)
		}
	}
	wantCall(t, h.service, "setPriority", hash, int64(3))
}

func TestTheStreamRefusesOtherSites(t *testing.T) {
	h := boot(t, nil)
	h.service.state = (&changing{}).state
	for header, refused := range map[string]bool{"cross-site": true, "same-site": true, "same-origin": false, "none": false} {
		resp := raw(t, h.base+"/api/stream", map[string]string{"Sec-Fetch-Site": header})
		if (resp.StatusCode == http.StatusForbidden) != refused {
			t.Errorf("Sec-Fetch-Site %s: %d", header, resp.StatusCode)
		}
		resp.Body.Close()
	}
	if resp := raw(t, h.base+"/api/stream", map[string]string{"Origin": "https://evil.example"}); resp.StatusCode != http.StatusForbidden {
		t.Errorf("a foreign Origin: %d", resp.StatusCode)
	}
}

func TestTooManyStreamsAreRefusedUntilOneCloses(t *testing.T) {
	h := boot(t, nil)
	h.service.state = (&changing{}).state
	// Compressed, as a browser takes them: the compressor keeps a failed
	// flush to itself, so only the request's context can tell the stream
	// that its page went away.
	gzipped := map[string]string{"Accept-Encoding": "gzip"}
	var open []*http.Response
	defer func() {
		for _, resp := range open {
			resp.Body.Close()
		}
	}()
	for len(open) < 100 {
		resp := raw(t, h.base+"/api/stream", gzipped)
		if resp.StatusCode != 200 {
			t.Fatalf("stream %d: %d", len(open)+1, resp.StatusCode)
		}
		open = append(open, resp)
	}
	refused := raw(t, h.base+"/api/stream", gzipped)
	if refused.StatusCode != http.StatusServiceUnavailable || refused.Header.Get("Retry-After") == "" {
		t.Fatalf("%d %v", refused.StatusCode, refused.Header)
	}
	// HEAD subscribes to nothing, so it is answered even now.
	req, _ := http.NewRequest(http.MethodHead, h.base+"/api/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatalf("HEAD: %d %v", resp.StatusCode, resp.Header)
	}
	// A page that goes away gives its slot back.
	open[0].Body.Close()
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		again := raw(t, h.base+"/api/stream", gzipped)
		if again.StatusCode == 200 {
			break
		}
		again.Body.Close()
		if time.Now().After(deadline) {
			t.Fatalf("no stream was let in after one closed: %d", again.StatusCode)
		}
	}
}

func TestStaticFilesNeverLeaveTheWebRoot(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := boot(t, func(c *config.Config) {
		withWeb(t, map[string]string{"index.html": "<!doctype html>", "assets/app.js": "x"})(c)
		if err := os.Symlink(outside, filepath.Join(c.WebRoot, "leak.txt")); err != nil {
			t.Fatal(err)
		}
		// Relative: os.Root follows no absolute link, even one that stays in.
		if err := os.Symlink(filepath.Join("assets", "app.js"), filepath.Join(c.WebRoot, "inside.js")); err != nil {
			t.Fatal(err)
		}
	})
	resp := raw(t, h.base+"/leak.txt", nil)
	body := make([]byte, 64)
	n, _ := resp.Body.Read(body)
	if strings.Contains(string(body[:n]), "SECRET") {
		t.Fatal("a symlink led out of the web root")
	}
	if resp := raw(t, h.base+"/inside.js", nil); resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("a symlink within the root: %d %v", resp.StatusCode, resp.Header)
	}
	if r := send(t, "POST", h.base+"/some/page", "{}", nil); r.status != 404 || !strings.Contains(string(r.raw), "Cannot POST /some/page") {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestAJSONBodyMustBeUTF8(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/torrents/action/start", `{"hashes":["`+hash+`"]}`,
		map[string]string{"Content-Type": "application/json; charset=utf-16"})
	if r.status != http.StatusUnsupportedMediaType {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	r = send(t, "POST", h.base+"/api/torrents/action/start", `{"hashes":["`+hash+`"]}`,
		map[string]string{"Content-Type": "application/json; charset=UTF-8"})
	if r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestAScalarBodyIsNamedByItsFirstCharacters(t *testing.T) {
	h := boot(t, nil)
	body := `"räksmörgås` + strings.Repeat("x", jsonLimit-20) + `"`
	r := send(t, "POST", h.base+"/api/torrents/action/start", body, nil)
	if r.status != 400 || r.body["error"] != `request body must be a JSON object, not "\"räksmörgåsxxxxxxxxx…"` {
		t.Fatalf("%d %.200s", r.status, r.raw)
	}
	for text, want := range map[string]string{"räksmörgås": "räk…", "räk": "räk", "": "", "a\xffbc": "a\xffb…"} {
		if got := truncate([]byte(text), 3); got != want {
			t.Errorf("%q: %q, want %q", text, got, want)
		}
	}
	// The error names twenty characters of a body of megabytes, and must not
	// copy or decode the rest of it to do so.
	big := []byte(strings.Repeat("ö", jsonLimit/2))
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	cut := truncate(big, 20)
	runtime.ReadMemStats(&after)
	if grown := after.TotalAlloc - before.TotalAlloc; cut != strings.Repeat("ö", 20)+"…" || grown > 64<<10 {
		t.Fatalf("%q, %d bytes allocated", cut, grown)
	}
}

func TestAnUploadBodyIsCappedAsAWhole(t *testing.T) {
	h := boot(t, func(c *config.Config) { c.MaxUploadBytes = 100 })
	// A preamble of short lines, which no part limit sees, far past what the
	// parts could add up to.
	boundary := "cascadecap"
	body := strings.Repeat("x\r\n", 2<<20) + "--" + boundary + "\r\n" +
		`Content-Disposition: form-data; name="urls"` + "\r\n\r\nmagnet:?x\r\n--" + boundary + "--\r\n"
	r := do(t, "POST", h.base+"/api/torrents/upload", strings.NewReader(body),
		map[string]string{"Content-Type": "multipart/form-data; boundary=" + boundary})
	if r.status != http.StatusRequestEntityTooLarge || !strings.Contains(string(r.raw), "batch exceeds 100 bytes") {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if n := h.service.count(); n != 0 {
		t.Fatalf("%d calls reached the service", n)
	}
}

func TestRoutesMatchInOrderWithoutRegardToCase(t *testing.T) {
	h := boot(t, nil)
	// First match wins: "action" here is the bulk route, not a torrent hash.
	if r := send(t, "POST", h.base+"/api/torrents/action/trackers", `{"hashes":["`+hash+`"]}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	wantCall(t, h.service, "action", hash, "trackers")
	if r := send(t, "GET", h.base+"/API/Nothing", "", nil); r.status != 404 || r.body["error"] != "no such endpoint: GET /Nothing" {
		t.Errorf("%d %s", r.status, r.raw)
	}
	for _, path := range []string{"/API/Game", "/api/game/", "/api//game"} {
		r := send(t, "GET", h.base+path, "", nil)
		if want := path != "/api//game"; (r.status == 200) != want {
			t.Errorf("%s: %d", path, r.status)
		}
	}
}
