// SPDX-License-Identifier: MIT

package service

// A directory change takes the directory the data goes into, as an add does.
// d.directory reports a multi-file torrent's own folder, and d.directory.set
// appends the torrent's name to what it is given, so the prompt's suggestion
// — d.directory as it was — used to move the saved path to "/downloads/X/X".

import (
	"encoding/base64"
	"reflect"
	"slices"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent/rtorrenttest"
)

// placed is a backend whose torrent's d.directory is directory, on a build
// that lists the extra commands besides the ones every release has.
func placed(directory string, multi bool, extra ...string) *rtorrenttest.FakeClient {
	commands := []string{"d.directory", "d.is_multi_file", "d.directory.set", "d.directory_base.set", "d.save_full_session"}
	client := backend(append(commands, extra...)...).Answer("d.directory", directory)
	if multi {
		return client.Answer("d.is_multi_file", 1)
	}
	return client.Answer("d.is_multi_file", 0)
}

// changes is what reached rtorrent besides reads.
func changes(client *rtorrenttest.FakeClient) []rtorrent.Call {
	mutations := []string{"d.stop", "d.close", "d.directory.set", "d.directory_base.set", "d.directory.base.set", "d.save_full_session"}
	var got []rtorrent.Call
	for _, c := range client.Calls() {
		if slices.Contains(mutations, c.Method) {
			got = append(got, c)
		}
	}
	return got
}

func movedWith(method, value string) []rtorrent.Call {
	return []rtorrent.Call{
		{Method: "d.stop", Params: []any{hash}},
		{Method: "d.close", Params: []any{hash}},
		{Method: method, Params: []any{hash, value}},
		{Method: "d.save_full_session", Params: []any{hash}},
	}
}

func b64(raw string) string { return base64.StdEncoding.EncodeToString([]byte(raw)) }

func TestChangingADirectoryClosesFirstAndLeavesItStopped(t *testing.T) {
	// Trailing slashes or not: a directory goes to rtorrent as it keeps one.
	for _, to := range []string{"/downloads/moved", "/downloads/moved//"} {
		client := placed("/downloads", false)
		if err := newService(t, client, nil).SetDirectory(ctx, hash, to); err != nil {
			t.Fatal(err)
		}
		if got, want := changes(client), movedWith("d.directory.set", "/downloads/moved"); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %v", to, got)
		}
	}
	unsupported := backend()
	if code := status(t, newService(t, unsupported, nil).SetDirectory(ctx, hash, "/downloads/moved")); code != 501 || len(unsupported.CallsTo("d.stop")) != 0 {
		t.Fatalf("%d", code)
	}
}

func TestAMultiFileTorrentKeepsItsFolderInsideTheDirectoryGiven(t *testing.T) {
	for _, c := range []struct {
		name, directory, to string
		extra               []string
		method, root        string
	}{
		{"named after the torrent", "/downloads/Show S01", "/media/tv", nil, "d.directory_base.set", "/media/tv/Show S01"},
		// Set by another tool with d.directory_base.set: d.directory.set would
		// look for the torrent's name instead, where the data never is.
		{"a folder of another name", "/downloads/Season One", "/media/tv/", nil, "d.directory_base.set", "/media/tv/Season One"},
		{"0.16.22's name for the setter", "/downloads/Show S01", "/", []string{"d.directory.base.set"}, "d.directory.base.set", "/Show S01"},
		// rtorrent leaves "." for a root of "/" or "": no folder to keep, so
		// it is named after the torrent, as an add names it.
		{"no folder of its own", ".", "/media", nil, "d.directory.set", "/media"},
		// Sent without trailing slashes, which d.directory.set would keep
		// before the name it appends ("/media//Show S01"); the base setter
		// is given the root as rtorrent would make it.
		{"a doubled trailing slash", "/downloads/Season One", "/media/tv//", nil, "d.directory_base.set", "/media/tv/Season One"},
		{"a doubled trailing slash, named on rtorrent's side", ".", "/media//", nil, "d.directory.set", "/media"},
		{"the root with a slash too many", "/downloads/Show S01", "//", nil, "d.directory_base.set", "/Show S01"},
	} {
		client := placed(c.directory, true, c.extra...).Answer("d.name", "Show S01")
		if err := newService(t, client, nil).SetDirectory(ctx, hash, c.to); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got, want := changes(client), movedWith(c.method, c.root); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func TestTheDirectoryOfferedChangesNothing(t *testing.T) {
	for _, c := range []struct {
		directory string
		multi     bool
		offered   []string
	}{
		{"/downloads/Show S01", true, []string{"/downloads", "/downloads/", "/downloads//"}},
		{"/downloads/Season One", true, []string{"/downloads"}},
		{"/downloads", false, []string{"/downloads", "/downloads/"}},
		{"/Show S01", true, []string{"/", "//"}},
		// d.directory.set given "/downloads//" keeps the slashes before the
		// name it appends; the UI offers the directory without them.
		{"/downloads//Show S01", true, []string{"/downloads", "/downloads/"}},
		{"//Show S01", true, []string{"/"}},
	} {
		client := placed(c.directory, c.multi)
		s := newService(t, client, nil)
		for _, offered := range c.offered {
			if err := s.SetDirectory(ctx, hash, offered); err != nil {
				t.Fatal(err)
			}
		}
		// Not even stopped: a selection already there stays as it was.
		if got := changes(client); len(got) != 0 {
			t.Errorf("%s: %v", c.directory, got)
		}
	}
	// A multi-file torrent offered its own folder is moved into it, as asked.
	client := placed("/downloads/Show S01", true)
	if err := newService(t, client, nil).SetDirectory(ctx, hash, "/downloads/Show S01"); err != nil {
		t.Fatal(err)
	}
	if got, want := changes(client), movedWith("d.directory_base.set", "/downloads/Show S01/Show S01"); !reflect.DeepEqual(got, want) {
		t.Errorf("%v", got)
	}
}

// A path that is not UTF-8 text reaches the server as a stand-in (see
// rtorrent/standin.go), which names another folder than the one on disk —
// and bytes that are not UTF-8, or an emoji, cannot be sent back as text.
func TestAFolderReportedByAStandInIsKeptByItsBytes(t *testing.T) {
	exact := []string{"d.base_path.base64", "d.name.base64"}
	move := func(t *testing.T, client *rtorrenttest.FakeClient, want []rtorrent.Call) {
		t.Helper()
		if err := newService(t, client, nil).SetDirectory(ctx, hash, "/media"); err != nil {
			t.Fatal(err)
		}
		if got := changes(client); !reflect.DeepEqual(got, want) {
			t.Errorf("%v", got)
		}
	}

	// From 0.16.13 the base path carries the bytes, and what the UI shows is
	// read from it: its directory changes nothing, another keeps the folder.
	// Under a directory that is not UTF-8 the whole path is escaped, the
	// folder's own text with it.
	escaped := placed("/downloads/Caf%E9/Caf%C3%A9 dir", true, exact...).
		Answer("d.base_path.base64", b64("/downloads/Caf\xe9/Café dir"))
	if err := newService(t, escaped, nil).SetDirectory(ctx, hash, "/downloads/Caf\uFFFD"); err != nil {
		t.Fatal(err)
	}
	if got := changes(escaped); len(got) != 0 {
		t.Errorf("the directory shown: %v", got)
	}
	move(t, escaped, movedWith("d.directory_base.set", "/media/Café dir"))

	// Changed since it last opened, the base path is the old root, but its
	// folder still fits the one reported.
	move(t, placed("/elsewhere/Caf%E9/Caf%C3%A9 dir", true, exact...).
		Answer("d.base_path.base64", b64("/downloads/Caf\xe9/Café dir")),
		movedWith("d.directory_base.set", "/media/Café dir"))

	// A folder named after its torrent that cannot be sent back — not UTF-8,
	// or an emoji, which xmlrpc-c refuses — is the one d.directory.set names,
	// bytes and all; before 0.16.13 nothing carries the bytes at all.
	for _, client := range []*rtorrenttest.FakeClient{
		placed("/downloads/Caf%E9 dir", true, exact...).
			Answer("d.base_path.base64", b64("/downloads/Caf\xe9 dir")).Answer("d.name.base64", b64("Caf\xe9 dir")),
		placed("/downloads/Song %F0%9F%8E%B5", true, exact...).
			Answer("d.base_path.base64", b64("/downloads/Song \U0001F3B5")).Answer("d.name.base64", b64("Song \U0001F3B5")),
		placed("/downloads/Caf? dir", true).Answer("d.name", "Caf? dir"),
	} {
		move(t, client, movedWith("d.directory.set", "/media"))
	}

	// Any other folder cannot be kept, and nothing is touched.
	for _, client := range []*rtorrenttest.FakeClient{
		placed("/downloads/Song %F0%9F%8E%B5", true, exact...).
			Answer("d.base_path.base64", b64("/downloads/Song \U0001F3B5")).Answer("d.name.base64", b64("Album")),
		placed("/downloads/Caf? dir", true).Answer("d.name", "Something else"),
	} {
		if code := status(t, newService(t, client, nil).SetDirectory(ctx, hash, "/media")); code != 502 || len(changes(client)) != 0 {
			t.Errorf("another name: %d %v", code, changes(client))
		}
	}

	// A stand-in above a plain folder is no stand-in for the folder.
	move(t, placed("/downloads/Caf?/Plain", true), movedWith("d.directory_base.set", "/media/Plain"))
}
