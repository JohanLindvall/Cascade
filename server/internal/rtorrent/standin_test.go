// SPDX-License-Identifier: MIT

package rtorrent

// What rtorrent sends for text xmlrpc-c refuses, pinned to the C it comes
// from: string_with_escape_codes (libtorrent 0.16.7 and later; 0.16.3 to
// 0.16.6 garble it into a fault) and the '?' loop in object_to_xmlrpc
// (rtorrent before 0.16.3). The property that matters most is the last one: a
// stand-in never passes for the bytes themselves, or the delete would act on
// a path that is not there.

import (
	"math/rand"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/utf8text"
)

func TestTheStandInsAreWhatRtorrentSends(t *testing.T) {
	for _, c := range []struct{ raw, escaped, questioned string }{
		{"plain name.bin", "plain name.bin", "plain name.bin"},
		{"Caf\xe9 single on.bin", "Caf%E9 single on.bin", "Caf? single on.bin"},
		// Valid UTF-8, but outside what xmlrpc-c 1.51 holds: a byte each.
		{"Song \xf0\x9f\x8e\xb5.bin", "Song %F0%9F%8E%B5.bin", "Song ????.bin"},
		// '%' is printable and stands for itself; tab, LF and CR survive the
		// old loop, and xmlrpc-c turns the CR into a LF.
		{"100%E9\t\x7f", "100%E9%09%7F", "100%E9\t\x7f"},
		{"a\r\nb\rc\x00", "a%0D%0Ab%0Dc%00", "a\nb\nc?"},
	} {
		if got := EscapeCodes(c.raw); got != c.escaped {
			t.Errorf("EscapeCodes(%q) = %q, want %q", c.raw, got, c.escaped)
		}
		if got := QuestionMarks(c.raw); got != c.questioned {
			t.Errorf("QuestionMarks(%q) = %q, want %q", c.raw, got, c.questioned)
		}
		if !Reports(c.raw, c.escaped) || !Reports(c.raw, c.questioned) {
			t.Errorf("%q is not reported as its own stand-ins", c.raw)
		}
	}
	if got := lineFeeds("x\r\ny\rz"); got != "x\ny\nz" {
		t.Errorf("lineFeeds: %q", got)
	}
}

func TestOnlyTextThatCanBeAStandInIsTakenForOne(t *testing.T) {
	for reported, want := range map[string]bool{
		"/downloads/plain name.bin":       false,
		"/downloads/Caf%E9 single.bin":    true,
		"/downloads/Caf? old.bin":         true,
		"/downloads/x%0A":                 true,
		"/downloads/x%7F":                 true,
		"/downloads/50%20off%41.bin":      false, // escapes of printable bytes are never sent
		"/downloads/lower%e9.bin":         false, // nor in lower case
		"/downloads/trailing%E":           false,
		"/downloads/Café %E9 mix?.bin":    false, // text that is not ASCII is no escape stand-in
		"/downloads/a\nb":                 true,  // a line feed may have been a carriage return
		"/downloads/Caf\uFFFD single.bin": true,  // what a build without xmlrpc-c leaves us
	} {
		if got := MayStandIn(reported); got != want {
			t.Errorf("MayStandIn(%q) = %v, want %v", reported, got, want)
		}
	}
}

func TestReportsMatchesOnlyWhatABuildCouldSend(t *testing.T) {
	for _, c := range []struct {
		raw, reported string
		want          bool
	}{
		{"Caf\xe9.bin", "Caf%E9.bin", true},
		{"Caf%E9.bin", "Caf%E9.bin", true}, // the literal reading
		{"Caf\xe8.bin", "Caf%E9.bin", false},
		{"Caf\xe9.bin", "Caf?.bin", true},
		{"Caf\xe9.bin", "Caf\uFFFD.bin", true},
		{"Café.bin", "Caf%C3%A9.bin", true}, // escaped with the rest of its path
		{"Cafe.bin", "Caf?.bin", false},     // '?' stands for a byte that is not ASCII
		{"a\rb", "a\nb", true},
	} {
		if got := Reports(c.raw, c.reported); got != c.want {
			t.Errorf("Reports(%q, %q) = %v, want %v", c.raw, c.reported, got, c.want)
		}
	}
}

func TestAStandInNeverPassesForTheBytesThemselves(t *testing.T) {
	random := rand.New(rand.NewSource(1))
	alphabet := []byte("ab%E9?/ \t\r\n\x00\x7f\xc3\xa9\xe9\xf0\x9f\x8e\xb5\xff")
	for range 20000 {
		raw := make([]byte, random.Intn(12))
		for i := range raw {
			if random.Intn(3) == 0 {
				raw[i] = byte(random.Intn(256))
			} else {
				raw[i] = alphabet[random.Intn(len(alphabet))]
			}
		}
		for _, form := range []string{lineFeeds(string(raw)), EscapeCodes(string(raw)), QuestionMarks(string(raw)), utf8text.Decode(raw)} {
			if form != string(raw) && !MayStandIn(form) {
				t.Fatalf("%q stands for %q but passes for itself", form, raw)
			}
			if !Reports(string(raw), form) {
				t.Fatalf("%q is not reported as %q", raw, form)
			}
		}
	}
}
