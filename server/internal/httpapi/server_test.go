// SPDX-License-Identifier: MIT

package httpapi

// The HTTP contract: input that is not what a route expects must come back
// as a 400 that names the problem rather than reaching rtorrent and
// returning as an opaque fault, bulk routes must report per-hash failures
// instead of stopping, unknown API paths must answer JSON, and Basic auth
// must guard everything but /healthz. The service underneath is a stub that
// records what it was asked.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/store"
)

var (
	hash  = strings.Repeat("A", 40)
	other = strings.Repeat("B", 40)
)

type stubCall struct {
	method string
	args   []any
}

// stubService records what it was asked and fails for the other hash. The
// embedded interface is nil: a route that reaches a method the stub does not
// define panics, which fails the test that took it there.
type stubService struct {
	Service
	mu    sync.Mutex
	calls []stubCall
	state func(context.Context) (contracts.StateResponse, error)
	// Called with the context an action ran under, when set.
	onAction func(context.Context)
	// What a method answers after it is recorded, whatever it was asked:
	// a change that went through and then failed.
	fail map[string]error
}

func (s *stubService) record(method string, args ...any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, stubCall{method, args})
	if err := s.fail[method]; err != nil {
		return err
	}
	if len(args) > 0 && args[0] == other {
		return httperr.New(http.StatusBadGateway, "rtorrent said no")
	}
	return nil
}

func (s *stubService) callsTo(method string) []stubCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []stubCall
	for _, c := range s.calls {
		if c.method == method {
			out = append(out, c)
		}
	}
	return out
}

func (s *stubService) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

func (s *stubService) Ready() bool                              { return false }
func (s *stubService) EnsureCapabilities(context.Context) error { return nil }
func (s *stubService) MethodNames() []string                    { return []string{"a", "b"} }
func (s *stubService) Game() contracts.GameState                { return contracts.GameState{Enabled: true} }
func (s *stubService) LogScopes() contracts.LogScopeState {
	return contracts.LogScopeState{Boot: []string{}, Extra: []string{}, Available: []string{}, Supported: true}
}
func (s *stubService) State(ctx context.Context) (contracts.StateResponse, error) {
	if s.state != nil {
		return s.state(ctx)
	}
	return contracts.StateResponse{Torrents: []contracts.Torrent{}}, s.record("state")
}
func (s *stubService) Action(ctx context.Context, hash, action string) error {
	if s.onAction != nil {
		s.onAction(ctx)
	}
	return s.record("action", hash, action)
}
func (s *stubService) Remove(_ context.Context, hash string, deleteData bool) error {
	return s.record("remove", hash, deleteData)
}
func (s *stubService) SetPriority(_ context.Context, hash string, priority int64) error {
	return s.record("setPriority", hash, priority)
}
func (s *stubService) SetLabel(_ context.Context, hash, label string) error {
	return s.record("setLabel", hash, label)
}
func (s *stubService) SetFilePriority(_ context.Context, hash string, index int, priority int64) error {
	return s.record("setFilePriority", hash, index, priority)
}
func (s *stubService) AddTracker(_ context.Context, hash, url string, group int64) error {
	return s.record("addTracker", hash, url, group)
}
func (s *stubService) AddTorrentFile(_ context.Context, data []byte, _ contracts.LoadOptions) error {
	return s.record("addTorrentFile", string(data))
}
func (s *stubService) AddTorrentURL(_ context.Context, url string, _ contracts.LoadOptions) error {
	return s.record("addTorrentUrl", url)
}
func (s *stubService) Client() rtorrent.Client { return &stubClient{s: s} }

type stubClient struct {
	rtorrent.Client
	s *stubService
}

func (c *stubClient) Call(_ context.Context, method string, params ...any) (any, error) {
	return "pong", c.s.record("rpc", append([]any{method}, params...)...)
}

func testConfig(t *testing.T, change func(*config.Config)) config.Config {
	t.Helper()
	root := t.TempDir()
	downloads := filepath.Join(root, "downloads")
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

type harness struct {
	base    string
	service *stubService
	server  *Server
}

func boot(t *testing.T, change func(*config.Config)) *harness {
	t.Helper()
	service := &stubService{}
	st := store.Open(filepath.Join(t.TempDir(), "state.json"))
	server := New(service, testConfig(t, change), st)
	front := httptest.NewServer(server)
	t.Cleanup(front.Close)
	return &harness{base: front.URL, service: service, server: server}
}

type reply struct {
	status int
	header http.Header
	body   map[string]any
	raw    []byte
}

func do(t *testing.T, method, target string, body io.Reader, header map[string]string) reply {
	t.Helper()
	req, err := http.NewRequest(method, target, body)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range header {
		req.Header.Set(name, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	return reply{resp.StatusCode, resp.Header, decoded, raw}
}

// send is a JSON request, the way the web client makes them.
func send(t *testing.T, method, target, body string, header map[string]string) reply {
	t.Helper()
	all := map[string]string{"Content-Type": "application/json"}
	for name, value := range header {
		all[name] = value
	}
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	return do(t, method, target, reader, all)
}

func TestHealthzAnswersWithoutAuthAndReportsReadiness(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "GET", h.base+"/healthz", "", nil)
	if r.status != 200 || !reflect.DeepEqual(r.body, map[string]any{"ok": true, "rtorrent": false}) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestAnUnknownAPIPathIsAJSON404(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "GET", h.base+"/api/nothing/here", "", nil)
	if r.status != 404 || !strings.Contains(r.body["error"].(string), "no such endpoint: GET /nothing/here") {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	// A known path with another method is no endpoint either, not a 405.
	if r := send(t, "PUT", h.base+"/api/state", "{}", nil); r.status != 404 || r.body["error"] != "no such endpoint: PUT /state" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestBackendErrorsAreBadGateway(t *testing.T) {
	h := boot(t, nil)
	h.service.state = func(context.Context) (contracts.StateResponse, error) {
		return contracts.StateResponse{}, httperr.Backend("SCGI connection failed")
	}
	r := send(t, "GET", h.base+"/api/state", "", nil)
	if r.status != 502 || r.body["error"] != "SCGI connection failed" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestAMalformedInfoHashIsRefusedBeforeTheServiceIsAsked(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/torrents/not-a-hash/action/start", "", nil)
	if r.status != 400 || r.body["error"] != "invalid info hash" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if len(h.service.callsTo("action")) != 0 {
		t.Fatal("the service was asked")
	}
}

func TestALowercaseHashIsAcceptedAndNormalised(t *testing.T) {
	h := boot(t, nil)
	if r := send(t, "POST", h.base+"/api/torrents/"+strings.ToLower(hash)+"/action/stop", "", nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if calls := h.service.callsTo("action"); len(calls) != 1 || !reflect.DeepEqual(calls[0].args, []any{hash, "stop"}) {
		t.Fatalf("%v", calls)
	}
}

func TestBulkActionsCollectFailuresByHashNormaliseAndDeduplicate(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/torrents/action/start",
		`{"hashes":["`+strings.ToLower(hash)+`","`+hash+`","`+other+`"]}`, nil)
	if r.status != 200 || r.body["ok"] != false || !reflect.DeepEqual(r.body["errors"], []any{other + ": rtorrent said no"}) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	var asked []any
	for _, c := range h.service.callsTo("action") {
		asked = append(asked, c.args[0])
	}
	if !reflect.DeepEqual(asked, []any{hash, other}) {
		t.Fatalf("asked %v", asked)
	}
}

func TestMalformedBatchesAndValuesAreRejectedBeforeAnyMutation(t *testing.T) {
	h := boot(t, nil)
	for _, hashes := range []string{`{}`, `{"hashes":[]}`, `{"hashes":["junk"]}`, `{"hashes":["` + hash + `","junk"]}`,
		`{"hashes":[null]}`, `{"hashes":"` + hash + `"}`} {
		if r := send(t, "POST", h.base+"/api/torrents/action/start", hashes, nil); r.status != 400 {
			t.Errorf("%s: %d", hashes, r.status)
		}
	}
	for _, value := range []string{"null", "false", `""`, "[]", "{}", "[1]"} {
		if r := send(t, "PATCH", h.base+"/api/torrents/"+hash, `{"priority":`+value+`}`, nil); r.status != 400 {
			t.Errorf("priority %s: %d", value, r.status)
		}
	}
	if r := send(t, "PATCH", h.base+"/api/torrents/"+hash, `{"priority":3,"label":"test","maxUploads":-1}`, nil); r.status != 400 {
		t.Errorf("a bad last field: %d", r.status)
	}
	if n := h.service.count(); n != 0 {
		t.Fatalf("%d calls reached the service", n)
	}
}

func TestSubpathDeploymentsKeepRootHealthAndRedirectToAUsableBase(t *testing.T) {
	h := boot(t, func(c *config.Config) { c.BasePath, c.User, c.Password = "/cascade", "admin", "secret" })
	for _, path := range []string{"/healthz", "/cascade/healthz"} {
		if r := send(t, "GET", h.base+path, "", nil); r.status != 200 {
			t.Errorf("%s: %d", path, r.status)
		}
	}
	req, _ := http.NewRequest("GET", h.base+"/cascade?x=1", nil)
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 308 || resp.Header.Get("Location") != "/cascade/?x=1" {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	if r := send(t, "GET", h.base+"/elsewhere", "", nil); r.status != 404 {
		t.Errorf("outside the base path: %d", r.status)
	}
}

type formFile struct{ field, name, content string }

func form(t *testing.T, files []formFile, fields map[string]string) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, f := range files {
		part, err := w.CreateFormFile(f.field, f.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(part, f.content)
	}
	for name, value := range fields {
		_ = w.WriteField(name, value)
	}
	_ = w.Close()
	return &buf, w.FormDataContentType()
}

func TestAChunkedUploadStopsReadingAtTheRemainingBatchAllowance(t *testing.T) {
	const limit = 128 << 10
	body, kind := form(t, []formFile{
		{"torrents", "first.torrent", strings.Repeat("a", limit-32)},
		{"torrents", "second.torrent", strings.Repeat("b", limit)},
	}, nil)
	buffer := body.(*bytes.Buffer)
	before := buffer.Len()
	r := httptest.NewRequest(http.MethodPost, "/api/torrents/upload", io.NopCloser(body))
	r.ContentLength = -1
	r.Header.Set("Content-Type", kind)
	_, _, err := readUpload(httptest.NewRecorder(), r, limit)
	var failure *httperr.Error
	if !errors.As(err, &failure) || failure.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized batch: %v", err)
	}
	// Allow framing and the multipart reader's small lookahead, but never
	// buffer another whole file after the earlier file spent the allowance.
	if read := before - buffer.Len(); read > limit+8192 {
		t.Fatalf("read %d bytes for a %d-byte batch allowance", read, limit)
	}
}

func upload(t *testing.T, base string, files []formFile, fields map[string]string, header map[string]string) reply {
	t.Helper()
	body, kind := form(t, files, fields)
	all := map[string]string{"Content-Type": kind}
	for name, value := range header {
		all[name] = value
	}
	return do(t, "POST", base+"/api/torrents/upload", body, all)
}

func TestUnexpectedUploadFieldsAreAClientError(t *testing.T) {
	h := boot(t, nil)
	if r := upload(t, h.base, []formFile{{"wrong", "test.torrent", "x"}}, nil, nil); r.status != 400 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestMalformedRPCParametersAndScopeListsCannotBecomeEmptyRequests(t *testing.T) {
	h := boot(t, nil)
	for _, params := range []string{"null", "{}", "false", `"argument"`} {
		for _, endpoint := range []string{"/api/rpc", "/RPC2"} {
			if r := send(t, "POST", h.base+endpoint, `{"method":"d.erase","params":`+params+`}`, nil); r.status != 400 {
				t.Errorf("%s with params %s: %d", endpoint, params, r.status)
			}
		}
	}
	for _, scopes := range []string{"null", `"debug"`, "[true]", "[{}]"} {
		if r := send(t, "POST", h.base+"/api/log/scopes", `{"scopes":`+scopes+`}`, nil); r.status != 400 {
			t.Errorf("scopes %s: %d", scopes, r.status)
		}
	}
	if n := h.service.count(); n != 0 {
		t.Fatalf("%d calls reached the service", n)
	}
}

func TestTheUploadLimitAppliesToTheWholeBatchBeforeAnyLoad(t *testing.T) {
	h := boot(t, func(c *config.Config) { c.MaxUploadBytes = 100 })
	r := upload(t, h.base, []formFile{{"torrents", "a.torrent", strings.Repeat("a", 60)}, {"torrents", "b.torrent", strings.Repeat("b", 60)}}, nil, nil)
	if r.status != 413 || !strings.Contains(r.body["error"].(string), "batch exceeds") {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	// One file past the limit is named as such.
	r = upload(t, h.base, []formFile{{"torrents", "c.torrent", strings.Repeat("c", 101)}}, nil, nil)
	if r.status != 413 || r.body["error"] != "torrent file exceeds the upload size limit" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if n := h.service.count(); n != 0 {
		t.Fatalf("%d calls reached the service", n)
	}
}

func TestUploadRepliesIdentifyFailedItems(t *testing.T) {
	h := boot(t, nil)
	r := upload(t, h.base, []formFile{{"torrents", "a.torrent", "a"}},
		map[string]string{"urls": "https://example.test/a.torrent\n\n" + other}, nil)
	if r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if r.body["added"] != float64(2) || !reflect.DeepEqual(r.body["failedFiles"], []any{}) ||
		!reflect.DeepEqual(r.body["failedUrls"], []any{float64(1)}) || len(r.body["errors"].([]any)) != 1 {
		t.Fatalf("%s", r.raw)
	}
	// Nothing at all is a mistake, and so is a batch too big.
	if r := upload(t, h.base, nil, map[string]string{"urls": " \n "}, nil); r.status != 400 || r.body["error"] != "no .torrent files or URLs supplied" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if r := send(t, "POST", h.base+"/api/torrents/upload", `{"urls":"`+strings.Repeat(`magnet:?x\n`, 51)+`"}`, nil); r.status != 400 {
		t.Fatalf("51 URLs: %d %s", r.status, r.raw)
	}
}

func TestPatchValidatesPriorityAndSlotCounts(t *testing.T) {
	h := boot(t, nil)
	for _, patch := range []string{`{"priority":"high"}`, `{"priority":7}`, `{"maxUploads":-1}`, `{"maxDownloads":1.5}`} {
		r := send(t, "PATCH", h.base+"/api/torrents/"+hash, patch, nil)
		if r.status != 400 || !strings.Contains(r.body["error"].(string), "must be a whole number") {
			t.Errorf("%s: %d %s", patch, r.status, r.raw)
		}
	}
	if r := send(t, "PATCH", h.base+"/api/torrents/"+hash, `{"priority":3}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if calls := h.service.callsTo("setPriority"); len(calls) != 1 || !reflect.DeepEqual(calls[0].args, []any{hash, int64(3)}) {
		t.Fatalf("%v", calls)
	}
}

func TestAFileIndexAndPriorityAreValidated(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/torrents/"+hash+"/files/abc/priority", `{"priority":1}`, nil)
	if r.status != 400 || !strings.Contains(r.body["error"].(string), `"index"`) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	r = send(t, "POST", h.base+"/api/torrents/"+hash+"/files/2/priority", `{"priority":3}`, nil)
	if r.status != 400 || !strings.Contains(r.body["error"].(string), `"priority"`) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestAnAddedTrackerMustBeAnAnnounceURL(t *testing.T) {
	h := boot(t, nil)
	for _, url := range []string{`"tracker.example.org/announce"`, `"ftp://example.org/announce"`, `"http://"`, "42"} {
		if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/trackers", `{"url":`+url+`}`, nil); r.status != 400 {
			t.Errorf("%s: %d", url, r.status)
		}
	}
	if len(h.service.callsTo("addTracker")) != 0 {
		t.Fatal("a bad URL reached the service")
	}
	if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/trackers", `{"url":" udp://tracker.example.org:6969/announce "}`, nil); r.status != 200 {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	calls := h.service.callsTo("addTracker")
	if len(calls) != 1 || !reflect.DeepEqual(calls[0].args, []any{hash, "udp://tracker.example.org:6969/announce", int64(0)}) {
		t.Fatalf("%v", calls)
	}
}

func TestAMalformedJSONBodyIsA400(t *testing.T) {
	h := boot(t, nil)
	for _, body := range []string{"{not json", `"a string"`, "[1,2]"} {
		r := send(t, "POST", h.base+"/api/torrents/action/start", body, nil)
		if message, ok := r.body["error"].(string); r.status != 400 || !ok || message == "" {
			t.Errorf("%s: %d %s", body, r.status, r.raw)
		}
	}
}

func TestAServiceHTTPErrorKeepsItsStatusAndMessage(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/torrents/"+other+"/action/start", "", nil)
	if r.status != 502 || r.body["error"] != "rtorrent said no" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestRawRPCIsA403WhenSwitchedOff(t *testing.T) {
	h := boot(t, func(c *config.Config) { c.AllowRawRPC = false })
	for method, path := range map[string]string{"GET": "/api/rpc/methods", "POST": "/api/rpc"} {
		if r := send(t, method, h.base+path, "{}", nil); r.status != 403 {
			t.Errorf("%s: %d", path, r.status)
		}
	}
	if r := do(t, "POST", h.base+"/RPC2", strings.NewReader("<methodCall/>"), map[string]string{"Content-Type": "text/xml"}); r.status != 403 {
		t.Errorf("/RPC2: %d", r.status)
	}
}

func TestRawRPCAnswersWithWhatRtorrentSaid(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "POST", h.base+"/api/rpc", `{"method":"system.hostname","params":["x",1]}`, nil)
	if r.status != 200 || r.body["ok"] != true || r.body["result"] != "pong" {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if calls := h.service.callsTo("rpc"); len(calls) != 1 || !reflect.DeepEqual(calls[0].args, []any{"system.hostname", "x", float64(1)}) {
		t.Fatalf("%v", calls)
	}
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestBasicAuthGuardsTheAPIButNotHealthz(t *testing.T) {
	h := boot(t, func(c *config.Config) { c.User, c.Password = "admin", "secret" })
	if r := send(t, "GET", h.base+"/healthz", "", nil); r.status != 200 {
		t.Fatalf("healthz %d", r.status)
	}
	denied := send(t, "GET", h.base+"/api/game", "", nil)
	if denied.status != 401 || !strings.HasPrefix(denied.header.Get("WWW-Authenticate"), `Basic realm="Cascade"`) {
		t.Fatalf("%d %v", denied.status, denied.header)
	}
	if r := send(t, "GET", h.base+"/api/game", "", map[string]string{"Authorization": basic("admin", "nope")}); r.status != 401 {
		t.Fatalf("wrong password: %d", r.status)
	}
	if r := send(t, "GET", h.base+"/api/game", "", map[string]string{"Authorization": basic("admin", "secret")}); r.status != 200 {
		t.Fatalf("right password: %d", r.status)
	}
}

func TestAuthIsOffUnlessBothHalvesAreSet(t *testing.T) {
	for _, c := range []struct {
		user, pass string
		on         bool
	}{{"", "", false}, {"admin", "", false}, {"", "x", false}, {"admin", "x", true}} {
		w := httptest.NewRecorder()
		passed := basicAuth(w, httptest.NewRequest("GET", "/", nil), c.user, c.pass)
		if passed == c.on {
			t.Errorf("user %q pass %q: passed %v", c.user, c.pass, passed)
		}
	}
}

func TestTheRightCredentialsPassAndAnythingElseIsChallenged(t *testing.T) {
	check := func(header string) (bool, *httptest.ResponseRecorder) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/", nil)
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		return basicAuth(w, r, "admin", "p:ss:word"), w
	}
	if ok, _ := check(basic("admin", "p:ss:word")); !ok {
		t.Fatal("a colon inside the password broke it")
	}
	if ok, _ := check(strings.TrimRight(basic("admin", "p:ss:word"), "=")); !ok {
		t.Fatal("unpadded base64 is refused")
	}
	for _, header := range []string{"", "Bearer nope", basic("admin", "wrong"), basic("root", "p:ss:word"), "Basic !!!"} {
		ok, w := check(header)
		if ok || w.Code != 401 || !strings.HasPrefix(w.Header().Get("WWW-Authenticate"), `Basic realm="Cascade"`) {
			t.Errorf("%q: passed %v, %d %v", header, ok, w.Code, w.Header())
		}
	}
}

func TestTheSPAFallbackSaysWhereItLookedWhenTheBuildIsMissing(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "GET", h.base+"/some/client/route", "", nil)
	if r.status != 500 || !strings.Contains(string(r.raw), "web assets not found") {
		t.Fatalf("%d %s", r.status, r.raw)
	}
}

func TestACrossSiteFormPostIsRefusedBeforeItReachesTheService(t *testing.T) {
	h := boot(t, nil)
	r := upload(t, h.base, nil, map[string]string{"urls": "magnet:?xt=urn:btih:" + strings.Repeat("c", 40)},
		map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"})
	if r.status != 403 || !reflect.DeepEqual(r.body, map[string]any{"error": "cross-site request refused"}) {
		t.Fatalf("%d %s", r.status, r.raw)
	}
	if n := h.service.count(); n != 0 {
		t.Fatalf("%d calls reached the service", n)
	}
}

func TestSameOriginAndNonBrowserPostsStillGoThrough(t *testing.T) {
	h := boot(t, nil)
	for _, header := range []map[string]string{{"Sec-Fetch-Site": "same-origin"}, {}} {
		if r := send(t, "POST", h.base+"/api/torrents/"+hash+"/action/stop", "", header); r.status != 200 {
			t.Errorf("%v: %d", header, r.status)
		}
	}
}

func TestEveryResponseCarriesTheHardeningHeaders(t *testing.T) {
	h := boot(t, nil)
	r := send(t, "GET", h.base+"/healthz", "", nil)
	if r.header.Get("X-Content-Type-Options") != "nosniff" || r.header.Get("Referrer-Policy") != "same-origin" {
		t.Fatalf("%v", r.header)
	}
}

func TestAnUnchangedReadIsABodiless304(t *testing.T) {
	h := boot(t, nil)
	first := send(t, "GET", h.base+"/api/game", "", nil)
	tag := first.header.Get("ETag")
	if first.status != 200 || !strings.HasPrefix(tag, `W/"`) || first.header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("%d %v", first.status, first.header)
	}
	again := send(t, "GET", h.base+"/api/game", "", map[string]string{"If-None-Match": tag})
	if again.status != 304 || len(again.raw) != 0 {
		t.Fatalf("%d %q", again.status, again.raw)
	}
	// Asked to bypass its cache, the client gets the body.
	if r := send(t, "GET", h.base+"/api/game", "", map[string]string{"If-None-Match": tag, "Cache-Control": "no-cache"}); r.status != 200 {
		t.Fatalf("%d", r.status)
	}
}
