package httpapi

import (
	"net/http"
	"strings"

	"github.com/klauspost/compress/gzhttp"
)

// Bodies smaller than this are sent as they are: the framing costs about 20
// bytes, and a 204 or a short error gains nothing.
const minCompressSize = 1024

// compressible is what gains from compression: text, JSON, script and
// markup — the state stream included. Images other than SVG, fonts and
// .torrent files are compressed already or barely compress.
func compressible(contentType string) bool {
	mediaType, _, _ := strings.Cut(contentType, ";")
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	switch {
	case strings.HasPrefix(mediaType, "text/"):
		return true
	case mediaType == "application/json", mediaType == "application/javascript",
		mediaType == "application/xml", mediaType == "application/manifest+json",
		mediaType == "image/svg+xml", strings.HasSuffix(mediaType, "+json"):
		return true
	}
	return false
}

// compress wraps a handler so a client that takes compression gets it: zstd
// when it offers zstd, else gzip, both from klauspost/compress. Browsers offer
// zstd only over HTTPS — behind a TLS proxy, then — and gzip everywhere. A
// streamed response is compressed as one stream, flushed whenever the handler
// flushes, which is what keeps a delta of a few changed rates to a few dozen
// bytes. Validators are left as they are: the server's are weak, and a
// compressed representation of the same bytes may share one, which keeps a
// revalidating poll a bodiless 304 whichever encoding it asked for.
var compress = func() func(http.Handler) http.HandlerFunc {
	wrap, err := gzhttp.NewWrapper(gzhttp.MinSize(minCompressSize), gzhttp.ContentTypeFilter(compressible))
	if err != nil {
		panic(err) // Only an invalid option fails, and these are constants.
	}
	return wrap
}()
