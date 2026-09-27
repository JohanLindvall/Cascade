// Package httpapi is the HTTP face of Cascade: the JSON API, the state
// stream, the XML-RPC passthrough and the static web UI, behind the
// cross-site guard and optional Basic auth, with every failure answered as
// JSON and every compressible response compressed for clients that take it.
package httpapi

import (
	"context"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/store"
	"github.com/JohanLindvall/Cascade/server/internal/stream"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// Server is the whole HTTP side; it is an http.Handler.
type Server struct {
	svc     Service
	cfg     config.Config
	store   *store.Store
	hub     *stream.Hub
	mux     *router
	handler http.Handler
}

// New wires the handler. The state stream reads through svc, once per
// interval however many pages are open, and not at all while none is.
func New(svc Service, cfg config.Config, st *store.Store) *Server {
	s := &Server{svc: svc, cfg: cfg, store: st}
	s.hub = stream.NewHub(s.readState, time.Duration(cfg.StatePollMs)*time.Millisecond)
	s.mux = s.routes()
	s.handler = compress(http.HandlerFunc(s.serve))
	return s
}

func (s *Server) readState(ctx context.Context) ([]byte, error) {
	state, err := s.svc.State(ctx)
	if err != nil {
		return nil, err
	}
	return encodeJSON(state)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Cheap, compatible hardening on every response: no MIME sniffing of what
	// is served, and no URL (which carries the base path) leaking in Referer
	// to anything outside this origin. Framing is deliberately left alone —
	// dashboards embed Cascade in iframes.
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	s.handler.ServeHTTP(w, r)
}

func (s *Server) serve(out http.ResponseWriter, r *http.Request) {
	readOnly := r.Method == http.MethodGet || r.Method == http.MethodHead
	// Health stays outside the base path and outside Basic auth, so container
	// healthchecks and orchestrator probes work with WEB_USER/WEB_PASS set.
	// It reveals nothing but liveness.
	if readOnly && r.URL.Path == "/healthz" {
		s.health(out, r)
		return
	}
	if base := s.cfg.BasePath; base != "/" {
		// Relative asset and API URLs need the trailing slash. Keep the query
		// when somebody bookmarks /cascade rather than /cascade/.
		if readOnly && r.URL.Path == base {
			target := base + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(out, r, target, http.StatusPermanentRedirect)
			return
		}
		rest, ok := strings.CutPrefix(r.URL.Path, base)
		if !ok || !strings.HasPrefix(rest, "/") {
			writeText(out, http.StatusNotFound, fmt.Sprintf("Cannot %s %s", r.Method, r.URL.Path))
			return
		}
		r = withPath(r, rest, base)
	}
	s.route(out, r)
}

// withPath is the request as seen from under the base path.
func withPath(r *http.Request, rest, base string) *http.Request {
	inner := new(http.Request)
	*inner = *r
	u := *r.URL
	inner.URL = &u
	inner.URL.Path = rest
	if r.URL.RawPath != "" {
		inner.URL.RawPath = strings.TrimPrefix(r.URL.RawPath, base)
	}
	return inner
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && p == "/healthz" {
		s.health(w, r)
		return
	}
	// Before auth, so a hostile page learns nothing — not even whether a
	// password is set. See crosssite.go for what is refused and why.
	if isCrossSiteRequest(requestFacts{
		method:    r.Method,
		origin:    r.Header.Get("Origin"),
		fetchSite: r.Header.Get("Sec-Fetch-Site"),
		host:      requestHost(r),
		protocol:  requestProtocol(r),
	}) {
		writeJSON(w, r, http.StatusForbidden, map[string]string{"error": "cross-site request refused"})
		return
	}
	if !basicAuth(w, r, s.cfg.User, s.cfg.Password) {
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
	default:
		// Whatever this changed shows on every open page at once, rather
		// than at the stream's next tick.
		defer s.hub.Wake()
	}
	switch {
	case p == "/RPC2" && r.Method == http.MethodPost:
		s.rpcProxy(w, r)
	case p == "/api" || strings.HasPrefix(p, "/api/"):
		s.mux.ServeHTTP(w, r)
	default:
		s.static(w, r)
	}
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, struct {
		OK       bool `json:"ok"`
		RTorrent bool `json:"rtorrent"`
	}{true, s.svc.Ready()})
}

// requestHost is the host the browser addressed: X-Forwarded-Host behind a
// proxy, else Host.
func requestHost(r *http.Request) string {
	forwarded, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Host"), ",")
	if forwarded = strings.TrimSpace(forwarded); forwarded != "" {
		return forwarded
	}
	return r.Host
}

// requestProtocol trusts X-Forwarded-Proto: Cascade is meant to sit behind
// whatever terminates TLS for it.
func requestProtocol(r *http.Request) string {
	forwarded, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	if forwarded = strings.ToLower(strings.TrimSpace(forwarded)); forwarded != "" {
		return forwarded
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// rpcProxy is the raw XML-RPC passthrough, so external clients (the *arr
// apps, scripts) can drive rtorrent over HTTP. A JSON body of
// {"method": ..., "params": [...]} is accepted too.
func (s *Server) rpcProxy(w http.ResponseWriter, r *http.Request) {
	var payload []byte
	var body any
	var err error
	switch media, _ := mediaType(r); media {
	case "text/xml", "application/xml", "application/octet-stream":
		payload, err = readBody(r, rpcRawLimit)
	case "application/json":
		body, _, err = jsonBody(r, rpcJSONLimit)
	}
	if err == nil && !s.cfg.AllowRawRPC {
		err = httperr.New(http.StatusForbidden, "raw RPC access is disabled")
	}
	if err == nil && len(payload) == 0 {
		record, _ := body.(map[string]any)
		if _, named := record["method"].(string); !named {
			err = httperr.New(http.StatusBadRequest, "expected an XML-RPC methodCall body")
		} else {
			var method string
			var params []any
			method, err = validate.String(record["method"], "method", false)
			if err == nil {
				value, present := record["params"]
				params, err = rpcParams(value, present)
			}
			if err == nil {
				if payload, err = xmlrpc.EncodeCall(method, params); err != nil {
					err = httperr.New(http.StatusBadRequest, err.Error())
				}
			}
		}
	}
	var response []byte
	if err == nil {
		response, err = s.svc.Client().Raw(r.Context(), payload)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(response)))
	_, _ = w.Write(response)
}

func init() {
	// The image has no /etc/mime.types; name what the UI is built from
	// rather than leave a script to content sniffing, which nosniff forbids.
	for ext, kind := range map[string]string{
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
		".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
		".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
		".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json",
		".wasm": "application/wasm",
	} {
		_ = mime.AddExtensionType(ext, kind)
	}
}

// static serves the built SPA, with a history fallback for client-side
// routing.
//
// Vite writes content-hashed files under assets/, so those are immutable: a
// rebuild changes their names, never their bytes. Everything else — above
// all the shell that names those hashes — must revalidate on every load, or
// a browser that cached yesterday's index.html asks for hashed files that no
// longer exist after a redeploy and shows a blank page until a hard reload.
// no-cache still gives 304s (the files carry real validators), so it costs a
// conditional request, not a re-download.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	readOnly := r.Method == http.MethodGet || r.Method == http.MethodHead
	p := r.URL.Path
	if readOnly {
		if file, info := s.webFile(p); file != "" {
			cache := "no-cache"
			if strings.HasPrefix(p, "/assets/") {
				cache = "public, max-age=31536000, immutable"
			}
			serveFile(w, r, file, info, cache)
			return
		}
	}
	if p == "/assets" || strings.HasPrefix(p, "/assets/") {
		writeText(w, http.StatusNotFound, "asset not found")
		return
	}
	if !readOnly {
		writeText(w, http.StatusNotFound, fmt.Sprintf("Cannot %s %s", r.Method, p))
		return
	}
	index := filepath.Join(s.cfg.WebRoot, "index.html")
	info, err := os.Stat(index)
	if err != nil || !info.Mode().IsRegular() {
		writeText(w, http.StatusInternalServerError, "web assets not found at "+s.cfg.WebRoot)
		return
	}
	serveFile(w, r, index, info, "no-cache")
}

// webFile maps a URL path to a regular file under the web root, or "" —
// never outside it, and never a dotfile.
func (s *Server) webFile(urlPath string) (string, os.FileInfo) {
	clean := path.Clean("/" + urlPath)
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") {
			return "", nil
		}
	}
	file := filepath.Join(s.cfg.WebRoot, filepath.FromSlash(clean))
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil
	}
	return file, info
}

func serveFile(w http.ResponseWriter, r *http.Request, file string, info os.FileInfo, cache string) {
	f, err := os.Open(file)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Cache-Control", cache)
	// The validator Express's static files had: size and modification time.
	h.Set("ETag", fmt.Sprintf(`W/"%x-%x"`, info.Size(), info.ModTime().UnixMilli()))
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
