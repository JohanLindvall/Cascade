// SPDX-License-Identifier: MIT

package httpapi

// The cross-site rule has to refuse exactly the requests a hostile page can
// make the browser send — and nothing that scripts, the *arr apps or browser
// extensions send, which carry no Sec-Fetch-Site, no Origin, or an origin no
// page can forge.

import "testing"

func post(f requestFacts) bool {
	f.method = "POST"
	if f.host == "" {
		f.host = "cascade.lan:8080"
	}
	return isCrossSiteRequest(f)
}

func TestReadsAreNeverRefused(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "OPTIONS", "get"} {
		if isCrossSiteRequest(requestFacts{method: method, fetchSite: "cross-site", origin: "https://evil.example"}) {
			t.Errorf("%s was refused", method)
		}
	}
}

func TestSecFetchSiteDecidesWhenABrowserSendsIt(t *testing.T) {
	for _, c := range []struct {
		facts   requestFacts
		refused bool
	}{
		{requestFacts{fetchSite: "same-origin"}, false},
		{requestFacts{fetchSite: "none"}, false}, // the user's own navigation or drop
		{requestFacts{fetchSite: "cross-site"}, true},
		{requestFacts{fetchSite: "same-site"}, true}, // a sibling subdomain is still another app
		// Behind a proxy the header still says same-origin, whatever Host became.
		{requestFacts{fetchSite: "same-origin", origin: "https://torrents.example", host: "cascade:8080"}, false},
	} {
		if got := post(c.facts); got != c.refused {
			t.Errorf("%+v: refused %v", c.facts, got)
		}
	}
}

func TestAnOlderBrowserIsJudgedByOriginAgainstTheHostItAddressed(t *testing.T) {
	for origin, refused := range map[string]bool{
		"http://cascade.lan:8080": false,
		"https://evil.example":    true,
		"http://cascade.lan:9999": true, // another port is another origin
		"null":                    true, // a sandboxed frame or a file:// page
		"HTTP://CASCADE.LAN:8080": false,
	} {
		if got := post(requestFacts{origin: origin}); got != refused {
			t.Errorf("%s: refused %v", origin, got)
		}
	}
}

func TestNonBrowserClientsCarryNoMarkersAndPass(t *testing.T) {
	if post(requestFacts{}) || isCrossSiteRequest(requestFacts{method: "DELETE"}) {
		t.Fatal("a request without browser markers was refused")
	}
}

func TestBrowserExtensionsPassOnTheirUnforgeableOrigin(t *testing.T) {
	for _, origin := range []string{"chrome-extension://abcdef", "moz-extension://1234-5678", "safari-web-extension://x"} {
		if post(requestFacts{origin: origin, fetchSite: "cross-site"}) {
			t.Errorf("%s was refused", origin)
		}
	}
}

func TestOriginFallbackComparesSchemeAndNormalisesDefaultPorts(t *testing.T) {
	if !isCrossSiteRequest(requestFacts{method: "POST", origin: "http://example.com", host: "example.com", protocol: "https"}) {
		t.Error("another scheme passed")
	}
	if isCrossSiteRequest(requestFacts{method: "POST", origin: "https://example.com", host: "example.com:443", protocol: "https"}) {
		t.Error("the default port made a difference")
	}
}
