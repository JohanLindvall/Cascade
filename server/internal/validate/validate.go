// Package validate checks request input at the API edge, answering a 400 that
// names the field. JSON bodies are decoded into plain maps, so every checker
// takes the decoded value as it came: float64 for a number, string, bool, nil
// for null, []any and map[string]any. A field that is absent is the caller's
// to handle (look it up with the comma-ok form); these see only values.
package validate

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

// MaxSafeInteger is the largest integer a JSON number carries exactly, and so
// the default upper bound of Int — the same bound the browser's numbers have.
const MaxSafeInteger = 1<<53 - 1

// Record requires a JSON object.
func Record(value any, field string) (map[string]any, error) {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil, httperr.Newf(400, "%q must be an object", field)
	}
	return record, nil
}

var controlChars = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f]")

// String requires a string, trimmed, free of control characters, and unless
// allowEmpty is set, not blank.
func String(value any, field string, allowEmpty bool) (string, error) {
	text, ok := value.(string)
	if !ok || (!allowEmpty && Trim(text) == "") {
		want := "a non-empty string"
		if allowEmpty {
			want = "a string"
		}
		return "", httperr.Newf(400, "%q must be %s", field, want)
	}
	if controlChars.MatchString(text) {
		return "", httperr.Newf(400, "%q contains control characters", field)
	}
	return Trim(text), nil
}

// Trim removes surrounding whitespace the way the browser's String.trim does,
// byte order mark included.
func Trim(text string) string {
	return strings.TrimFunc(text, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' })
}

var integerText = regexp.MustCompile(`^-?\d+$`)

// Int requires a whole number from min to max. Numeric strings are accepted
// too, since URL parameters and multipart fields carry nothing else.
func Int(value any, field string, min, max int64) (int64, error) {
	number := math.NaN()
	switch v := value.(type) {
	case float64:
		number = v
	case int:
		number = float64(v)
	case int64:
		number = float64(v)
	case string:
		if text := Trim(v); integerText.MatchString(text) {
			if parsed, err := strconv.ParseFloat(text, 64); err == nil {
				number = parsed
			}
		}
	}
	if number != math.Trunc(number) || math.Abs(number) > MaxSafeInteger ||
		number < float64(min) || number > float64(max) {
		return 0, httperr.Newf(400, "%q must be a whole number from %d to %d", field, min, max)
	}
	return int64(number), nil
}

var (
	truthy = regexp.MustCompile(`(?i)^(1|true|yes|on)$`)
	falsy  = regexp.MustCompile(`(?i)^(0|false|no|off)$`)
)

// Bool requires a boolean, or 1/0, or one of the usual spellings of either.
func Bool(value any, field string) (bool, error) {
	switch v := value.(type) {
	case bool:
		return v, nil
	case float64:
		if v == 1 {
			return true, nil
		}
		if v == 0 {
			return false, nil
		}
	case string:
		if truthy.MatchString(v) {
			return true, nil
		}
		if falsy.MatchString(v) {
			return false, nil
		}
	}
	return false, httperr.Newf(400, "%q must be a boolean", field)
}
