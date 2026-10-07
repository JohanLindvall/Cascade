// SPDX-License-Identifier: MIT

package rtorrent

// MapTorrent turns raw multicall rows into what the whole UI shows. The
// status derivation is the part with real branches — and the part where a
// transient tracker message must not paint a healthy torrent red.

import (
	"strings"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
)

func row(over Row) Row {
	r := Row{
		"d.hash":            strings.Repeat("A", 40),
		"d.name":            "a release",
		"d.size_bytes":      int64(1000),
		"d.completed_bytes": int64(500),
		"d.left_bytes":      int64(500),
		"d.down.rate":       int64(100),
		"d.up.rate":         int64(0),
		"d.is_open":         int64(1),
		"d.is_active":       int64(1),
		"d.complete":        int64(0),
		"d.hashing":         int64(0),
		"d.hashing_failed":  int64(0),
		"d.message":         "",
		"d.ratio":           int64(1500),
	}
	for key, value := range over {
		r[key] = value
	}
	return r
}

func TestStatusFollowsTheLifecycle(t *testing.T) {
	for _, c := range []struct {
		over Row
		want contracts.TorrentStatus
	}{
		{nil, contracts.StatusDownloading},
		{Row{"d.complete": int64(1)}, contracts.StatusSeeding},
		{Row{"d.is_active": int64(0)}, contracts.StatusPaused},
		{Row{"d.is_open": int64(0), "d.is_active": int64(0)}, contracts.StatusStopped},
		{Row{"d.hashing": int64(2)}, contracts.StatusChecking},
		{Row{"d.hashing_failed": int64(1)}, contracts.StatusError},
	} {
		if got := MapTorrent(row(c.over), 0).Status; got != c.want {
			t.Errorf("%v: %s, want %s", c.over, got, c.want)
		}
	}
}

func TestATrackerWhingeIsNotAnErrorAnythingElseIs(t *testing.T) {
	if got := MapTorrent(row(Row{"d.message": "Tracker: [Timeout was reached]"}), 0).Status; got != contracts.StatusDownloading {
		t.Errorf("tracker message: %s", got)
	}
	if got := MapTorrent(row(Row{"d.message": "tracker: lower case too"}), 0).Status; got != contracts.StatusDownloading {
		t.Errorf("lower-case tracker message: %s", got)
	}
	if got := MapTorrent(row(Row{"d.message": "Storage error: no space"}), 0).Status; got != contracts.StatusError {
		t.Errorf("storage error: %s", got)
	}
}

func eta(t contracts.Torrent) string {
	if t.ETA == nil {
		return "null"
	}
	return Text(*t.ETA)
}

func TestETANeedsARateAndSomethingLeftDoneMeansZero(t *testing.T) {
	for _, c := range []struct {
		over Row
		want string
	}{
		{nil, "5"}, // 500 left at 100/s
		{Row{"d.down.rate": int64(0)}, "null"},
		{Row{"d.complete": int64(1), "d.left_bytes": int64(0)}, "0"},
		// Rounded half up: 250 left at 100/s.
		{Row{"d.left_bytes": int64(250)}, "3"},
		{Row{"d.left_bytes": int64(249)}, "2"},
	} {
		if got := eta(MapTorrent(row(c.over), 0)); got != c.want {
			t.Errorf("%v: eta %s, want %s", c.over, got, c.want)
		}
	}
}

func TestRatioIsScaledFromMilleProgressIsClamped(t *testing.T) {
	torrent := MapTorrent(row(nil), 0)
	if torrent.Ratio != 1.5 || torrent.Progress != 0.5 {
		t.Fatalf("ratio %v progress %v", torrent.Ratio, torrent.Progress)
	}
	if got := MapTorrent(row(Row{"d.completed_bytes": int64(2000)}), 0).Progress; got != 1 {
		t.Errorf("over-complete progress %v", got)
	}
	if got := MapTorrent(row(Row{"d.size_bytes": int64(0)}), 0).Progress; got != 0 {
		t.Errorf("empty torrent progress %v", got)
	}
}

func TestLabelsDecodeTheRuTorrentWayAndBadEscapesSurvive(t *testing.T) {
	for raw, want := range map[string]string{
		"tv%20shows":    "tv shows",
		"100%":          "100%",
		"a+b":           "a+b",
		"%E2%9C%93":     "✓",
		"%zz":           "%zz",
		"%C3":           "%C3",
		"%C3x":          "%C3x",
		"%C3%28":        "%C3%28",
		"%ED%A0%80":     "%ED%A0%80", // a surrogate
		"%C0%AF":        "%C0%AF",    // overlong
		"plain":         "plain",
		"%F0%9F%98%80!": "😀!",
	} {
		if got := MapTorrent(row(Row{"d.custom1": raw}), 0).Label; got != want {
			t.Errorf("label %q decoded as %q, want %q", raw, got, want)
		}
	}
}

func TestEveryDeclaredFieldIsAskedForAtMostOnce(t *testing.T) {
	for name, fields := range map[string][]string{"torrent": TorrentFields, "file": FileFields, "peer": PeerFields, "tracker": TrackerFields} {
		seen := map[string]bool{}
		for _, field := range fields {
			if seen[field] {
				t.Errorf("%s field %s is listed twice", name, field)
			}
			seen[field] = true
		}
	}
}

func TestTrackerHostReadsHostnamesFromTrackerURLsOfAnyScheme(t *testing.T) {
	for raw, want := range map[string]string{
		"http://t.example.net:6969/announce": "t.example.net",
		"udp://t.example.net:6969":           "t.example.net",
		"not a url":                          "unknown",
		"":                                   "unknown",
		"udp:opaque":                         "unknown",
		"HTTPS://User:Pass@T.Example.NET/a":  "t.example.net",
		// Only a special scheme's host is a domain the browser lower-cases.
		"udp://T.Example.NET:80":     "T.Example.NET",
		"http://[::1]:8080/announce": "[::1]",
	} {
		if got := TrackerHost(raw); got != want {
			t.Errorf("TrackerHost(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestFilesPeersAndTrackersMapTheirBooleansAndScaledNumbers(t *testing.T) {
	file := MapFile(Row{"f.path": "dir/a.bin", "f.size_bytes": int64(10), "f.completed_chunks": int64(1),
		"f.size_chunks": int64(4), "f.priority": int64(2), "f.is_created": int64(1)}, 3)
	if file.Index != 3 || file.Progress != 0.25 || !file.Created || file.OnDisk != "" || file.Size != 10 || file.Priority != 2 {
		t.Fatalf("file %#v", file)
	}
	if got := MapFile(Row{"f.size_chunks": int64(0)}, 0).Progress; got != 0 {
		t.Errorf("chunkless progress %v", got)
	}

	// The on-disk name is reported only when libtorrent shortened it.
	if got := MapFile(Row{"f.path": "dir/a.bin", "f.frozen_path": "/downloads/rel/dir/a.bin"}, 0).OnDisk; got != "" {
		t.Errorf("same name reported as %q", got)
	}
	cut := MapFile(Row{"f.path": "dir/" + strings.Repeat("x", 300) + ".bin", "f.frozen_path": "/downloads/rel/dir/xxx~1a2b3c4d.bin"}, 0)
	if cut.OnDisk != "xxx~1a2b3c4d.bin" {
		t.Errorf("shortened name reported as %q", cut.OnDisk)
	}
	if got := MapFile(Row{"f.path": "a.bin", "f.frozen_path": ""}, 0).OnDisk; got != "" { // never opened
		t.Errorf("unopened file reported as %q", got)
	}

	// rtorrent sends a stand-in for a string as a whole: under a directory
	// that is not UTF-8 the frozen path arrives escaped while f.path does not,
	// and the name is still the same one.
	for _, frozen := range []string{"/downloads/Caf%E9 dir/Caf%C3%A9.txt", "/downloads/Caf? dir/Caf??.txt"} {
		if got := MapFile(Row{"f.path": "Café.txt", "f.frozen_path": frozen}, 0).OnDisk; got != "" {
			t.Errorf("%q: the same name reported as %q", frozen, got)
		}
	}
	escapedCut := MapFile(Row{"f.path": "Caf%E9 " + strings.Repeat("x", 300) + ".bin",
		"f.frozen_path": "/downloads/Caf%E9 xxx~1a2b3c4d.bin"}, 0)
	if escapedCut.OnDisk != "Caf%E9 xxx~1a2b3c4d.bin" {
		t.Errorf("shortened escaped name reported as %q", escapedCut.OnDisk)
	}

	peer := MapPeer(Row{"p.address": "10.0.0.1", "p.port": int64(6881), "p.completed_percent": int64(50),
		"p.is_encrypted": int64(1), "p.is_incoming": int64(0)})
	if peer.Progress != 0.5 || !peer.Encrypted || peer.Incoming || peer.Client != "" || peer.Port != 6881 || peer.Address != "10.0.0.1" {
		t.Fatalf("peer %#v", peer)
	}

	tracker := MapTracker(Row{"t.url": "udp://t/x", "t.is_enabled": int64(1), "t.scrape_complete": int64(7), "t.type": int64(2)}, 1)
	if tracker.Index != 1 || !tracker.Enabled || tracker.Seeders != 7 || tracker.Type != 2 || tracker.URL != "udp://t/x" {
		t.Fatalf("tracker %#v", tracker)
	}
}

func TestEightBitStringsArriveAsBytesAndReadAsText(t *testing.T) {
	torrent := MapTorrent(row(Row{"d.name": []byte("nämn"), "d.size_bytes": "lots"}), 0)
	if torrent.Name != "nämn" || torrent.Size != 0 {
		t.Fatalf("name %q size %d", torrent.Name, torrent.Size)
	}
}

func TestFieldsTheBackendLacksMapToZeroAndEmpty(t *testing.T) {
	torrent := MapTorrent(Row{}, 42)
	if torrent.Hash != "" || torrent.Size != 0 || torrent.ETA != nil || torrent.AddedAt != 42 ||
		torrent.Status != contracts.StatusStopped {
		t.Fatalf("%#v", torrent)
	}
	// A list or struct where text belongs reads as "", not as its rendering.
	if got := MapTorrent(row(Row{"d.name": []any{"x"}}), 0).Name; got != "" {
		t.Fatalf("name %q", got)
	}
	// Integers past 2^53 come through exactly.
	if got := MapTorrent(row(Row{"d.size_bytes": int64(1)<<62 + 1}), 0).Size; got != int64(1)<<62+1 {
		t.Fatalf("size %d", got)
	}
}
