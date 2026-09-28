package service

import (
	"context"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// Files lists a torrent's files, each with where it stands.
func (s *Service) Files(ctx context.Context, hash string) ([]contracts.TorrentFile, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.client.FieldMulticall(ctx, "f.multicall", []any{hash, ""}, s.caps.Dialect().FileFields)
	if err != nil {
		return nil, err
	}
	files := make([]contracts.TorrentFile, len(rows))
	for i, row := range rows {
		files[i] = rtorrent.MapFile(row, i)
	}
	return files, nil
}

// Peers lists the peers a torrent is connected to.
func (s *Service) Peers(ctx context.Context, hash string) ([]contracts.Peer, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.client.FieldMulticall(ctx, "p.multicall", []any{hash, ""}, s.caps.Dialect().PeerFields)
	if err != nil {
		return nil, err
	}
	peers := make([]contracts.Peer, len(rows))
	for i, row := range rows {
		peers[i] = rtorrent.MapPeer(row)
	}
	return peers, nil
}

// Trackers lists a torrent's trackers, with their announce and scrape
// counters.
func (s *Service) Trackers(ctx context.Context, hash string) ([]contracts.Tracker, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := s.client.FieldMulticall(ctx, "t.multicall", []any{hash, ""}, s.caps.Dialect().TrackerFields)
	if err != nil {
		return nil, err
	}
	trackers := make([]contracts.Tracker, len(rows))
	for i, row := range rows {
		trackers[i] = rtorrent.MapTracker(row, i)
	}
	return trackers, nil
}

// TrackerHosts is the primary tracker host per torrent, used for the sidebar
// grouping.
func (s *Service) TrackerHosts(ctx context.Context, hashes []string) (map[string]string, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	hosts := make(map[string]string, len(hashes))
	if len(hashes) == 0 {
		return hosts, nil
	}
	calls := make([]rtorrent.Call, len(hashes))
	for i, hash := range hashes {
		calls[i] = call("t.multicall", hash, "", "t.url=")
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	for i, hash := range hashes {
		rows, ok := results[i].Value.([]any)
		if results[i].Err != nil || !ok || len(rows) == 0 {
			hosts[hash] = "unknown"
			continue
		}
		url := rtorrent.Text(rows[0])
		if first, isRow := rows[0].([]any); isRow {
			url = ""
			if len(first) > 0 {
				url = rtorrent.Text(first[0])
			}
		}
		hosts[hash] = rtorrent.TrackerHost(url)
	}
	return hosts, nil
}
