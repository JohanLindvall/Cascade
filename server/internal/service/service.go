// Package service is all of Cascade's application behaviour, expressed in
// terms of rtorrent commands chosen through the capability probe.
package service

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/store"
)

// Service is Cascade's application behaviour; it implements httpapi.Service.
type Service struct {
	cfg    config.Config
	store  *store.Store
	client rtorrent.Client
	caps   *rtorrent.Capabilities

	mu      sync.Mutex
	history []contracts.RateSample
	// Scopes attached to the log during this rtorrent session. Cleared when
	// rtorrent restarts: a restarted rtorrent has forgotten them.
	attachedScopes map[string]bool
	// The rtorrent the session state above belongs to, and whether contact
	// with it was lost since (see noteSession).
	rtorrentPID string
	lostContact bool

	// The housekeeping loop (see Start); nil while stopped.
	loopMu   sync.Mutex
	loopStop context.CancelFunc
	loopDone chan struct{}

	// What rtorrent forgets on a restart, and whether it has been put back.
	bootSettingsApplied atomic.Bool
	throttlesApplied    atomic.Bool
	logScopesApplied    atomic.Bool
	lastGameUpdate      atomic.Int64 // unix milliseconds

	pendingRestarts pendingRestarts
	torrentWrites   serialTasks
	throttleWrites  serialTasks
	loads           serialTasks
	logScopeWrites  sync.Mutex
	stateRead       flight[contracts.StateResponse]
	torrentRead     flight[[]contracts.Torrent]
	disk            diskCache

	now func() time.Time
}

// New builds the service. The client defaults to the configured SCGI
// endpoint; tests pass a scripted one.
func New(cfg config.Config, st *store.Store, client rtorrent.Client) *Service {
	if client == nil {
		client = rtorrent.NewClient(cfg.SCGI, nil)
	}
	return &Service{
		cfg:    cfg,
		store:  st,
		client: client,
		caps: rtorrent.NewCapabilities(client, rtorrent.FieldLists{
			Torrent: rtorrent.TorrentFields,
			File:    rtorrent.FileFields,
			Peer:    rtorrent.PeerFields,
			Tracker: rtorrent.TrackerFields,
		}),
		history:        []contracts.RateSample{},
		attachedScopes: map[string]bool{},
		now:            time.Now,
	}
}

// detached is the context a change runs under. A caller that gives up
// halfway — a closed tab, a dropped connection — must not leave rtorrent
// half changed: a torrent stopped for a throttle change that never came, one
// erased with its data still on disk. Every call stays bounded by the SCGI
// timeout.
func detached(ctx context.Context) context.Context {
	return context.WithoutCancel(ctx)
}

// call is one command; a nil params list still goes out as an empty one.
func call(method string, params ...any) rtorrent.Call {
	if params == nil {
		params = []any{}
	}
	return rtorrent.Call{Method: method, Params: params}
}

// Ready reports whether rtorrent has answered the capability probe.
func (s *Service) Ready() bool { return s.caps.Ready() }

// EnsureCapabilities probes rtorrent's command table unless a recent probe
// still holds.
func (s *Service) EnsureCapabilities(ctx context.Context) error { return s.caps.Ensure(ctx) }

// MethodNames lists every command rtorrent answered the probe with.
func (s *Service) MethodNames() []string { return s.caps.MethodNames() }

// Client is rtorrent itself, for the raw RPC console and /RPC2.
func (s *Service) Client() rtorrent.Client { return s.client }

// BackendSummary says which rtorrent this is and what it supports.
func (s *Service) BackendSummary() contracts.BackendSummary {
	info := s.caps.Info()
	return contracts.BackendSummary{
		ClientVersion:  info.ClientVersion,
		LibraryVersion: info.LibraryVersion,
		APIVersion:     info.APIVersion,
		Flavor:         info.Flavor,
		MethodCount:    info.MethodCount,
		RPCFacility:    info.RPCFacility,
		Endpoint:       s.client.Endpoint(),
		Supports:       info.Supports,
	}
}
