// SPDX-License-Identifier: MIT

package validate

import (
	"errors"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

func TestWhatRtorrentCanBeSentAsText(t *testing.T) {
	for text, want := range map[string]bool{
		"":                  true,
		"Season One":        true,
		"Café 中文 tab\there": true,
		"line\nfeed":        true,
		"x\uFFFDy":          true,
		"\uFFFD":            true,
		"last of the BMP \uFFFD and before it \uD7FF\uE000": true,
		"Caf\xe9":         false,
		"Song \U0001F3B5": false,
		"\U00010000":      false,
		"\uFFFE":          false,
		"\uFFFF":          false,
		"a\rb":            false,
		"a\x01b":          false,
		"a\x1fb":          false,
	} {
		if got := Sendable(text); got != want {
			t.Errorf("%q: %v", text, got)
		}
	}
}

// message is the 400 an error is, or fails the test.
func message(t *testing.T, err error) string {
	t.Helper()
	var failure *httperr.Error
	if !errors.As(err, &failure) || failure.Status != 400 {
		t.Fatalf("want a 400, got %v", err)
	}
	return failure.Message
}

func TestRtorrentTextNamesTheFieldAndWhatItHolds(t *testing.T) {
	for text, want := range map[string]string{
		"/downloads/films \U0001F3AC": `"directory" contains "` + "\U0001F3AC" + `" (U+1F3AC): rtorrent's XML-RPC layer ` +
			`takes no character beyond U+FFFF, such as an emoji`,
		"Caf\xe9 dir":   `"directory" contains a byte that is not UTF-8 (0xE9)`,
		"a\uFFFEb":      `"directory" contains U+FFFE, which XML cannot carry`,
		"two\r\nlines":  `"directory" contains a carriage return, which XML reads as a line feed`,
		"bell\x07":      `"directory" contains U+0007, a control character XML cannot carry`,
		"\U0001F600\r":  `"directory" contains "` + "\U0001F600" + `" (U+1F600): rtorrent's XML-RPC layer takes no character beyond U+FFFF, such as an emoji`,
		"first \r then": `"directory" contains a carriage return, which XML reads as a line feed`,
	} {
		if got := message(t, RtorrentText(text, "directory")); got != want {
			t.Errorf("%q: %s", text, got)
		}
	}
	if err := RtorrentText("/downloads/Café \uFFFD", "directory"); err != nil {
		t.Error(err)
	}
}

func TestRtorrentStringIsStringAndSendable(t *testing.T) {
	if got, err := RtorrentString(" /media/tv ", "directory", false); got != "/media/tv" || err != nil {
		t.Errorf("%q %v", got, err)
	}
	if got, err := RtorrentString("   ", "throttle", true); got != "" || err != nil {
		t.Errorf("%q %v", got, err)
	}
	for _, value := range []any{nil, float64(1), "   ", "a\x00b", "tv \U0001F4FA"} {
		_, err := RtorrentString(value, "throttle", false)
		refused(t, err, "throttle")
	}
}

func TestADirectoryIsNeverTheRoot(t *testing.T) {
	for _, text := range []string{"/", "//", " /// "} {
		got, err := Directory(text, "directory", true)
		if want := `"directory" cannot be "/": rtorrent strips a directory's trailing slashes and would put a single ` +
			`file in ".", the directory it runs in`; got != "" || message(t, err) != want {
			t.Errorf("%q: %q %v", text, got, err)
		}
	}
	// The root's own directories are directories like any other.
	for text, want := range map[string]string{"/media": "/media", "/media/": "/media/", "/.": "/.", ".": ".", "~": "~"} {
		if got, err := Directory(text, "directory", false); got != want || err != nil {
			t.Errorf("%q: %q %v", text, got, err)
		}
	}
	// Nothing at all is an add's default directory, where the caller allows it.
	if got, err := Directory("  ", "directory", true); got != "" || err != nil {
		t.Errorf("%q %v", got, err)
	}
	_, err := Directory("  ", "directory", false)
	refused(t, err, "directory")
	_, err = Directory("/films \U0001F3AC", "directory", true)
	refused(t, err, "directory")
}
