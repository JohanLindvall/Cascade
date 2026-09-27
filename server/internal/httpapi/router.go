package httpapi

import (
	"net/http"
	"net/url"
	"strings"
)

// router matches routes in the order they were added, first match wins —
// the rule the API was defined under. POST /api/torrents/action/trackers,
// say, is a bulk action named "trackers" rather than the tracker list of a
// torrent whose hash is "action", because the bulk route comes first;
// http.ServeMux refuses to register two such patterns at all. Literal
// segments match without regard to case, a trailing slash is ignored, and a
// {name} segment is any one non-empty segment, decoded, read back with
// PathValue.
type router struct {
	routes   []route
	fallback http.Handler
}

type route struct {
	method  string
	parts   []string
	handler http.Handler
}

func segments(path string) []string {
	return strings.Split(strings.Trim(path, "/"), "/")
}

// handle adds a route: "METHOD /path/{name}". A GET route answers HEAD too.
func (rt *router) handle(pattern string, handler http.Handler) {
	method, path, _ := strings.Cut(pattern, " ")
	rt.routes = append(rt.routes, route{method: method, parts: segments(path), handler: handler})
}

func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	got := segments(r.URL.EscapedPath())
	for _, route := range rt.routes {
		if route.method != r.Method && !(route.method == http.MethodGet && r.Method == http.MethodHead) {
			continue
		}
		if values, ok := route.match(got); ok {
			for name, value := range values {
				r.SetPathValue(name, value)
			}
			route.handler.ServeHTTP(w, r)
			return
		}
	}
	rt.fallback.ServeHTTP(w, r)
}

func (rt route) match(got []string) (map[string]string, bool) {
	if len(got) != len(rt.parts) {
		return nil, false
	}
	values := map[string]string{}
	for i, part := range rt.parts {
		if name, wild := strings.CutPrefix(part, "{"); wild {
			value, err := url.PathUnescape(got[i])
			if err != nil || value == "" {
				return nil, false
			}
			values[strings.TrimSuffix(name, "}")] = value
			continue
		}
		if !strings.EqualFold(part, got[i]) {
			return nil, false
		}
	}
	return values, true
}
