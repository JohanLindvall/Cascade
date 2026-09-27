package game

import (
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
)

// The gamification numbers are derived, never invented — so the derivations
// are pinned: the level curve, the titles, and the unlock edge.

func TestLevelForAndXPAtLevelAgreeAtEveryBoundary(t *testing.T) {
	for level := int64(1); level <= 50; level++ {
		floor := XPAtLevel(level)
		if got := LevelFor(floor); got != level {
			t.Errorf("xp %d should open level %d, got %d", floor, level, got)
		}
		if floor > 0 {
			if got := LevelFor(floor - 1); got != level-1 {
				t.Errorf("xp %d should still be level %d, got %d", floor-1, level-1, got)
			}
		}
	}
	if got := LevelFor(-5); got != 1 {
		t.Errorf("negative xp is level %d", got)
	}
}

func TestTitlesRankUpward(t *testing.T) {
	for level, want := range map[int64]string{1: "Newcomer", 10: "Seeder", 40: "Legend", 0: "Newcomer"} {
		if got := TitleFor(level); got != want {
			t.Errorf("TitleFor(%d) = %q, want %q", level, got, want)
		}
	}
}

func TestXPRewardsSharingOverTaking(t *testing.T) {
	upheavy := XPFor(contracts.GameStats{LifetimeUp: gib}, 0)
	downheavy := XPFor(contracts.GameStats{LifetimeDown: gib}, 0)
	if upheavy <= downheavy {
		t.Fatalf("uploading earned %d, downloading %d", upheavy, downheavy)
	}
}

func contains(ids []string, id string) bool {
	for _, item := range ids {
		if item == id {
			return true
		}
	}
	return false
}

func TestNewlyUnlockedFiresExactlyAtTheTargetAndNeverTwice(t *testing.T) {
	if contains(NewlyUnlocked(contracts.GameStats{}, map[string]int64{}), "first-contact") {
		t.Error("first-contact unlocked before anything was added")
	}
	if !contains(NewlyUnlocked(contracts.GameStats{EverAdded: 1}, map[string]int64{}), "first-contact") {
		t.Error("first-contact did not unlock at its target")
	}
	if contains(NewlyUnlocked(contracts.GameStats{EverAdded: 1}, map[string]int64{"first-contact": 123}), "first-contact") {
		t.Error("first-contact unlocked twice")
	}
	if ids := NewlyUnlocked(contracts.GameStats{}, nil); ids == nil || len(ids) != 0 {
		t.Errorf("nothing earned gave %#v, want an empty list", ids)
	}
}

func TestBuildStateCarriesEveryAchievementWithSaneProgress(t *testing.T) {
	game := BuildState(contracts.GameStats{LifetimeUp: gib, EverAdded: 3}, map[string]int64{"first-contact": 9}, true)
	if game.Total != len(Achievements) || game.Unlocked != 1 {
		t.Fatalf("total %d unlocked %d", game.Total, game.Unlocked)
	}
	if game.Progress < 0 || game.Progress >= 1 {
		t.Fatalf("progress %v", game.Progress)
	}
	for _, item := range game.Achievements {
		switch {
		case item.ID == "first-contact" && (item.UnlockedAt == nil || *item.UnlockedAt != 9):
			t.Errorf("first-contact unlockedAt %v", item.UnlockedAt)
		case item.ID != "first-contact" && item.UnlockedAt != nil:
			t.Errorf("%s unlocked at %d", item.ID, *item.UnlockedAt)
		}
	}
	// An unlock recorded at 0 is still an unlock, as it is in the browser.
	if got := BuildState(contracts.GameStats{}, map[string]int64{"touchdown": 0}, true); got.Unlocked != 1 {
		t.Errorf("an unlock at 0 was not counted: %d", got.Unlocked)
	}
}

func TestBuildStateLevelsFollowTheCurve(t *testing.T) {
	// 150 xp is the floor of level 2: 75 MiB uploaded is exactly that.
	game := BuildState(contracts.GameStats{LifetimeUp: 75 * mib}, nil, false)
	if game.Enabled || game.XP != 150 || game.Level != 2 || game.LevelXP != 150 || game.NextLevelXP != 600 ||
		game.Progress != 0 || game.Title != "Newcomer" {
		t.Fatalf("got %+v", game)
	}
	halfway := BuildState(contracts.GameStats{LifetimeUp: 300 * mib}, nil, true) // 600 xp: level 3
	if halfway.Level != 3 || halfway.Title != "Leecher" || halfway.Progress != 0 {
		t.Fatalf("got level %d %q progress %v", halfway.Level, halfway.Title, halfway.Progress)
	}
	partway := BuildState(contracts.GameStats{Completed: 3}, nil, true) // 300 xp of 150..600
	if want := 150.0 / 450.0; partway.Progress != want {
		t.Fatalf("progress %v, want %v", partway.Progress, want)
	}
}

func TestEveryAchievementIDIsUniqueAndHasAProgressPair(t *testing.T) {
	ids := map[string]bool{}
	for _, def := range Achievements {
		if ids[def.ID] {
			t.Errorf("%s is listed twice", def.ID)
		}
		ids[def.ID] = true
		current, target := def.Progress(contracts.GameStats{})
		if current != 0 || target <= 0 {
			t.Errorf("%s: progress %v of %v on empty stats", def.ID, current, target)
		}
	}
}

func TestEveryAchievementDeclaresTheUnitItsProgressIsMeasuredIn(t *testing.T) {
	units := map[contracts.ProgressUnit]bool{
		contracts.UnitCount: true, contracts.UnitBytes: true, contracts.UnitRate: true,
		contracts.UnitRatio: true, contracts.UnitDuration: true,
	}
	for _, def := range Achievements {
		if !units[def.Unit] {
			t.Errorf("%s: unit %q", def.ID, def.Unit)
		}
	}
	for _, item := range BuildState(contracts.GameStats{}, nil, true).Achievements {
		if item.ID == "speed-demon" && item.Unit != contracts.UnitRate {
			t.Errorf("speed-demon is measured in %q, not a rate", item.Unit) // a peak transfer rate, not a byte count
		}
	}
}

func TestBreakEvenCapsAtOne(t *testing.T) {
	for _, def := range Achievements {
		if def.ID != "break-even" {
			continue
		}
		if current, _ := def.Progress(contracts.GameStats{LifetimeUp: 3 * gib, LifetimeDown: gib}); current != 1 {
			t.Errorf("ratio 3 reads %v", current)
		}
		if current, _ := def.Progress(contracts.GameStats{LifetimeUp: gib}); current != 0 {
			t.Errorf("nothing downloaded reads %v", current)
		}
	}
}
