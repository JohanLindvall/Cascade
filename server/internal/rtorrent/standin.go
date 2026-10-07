// SPDX-License-Identifier: MIT

package rtorrent

// What rtorrent sends for text XML-RPC cannot carry.
//
// Names and paths are bytes to rtorrent, and nothing makes them UTF-8: a
// torrent made on an old system names its files in Latin-1, and libtorrent
// writes those bytes to disk as they are. xmlrpc-c, the RPC layer of every
// build the image ships, takes a string only if it is UTF-8 it can hold, and
// 1.51 holds the Basic Multilingual Plane alone — so a byte that is not UTF-8,
// but also an emoji, a surrogate, U+FFFE or U+FFFF, fails its check. rtorrent
// then sends a stand-in for the whole string instead:
//
//   - from 0.16.7, every byte outside printable ASCII as %XX in upper-case hex
//     (libtorrent's string_with_escape_codes). '%' itself is not escaped, so
//     "%E9" may be the byte 0xE9 or the three characters it reads as;
//   - before 0.16.3 (0.9.x, 0.15.x, 0.16.0 to 0.16.2), every byte with its
//     high bit set, and every control byte but tab, line feed and carriage
//     return, as '?' — which also stands for itself.
//
// 0.16.3 to 0.16.6 send neither. Their string_with_escape_codes adds '%' and
// the two hex digits up as numbers, one byte from 0x85 to 0xB1 for each byte
// escaped, so the stand-in is no more UTF-8 than the string it replaces:
// xmlrpc-c refuses it as well, and rtorrent answers a command with fault -510
// — or crashes, when the string is an item of a list such as a multicall's
// answer.
//
// Text that passes is sent as it is, except that xmlrpc_string_new turns a
// carriage return, alone or before a line feed, into a line feed. A build on
// another RPC layer (tinyxml2) writes the bytes into the XML unchecked, and
// the decoder reads what is not UTF-8 as U+FFFD. Neither stand-in can be
// undone from the text alone; 0.16.13 added .base64 variants of d.base_path,
// d.name, f.frozen_path and f.path_components that carry the bytes exactly.

import (
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/utf8text"
)

const upperHex = "0123456789ABCDEF"

func printable(b byte) bool { return b >= 0x20 && b <= 0x7E }

// EscapeCodes is the stand-in rtorrent 0.16.7 and later send.
func EscapeCodes(raw string) string {
	var out strings.Builder
	for i := 0; i < len(raw); i++ {
		if b := raw[i]; printable(b) {
			out.WriteByte(b)
		} else {
			out.WriteByte('%')
			out.WriteByte(upperHex[b>>4])
			out.WriteByte(upperHex[b&0x0F])
		}
	}
	return out.String()
}

// QuestionMarks is the stand-in releases before 0.16.3 send, carriage returns
// already turned into line feeds as xmlrpc-c turns them.
func QuestionMarks(raw string) string {
	out := []byte(raw)
	for i, b := range out {
		if b >= 0x80 || (b < 0x20 && b != '\t' && b != '\n' && b != '\r') {
			out[i] = '?'
		}
	}
	return lineFeeds(string(out))
}

// lineFeeds is text xmlrpc-c accepted, as it arrives.
func lineFeeds(raw string) string {
	if !strings.Contains(raw, "\r") {
		return raw
	}
	return strings.ReplaceAll(strings.ReplaceAll(raw, "\r\n", "\n"), "\r", "\n")
}

// Reports reports whether some build of rtorrent could have sent raw — a
// name or a path as bytes on disk — as reported: as it is, or as either
// stand-in. Every form keeps '/' as it is, so it holds component by
// component.
func Reports(raw, reported string) bool {
	return reported == lineFeeds(raw) ||
		reported == EscapeCodes(raw) ||
		reported == QuestionMarks(raw) ||
		reported == utf8text.Decode([]byte(raw))
}

// MayStandIn reports whether reported could stand for bytes other than its
// own. When it cannot, it is exactly what is on disk: every stand-in marks
// what it replaced — with U+FFFD, a line feed, '?' or the escape of a byte
// outside printable ASCII — and the last two are ASCII through and through,
// so text that is not cannot be one.
func MayStandIn(reported string) bool {
	if strings.ContainsAny(reported, "\n\uFFFD") {
		return true
	}
	for i := 0; i < len(reported); i++ {
		if reported[i] >= 0x80 {
			return false
		}
	}
	if strings.Contains(reported, "?") {
		return true
	}
	for i := 0; i+2 < len(reported); i++ {
		if reported[i] != '%' {
			continue
		}
		high, low := strings.IndexByte(upperHex, reported[i+1]), strings.IndexByte(upperHex, reported[i+2])
		if high >= 0 && low >= 0 && !printable(byte(high<<4|low)) {
			return true
		}
	}
	return false
}
