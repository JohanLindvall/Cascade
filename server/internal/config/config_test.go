package config

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/options"
)

// Load is the only reader of the environment, and every default it uses
// comes out of the option catalog — so a fresh environment must give the
// documented defaults, and the few values that are shaped rather than copied
// (the base path, the delete roots, the SCGI target) are pinned here.

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func load(t *testing.T, values map[string]string) Config {
	t.Helper()
	cfg, err := Load(env(values))
	if err != nil {
		t.Fatalf("Load(%v): %v", values, err)
	}
	return cfg
}

func documented(t *testing.T, name string) string {
	t.Helper()
	value, ok := options.Default(name)
	if !ok {
		t.Fatalf("%s has no documented default", name)
	}
	return value
}

func TestAnEmptyEnvironmentYieldsTheDocumentedDefaults(t *testing.T) {
	cfg := load(t, nil)
	if port, _ := strconv.Atoi(documented(t, "WEB_PORT")); cfg.Port != port {
		t.Errorf("port %d, want %d", cfg.Port, port)
	}
	if cfg.Host != documented(t, "WEB_HOST") || cfg.BasePath != "/" {
		t.Errorf("host %q base %q", cfg.Host, cfg.BasePath)
	}
	downloads := documented(t, "RT_DOWNLOAD_DIR")
	if cfg.DownloadDir != downloads || cfg.CompletedDir != "" {
		t.Errorf("download %q completed %q", cfg.DownloadDir, cfg.CompletedDir)
	}
	if want := []string{filepath.Clean(downloads)}; !reflect.DeepEqual(cfg.DeleteRoots, want) {
		t.Errorf("delete roots %v, want %v", cfg.DeleteRoots, want)
	}
	if got, want := cfg.SCGI.String(), documented(t, "RT_SCGI_SOCKET"); !strings.Contains(got, want) {
		t.Errorf("scgi %q, want the socket %q", got, want)
	}
	if !cfg.AllowRawRPC || !cfg.Gamify || cfg.User != "" {
		t.Errorf("raw rpc %v gamify %v user %q", cfg.AllowRawRPC, cfg.Gamify, cfg.User)
	}
	if mb, _ := strconv.ParseInt(documented(t, "CASCADE_MAX_UPLOAD_MB"), 10, 64); cfg.MaxUploadBytes != mb*1024*1024 {
		t.Errorf("upload limit %d", cfg.MaxUploadBytes)
	}
	if ms, _ := strconv.Atoi(documented(t, "CASCADE_STATE_POLL_MS")); cfg.StatePollMs != ms {
		t.Errorf("state poll %d, want %d", cfg.StatePollMs, ms)
	}
}

func TestTheBasePathIsNormalised(t *testing.T) {
	for in, want := range map[string]string{"rtorrent/": "/rtorrent", "/ui": "/ui", "/": "/", "/cascade///": "/cascade"} {
		if got := load(t, map[string]string{"WEB_BASE_PATH": in}).BasePath; got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"/a/../b", "/a/./b", "/x:y", "/{*splat}", "/a b"} {
		if _, err := Load(env(map[string]string{"WEB_BASE_PATH": bad})); err == nil || !strings.Contains(err.Error(), "WEB_BASE_PATH") {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestDeleteRootsCollectDownloadCompletedAndExtraDirectoriesResolved(t *testing.T) {
	cfg := load(t, map[string]string{
		"RT_DOWNLOAD_DIR":      "/data/dl",
		"RT_COMPLETED_DIR":     "/data/done/",
		"CASCADE_DELETE_ROOTS": "/mnt/a::relative/../b",
	})
	b, _ := filepath.Abs("b")
	if want := []string{"/data/dl", "/data/done", "/mnt/a", b}; !reflect.DeepEqual(cfg.DeleteRoots, want) {
		t.Errorf("%v, want %v", cfg.DeleteRoots, want)
	}
}

func TestCascadeSCGIOverridesTheSocketAndUnderstandsHostPort(t *testing.T) {
	remote := load(t, map[string]string{"CASCADE_SCGI": "rt.internal:5000"}).SCGI
	if got := remote.String(); !strings.Contains(got, "rt.internal:5000") {
		t.Errorf("tcp target %q", got)
	}
	socket := load(t, map[string]string{"RT_SCGI_SOCKET": "/tmp/x.sock"}).SCGI
	if got := socket.String(); !strings.Contains(got, "/tmp/x.sock") {
		t.Errorf("unix target %q", got)
	}
	if remote.String() == socket.String() {
		t.Error("the two targets describe themselves the same")
	}
}

func TestBooleansReadTheUsualSpellingsAndEmptyMeansUnset(t *testing.T) {
	for value, want := range map[string]bool{"0": false, "no": false, "YES": true, "": true} {
		if got := load(t, map[string]string{"CASCADE_GAMIFY": value}).Gamify; got != want {
			t.Errorf("CASCADE_GAMIFY=%q: %v", value, got)
		}
	}
	if _, err := Load(env(map[string]string{"WEB_PORT": "eighty"})); err == nil || !strings.Contains(err.Error(), "WEB_PORT") {
		t.Errorf("WEB_PORT=eighty: %v", err)
	}
	// A typo is refused rather than read as off.
	for _, value := range []string{"ture", "enabled", "2"} {
		if _, err := Load(env(map[string]string{"CASCADE_ALLOW_RAW_RPC": value})); err == nil || !strings.Contains(err.Error(), "CASCADE_ALLOW_RAW_RPC") {
			t.Errorf("CASCADE_ALLOW_RAW_RPC=%s: %v", value, err)
		}
	}
	for value, want := range map[string]bool{"Off": false, "ON": true, "false": false, "1": true} {
		if got := load(t, map[string]string{"CASCADE_ALLOW_DATA_DELETE": value}).AllowDataDelete; got != want {
			t.Errorf("CASCADE_ALLOW_DATA_DELETE=%s: %v", value, got)
		}
	}
}

func TestInvalidPortsIntervalsAndUploadLimitsFailEarly(t *testing.T) {
	for _, value := range []string{"-1", "0", "1.5", "NaN", "Infinity"} {
		for _, name := range []string{"WEB_PORT", "CASCADE_POLL_MS", "CASCADE_MAX_UPLOAD_MB", "CASCADE_STATE_POLL_MS"} {
			if _, err := Load(env(map[string]string{name: value})); err == nil || !strings.Contains(err.Error(), name) {
				t.Errorf("%s=%s: %v", name, value, err)
			}
		}
	}
	for name, value := range map[string]string{"WEB_PORT": "65536", "CASCADE_POLL_MS": "2147483648", "CASCADE_STATE_POLL_MS": "60001"} {
		if _, err := Load(env(map[string]string{name: value})); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=%s: %v", name, value, err)
		}
	}
	// Numbers read the way the browser reads them.
	if port := load(t, map[string]string{"WEB_PORT": " 0x1F90 "}).Port; port != 8080 {
		t.Errorf("hex port %d", port)
	}
	if ms := load(t, map[string]string{"CASCADE_STATE_POLL_MS": "5e1"}).StatePollMs; ms != 100 {
		t.Errorf("a state poll under the floor is raised to it, got %d", ms)
	}
}

func TestStartupSettingsFollowTheCatalog(t *testing.T) {
	settings, err := StartupSettings(env(nil))
	if err != nil || !reflect.DeepEqual(settings, map[string]any{"xmlrpcSizeLimit": int64(16777216)}) {
		t.Fatalf("defaults %v %v", settings, err)
	}
	settings, err = StartupSettings(env(map[string]string{"RT_DOWNLOAD_RATE": "500", "RT_PEX": "no", "RT_MAX_PEERS_SEED": "-1"}))
	if err != nil {
		t.Fatal(err)
	}
	if settings["downloadRate"] != int64(500*1024) || settings["pex"] != false || settings["maxPeersSeed"] != int64(-1) {
		t.Errorf("units, booleans and signed values: %v", settings)
	}
}

func TestQuotesAndBackslashesInStartupStringsSurviveJSON(t *testing.T) {
	proxy := `http://user:some"password@proxy.example/path\`
	settings, err := StartupSettings(env(map[string]string{"RT_PROXY": proxy}))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(settings)
	var back map[string]any
	if err := json.Unmarshal(data, &back); err != nil || back["proxyAddress"] != proxy {
		t.Errorf("%s -> %v %v", data, back, err)
	}
}

func TestInvalidStartupInputFailsByEnvironmentName(t *testing.T) {
	for name, value := range map[string]string{"RT_DOWNLOAD_RATE": "fast", "RT_PEX": "perhaps", "RT_MAX_UPLOADS": "-1"} {
		if _, err := StartupSettings(env(map[string]string{name: value})); err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s=%s: %v", name, value, err)
		}
	}
}
