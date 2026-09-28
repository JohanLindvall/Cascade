package service

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// Action starts, stops, pauses, resumes, rechecks or announces a torrent.
func (s *Service) Action(ctx context.Context, hash, action string) error {
	ctx = detached(ctx)
	return s.torrentWrites.run(hash, func() error { return s.performAction(ctx, hash, action) })
}

func (s *Service) performAction(ctx context.Context, hash, action string) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	var calls []rtorrent.Call
	switch action {
	case "start":
		calls = append(calls, call("d.open", hash), call("d.start", hash))
	case "stop":
		calls = append(calls, call("d.stop", hash), call("d.close", hash))
	case "pause":
		calls = append(calls, call("d.pause", hash))
	case "resume":
		calls = append(calls, call("d.resume", hash))
	case "recheck", "recheck-restart":
		calls = append(calls, call("d.stop", hash))
		// A stale error ("registered as completed, but hash check returned
		// unfinished chunks") outranks everything in the status derivation,
		// so left in place it hides the very check the user just started.
		// The check writes its own message if it fails again.
		if s.caps.Has("d.message.set") {
			calls = append(calls, call("d.message.set", hash, ""))
		}
		calls = append(calls, call("d.check_hash", hash))
	case "announce":
		if !s.caps.Supports("trackerAnnounce") {
			return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.tracker_announce")
		}
		calls = append(calls, call("d.tracker_announce", hash))
	default:
		return httperr.Newf(http.StatusBadRequest, `unknown action "%s"`, action)
	}
	for _, c := range calls {
		if !s.caps.Has(c.Method) {
			return httperr.Newf(http.StatusNotImplemented, "this rtorrent build does not expose %s", c.Method)
		}
	}
	if action != "announce" {
		s.pendingRestarts.cancel(hash)
	}
	// Lifecycle commands must be separate, ordered requests (rtorrent 0.15.2
	// can crash when lifecycle changes and setters share a multicall).
	for _, c := range calls {
		if _, err := s.client.Call(ctx, c.Method, c.Params...); err != nil {
			return err
		}
	}
	// The restart half cannot happen here: the check runs for as long as the
	// disk takes, far past this request. The poll tick watches for the end.
	if action == "recheck-restart" {
		s.pendingRestarts.add(hash, s.now())
	}
	return nil
}

// processPendingRestarts starts whatever finished its recheck since the last
// tick — the second half of "recheck & restart". Reads and starts share the
// torrent's mutation queue so a later stop cannot be overtaken. Starts remain
// separate calls (quirk 5: lifecycle mixes in one multicall have segfaulted
// rtorrent).
func (s *Service) processPendingRestarts(ctx context.Context) error {
	if s.pendingRestarts.size() == 0 {
		return nil
	}
	for _, hash := range s.pendingRestarts.hashes() {
		err := s.torrentWrites.run(hash, func() error {
			if !s.pendingRestarts.has(hash) {
				return nil
			}
			results, err := s.client.MulticallSettled(ctx, []rtorrent.Call{call("d.hashing", hash)})
			if err != nil {
				return err
			}
			var hashing *float64
			if results[0].Err == nil {
				reading := results[0].Number()
				hashing = &reading
			}
			if s.pendingRestarts.step(hash, hashing, s.now()) != restartStart {
				return nil
			}
			// Seen through even if the housekeeping is being stopped: the
			// reading above has already taken the torrent off the list.
			started := detached(ctx)
			_, err = s.client.Call(started, "d.open", hash)
			if err == nil {
				_, err = s.client.Call(started, "d.start", hash)
			}
			if err != nil {
				log.Printf("[cascade] recheck finished but %s would not start: %v", hash, err)
			} else {
				log.Printf("[cascade] recheck finished, restarted %s", hash)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Remove erases a torrent, and with deleteData its data as well — only inside
// the data roots.
func (s *Service) Remove(ctx context.Context, hash string, deleteData bool) error {
	ctx = detached(ctx)
	return s.torrentWrites.run(hash, func() error { return s.removeTorrent(ctx, hash, deleteData) })
}

func (s *Service) removeTorrent(ctx context.Context, hash string, deleteData bool) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	dataPath := ""
	if deleteData {
		if !s.cfg.AllowDataDelete {
			return httperr.New(http.StatusForbidden, "deleting torrent data is disabled (CASCADE_ALLOW_DATA_DELETE=0)")
		}
		basePath, err := s.client.Call(ctx, "d.base_path", hash)
		if err != nil {
			return err
		}
		// Refused before the torrent is erased: rejecting the path afterwards
		// left the metadata gone and the data behind — the one combination the
		// user did not ask for. An empty base path (never started) has nothing
		// to check or delete.
		if base := rtorrent.Text(basePath); base != "" {
			if dataPath, err = assertDeletable(base, s.cfg.DeleteRoots); err != nil {
				return err
			}
		}
	}
	if _, err := s.client.Call(ctx, "d.erase", hash); err != nil {
		return err
	}
	s.pendingRestarts.cancel(hash)
	s.store.Forget(hash)
	if dataPath != "" {
		if _, err := assertDeletable(dataPath, s.cfg.DeleteRoots); err != nil {
			return err
		}
		if err := os.RemoveAll(dataPath); err != nil {
			return httperr.Newf(http.StatusInternalServerError, "the torrent was removed, but its data could not be deleted: %v", err)
		}
	}
	return nil
}

// SetPriority sets a torrent's priority: 0 off, 1 low, 2 normal, 3 high.
func (s *Service) SetPriority(ctx context.Context, hash string, priority int64) error {
	_, err := s.client.Call(detached(ctx), "d.priority.set", hash, priority)
	return err
}

// SetLabel labels a torrent; an empty label clears it.
func (s *Service) SetLabel(ctx context.Context, hash, label string) error {
	ctx = detached(ctx)
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("labels") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.custom1")
	}
	_, err := s.client.Call(ctx, "d.custom1.set", hash, encodeURIComponent(label))
	return err
}

// SetTorrentThrottle assigns a torrent to a throttle group.
func (s *Service) SetTorrentThrottle(ctx context.Context, hash, name string) error {
	ctx = detached(ctx)
	return s.torrentWrites.run(hash, func() error { return s.changeTorrentThrottle(ctx, hash, name) })
}

func (s *Service) changeTorrentThrottle(ctx context.Context, hash, name string) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("perTorrentThrottle") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.throttle_name")
	}
	// rtorrent rejects a throttle change while the download is running
	// ("Cannot set throttle on active download"), so bounce it around the
	// set. These go out as separate requests on purpose: batching
	// stop/set/start into one system.multicall segfaults rtorrent 0.15.2.
	state, err := s.client.Call(ctx, "d.is_active", hash)
	if err != nil {
		return err
	}
	wasActive := rtorrent.Number(state) != 0
	if wasActive {
		if _, err := s.client.Call(ctx, "d.stop", hash); err != nil {
			return err
		}
	}
	if _, err := s.client.Call(ctx, "d.throttle_name.set", hash, name); err != nil {
		if wasActive {
			_, _ = s.client.Call(ctx, "d.start", hash)
		}
		return err
	}
	if wasActive {
		if _, err := s.client.Call(ctx, "d.start", hash); err != nil {
			return err
		}
	}
	_, err = s.client.Call(ctx, "d.save_full_session", hash)
	return err
}

// SetTorrentSlots sets a torrent's upload and download slot limits; a nil
// count is left as it is.
func (s *Service) SetTorrentSlots(ctx context.Context, hash string, uploads, downloads *int64) error {
	ctx = detached(ctx)
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if (uploads != nil && !s.caps.Supports("perTorrentMaxUploads")) ||
		(downloads != nil && !s.caps.Supports("perTorrentMaxDownloads")) {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support the requested per-torrent slot setting")
	}
	var calls []rtorrent.Call
	if uploads != nil {
		calls = append(calls, call("d.uploads_max.set", hash, *uploads))
	}
	if downloads != nil {
		calls = append(calls, call("d.downloads_max.set", hash, *downloads))
	}
	if len(calls) == 0 {
		return nil
	}
	_, err := s.client.Multicall(ctx, calls)
	return err
}

// SetDirectory moves where a torrent's data is looked for. The data itself
// is not moved.
func (s *Service) SetDirectory(ctx context.Context, hash, directory string) error {
	ctx = detached(ctx)
	return s.torrentWrites.run(hash, func() error {
		if err := s.caps.Ensure(ctx); err != nil {
			return err
		}
		if !s.caps.Supports("perTorrentDirectory") {
			return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support changing a torrent directory")
		}
		// Close before changing paths: rtorrent refuses an open download whose
		// files were moved, and frozen file paths must be rebuilt on next
		// open. Leave it stopped so the owner can move the data and recheck
		// it first.
		if err := s.performAction(ctx, hash, "stop"); err != nil {
			return err
		}
		if _, err := s.client.Call(ctx, "d.directory.set", hash, directory); err != nil {
			return err
		}
		_, err := s.client.Call(ctx, "d.save_full_session", hash)
		return err
	})
}

// SetFilePriority sets a file's priority — 0 skip, 1 normal, 2 high — and
// has rtorrent act on it at once.
func (s *Service) SetFilePriority(ctx context.Context, hash string, index int, priority int64) error {
	_, err := s.client.Multicall(detached(ctx), []rtorrent.Call{
		call("f.priority.set", hash+":f"+strconv.Itoa(index), priority),
		call("d.update_priorities", hash),
	})
	return err
}

// SetTrackerEnabled switches one of a torrent's trackers on or off.
func (s *Service) SetTrackerEnabled(ctx context.Context, hash string, index int, enabled bool) error {
	ctx = detached(ctx)
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("trackerToggle") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose t.is_enabled.set")
	}
	flag := 0
	if enabled {
		flag = 1
	}
	_, err := s.client.Call(ctx, "t.is_enabled.set", hash+":t"+strconv.Itoa(index), flag)
	return err
}

// AddTracker adds an announce URL to a torrent, in the given tier, and saves
// the session so it survives a restart.
func (s *Service) AddTracker(ctx context.Context, hash, url string, group int64) error {
	ctx = detached(ctx)
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("trackerInsert") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose d.tracker.insert")
	}
	_, err := s.client.Multicall(ctx, []rtorrent.Call{
		call("d.tracker.insert", hash, max(0, group), url),
		call("d.save_full_session", hash),
	})
	return err
}
