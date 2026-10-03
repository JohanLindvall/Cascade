package service

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
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
