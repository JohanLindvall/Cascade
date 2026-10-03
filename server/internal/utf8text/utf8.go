// Package utf8text decodes external text the way a browser does, replacing
// each maximal ill-formed UTF-8 sequence once.
package utf8text

import (
	"strings"
	"unicode/utf8"
)

// Decode reads bytes as UTF-8 the way a browser (and Node's
// Buffer.toString) does: each maximal ill-formed subsequence becomes one
// U+FFFD, so what a stray byte turns into does not depend on the reader.
func Decode(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	out.Grow(len(b) + 8)
	needed, seen := 0, 0
	var code rune
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if needed == 0 {
			i++
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, code = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				needed, code = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				needed, code = 3, rune(c&0x07)
			default:
				out.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// Not a continuation here: the sequence so far is one error, and
			// this byte starts over as whatever it is.
			code, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out.WriteRune(utf8.RuneError)
			continue
		}
		lower, upper = 0x80, 0xBF
		code = code<<6 | rune(c&0x3F)
		seen++
		i++
		if seen == needed {
			out.WriteRune(code)
			code, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out.WriteRune(utf8.RuneError)
	}
	return out.String()
}
