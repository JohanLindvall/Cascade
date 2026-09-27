package service

import (
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

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
// erased, and again before unlinking after the RPC round trip.
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
		`refusing to delete "%s": it is outside the permitted data roots or would delete a data root (%s)`, resolved, listed)
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
