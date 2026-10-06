// SPDX-License-Identifier: MIT

package httpapi

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	lightning "github.com/JohanLindvall/lightning/pkg/json"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

const (
	jsonLimit    = 4 << 20
	rpcJSONLimit = 1 << 20
	rpcRawLimit  = 16 << 20
)

// mediaType is the request's Content-Type without parameters, lower-case.
func mediaType(r *http.Request) (string, map[string]string) {
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return "", nil
	}
	return media, params
}

// readBody reads the whole body, refusing one over limit with a 413.
func readBody(r *http.Request, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, httperr.New(http.StatusBadRequest, "request aborted")
	}
	if int64(len(data)) > limit {
		return nil, httperr.New(http.StatusRequestEntityTooLarge, "request entity too large")
	}
	return data, nil
}

// jsonBody parses a JSON request body the way the browser would have sent it
// — numbers as float64, objects as maps — with lightning's decoder. present is
// false when the request carries no JSON at all, which the routes read as an
// empty object; an empty JSON body is an empty object too.
func jsonBody(r *http.Request, limit int64) (value any, present bool, err error) {
	media, params := mediaType(r)
	if media != "application/json" {
		return nil, false, nil
	}
	// JSON is UTF-8 (RFC 8259); a body declared as anything else would be
	// misread rather than decoded.
	if charset := strings.ToLower(params["charset"]); charset != "" && charset != "utf-8" && charset != "utf8" {
		return nil, false, httperr.Newf(http.StatusUnsupportedMediaType, "unsupported charset %q", strings.ToUpper(charset))
	}
	data, err := readBody(r, limit)
	if err != nil {
		return nil, false, err
	}
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	if len(trimmed) == 0 {
		return map[string]any{}, true, nil
	}
	// Only an object or an array is a request; a bare scalar is a mistake.
	if trimmed[0] != '{' && trimmed[0] != '[' {
		return nil, false, httperr.Newf(http.StatusBadRequest, "request body must be a JSON object, not %q", truncate(trimmed, 20))
	}
	if value, err = lightning.DecodeAny(data); err != nil {
		return nil, false, httperr.Newf(http.StatusBadRequest, "malformed JSON body: %v", err)
	}
	return value, true, nil
}

// truncate is at most n characters of text, marked when cut. It decodes no
// further than it keeps and copies only that: the text can be a whole
// request body of megabytes, refused for its first byte.
func truncate(text []byte, n int) string {
	end := 0
	for range n {
		if end == len(text) {
			break
		}
		_, size := utf8.DecodeRune(text[end:])
		end += size
	}
	if end == len(text) {
		return string(text)
	}
	return string(text[:end]) + "…"
}
