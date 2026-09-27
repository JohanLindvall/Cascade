package httpapi

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/klauspost/compress/zstd"
)

// raw is a request the transport leaves alone: it would otherwise add
// Accept-Encoding itself and undo the gzip on the way in.
func raw(t *testing.T, target string, header map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, target, nil)
	for name, value := range header {
		req.Header.Set(name, value)
	}
	resp, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func withWeb(t *testing.T, files map[string]string) func(*config.Config) {
	return func(c *config.Config) {
		for name, content := range files {
			path := filepath.Join(c.WebRoot, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// decoded is a response body as the client reads it, whichever encoding the
// server chose.
func decoded(t *testing.T, resp *http.Response) io.Reader {
	t.Helper()
	switch encoding := resp.Header.Get("Content-Encoding"); encoding {
	case "":
		return resp.Body
	case "gzip":
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return zr
	case "zstd":
		zr, err := zstd.NewReader(resp.Body, zstd.WithDecoderConcurrency(1))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(zr.Close)
		return zr
	default:
		t.Fatalf("unexpected Content-Encoding %q", encoding)
		return nil
	}
}

func TestTheEncodingIsNegotiated(t *testing.T) {
	big := strings.Repeat("x", 4000)
	h := boot(t, withWeb(t, map[string]string{"index.html": "<!doctype html>" + big, "assets/app-1a2b.js": big, "logo.png": big}))
	var tag string
	for _, c := range []struct{ accept, want string }{
		{"gzip, deflate", "gzip"},
		{"gzip, deflate, br, zstd", "zstd"}, // what a browser offers over HTTPS
		{"zstd", "zstd"},
		{"gzip;q=1.0, zstd;q=0.5", "gzip"},
		{"br;q=1.0, gzip;q=0.8", "gzip"},
		{"", ""},
		{"gzip;q=0", ""},
		{"br", ""},
	} {
		resp := raw(t, h.base+"/assets/app-1a2b.js", map[string]string{"Accept-Encoding": c.accept})
		if got := resp.Header.Get("Content-Encoding"); resp.StatusCode != 200 || got != c.want {
			t.Errorf("%q: %d %q, want %q", c.accept, resp.StatusCode, got, c.want)
			continue
		}
		if !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
			t.Errorf("%q: no Vary", c.accept)
		}
		if body, _ := io.ReadAll(decoded(t, resp)); string(body) != big {
			t.Errorf("%q: %d bytes back", c.accept, len(body))
		}
		// One validator whatever the encoding, so revalidating stays a 304.
		if tag == "" {
			tag = resp.Header.Get("ETag")
		} else if got := resp.Header.Get("ETag"); got != tag {
			t.Errorf("%q: ETag %q, want %q", c.accept, got, tag)
		}
	}
	if again := raw(t, h.base+"/assets/app-1a2b.js", map[string]string{"Accept-Encoding": "zstd", "If-None-Match": tag}); again.StatusCode != 304 {
		t.Errorf("revalidating over zstd: %d", again.StatusCode)
	}
	for _, path := range []string{
		"/healthz",   // too small to gain
		"/logo.png",  // compressed already
		"/api/state", // small
	} {
		resp := raw(t, h.base+path, map[string]string{"Accept-Encoding": "gzip, zstd"})
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("%s: %s", path, resp.Header.Get("Content-Encoding"))
		}
	}
}

func TestStaticFilesAreCachedByWhatCanChange(t *testing.T) {
	h := boot(t, withWeb(t, map[string]string{"index.html": "<!doctype html>", "assets/app-1a2b.js": "x", ".env": "SECRET=1"}))
	asset := raw(t, h.base+"/assets/app-1a2b.js", nil)
	if asset.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		!strings.HasPrefix(asset.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("asset %v", asset.Header)
	}
	shell := raw(t, h.base+"/torrents/some/route", nil)
	body, _ := io.ReadAll(shell.Body)
	if shell.StatusCode != 200 || string(body) != "<!doctype html>" || shell.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("shell %d %q %v", shell.StatusCode, body, shell.Header)
	}
	again := raw(t, h.base+"/", map[string]string{"If-None-Match": shell.Header.Get("ETag")})
	if again.StatusCode != 304 {
		t.Fatalf("revalidating the shell: %d", again.StatusCode)
	}
	if missing := raw(t, h.base+"/assets/gone-9z.js", nil); missing.StatusCode != 404 {
		t.Fatalf("a missing asset: %d", missing.StatusCode)
	}
	// A dotfile is never served, and a path cannot climb out of the root.
	for _, path := range []string{"/.env", "/assets/../.env", "/%2e%2e/%2e%2e/etc/passwd"} {
		resp := raw(t, h.base+path, nil)
		body, _ := io.ReadAll(resp.Body)
		if strings.Contains(string(body), "SECRET") || strings.Contains(string(body), "root:") {
			t.Errorf("%s leaked %q", path, body)
		}
	}
}

// readEvent reads one server-sent event, skipping comments and retry lines.
func readEvent(t *testing.T, r *bufio.Reader) (name, data string) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\n")
			switch {
			case line == "" && name != "":
				return
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("no event on the stream")
	}
	return name, data
}

// a service whose state a test can change.
type changing struct {
	mu   sync.Mutex
	rate int64
}

func (c *changing) set(rate int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rate = rate
}

func (c *changing) state(context.Context) (contracts.StateResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return contracts.StateResponse{
		Status:   contracts.GlobalStatus{StatePollMs: 60_000, History: []contracts.RateSample{}},
		Torrents: []contracts.Torrent{{Hash: hash, UpRate: c.rate}},
	}, nil
}

func TestTheStreamSendsASnapshotThenOnlyChanges(t *testing.T) {
	for _, encoding := range []string{"gzip", "zstd", ""} {
		t.Run("encoding "+encoding, func(t *testing.T) {
			h := boot(t, func(c *config.Config) { c.BasePath = "/cascade" })
			source := &changing{}
			h.service.state = source.state
			resp := raw(t, h.base+"/cascade/api/stream", map[string]string{"Accept-Encoding": encoding})
			if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" ||
				resp.Header.Get("Content-Encoding") != encoding {
				t.Fatalf("%d %v", resp.StatusCode, resp.Header)
			}
			events := bufio.NewReader(decoded(t, resp))
			name, data := readEvent(t, events)
			var snapshot struct {
				Torrents map[string]struct{ Hash string }
			}
			if err := json.Unmarshal([]byte(data), &snapshot); name != "snapshot" || err != nil || snapshot.Torrents[hash].Hash != hash {
				t.Fatalf("first event %s %s", name, data)
			}

			// The state is read once a minute here: only the wake after a
			// change through the API can have read it this soon.
			source.set(9)
			if r := send(t, "POST", h.base+"/cascade/api/torrents/"+hash+"/action/start", "", nil); r.status != 200 {
				t.Fatalf("%d %s", r.status, r.raw)
			}
			if name, data := readEvent(t, events); name != "delta" || data != `{"torrents":{"`+hash+`":{"upRate":9}}}` {
				t.Fatalf("second event %s %s", name, data)
			}
		})
	}
}

func TestTheStreamIsGuardedLikeEverythingElse(t *testing.T) {
	h := boot(t, func(c *config.Config) { c.User, c.Password = "admin", "secret" })
	source := &changing{}
	h.service.state = source.state
	if resp := raw(t, h.base+"/api/stream", nil); resp.StatusCode != 401 || resp.Header.Get("WWW-Authenticate") == "" {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	resp := raw(t, h.base+"/api/stream", map[string]string{"Authorization": basic("admin", "secret")})
	if resp.StatusCode != 200 {
		t.Fatalf("with credentials: %d", resp.StatusCode)
	}
	if name, _ := readEvent(t, bufio.NewReader(resp.Body)); name != "snapshot" {
		t.Fatalf("got %s", name)
	}
}
