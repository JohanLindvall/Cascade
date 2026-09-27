package httpapi

import (
	"context"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// Service is what the HTTP layer needs from the application. The real one is
// *service.Service; the tests hand in a stub that records what it was asked,
// so the HTTP contract is tested without rtorrent underneath.
type Service interface {
	// Ready reports whether rtorrent has answered the capability probe.
	Ready() bool
	EnsureCapabilities(ctx context.Context) error
	MethodNames() []string
	BackendSummary() contracts.BackendSummary

	State(ctx context.Context) (contracts.StateResponse, error)
	Status(ctx context.Context) (contracts.GlobalStatus, error)
	Torrents(ctx context.Context, view string) ([]contracts.Torrent, error)
	Game() contracts.GameState
	Files(ctx context.Context, hash string) ([]contracts.TorrentFile, error)
	Peers(ctx context.Context, hash string) ([]contracts.Peer, error)
	Trackers(ctx context.Context, hash string) ([]contracts.Tracker, error)
	TrackerHosts(ctx context.Context, hashes []string) (map[string]string, error)

	AddTorrentFile(ctx context.Context, data []byte, options contracts.LoadOptions) error
	AddTorrentURL(ctx context.Context, url string, options contracts.LoadOptions) error
	Action(ctx context.Context, hash, action string) error
	Remove(ctx context.Context, hash string, deleteData bool) error
	SetPriority(ctx context.Context, hash string, priority int64) error
	SetLabel(ctx context.Context, hash, label string) error
	SetTorrentThrottle(ctx context.Context, hash, name string) error
	// A nil count is left as it is.
	SetTorrentSlots(ctx context.Context, hash string, uploads, downloads *int64) error
	SetDirectory(ctx context.Context, hash, directory string) error
	SetFilePriority(ctx context.Context, hash string, index int, priority int64) error
	SetTrackerEnabled(ctx context.Context, hash string, index int, enabled bool) error
	AddTracker(ctx context.Context, hash, url string, group int64) error

	Settings(ctx context.Context) (map[string]any, error)
	UpdateSettings(ctx context.Context, patch any) error

	SaveThrottle(ctx context.Context, group contracts.ThrottleGroup) error
	// A nil rate is left as it is.
	PatchThrottle(ctx context.Context, name string, up, down *int64) error
	DeleteThrottle(ctx context.Context, name string) error
	ThrottleRates(ctx context.Context) (map[string]contracts.ThrottleRate, error)

	Log(ctx context.Context, lines int) ([]string, error)
	LogScopes() contracts.LogScopeState
	SetLogScopes(ctx context.Context, scopes []string) (contracts.LogScopeChange, error)

	// Client is rtorrent itself, for the raw RPC console and /RPC2.
	Client() rtorrent.Client
}
