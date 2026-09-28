package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
)

// call is one API request: the body is the parsed JSON object, or empty when
// the request carried none.
type call struct {
	w       http.ResponseWriter
	r       *http.Request
	ctx     context.Context
	body    map[string]any
	hasBody bool
}

type handler func(c *call) error

// safeMethod is a method that must not change anything.
func safeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

// api adapts a handler: the JSON body parsed and checked, API responses never
// reused unrevalidated, and failures answered as JSON.
func (s *Server) api(h handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Revalidate rather than reuse: with the ETag, a poll whose answer
		// has not changed comes back as a bodiless 304.
		w.Header().Set("Cache-Control", "no-cache")
		c := &call{w: w, r: r, ctx: r.Context(), body: map[string]any{}}
		if !safeMethod(r.Method) {
			// A change is carried through even when the client stops
			// listening: a throttle change stops the torrent, sets it and
			// starts it again, and abandoning that halfway because a tab
			// closed would leave the torrent stopped.
			c.ctx = context.WithoutCancel(c.ctx)
		}
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

// The readers below check one body field. An absent field reads as null, so
// a required one is refused with the same message as one of the wrong type.

func (c *call) text(name string, allowEmpty bool) (string, error) {
	return validate.String(c.body[name], name, allowEmpty)
}

func (c *call) integer(name string, min, max int64) (int64, error) {
	return validate.Int(c.body[name], name, min, max)
}

func (c *call) boolean(name string) (bool, error) {
	return validate.Bool(c.body[name], name)
}

// optionalInteger is nil for an absent field.
func (c *call) optionalInteger(name string, max int64) (*int64, error) {
	if _, ok := c.field(name); !ok {
		return nil, nil
	}
	n, err := c.integer(name, 0, max)
	return &n, err
}

// optionalText is nil for an absent field.
func (c *call) optionalText(name string, allowEmpty bool) (*string, error) {
	if _, ok := c.field(name); !ok {
		return nil, nil
	}
	text, err := c.text(name, allowEmpty)
	return &text, err
}

// query is a query parameter that was given exactly once, as the routes read
// them: a repeated parameter is a list, which none of them takes.
func query(r *http.Request, name string) (string, bool) {
	values := r.URL.Query()[name]
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

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

// uniqueHashes is the info hashes in a comma-separated list that are well
// formed, upper-cased, each once, in their order.
func uniqueHashes(list string) []string {
	hashes := []string{}
	seen := map[string]bool{}
	for _, hash := range strings.Split(list, ",") {
		if hash = strings.ToUpper(hash); hashPattern.MatchString(hash) && !seen[hash] {
			seen[hash] = true
			hashes = append(hashes, hash)
		}
	}
	return hashes
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

var lineBreaks = regexp.MustCompile(`[\r\n]+`)

// uploadURLs is the non-blank lines of the upload's "urls" field, which may
// be absent or null.
func uploadURLs(body map[string]any) ([]string, error) {
	value := body["urls"]
	if value == nil {
		value = ""
	}
	text, err := validate.String(value, "urls", true)
	if err != nil {
		return nil, err
	}
	urls := []string{}
	for _, line := range lineBreaks.Split(text, -1) {
		if line = validate.Trim(line); line != "" {
			urls = append(urls, line)
		}
	}
	return urls, nil
}
