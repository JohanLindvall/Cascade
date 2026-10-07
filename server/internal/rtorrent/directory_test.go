// SPDX-License-Identifier: MIT

package rtorrent

import (
	"strings"
	"testing"
	"unicode/utf8"
)

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
		// d.directory.set keeps the slashes it was given before the name it
		// appends; the directory above is read without them, as a change is.
		{Row{"d.directory": "/downloads//Show S01", "d.is_multi_file": int64(1)}, "/downloads"},
		{Row{"d.directory": "//Show S01", "d.is_multi_file": int64(1)}, "/"},
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
		// Bytes rtorrent cannot be sent back: the encoder would make the first
		// "Caf\uFFFD", and xmlrpc-c refuses the second.
		{"not UTF-8", Row{"d.directory": "/downloads/Caf%E9",
			"d.base_path.base64": b64("/downloads/Caf\xe9")}, "", false},
		{"an emoji", Row{"d.directory": "/downloads/Song %F0%9F%8E%B5",
			"d.base_path.base64": b64("/downloads/Song \U0001F3B5")}, "", false},
	} {
		// The same whether a '?' may stand in for a byte or not.
		for _, questionMarks := range []bool{true, false} {
			if folder, ok := Folder(c.row, questionMarks); folder != c.folder || ok != c.ok {
				t.Errorf("%s, question marks %v: %q %v", c.name, questionMarks, folder, ok)
			}
		}
	}
}

// Before 0.16.3 a '?' may stand in for a byte; from there rtorrent sends %XX
// or no stand-in at all, and a folder whose only mark is a '?' is its name.
func TestAQuestionMarkStandsInOnlyBefore0163(t *testing.T) {
	for version, want := range map[string]bool{
		"0.9.8": true, "0.15.2": true, "0.16.2": true, "unknown": true, "": true,
		"0.16.3": false, "0.16.12": false, "0.16.25": false, "0.17.0": false,
	} {
		if got := QuestionMarksStandIn(version); got != want {
			t.Errorf("%q: %v", version, got)
		}
	}
	for _, c := range []struct {
		name          string
		row           Row
		before, after string // the folder kept before 0.16.3 and from it; "" for none
	}{
		// Never opened, no base path vouches for it; before 0.16.13 there are
		// no bytes to read at all.
		{"never opened", Row{"d.directory": "/downloads/What? X", "d.base_path.base64": ""}, "", "What? X"},
		{"no bytes to read", Row{"d.directory": "/downloads/Caf?", "d.base_path": "/downloads/Caf?"}, "", "Caf?"},
		{"vouched for", Row{"d.directory": "/downloads/What?", "d.base_path.base64": b64("/downloads/What?")}, "What?", "What?"},
		// Any other mark stands in still.
		{"and an escape", Row{"d.directory": "/downloads/What? Caf%E9"}, "", ""},
		{"and a line feed", Row{"d.directory": "/downloads/What?\nX"}, "", ""},
		{"and U+FFFD", Row{"d.directory": "/downloads/What? \uFFFD"}, "", ""},
		{"and an escape the base path undoes", Row{"d.directory": "/downloads/Caf%E9/What? Caf%C3%A9",
			"d.base_path.base64": b64("/downloads/Caf\xe9/What? Café")}, "What? Café", "What? Café"},
	} {
		for questionMarks, want := range map[bool]string{true: c.before, false: c.after} {
			if folder, ok := Folder(c.row, questionMarks); folder != want || ok != (want != "") {
				t.Errorf("%s, question marks %v: %q %v", c.name, questionMarks, folder, ok)
			}
		}
	}
}

func TestADirectoryIsTrimmedAsRtorrentKeepsOne(t *testing.T) {
	for directory, want := range map[string]string{
		"/downloads": "/downloads", "/downloads/": "/downloads", "/downloads//": "/downloads",
		"/": "/", "//": "/", "": "", ".": ".", "./": ".", "~/": "~",
	} {
		if got := TrimDirectory(directory); got != want {
			t.Errorf("%q: %q", directory, got)
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
		// Shortened by the libtorrent patch, emoji and all, as d.directory.set shortens it again.
		{"the name shortened", Row{"d.directory": "/downloads/" + EscapeCodes(fitComponent(longName)),
			"d.name.base64": b64(longName)}, true},
		{"another name shortened", Row{"d.directory": "/downloads/" + EscapeCodes(fitComponent(longName+"!")),
			"d.name.base64": b64(longName)}, false},
		// Before 0.16.13 the name is a stand-in too, and only the shape can be told.
		{"a stand-in shortened", Row{"d.directory": "/downloads/" + QuestionMarks(fitComponent(longName)),
			"d.name": QuestionMarks(longName)}, true},
		{"an escaped one shortened", Row{"d.directory": "/downloads/" + EscapeCodes(fitComponent(longName)),
			"d.name": EscapeCodes(longName)}, true},
		{"the shape of another name", Row{"d.directory": "/downloads/" + QuestionMarks(fitComponent("Other "+longName)),
			"d.name": QuestionMarks(longName)}, false},
		{"another name", Row{"d.directory": "/downloads/Caf?", "d.name": "Show S01"}, false},
		{"no name", Row{"d.directory": "/downloads/x"}, false},
	} {
		if got := NamedAfterTorrent(c.row); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

// longName is a multi-file torrent's name past the 255 bytes a path component may hold.
var longName = strings.Repeat("\U0001F3B5 Song ", 30) + "[FLAC]"

// The rule docker/patches/path_fit.h compiles into the image's libtorrent,
// held to the values its own test and the demo's port are held to.
func TestAComponentIsFittedAsTheImagesLibtorrentFitsIt(t *testing.T) {
	for _, same := range []string{"", "Some.Series.S01E01.mkv", strings.Repeat("a", 255)} {
		if got := fitComponent(same); got != same {
			t.Errorf("%q fitted to %q", same, got)
		}
	}
	if got, want := fitComponent(strings.Repeat("a", 300)+".bin"), strings.Repeat("a", 242)+"~d9bcc566.bin"; got != want {
		t.Errorf("%q, want %q", got, want)
	}
	if fitComponent(strings.Repeat("x", 300)+"A.bin") == fitComponent(strings.Repeat("x", 300)+"B.bin") {
		t.Error("names that differ past the cut collide")
	}
	for _, name := range []string{longName, strings.Repeat("\U0001F3B5", 80) + ".flac", strings.Repeat("w", 240) + strings.Repeat(" ", 30) + "tail.mkv"} {
		fitted := fitComponent(name)
		if len(fitted) > 255 || !utf8.ValidString(fitted) || strings.Contains(fitted, " ~") {
			t.Errorf("%q fitted to %q", name, fitted)
		}
	}
	if !strings.HasSuffix(fitComponent(strings.Repeat("\U0001F3B5", 80)+".flac"), ".flac") {
		t.Error("the extension was lost")
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
