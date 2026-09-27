package httpapi

import (
	"bytes"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

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

// jsonBody parses a JSON request body the way the browser would have sent
// it — numbers as float64, objects as maps — with lightning's decoder. present is false when the request
// carries no JSON at all, which the routes read as an empty object; an empty
// JSON body is an empty object too.
func jsonBody(r *http.Request, limit int64) (value any, present bool, err error) {
	media, params := mediaType(r)
	if media != "application/json" {
		return nil, false, nil
	}
	if charset := strings.ToLower(params["charset"]); charset != "" && !strings.HasPrefix(charset, "utf-") {
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
		return nil, false, httperr.Newf(http.StatusBadRequest, "request body must be a JSON object, not %q", truncate(string(trimmed), 20))
	}
	if value, err = lightning.DecodeAny(data); err != nil {
		return nil, false, httperr.Newf(http.StatusBadRequest, "malformed JSON body: %v", err)
	}
	return value, true, nil
}

func truncate(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return fmt.Sprintf("%s…", text[:n])
}
