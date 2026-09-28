package jsnum

import (
	"math"
	"testing"
)

func TestParseReadsWhatTheBrowserReads(t *testing.T) {
	for text, want := range map[string]float64{
		"": 0, "  ": 0, "42": 42, " 7 ": 7, "-3": -3, "+3": 3, "1.5": 1.5, ".5": 0.5, "5.": 5,
		"1e3": 1000, "1E-2": 0.01, "0x10": 16, "0X1f": 31, "0o17": 15, "0b101": 5, "007": 7,
		"Infinity": math.Inf(1), "-Infinity": math.Inf(-1), "1e400": math.Inf(1), "1e-400": 0,
		// Past 2^64 a radix literal still reads, rounded as the browser rounds it.
		"0xffffffffffffffffffff": 1208925819614629174706176,
		// The whitespace Number() trims: tabs, line terminators, no-break and
		// ideographic spaces, the byte order mark.
		"\t\n\v\f\r 12 \u00A0\u2028\u2029\u3000\uFEFF": 12,
	} {
		if got := Parse(text); got != want {
			t.Errorf("Parse(%q) = %v, want %v", text, got, want)
		}
	}
	for _, text := range []string{
		"abc", "1,5", "1_000", "Inf", "inf", "NaN", "0x", "-0x10", "+0x10", "1e", "--1", "12px",
		"0b12", "0o9", "0xg", "\u0085 1", // U+0085 is not whitespace to Number()
		"1 000", "infinity", "nan", "0x1p3", ".",
	} {
		if got := Parse(text); !math.IsNaN(got) {
			t.Errorf("Parse(%q) = %v, want NaN", text, got)
		}
	}
	if OrZero("junk") != 0 || OrZero("9") != 9 {
		t.Error("OrZero")
	}
}

func TestFormatWritesWhatTheBrowserWrites(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want string
	}{
		{0, "0"}, {math.Copysign(0, -1), "0"}, {1, "1"}, {-1.5, "-1.5"}, {0.1, "0.1"},
		{123456789012345680000, "123456789012345680000"}, {1e21, "1e+21"}, {1.5e21, "1.5e+21"},
		{0.000001, "0.000001"}, {1e-7, "1e-7"}, {1.5e-7, "1.5e-7"}, {-2.5e-10, "-2.5e-10"},
		{9007199254740993, "9007199254740992"}, {100, "100"}, {0.5, "0.5"}, {1.25e22, "1.25e+22"},
		{1e20, "100000000000000000000"}, {5e-324, "5e-324"}, {math.MaxFloat64, "1.7976931348623157e+308"},
		{math.NaN(), "NaN"}, {math.Inf(1), "Infinity"}, {math.Inf(-1), "-Infinity"},
	} {
		if got := Format(c.in); got != c.want {
			t.Errorf("Format(%v) = %q, want %q", c.in, got, c.want)
		}
	}
	// Whatever Format writes, Parse reads back.
	for _, f := range []float64{3.14159, 1e300, 5e-324, 123.456, -1e-5, 1 << 60} {
		if got := Parse(Format(f)); got != f {
			t.Errorf("Parse(Format(%v)) = %v", f, got)
		}
	}
}

func TestFormatWritesTheSumsTheBrowserWrites(t *testing.T) {
	// At run time, not as a constant: Go folds 0.1 + 0.2 exactly.
	tenth, fifth := 0.1, 0.2
	if got := Format(tenth + fifth); got != "0.30000000000000004" {
		t.Errorf("Format(0.1+0.2) = %q", got)
	}
}

func TestRoundHalvesTowardPositiveInfinity(t *testing.T) {
	for in, want := range map[float64]float64{
		2.5: 3, 2.49: 2, -2.5: -2, -2.6: -3, 0.49999999999999994: 0, 750.4: 750, 750.5: 751, 0: 0,
	} {
		if got := Round(in); got != want {
			t.Errorf("Round(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestIsSpace(t *testing.T) {
	for _, r := range []rune{' ', '\t', '\u00A0', '\u1680', '\u2000', '\u200A', '\u202F', '\u205F', '\u3000', '\uFEFF', '\u2028'} {
		if !IsSpace(r) {
			t.Errorf("%U is whitespace to Number()", r)
		}
	}
	for _, r := range []rune{'x', '0', '\u0085', '\u200B'} {
		if IsSpace(r) {
			t.Errorf("%U is not whitespace to Number()", r)
		}
	}
}
