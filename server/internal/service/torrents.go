// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"path"
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
	var data *dataDeletion
	if deleteData {
		if !s.cfg.AllowDataDelete {
			return httperr.New(http.StatusForbidden, "deleting torrent data is disabled (CASCADE_ALLOW_DATA_DELETE=0)")
		}
		base, err := s.dataPath(ctx, hash)
		if err != nil {
			return err
		}
		// Refused before the torrent is erased: rejecting the path afterwards
		// left the metadata gone and the data behind — the one combination the
		// user did not ask for. An empty base path (never started) has nothing
		// to check or delete.
		if base != "" {
			if data, err = prepareDataDeletion(base, s.cfg.DeleteRoots); err != nil {
				return err
			}
			if data != nil {
				defer data.root.Close()
			}
		}
	}
	// Finish folding any earlier listing before forgetting its counters,
	// and keep a later listing from reaching the store before this erase.
	s.listingGate <- struct{}{}
	_, err := s.client.Call(ctx, "d.erase", hash)
	if err == nil {
		s.store.Forget(hash)
	}
	<-s.listingGate
	if err != nil {
		return err
	}
	s.pendingRestarts.cancel(hash)
	if data != nil {
		if err := data.root.RemoveAll(data.name); err != nil {
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

// SetDirectory changes the directory a torrent's data goes into — what an
// add's directory names: the one a single file is in, or the one holding a
// multi-file torrent's own folder, which keeps its name on disk (see
// rtorrent/directory.go). The data itself is not moved. A torrent whose data
// already goes there is left alone, running or not, so the directory the UI
// offers changes nothing when it is sent back as it is.
func (s *Service) SetDirectory(ctx context.Context, hash, directory string) error {
	ctx = detached(ctx)
	// As rtorrent keeps a directory, and as DataDirectory reads the listing's:
	// without the trailing slashes d.directory.set would keep before the name
	// it appends ("dir//X").
	directory = rtorrent.TrimDirectory(directory)
	return s.torrentWrites.run(hash, func() error {
		if err := s.caps.Ensure(ctx); err != nil {
			return err
		}
		if !s.caps.Supports("perTorrentDirectory") {
			return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support changing a torrent directory")
		}
		where, err := s.placement(ctx, hash)
		if err != nil {
			return err
		}
		if rtorrent.DataDirectory(where) == directory {
			return nil
		}
		method, value, err := s.directoryCommand(where, directory)
		if err != nil {
			return err
		}
		// Close before changing paths: rtorrent refuses an open download whose
		// files were moved, and frozen file paths must be rebuilt on next
		// open. Leave it stopped so the owner can move the data and recheck
		// it first.
		if err := s.performAction(ctx, hash, "stop"); err != nil {
			return err
		}
		if _, err := s.client.Call(ctx, method, hash, value); err != nil {
			return err
		}
		_, err = s.client.Call(ctx, "d.save_full_session", hash)
		return err
	})
}

// placement reads what a directory change needs to know of a torrent: its
// d.is_multi_file and d.directory, and where d.directory may be a stand-in,
// the base path's bytes and the torrent's name. Each string is a request of
// its own: rtorrent 0.16.3 to 0.16.6 crash on one xmlrpc-c refuses inside a
// multicall's answer (see filesPresent).
func (s *Service) placement(ctx context.Context, hash string) (rtorrent.Row, error) {
	row := rtorrent.Row{}
	read := func(field string) error {
		value, err := s.client.Call(ctx, field, hash)
		row[field] = value
		return err
	}
	for _, field := range []string{"d.is_multi_file", "d.directory"} {
		if err := read(field); err != nil {
			return nil, err
		}
	}
	exact := rtorrent.ExactFields["d.base_path"]
	if rtorrent.MayStandIn(rtorrent.Text(row["d.directory"])) && s.caps.Has(exact) {
		if err := read(exact); err != nil {
			return nil, err
		}
	}
	if _, ok := rtorrent.Folder(row); !ok && rtorrent.Number(row["d.is_multi_file"]) != 0 {
		if name := s.caps.Resolve(rtorrent.ExactFields["d.name"], "d.name"); name != "" {
			if err := read(name); err != nil {
				return nil, err
			}
		}
	}
	return row, nil
}

// directoryCommand is the command, and its argument, that puts a torrent's
// data into directory: d.directory.set for a single file; for a multi-file
// torrent the base setter, given its folder by the name it has inside
// directory, since d.directory.set would name the folder after the torrent.
// Where the folder's bytes cannot pass through XML-RPC text either way,
// d.directory.set still serves a folder named after the torrent, appending
// the name on rtorrent's side; any other is refused before anything changes.
func (s *Service) directoryCommand(where rtorrent.Row, directory string) (method, value string, err error) {
	if rtorrent.Number(where["d.is_multi_file"]) == 0 {
		return "d.directory.set", directory, nil
	}
	setter := s.caps.Resolve("d.directory.base.set", "d.directory_base.set")
	switch folder, ok := rtorrent.Folder(where); {
	case ok && folder != "" && setter != "":
		return setter, rtorrent.JoinDirectory(directory, folder), nil
	// A root with no folder of its own is given one named after the torrent,
	// as an add names it.
	case ok && folder == "", !ok && rtorrent.NamedAfterTorrent(where):
		return "d.directory.set", directory, nil
	case ok:
		return "", "", httperr.New(http.StatusNotImplemented,
			"this rtorrent build has no d.directory_base.set to keep a multi-file torrent's folder with")
	}
	return "", "", httperr.Backend(fmt.Sprintf(
		"cannot keep this torrent's folder, %q: its name cannot be read from rtorrent exactly or sent back as text, "+
			"and it is not the torrent's own; nothing was changed", path.Base(rtorrent.Text(where["d.directory"]))))
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
