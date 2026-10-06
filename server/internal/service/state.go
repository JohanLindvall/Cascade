// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/game"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// State is what the UI shows: the list, the global status, the throttle
// groups and the game. Several readers can ask together; they share one read
// of rtorrent, and so one answer, which none of them may modify.
func (s *Service) State(ctx context.Context) (contracts.StateResponse, error) {
	// The shared read outlives any one caller that gives up on it.
	shared := context.WithoutCancel(ctx)
	return s.stateRead.do(func() (contracts.StateResponse, error) {
		if err := s.caps.Ensure(shared); err != nil {
			return contracts.StateResponse{}, err
		}
		torrents, err := s.Torrents(shared, "main")
		if err != nil {
			return contracts.StateResponse{}, err
		}
		status, err := s.status(shared, torrents)
		if err != nil {
			return contracts.StateResponse{}, err
		}
		return contracts.StateResponse{
			Status:    status,
			Torrents:  torrents,
			Throttles: s.store.Throttles(),
			Game:      s.Game(),
		}, nil
	})
}

// updateGame folds the current list into the lifetime stats and unlocks
// what is earned.
func (s *Service) updateGame(torrents []contracts.Torrent) {
	if !s.cfg.Gamify {
		return
	}
	now := s.now()
	s.lastGameUpdate.Store(now.UnixMilli())
	s.store.RecordTorrents(torrents)
	for _, id := range game.NewlyUnlocked(s.store.Stats(), s.store.UnlockedAchievements()) {
		s.store.Unlock(id, now.Unix())
	}
}

// Game is the level and badges the lifetime counters have earned.
func (s *Service) Game() contracts.GameState {
	return game.BuildState(s.store.Stats(), s.store.UnlockedAchievements(), s.cfg.Gamify)
}

// Torrents lists a view. The main view is shared among concurrent readers,
// and only it may drive the bookkeeping.
func (s *Service) Torrents(ctx context.Context, view string) ([]contracts.Torrent, error) {
	if view != "main" {
		return s.readTorrents(ctx, view)
	}
	shared := context.WithoutCancel(ctx)
	return s.torrentRead.do(func() ([]contracts.Torrent, error) { return s.readTorrents(shared, view) })
}

func (s *Service) readTorrents(ctx context.Context, view string) ([]contracts.Torrent, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	select {
	case s.listingGate <- struct{}{}:
		defer func() { <-s.listingGate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	dialect := s.caps.Dialect()
	rows, err := s.client.FieldMulticall(ctx, dialect.DownloadMulticall, dialect.DownloadMulticallPrefix(view), dialect.TorrentFields)
	if err != nil {
		return nil, err
	}
	hashes := make([]string, len(rows))
	for i, row := range rows {
		hashes[i] = rtorrent.Text(row["d.hash"])
	}
	added := s.store.AddedTimes(hashes, s.now().Unix())
	live := make(map[string]bool, len(rows))
	torrents := make([]contracts.Torrent, len(rows))
	for i, row := range rows {
		live[hashes[i]] = true
		torrents[i] = rtorrent.MapTorrent(row, added[i])
	}
	// Only the complete list may drive pruning: a filtered view would look
	// like every other torrent had been removed and erase its bookkeeping.
	if view == "main" {
		s.store.Prune(live)
		s.updateGame(torrents)
	}
	return torrents, nil
}

// Status is the global status on its own.
func (s *Service) Status(ctx context.Context) (contracts.GlobalStatus, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return contracts.GlobalStatus{}, err
	}
	torrents, err := s.Torrents(ctx, "main")
	if err != nil {
		return contracts.GlobalStatus{}, err
	}
	return s.status(ctx, torrents)
}

func (s *Service) status(ctx context.Context, torrents []contracts.Torrent) (contracts.GlobalStatus, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return contracts.GlobalStatus{}, err
	}
	methods := []string{
		"throttle.global_down.rate",
		"throttle.global_up.rate",
		"throttle.global_down.total",
		"throttle.global_up.total",
		"throttle.global_down.max_rate",
		"throttle.global_up.max_rate",
		"network.listen.port",
		"directory.default",
	}
	if s.caps.Supports("dhtStatistics") {
		methods = append(methods, "dht.statistics")
	}
	calls := make([]rtorrent.Call, len(methods))
	for i, method := range methods {
		calls[i] = call(method)
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return contracts.GlobalStatus{}, err
	}
	// Answers are looked up by command rather than by position, so an entry
	// added above another cannot silently shift it into the wrong slot.
	answer := func(method string) rtorrent.Result {
		if i := slices.Index(methods, method); i >= 0 && i < len(results) {
			return results[i]
		}
		return rtorrent.Result{Err: errors.New("not asked")}
	}
	number := func(method string) int64 { return int64(answer(method).Number()) }

	var dhtNodes int64
	if dht := answer("dht.statistics"); dht.Err == nil {
		if stats, ok := dht.Value.(map[string]any); ok {
			dhtNodes = int64(rtorrent.Number(stats["active_nodes"]))
		}
	}
	downloadDir := ""
	if directory := answer("directory.default"); directory.Err == nil {
		switch v := directory.Value.(type) {
		case []byte:
			downloadDir = string(v)
		case string:
			downloadDir = v
		}
	}
	active := 0
	for _, t := range torrents {
		if t.Status == contracts.StatusDownloading || t.Status == contracts.StatusSeeding {
			active++
		}
	}
	statePollMs := s.cfg.StatePollMs
	if preferred := s.store.Preferences().StatePollMs; preferred != nil {
		statePollMs = *preferred
	}
	s.mu.Lock()
	history := slices.Clone(s.history)
	s.mu.Unlock()
	return contracts.GlobalStatus{
		// A successful read proves the connection is up even before the first
		// background tick or just after recovery.
		Connected:          true,
		DownRate:           number("throttle.global_down.rate"),
		UpRate:             number("throttle.global_up.rate"),
		DownTotal:          number("throttle.global_down.total"),
		UpTotal:            number("throttle.global_up.total"),
		DownLimit:          number("throttle.global_down.max_rate"),
		UpLimit:            number("throttle.global_up.max_rate"),
		TorrentCount:       len(torrents),
		ActiveCount:        active,
		DHTNodes:           dhtNodes,
		ListenPort:         number("network.listen.port"),
		DiskFree:           s.diskFree(),
		DownloadDir:        downloadDir,
		Policy:             contracts.Policy{RawRPC: s.cfg.AllowRawRPC, DeleteData: s.cfg.AllowDataDelete},
		StatePollMs:        statePollMs,
		StatePollDefaultMs: s.cfg.StatePollMs,
		Backend:            s.BackendSummary(),
		History:            history,
	}, nil
}

// diskCache holds the free space on the download volume for a few seconds:
// the state is read up to ten times a second, and statfs on a network mount
// is not free.
type diskCache struct {
	mu    sync.Mutex
	at    time.Time
	value *int64
}

const diskFreeTTL = 5 * time.Second

func (s *Service) diskFree() *int64 {
	s.disk.mu.Lock()
	defer s.disk.mu.Unlock()
	if now := s.now(); s.disk.at.IsZero() || now.Sub(s.disk.at) >= diskFreeTTL || now.Before(s.disk.at) {
		s.disk.value, s.disk.at = freeSpace(s.cfg.DownloadDir), now
	}
	if s.disk.value == nil {
		return nil
	}
	free := *s.disk.value
	return &free
}
