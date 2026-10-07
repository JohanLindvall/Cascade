// SPDX-License-Identifier: MIT

package service

// Deleting data whose path rtorrent can only send as a stand-in: "%E9" (or
// "?" before 0.16.3) where the byte 0xE9 is on disk. The fake answers the way
// rtorrent does, over a temporary directory holding the real bytes, and what
// these pin is that the delete reaches exactly the torrent's own data — and
// that what cannot be told apart is refused before the erase.

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/rtorrent/rtorrenttest"
)

// plant writes a file, and the directories above it, and returns its path.
func plant(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func onDisk(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// standIn is a release before 0.16.13: no .base64 variants, so the base path
// arrives as rtorrent's stand-in. files is the f.multicall answer, f.path and
// f.is_created per file.
func standIn(t *testing.T, reported func(downloads string) string, files ...[]any) (subject, *rtorrenttest.FakeClient) {
	t.Helper()
	client := backend("f.is_created")
	s := newService(t, client, nil)
	client.Answer("d.base_path", reported(s.cfg.DownloadDir))
	client.Answer("f.multicall", files)
	return s, client
}

func under(name string) func(string) string {
	return func(downloads string) string { return downloads + "/" + name }
}

func TestALatin1NameRtorrentEscapesIsDeletedWhereItIsOnDisk(t *testing.T) {
	s, client := standIn(t, under("Caf%E9 single on.bin"), []any{"Caf%E9 single on.bin", 1})
	data := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf\xe9 single on.bin"), "payload")
	// Differs only in the byte the escape hides, so it is not a match.
	keep := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf\xe8 single on.bin"), "another")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) || !onDisk(keep) {
		t.Fatalf("data still there: %v; neighbour gone: %v", onDisk(data), !onDisk(keep))
	}
	if len(client.CallsTo("d.erase")) != 1 {
		t.Fatal("not erased")
	}
}

func TestAMultiFileTorrentInAnEscapedDirectoryIsDeletedWhole(t *testing.T) {
	// The escape covers the whole path, the UTF-8 name inside included.
	s, _ := standIn(t, under("Caf%E9 dir"), []any{"Café.txt", 1}, []any{"sub/x%FF.bin", 1})
	dir := filepath.Join(s.cfg.DownloadDir, "Caf\xe9 dir")
	plant(t, filepath.Join(dir, "Café.txt"), "a")
	plant(t, filepath.Join(dir, "sub", "x\xff.bin"), "b")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(dir) {
		t.Fatal("the directory is still there")
	}
}

func TestAStandInDeeperInThePathIsFollowedToo(t *testing.T) {
	// A single-file torrent in a directory that is not UTF-8: only the file
	// is the torrent's.
	s, _ := standIn(t, under("M%FCsik/track.flac"), []any{"track.flac", 1})
	dir := filepath.Join(s.cfg.DownloadDir, "M\xfcsik")
	data := plant(t, filepath.Join(dir, "track.flac"), "a")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) || !onDisk(dir) {
		t.Fatalf("file still there: %v; directory gone: %v", onDisk(data), !onDisk(dir))
	}
}

func TestTheQuestionMarksOfOlderReleasesAreResolvedToo(t *testing.T) {
	s, _ := standIn(t, under("Caf? old.bin"), []any{"Caf? old.bin", 1})
	data := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf\xe9 old.bin"), "payload")
	// '?' stands for a byte that is not ASCII, never for 'e'.
	keep := plant(t, filepath.Join(s.cfg.DownloadDir, "Cafe old.bin"), "another")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) || !onDisk(keep) {
		t.Fatalf("data still there: %v; neighbour gone: %v", onDisk(data), !onDisk(keep))
	}
}

func TestAnEmojiNameIsEscapedAndStillDeleted(t *testing.T) {
	// Valid UTF-8, but outside the Basic Multilingual Plane, which is all
	// xmlrpc-c 1.51 holds.
	s, _ := standIn(t, under("Song %F0%9F%8E%B5.bin"), []any{"Song %F0%9F%8E%B5.bin", 1})
	data := plant(t, filepath.Join(s.cfg.DownloadDir, "Song \U0001F3B5.bin"), "payload")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) {
		t.Fatal("the data is still there")
	}
}

func TestTwoPathsOneStandInCouldMeanAreRefusedBeforeTheErase(t *testing.T) {
	s, client := standIn(t, under("Caf%E9 x.bin"), []any{"Caf%E9 x.bin", 1})
	real := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf\xe9 x.bin"), "payload")
	// What the delete used to remove: a file called what rtorrent reports.
	literal := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf%E9 x.bin"), "someone else's")
	err := s.Remove(ctx, hash, true)
	if got := status(t, err); got != 409 || len(client.CallsTo("d.erase")) != 0 {
		t.Fatalf("%d; the erase must wait for a path that is certain", got)
	}
	if !onDisk(real) || !onDisk(literal) {
		t.Fatal("something was deleted")
	}
	for _, named := range []string{`/Caf\xe9 x.bin"`, `/Caf%E9 x.bin"`} {
		if !strings.Contains(err.Error(), named) {
			t.Errorf("the refusal does not name %s: %v", named, err)
		}
	}
}

func TestAStandInMatchingTooManyPathsIsRefused(t *testing.T) {
	s, client := standIn(t, under("Caf?"), []any{"Caf?", 1})
	for b := 0x80; b < 0x80+maxStandInPaths+1; b++ {
		plant(t, filepath.Join(s.cfg.DownloadDir, "Caf"+string([]byte{byte(b)})), "x")
	}
	if got := status(t, s.Remove(ctx, hash, true)); got != 409 || len(client.CallsTo("d.erase")) != 0 {
		t.Fatalf("%d", got)
	}
}

func TestAValidNameThatSpellsAnEscapeIsDeletedAsItself(t *testing.T) {
	s, _ := standIn(t, under("Mix 100%E9.bin"), []any{"Mix 100%E9.bin", 1})
	data := plant(t, filepath.Join(s.cfg.DownloadDir, "Mix 100%E9.bin"), "payload")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) {
		t.Fatal("the data is still there")
	}
}

func TestTextThatIsNotASCIICannotBeAnEscapeAndIsTakenAsItIs(t *testing.T) {
	// An escaped string is ASCII through and through, so "%E9" beside an "é"
	// rtorrent sent as itself is three characters: no directory is read and
	// rtorrent is not asked to confirm anything.
	s, client := standIn(t, under("Café 100%E9.bin"))
	data := plant(t, filepath.Join(s.cfg.DownloadDir, "Café 100%E9.bin"), "payload")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) || len(client.CallsTo("f.multicall")) != 0 {
		t.Fatalf("data still there: %v; confirmation asked: %d", onDisk(data), len(client.CallsTo("f.multicall")))
	}
}

func TestAStandInForDataThatIsGoneErasesAndDeletesNothing(t *testing.T) {
	s, client := standIn(t, under("Caf%E9 gone.bin"), []any{"Caf%E9 gone.bin", 0})
	keep := plant(t, filepath.Join(s.cfg.DownloadDir, "Cafe gone.bin"), "another")
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if len(client.CallsTo("d.erase")) != 1 || !onDisk(keep) {
		t.Fatal("expected the erase alone")
	}
}

func TestAMatchRtorrentCannotConfirmAsItsDataIsRefused(t *testing.T) {
	// The torrent's own file is gone; one called what rtorrent reports is
	// someone else's, and rtorrent, which stats the real bytes, finds none of
	// the torrent's files.
	s, client := standIn(t, under("Caf%E9 gone.bin"), []any{"Caf%E9 gone.bin", 0})
	other := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf%E9 gone.bin"), "someone else's")
	if got := status(t, s.Remove(ctx, hash, true)); got != 409 || len(client.CallsTo("d.erase")) != 0 || !onDisk(other) {
		t.Fatalf("%d", got)
	}
	// A padding file says it is there without ever being written.
	client.Answer("f.multicall", [][]any{{".pad/1024", 1}, {"Caf%E9 gone.bin", 0}})
	if got := status(t, s.Remove(ctx, hash, true)); got != 409 || !onDisk(other) {
		t.Fatalf("padding taken for data: %d", got)
	}
}

func TestAResolvedPathMustStillLieInsideTheRoots(t *testing.T) {
	s, client := standIn(t, under("link/Caf%E9 x.bin"), []any{"Caf%E9 x.bin", 1})
	outside := filepath.Join(filepath.Dir(s.cfg.DownloadDir), "outside")
	keep := plant(t, filepath.Join(outside, "Caf\xe9 x.bin"), "important")
	if err := os.Symlink(outside, filepath.Join(s.cfg.DownloadDir, "link")); err != nil {
		t.Fatal(err)
	}
	if got := status(t, s.Remove(ctx, hash, true)); got != 403 || len(client.CallsTo("d.erase")) != 0 || !onDisk(keep) {
		t.Fatalf("%d", got)
	}
}

func TestTheExactBytesAreUsedWhereRtorrentSendsThem(t *testing.T) {
	client := backend("d.base_path.base64", "f.is_created")
	s := newService(t, client, nil)
	data := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf\xe9 x.bin"), "payload")
	literal := plant(t, filepath.Join(s.cfg.DownloadDir, "Caf%E9 x.bin"), "someone else's")
	client.Answer("d.base_path.base64", base64.StdEncoding.EncodeToString([]byte(data)))
	if err := s.Remove(ctx, hash, true); err != nil {
		t.Fatal(err)
	}
	if onDisk(data) || !onDisk(literal) {
		t.Fatalf("data still there: %v; the file named like its stand-in gone: %v", onDisk(data), !onDisk(literal))
	}
	if len(client.CallsTo("d.base_path"))+len(client.CallsTo("f.multicall")) != 0 {
		t.Fatal("the bytes were known; nothing else needed asking")
	}

	client.Answer("d.base_path.base64", "not base64!")
	if got := status(t, s.Remove(ctx, hash, true)); got != 502 || len(client.CallsTo("d.erase")) != 1 || !onDisk(literal) {
		t.Fatalf("an answer that is not base64: %d", got)
	}
}
