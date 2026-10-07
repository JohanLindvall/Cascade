// SPDX-License-Identifier: MIT

package service

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent/rtorrenttest"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// singleFile is a minimal valid .torrent and the info hash rtorrent will list
// it under.
func singleFile(t *testing.T) ([]byte, string) {
	t.Helper()
	pieces := strings.Repeat("\x07", 20)
	info := "d6:lengthi1e4:name5:a.bin12:piece lengthi16384e6:pieces20:" + pieces + "e"
	sum := sha1.Sum([]byte(info))
	return []byte("d4:info" + info + "e"), strings.ToUpper(hex.EncodeToString(sum[:]))
}

// loadedBy is a session that holds infoHash once load has been called, and
// answers d.hash for it with rtorrent's not-found fault until then.
func loadedBy(client *rtorrenttest.FakeClient, load, infoHash string) *rtorrenttest.FakeClient {
	var loaded atomic.Bool
	return client.
		Answer(load, func([]any) any { loaded.Store(true); return 0 }).
		Answer("d.hash", func([]any) (any, error) {
			if !loaded.Load() {
				return nil, &xmlrpc.Fault{Code: -501, Message: "Could not find info-hash."}
			}
			return infoHash, nil
		})
}

func TestAnUploadIsLoadedWithItsOptionsAndConfirmedByItsHash(t *testing.T) {
	data, infoHash := singleFile(t)
	client := loadedBy(backend(), "load.raw_start", infoHash)
	s := newService(t, client, nil)
	err := s.AddTorrentFile(ctx, data, contracts.LoadOptions{Start: true, Directory: `/downloads/a "b"`, Label: "x&y"})
	if err != nil {
		t.Fatal(err)
	}
	load := params(client.CallsTo("load.raw_start"), 0)
	want := []any{"", data, `d.directory.set="/downloads/a \"b\""`, `d.custom1.set="x%26y"`}
	if !reflect.DeepEqual(load, want) {
		t.Fatalf("%#v", load)
	}
	// Not started: the plain load.
	client = loadedBy(backend(), "load.raw", infoHash)
	s = newService(t, client, nil)
	if err := s.AddTorrentFile(ctx, data, contracts.LoadOptions{}); err != nil || len(client.CallsTo("load.raw")) != 1 {
		t.Fatalf("%v %v", err, client.CallsTo("load.raw"))
	}
}

func TestATorrentTheSessionHoldsIsA409NamingItAndIsNotLoadedAgain(t *testing.T) {
	data, infoHash := singleFile(t)
	for name, add := range map[string]func(s subject) error{
		"a file": func(s subject) error {
			return s.AddTorrentFile(ctx, data, contracts.LoadOptions{Start: true, Label: "new label"})
		},
		"a magnet": func(s subject) error {
			return s.AddTorrentURL(ctx, "magnet:?xt=urn:btih:"+strings.ToLower(infoHash), contracts.LoadOptions{Start: true})
		},
	} {
		client := backend().Answer("d.hash", infoHash).Answer("d.name", "Already here")
		err := add(newService(t, client, nil))
		if status(t, err) != 409 || !strings.Contains(err.Error(), `"Already here" is already loaded`) {
			t.Errorf("%s: %v", name, err)
		}
		// rtorrent would drop the load, and the label with it, without a word.
		for _, method := range []string{"load.raw_start", "load.start", "d.custom1.set"} {
			if calls := client.CallsTo(method); len(calls) != 0 {
				t.Errorf("%s: %s was called: %v", name, method, calls)
			}
		}
	}
}

func TestATorrentAlreadyLoadedIsNamedByItsExactBytesWhereRtorrentSendsThem(t *testing.T) {
	data, infoHash := singleFile(t)
	// d.name is the stand-in an emoji gets; the .base64 variant the bytes.
	client := backend("d.name.base64").Answer("d.hash", infoHash).Answer("d.name", "Song %F0%9F%8E%B5").
		Answer("d.name.base64", base64.StdEncoding.EncodeToString([]byte("Song \U0001F3B5")))
	err := newService(t, client, nil).AddTorrentFile(ctx, data, contracts.LoadOptions{Start: true})
	if status(t, err) != 409 || !strings.Contains(err.Error(), "\"Song \U0001F3B5\" is already loaded") {
		t.Fatalf("%v", err)
	}
}

func TestAnUploadRtorrentNeverListsIsA502NamingIt(t *testing.T) {
	data, _ := singleFile(t)
	client := backend().Answer("d.hash", &xmlrpc.Fault{Code: -501, Message: "Could not find info-hash."})
	s := newService(t, client, nil)
	fastClock(s)
	err := s.AddTorrentFile(ctx, data, contracts.LoadOptions{Start: true})
	if status(t, err) != 502 || !strings.Contains(err.Error(), `"a.bin"`) {
		t.Fatalf("%v", err)
	}
}

func TestBadAddsAreRefusedWithoutAskingRtorrent(t *testing.T) {
	down := rtorrenttest.New(nil) // no command table: every call faults
	s := newService(t, down, nil)
	data, _ := singleFile(t)
	for name, err := range map[string]error{
		"junk":                    s.AddTorrentFile(ctx, []byte("junk"), contracts.LoadOptions{Start: true}),
		"a line break":            s.AddTorrentFile(ctx, data, contracts.LoadOptions{Directory: "/downloads\nexecute.throw=rm"}),
		"a URL line break":        s.AddTorrentURL(ctx, "magnet:?xt=urn:btih:"+hash, contracts.LoadOptions{Directory: "a\rb"}),
		"a directory command":     s.AddTorrentFile(ctx, data, contracts.LoadOptions{Directory: "$execute=/bin/true"}),
		"a URL directory command": s.AddTorrentURL(ctx, "https://example.test/file.torrent", contracts.LoadOptions{Directory: "$execute=/bin/true"}),
		"no link":                 s.AddTorrentURL(ctx, "not a link", contracts.LoadOptions{}),
		"no magnet hash":          s.AddTorrentURL(ctx, "magnet:?dn=x", contracts.LoadOptions{}),
	} {
		if got := status(t, err); got != 400 {
			t.Errorf("%s: %d", name, got)
		}
	}
	if calls := down.Calls(); len(calls) != 0 {
		t.Fatalf("rtorrent was asked %v", calls)
	}
}

func TestPerTorrentDetailsAreMappedRowByRow(t *testing.T) {
	fields := slices.Concat(rtorrent.FileFields, rtorrent.PeerFields, rtorrent.TrackerFields, []string{"f.multicall", "p.multicall", "t.multicall"})
	client := backend(fields...).
		Answer("f.multicall", func(p []any) any {
			if !reflect.DeepEqual(p[:2], []any{hash, ""}) {
				t.Errorf("f.multicall %v", p)
			}
			return []any{[]any{"a/b.bin"}, []any{"c.bin"}}
		}).
		Answer("p.multicall", []any{[]any{"PEERID"}}).
		Answer("t.multicall", []any{[]any{"https://tracker.example/announce"}})
	s := newService(t, client, nil)
	files, err := s.Files(ctx, hash)
	if err != nil || len(files) != 2 || files[1].Index != 1 || files[0].Path == "" {
		t.Fatalf("%+v %v", files, err)
	}
	peers, err := s.Peers(ctx, hash)
	if err != nil || len(peers) != 1 {
		t.Fatalf("%+v %v", peers, err)
	}
	trackers, err := s.Trackers(ctx, hash)
	if err != nil || len(trackers) != 1 || trackers[0].Index != 0 {
		t.Fatalf("%+v %v", trackers, err)
	}
}

func TestTrackerHostsNameEachTorrentsFirstTracker(t *testing.T) {
	other := strings.Repeat("B", 40)
	client := backend("t.multicall").Answer("t.multicall", func(p []any) (any, error) {
		if p[0] == other {
			return nil, &xmlrpc.Fault{Code: -501, Message: "Could not find info-hash."}
		}
		return []any{[]any{"udp://Tracker.Example:6969/announce"}, []any{"https://second.example/a"}}, nil
	})
	s := newService(t, client, nil)
	hosts, err := s.TrackerHosts(ctx, []string{hash, other})
	if err != nil || !reflect.DeepEqual(hosts, map[string]string{hash: "Tracker.Example", other: "unknown"}) {
		t.Fatalf("%v %v", hosts, err)
	}
	if hosts, err := s.TrackerHosts(ctx, nil); err != nil || len(hosts) != 0 {
		t.Fatalf("nothing asked: %v %v", hosts, err)
	}
}

func TestStatusCountsTheListItReads(t *testing.T) {
	client := backend().Answer("d.multicall2", []any{[]any{hash, "a"}, []any{strings.Repeat("B", 40), "b"}})
	s := newService(t, client, nil)
	status, err := s.Status(ctx)
	if err != nil || status.TorrentCount != 2 || !status.Connected {
		t.Fatalf("%+v %v", status, err)
	}
}

func TestTheSettersSendWhatRtorrentExpects(t *testing.T) {
	client := backend("d.priority.set", "d.uploads_max.set", "d.downloads_max.set", "f.priority.set",
		"d.update_priorities", "t.is_enabled.set", "d.tracker.insert", "d.save_full_session")
	s := newService(t, client, nil)
	two, three := int64(2), int64(3)
	for _, err := range []error{
		s.SetPriority(ctx, hash, 3),
		s.SetLabel(ctx, hash, "tv shows"),
		s.SetTorrentSlots(ctx, hash, &two, &three),
		s.SetTorrentSlots(ctx, hash, nil, nil),
		s.SetFilePriority(ctx, hash, 2, 0),
		s.SetTrackerEnabled(ctx, hash, 1, true),
		s.AddTracker(ctx, hash, "udp://t.example:1/announce", 0),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	for method, want := range map[string][]any{
		"d.priority.set":      {hash, int64(3)},
		"d.custom1.set":       {hash, "tv%20shows"},
		"d.uploads_max.set":   {hash, int64(2)},
		"d.downloads_max.set": {hash, int64(3)},
		"f.priority.set":      {hash + ":f2", int64(0)},
		"d.update_priorities": {hash},
		"t.is_enabled.set":    {hash + ":t1", 1},
		"d.tracker.insert":    {hash, int64(0), "udp://t.example:1/announce"},
		"d.save_full_session": {hash},
	} {
		calls := client.CallsTo(method)
		if len(calls) != 1 || !reflect.DeepEqual(calls[0].Params, want) {
			t.Errorf("%s: %#v", method, calls)
		}
	}
}

func TestSettersABuildLacksAreRefusedWith501(t *testing.T) {
	bare := rtorrenttest.New(rtorrenttest.Answers{"system.listMethods": []any{"system.listMethods"}})
	s := newService(t, bare, nil)
	one := int64(1)
	for name, err := range map[string]error{
		"label":      s.SetLabel(ctx, hash, "x"),
		"slots":      s.SetTorrentSlots(ctx, hash, &one, nil),
		"tracker":    s.SetTrackerEnabled(ctx, hash, 0, false),
		"insert":     s.AddTracker(ctx, hash, "udp://t.example:1/announce", 0),
		"throttle":   s.SetTorrentThrottle(ctx, hash, "slow"),
		"group":      s.SaveThrottle(ctx, contracts.ThrottleGroup{Name: "slow"}),
		"directory":  s.SetDirectory(ctx, hash, "/x"),
		"announce":   s.Action(ctx, hash, "announce"),
		"log scopes": func() error { _, err := s.SetLogScopes(ctx, []string{"debug"}); return err }(),
	} {
		if got := status(t, err); got != 501 {
			t.Errorf("%s: %d", name, got)
		}
	}
	for _, call := range bare.Calls() {
		if call.Method != "system.listMethods" && !strings.HasPrefix(call.Method, "system.") {
			t.Errorf("%s reached rtorrent", call.Method)
		}
	}
}

func TestFreeSpaceIsReadAtMostOnceEveryFewSeconds(t *testing.T) {
	s := newService(t, backend(), nil)
	now := time.Unix(1_800_000_000, 0)
	s.now = func() time.Time { return now }
	first := s.diskFree()
	if first == nil {
		t.Fatal("no free space for an existing directory")
	}
	if err := os.Remove(s.cfg.DownloadDir); err != nil {
		t.Fatal(err)
	}
	if again := s.diskFree(); again == nil || *again != *first {
		t.Fatal("the free space was read again within the window")
	}
	now = now.Add(diskFreeTTL)
	if gone := s.diskFree(); gone != nil {
		t.Fatalf("a volume that went away still reports %d free", *gone)
	}
}

func TestFilteredViewsReadWithoutBookkeeping(t *testing.T) {
	client := backend().Answer("d.multicall2", func(p []any) any {
		return []any{[]any{hash, "view " + strconv.Quote(p[1].(string))}}
	})
	s := newService(t, client, func(c *config.Config) { c.Gamify = true })
	torrents, err := s.Torrents(ctx, "stopped")
	if err != nil || len(torrents) != 1 || torrents[0].Name != `view "stopped"` {
		t.Fatalf("%+v %v", torrents, err)
	}
	if s.store.Stats().EverAdded != 0 {
		t.Fatal("a filtered view drove the lifetime counters")
	}
}
