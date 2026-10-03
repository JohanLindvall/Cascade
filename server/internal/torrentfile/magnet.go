package torrentfile

import (
	"encoding/hex"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/utf8text"
)

// MagnetInfoHash reads the info hash out of a magnet's xt=urn:btih:, hex or
// base32, so a magnet load can be confirmed the same way an uploaded file is.
// It answers "" for anything that is not a magnet carrying one.
//
// The link is read as a browser reads it (the WHATWG URL and URLSearchParams
// rules): the xt parameters in order, the first usable one winning, with +
// as a space and percent escapes decoded.
func MagnetInfoHash(link string) string {
	query, ok := magnetQuery(link)
	if !ok {
		return ""
	}
	for _, param := range formParams(query) {
		if strings.ToLower(param[0]) != "xt" {
			continue
		}
		value, ok := btih(param[1])
		if !ok {
			continue
		}
		if len(value) == 40 && allBytes(value, isHexDigit) {
			return strings.ToUpper(value)
		}
		if len(value) == 32 && allBytes(value, isBase32) {
			return base32ToHex(value)
		}
	}
	return ""
}

// magnetQuery is the query of a magnet: URL, after the clean-up a URL parser
// does first (surrounding C0 controls and spaces trimmed, tabs and newlines
// dropped anywhere); ok is false when the scheme is not magnet.
func magnetQuery(link string) (string, bool) {
	link = strings.TrimFunc(link, func(r rune) bool { return r <= ' ' })
	link = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(link)
	scheme, rest, found := strings.Cut(link, ":")
	if !found || scheme == "" || !isAlpha(scheme[0]) ||
		!allBytes(scheme, func(c byte) bool { return isAlpha(c) || isDigit(c) || c == '+' || c == '-' || c == '.' }) ||
		strings.ToLower(scheme) != "magnet" {
		return "", false
	}
	rest, _, _ = strings.Cut(rest, "#")
	_, query, _ := strings.Cut(rest, "?")
	return query, true
}

// formParams parses application/x-www-form-urlencoded pairs, in order.
func formParams(query string) [][2]string {
	var params [][2]string
	for _, part := range strings.Split(query, "&") {
		if part == "" {
			continue
		}
		name, value, _ := strings.Cut(part, "=")
		params = append(params, [2]string{formDecode(name), formDecode(value)})
	}
	return params
}

// formDecode undoes the form encoding: + is a space, and a % escape is a byte
// only when two hex digits follow it — a stray % stays as it is.
func formDecode(text string) string {
	out := make([]byte, 0, len(text))
	for i := 0; i < len(text); i++ {
		switch c := text[i]; {
		case c == '+':
			out = append(out, ' ')
		case c == '%' && i+2 < len(text) && isHexDigit(text[i+1]) && isHexDigit(text[i+2]):
			b, _ := hex.DecodeString(text[i+1 : i+3])
			out = append(out, b[0])
			i += 2
		default:
			out = append(out, c)
		}
	}
	return utf8text.Decode(out)
}

// btih is the hash of an urn:btih: topic, matched case-insensitively and in
// full.
func btih(topic string) (string, bool) {
	const prefix = "urn:btih:"
	if len(topic) <= len(prefix) || !asciiEqualFold(topic[:len(prefix)], prefix) {
		return "", false
	}
	value := topic[len(prefix):]
	if !allBytes(value, func(c byte) bool { return isAlpha(c) || isDigit(c) }) {
		return "", false
	}
	return value, true
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

// base32ToHex converts a 32-character base32 hash to 40 hex digits.
func base32ToHex(value string) string {
	var out []byte
	var bits uint64
	width := 0
	for _, c := range []byte(strings.ToUpper(value)) {
		bits = bits<<5 | uint64(strings.IndexByte(base32Alphabet, c))
		width += 5
		if width >= 8 {
			width -= 8
			out = append(out, byte(bits>>width))
			bits &= 1<<width - 1
		}
	}
	return strings.ToUpper(hex.EncodeToString(out))
}

func allBytes(text string, ok func(byte) bool) bool {
	for i := 0; i < len(text); i++ {
		if !ok(text[i]) {
			return false
		}
	}
	return true
}

// asciiEqualFold compares ignoring ASCII case only, as the browser's
// case-insensitive regular expression does; the Unicode folding of
// strings.EqualFold would let characters such as the Kelvin sign match ASCII
// letters.
func asciiEqualFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if lower(a[i]) != lower(b[i]) {
			return false
		}
	}
	return true
}

func lower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

func isAlpha(c byte) bool    { return c|0x20 >= 'a' && c|0x20 <= 'z' }
func isDigit(c byte) bool    { return c >= '0' && c <= '9' }
func isHexDigit(c byte) bool { return isDigit(c) || (c|0x20 >= 'a' && c|0x20 <= 'f') }
func isBase32(c byte) bool   { return isAlpha(c) || (c >= '2' && c <= '7') }
