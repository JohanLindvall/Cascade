// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// dataPath is the torrent's base path as the bytes on disk, or "" when it has
// none yet (a torrent never opened has no base path).
//
// rtorrent cannot always name it in XML-RPC text: a path that is not UTF-8,
// or that holds an emoji, arrives as a stand-in (see rtorrent/standin.go) —
// "/downloads/Caf%E9.bin" for the byte 0xE9. Taken as a path, that named
// nothing, so the delete removed nothing and reported success; or, worse, a
// file really called that. From 0.16.13 rtorrent sends the bytes themselves
// on request; on an older release the stand-in is matched against the disk
// instead, and what cannot be told apart is refused before anything is
// erased. (0.16.3 to 0.16.6 garble the stand-in and answer with a fault,
// which ends the delete before the erase too.)
func (s *Service) dataPath(ctx context.Context, hash string) (string, error) {
	if s.caps.Has("d.base_path.base64") {
		encoded, err := s.client.Call(ctx, "d.base_path.base64", hash)
		if err != nil {
			return "", err
		}
		raw, err := base64.StdEncoding.DecodeString(rtorrent.Text(encoded))
		if err != nil {
			return "", httperr.Backend("rtorrent answered d.base_path.base64 with something other than base64")
		}
		return string(raw), nil
	}
	answer, err := s.client.Call(ctx, "d.base_path", hash)
	if err != nil {
		return "", err
	}
	reported := rtorrent.Text(answer)
	if reported == "" || !rtorrent.MayStandIn(reported) {
		return reported, nil
	}
	return s.resolveStandIn(ctx, hash, reported)
}

// maxStandInPaths bounds how many paths on disk a stand-in is followed into.
const maxStandInPaths = 16

// resolveStandIn finds the path on disk a reported base path stands for, and
// refuses rather than guesses.
func (s *Service) resolveStandIn(ctx context.Context, hash, reported string) (string, error) {
	matches, err := pathsReportedAs(reported, maxStandInPaths)
	if err != nil {
		return "", err
	}
	switch {
	case len(matches) == 0:
		// Nothing on disk is what rtorrent means, whatever it means: there is
		// no data to delete. The path still goes through the root checks, as
		// every path always has.
		return reported, nil
	case len(matches) > 1:
		return "", httperr.Newf(http.StatusConflict,
			"refusing to delete the data: rtorrent reports its path as %q, which more than one path on disk matches (%s); "+
				"nothing was removed — remove the torrent without its data and delete the right one yourself",
			reported, quoteSome(matches))
	}
	// One path matches. It is the torrent's own if that data is on disk at
	// all, since the data would match too; with the data gone, it can be
	// another torrent's, named alike. rtorrent can tell: it stats the bytes it
	// holds.
	present, err := s.filesPresent(ctx, hash)
	if err != nil {
		return "", err
	}
	if !present {
		return "", httperr.Newf(http.StatusConflict,
			"refusing to delete the data: rtorrent reports its path as %q, which may stand for another name, and "+
				"finds none of the torrent's files on disk to confirm that %q is its data; nothing was removed — "+
				"remove the torrent without its data and delete that yourself if it is", reported, matches[0])
	}
	return matches[0], nil
}

// unopened is 1 for a file without a frozen path, which every file libtorrent
// opened has: a number, where the path itself would be a string.
const unopened = "not=$f.frozen_path"

// filesPresent reports whether rtorrent finds any of the torrent's files where
// it put them: f.is_created stats the frozen path, the bytes the file was
// opened under, which no stand-in blurs.
//
// Padding is the exception. From libtorrent 0.15 a file is padding when its
// BEP 47 attr holds a 'p', whatever it is called, and f.is_created answers 1
// for it without a stat, data or no data. Padding is never opened, so it has
// no frozen path — and without one a stat finds nothing, so requiring one
// rules out padding and nothing else, on every release.
//
// Only numbers are asked for: rtorrent 0.16.3 to 0.16.6 crash on a string in a
// multicall answer that xmlrpc-c refuses, and a base path that reads as plain
// text says nothing of the names of the files under it.
func (s *Service) filesPresent(ctx context.Context, hash string) (bool, error) {
	if !s.caps.Has("f.is_created") || !s.caps.Has("f.frozen_path") || !s.caps.Has("not") {
		return false, nil
	}
	rows, err := s.client.FieldMulticall(ctx, "f.multicall", []any{hash, ""}, []string{"f.is_created", unopened})
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		if rtorrent.Number(row["f.is_created"]) != 0 && rtorrent.Number(row[unopened]) == 0 {
			return true, nil
		}
	}
	return false, nil
}

// pathsReportedAs lists the paths on disk rtorrent could have reported as
// reported — once more than limit turn up, only as many as it took to find
// out. A component that cannot be a stand-in is taken as it is; for one that
// can, the directory above it is read and every entry rtorrent could have
// reported that way is followed. Every form keeps '/', so the components
// match one for one.
func pathsReportedAs(reported string, limit int) ([]string, error) {
	if !strings.HasPrefix(reported, "/") {
		return nil, nil // never a data path; the root checks refuse it
	}
	paths := []string{""}
	for _, part := range strings.Split(reported[1:], "/") {
		if !rtorrent.MayStandIn(part) {
			for i := range paths {
				paths[i] += "/" + part
			}
			continue
		}
		var next []string
		for _, dir := range paths {
			names, err := entryNames(dir + "/")
			if err != nil {
				return nil, err
			}
			for _, name := range names {
				if rtorrent.Reports(name, part) {
					next = append(next, dir+"/"+name)
				}
			}
			if len(next) > limit {
				return next, nil
			}
		}
		if paths = next; len(paths) == 0 {
			return nil, nil
		}
	}
	found := paths[:0]
	for _, path := range paths {
		if _, err := os.Lstat(path); err == nil {
			found = append(found, path)
		} else if !absent(err) {
			return nil, err
		}
	}
	sort.Strings(found)
	return found, nil
}

// entryNames is a directory's entries, named by the bytes on disk; a
// directory that is not there has none.
func entryNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if absent(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

func absent(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// quoteSome quotes the first few paths as Go quotes them: a byte that is not
// UTF-8 shows as \xe9 rather than vanishing into U+FFFD.
func quoteSome(paths []string) string {
	const shown = 3
	quoted := make([]string, 0, shown+1)
	for i, path := range paths {
		if i == shown {
			quoted = append(quoted, fmt.Sprintf("and %d more", len(paths)-shown))
			break
		}
		quoted = append(quoted, fmt.Sprintf("%q", path))
	}
	return strings.Join(quoted, ", ")
}

func within(candidate, root string) bool {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative))
}

// canonicalPath resolves symlinks in the existing ancestors too: a missing
// file can still sit under a symlink.
func canonicalPath(candidate string) (string, error) {
	resolved, err := filepath.EvalSymlinks(candidate)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(candidate)
	if parent == candidate {
		return "", err
	}
	resolvedParent, err := canonicalPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolvedParent, filepath.Base(candidate)), nil
}

// assertDeletable refuses a path outside the data roots, or one that would
// take a data root with it. It is checked before the torrent's metadata is
// erased. The deletion itself must use an os.Root, not this pathname: an
// ancestor can be replaced after even the last path check.
func assertDeletable(basePath string, deleteRoots []string) (string, error) {
	resolved, err := filepath.Abs(basePath)
	if err != nil {
		return "", err
	}
	roots := make([]string, len(deleteRoots))
	for i, root := range deleteRoots {
		if roots[i], err = filepath.Abs(root); err != nil {
			return "", err
		}
	}
	listed := strings.Join(roots, ", ")
	if listed == "" {
		listed = "none"
	}
	refuse := httperr.Newf(http.StatusForbidden,
		`refusing to delete %q: it is outside the permitted data roots or would delete a data root (%s)`, resolved, listed)
	inRoots := func(path string, roots []string) bool {
		for _, root := range roots {
			if within(path, root) {
				return true
			}
		}
		return false
	}
	if !filepath.IsAbs(basePath) || !inRoots(resolved, roots) {
		return "", refuse
	}
	canonical, err := canonicalPath(resolved)
	if err != nil {
		return "", err
	}
	realRoots := make([]string, len(roots))
	for i, root := range roots {
		if realRoots[i], err = canonicalPath(root); err != nil {
			return "", err
		}
	}
	if !inRoots(canonical, realRoots) {
		return "", refuse
	}
	for _, root := range realRoots {
		if within(root, canonical) {
			return "", refuse
		}
	}
	// RemoveAll unlinks a final symlink itself; keep the original path rather
	// than its target. Ancestor symlinks have been checked above.
	return resolved, nil
}

// dataDeletion holds the permitted directory open across the RPC round trip.
// Root.RemoveAll never follows a symlink out of it, even when an ancestor is
// replaced between validation and removal. A final symlink is unlinked, not
// followed, just as it is by os.RemoveAll.
type dataDeletion struct {
	root *os.Root
	name string
}

func prepareDataDeletion(basePath string, deleteRoots []string) (*dataDeletion, error) {
	resolved, err := assertDeletable(basePath, deleteRoots)
	if err != nil {
		return nil, err
	}
	// Resolve the parent only: resolving the last component would delete a
	// symlink's target rather than the link. Existing in-root absolute links
	// work too; os.Root itself deliberately refuses absolute symlink targets.
	parent, err := canonicalPath(filepath.Dir(resolved))
	if err != nil {
		return nil, err
	}
	path := filepath.Join(parent, filepath.Base(resolved))
	for _, permitted := range deleteRoots {
		absolute, err := filepath.Abs(permitted)
		if err != nil {
			return nil, err
		}
		canonical, err := canonicalPath(absolute)
		if err != nil {
			return nil, err
		}
		if !within(path, canonical) || path == canonical {
			continue
		}
		root, err := os.OpenRoot(canonical)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil // The permitted root itself has no data yet.
		}
		if err != nil {
			return nil, err
		}
		name, err := filepath.Rel(canonical, path)
		if err != nil {
			root.Close()
			return nil, err
		}
		return &dataDeletion{root: root, name: name}, nil
	}
	return nil, httperr.New(http.StatusForbidden, "refusing to delete data: its parent is outside the permitted data roots")
}
