// SPDX-License-Identifier: MIT

package validate

import (
	"errors"
	"strings"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

func refused(t *testing.T, err error, field string) {
	t.Helper()
	var failure *httperr.Error
	if !errors.As(err, &failure) || failure.Status != 400 || !strings.Contains(failure.Message, `"`+field+`"`) {
		t.Errorf("want a 400 naming %q, got %v", field, err)
	}
}

func TestIntTakesWholeNumbersAndNumericStrings(t *testing.T) {
	for value, want := range map[any]int64{float64(3): 3, " 12 ": 12, "-1": -1, "007": 7, float64(1e3): 1000} {
		if got, err := Int(value, "n", -1, 5000); err != nil || got != want {
			t.Errorf("%#v: %d %v", value, got, err)
		}
	}
	for _, value := range []any{nil, true, "1.5", float64(1.5), "12px", "", float64(-2), float64(5001), "1e3", []any{float64(1)}} {
		_, err := Int(value, "n", -1, 5000)
		refused(t, err, "n")
	}
	if _, err := Int(float64(MaxSafeInteger+1), "n", 0, MaxSafeInteger); err == nil {
		t.Error("past the safe range")
	}
}

func TestStringTrimsAndRefusesControlCharacters(t *testing.T) {
	if got, err := String("  x ", "s", false); got != "x" || err != nil {
		t.Errorf("%q %v", got, err)
	}
	if got, err := String("   ", "s", true); got != "" || err != nil {
		t.Errorf("%q %v", got, err)
	}
	for _, value := range []any{nil, float64(1), "   ", "a\x00b", "a\x1bb"} {
		_, err := String(value, "s", false)
		refused(t, err, "s")
	}
	if _, err := String("tab\tand\nnewline", "s", false); err != nil {
		t.Errorf("tabs and newlines are text: %v", err)
	}
}

func TestTrimIsTheBrowsersTrim(t *testing.T) {
	// String.prototype.trim takes the byte order mark and the Unicode space
	// separators, but leaves U+0085 (NEL), which unicode.IsSpace counts.
	for text, want := range map[string]string{
		"\uFEFF\u3000 x\u00A0\u2028": "x",
		"\u0085x\u0085":              "\u0085x\u0085",
		"\t\u0085\n":                 "\u0085",
	} {
		if got := Trim(text); got != want {
			t.Errorf("%q: %q, want %q", text, got, want)
		}
	}
	if got, err := String(" \u0085 ", "s", false); got != "\u0085" || err != nil {
		t.Errorf("%q %v", got, err)
	}
}

func TestBoolReadsTheUsualSpellings(t *testing.T) {
	for value, want := range map[any]bool{true: true, false: false, float64(1): true, float64(0): false,
		"yes": true, "ON": true, "true": true, "no": false, "off": false, "0": false} {
		if got, err := Bool(value, "b"); err != nil || got != want {
			t.Errorf("%#v: %v %v", value, got, err)
		}
	}
	for _, value := range []any{nil, "perhaps", float64(2), " yes"} {
		_, err := Bool(value, "b")
		refused(t, err, "b")
	}
}

func TestRecordWantsAnObject(t *testing.T) {
	if _, err := Record(map[string]any{}, "body"); err != nil {
		t.Error(err)
	}
	for _, value := range []any{nil, []any{}, "x", float64(1)} {
		_, err := Record(value, "body")
		refused(t, err, "body")
	}
}
