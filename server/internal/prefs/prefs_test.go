package prefs

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"testing"
)

// Preference sanitizing is the wall between a hand-edited state file (or a
// hostile PATCH body) and the UI: anything malformed falls back rather than
// reaching the browser.

func poll(ms int) *int { return &ms }

func TestACleanPatchMergesOverTheCurrentValues(t *testing.T) {
	next := Sanitize(Default(), map[string]any{"theme": "retro", "sortDir": "asc"})
	if next.Theme != "retro" || next.SortDir != "asc" || next.SortKey != Default().SortKey {
		t.Fatalf("got %+v", next)
	}
}

func TestUnknownThemesAndSortKeysFallBackToTheDefaults(t *testing.T) {
	next := Sanitize(Default(), map[string]any{"theme": "chrome-vomit", "sortKey": "nonsense"})
	if next.Theme != "system" || next.SortKey != "addedAt" {
		t.Fatalf("got %+v", next)
	}
}

func TestDetailHeightIsClampedIntoItsLivableRange(t *testing.T) {
	for _, c := range []struct {
		in   any
		want int
	}{
		{5.0, 140},
		{99999.0, 2000},
		{math.NaN(), Default().DetailHeight},
		{300.5, 301}, // Math.round: halves go up
		{300.49, 300},
	} {
		if got := Sanitize(Default(), map[string]any{"detailHeight": c.in}).DetailHeight; got != c.want {
			t.Errorf("detailHeight %v: got %d, want %d", c.in, got, c.want)
		}
	}
}

func TestSeenBadgesDeduplicatesStringifiesAndCaps(t *testing.T) {
	list := []any{"a", "a", 1.0}
	for i := 0; i < 500; i++ {
		list = append(list, fmt.Sprintf("x%d", i))
	}
	next := Sanitize(Default(), map[string]any{"seenBadges": list})
	if len(next.SeenBadges) != 200 || next.SeenBadges[0] != "a" || next.SeenBadges[1] != "1" ||
		next.SeenBadges[2] != "x0" || next.SeenBadges[199] != "x197" {
		t.Fatalf("got %d badges, starting %v", len(next.SeenBadges), next.SeenBadges[:3])
	}
	if got := Sanitize(Default(), map[string]any{"seenBadges": "no"}).SeenBadges; got == nil || len(got) != 0 {
		t.Fatalf("a non-array gave %#v, want an empty list", got)
	}
	// Numbers are stringified as the browser prints them; other items drop.
	got := Sanitize(Default(), map[string]any{"seenBadges": []any{1.5, 1e21, true, nil, map[string]any{}, "b", 1.0}}).SeenBadges
	if !reflect.DeepEqual(got, []string{"1.5", "1e+21", "b", "1"}) {
		t.Fatalf("got %#v", got)
	}
}

func TestStatePollMsTakesNumbersAndClampsThem(t *testing.T) {
	for _, c := range []struct {
		in   any
		want *int
	}{
		{1000.0, poll(1000)},
		{1.0, poll(StatePollMsMin)},
		{1e9, poll(StatePollMsMax)},
		{999.5, poll(1000)},
		{"1e3", poll(1000)},
		{" 750 ", poll(750)},
		{"0x3e8", poll(1000)},
		{"0o1750", poll(1000)},
		{"0b1111101000", poll(1000)},
		{".5e4", poll(5000)},
		{"+800", poll(800)},
		{"5.", poll(StatePollMsMin)},
		// Anything that is not a number means "the server's default".
		{nil, nil},
		{"", nil},
		{"   ", nil},
		{"Infinity", nil},
		{"-Infinity", nil},
		{"abc", nil},
		{"-0x10", nil},
		{"1_000", nil},
		{"0x", nil},
		{"1e", nil},
		{"NaN", nil},
		{true, nil},
		{[]any{1000.0}, nil},
	} {
		got := Sanitize(Default(), map[string]any{"statePollMs": c.in}).StatePollMs
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("statePollMs %#v: got %v, want %v", c.in, deref(got), deref(c.want))
		}
	}
}

func deref(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestAPatchWithoutAFieldKeepsTheCurrentValue(t *testing.T) {
	current := Sanitize(Default(), map[string]any{
		"theme": "dark", "sortKey": "name", "sortDir": "asc", "detailHeight": 500.0,
		"seenBadges": []any{"touchdown"}, "statePollMs": 2000.0,
	})
	if got := Sanitize(current, map[string]any{}); !reflect.DeepEqual(got, current) {
		t.Fatalf("an empty patch changed %+v into %+v", current, got)
	}
	// Anything but an object is an empty patch too.
	for _, patch := range []any{nil, "theme", []any{"retro"}, 3.0, map[string]any(nil)} {
		if got := Sanitize(current, patch); !reflect.DeepEqual(got, current) {
			t.Errorf("patch %#v changed the preferences to %+v", patch, got)
		}
	}
}

func TestNullInAPatchRepairsToTheDefaultRatherThanKeeping(t *testing.T) {
	current := Sanitize(Default(), map[string]any{
		"theme": "dark", "sortDir": "asc", "detailHeight": 500.0, "seenBadges": []any{"x"}, "statePollMs": 2000.0,
	})
	got := Sanitize(current, map[string]any{
		"theme": nil, "sortDir": nil, "detailHeight": nil, "seenBadges": nil, "statePollMs": nil,
	})
	if !reflect.DeepEqual(got, Default()) {
		t.Fatalf("got %+v, want the defaults", got)
	}
}

func TestUnknownKeysAreNotRetained(t *testing.T) {
	data, err := json.Marshal(Sanitize(Default(), map[string]any{"evil": "yes", "theme": "light"}))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"theme":"light","sortKey":"addedAt","sortDir":"desc","detailHeight":280,"seenBadges":[],"statePollMs":null}`
	if string(data) != want {
		t.Fatalf("got %s", data)
	}
}

func TestNormalizeRepairsAnything(t *testing.T) {
	for _, v := range []any{nil, "x", []any{}, map[string]any{"theme": 7.0}} {
		if got := Normalize(v); !reflect.DeepEqual(got, Default()) {
			t.Errorf("Normalize(%#v) = %+v", v, got)
		}
	}
	if got := Normalize(map[string]any{"statePollMs": json.Number("500")}); deref(got.StatePollMs) != 500 {
		t.Errorf("a json.Number was not read as a number: %+v", got)
	}
}

func TestIsThemeAndIsSortKey(t *testing.T) {
	for _, theme := range Themes {
		if !IsTheme(theme) {
			t.Errorf("%s is not a theme", theme)
		}
	}
	for _, key := range SortKeys {
		if !IsSortKey(key) {
			t.Errorf("%s is not a sort key", key)
		}
	}
	for _, v := range []any{"", "System", "dark ", nil, 1.0} {
		if IsTheme(v) {
			t.Errorf("theme %#v was accepted", v)
		}
	}
	for _, v := range []any{"", "Name", "name ", nil, 1.0} {
		if IsSortKey(v) {
			t.Errorf("sort key %#v was accepted", v)
		}
	}
}

func TestNumberFollowsJavaScript(t *testing.T) {
	for _, c := range []struct {
		in   string
		want float64
	}{
		{"", 0},
		{"  ", 0},
		{"42", 42},
		{"007", 7},
		{"-7", -7},
		{"1e3", 1000},
		{"1E-2", 0.01},
		{"0x10", 16},
		{"0XfF", 255},
		{"0b101", 5},
		{"0o17", 15},
		{"1e400", math.Inf(1)},
		{"-1e400", math.Inf(-1)},
		{"Infinity", math.Inf(1)},
		{"\t12\n", 12},
		{"0xffffffffffffffffff", 4722366482869645213696}, // past uint64, rounded as JS rounds
	} {
		if got := Number(c.in); got != c.want {
			t.Errorf("Number(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	for _, in := range []string{"abc", "1,000", "1 000", "--1", "0x", "-0x1", "0b2", "0o8", "infinity", "inf", "nan", "1_0", "0x1p3", "."} {
		if got := Number(in); !math.IsNaN(got) {
			t.Errorf("Number(%q) = %v, want NaN", in, got)
		}
	}
}

func TestNumberStringFollowsJavaScript(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{math.Copysign(0, -1), "0"},
		{1, "1"},
		{-1, "-1"},
		{1.5, "1.5"},
		{100, "100"},
		{0.1, "0.1"},
		{0.000001, "0.000001"},
		{1e-7, "1e-7"},
		{1.5e-7, "1.5e-7"},
		{-2.5e-10, "-2.5e-10"},
		{1e20, "100000000000000000000"},
		{123456789012345680000, "123456789012345680000"},
		{1e21, "1e+21"},
		{1.25e22, "1.25e+22"},
		{math.MaxFloat64, "1.7976931348623157e+308"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
	} {
		if got := NumberString(c.in); got != c.want {
			t.Errorf("NumberString(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
