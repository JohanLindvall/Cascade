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
	"slices"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
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

// Equal reports whether two sets of preferences say the same thing.
func (p Preferences) Equal(q Preferences) bool {
	samePoll := p.StatePollMs == nil && q.StatePollMs == nil ||
		p.StatePollMs != nil && q.StatePollMs != nil && *p.StatePollMs == *q.StatePollMs
	return p.Theme == q.Theme && p.SortKey == q.SortKey && p.SortDir == q.SortDir &&
		p.DetailHeight == q.DetailHeight && slices.Equal(p.SeenBadges, q.SeenBadges) && samePoll
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
		next.DetailHeight = int(clamp(jsnum.Round(height), DetailHeightMin, DetailHeightMax))
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
				id = jsnum.Format(v)
			case json.Number:
				id = jsnum.Format(jsnum.Parse(v.String()))
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
		ms := int(clamp(jsnum.Round(poll), StatePollMsMin, StatePollMsMax))
		next.StatePollMs = &ms
	}
	return next
}

// Normalize repairs a whole preferences object, as read from a file or a cache.
func Normalize(v any) Preferences {
	return Sanitize(Default(), v)
}

// numeric reads a number the way the browser's copy does: numbers as they
// are, non-blank strings through jsnum.Parse(), and everything else as NaN.
func numeric(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case json.Number:
		return jsnum.Parse(v.String())
	case string:
		if strings.TrimFunc(v, jsnum.IsSpace) != "" {
			return jsnum.Parse(v)
		}
	}
	return math.NaN()
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func clamp(f, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, f)) }
