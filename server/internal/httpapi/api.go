package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// call is one API request: the body is the parsed JSON object, or empty when
// the request carried none.
type call struct {
	w       http.ResponseWriter
	r       *http.Request
	body    map[string]any
	hasBody bool
}

func (c *call) ctx() context.Context { return c.r.Context() }

func (c *call) json(v any) error {
	writeJSON(c.w, c.r, http.StatusOK, v)
	return nil
}

func (c *call) ok() error { return c.json(map[string]bool{"ok": true}) }

// field is a body field, and whether the body has it at all: an absent field
// is left alone, a null one is refused like any other wrong type.
func (c *call) field(name string) (any, bool) {
	value, ok := c.body[name]
	return value, ok
}

type handler func(c *call) error

var hashPattern = regexp.MustCompile(`^[0-9A-Fa-f]{40}$`)

func requireHash(r *http.Request) (string, error) {
	hash := r.PathValue("hash")
	if !hashPattern.MatchString(hash) {
		return "", httperr.New(http.StatusBadRequest, "invalid info hash")
	}
	return strings.ToUpper(hash), nil
}

// requireIndex is a file/tracker index from the path.
func requireIndex(r *http.Request) (int, error) {
	index, err := validate.Int(r.PathValue("index"), "index", 0, 100_000)
	return int(index), err
}

// d.tracker.insert keeps whatever string it is given; only these schemes can
// ever announce. The web UI checks the same rule before sending.
var announceURL = regexp.MustCompile(`(?i)^(https?|udp)://\S+$`)

func requireAnnounceURL(value any) (string, error) {
	text, err := validate.String(value, "url", false)
	if err != nil {
		return "", err
	}
	parsed, parseErr := url.Parse(text)
	if !announceURL.MatchString(text) || parseErr != nil || parsed.Hostname() == "" {
		return "", httperr.New(http.StatusBadRequest, `"url" must be an http(s):// or udp:// announce URL`)
	}
	return text, nil
}

// bodyHashes validates the entire batch before anything starts, and drops
// repeats: a repeated hash must not repeat a destructive action.
func bodyHashes(body map[string]any) ([]string, error) {
	list, ok := body["hashes"].([]any)
	refuse := httperr.New(http.StatusBadRequest, `"hashes" must be a non-empty array of 40-digit hexadecimal info hashes`)
	if !ok || len(list) == 0 {
		return nil, refuse
	}
	hashes := make([]string, 0, len(list))
	seen := map[string]bool{}
	for _, item := range list {
		hash, ok := item.(string)
		if !ok || !hashPattern.MatchString(hash) {
			return nil, refuse
		}
		if hash = strings.ToUpper(hash); !seen[hash] {
			seen[hash] = true
			hashes = append(hashes, hash)
		}
	}
	return hashes, nil
}

type bulkResult struct {
	OK     bool     `json:"ok"`
	Errors []string `json:"errors"`
}

// bulk applies an action to each hash, collecting failures by hash instead of
// stopping at the first: one torrent rtorrent refuses must not leave the rest
// of a selection untouched.
func bulk(hashes []string, action func(hash string) error) bulkResult {
	errs := []string{}
	for _, hash := range hashes {
		if err := action(hash); err != nil {
			errs = append(errs, hash+": "+err.Error())
		}
	}
	return bulkResult{OK: len(errs) == 0, Errors: errs}
}

// loadOptions reads the add options as both the multipart form and the JSON
// body carry them.
func loadOptions(body map[string]any) (contracts.LoadOptions, error) {
	options := contracts.LoadOptions{Start: true}
	var err error
	if value, ok := body["start"]; ok {
		if options.Start, err = validate.Bool(value, "start"); err != nil {
			return options, err
		}
	}
	if value, ok := body["directory"]; ok {
		if options.Directory, err = validate.String(value, "directory", true); err != nil {
			return options, err
		}
	}
	if value, ok := body["label"]; ok {
		if options.Label, err = validate.String(value, "label", true); err != nil {
			return options, err
		}
	}
	return options, nil
}

// rpcParams checks raw RPC parameters: a list, of anything JSON can say, not
// nested past what any real command takes.
func rpcParams(value any, present bool) ([]any, error) {
	if !present {
		return []any{}, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, httperr.New(http.StatusBadRequest, `"params" must be an array`)
	}
	var check func(item any, depth int) error
	check = func(item any, depth int) error {
		if depth > 100 {
			return httperr.New(http.StatusBadRequest, `"params" nesting is too deep`)
		}
		switch v := item.(type) {
		case []any:
			for _, child := range v {
				if err := check(child, depth+1); err != nil {
					return err
				}
			}
		case map[string]any:
			for _, child := range v {
				if err := check(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := check(list, 0); err != nil {
		return nil, err
	}
	return list, nil
}

// jsonSafe renders base64 values, which JSON has no type for, as
// {"$base64": "..."}.
func jsonSafe(value any) any {
	switch v := value.(type) {
	case []byte:
		return map[string]string{"$base64": base64.StdEncoding.EncodeToString(v)}
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = jsonSafe(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = jsonSafe(item)
		}
		return out
	}
	return value
}

// query is a query parameter that was given exactly once, as the routes
// read them: a repeated parameter is a list, which none of them takes.
func query(r *http.Request, name string) (string, bool) {
	values := r.URL.Query()[name]
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

func (s *Server) routes() *router {
	mux := &router{}
	handle := func(pattern string, h handler) { mux.handle(pattern, s.api(h)) }
	rawRPC := func(h handler) handler {
		return func(c *call) error {
			if !s.cfg.AllowRawRPC {
				return httperr.New(http.StatusForbidden, "raw RPC access is disabled")
			}
			return h(c)
		}
	}

	/* ------------------------------- reads ------------------------------- */

	handle("GET /api/state", func(c *call) error {
		state, err := s.svc.State(c.ctx())
		if err != nil {
			return err
		}
		return c.json(state)
	})
	mux.handle("GET /api/stream", http.HandlerFunc(s.serveStream))
	handle("GET /api/status", func(c *call) error {
		status, err := s.svc.Status(c.ctx())
		if err != nil {
			return err
		}
		return c.json(status)
	})
	handle("GET /api/torrents", func(c *call) error {
		view, ok := query(c.r, "view")
		if !ok {
			view = "main"
		}
		torrents, err := s.svc.Torrents(c.ctx(), view)
		if err != nil {
			return err
		}
		return c.json(torrents)
	})

	/* ---------------------------- preferences ---------------------------- */

	handle("GET /api/prefs", func(c *call) error { return c.json(s.store.Preferences()) })
	handle("PATCH /api/prefs", func(c *call) error { return c.json(s.store.UpdatePreferences(c.body)) })
	handle("GET /api/game", func(c *call) error { return c.json(s.svc.Game()) })
	handle("GET /api/capabilities", func(c *call) error {
		if err := s.svc.EnsureCapabilities(c.ctx()); err != nil {
			return err
		}
		return c.json(s.svc.BackendSummary())
	})
	perTorrent := func(read func(ctx context.Context, hash string) (any, error)) handler {
		return func(c *call) error {
			hash, err := requireHash(c.r)
			if err != nil {
				return err
			}
			result, err := read(c.ctx(), hash)
			if err != nil {
				return err
			}
			return c.json(result)
		}
	}
	handle("GET /api/torrents/{hash}/files", perTorrent(func(ctx context.Context, hash string) (any, error) {
		return s.svc.Files(ctx, hash)
	}))
	handle("GET /api/torrents/{hash}/peers", perTorrent(func(ctx context.Context, hash string) (any, error) {
		return s.svc.Peers(ctx, hash)
	}))
	handle("GET /api/torrents/{hash}/trackers", perTorrent(func(ctx context.Context, hash string) (any, error) {
		return s.svc.Trackers(ctx, hash)
	}))
	handle("GET /api/trackers", func(c *call) error {
		raw, _ := query(c.r, "hashes")
		hashes := []string{}
		seen := map[string]bool{}
		for _, hash := range strings.Split(raw, ",") {
			if hash = strings.ToUpper(hash); hashPattern.MatchString(hash) && !seen[hash] {
				seen[hash] = true
				hashes = append(hashes, hash)
			}
		}
		hosts, err := s.svc.TrackerHosts(c.ctx(), hashes)
		if err != nil {
			return err
		}
		return c.json(hosts)
	})

	/* -------------------------------- add -------------------------------- */

	handle("POST /api/torrents/upload", func(c *call) error {
		files := []uploadedFile{}
		body := c.body
		if media, _ := mediaType(c.r); strings.HasPrefix(media, "multipart/") {
			var err error
			if files, body, err = readUpload(c.r, s.cfg.MaxUploadBytes); err != nil {
				return err
			}
		}
		options, err := loadOptions(body)
		if err != nil {
			return err
		}
		rawURLs, present := body["urls"]
		if !present || rawURLs == nil {
			rawURLs = ""
		}
		text, err := validate.String(rawURLs, "urls", true)
		if err != nil {
			return err
		}
		urls := []string{}
		for _, line := range lineBreaks.Split(text, -1) {
			if line = validate.Trim(line); line != "" {
				urls = append(urls, line)
			}
		}
		if len(files) == 0 && len(urls) == 0 {
			return httperr.New(http.StatusBadRequest, "no .torrent files or URLs supplied")
		}
		if len(files)+len(urls) > uploadMaxFiles {
			return httperr.New(http.StatusBadRequest, "at most 50 .torrent files and URLs may be added in one batch")
		}
		result := contracts.UploadResult{Errors: []string{}, FailedFiles: []int{}, FailedURLs: []int{}}
		for index, file := range files {
			if err := s.svc.AddTorrentFile(c.ctx(), file.data, options); err != nil {
				result.FailedFiles = append(result.FailedFiles, index)
				result.Errors = append(result.Errors, file.name+": "+err.Error())
			}
		}
		for index, link := range urls {
			if err := s.svc.AddTorrentURL(c.ctx(), link, options); err != nil {
				result.FailedURLs = append(result.FailedURLs, index)
				result.Errors = append(result.Errors, link+": "+err.Error())
			}
		}
		result.Added = len(files) + len(urls) - len(result.Errors)
		return c.json(result)
	})
	handle("POST /api/torrents/url", func(c *call) error {
		value, _ := c.field("url")
		link, err := validate.String(value, "url", false)
		if err != nil {
			return err
		}
		options, err := loadOptions(c.body)
		if err != nil {
			return err
		}
		if err := s.svc.AddTorrentURL(c.ctx(), link, options); err != nil {
			return err
		}
		return c.ok()
	})

	/* ------------------------------ mutations ---------------------------- */

	handle("POST /api/torrents/{hash}/action/{action}", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		if err := s.svc.Action(c.ctx(), hash, c.r.PathValue("action")); err != nil {
			return err
		}
		return c.ok()
	})
	handle("POST /api/torrents/action/{action}", func(c *call) error {
		hashes, err := bodyHashes(c.body)
		if err != nil {
			return err
		}
		action := c.r.PathValue("action")
		return c.json(bulk(hashes, func(hash string) error { return s.svc.Action(c.ctx(), hash, action) }))
	})
	handle("DELETE /api/torrents/{hash}", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		deleteData := false
		if values, ok := c.r.URL.Query()["deleteData"]; ok {
			var value any = values[0]
			if len(values) > 1 {
				value = values
			}
			if deleteData, err = validate.Bool(value, "deleteData"); err != nil {
				return err
			}
		}
		if err := s.svc.Remove(c.ctx(), hash, deleteData); err != nil {
			return err
		}
		return c.ok()
	})
	handle("POST /api/torrents/remove", func(c *call) error {
		deleteData := false
		if value, ok := c.field("deleteData"); ok {
			var err error
			if deleteData, err = validate.Bool(value, "deleteData"); err != nil {
				return err
			}
		}
		hashes, err := bodyHashes(c.body)
		if err != nil {
			return err
		}
		return c.json(bulk(hashes, func(hash string) error { return s.svc.Remove(c.ctx(), hash, deleteData) }))
	})
	handle("PATCH /api/torrents/{hash}", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		// Parse every field before the first RPC: a bad final field must not
		// leave earlier changes applied although the request was refused.
		var priority, uploads, downloads *int64
		var label, throttle, directory *string
		integer := func(name string, max int64) (*int64, error) {
			value, ok := c.field(name)
			if !ok {
				return nil, nil
			}
			n, err := validate.Int(value, name, 0, max)
			return &n, err
		}
		text := func(name string, allowEmpty bool) (*string, error) {
			value, ok := c.field(name)
			if !ok {
				return nil, nil
			}
			s, err := validate.String(value, name, allowEmpty)
			return &s, err
		}
		if priority, err = integer("priority", 3); err != nil {
			return err
		}
		if label, err = text("label", true); err != nil {
			return err
		}
		if throttle, err = text("throttle", true); err != nil {
			return err
		}
		if directory, err = text("directory", false); err != nil {
			return err
		}
		if uploads, err = integer("maxUploads", 100_000); err != nil {
			return err
		}
		if downloads, err = integer("maxDownloads", 100_000); err != nil {
			return err
		}
		if priority != nil {
			// d.priority: 0 off, 1 low, 2 normal, 3 high.
			if err := s.svc.SetPriority(c.ctx(), hash, *priority); err != nil {
				return err
			}
		}
		if label != nil {
			if err := s.svc.SetLabel(c.ctx(), hash, *label); err != nil {
				return err
			}
		}
		if throttle != nil {
			if err := s.svc.SetTorrentThrottle(c.ctx(), hash, *throttle); err != nil {
				return err
			}
		}
		if directory != nil {
			if err := s.svc.SetDirectory(c.ctx(), hash, *directory); err != nil {
				return err
			}
		}
		if uploads != nil || downloads != nil {
			if err := s.svc.SetTorrentSlots(c.ctx(), hash, uploads, downloads); err != nil {
				return err
			}
		}
		return c.ok()
	})
	handle("POST /api/torrents/{hash}/files/{index}/priority", func(c *call) error {
		// f.priority: 0 skip, 1 normal, 2 high.
		value, _ := c.field("priority")
		priority, err := validate.Int(value, "priority", 0, 2)
		if err != nil {
			return err
		}
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		index, err := requireIndex(c.r)
		if err != nil {
			return err
		}
		if err := s.svc.SetFilePriority(c.ctx(), hash, index, priority); err != nil {
			return err
		}
		return c.ok()
	})
	handle("POST /api/torrents/{hash}/trackers/{index}/enabled", func(c *call) error {
		value, _ := c.field("enabled")
		enabled, err := validate.Bool(value, "enabled")
		if err != nil {
			return err
		}
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		index, err := requireIndex(c.r)
		if err != nil {
			return err
		}
		if err := s.svc.SetTrackerEnabled(c.ctx(), hash, index, enabled); err != nil {
			return err
		}
		return c.ok()
	})
	handle("POST /api/torrents/{hash}/trackers", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		value, _ := c.field("url")
		link, err := requireAnnounceURL(value)
		if err != nil {
			return err
		}
		var group any = float64(0)
		if value, ok := c.field("group"); ok && value != nil {
			group = value
		}
		tier, err := validate.Int(group, "group", 0, 100_000)
		if err != nil {
			return err
		}
		if err := s.svc.AddTracker(c.ctx(), hash, link, tier); err != nil {
			return err
		}
		return c.ok()
	})

	/* ------------------------------ settings ----------------------------- */

	handle("GET /api/settings", func(c *call) error {
		settings, err := s.svc.Settings(c.ctx())
		if err != nil {
			return err
		}
		return c.json(settings)
	})
	handle("POST /api/settings", func(c *call) error {
		if err := s.svc.UpdateSettings(c.ctx(), c.body); err != nil {
			return err
		}
		settings, err := s.svc.Settings(c.ctx())
		if err != nil {
			return err
		}
		return c.json(settings)
	})

	/* --------------------------- throttle groups ------------------------- */

	handle("GET /api/throttles", func(c *call) error {
		rates, err := s.svc.ThrottleRates(c.ctx())
		if err != nil {
			return err
		}
		return c.json(struct {
			Groups []contracts.ThrottleGroup         `json:"groups"`
			Rates  map[string]contracts.ThrottleRate `json:"rates"`
		}{s.store.Throttles(), rates})
	})
	handle("POST /api/throttles", func(c *call) error {
		value, _ := c.field("name")
		name, err := validate.String(value, "name", false)
		if err != nil {
			return err
		}
		value, _ = c.field("up")
		up, err := validate.Int(value, "up", 0, validate.MaxSafeInteger)
		if err != nil {
			return err
		}
		value, _ = c.field("down")
		down, err := validate.Int(value, "down", 0, validate.MaxSafeInteger)
		if err != nil {
			return err
		}
		if err := s.svc.SaveThrottle(c.ctx(), contracts.ThrottleGroup{Name: name, Up: up, Down: down}); err != nil {
			return err
		}
		return c.ok()
	})
	handle("DELETE /api/throttles/{name}", func(c *call) error {
		if err := s.svc.DeleteThrottle(c.ctx(), c.r.PathValue("name")); err != nil {
			return err
		}
		return c.ok()
	})
	handle("PATCH /api/throttles/{name}", func(c *call) error {
		if !c.hasBody {
			return httperr.New(http.StatusBadRequest, `"body" must be an object`)
		}
		var up, down *int64
		for _, field := range []struct {
			name   string
			target **int64
		}{{"up", &up}, {"down", &down}} {
			if value, ok := c.field(field.name); ok {
				rate, err := validate.Int(value, field.name, 0, validate.MaxSafeInteger)
				if err != nil {
					return err
				}
				*field.target = &rate
			}
		}
		if up == nil && down == nil {
			return httperr.New(http.StatusBadRequest, "supply an up or down rate")
		}
		if err := s.svc.PatchThrottle(c.ctx(), c.r.PathValue("name"), up, down); err != nil {
			return err
		}
		return c.ok()
	})

	/* --------------------------------- log ------------------------------- */

	handle("GET /api/log", func(c *call) error {
		text, _ := query(c.r, "lines")
		lines := jsnum.OrZero(text)
		if lines == 0 {
			lines = 300
		}
		rows, err := s.svc.Log(c.ctx(), int(math.Min(2000, math.Max(1, math.Trunc(lines)))))
		if err != nil {
			return err
		}
		return c.json(map[string][]string{"lines": rows})
	})
	handle("GET /api/log/scopes", func(c *call) error {
		if err := s.svc.EnsureCapabilities(c.ctx()); err != nil {
			return err
		}
		return c.json(s.svc.LogScopes())
	})
	handle("POST /api/log/scopes", func(c *call) error {
		value, _ := c.field("scopes")
		list, ok := value.([]any)
		scopes := make([]string, 0, len(list))
		for _, item := range list {
			scope, isText := item.(string)
			ok = ok && isText
			scopes = append(scopes, scope)
		}
		if !ok {
			return httperr.New(http.StatusBadRequest, `"scopes" must be an array of log scope names`)
		}
		result, err := s.svc.SetLogScopes(c.ctx(), scopes)
		if err != nil {
			return err
		}
		return c.json(result)
	})

	/* ------------------------- raw rtorrent RPC -------------------------- */

	handle("GET /api/rpc/methods", rawRPC(func(c *call) error {
		if err := s.svc.EnsureCapabilities(c.ctx()); err != nil {
			return err
		}
		return c.json(map[string][]string{"methods": s.svc.MethodNames()})
	}))
	handle("POST /api/rpc", rawRPC(func(c *call) error {
		value, _ := c.field("method")
		method, err := validate.String(value, "method", false)
		if err != nil {
			return err
		}
		value, present := c.field("params")
		params, err := rpcParams(value, present)
		if err != nil {
			return err
		}
		result, err := s.svc.Client().Call(c.ctx(), method, params...)
		var fault *xmlrpc.Fault
		if errors.As(err, &fault) {
			type faultBody struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			}
			return c.json(struct {
				OK    bool      `json:"ok"`
				Fault faultBody `json:"fault"`
			}{false, faultBody{fault.Code, fault.Message}})
		}
		if err != nil {
			return err
		}
		return c.json(struct {
			OK     bool `json:"ok"`
			Result any  `json:"result"`
		}{true, jsonSafe(result)})
	}))
	handle("POST /api/rpc/help", rawRPC(func(c *call) error {
		value, _ := c.field("method")
		method, err := validate.String(value, "method", false)
		if err != nil {
			return err
		}
		results, err := s.svc.Client().MulticallSettled(c.ctx(), []rtorrent.Call{
			{Method: "system.methodHelp", Params: []any{method}},
			{Method: "system.methodSignature", Params: []any{method}},
		})
		if err != nil {
			return err
		}
		answer := struct {
			Method    string `json:"method"`
			Help      string `json:"help"`
			Signature any    `json:"signature"`
		}{Method: method, Signature: ""}
		if results[0].Err == nil {
			answer.Help = rtorrent.Text(results[0].Value)
		}
		if results[1].Err == nil {
			answer.Signature = jsonSafe(results[1].Value)
		}
		return c.json(answer)
	}))

	// Unknown API paths must answer JSON, not fall through to the SPA shell.
	mux.fallback = s.api(func(c *call) error {
		path := strings.TrimPrefix(c.r.URL.Path, "/api")
		if path == "" {
			path = "/"
		}
		return httperr.Newf(http.StatusNotFound, "no such endpoint: %s %s", c.r.Method, path)
	})
	return mux
}

var lineBreaks = regexp.MustCompile(`[\r\n]+`)

// api adapts a handler: the JSON body parsed and checked, API responses
// never reused unrevalidated, and failures answered as JSON.
func (s *Server) api(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Revalidate rather than reuse: with the ETag, a poll whose answer
		// has not changed comes back as a bodiless 304.
		w.Header().Set("Cache-Control", "no-cache")
		c := &call{w: w, r: r, body: map[string]any{}}
		value, present, err := jsonBody(r, jsonLimit)
		if err == nil && present {
			var record map[string]any
			if record, err = validate.Record(value, "body"); err == nil {
				c.body, c.hasBody = record, true
			}
		}
		if err == nil {
			err = h(c)
		}
		if err != nil {
			writeError(w, r, err)
		}
	})
}
