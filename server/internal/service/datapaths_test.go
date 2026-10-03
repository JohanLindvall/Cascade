package service

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeletionCannotFollowAnAncestorReplacedAfterValidation(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	parent := filepath.Join(root, "parent")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{parent, outside} {
		if err := os.WriteFile(filepath.Join(dir, "keep"), []byte("payload"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	data, err := prepareDataDeletion(filepath.Join(parent, "keep"), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer data.root.Close()
	if err := os.Rename(parent, parent+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	// The old absolute RemoveAll would now erase outside/keep. Whether the
	// rooted removal reports a missing ancestor or a refused link, it must
	// never follow that link.
	_ = data.root.RemoveAll(data.name)
	if got, err := os.ReadFile(filepath.Join(outside, "keep")); err != nil || string(got) != "payload" {
		t.Fatalf("outside data changed: %q, %v", got, err)
	}
}

func TestDeletionUnlinksFinalSymlinkAndSupportsInternalAncestorLinks(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "data")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "payload")
	if err := os.WriteFile(file, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	data, err := prepareDataDeletion(filepath.Join(alias, "link"), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer data.root.Close()
	if err := data.root.RemoveAll(data.name); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("link was not removed: %v", err)
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "keep" {
		t.Fatalf("symlink target changed: %q, %v", got, err)
	}
}

func TestDeletionRefusesAnOutsideParentEvenWhenFinalLinkPointsBackInside(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(root, filepath.Join(outside, "back")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "out")); err != nil {
		t.Fatal(err)
	}
	// The final target is inside the root, but unlinking this path would
	// modify outside/back. A final-component check alone misses that.
	if _, err := prepareDataDeletion(filepath.Join(root, "out", "back"), []string{root}); err == nil {
		t.Fatal("accepted a symlink whose parent is outside the permitted root")
	}
}
