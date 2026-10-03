package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteDoesNotFollowAStaleTemporarySymlink(t *testing.T) {
	dir := t.TempDir()
	file, other := filepath.Join(dir, "state.json"), filepath.Join(dir, "other")
	if err := os.WriteFile(other, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, file+".tmp"); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(file, []byte(`{"prefs":{}}`)); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(other); err != nil || string(got) != "keep" {
		t.Fatalf("unrelated file overwritten: %q, %v", got, err)
	}
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("state is not a private regular file: %v, %v", info, err)
	}
	if matches, err := filepath.Glob(filepath.Join(dir, ".state.json-*.tmp")); err != nil || len(matches) != 0 {
		t.Fatalf("temporary files left behind: %v, %v", matches, err)
	}
}
