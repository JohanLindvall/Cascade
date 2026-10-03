package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/prefs"
)

// The store holds everything Cascade remembers, and its two hard rules are
// pinned here: lifetime counters accumulate as deltas (removal erases
// nothing, re-adding double-counts nothing), and an idle poll must not dirty
// the file — unchanged counters used to rewrite the JSON every two seconds
// for as long as a browser was open.

var hashA = strings.Repeat("A", 40)

// tempStore opens a store on a file nobody else touches, and stops its
// pending write when the test ends so it cannot land after the directory
// has gone.
func tempStore(t *testing.T) (*Store, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "state.json")
	s := Open(file)
	t.Cleanup(func() { stopTimer(s) })
	return s, file
}

func stopTimer(s *Store) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

func torrent(over func(*contracts.Torrent)) contracts.Torrent {
	item := contracts.Torrent{Hash: hashA, Status: contracts.StatusDownloading}
	if over != nil {
		over(&item)
	}
	return item
}

func exists(t *testing.T, file string) bool {
	t.Helper()
	_, err := os.Stat(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func mustFlush(t *testing.T, s *Store) {
	t.Helper()
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
}

func TestTotalsAccumulateAsDeltasAndSurviveRemoval(t *testing.T) {
	s, _ := tempStore(t)
	s.RecordTorrents([]contracts.Torrent{torrent(func(x *contracts.Torrent) { x.UpTotal, x.DownTotal = 100, 50 })})
	if got := s.Stats().LifetimeUp; got != 100 {
		t.Fatalf("first sight credited %v, want the whole total", got)
	}
	s.RecordTorrents([]contracts.Torrent{torrent(func(x *contracts.Torrent) { x.UpTotal, x.DownTotal = 150, 75 })})
	if stats := s.Stats(); stats.LifetimeUp != 150 || stats.LifetimeDown != 75 {
		t.Fatalf("got %+v", stats)
	}
	s.Forget(hashA)
	if got := s.Stats().LifetimeUp; got != 150 {
		t.Fatalf("removal erased traffic: %v", got)
	}
	// Re-added: its totals are "new" again, which credits a fresh session once.
	s.RecordTorrents([]contracts.Torrent{torrent(func(x *contracts.Torrent) { x.UpTotal = 10 })})
	if got := s.Stats().LifetimeUp; got != 160 {
		t.Fatalf("got %v", got)
	}
}

func TestACompletionIsCountedOnceEvenAcrossRemoveAndReAdd(t *testing.T) {
	s, _ := tempStore(t)
	done := torrent(func(x *contracts.Torrent) { x.Progress = 1 })
	s.RecordTorrents([]contracts.Torrent{done})
	if got := s.Stats().Completed; got != 1 {
		t.Fatalf("completed %v", got)
	}
	s.Forget(hashA)
	s.RecordTorrents([]contracts.Torrent{done})
	if got := s.Stats().Completed; got != 1 {
		t.Fatalf("a re-add counted again: %v", got)
	}
}

func TestAnUnchangedPollDoesNotReDirtyTheFile(t *testing.T) {
	s, file := tempStore(t)
	list := []contracts.Torrent{torrent(func(x *contracts.Torrent) {
		x.UpTotal, x.Status, x.PeersConnected, x.Label = 5, contracts.StatusSeeding, 2, "tv"
	})}
	s.RecordTorrents(list)
	mustFlush(t, s)
	if !exists(t, file) {
		t.Fatal("the first fold was not written")
	}
	os.Remove(file)
	// The same numbers again: nothing moved, so nothing to write.
	s.RecordTorrents(list)
	mustFlush(t, s)
	if exists(t, file) {
		t.Fatal("an idle poll rewrote the state file")
	}
	// But a real movement dirties it again.
	s.RecordTorrents([]contracts.Torrent{torrent(func(x *contracts.Torrent) { x.UpTotal, x.Status = 6, contracts.StatusSeeding })})
	mustFlush(t, s)
	if !exists(t, file) {
		t.Fatal("a real change was not written")
	}
}

func TestTheSeedClockMovesTheFileOnlyOnceAMinute(t *testing.T) {
	s, file := tempStore(t)
	now := time.Unix(10_000, 0)
	s.now = func() time.Time { return now }
	list := []contracts.Torrent{torrent(func(x *contracts.Torrent) { x.Progress, x.FinishedAt = 1, 1_000 })}
	s.RecordTorrents(list)
	mustFlush(t, s)
	if got := s.Stats().LongestSeed; got != 9_000 {
		t.Fatalf("longest seed %v", got)
	}
	os.Remove(file)
	now = now.Add(60 * time.Second) // exactly a minute longer: not yet
	s.RecordTorrents(list)
	mustFlush(t, s)
	if exists(t, file) || s.Stats().LongestSeed != 9_000 {
		t.Fatalf("the seed clock dirtied the file within a minute (%v)", s.Stats().LongestSeed)
	}
	now = now.Add(time.Second)
	s.RecordTorrents(list)
	mustFlush(t, s)
	if !exists(t, file) || s.Stats().LongestSeed != 9_061 {
		t.Fatalf("a minute and a second later: %v", s.Stats().LongestSeed)
	}
}

func TestAddedAtRecordsFirstSightAndThenHoldsStill(t *testing.T) {
	s, _ := tempStore(t)
	hash := strings.Repeat("B", 40)
	if got := s.AddedAt(hash, 1000); got != 1000 {
		t.Fatalf("got %d", got)
	}
	if got := s.AddedAt(hash, 2000); got != 1000 {
		t.Fatalf("got %d", got)
	}
	// A recorded 0 is no time at all, and is recorded afresh.
	zero := strings.Repeat("0", 40)
	s.AddedAt(zero, 0)
	if got := s.AddedAt(zero, 5); got != 5 {
		t.Fatalf("got %d", got)
	}
}

func TestPruneDropsBookkeepingForVanishedTorrentsOnly(t *testing.T) {
	s, _ := tempStore(t)
	c, d := strings.Repeat("C", 40), strings.Repeat("D", 40)
	s.AddedAt(c, 1)
	s.AddedAt(d, 2)
	s.Prune(map[string]bool{c: true})
	if got := s.AddedAt(c, 9); got != 1 {
		t.Fatalf("a live torrent was pruned: %d", got)
	}
	if got := s.AddedAt(d, 9); got != 9 {
		t.Fatalf("a vanished torrent kept its time: %d", got)
	}
}

func TestTheFileSurvivesARoundTrip(t *testing.T) {
	s, file := tempStore(t)
	s.UpsertThrottle(contracts.ThrottleGroup{Name: "slow", Up: 1024, Down: 2048})
	s.Unlock("first-contact", 42)
	s.UpdatePreferences(map[string]any{"theme": "dark"})
	mustFlush(t, s)
	reloaded := Open(file)
	if got := reloaded.Throttles(); !reflect.DeepEqual(got, []contracts.ThrottleGroup{{Name: "slow", Up: 1024, Down: 2048}}) {
		t.Fatalf("throttles %+v", got)
	}
	if got := reloaded.UnlockedAchievements()["first-contact"]; got != 42 {
		t.Fatalf("unlocked at %d", got)
	}
	if got := reloaded.Preferences().Theme; got != "dark" {
		t.Fatalf("theme %q", got)
	}
}

func TestLogScopesPersistAndSurviveAReload(t *testing.T) {
	s, file := tempStore(t)
	if got := s.LogScopes(); got == nil || len(got) != 0 {
		t.Fatalf("got %#v", got)
	}
	s.SetLogScopes([]string{"debug", "tracker_debug"})
	mustFlush(t, s)
	if got := Open(file).LogScopes(); !reflect.DeepEqual(got, []string{"debug", "tracker_debug"}) {
		t.Fatalf("got %#v", got)
	}
}

func TestACorruptFileStartsCleanInsteadOfCrashing(t *testing.T) {
	for _, content := range []string{"{not json", `{"stats":{"lifetimeUp":5}} trailing`, `{} {}`, "\ufeff{}", ""} {
		file := filepath.Join(t.TempDir(), "state.json")
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		s := Open(file)
		if s.Stats().LifetimeUp != 0 || len(s.Throttles()) != 0 || !reflect.DeepEqual(s.Preferences(), prefs.Default()) {
			t.Errorf("%q did not start clean", content)
		}
		// The next write must not destroy the only copy of what it held.
		if kept, err := os.ReadFile(file + ".corrupt"); err != nil || string(kept) != content {
			t.Errorf("%q was not kept aside: %q %v", content, kept, err)
		}
		if exists(t, file) {
			t.Errorf("%q is still in place", content)
		}
	}
	// A directory in its place starts clean too, and is left where it is.
	dir := t.TempDir()
	if s := Open(dir); s.Stats().LifetimeUp != 0 {
		t.Error("a directory did not start clean")
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() || exists(t, dir+".corrupt") {
		t.Error("a directory in the state file's place was moved")
	}
}

func TestASecondCorruptFileDoesNotReplaceTheFirstOneKeptAside(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	first := `{"stats":{"lifetimeUp":123456789}`
	if err := os.WriteFile(file, []byte(first), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Open(file)
	// The clean start writes a fresh file, and the same fault spoils it too.
	s.AddedTimes([]string{hashA}, 100)
	mustFlush(t, s)
	for _, content := range []string{"{garbage", "{worse"} {
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		Open(file)
	}
	for aside, want := range map[string]string{".corrupt": first, ".corrupt.1": "{garbage", ".corrupt.2": "{worse"} {
		if kept, err := os.ReadFile(file + aside); err != nil || string(kept) != want {
			t.Errorf("%s holds %q (%v), want %q", aside, kept, err, want)
		}
	}
}

func TestAddedTimesRecordsNewHashesAndKeepsKnownOnes(t *testing.T) {
	s, file := tempStore(t)
	hashB := strings.Repeat("B", 40)
	if got := s.AddedTimes([]string{hashA, hashB}, 100); !reflect.DeepEqual(got, []int64{100, 100}) {
		t.Fatalf("first sighting %v", got)
	}
	if got := s.AddedTimes([]string{hashB, hashA, ""}, 200); !reflect.DeepEqual(got, []int64{100, 100, 0}) {
		t.Fatalf("second sighting %v", got)
	}
	mustFlush(t, s)
	_ = os.Remove(file)
	// Nothing new: the same listing again must not dirty the store.
	s.AddedTimes([]string{hashA, hashB}, 300)
	mustFlush(t, s)
	if exists(t, file) {
		t.Fatal("an unchanged listing rewrote the state file")
	}
	if _, recorded := s.data.AddedAt[""]; recorded {
		t.Fatal("an empty hash was recorded")
	}
}

func TestAWriteIsSyncedIntoPlaceAndLeavesNoTempFile(t *testing.T) {
	s, file := tempStore(t)
	s.SetLogScopes([]string{"debug"})
	mustFlush(t, s)
	if exists(t, file+".tmp") {
		t.Fatal("the temp file was left behind")
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm()&0o600 != 0o600 {
		t.Fatalf("mode %v %v", info.Mode(), err)
	}
	// A failed write keeps the state dirty and leaves nothing half-written.
	blocked := filepath.Join(t.TempDir(), "file-not-dir")
	if err := os.WriteFile(blocked, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	broken := Open(filepath.Join(blocked, "state.json"))
	t.Cleanup(func() { stopTimer(broken) })
	broken.SetLogScopes([]string{"debug"})
	if err := broken.Flush(); err == nil {
		t.Fatal("a write under a file succeeded")
	}
	broken.mu.Lock()
	dirty := broken.dirty
	broken.mu.Unlock()
	if !dirty {
		t.Fatal("a failed write forgot the unsaved change")
	}
}

func TestATotalThatShrinksIsRememberedButNeverSubtracted(t *testing.T) {
	s, _ := tempStore(t)
	fold := func(up, down int64) {
		s.RecordTorrents([]contracts.Torrent{torrent(func(x *contracts.Torrent) { x.UpTotal, x.DownTotal = up, down })})
	}
	fold(100, 100)
	fold(40, 100) // a recheck
	if got := s.Stats().LifetimeUp; got != 100 {
		t.Fatalf("got %v", got)
	}
	// Growth from the lower baseline counts again from there.
	fold(50, 100)
	if got := s.Stats().LifetimeUp; got != 110 {
		t.Fatalf("got %v", got)
	}
}

func TestPeakRatesOnlyEverRiseAndOnlyARiseDirtiesTheFile(t *testing.T) {
	s, file := tempStore(t)
	s.RecordRates(500, 200)
	mustFlush(t, s)
	os.Remove(file)
	s.RecordRates(400, 100)
	mustFlush(t, s)
	if exists(t, file) {
		t.Fatal("a lower sample rewrote the file")
	}
	s.RecordRates(600, 100)
	mustFlush(t, s)
	if !exists(t, file) {
		t.Fatal("a new peak was not written")
	}
	if stats := s.Stats(); stats.PeakDownRate != 600 || stats.PeakUpRate != 200 {
		t.Fatalf("got %+v", stats)
	}
}

func TestThrottleGroupsUpsertByNameAndCanBeRemoved(t *testing.T) {
	s, _ := tempStore(t)
	s.UpsertThrottle(contracts.ThrottleGroup{Name: "slow", Up: 1, Down: 2})
	s.UpsertThrottle(contracts.ThrottleGroup{Name: "slow", Up: 3, Down: 4})
	s.UpsertThrottle(contracts.ThrottleGroup{Name: "fast"})
	want := []contracts.ThrottleGroup{{Name: "slow", Up: 3, Down: 4}, {Name: "fast"}}
	if got := s.Throttles(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	s.RemoveThrottle("slow")
	if got := s.Throttles(); len(got) != 1 || got[0].Name != "fast" {
		t.Fatalf("got %+v", got)
	}
}

func TestPreferencesAreSanitisedOnTheWayInAndCopiedOnTheWayOut(t *testing.T) {
	s, _ := tempStore(t)
	saved := s.UpdatePreferences(map[string]any{"theme": "chrome-vomit", "detailHeight": 5.0, "statePollMs": 900.0})
	if saved.Theme != "system" || saved.DetailHeight != 140 {
		t.Fatalf("got %+v", saved)
	}
	saved.SeenBadges = append(saved.SeenBadges, "tampered")
	*saved.StatePollMs = 1
	if got := s.Preferences(); len(got.SeenBadges) != 0 || *got.StatePollMs != 900 {
		t.Fatalf("the caller reached the stored preferences: %+v", got)
	}
}

func TestAnUnlockedBadgeKeepsItsFirstTimestamp(t *testing.T) {
	s, _ := tempStore(t)
	s.Unlock("touchdown", 10)
	s.Unlock("touchdown", 20)
	if got := s.UnlockedAchievements()["touchdown"]; got != 10 {
		t.Fatalf("got %d", got)
	}
}

func TestAFailedFlushIsRetriedWithoutAnotherMutation(t *testing.T) {
	s, file := tempStore(t)
	if err := os.Mkdir(file, 0o755); err != nil { // rename over a directory fails, even as root
		t.Fatal(err)
	}
	s.UpdatePreferences(map[string]any{"theme": "retro"})
	if err := s.Flush(); err == nil {
		t.Fatal("renaming over a directory succeeded")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	mustFlush(t, s)
	if got := Open(file).Preferences().Theme; got != "retro" {
		t.Fatalf("got %q", got)
	}
}

func TestAFailedFlushRetriesOnItsOwn(t *testing.T) {
	s, file := tempStore(t)
	s.delay = 20 * time.Millisecond
	if err := os.Mkdir(file, 0o755); err != nil {
		t.Fatal(err)
	}
	s.UpdatePreferences(map[string]any{"theme": "retro"})
	if err := s.Flush(); err == nil {
		t.Fatal("renaming over a directory succeeded")
	}
	os.Remove(file)
	waitFor(t, func() bool { return exists(t, file) })
	if got := Open(file).Preferences().Theme; got != "retro" {
		t.Fatalf("got %q", got)
	}
}

func waitFor(t *testing.T, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if done() {
			return
		}
	}
	t.Fatal("timed out")
}

func TestWritesAreDebounced(t *testing.T) {
	s, file := tempStore(t)
	s.delay = 100 * time.Millisecond
	s.Unlock("touchdown", 1)
	s.Unlock("century", 2)
	if exists(t, file) {
		t.Fatal("a change was written before the delay")
	}
	waitFor(t, func() bool { return exists(t, file) })
	if got := Open(file).UnlockedAchievements(); len(got) != 2 {
		t.Fatalf("the write carried %v", got)
	}
}

func TestValidJSONWithMalformedFieldsRepairsOnlyTheAffectedFields(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	content := `{
		"addedAt": [], "throttles": [null, {"name": "slow", "up": 1024, "down": 2048}],
		"stats": {"lifetimeUp": "bad", "completed": 7}, "seen": {"bad": null},
		"achievements": {"touchdown": 42, "broken": "no"}, "everCompleted": 42,
		"prefs": {"theme": "retro"}
	}`
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Open(file)
	t.Cleanup(func() { stopTimer(s) })
	if stats := s.Stats(); stats.LifetimeUp != 0 || stats.Completed != 7 {
		t.Fatalf("stats %+v", stats)
	}
	if got := s.Preferences().Theme; got != "retro" {
		t.Fatalf("theme %q", got)
	}
	if got := s.Throttles(); !reflect.DeepEqual(got, []contracts.ThrottleGroup{{Name: "slow", Up: 1024, Down: 2048}}) {
		t.Fatalf("throttles %+v", got)
	}
	if got := s.UnlockedAchievements(); !reflect.DeepEqual(got, map[string]int64{"touchdown": 42}) {
		t.Fatalf("achievements %v", got)
	}
	s.RecordTorrents([]contracts.Torrent{torrent(nil)})
}

func TestNumbersJSONCannotHoldAreDroppedNotTheFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	content := `{"stats": {"lifetimeUp": 1e400, "lifetimeDown": -0, "completed": -3, "everAdded": 4},
		"addedAt": {"X": 1e999, "Y": 17}, "seen": {"Z": {"up": 1, "down": 2, "complete": "yes"}},
		"logScopes": ["debug", 3, "debug", "info"], "everCompleted": ["H", "H", null]}`
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Open(file)
	t.Cleanup(func() { stopTimer(s) })
	if stats := s.Stats(); stats.LifetimeUp != 0 || stats.Completed != 0 || stats.EverAdded != 4 {
		t.Fatalf("stats %+v", stats)
	}
	if got := s.AddedAt("Y", 99); got != 17 {
		t.Fatalf("a valid add time was lost: %d", got)
	}
	if got := s.AddedAt("X", 99); got != 99 {
		t.Fatalf("an infinite add time survived: %d", got)
	}
	if got := s.LogScopes(); !reflect.DeepEqual(got, []string{"debug", "info"}) {
		t.Fatalf("log scopes %v", got)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.data.Seen) != 0 || !reflect.DeepEqual(s.data.EverCompleted, []string{"H"}) {
		t.Fatalf("seen %v, everCompleted %v", s.data.Seen, s.data.EverCompleted)
	}
}

func TestIdenticalPreferenceThrottleAndScopeWritesDoNotDirtyTheStore(t *testing.T) {
	s, file := tempStore(t)
	group := contracts.ThrottleGroup{Name: "slow", Up: 1024, Down: 2048}
	s.UpsertThrottle(group)
	s.SetLogScopes([]string{"debug"})
	s.UpdatePreferences(map[string]any{"theme": "retro"})
	mustFlush(t, s)
	os.Remove(file)
	s.UpsertThrottle(group)
	s.SetLogScopes([]string{"debug"})
	s.UpdatePreferences(map[string]any{"theme": "retro"})
	s.RemoveThrottle("missing")
	s.Forget("missing")
	s.Prune(map[string]bool{})
	mustFlush(t, s)
	if exists(t, file) {
		t.Fatal("identical writes dirtied the store")
	}
	group.Up = 99
	if got := s.Throttles()[0].Up; got != 1024 {
		t.Fatalf("the caller mutated saved state: %d", got)
	}
}

func TestSavedThrottleLimitsMigrateToRepresentableKiBRates(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	content := `{"throttles": [
		{"name": "small", "up": 1, "down": 1025},
		{"name": "bad", "up": -1, "down": 0},
		{"name": "NULL", "up": 0, "down": 0},
		{"name": "frac", "up": 1.5, "down": 0},
		{"name": "text", "up": "1024", "down": 0},
		{"name": "later", "up": 0, "down": 0},
		{"name": "small", "up": 4096, "down": 0},
		{"name": "small", "up": -5, "down": 0}
	]}`
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Open(file)
	t.Cleanup(func() { stopTimer(s) })
	// A repeated name keeps its first place and its last valid rates.
	want := []contracts.ThrottleGroup{{Name: "small", Up: 4096}, {Name: "later"}}
	if got := s.Throttles(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

// tsStateFile is a state file as the TypeScript server wrote it
// (JSON.stringify with two-space indentation), with every field in use.
const tsStateFile = `{
  "addedAt": {
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": 1790000000,
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB": 1790000500
  },
  "throttles": [
    {
      "name": "slow",
      "up": 1024,
      "down": 2048
    },
    {
      "name": "night",
      "up": 0,
      "down": 5242880
    }
  ],
  "stats": {
    "lifetimeUp": 5368709120,
    "lifetimeDown": 1073741824,
    "completed": 3,
    "everAdded": 4,
    "peakDownRate": 1048576,
    "peakUpRate": 524288,
    "peakPeers": 12,
    "bestRatio": 2.5,
    "longestSeed": 86400,
    "maxSeeding": 2,
    "maxLabels": 1
  },
  "seen": {
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": {
      "up": 5368709120,
      "down": 1073741824,
      "complete": true
    }
  },
  "achievements": {
    "first-contact": 1790000100,
    "touchdown": 1790000200
  },
  "everCompleted": [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  ],
  "prefs": {
    "theme": "blackmetal",
    "sortKey": "name",
    "sortDir": "asc",
    "detailHeight": 320,
    "seenBadges": [
      "first-contact"
    ],
    "statePollMs": 1000
  },
  "logScopes": [
    "tracker_events"
  ]
}`

func TestAStateFileWrittenByTheTypeScriptServerLoadsUnchanged(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(file, []byte(tsStateFile), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Open(file)
	t.Cleanup(func() { stopTimer(s) })

	wantStats := contracts.GameStats{
		LifetimeUp: 5368709120, LifetimeDown: 1073741824, Completed: 3, EverAdded: 4,
		PeakDownRate: 1048576, PeakUpRate: 524288, PeakPeers: 12, BestRatio: 2.5,
		LongestSeed: 86400, MaxSeeding: 2, MaxLabels: 1,
	}
	if got := s.Stats(); got != wantStats {
		t.Errorf("stats %+v", got)
	}
	if got := s.Throttles(); !reflect.DeepEqual(got, []contracts.ThrottleGroup{
		{Name: "slow", Up: 1024, Down: 2048}, {Name: "night", Down: 5242880},
	}) {
		t.Errorf("throttles %+v", got)
	}
	if got := s.UnlockedAchievements(); !reflect.DeepEqual(got, map[string]int64{"first-contact": 1790000100, "touchdown": 1790000200}) {
		t.Errorf("achievements %v", got)
	}
	poll := 1000
	wantPrefs := prefs.Preferences{
		Theme: "blackmetal", SortKey: "name", SortDir: "asc", DetailHeight: 320,
		SeenBadges: []string{"first-contact"}, StatePollMs: &poll,
	}
	if got := s.Preferences(); !reflect.DeepEqual(got, wantPrefs) {
		t.Errorf("prefs %+v", got)
	}
	if got := s.LogScopes(); !reflect.DeepEqual(got, []string{"tracker_events"}) {
		t.Errorf("log scopes %v", got)
	}
	if got := s.AddedAt(hashA, 1); got != 1790000000 {
		t.Errorf("added at %d", got)
	}
	// The seen totals are the baseline: the same list again adds nothing, and
	// the completion is not counted twice.
	s.RecordTorrents([]contracts.Torrent{torrent(func(x *contracts.Torrent) {
		x.UpTotal, x.DownTotal, x.Progress = 5368709120, 1073741824, 1
	})})
	if got := s.Stats(); got.LifetimeUp != 5368709120 || got.Completed != 3 || got.EverAdded != 4 {
		t.Errorf("the saved baseline was not used: %+v", got)
	}

	// Written back, it is the same document in the same shape, plus the one
	// change made here.
	s.Unlock("curator", 1790000300)
	mustFlush(t, s)
	written, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	if err := json.Unmarshal([]byte(tsStateFile), &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(written, &after); err != nil {
		t.Fatal(err)
	}
	before["achievements"].(map[string]any)["curator"] = 1790000300.0
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("written back as\n%s", written)
	}
	keys := regexp.MustCompile(`(?m)^  "(\w+)":`).FindAllStringSubmatch(string(written), -1)
	var order []string
	for _, key := range keys {
		order = append(order, key[1])
	}
	if want := []string{"addedAt", "throttles", "stats", "seen", "achievements", "everCompleted", "prefs", "logScopes"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("top-level keys %v", order)
	}
	if strings.HasSuffix(string(written), "\n") {
		t.Fatal("a trailing newline JSON.stringify never wrote")
	}
}

func TestAnOlderStateFileGetsTheNewFieldsDefaults(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(file, []byte(`{"prefs": {"theme": "dark", "sortKey": "size", "sortDir": "desc", "detailHeight": 280, "seenBadges": []}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Open(file)
	if got := s.Preferences(); got.Theme != "dark" || got.StatePollMs != nil {
		t.Fatalf("got %+v", got)
	}
	if got := s.LogScopes(); got == nil || len(got) != 0 {
		t.Fatalf("got %#v", got)
	}
}

func TestConcurrentUseIsSafe(t *testing.T) {
	s, file := tempStore(t)
	s.delay = time.Millisecond // so the timer's writes race the callers too
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				hash := fmt.Sprintf("%040d", j%7)
				s.RecordTorrents([]contracts.Torrent{{Hash: hash, UpTotal: int64(j), Progress: float64(j % 2), Label: fmt.Sprint(i)}})
				s.AddedAt(hash, int64(j))
				s.RecordRates(float64(j), float64(i))
				s.UpdatePreferences(map[string]any{"detailHeight": float64(200 + j)})
				s.UpsertThrottle(contracts.ThrottleGroup{Name: fmt.Sprintf("g%d", i), Up: int64(j)})
				s.SetLogScopes([]string{fmt.Sprint(j)})
				s.Unlock(fmt.Sprint(j), int64(j))
				_, _, _, _, _ = s.Throttles(), s.Preferences(), s.Stats(), s.UnlockedAchievements(), s.LogScopes()
				if j%25 == 0 {
					_ = s.Flush()
				}
				s.Prune(map[string]bool{hash: true})
				s.Forget(hash)
				s.RemoveThrottle(fmt.Sprintf("g%d", (i+1)%8))
			}
		}(i)
	}
	wg.Wait()
	mustFlush(t, s)
	if got := Open(file).Stats(); got.EverAdded == 0 {
		t.Fatalf("the written file lost the counters: %+v", got)
	}
}

func TestNormalizeThrottle(t *testing.T) {
	for _, c := range []struct {
		up, down         int64
		wantUp, wantDown int64
	}{
		{0, 0, 0, 0},
		{1, 1023, 1024, 1024}, // a positive sub-KiB limit must not become unlimited
		{1024, 1025, 1024, 2048},
		{9007199254739968, 5, 9007199254739968, 1024},
	} {
		got, err := NormalizeThrottle(contracts.ThrottleGroup{Name: "g", Up: c.up, Down: c.down})
		if err != nil || got != (contracts.ThrottleGroup{Name: "g", Up: c.wantUp, Down: c.wantDown}) {
			t.Errorf("%d/%d: %+v %v", c.up, c.down, got, err)
		}
	}
	for _, name := range []string{"slow", "null", "a.b_c-d", strings.Repeat("x", 32)} {
		if _, err := NormalizeThrottle(contracts.ThrottleGroup{Name: name}); err != nil {
			t.Errorf("%q was refused: %v", name, err)
		}
	}
	for _, name := range []string{"", "NULL", ".", "..", "a b", strings.Repeat("x", 33), "slow\n", "sl/ow", "\u00e9"} {
		_, err := NormalizeThrottle(contracts.ThrottleGroup{Name: name})
		var problem *httperr.Error
		if !errors.As(err, &problem) || problem.Status != 400 ||
			problem.Message != "throttle name must be 1-32 chars of [A-Za-z0-9_.-] and cannot be NULL, . or .." {
			t.Errorf("%q: %v", name, err)
		}
	}
	for _, c := range []struct {
		group contracts.ThrottleGroup
		want  string
	}{
		{contracts.ThrottleGroup{Name: "g", Up: -1}, `"up" must be a whole number from 0 to 9007199254739968`},
		{contracts.ThrottleGroup{Name: "g", Down: 9007199254739969}, `"down" must be a whole number from 0 to 9007199254739968`},
	} {
		_, err := NormalizeThrottle(c.group)
		var problem *httperr.Error
		if !errors.As(err, &problem) || problem.Status != 400 || problem.Message != c.want {
			t.Errorf("%+v: %v", c.group, err)
		}
	}
}
