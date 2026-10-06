// SPDX-License-Identifier: MIT

// Package game is the light gamification layer: lifetime stats distilled into
// a level and a set of badges. Everything is derived from real rtorrent
// numbers — nothing here is invented, and the whole feature can be switched
// off with CASCADE_GAMIFY=0.
//
// The black metal theme re-carves every badge and title client-side
// (web/src/grim.ts), checked against web/src/game-catalog.json, which a test
// here keeps in step with these tables.
package game

import (
	"math"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
)

// Def is one badge: what it is called and how far along the stats are.
type Def struct {
	ID          string
	Title       string
	Description string
	Tier        contracts.Tier
	Icon        string
	// How the UI formats the progress, rather than guessing from the id.
	Unit contracts.ProgressUnit
	// Progress reports where the stats stand; unlocked once current >= target.
	Progress func(contracts.GameStats) (current, target float64)
}

const (
	mib = 1024 * 1024
	gib = 1024 * mib
	tib = 1024 * gib
	day = 24 * 60 * 60
)

// Achievements are the badges, in the order the UI lists them.
var Achievements = []Def{
	{
		ID: "first-contact", Title: "First Contact", Description: "Add your first torrent",
		Tier: contracts.Bronze, Icon: "download", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.EverAdded, 1 },
	},
	{
		ID: "touchdown", Title: "Touchdown", Description: "Finish your first download",
		Tier: contracts.Bronze, Icon: "target", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.Completed, 1 },
	},
	{
		ID: "serial-downloader", Title: "Serial Downloader", Description: "Finish 10 downloads",
		Tier: contracts.Silver, Icon: "target", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.Completed, 10 },
	},
	{
		ID: "century", Title: "Century", Description: "Finish 100 downloads",
		Tier: contracts.Gold, Icon: "trophy", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.Completed, 100 },
	},
	{
		ID: "gigabyte-club", Title: "Gigabyte Club", Description: "Download 1 GiB",
		Tier: contracts.Bronze, Icon: "download", Unit: contracts.UnitBytes,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.LifetimeDown, gib },
	},
	{
		ID: "terabyte-club", Title: "Terabyte Club", Description: "Download 1 TiB",
		Tier: contracts.Gold, Icon: "trophy", Unit: contracts.UnitBytes,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.LifetimeDown, tib },
	},
	{
		ID: "giving-back", Title: "Giving Back", Description: "Upload 1 GiB",
		Tier: contracts.Bronze, Icon: "upload", Unit: contracts.UnitBytes,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.LifetimeUp, gib },
	},
	{
		ID: "pillar-of-the-swarm", Title: "Pillar of the Swarm", Description: "Upload 100 GiB",
		Tier: contracts.Gold, Icon: "medal", Unit: contracts.UnitBytes,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.LifetimeUp, 100 * gib },
	},
	{
		ID: "break-even", Title: "Break Even", Description: "Reach a lifetime ratio of 1.00",
		Tier: contracts.Silver, Icon: "star", Unit: contracts.UnitRatio,
		Progress: func(s contracts.GameStats) (float64, float64) {
			if s.LifetimeDown > 0 {
				return math.Min(1, s.LifetimeUp/s.LifetimeDown), 1
			}
			return 0, 1
		},
	},
	{
		ID: "overachiever", Title: "Overachiever", Description: "Seed a single torrent to a ratio of 5.00",
		Tier: contracts.Silver, Icon: "star", Unit: contracts.UnitRatio,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.BestRatio, 5 },
	},
	{
		ID: "seed-farm", Title: "Seed Farm", Description: "Seed 10 torrents at once",
		Tier: contracts.Silver, Icon: "upload", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.MaxSeeding, 10 },
	},
	{
		ID: "swarm-master", Title: "Swarm Master", Description: "Hold 50 peer connections at once",
		Tier: contracts.Silver, Icon: "users", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.PeakPeers, 50 },
	},
	{
		ID: "speed-demon", Title: "Speed Demon", Description: "Hit 10 MiB/s of download",
		Tier: contracts.Silver, Icon: "bolt", Unit: contracts.UnitRate,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.PeakDownRate, 10 * mib },
	},
	{
		ID: "curator", Title: "Curator", Description: "Organise torrents under 5 labels",
		Tier: contracts.Bronze, Icon: "tag", Unit: contracts.UnitCount,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.MaxLabels, 5 },
	},
	{
		ID: "marathon", Title: "Marathon Seeder", Description: "Keep a torrent seeding for 7 days",
		Tier: contracts.Gold, Icon: "clock", Unit: contracts.UnitDuration,
		Progress: func(s contracts.GameStats) (float64, float64) { return s.LongestSeed, 7 * day },
	},
}

/* --------------------------------- levels -------------------------------- */

// maxXP bounds XP to what the browser's numbers carry exactly; a hand-edited
// state file can hold any finite count, and past this the level curve would
// overflow.
const maxXP = 1<<53 - 1

// XPFor weights XP towards uploading: sharing is the part worth rewarding.
func XPFor(stats contracts.GameStats, unlockedCount int) int64 {
	xp := math.Floor(
		stats.LifetimeUp/mib*2 +
			stats.LifetimeDown/mib*0.5 +
			stats.Completed*100 +
			float64(unlockedCount)*250,
	)
	return int64(math.Min(xp, maxXP))
}

const levelStep = 150

// LevelFor is the level an amount of XP has reached, 1 at the least.
func LevelFor(xp int64) int64 {
	return int64(math.Floor(math.Sqrt(math.Max(0, float64(xp))/levelStep))) + 1
}

// XPAtLevel is the XP a level opens at.
func XPAtLevel(level int64) int64 {
	steps := max(1, level) - 1
	return levelStep * steps * steps
}

// Title is the name a level earns from From upwards.
type Title struct {
	From int64
	Name string
}

// Titles are the level titles, highest threshold first.
var Titles = []Title{
	{40, "Legend"},
	{30, "Torrent Warden"},
	{22, "Swarm Keeper"},
	{15, "Archivist"},
	{10, "Seeder"},
	{6, "Sharer"},
	{3, "Leecher"},
	{1, "Newcomer"},
}

// TitleFor names a level.
func TitleFor(level int64) string {
	for _, title := range Titles {
		if level >= title.From {
			return title.Name
		}
	}
	return "Newcomer"
}

// BuildState is the game as the UI shows it: every badge with its progress
// and unlock time, and the level the stats have reached.
func BuildState(stats contracts.GameStats, unlockedAt map[string]int64, enabled bool) contracts.GameState {
	achievements := make([]contracts.Achievement, 0, len(Achievements))
	unlocked := 0
	for _, def := range Achievements {
		current, target := def.Progress(stats)
		item := contracts.Achievement{
			ID: def.ID, Title: def.Title, Description: def.Description, Tier: def.Tier,
			Icon: def.Icon, Unit: def.Unit, Current: current, Target: target,
		}
		if at, ok := unlockedAt[def.ID]; ok {
			item.UnlockedAt = &at
			unlocked++
		}
		achievements = append(achievements, item)
	}

	xp := XPFor(stats, unlocked)
	level := LevelFor(xp)
	levelXP := XPAtLevel(level)
	nextLevelXP := XPAtLevel(level + 1)
	progress := 0.0
	if nextLevelXP > levelXP {
		progress = float64(xp-levelXP) / float64(nextLevelXP-levelXP)
	}

	return contracts.GameState{
		Enabled:      enabled,
		XP:           xp,
		Level:        level,
		Title:        TitleFor(level),
		LevelXP:      levelXP,
		NextLevelXP:  nextLevelXP,
		Progress:     progress,
		Stats:        stats,
		Unlocked:     unlocked,
		Total:        len(achievements),
		Achievements: achievements,
	}
}

// NewlyUnlocked lists the ids whose progress has reached the target but that
// are not yet recorded.
func NewlyUnlocked(stats contracts.GameStats, unlockedAt map[string]int64) []string {
	ids := []string{}
	for _, def := range Achievements {
		if _, done := unlockedAt[def.ID]; done {
			continue
		}
		if current, target := def.Progress(stats); current >= target {
			ids = append(ids, def.ID)
		}
	}
	return ids
}
