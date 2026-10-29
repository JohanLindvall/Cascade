// SPDX-License-Identifier: MIT

package redact

import "testing"

func TestCredentialsAreNotSearchable(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"http://t.example/a?passkey=secret&info=keep", "http://t.example/a?passkey=•••&info=keep"},
		{"https://t.example/a?authkey=abc&torrent_pass=def", "https://t.example/a?authkey=•••&torrent_pass=•••"},
		{"https://t.example/a?PassKey=X", "https://t.example/a?PassKey=•••"},
		{"https://t.example/a?%70asskey=secret", "https://t.example/a?%70asskey=•••"},
		{"https://me:p@ssword@t.example/a", "https://•••@t.example/a"},
		{"https://t.example/0123456789abcdef0123456789abcdef/announce", "https://t.example/•••/announce"},
		{"https://t.example/abcde-fghij_klmno.pqrst/announce", "https://t.example/•••/announce"},
		{"https://t.example/%30%31%32%33%34%35%36%37%38%39abcdefghijkl/a", "https://t.example/•••/a"},
		{"http://abcdefghijklmnopqrstuvwxyz/announce", "http://abcdefghijklmnopqrstuvwxyz/announce"},
		{"http://[::1]:6969/announce", "http://[::1]:6969/announce"},
		{"http://t.example/tracker-v2/announce", "http://t.example/tracker-v2/announce"},
		{"Tracker: [Timeout was reached]", "Tracker: [Timeout was reached]"},
		{"ABCDEF0123456789->tracker: [https://t.example/a?pk=secret]", "ABCDEF0123456789->tracker: [https://t.example/a?pk=•••]"},
		{"see (https://t.example/a?pk=secret).", "see (https://t.example/a?pk=•••)."},
		{"http://t.example/?pk=1\u00a0https://t.example/?token=2", "http://t.example/?pk=•••\u00a0https://t.example/?token=•••"},
	} {
		if got := Secrets(tc.input); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.input, got, tc.want)
		}
	}
}
