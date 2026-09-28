// Package jsnum reads and writes numbers the way the browser's Number() and
// String() do, for the places Cascade's behaviour was defined in those terms:
// environment values, query parameters, preferences and rtorrent's answers.
package jsnum

import (
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	decimal = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)
	radix   = regexp.MustCompile(`^0([xXoObB])([0-9A-Fa-f]+)$`)
)

// IsSpace is the whitespace Number() ignores around a number: the Unicode
// space separators, the line terminators and the byte order mark — which is
// not quite unicode.IsSpace (that also counts U+0085, and misses U+FEFF).
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\u2028', '\u2029', '\uFEFF':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// Parse is Number(text): surrounding whitespace ignored, the empty string
// zero, decimal and exponent forms, unsigned 0x/0o/0b integers of any length
// (rounded to the nearest float64, as the browser does), and Infinity spelled
// out; anything else is NaN.
func Parse(text string) float64 {
	text = strings.TrimFunc(text, IsSpace)
	switch text {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if m := radix.FindStringSubmatch(text); m != nil {
		base := map[byte]int{'x': 16, 'o': 8, 'b': 2}[strings.ToLower(m[1])[0]]
		n, ok := new(big.Int).SetString(m[2], base)
		if !ok {
			return math.NaN() // a digit the base does not have: 0b12, 0o9
		}
		value, _ := new(big.Float).SetInt(n).Float64()
		return value
	}
	if !decimal.MatchString(text) {
		return math.NaN()
	}
	// The literal is validated, so the only error left is a range one, and
	// ParseFloat then answers the ±Inf or 0 the browser would.
	value, _ := strconv.ParseFloat(text, 64)
	return value
}

// OrZero is the `Number(text) || 0` idiom: NaN reads as zero.
func OrZero(text string) float64 {
	if value := Parse(text); !math.IsNaN(value) {
		return value
	}
	return 0
}

// Format is String(f): the shortest digits that read back as f, positional
// from 1e-6 up to 1e21 and exponential (1e+21, 1.5e-7) outside that.
func Format(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0" // negative zero included
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// 'e' with precision -1 gives the shortest round-trip digits: d.ddde±x.
	mantissa, exponent, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exp, _ := strconv.Atoi(exponent)
	k, n := len(digits), exp+1 // the value is digits × 10^(n−k)
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	exponentSign := "+"
	if n-1 < 0 {
		exponentSign = "-"
	}
	power := strconv.Itoa(max(n-1, 1-n))
	if k == 1 {
		return sign + digits + "e" + exponentSign + power
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + exponentSign + power
}

// Round is Math.round: the nearest integer, halves toward +Infinity (so
// Round(2.5) is 3 and Round(-2.5) is -2), where math.Round rounds them away
// from zero.
func Round(f float64) float64 {
	floor := math.Floor(f)
	if f-floor >= 0.5 {
		return floor + 1
	}
	return floor
}
