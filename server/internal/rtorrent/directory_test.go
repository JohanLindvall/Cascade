// SPDX-License-Identifier: MIT

package rtorrent

import "testing"

func TestTheDataDirectoryIsWhereTheDataGoesNotTheTorrentsOwnFolder(t *testing.T) {
	for _, c := range []struct {
		row  Row
		want string
	}{
		{Row{"d.directory": "/downloads", "d.is_multi_file": int64(0)}, "/downloads"},
		{Row{"d.directory": "/downloads/Show S01", "d.is_multi_file": int64(1)}, "/downloads"},
		// The folder's name plays no part: the directory above it is the answer.
		{Row{"d.directory": "/downloads/Season One", "d.name": "Show S01", "d.is_multi_file": int64(1)}, "/downloads"},
		{Row{"d.directory": "/Show S01", "d.is_multi_file": int64(1)}, "/"},
		{Row{"d.directory": ".", "d.is_multi_file": int64(1)}, ""},
		// The stand-in read from the base path, as the listing shows it.
		{Row{"d.directory": "/downloads/Caf%E9/Plain", "d.is_multi_file": int64(1),
			"d.base_path.base64": b64("/downloads/Caf\xe9/Plain")}, "/downloads/Caf\uFFFD"},
		// Changed since it last opened: the base path is another place.
		{Row{"d.directory": "/elsewhere/Caf%E9", "d.is_multi_file": int64(0),
			"d.base_path.base64": b64("/downloads/Caf\xe9/x.bin")}, "/elsewhere/Caf%E9"},
	} {
		if got := DataDirectory(c.row); got != c.want {
			t.Errorf("%v: %q, want %q", c.row, got, c.want)
		}
	}
}

func TestAFolderIsKeptByItsBytesOrNotAtAll(t *testing.T) {
	for _, c := range []struct {
		name   string
		row    Row
		folder string
		ok     bool
	}{
		{"plain", Row{"d.directory": "/downloads/Season One"}, "Season One", true},
		{"UTF-8 text is no stand-in", Row{"d.directory": "/downloads/Café"}, "Café", true},
		{"a stand-in above it", Row{"d.directory": "/downloads/Caf%E9/Plain"}, "Plain", true},
		{"no folder of its own", Row{"d.directory": "."}, "", true},
		// A path that is not UTF-8 is escaped whole, the text below it too.
		{"from the base path", Row{"d.directory": "/downloads/Caf%E9/Caf%C3%A9",
			"d.base_path.base64": b64("/downloads/Caf\xe9/Café")}, "Café", true},
		{"from a base path a change left behind", Row{"d.directory": "/elsewhere/Caf%E9/Caf%C3%A9",
			"d.base_path.base64": b64("/downloads/Caf\xe9/Café")}, "Café", true},
		{"a literal question mark", Row{"d.directory": "/downloads/What?",
			"d.base_path.base64": b64("/downloads/What?")}, "What?", true},
		{"a base path of another folder", Row{"d.directory": "/downloads/Caf%E9",
			"d.base_path.base64": b64("/downloads/Other")}, "", false},
		{"never opened", Row{"d.directory": "/downloads/Caf%E9", "d.base_path.base64": ""}, "", false},
		// Before 0.16.13 the base path is a stand-in too.
		{"no bytes to read", Row{"d.directory": "/downloads/Caf?", "d.base_path": "/downloads/Caf?"}, "", false},
		// Bytes rtorrent cannot be sent back: the encoder would make the first
		// "Caf\uFFFD", and xmlrpc-c refuses the second.
		{"not UTF-8", Row{"d.directory": "/downloads/Caf%E9",
			"d.base_path.base64": b64("/downloads/Caf\xe9")}, "", false},
		{"an emoji", Row{"d.directory": "/downloads/Song %F0%9F%8E%B5",
			"d.base_path.base64": b64("/downloads/Song \U0001F3B5")}, "", false},
	} {
		if folder, ok := Folder(c.row); folder != c.folder || ok != c.ok {
			t.Errorf("%s: %q %v", c.name, folder, ok)
		}
	}
}

func TestWhatRtorrentCanBeSentAsText(t *testing.T) {
	for text, want := range map[string]bool{
		"Season One":        true,
		"Café 中文 tab\there": true,
		"x\uFFFDy":          true,
		"Caf\xe9":           false,
		"Song \U0001F3B5":   false,
		"\uFFFE":            false,
		"a\rb":              false,
		"a\x01b":            false,
	} {
		if got := Sendable(text); got != want {
			t.Errorf("%q: %v", text, got)
		}
	}
}

func TestAFolderNamedAfterItsTorrent(t *testing.T) {
	for _, c := range []struct {
		name string
		row  Row
		want bool
	}{
		{"the same stand-in", Row{"d.directory": "/downloads/Caf? dir", "d.name": "Caf? dir"}, true},
		{"the name as bytes", Row{"d.directory": "/downloads/Caf%E9", "d.name.base64": b64("Caf\xe9")}, true},
		// A name that is text, under a path that is not: the whole path is the stand-in.
		{"the name as text", Row{"d.directory": "/downloads/Caf?/Caf??", "d.name": "Café"}, true},
		{"another name", Row{"d.directory": "/downloads/Caf?", "d.name": "Show S01"}, false},
		{"no name", Row{"d.directory": "/downloads/x"}, false},
	} {
		if got := NamedAfterTorrent(c.row); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func TestJoiningADirectoryAsDDirectorySetDoes(t *testing.T) {
	for _, c := range [][3]string{
		{"/media", "X", "/media/X"},
		{"/media/", "X", "/media/X"},
		{"/", "X", "/X"},
		{"", "X", "X"},
	} {
		if got := JoinDirectory(c[0], c[1]); got != c[2] {
			t.Errorf("%q + %q: %q", c[0], c[1], got)
		}
	}
}
