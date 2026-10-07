// SPDX-License-Identifier: MIT

// Package contracts holds the JSON shapes the HTTP API speaks. The browser
// declares the same shapes in web/src/contracts.ts; keep the two in step.
//
// Slices that reach JSON must never be nil — a nil slice encodes as null where
// the browser expects [] — so every constructor of these starts them empty.
package contracts

// UploadResult answers POST /api/torrents/upload.
type UploadResult struct {
	Added  int      `json:"added"`
	Errors []string `json:"errors"`
	// Indices in the submitted file list / non-empty URL lines, for retrying
	// only the failures.
	FailedFiles []int `json:"failedFiles"`
	FailedURLs  []int `json:"failedUrls"`
}

// TorrentStatus is what the list shows a torrent doing.
type TorrentStatus string

const (
	StatusDownloading TorrentStatus = "downloading"
	StatusSeeding     TorrentStatus = "seeding"
	StatusPaused      TorrentStatus = "paused"
	StatusStopped     TorrentStatus = "stopped"
	StatusChecking    TorrentStatus = "checking"
	StatusError       TorrentStatus = "error"
)

type Torrent struct {
	Hash      string        `json:"hash"`
	Name      string        `json:"name"`
	Status    TorrentStatus `json:"status"`
	Progress  float64       `json:"progress"`
	Size      int64         `json:"size"`
	Completed int64         `json:"completed"`
	Left      int64         `json:"left"`
	DownRate  int64         `json:"downRate"`
	UpRate    int64         `json:"upRate"`
	DownTotal int64         `json:"downTotal"`
	UpTotal   int64         `json:"upTotal"`
	Ratio     float64       `json:"ratio"`
	// Seconds to completion; nil (null) when it cannot be estimated.
	ETA               *int64 `json:"eta"`
	Priority          int64  `json:"priority"`
	Label             string `json:"label"`
	Message           string `json:"message"`
	Directory         string `json:"directory"`
	BasePath          string `json:"basePath"`
	Throttle          string `json:"throttle"`
	IsOpen            bool   `json:"isOpen"`
	IsActive          bool   `json:"isActive"`
	IsPrivate         bool   `json:"isPrivate"`
	IsMultiFile       bool   `json:"isMultiFile"`
	IsMeta            bool   `json:"isMeta"` // a magnet still fetching its metadata (d.is_meta)
	Hashing           int64  `json:"hashing"`
	ChunkSize         int64  `json:"chunkSize"`
	ChunksDone        int64  `json:"chunksDone"`
	ChunksTotal       int64  `json:"chunksTotal"`
	PeersConnected    int64  `json:"peersConnected"`
	PeersNotConnected int64  `json:"peersNotConnected"`
	PeersComplete     int64  `json:"peersComplete"`
	TrackerCount      int64  `json:"trackerCount"`
	AddedAt           int64  `json:"addedAt"`
	StartedAt         int64  `json:"startedAt"`
	FinishedAt        int64  `json:"finishedAt"`
	CreatedAt         int64  `json:"createdAt"`
}

type TorrentFile struct {
	Index int `json:"index"`
	// The path inside the torrent, as the torrent names it.
	Path string `json:"path"`
	// The file's name on disk when it differs from the torrent's: the image's
	// libtorrent shortens names longer than Linux allows (AGENTS.md quirk 12).
	// Empty when they agree, or before the torrent has ever been opened.
	OnDisk          string  `json:"onDisk"`
	Size            int64   `json:"size"`
	CompletedChunks int64   `json:"completedChunks"`
	SizeChunks      int64   `json:"sizeChunks"`
	Priority        int64   `json:"priority"`
	Progress        float64 `json:"progress"`
	Created         bool    `json:"created"`
}

type Peer struct {
	ID string `json:"id"`
	// p.address as rtorrent answers it: an IPv6 address comes in brackets.
	Address   string  `json:"address"`
	Port      int64   `json:"port"`
	Client    string  `json:"client"`
	Progress  float64 `json:"progress"`
	UpRate    int64   `json:"upRate"`
	DownRate  int64   `json:"downRate"`
	UpTotal   int64   `json:"upTotal"`
	DownTotal int64   `json:"downTotal"`
	// What the peer is pulling from the swarm as a whole, not from us.
	PeerRate   int64 `json:"peerRate"`
	PeerTotal  int64 `json:"peerTotal"`
	Encrypted  bool  `json:"encrypted"`
	Obfuscated bool  `json:"obfuscated"`
	Incoming   bool  `json:"incoming"`
	Snubbed    bool  `json:"snubbed"`
	Preferred  bool  `json:"preferred"`
	Unwanted   bool  `json:"unwanted"`
	Banned     bool  `json:"banned"`
	// Reserved-bytes/extension string as rtorrent formats it.
	Options string `json:"options"`
}

type Tracker struct {
	Index        int    `json:"index"`
	URL          string `json:"url"`
	Type         int64  `json:"type"`
	Group        int64  `json:"group"`
	TrackerID    string `json:"trackerId"`
	Enabled      bool   `json:"enabled"`
	Usable       bool   `json:"usable"`
	Open         bool   `json:"open"`
	Busy         bool   `json:"busy"`
	Extra        bool   `json:"extra"`
	CanScrape    bool   `json:"canScrape"`
	Seeders      int64  `json:"seeders"`
	Leechers     int64  `json:"leechers"`
	Downloaded   int64  `json:"downloaded"`
	LastScrape   int64  `json:"lastScrape"`
	Scrapes      int64  `json:"scrapes"`
	Successes    int64  `json:"successes"`
	LastSuccess  int64  `json:"lastSuccess"`
	NextSuccess  int64  `json:"nextSuccess"`
	Failures     int64  `json:"failures"`
	LastFailure  int64  `json:"lastFailure"`
	NextFailure  int64  `json:"nextFailure"`
	LatestEvent  int64  `json:"latestEvent"`
	NewPeers     int64  `json:"newPeers"`
	SumPeers     int64  `json:"sumPeers"`
	Interval     int64  `json:"interval"`
	MinInterval  int64  `json:"minInterval"`
	LastActivity int64  `json:"lastActivity"`
	NextActivity int64  `json:"nextActivity"`
}

type GlobalStatus struct {
	Connected    bool   `json:"connected"`
	Error        string `json:"error,omitempty"`
	DownRate     int64  `json:"downRate"`
	UpRate       int64  `json:"upRate"`
	DownTotal    int64  `json:"downTotal"`
	UpTotal      int64  `json:"upTotal"`
	DownLimit    int64  `json:"downLimit"`
	UpLimit      int64  `json:"upLimit"`
	TorrentCount int    `json:"torrentCount"`
	ActiveCount  int    `json:"activeCount"`
	DHTNodes     int64  `json:"dhtNodes"`
	ListenPort   int64  `json:"listenPort"`
	// Free bytes on the download volume; nil (null) when it cannot be determined.
	DiskFree *int64 `json:"diskFree"`
	// rtorrent's default download directory, shown as the Add dialog's default.
	DownloadDir string `json:"downloadDir"`
	// What this server allows, so the UI stops offering what it would refuse.
	Policy Policy `json:"policy"`
	// How often the state is read for open pages, ms: the preference, else
	// StatePollDefaultMs.
	StatePollMs int `json:"statePollMs"`
	// CASCADE_STATE_POLL_MS, what "the server's default" means in the preference.
	StatePollDefaultMs int            `json:"statePollDefaultMs"`
	Backend            BackendSummary `json:"backend"`
	History            []RateSample   `json:"history"`
}

type Policy struct {
	// The API console and /RPC2.
	RawRPC bool `json:"rawRpc"`
	// Removing a torrent together with its downloaded data.
	DeleteData bool `json:"deleteData"`
}

type BackendSummary struct {
	ClientVersion  string          `json:"clientVersion"`
	LibraryVersion string          `json:"libraryVersion"`
	APIVersion     string          `json:"apiVersion"`
	Flavor         string          `json:"flavor"`
	MethodCount    int             `json:"methodCount"`
	RPCFacility    string          `json:"rpcFacility"`
	Endpoint       string          `json:"endpoint"`
	Supports       map[string]bool `json:"supports"`
}

type RateSample struct {
	T    int64 `json:"t"`
	Down int64 `json:"down"`
	Up   int64 `json:"up"`
}

// StateResponse is GET /api/state, and what the stream sends deltas of.
type StateResponse struct {
	Status    GlobalStatus    `json:"status"`
	Torrents  []Torrent       `json:"torrents"`
	Throttles []ThrottleGroup `json:"throttles"`
	Game      GameState       `json:"game"`
}

// LoadOptions are the add options the upload form and the URL body carry.
type LoadOptions struct {
	Start bool
	// Empty means rtorrent's default directory / no label.
	Directory string
	Label     string
}

type LogScopeState struct {
	// Baked into rtorrent.rc by RT_LOG_LEVEL; fixed until the container restarts.
	Boot []string `json:"boot"`
	// Raised from the UI on top of that; live, persisted, re-applied.
	Extra     []string `json:"extra"`
	Available []string `json:"available"`
	Supported bool     `json:"supported"`
}

type Tier string

const (
	Bronze Tier = "bronze"
	Silver Tier = "silver"
	Gold   Tier = "gold"
)

type ProgressUnit string

const (
	UnitCount    ProgressUnit = "count"
	UnitBytes    ProgressUnit = "bytes"
	UnitRate     ProgressUnit = "rate"
	UnitRatio    ProgressUnit = "ratio"
	UnitDuration ProgressUnit = "duration"
)

// GameStats are the lifetime counters the badges and levels derive from.
// Plain numbers, as they are persisted: bestRatio is fractional, and the
// byte counters outgrow what an int32 could hold.
type GameStats struct {
	LifetimeUp   float64 `json:"lifetimeUp"`
	LifetimeDown float64 `json:"lifetimeDown"`
	Completed    float64 `json:"completed"`
	EverAdded    float64 `json:"everAdded"`
	PeakDownRate float64 `json:"peakDownRate"`
	PeakUpRate   float64 `json:"peakUpRate"`
	PeakPeers    float64 `json:"peakPeers"`
	BestRatio    float64 `json:"bestRatio"`
	LongestSeed  float64 `json:"longestSeed"`
	MaxSeeding   float64 `json:"maxSeeding"`
	MaxLabels    float64 `json:"maxLabels"`
}

type Achievement struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Tier        Tier         `json:"tier"`
	Icon        string       `json:"icon"`
	Unit        ProgressUnit `json:"unit"`
	Current     float64      `json:"current"`
	Target      float64      `json:"target"`
	// Unix seconds; nil (null) while locked.
	UnlockedAt *int64 `json:"unlockedAt"`
}

type GameState struct {
	Enabled      bool          `json:"enabled"`
	XP           int64         `json:"xp"`
	Level        int64         `json:"level"`
	Title        string        `json:"title"`
	LevelXP      int64         `json:"levelXp"`
	NextLevelXP  int64         `json:"nextLevelXp"`
	Progress     float64       `json:"progress"`
	Stats        GameStats     `json:"stats"`
	Unlocked     int           `json:"unlocked"`
	Total        int           `json:"total"`
	Achievements []Achievement `json:"achievements"`
}

type ThrottleGroup struct {
	Name string `json:"name"`
	// Bytes per second; 0 means unlimited. rtorrent groups have KiB/s precision.
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

// ThrottleRate is a throttle group's current throughput, bytes per second.
type ThrottleRate struct {
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

// LogScopeChange answers POST /api/log/scopes: the new state, and what the
// change could not do.
type LogScopeChange struct {
	LogScopeState
	// Switched off but still attached for this rtorrent session: nothing
	// can detach a scope, so it stops only when rtorrent restarts.
	StillActive []string `json:"stillActive"`
	// Scopes this build refused.
	Failed []string `json:"failed"`
}
