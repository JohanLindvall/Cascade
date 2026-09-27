package httpapi

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
)

// basicAuth reports whether the request carries the configured credentials,
// answering the challenge itself when it does not. Auth is enabled only when
// both a user and a password are set.
func basicAuth(w http.ResponseWriter, r *http.Request, user, password string) bool {
	if user == "" || password == "" {
		return true
	}
	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Basic ") {
		// Padding is optional here, as it is to every browser's own decoder.
		decoded, _ := base64.RawStdEncoding.DecodeString(strings.TrimRight(header[len("Basic "):], "="))
		// A colon may sit inside the password; only the first one separates.
		gotUser, gotPass, _ := strings.Cut(string(decoded), ":")
		// Both halves are always compared, so the timing does not say which
		// one was wrong.
		userOK := subtle.ConstantTimeCompare([]byte(gotUser), []byte(user))
		passOK := subtle.ConstantTimeCompare([]byte(gotPass), []byte(password))
		if userOK&passOK == 1 {
			return true
		}
	}
	w.Header().Set("WWW-Authenticate", `Basic realm="Cascade", charset="UTF-8"`)
	writeText(w, http.StatusUnauthorized, "authentication required")
	return false
}
