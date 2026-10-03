// Package httpapi is the HTTP face of Cascade: the JSON API, the state
// stream, the XML-RPC passthrough and the static web UI, behind the
// cross-site guard and optional Basic auth, with every failure answered as
// JSON and every compressible response compressed for clients that take it.
package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/store"
	"github.com/JohanLindvall/Cascade/server/internal/stream"
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

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	readOnly := r.Method == http.MethodGet || r.Method == http.MethodHead
	// Health stays outside the base path and outside Basic auth, so container
	// healthchecks and orchestrator probes work with WEB_USER/WEB_PASS set.
	// It reveals nothing but liveness.
	if readOnly && strings.EqualFold(r.URL.Path, "/healthz") {
		s.health(w, r)
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
			http.Redirect(w, r, target, http.StatusPermanentRedirect)
			return
		}
		rest, ok := strings.CutPrefix(r.URL.Path, base)
		if !ok || !strings.HasPrefix(rest, "/") {
			writeText(w, http.StatusNotFound, fmt.Sprintf("Cannot %s %s", r.Method, r.URL.Path))
			return
		}
		r = withPath(r, rest, base)
	}
	s.route(w, r)
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
	// The server's own paths match without regard to case, as the routes
	// under them do; the web UI's files are the filesystem's to match.
	p := strings.ToLower(r.URL.Path)
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && p == "/healthz" {
		s.health(w, r)
		return
	}
	// Before auth, so a hostile page learns nothing — not even whether a
	// password is set. See crosssite.go for what is refused and why.
	if isCrossSiteRequest(factsOf(r)) {
		writeJSON(w, r, http.StatusForbidden, map[string]string{"error": "cross-site request refused"})
		return
	}
	if !basicAuth(w, r, s.cfg.User, s.cfg.Password) {
		return
	}
	if !safeMethod(r.Method) {
		// Whatever a change did shows on every open page at once, rather than
		// at the stream's next tick — a failed one too: a torrent erased
		// before its data could not be deleted, or stopped before its new
		// directory faulted, has changed all the same. Only a request turned
		// away as it was sent certainly changed nothing, and costs rtorrent
		// no read.
		recorder := &statusRecorder{ResponseWriter: w}
		defer func() {
			if !refusedAsSent(recorder.status) {
				s.hub.Wake()
			}
		}()
		w = recorder
	}
	switch {
	case p == "/rpc2" && r.Method == http.MethodPost:
		s.rpcProxy(w, r)
	case p == "/api" || strings.HasPrefix(p, "/api/"):
		s.mux.ServeHTTP(w, r)
	default:
		s.static(w, r)
	}
}

// refusedAsSent is an answer that turns a request away for what it is —
// malformed, naming nothing there is, adding what is there already, too
// large, in a form not taken — which the API and the service both decide
// before asking rtorrent to change anything. Other errors conservatively
// wake the stream: in particular, a 5xx can follow a change half made.
func refusedAsSent(status int) bool {
	switch status {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusConflict,
		http.StatusRequestEntityTooLarge, http.StatusUnsupportedMediaType:
		return true
	}
	return false
}

// statusRecorder remembers the status a handler answered with.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the connection underneath.
func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, struct {
		OK       bool `json:"ok"`
		RTorrent bool `json:"rtorrent"`
	}{true, s.svc.Ready()})
}

// factsOf is what the cross-site rule looks at in a request.
func factsOf(r *http.Request) requestFacts {
	return requestFacts{
		method:    r.Method,
		origin:    r.Header.Get("Origin"),
		fetchSite: r.Header.Get("Sec-Fetch-Site"),
		host:      requestHost(r),
		protocol:  requestProtocol(r),
	}
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
