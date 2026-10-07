// SPDX-License-Identifier: MIT

package httpapi

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// encodeJSON is JSON as the browser's JSON.stringify writes it: no HTML
// escaping, no trailing newline.
func encodeJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// writeJSON answers with a JSON body. A successful read carries a weak ETag,
// and a poll whose answer has not changed (a finished torrent's files, a
// quiet log) comes back as a bodiless 304.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	body, err := encodeJSON(v)
	if err != nil {
		writeError(w, r, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if status >= 200 && status < 300 {
		tag := etag(body)
		h.Set("ETag", tag)
		if fresh(r, tag) {
			h.Del("Content-Type")
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func writeText(w http.ResponseWriter, status int, text string) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(text)))
	w.WriteHeader(status)
	_, _ = w.Write([]byte(text))
}

// etag is the weak validator Express gives a body: its length and a hash of
// it, so clients that cached one from the Node server revalidate cleanly.
func etag(body []byte) string {
	sum := sha1.Sum(body)
	return fmt.Sprintf(`W/"%x-%s"`, len(body), base64.StdEncoding.EncodeToString(sum[:])[:27])
}

var noCache = regexp.MustCompile(`(?:^|,)\s*no-cache\s*(?:,|$)`)

// fresh says whether the client's copy is current: a GET or HEAD naming this
// validator in If-None-Match, unless the client asked to bypass its cache.
func fresh(r *http.Request, tag string) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	match := r.Header.Get("If-None-Match")
	if match == "" || noCache.MatchString(r.Header.Get("Cache-Control")) {
		return false
	}
	if strings.TrimSpace(match) == "*" {
		return true
	}
	opaque := strings.TrimPrefix(tag, "W/")
	for _, candidate := range strings.Split(match, ",") {
		if strings.TrimPrefix(strings.TrimSpace(candidate), "W/") == opaque {
			return true
		}
	}
	return false
}

// writeError answers every failure with JSON and a status that means
// something: an httperr carries its own, an rtorrent fault is a 502 with
// rtorrent's message, and only the unexpected is a 500.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var status *httperr.Error
	var fault *xmlrpc.Fault
	switch {
	case errors.As(err, &status):
		writeJSON(w, r, status.Status, map[string]string{"error": status.Message})
	case errors.As(err, &fault):
		writeJSON(w, r, http.StatusBadGateway, struct {
			Error     string `json:"error"`
			FaultCode int    `json:"faultCode"`
		}{fault.Message, fault.Code})
	default:
		log.Printf("[cascade] %s %s: %v", r.Method, r.URL.Path, err)
		message := err.Error()
		if message == "" {
			message = "internal error"
		}
		writeJSON(w, r, http.StatusInternalServerError, map[string]string{"error": message})
	}
}
