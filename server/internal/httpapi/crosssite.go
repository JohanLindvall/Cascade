// SPDX-License-Identifier: MIT

package httpapi

import (
	"net/url"
	"regexp"
	"strings"
)

// Refuse state-changing requests that a *different website* made the
// browser send.
//
// The JSON endpoints are already out of a hostile page's reach: a cross-site
// request with `content-type: application/json` needs a CORS preflight,
// which this server never answers. /api/torrents/upload is not:
// multipart/form-data is a "simple" request, so any page the owner visits
// could post a form there and have their rtorrent fetch whatever magnet or
// URL it liked — with Basic auth on, too, since the browser attaches cached
// credentials to the form post.
//
// Browsers say where a request came from, and nothing else does:
// Sec-Fetch-Site on every modern browser, Origin on older ones. Only requests
// carrying one of those and naming another site are refused, so curl, the
// Python xmlrpc client, the *arr apps and other non-browser callers of /api
// and /RPC2 are untouched, and so are browser extensions (their origin cannot
// be forged by a page).

// requestFacts are the parts of a request the rule looks at.
type requestFacts struct {
	method string
	// The Origin header, if any.
	origin string
	// The Sec-Fetch-Site header, if any.
	fetchSite string
	// The host the browser addressed: X-Forwarded-Host behind a proxy, else Host.
	host     string
	protocol string
}

// Extension pages post as themselves; a web page cannot claim these schemes.
var extensionOrigin = regexp.MustCompile(`(?i)^(chrome|moz|safari-web)-extension://`)

func isCrossSiteRequest(f requestFacts) bool {
	switch strings.ToUpper(f.method) {
	case "GET", "HEAD", "OPTIONS":
		return false // Methods that must not change state need no check.
	}
	if f.origin != "" && extensionOrigin.MatchString(f.origin) {
		return false
	}
	// "none" is the user's own doing: a bookmark, the address bar, a drop.
	if f.fetchSite != "" {
		return f.fetchSite != "same-origin" && f.fetchSite != "none"
	}
	if f.origin != "" {
		protocol := f.protocol
		if protocol == "" {
			protocol = "http"
		}
		expected, ok := originOf(protocol + "://" + f.host)
		got, gotOK := originOf(f.origin)
		// "null" and other opaque origins are a sandbox, never this page.
		return !ok || !gotOK || got != expected
	}
	return false // No browser markers at all: a script, not a page.
}

var defaultPorts = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}

// originOf is the serialized origin of an absolute URL — scheme, host and a
// port only when it is not the scheme's default — or false when it has none.
func originOf(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if _, special := defaultPorts[scheme]; !special {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && port != defaultPorts[scheme] {
		host += ":" + port
	}
	return scheme + "://" + host, true
}
