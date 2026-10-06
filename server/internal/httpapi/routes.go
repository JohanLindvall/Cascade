// SPDX-License-Identifier: MIT

package httpapi

import (
	"math"
	"net/http"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
)

// routes is the API, in the order it matches (see router): a route that
// would also match a later one must come first.
func (s *Server) routes() *router {
	mux := &router{}
	handle := func(pattern string, h handler) { mux.handle(pattern, s.api(h)) }
	// read answers with what get returns.
	read := func(pattern string, get func(c *call) (any, error)) {
		handle(pattern, func(c *call) error {
			result, err := get(c)
			if err != nil {
				return err
			}
			return c.json(result)
		})
	}
	// act answers {"ok": true} once do succeeds.
	act := func(pattern string, do func(c *call) error) {
		handle(pattern, func(c *call) error {
			if err := do(c); err != nil {
				return err
			}
			return c.ok()
		})
	}
	// torrent reads the info hash from the path first.
	torrent := func(next func(c *call, hash string) (any, error)) func(c *call) (any, error) {
		return func(c *call) (any, error) {
			hash, err := requireHash(c.r)
			if err != nil {
				return nil, err
			}
			return next(c, hash)
		}
	}

	/* ------------------------------- reads ------------------------------- */

	read("GET /api/state", func(c *call) (any, error) { return s.svc.State(c.ctx) })
	mux.handle("GET /api/stream", http.HandlerFunc(s.serveStream))
	read("GET /api/status", func(c *call) (any, error) { return s.svc.Status(c.ctx) })
	read("GET /api/torrents", func(c *call) (any, error) {
		view, ok := query(c.r, "view")
		if !ok {
			view = "main"
		}
		return s.svc.Torrents(c.ctx, view)
	})
	read("GET /api/prefs", func(*call) (any, error) { return s.store.Preferences(), nil })
	read("PATCH /api/prefs", func(c *call) (any, error) { return s.store.UpdatePreferences(c.body), nil })
	read("GET /api/game", func(*call) (any, error) { return s.svc.Game(), nil })
	read("GET /api/capabilities", func(c *call) (any, error) {
		if err := s.svc.EnsureCapabilities(c.ctx); err != nil {
			return nil, err
		}
		return s.svc.BackendSummary(), nil
	})
	read("GET /api/torrents/{hash}/files", torrent(func(c *call, hash string) (any, error) {
		return s.svc.Files(c.ctx, hash)
	}))
	read("GET /api/torrents/{hash}/peers", torrent(func(c *call, hash string) (any, error) {
		return s.svc.Peers(c.ctx, hash)
	}))
	read("GET /api/torrents/{hash}/trackers", torrent(func(c *call, hash string) (any, error) {
		return s.svc.Trackers(c.ctx, hash)
	}))
	read("GET /api/trackers", func(c *call) (any, error) {
		list, _ := query(c.r, "hashes")
		return s.svc.TrackerHosts(c.ctx, uniqueHashes(list))
	})

	/* -------------------------------- add -------------------------------- */

	handle("POST /api/torrents/upload", s.upload)
	act("POST /api/torrents/url", func(c *call) error {
		link, err := c.text("url", false)
		if err != nil {
			return err
		}
		options, err := loadOptions(c.body)
		if err != nil {
			return err
		}
		return s.svc.AddTorrentURL(c.ctx, link, options)
	})

	/* ------------------------------ mutations ---------------------------- */

	act("POST /api/torrents/{hash}/action/{action}", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		return s.svc.Action(c.ctx, hash, c.r.PathValue("action"))
	})
	read("POST /api/torrents/action/{action}", func(c *call) (any, error) {
		hashes, err := bodyHashes(c.body)
		if err != nil {
			return nil, err
		}
		action := c.r.PathValue("action")
		return bulk(hashes, func(hash string) error { return s.svc.Action(c.ctx, hash, action) }), nil
	})
	act("DELETE /api/torrents/{hash}", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		deleteData := false
		if values, given := c.r.URL.Query()["deleteData"]; given {
			var value any = values[0]
			if len(values) > 1 {
				value = values // a list, which is refused like any other non-boolean
			}
			if deleteData, err = validate.Bool(value, "deleteData"); err != nil {
				return err
			}
		}
		return s.svc.Remove(c.ctx, hash, deleteData)
	})
	read("POST /api/torrents/remove", func(c *call) (any, error) {
		deleteData := false
		if _, given := c.field("deleteData"); given {
			var err error
			if deleteData, err = c.boolean("deleteData"); err != nil {
				return nil, err
			}
		}
		hashes, err := bodyHashes(c.body)
		if err != nil {
			return nil, err
		}
		return bulk(hashes, func(hash string) error { return s.svc.Remove(c.ctx, hash, deleteData) }), nil
	})
	act("PATCH /api/torrents/{hash}", s.patchTorrent)
	act("POST /api/torrents/{hash}/files/{index}/priority", func(c *call) error {
		// f.priority: 0 skip, 1 normal, 2 high.
		priority, err := c.integer("priority", 0, 2)
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
		return s.svc.SetFilePriority(c.ctx, hash, index, priority)
	})
	act("POST /api/torrents/{hash}/trackers/{index}/enabled", func(c *call) error {
		enabled, err := c.boolean("enabled")
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
		return s.svc.SetTrackerEnabled(c.ctx, hash, index, enabled)
	})
	act("POST /api/torrents/{hash}/trackers", func(c *call) error {
		hash, err := requireHash(c.r)
		if err != nil {
			return err
		}
		link, err := requireAnnounceURL(c.body["url"])
		if err != nil {
			return err
		}
		var group any = float64(0) // absent or null: the first tier
		if value := c.body["group"]; value != nil {
			group = value
		}
		tier, err := validate.Int(group, "group", 0, 100_000)
		if err != nil {
			return err
		}
		return s.svc.AddTracker(c.ctx, hash, link, tier)
	})

	/* ------------------------------ settings ----------------------------- */

	read("GET /api/settings", func(c *call) (any, error) { return s.svc.Settings(c.ctx) })
	read("POST /api/settings", func(c *call) (any, error) {
		if err := s.svc.UpdateSettings(c.ctx, c.body); err != nil {
			return nil, err
		}
		return s.svc.Settings(c.ctx)
	})

	/* --------------------------- throttle groups ------------------------- */

	read("GET /api/throttles", func(c *call) (any, error) {
		rates, err := s.svc.ThrottleRates(c.ctx)
		if err != nil {
			return nil, err
		}
		return struct {
			Groups []contracts.ThrottleGroup         `json:"groups"`
			Rates  map[string]contracts.ThrottleRate `json:"rates"`
		}{s.store.Throttles(), rates}, nil
	})
	act("POST /api/throttles", func(c *call) error {
		name, err := c.text("name", false)
		if err != nil {
			return err
		}
		up, err := c.integer("up", 0, validate.MaxSafeInteger)
		if err != nil {
			return err
		}
		down, err := c.integer("down", 0, validate.MaxSafeInteger)
		if err != nil {
			return err
		}
		return s.svc.SaveThrottle(c.ctx, contracts.ThrottleGroup{Name: name, Up: up, Down: down})
	})
	act("DELETE /api/throttles/{name}", func(c *call) error {
		return s.svc.DeleteThrottle(c.ctx, c.r.PathValue("name"))
	})
	act("PATCH /api/throttles/{name}", func(c *call) error {
		if !c.hasBody {
			return httperr.New(http.StatusBadRequest, `"body" must be an object`)
		}
		up, err := c.optionalInteger("up", validate.MaxSafeInteger)
		if err != nil {
			return err
		}
		down, err := c.optionalInteger("down", validate.MaxSafeInteger)
		if err != nil {
			return err
		}
		if up == nil && down == nil {
			return httperr.New(http.StatusBadRequest, "supply an up or down rate")
		}
		return s.svc.PatchThrottle(c.ctx, c.r.PathValue("name"), up, down)
	})

	/* --------------------------------- log ------------------------------- */

	read("GET /api/log", func(c *call) (any, error) {
		// Number(lines) || 300, then held to 1-2000.
		text, _ := query(c.r, "lines")
		lines := jsnum.OrZero(text)
		if lines == 0 {
			lines = 300
		}
		rows, err := s.svc.Log(c.ctx, int(math.Min(2000, math.Max(1, math.Trunc(lines)))))
		if err != nil {
			return nil, err
		}
		return map[string][]string{"lines": rows}, nil
	})
	read("GET /api/log/scopes", func(c *call) (any, error) {
		if err := s.svc.EnsureCapabilities(c.ctx); err != nil {
			return nil, err
		}
		return s.svc.LogScopes(), nil
	})
	read("POST /api/log/scopes", func(c *call) (any, error) {
		list, ok := c.body["scopes"].([]any)
		scopes := make([]string, 0, len(list))
		for _, item := range list {
			scope, isText := item.(string)
			ok = ok && isText
			scopes = append(scopes, scope)
		}
		if !ok {
			return nil, httperr.New(http.StatusBadRequest, `"scopes" must be an array of log scope names`)
		}
		return s.svc.SetLogScopes(c.ctx, scopes)
	})

	/* ------------------------- raw rtorrent RPC -------------------------- */

	read("GET /api/rpc/methods", s.rawRPC(func(c *call) (any, error) {
		if err := s.svc.EnsureCapabilities(c.ctx); err != nil {
			return nil, err
		}
		return map[string][]string{"methods": s.svc.MethodNames()}, nil
	}))
	read("POST /api/rpc", s.rawRPC(s.rpcCall))
	read("POST /api/rpc/help", s.rawRPC(s.rpcHelp))

	// Unknown API paths must answer JSON, not fall through to the SPA shell.
	mux.fallback = s.api(func(c *call) error {
		path := c.r.URL.Path[len("/api"):] // in whatever case it came
		if path == "" {
			path = "/"
		}
		return httperr.Newf(http.StatusNotFound, "no such endpoint: %s %s", c.r.Method, path)
	})
	return mux
}

// upload adds .torrent files and links from a multipart form (or a JSON body
// carrying the links), reporting failures by item so a retry resubmits only
// those.
func (s *Server) upload(c *call) error {
	files := []uploadedFile{}
	body := c.body
	if media, _ := mediaType(c.r); strings.HasPrefix(media, "multipart/") {
		var err error
		if files, body, err = readUpload(c.w, c.r, s.cfg.MaxUploadBytes); err != nil {
			return err
		}
	}
	options, err := loadOptions(body)
	if err != nil {
		return err
	}
	urls, err := uploadURLs(body)
	if err != nil {
		return err
	}
	if len(files) == 0 && len(urls) == 0 {
		return httperr.New(http.StatusBadRequest, "no .torrent files or URLs supplied")
	}
	if len(files)+len(urls) > uploadMaxFiles {
		return httperr.Newf(http.StatusBadRequest, "at most %d .torrent files and URLs may be added in one batch", uploadMaxFiles)
	}
	result := contracts.UploadResult{Errors: []string{}, FailedFiles: []int{}, FailedURLs: []int{}}
	for index, file := range files {
		if err := s.svc.AddTorrentFile(c.ctx, file.data, options); err != nil {
			result.FailedFiles = append(result.FailedFiles, index)
			result.Errors = append(result.Errors, file.name+": "+err.Error())
		}
	}
	for index, link := range urls {
		if err := s.svc.AddTorrentURL(c.ctx, link, options); err != nil {
			result.FailedURLs = append(result.FailedURLs, index)
			result.Errors = append(result.Errors, link+": "+err.Error())
		}
	}
	result.Added = len(files) + len(urls) - len(result.Errors)
	return c.json(result)
}

// patchTorrent changes a torrent's priority, label, throttle group,
// directory and slot limits, whichever the body names.
func (s *Server) patchTorrent(c *call) error {
	hash, err := requireHash(c.r)
	if err != nil {
		return err
	}
	// Parse every field before the first RPC: a bad final field must not
	// leave earlier changes applied although the request was refused.
	priority, err := c.optionalInteger("priority", 3)
	if err != nil {
		return err
	}
	label, err := c.optionalText("label", true)
	if err != nil {
		return err
	}
	throttle, err := c.optionalText("throttle", true)
	if err != nil {
		return err
	}
	directory, err := c.optionalText("directory", false)
	if err != nil {
		return err
	}
	uploads, err := c.optionalInteger("maxUploads", 100_000)
	if err != nil {
		return err
	}
	downloads, err := c.optionalInteger("maxDownloads", 100_000)
	if err != nil {
		return err
	}
	if priority != nil {
		// d.priority: 0 off, 1 low, 2 normal, 3 high.
		if err := s.svc.SetPriority(c.ctx, hash, *priority); err != nil {
			return err
		}
	}
	if label != nil {
		if err := s.svc.SetLabel(c.ctx, hash, *label); err != nil {
			return err
		}
	}
	if throttle != nil {
		if err := s.svc.SetTorrentThrottle(c.ctx, hash, *throttle); err != nil {
			return err
		}
	}
	if directory != nil {
		if err := s.svc.SetDirectory(c.ctx, hash, *directory); err != nil {
			return err
		}
	}
	if uploads != nil || downloads != nil {
		return s.svc.SetTorrentSlots(c.ctx, hash, uploads, downloads)
	}
	return nil
}
