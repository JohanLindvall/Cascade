// SPDX-License-Identifier: MIT

package utf8text

import "testing"

func TestDecodeReplacesEachIllFormedSubsequenceOnce(t *testing.T) {
	for _, c := range []struct {
		in   string
		want string
	}{
		{"plain", "plain"},
		{"caf\xc3\xa9", "café"},
		{"ab\xffcd", "ab\uFFFDcd"},
		// A truncated four-byte sequence is one error, not three.
		{"\xf0\x9f\x98", "\uFFFD"},
		{"\xf0\x9f\x98x", "\uFFFDx"},
		{"\xe2\x82x", "\uFFFDx"},
		// A surrogate's lead is refused at its second byte; the rest are
		// stray continuations.
		{"\xed\xa0\x80", "\uFFFD\uFFFD\uFFFD"},
		{"\xc0\xaf", "\uFFFD\uFFFD"},
		{"\xf4\x90\x80\x80", "\uFFFD\uFFFD\uFFFD\uFFFD"},
		{"\xf0\x9f\x98\x80", "😀"},
	} {
		if got := Decode([]byte(c.in)); got != c.want {
			t.Errorf("Decode(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
