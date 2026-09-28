package httpapi

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

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
		if f, info := s.openWebFile(p); f != nil {
			defer f.Close()
			cache := "no-cache"
			if strings.HasPrefix(p, "/assets/") {
				cache = "public, max-age=31536000, immutable"
			}
			serveFile(w, r, f, info, cache)
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
	f, info := s.openWebFile("/index.html")
	if f == nil {
		writeText(w, http.StatusInternalServerError, "web assets not found at "+s.cfg.WebRoot)
		return
	}
	defer f.Close()
	serveFile(w, r, f, info, "no-cache")
}

// openWebFile opens a regular file under the web root, or answers nil: never
// a dotfile, and never anything outside the root — os.Root refuses a path,
// or a symlink inside the root, that leads out of it.
func (s *Server) openWebFile(urlPath string) (*os.File, os.FileInfo) {
	name := strings.TrimPrefix(path.Clean("/"+urlPath), "/")
	if name == "" {
		return nil, nil
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return nil, nil
		}
	}
	root, err := os.OpenRoot(s.cfg.WebRoot)
	if err != nil {
		return nil, nil
	}
	defer root.Close() // the file stays open on its own descriptor
	f, err := root.Open(filepath.FromSlash(name))
	if err != nil {
		return nil, nil
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, nil
	}
	return f, info
}

func serveFile(w http.ResponseWriter, r *http.Request, f *os.File, info os.FileInfo, cache string) {
	h := w.Header()
	h.Set("Cache-Control", cache)
	// The validator Express's static files had: size and modification time.
	h.Set("ETag", fmt.Sprintf(`W/"%x-%x"`, info.Size(), info.ModTime().UnixMilli()))
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
