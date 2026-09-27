// Package prefs is the UI preference schema and its repair, applied to both
// the persisted state and every PATCH /api/prefs body. The browser keeps the
// same schema in web/src/preferences.ts for its first-paint cache; keep the
// two in step.
//
// Sanitize works on the decoded JSON as the browser's copy works on its
// objects, with the same JavaScript number semantics, so a value the browser
// accepts is the value the server stores.
package prefs

import (
	"encoding/json"
	"math"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// Themes are the theme modes the UI knows.
var Themes = []string{"system", "light", "dark", "retro", "blackmetal"}

// SortKeys are the columns the torrent list can sort by.
var SortKeys = []string{
	"name", "size", "progress", "status", "downRate", "upRate", "ratio", "eta", "peers", "addedAt", "label",
}

const (
	DetailHeightMin = 140
	DetailHeightMax = 2000
	// How often the state may be read, ms: faster than a tenth of a second
	// shows nothing new and costs rtorrent.
	StatePollMsMin = 100
	StatePollMsMax = 60_000
)

// seenBadgesMax caps the badge ids remembered as already toasted.
const seenBadgesMax = 200

// Preferences are the UI's settings, kept server-side so every browser
// shows the same ones.
type Preferences struct {
	Theme        string `json:"theme"`
	SortKey      string `json:"sortKey"`
	SortDir      string `json:"sortDir"`
	DetailHeight int    `json:"detailHeight"`
	// Badge ids the user has already been shown a toast for.
	SeenBadges []string `json:"seenBadges"`
	// How often the state is read, ms; nil leaves it to CASCADE_STATE_POLL_MS.
	StatePollMs *int `json:"statePollMs"`
}

// Default returns the preferences of a fresh install.
func Default() Preferences {
	return Preferences{
		Theme: "system", SortKey: "addedAt", SortDir: "desc", DetailHeight: 280,
		SeenBadges: []string{}, StatePollMs: nil,
	}
}

// IsTheme reports whether v names a theme mode.
func IsTheme(v any) bool {
	s, ok := v.(string)
	return ok && slices.Contains(Themes, s)
}

// IsSortKey reports whether v names a sortable column.
func IsSortKey(v any) bool {
	s, ok := v.(string)
	return ok && slices.Contains(SortKeys, s)
}

// Sanitize merges a patch over the current values, repairing invalid fields
// without retaining unknown keys. The patch is a decoded JSON body; anything
// but an object is an empty patch.
func Sanitize(current Preferences, patch any) Preferences {
	raw, _ := patch.(map[string]any)
	// The merge is {...current, ...raw}: a key the patch carries wins even
	// when its value is null, which then repairs to the default below.
	merged := func(key string, fallback any) any {
		if value, ok := raw[key]; ok {
			return value
		}
		return fallback
	}
	var currentPoll any
	if current.StatePollMs != nil {
		currentPoll = float64(*current.StatePollMs)
	}
	badges := make([]any, len(current.SeenBadges))
	for i, id := range current.SeenBadges {
		badges[i] = id
	}

	next := Default()
	if theme := merged("theme", current.Theme); IsTheme(theme) {
		next.Theme = theme.(string)
	}
	if key := merged("sortKey", current.SortKey); IsSortKey(key) {
		next.SortKey = key.(string)
	}
	if merged("sortDir", current.SortDir) == "asc" {
		next.SortDir = "asc"
	}
	if height := numeric(merged("detailHeight", float64(current.DetailHeight))); isFinite(height) {
		next.DetailHeight = int(clamp(round(height), DetailHeightMin, DetailHeightMax))
	}
	if list, ok := merged("seenBadges", badges).([]any); ok {
		// Unique ids in first-seen order, the first seenBadgesMax of them:
		// later items cannot change those, so a huge body stops early.
		seen := make(map[string]bool)
		for _, item := range list {
			if len(next.SeenBadges) == seenBadgesMax {
				break
			}
			var id string
			switch v := item.(type) {
			case string:
				id = v
			case float64:
				id = NumberString(v)
			case json.Number:
				id = NumberString(Number(v.String()))
			default:
				continue
			}
			if !seen[id] {
				seen[id] = true
				next.SeenBadges = append(next.SeenBadges, id)
			}
		}
	}
	// Anything that is not a number, null included, means "the server's default".
	if poll := numeric(merged("statePollMs", currentPoll)); isFinite(poll) {
		ms := int(clamp(round(poll), StatePollMsMin, StatePollMsMax))
		next.StatePollMs = &ms
	}
	return next
}

// Normalize repairs a whole preferences object, as read from a file or a cache.
func Normalize(v any) Preferences {
	return Sanitize(Default(), v)
}

// numeric reads a number the way the browser's copy does: numbers as they
// are, non-blank strings through Number(), and everything else as NaN.
func numeric(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case json.Number:
		return Number(v.String())
	case string:
		if strings.TrimFunc(v, isJSSpace) != "" {
			return Number(v)
		}
	}
	return math.NaN()
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func clamp(f, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, f)) }

// round is Math.round: the nearest integer, halves toward +Infinity.
func round(f float64) float64 {
	floor := math.Floor(f)
	if f-floor >= 0.5 {
		return floor + 1
	}
	return floor
}

// isJSSpace is the whitespace String.prototype.trim and Number() strip:
// WhiteSpace and LineTerminator, which unicode.IsSpace does not match
// exactly (it adds U+0085 and lacks U+FEFF).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\u2028', '\u2029', '\uFEFF':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

var (
	decimalLiteral = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)
	radixLiteral   = regexp.MustCompile(`^0([xXoObB])([0-9a-fA-F]+)$`)
)

// Number converts a string the way JavaScript's Number() does: surrounding
// whitespace ignored, "" is 0, decimal and exponent forms, unsigned 0x/0o/0b
// integers, and Infinity; anything else is NaN.
func Number(s string) float64 {
	s = strings.TrimFunc(s, isJSSpace)
	switch s {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if m := radixLiteral.FindStringSubmatch(s); m != nil {
		base := 16
		switch m[1] {
		case "o", "O":
			base = 8
		case "b", "B":
			base = 2
		}
		n, ok := new(big.Int).SetString(m[2], base)
		if !ok {
			return math.NaN()
		}
		f, _ := new(big.Float).SetInt(n).Float64()
		return f
	}
	if !decimalLiteral.MatchString(s) {
		return math.NaN()
	}
	// The literal is validated, so the only error left is a range one, and
	// ParseFloat then answers the ±Inf or 0 that JavaScript would.
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

// NumberString formats a number as JavaScript's String(n) does: the shortest
// digits that round-trip, positional from 1e-6 up to 1e21 and exponential
// (1e+21, 1.5e-7) outside that.
func NumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// 'e' with precision -1 gives the shortest round-trip digits: d.ddde±x.
	mantissa, exponent, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exp, _ := strconv.Atoi(exponent)
	k, n := len(digits), exp+1 // digits × 10^(n−k) is the value
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	e := strconv.Itoa(abs(n - 1))
	if k == 1 {
		return sign + digits + "e" + expSign + e
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + e
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
