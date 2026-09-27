// Package jsnum reads numbers the way the browser's Number() does, for the
// places Cascade's behaviour was defined in those terms: environment values,
// query parameters and the preferences file.
package jsnum

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	decimal  = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)
	prefixed = regexp.MustCompile(`^0([xXoObB])([0-9A-Fa-f]+)$`)
)

// Parse is Number(text): surrounding whitespace ignored, the empty string
// zero, 0x/0o/0b prefixes and exponents understood, Infinity spelled out,
// anything else NaN.
func Parse(text string) float64 {
	text = strings.TrimFunc(text, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' })
	switch text {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if m := prefixed.FindStringSubmatch(text); m != nil {
		base := map[byte]int{'x': 16, 'o': 8, 'b': 2}[strings.ToLower(m[1])[0]]
		value, err := strconv.ParseUint(m[2], base, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(value)
	}
	if !decimal.MatchString(text) {
		return math.NaN()
	}
	value, _ := strconv.ParseFloat(text, 64) // Out of range is ±Inf, as in the browser.
	return value
}

// OrZero is the `Number(text) || 0` idiom: NaN reads as zero.
func OrZero(text string) float64 {
	if value := Parse(text); !math.IsNaN(value) {
		return value
	}
	return 0
}
