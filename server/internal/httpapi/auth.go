package httpapi

import (
	"crypto/sha256"
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
		// Both halves are always compared, and as digests of one length, so
		// the timing says neither which one was wrong nor how long either is.
		if sameSecret(gotUser, user)&sameSecret(gotPass, password) == 1 {
			return true
		}
	}
	w.Header().Set("WWW-Authenticate", `Basic realm="Cascade", charset="UTF-8"`)
	writeText(w, http.StatusUnauthorized, "authentication required")
	return false
}

// sameSecret is 1 when a and b are equal, in time that depends on neither.
func sameSecret(a, b string) int {
	digestA, digestB := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(digestA[:], digestB[:])
}
