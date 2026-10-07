// SPDX-License-Identifier: MIT

package validate

// What rtorrent can be sent as text.
//
// Strings reach rtorrent as XML-RPC text, which xmlrpc-c — the RPC layer of
// every build the image ships — takes only as UTF-8 within the Basic
// Multilingual Plane: a character beyond U+FFFF, an emoji, fails the whole
// call with fault -503 ("Call XML not a proper XML-RPC call", on 0.9.8 as on
// 0.16.25) before rtorrent has seen any of it. XML itself cannot carry
// U+FFFE, U+FFFF or a control character other than tab, line feed and
// carriage return, and reads a carriage return as a line feed; the encoder
// sends a byte that is not UTF-8 as U+FFFD. None of those reaches rtorrent as
// it was given, so a value typed for rtorrent is refused here, at the API
// edge, with a 400 naming the field, before rtorrent is asked anything: a
// directory change used to stop and close the torrent first, then fail with
// the fault and leave it stopped.
//
// Labels need none of it: they go URL-encoded (encodeURIComponent in
// internal/service), ASCII whatever they hold. The API console and /RPC2 pass
// text through as given, and rtorrent's fault is their answer.

import (
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

// Sendable reports whether text reaches rtorrent as it is.
func Sendable(text string) bool { return unsendable(text) == "" }

// unsendable is what in text does not reach rtorrent as it is, the first
// such thing, worded to follow a field's name; "" when there is none. The
// web UI words it the same (unsendable in web/src/rtorrentText.ts).
func unsendable(text string) string {
	for i, r := range text {
		switch {
		case r == utf8.RuneError && !strings.HasPrefix(text[i:], "\uFFFD"):
			return fmt.Sprintf("contains a byte that is not UTF-8 (0x%02X)", text[i])
		case r > 0xFFFF:
			return fmt.Sprintf(`contains "%c" (U+%04X): rtorrent's XML-RPC layer takes no character beyond U+FFFF, `+
				`such as an emoji`, r, r)
		case r == 0xFFFE || r == 0xFFFF:
			return fmt.Sprintf("contains U+%04X, which XML cannot carry", r)
		case r == '\r':
			return "contains a carriage return, which XML reads as a line feed"
		case r < 0x20 && r != '\t' && r != '\n':
			return fmt.Sprintf("contains U+%04X, a control character XML cannot carry", r)
		}
	}
	return ""
}

// RtorrentText refuses text that does not reach rtorrent as it is
// (Sendable), with a 400 naming the field and what it holds.
func RtorrentText(text, field string) error {
	if problem := unsendable(text); problem != "" {
		return httperr.Newf(http.StatusBadRequest, "%q %s", field, problem)
	}
	return nil
}

// RtorrentString is String for a value rtorrent is sent as text.
func RtorrentString(value any, field string, allowEmpty bool) (string, error) {
	text, err := String(value, field, allowEmpty)
	if err == nil {
		err = RtorrentText(text, field)
	}
	if err != nil {
		return "", err
	}
	return text, nil
}

// Directory is RtorrentString for a directory rtorrent is to keep a
// torrent's data in, and refuses the root as well: rtorrent strips the
// trailing slashes of a directory it is given, so "/", however many slashes
// it is typed with, leaves "", which it reads as "." — the directory it runs
// in — and a single file goes there rather than into the root (0.9.8 and
// 0.16.25 alike, a change or an add). An empty directory, where allowEmpty
// lets it be, is the caller's: an add reads it as rtorrent's default.
func Directory(value any, field string, allowEmpty bool) (string, error) {
	text, err := RtorrentString(value, field, allowEmpty)
	if err == nil && text != "" && strings.Trim(text, "/") == "" {
		err = httperr.Newf(http.StatusBadRequest,
			`%q cannot be "/": rtorrent strips a directory's trailing slashes and would put a single file in ".", `+
				`the directory it runs in`, field)
	}
	if err != nil {
		return "", err
	}
	return text, nil
}
