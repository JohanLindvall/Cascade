package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runWith(t *testing.T, env map[string]string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errs bytes.Buffer
	code = run(args, func(name string) string { return env[name] }, &out, &errs)
	return code, out.String(), errs.String()
}

func TestHelpIsAnsweredWhateverElseIsAsked(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"help"}, {"serve", "-h"}} {
		code, out, _ := runWith(t, nil, args...)
		if code != 0 || !strings.Contains(out, "CASCADE_STATE_POLL_MS") {
			t.Errorf("%v: %d %q", args, code, out[:min(len(out), 80)])
		}
	}
	if code, _, errs := runWith(t, nil, "frobnicate"); code != 2 || !strings.Contains(errs, "unknown command") {
		t.Errorf("an unknown command: %d %q", code, errs)
	}
}

func TestBootSettingsPrintJSONOrFailByName(t *testing.T) {
	code, out, _ := runWith(t, map[string]string{"RT_DOWNLOAD_RATE": "100"}, "boot-settings")
	if code != 0 || !strings.Contains(out, `"downloadRate":102400`) {
		t.Fatalf("%d %q", code, out)
	}
	code, _, errs := runWith(t, map[string]string{"RT_PEX": "perhaps"}, "boot-settings")
	if code != 1 || !strings.Contains(errs, "RT_PEX") {
		t.Fatalf("%d %q", code, errs)
	}
}

func TestLogScopesAreReadDefensively(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct{ content, want string }{
		{`{"logScopes":["debug","tracker_debug"]}`, "debug tracker_debug\n"},
		// Nothing that could carry an rc line survives.
		{`{"logScopes":["debug\nexecute = rm","DEBUG","x",7,"ok_scope"]}`, "ok_scope\n"},
		{`{"logScopes":[]}`, "\n"},
		{`{"prefs":{}}`, "\n"},
		{`{"logScopes":["debug"]`, ""}, // corrupt: nothing at all
	} {
		file := filepath.Join(dir, "state.json")
		if err := os.WriteFile(file, []byte(c.content), 0o644); err != nil {
			t.Fatal(err)
		}
		if code, out, _ := runWith(t, nil, "log-scopes", file); code != 0 || out != c.want {
			t.Errorf("%s: %d %q, want %q", c.content, code, out, c.want)
		}
	}
	if code, out, _ := runWith(t, nil, "log-scopes", filepath.Join(dir, "missing.json")); code != 0 || out != "" {
		t.Errorf("a missing file: %d %q", code, out)
	}
	if code, _, _ := runWith(t, nil, "log-scopes"); code != 2 {
		t.Errorf("no file named: %d", code)
	}
}

func TestTheOptionDocsAreInStep(t *testing.T) {
	if code, out, errs := runWith(t, nil, "options-docs"); code != 0 {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	if code, _, _ := runWith(t, nil, "options-docs", t.TempDir()); code != 1 {
		t.Fatalf("a directory without the files: %d", code)
	}
}

func TestServeRefusesABadConfigurationWithItsReason(t *testing.T) {
	code, _, errs := runWith(t, map[string]string{"WEB_PORT": "eighty"}, "serve")
	if code != 1 || !strings.Contains(errs, "WEB_PORT") {
		t.Fatalf("%d %q", code, errs)
	}
}

// health answers for the image's HEALTHCHECK: 0 only when /healthz says 200 on
// the address the server listens on.
func TestHealthAsksTheServerWhereItListens(t *testing.T) {
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(server.Close)
	host, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	env := map[string]string{"WEB_HOST": host, "WEB_PORT": port}

	if code, _, errs := runWith(t, env, "health"); code != 0 {
		t.Fatalf("a healthy server: %d %q", code, errs)
	}
	// Bound to every interface, the server is asked on loopback.
	if code, _, errs := runWith(t, map[string]string{"WEB_HOST": "0.0.0.0", "WEB_PORT": port}, "health"); code != 0 {
		t.Fatalf("an unspecified host: %d %q", code, errs)
	}
	status = http.StatusServiceUnavailable
	if code, _, errs := runWith(t, env, "health"); code != 1 || !strings.Contains(errs, "503") {
		t.Fatalf("an unhealthy answer: %d %q", code, errs)
	}
	server.Close()
	if code, _, errs := runWith(t, env, "health"); code != 1 || !strings.Contains(errs, "unhealthy") {
		t.Fatalf("nothing listening: %d %q", code, errs)
	}
}
