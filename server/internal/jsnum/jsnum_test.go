package jsnum

import (
	"math"
	"testing"
)

func TestParseReadsWhatTheBrowserReads(t *testing.T) {
	for text, want := range map[string]float64{
		"": 0, "  ": 0, "42": 42, " 7 ": 7, "-3": -3, "+3": 3, "1.5": 1.5, ".5": 0.5, "5.": 5,
		"1e3": 1000, "1E-2": 0.01, "0x10": 16, "0X1f": 31, "0o17": 15, "0b101": 5, "007": 7,
		"Infinity": math.Inf(1), "-Infinity": math.Inf(-1), "1e400": math.Inf(1),
	} {
		if got := Parse(text); got != want {
			t.Errorf("Parse(%q) = %v, want %v", text, got, want)
		}
	}
	for _, text := range []string{"abc", "1,5", "1_000", "Inf", "inf", "NaN", "0x", "-0x10", "1e", "--1", "12px"} {
		if got := Parse(text); !math.IsNaN(got) {
			t.Errorf("Parse(%q) = %v, want NaN", text, got)
		}
	}
	if OrZero("junk") != 0 || OrZero("9") != 9 {
		t.Error("OrZero")
	}
}
