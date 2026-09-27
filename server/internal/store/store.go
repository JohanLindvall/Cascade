// Package store is the one JSON-backed store for everything Cascade remembers
// that rtorrent does not: UI preferences, lifetime counters and unlocked
// badges, when each torrent was first seen and its last totals, the throttle
// groups and the log scopes that have to be re-created after an rtorrent
// restart.
//
// Writes are debounced and land through a temp file plus rename, and only a
// real change may dirty the file — the list is folded in on every poll.
package store

import (
	"bytes"
	"encoding/json"
	"log"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/prefs"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	lightning "github.com/JohanLindvall/lightning/pkg/json"
)

// flushDelay is how long a change waits for company before it is written.
const flushDelay = 2 * time.Second

// seenTorrent is a torrent's last-seen totals, which the lifetime counters
// accumulate against.
type seenTorrent struct {
	Up       float64 `json:"up"`
	Down     float64 `json:"down"`
	Complete bool    `json:"complete"`
}

// data is the file's shape. Numbers are kept as the float64s JSON carries,
// so a file is written back with the values it was read with.
type data struct {
	AddedAt   map[string]float64        `json:"addedAt"`
	Throttles []contracts.ThrottleGroup `json:"throttles"`
	Stats     contracts.GameStats       `json:"stats"`
	Seen      map[string]seenTorrent    `json:"seen"`
	// Unix seconds each badge was unlocked at.
	Achievements map[string]float64 `json:"achievements"`
	// Hashes already counted as completed, kept so a re-add is not counted twice.
	EverCompleted []string          `json:"everCompleted"`
	Prefs         prefs.Preferences `json:"prefs"`
	// Log scopes raised from the UI, re-attached after every rtorrent restart
	// (which drops runtime outputs) — the same arrangement as throttles.
	LogScopes []string `json:"logScopes"`
}

func emptyData() data {
	return data{
		AddedAt:       map[string]float64{},
		Throttles:     []contracts.ThrottleGroup{},
		Seen:          map[string]seenTorrent{},
		Achievements:  map[string]float64{},
		EverCompleted: []string{},
		Prefs:         prefs.Default(),
		LogScopes:     []string{},
	}
}

// Store is safe for concurrent use: HTTP handlers and the poller call it at
// once.
type Store struct {
	file string
	// now is the clock; tests set it.
	now   func() time.Time
	delay time.Duration

	mu        sync.Mutex
	data      data
	completed map[string]bool
	dirty     bool
	timer     *time.Timer
}

// Open loads the store kept in file. A missing, unreadable or corrupt file
// starts clean, and a well-formed one keeps whatever of it is valid.
func Open(file string) *Store {
	s := &Store{file: file, now: time.Now, delay: flushDelay, data: emptyData()}
	if raw, err := os.ReadFile(file); err == nil {
		if parsed, err := parseJSON(raw); err == nil {
			s.data = restoreData(parsed)
		}
	}
	s.completed = make(map[string]bool, len(s.data.EverCompleted))
	for _, hash := range s.data.EverCompleted {
		s.completed[hash] = true
	}
	return s
}

// parseJSON decodes one JSON document as JSON.parse does: numbers too large
// for a float64 read as ±Inf rather than failing the whole file (they are
// dropped as non-finite later), and anything after the document is an error.
// lightning's decoder keeps each number as its literal, which is what lets a
// huge one fail alone.
func parseJSON(raw []byte) (any, error) {
	return lightning.DecodeAnyNumber(raw)
}

func record(value any) map[string]any {
	if m, ok := value.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}

// number reads a JSON number; ok is false for anything else.
func number(value any) (float64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func nonnegative(value any) (float64, bool) {
	f, ok := number(value)
	if !ok || math.IsInf(f, 0) || math.IsNaN(f) || f < 0 {
		return 0, false
	}
	if f == 0 {
		f = 0 // -0 is written back as 0, as JSON.stringify writes it
	}
	return f, true
}

func counters(value any) map[string]float64 {
	out := map[string]float64{}
	for key, item := range record(value) {
		if f, ok := nonnegative(item); ok {
			out[key] = f
		}
	}
	return out
}

// stringList keeps the strings of an array, de-duplicated in first-seen order.
func stringList(value any) []string {
	out := []string{}
	list, _ := value.([]any)
	seen := map[string]bool{}
	for _, item := range list {
		if text, ok := item.(string); ok && !seen[text] {
			seen[text] = true
			out = append(out, text)
		}
	}
	return out
}

// restoreData repairs a parsed file field by field: JSON can be well-formed
// while individual fields are corrupt or from an older version.
func restoreData(value any) data {
	parsed := record(value)
	restored := emptyData()

	saved := record(parsed["stats"])
	for key, field := range statFields(&restored.Stats) {
		if f, ok := nonnegative(saved[key]); ok {
			*field = f
		}
	}
	for hash, item := range record(parsed["seen"]) {
		entry := record(item)
		up, upOK := nonnegative(entry["up"])
		down, downOK := nonnegative(entry["down"])
		complete, completeOK := entry["complete"].(bool)
		if upOK && downOK && completeOK {
			restored.Seen[hash] = seenTorrent{Up: up, Down: down, Complete: complete}
		}
	}
	// By name: a repeated name takes the last valid entry's rates but keeps
	// the first one's place.
	index := map[string]int{}
	list, _ := parsed["throttles"].([]any)
	for _, item := range list {
		entry := record(item)
		name, nameOK := entry["name"].(string)
		up, upOK := number(entry["up"])
		down, downOK := number(entry["down"])
		if !nameOK || !upOK || !downOK {
			continue
		}
		group, err := normalizeThrottle(name, up, down)
		if err != nil {
			continue // Keep valid groups when another persisted entry is corrupt.
		}
		if at, ok := index[name]; ok {
			restored.Throttles[at] = group
		} else {
			index[name] = len(restored.Throttles)
			restored.Throttles = append(restored.Throttles, group)
		}
	}
	restored.AddedAt = counters(parsed["addedAt"])
	restored.Achievements = counters(parsed["achievements"])
	restored.EverCompleted = stringList(parsed["everCompleted"])
	restored.Prefs = prefs.Sanitize(prefs.Default(), record(parsed["prefs"]))
	restored.LogScopes = stringList(parsed["logScopes"])
	return restored
}

// statFields names every counter the way the file does.
func statFields(stats *contracts.GameStats) map[string]*float64 {
	return map[string]*float64{
		"lifetimeUp":   &stats.LifetimeUp,
		"lifetimeDown": &stats.LifetimeDown,
		"completed":    &stats.Completed,
		"everAdded":    &stats.EverAdded,
		"peakDownRate": &stats.PeakDownRate,
		"peakUpRate":   &stats.PeakUpRate,
		"peakPeers":    &stats.PeakPeers,
		"bestRatio":    &stats.BestRatio,
		"longestSeed":  &stats.LongestSeed,
		"maxSeeding":   &stats.MaxSeeding,
		"maxLabels":    &stats.MaxLabels,
	}
}

// scheduleFlushLocked marks the store dirty and writes it once the delay
// passes, however many changes arrive in the meantime.
func (s *Store) scheduleFlushLocked() {
	s.dirty = true
	if s.timer != nil {
		return
	}
	var timer *time.Timer
	timer = time.AfterFunc(s.delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		// An explicit Flush in the meantime has already written, and may
		// have scheduled a retry of its own.
		if s.timer != timer {
			return
		}
		s.timer = nil
		_ = s.flushLocked()
	})
	s.timer = timer
}

// Flush writes pending changes now; a failed write is retried later without
// waiting for another change.
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.flushLocked()
}

func (s *Store) flushLocked() error {
	if !s.dirty {
		return nil
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if err := s.writeLocked(); err != nil {
		log.Printf("[cascade] could not persist state to %s: %v", s.file, err)
		// Keep the unsaved state dirty and retry even if the session is idle.
		s.scheduleFlushLocked()
		return err
	}
	s.dirty = false
	return nil
}

func (s *Store) writeLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0o777); err != nil {
		return err
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(s.data); err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, bytes.TrimSuffix(encoded.Bytes(), []byte("\n")), 0o666); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// seconds turns a stored time back into whole Unix seconds; a hand-edited
// file can hold anything JSON can, so out-of-range values are held to what a
// timestamp can be.
func seconds(f float64) int64 {
	return int64(math.Min(math.Max(f, 0), validate.MaxSafeInteger))
}

// AddedAt returns the recorded add time, recording seenAt the first time a
// hash is seen.
func (s *Store) AddedAt(hash string, seenAt int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.data.AddedAt[hash]; existing != 0 {
		return seconds(existing)
	}
	s.data.AddedAt[hash] = float64(seenAt)
	s.scheduleFlushLocked()
	return seenAt
}

// Forget drops a removed torrent's bookkeeping. Its completion stays counted.
func (s *Store) Forget(hash string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, added := s.data.AddedAt[hash]
	_, seen := s.data.Seen[hash]
	if !added && !seen {
		return
	}
	delete(s.data.AddedAt, hash)
	delete(s.data.Seen, hash)
	s.scheduleFlushLocked()
}

// Prune drops bookkeeping for torrents that no longer exist.
func (s *Store) Prune(live map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for hash := range s.data.AddedAt {
		if !live[hash] {
			delete(s.data.AddedAt, hash)
			changed = true
		}
	}
	for hash := range s.data.Seen {
		if !live[hash] {
			delete(s.data.Seen, hash)
			changed = true
		}
	}
	if changed {
		s.scheduleFlushLocked()
	}
}

/* ----------------------------- preferences ----------------------------- */

// Preferences returns a copy of the UI preferences.
func (s *Store) Preferences() prefs.Preferences {
	s.mu.Lock()
	defer s.mu.Unlock()
	return copyPreferences(s.data.Prefs)
}

func copyPreferences(p prefs.Preferences) prefs.Preferences {
	p.SeenBadges = append([]string{}, p.SeenBadges...)
	if p.StatePollMs != nil {
		ms := *p.StatePollMs
		p.StatePollMs = &ms
	}
	return p
}

// UpdatePreferences merges a patch (a decoded JSON body) over the stored
// preferences, repairing what is invalid, and returns the result.
func (s *Store) UpdatePreferences(patch any) prefs.Preferences {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := prefs.Sanitize(s.data.Prefs, patch)
	before, _ := json.Marshal(s.data.Prefs)
	after, _ := json.Marshal(next)
	if !bytes.Equal(before, after) {
		s.data.Prefs = next
		s.scheduleFlushLocked()
	}
	return copyPreferences(s.data.Prefs)
}

/* ------------------------------ game state ----------------------------- */

// Stats returns the lifetime counters.
func (s *Store) Stats() contracts.GameStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Stats
}

// UnlockedAchievements returns when each unlocked badge was unlocked.
func (s *Store) UnlockedAchievements() map[string]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]int64, len(s.data.Achievements))
	for id, at := range s.data.Achievements {
		out[id] = seconds(at)
	}
	return out
}

// Unlock records a badge as unlocked at a Unix time, unless it already is.
func (s *Store) Unlock(id string, at int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data.Achievements[id]; ok {
		return
	}
	s.data.Achievements[id] = float64(at)
	s.scheduleFlushLocked()
}

// RecordTorrents folds the current torrent list into the lifetime counters.
//
// Totals are accumulated as deltas against the last seen value so that
// removing a torrent does not erase the traffic it already contributed. A
// torrent seen for the first time contributes its whole total, which credits
// an rtorrent session that predates this UI.
func (s *Store) RecordTorrents(torrents []contracts.Torrent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats := &s.data.Stats
	seeding, peers := 0.0, 0.0
	labels := map[string]bool{}
	now := float64(s.now().Unix())
	// Every poll folds the list in, so an idle session must not mark the
	// store dirty: unchanged counters used to rewrite the JSON file every
	// couple of seconds for as long as a browser was open.
	changed := false

	for _, torrent := range torrents {
		up, down := float64(torrent.UpTotal), float64(torrent.DownTotal)
		complete := torrent.Progress >= 1

		if previous, ok := s.data.Seen[torrent.Hash]; ok {
			// Totals only ever grow, but a recheck can reset one: a shrink is
			// remembered without being subtracted from the lifetime counters.
			stats.LifetimeUp += math.Max(0, up-previous.Up)
			stats.LifetimeDown += math.Max(0, down-previous.Down)
			if complete && !previous.Complete {
				s.countCompletionLocked(torrent.Hash)
			}
			if previous.Up != up || previous.Down != down || previous.Complete != complete {
				changed = true
			}
		} else {
			stats.EverAdded++
			stats.LifetimeUp += up
			stats.LifetimeDown += down
			if complete {
				s.countCompletionLocked(torrent.Hash)
			}
			changed = true
		}

		s.data.Seen[torrent.Hash] = seenTorrent{Up: up, Down: down, Complete: complete}

		if torrent.Ratio > stats.BestRatio {
			stats.BestRatio = torrent.Ratio
			changed = true
		}
		if torrent.Status == contracts.StatusSeeding {
			seeding++
		}
		peers += float64(torrent.PeersConnected)
		if torrent.Label != "" {
			labels[torrent.Label] = true
		}
		if torrent.FinishedAt > 0 && complete {
			seeded := now - float64(torrent.FinishedAt)
			// A finished torrent's seed time grows every second by definition;
			// recording it once a minute keeps the badge honest without turning
			// the clock itself into a reason to rewrite the file on every poll.
			if seeded > stats.LongestSeed+60 {
				stats.LongestSeed = seeded
				changed = true
			}
		}
	}

	if seeding > stats.MaxSeeding {
		stats.MaxSeeding = seeding
		changed = true
	}
	if peers > stats.PeakPeers {
		stats.PeakPeers = peers
		changed = true
	}
	if n := float64(len(labels)); n > stats.MaxLabels {
		stats.MaxLabels = n
		changed = true
	}
	if changed {
		s.scheduleFlushLocked()
	}
}

// countCompletionLocked counts a finished torrent once, even if it is later
// removed and re-added.
func (s *Store) countCompletionLocked(hash string) {
	if s.completed[hash] {
		return
	}
	s.completed[hash] = true
	s.data.EverCompleted = append(s.data.EverCompleted, hash)
	s.data.Stats.Completed++
}

// RecordRates folds a rate sample into the peak counters.
func (s *Store) RecordRates(down, up float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats := &s.data.Stats
	changed := false
	if down > stats.PeakDownRate {
		stats.PeakDownRate = down
		changed = true
	}
	if up > stats.PeakUpRate {
		stats.PeakUpRate = up
		changed = true
	}
	if changed {
		s.scheduleFlushLocked()
	}
}

/* ------------------------ re-applied on reconnect ----------------------- */

// LogScopes returns the log scopes raised from the UI.
func (s *Store) LogScopes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.data.LogScopes...)
}

// SetLogScopes replaces the log scopes raised from the UI.
func (s *Store) SetLogScopes(scopes []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slices.Equal(scopes, s.data.LogScopes) {
		return
	}
	s.data.LogScopes = append([]string{}, scopes...)
	s.scheduleFlushLocked()
}

// Throttles returns the saved throttle groups, in the order they were created.
func (s *Store) Throttles() []contracts.ThrottleGroup {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]contracts.ThrottleGroup{}, s.data.Throttles...)
}

// UpsertThrottle saves a group by name, as given: the service normalizes a
// group before rtorrent sees it, and saves what rtorrent accepted.
func (s *Store) UpsertThrottle(group contracts.ThrottleGroup) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := slices.IndexFunc(s.data.Throttles, func(item contracts.ThrottleGroup) bool { return item.Name == group.Name })
	if at >= 0 {
		if previous := s.data.Throttles[at]; previous.Up == group.Up && previous.Down == group.Down {
			return
		}
		s.data.Throttles[at] = group
	} else {
		s.data.Throttles = append(s.data.Throttles, group)
	}
	s.scheduleFlushLocked()
}

// RemoveThrottle forgets a group.
func (s *Store) RemoveThrottle(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := slices.DeleteFunc(slices.Clone(s.data.Throttles), func(item contracts.ThrottleGroup) bool { return item.Name == name })
	if len(kept) == len(s.data.Throttles) {
		return
	}
	s.data.Throttles = kept
	s.scheduleFlushLocked()
}
