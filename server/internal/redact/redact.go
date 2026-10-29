// SPDX-License-Identifier: MIT

// Package redact keeps tracker credentials out of search text and errors.
// These rules mirror web/src/redact.ts, which masks the same text on screen.
package redact

import (
	"net/url"
	"regexp"
	"strings"
)

const mask = "•••"

var (
	parts     = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*://[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$`)
	segment   = regexp.MustCompile(`^[A-Za-z0-9_-]{16,}(\.[A-Za-z0-9_-]+)*$`)
	parameter = regexp.MustCompile(`([?&;])([^=&;]+)=([^&;]*)`)
	// The same whitespace as JavaScript's \s, including non-ASCII spaces.
	inText       = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s\x{000b}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}'"<>]+`)
	secretParams = map[string]bool{
		"passkey": true, "authkey": true, "torrent_pass": true, "pk": true,
		"pid": true, "uid": true, "key": true, "token": true, "secret": true,
		"apikey": true, "api_key": true, "auth": true, "sig": true, "signature": true,
	}
)

func decoded(text string) string {
	if value, err := url.PathUnescape(text); err == nil {
		return value
	}
	return text
}

// URL masks credentials without decoding or rewriting the rest of the URL.
func URL(text string) string {
	p := parts.FindStringSubmatch(text)
	if p == nil {
		return text
	}
	host := p[1]
	if at := strings.LastIndexByte(host, '@'); at >= 0 {
		host = host[:strings.Index(host, "://")+3] + mask + host[at:]
	}
	path := strings.Split(p[2], "/")
	for i, part := range path {
		if segment.MatchString(decoded(part)) {
			path[i] = mask
		}
	}
	query := parameter.ReplaceAllStringFunc(p[3], func(pair string) string {
		key, _, _ := strings.Cut(pair[1:], "=")
		if secretParams[strings.ToLower(decoded(key))] {
			return pair[:1] + key + "=" + mask
		}
		return pair
	})
	return host + strings.Join(path, "/") + query + p[4]
}

// Secrets only touches URLs: bare info hashes in messages remain searchable.
func Secrets(text string) string {
	if !strings.Contains(text, "://") {
		return text
	}
	return inText.ReplaceAllStringFunc(text, func(span string) string {
		url := strings.TrimRight(span, ")].,;:!?")
		return URL(url) + span[len(url):]
	})
}
