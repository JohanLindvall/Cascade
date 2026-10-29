// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent/rtorrenttest"
)

func searchRows(rows ...rtorrent.Row) func([]any) any {
	return func(params []any) any {
		result := make([]any, len(rows))
		for i, row := range rows {
			values := make([]any, len(params)-2)
			for j, param := range params[2:] {
				values[j] = row[strings.TrimSuffix(param.(string), "=")]
			}
			result[i] = values
		}
		return result
	}
}

func searchService(t *testing.T, rows ...rtorrent.Row) (subject, *rtorrenttest.FakeClient) {
	t.Helper()
	fields := slices.Concat(rtorrent.TorrentFields, rtorrent.FileFields, rtorrent.TrackerFields, []string{"f.multicall", "t.multicall"})
	client := backend(fields...).
		Answer("d.multicall2", searchRows(rows...)).
		Answer("f.multicall", searchRows(rtorrent.Row{"f.path": "Extras/Director-Interview.srt", "f.frozen_path": "/downloads/short~1234.srt"})).
		Answer("t.multicall", searchRows(
			rtorrent.Row{"t.url": "https://primary.example.org/announce?passkey=secretvalue"},
			rtorrent.Row{"t.url": "https://username:password@backup.example.org/announce", "t.id": "Festival"},
		))
	return newService(t, client, nil), client
}

func assertSearch(t *testing.T, s *Service, query string, want ...string) contracts.SearchResult {
	t.Helper()
	result, err := s.Search(ctx, query)
	if err != nil || !slices.Equal(result.Hashes, want) {
		t.Fatalf("search %q: %+v, %v; want %v", query, result, err, want)
	}
	return result
}

func TestSearchMatchesWordsAcrossAllFieldsAndKeepsDetailsOnServer(t *testing.T) {
	s, client := searchService(t, rtorrent.Row{
		"d.hash": hash, "d.name": "Big.Buck_Bunny-1080p ÉTÉ_日本語_١٢ ΟΣ İSTANBUL",
		"d.custom1": "Cinema", "d.directory": "/downloads/Archive", "d.base_path": "/downloads/Archive/Collection",
		"d.throttle_name": "Overnight", "d.message": "Tracker timed out https://tracker.example/announce?token=hiddenvalue",
	})
	for _, query := range []string{
		"bunny 1080", "1080 BUNNY", "  buck\t1080\n", "bunn.1080", "bunny-1080",
		"日本 ÉTÉ", "١٢ été", "日本語", "ος", "ΟΣ", "İSTANBUL",
		"bunny interview", "cinema srt", "backup bunny", "festival director",
		"primary aaaa", "archive error", "collection overnight", "timed bunny", "short 1234",
	} {
		result := assertSearch(t, s.Service, query, hash)
		if result.Pending != 0 || result.Failed != 0 || result.Error != "" {
			t.Fatalf("%q: %+v", query, result)
		}
	}
	for _, query := range []string{"bunny absent", "big 2160", "Русский", "secretvalue", "hiddenvalue", "username", "password"} {
		assertSearch(t, s.Service, query)
	}
	for _, query := range []string{"", " \t\n ", " .-_ "} {
		assertSearch(t, s.Service, query, hash)
	}
	if len(client.CallsTo("f.multicall")) != 1 || len(client.CallsTo("t.multicall")) != 1 {
		t.Fatal("queries did not share cached details")
	}
	for _, method := range []string{"f.multicall", "t.multicall"} {
		if got := len(client.CallsTo(method)[0].Params); got != 4 {
			t.Fatalf("%s fetched more than the two search fields: %v", method, client.CallsTo(method))
		}
	}
}

func TestSearchEmptyQueriesNeverReadDetails(t *testing.T) {
	s, client := searchService(t, rtorrent.Row{"d.hash": hash, "d.name": "Movie"})
	for _, query := range []string{"", " .-_ ", "🎞️"} {
		result := assertSearch(t, s.Service, query, hash)
		if result.Pending != 0 || result.Failed != 0 {
			t.Fatalf("idle query: %+v", result)
		}
	}
	if len(client.CallsTo("f.multicall"))+len(client.CallsTo("t.multicall")) != 0 {
		t.Fatal("idle search fetched details")
	}
}

func TestSearchUsesExactPathFieldsWhereAvailable(t *testing.T) {
	s, client := searchService(t, rtorrent.Row{"d.hash": hash, "d.name": "Movie"})
	methods := append(rtorrenttest.MethodList(slices.Concat(rtorrent.TorrentFields, rtorrent.FileFields, rtorrent.TrackerFields)...),
		"f.multicall", "t.multicall", "f.path_components.base64", "f.frozen_path.base64")
	client.Answer("system.listMethods", methods).Answer("f.multicall", searchRows(rtorrent.Row{
		"f.path_components.base64": []string{base64.StdEncoding.EncodeToString([]byte("日本語-𐐀.srt"))},
		"f.frozen_path.base64":     base64.StdEncoding.EncodeToString([]byte("/downloads/short.srt")),
	}))
	assertSearch(t, s.Service, "日本語 𐐨", hash)
	assertSearch(t, s.Service, "short", hash)
	if got := client.CallsTo("f.multicall")[0].Params[2:]; !reflect.DeepEqual(got, []any{"f.path_components.base64=", "f.frozen_path.base64="}) {
		t.Fatalf("exact path commands: %v", got)
	}
}

func TestSearchInvalidatesMetadataButNotRatesAndRefreshesTrackers(t *testing.T) {
	row := rtorrent.Row{"d.hash": hash, "d.name": "Movie"}
	s, client := searchService(t, row)
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	assertSearch(t, s.Service, "interview", hash)
	row["d.down.rate"] = 20
	assertSearch(t, s.Service, "interview", hash)
	if len(client.CallsTo("f.multicall")) != 1 {
		t.Fatal("rate change discarded file names")
	}
	now = now.Add(time.Minute)
	client.Answer("t.multicall", searchRows(rtorrent.Row{"t.url": "https://replacement.example/announce"}))
	assertSearch(t, s.Service, "replacement interview", hash)
	assertSearch(t, s.Service, "backup")
	if len(client.CallsTo("f.multicall")) != 1 || len(client.CallsTo("t.multicall")) != 2 {
		t.Fatal("tracker refresh read files again")
	}
	for field, value := range map[string]any{
		"d.directory": "/archive", "d.base_path": "/archive/Movie", "d.is_meta": 1,
		"d.name": "Metadata arrived", "d.tracker_size": 3,
	} {
		before := len(client.CallsTo("f.multicall"))
		row[field] = value
		assertSearch(t, s.Service, "interview", hash)
		if len(client.CallsTo("f.multicall")) != before+1 {
			t.Fatalf("%s did not invalidate metadata", field)
		}
	}
	client.Answer("d.multicall2", []any{})
	assertSearch(t, s.Service, "interview")
	if len(s.search.entries) != 0 {
		t.Fatal("removed torrent's metadata retained")
	}
	client.Answer("d.multicall2", searchRows(row)).Answer("f.multicall", searchRows(rtorrent.Row{"f.path": "new-file.txt"}))
	assertSearch(t, s.Service, "interview")
	assertSearch(t, s.Service, "new file", hash)
}

func TestSearchPartialFailuresKeepOtherMatchesAndRetryOnlyFailedSources(t *testing.T) {
	for _, failed := range []string{"f.multicall", "t.multicall"} {
		t.Run(failed, func(t *testing.T) {
			s, client := searchService(t, rtorrent.Row{"d.hash": hash, "d.name": "Movie"})
			now := time.Unix(1000, 0)
			s.now = func() time.Time { return now }
			client.Answer(failed, errors.New("offline https://tracker.example/announce?passkey=hidden"))
			word := "interview"
			if failed == "f.multicall" {
				word = "backup"
			}
			result := assertSearch(t, s.Service, word, hash)
			if result.Pending != 0 || result.Failed != 1 || strings.Contains(result.Error, "hidden") || !strings.Contains(result.Error, "offline") {
				t.Fatalf("failure: %+v", result)
			}
			assertSearch(t, s.Service, "movie", hash)
			if len(client.CallsTo(failed)) != 1 {
				t.Fatal("failure retried without a cooldown")
			}
			client.Answer(failed, []any{})
			now = now.Add(5 * time.Second)
			result = assertSearch(t, s.Service, word, hash)
			if result.Failed != 0 || result.Error != "" {
				t.Fatalf("retry: %+v", result)
			}
			other := "f.multicall"
			if failed == other {
				other = "t.multicall"
			}
			if len(client.CallsTo(failed)) != 2 || len(client.CallsTo(other)) != 1 {
				t.Fatal("retry reread a successful source")
			}
		})
	}
}

func TestSearchBatchesProgressAndSharesOneIndexerAcrossTabs(t *testing.T) {
	rows := make([]rtorrent.Row, searchBatch+1)
	for i := range rows {
		rows[i] = rtorrent.Row{"d.hash": fmt.Sprintf("%040X", i), "d.name": "Movie"}
	}
	s, client := searchService(t, rows...)
	started, release := make(chan struct{}), make(chan struct{})
	client.Answer("f.multicall", func([]any) any {
		if len(client.CallsTo("f.multicall")) == 1 {
			close(started)
			<-release
		}
		return []any{[]any{"interview.srt", ""}}
	})
	finished := make(chan error, 1)
	go func() { _, err := s.Search(ctx, "interview"); finished <- err }()
	<-started
	result, err := s.Search(ctx, "interview")
	if err != nil || result.Pending != len(rows) || len(client.CallsTo("f.multicall")) != 1 {
		t.Errorf("overlapping search: %+v, %v", result, err)
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if count := len(client.CallsTo("f.multicall")); count > searchBatch {
		t.Fatalf("unbounded batch: %d", count)
	}
	for range len(rows) {
		result, err = s.Search(ctx, "interview")
		if err != nil {
			t.Fatal(err)
		}
		if result.Pending == 0 {
			break
		}
	}
	if result.Pending != 0 || len(result.Hashes) != len(rows) || len(client.CallsTo("f.multicall")) != len(rows) {
		t.Fatalf("progress: %+v", result)
	}
}

func TestSearchDiscardsDetailsForChangedOrRemovedTorrents(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(fmt.Sprint(remove), func(t *testing.T) {
			s, client := searchService(t, rtorrent.Row{"d.hash": hash, "d.name": "Movie"})
			started, release := make(chan struct{}), make(chan struct{})
			client.Answer("f.multicall", func([]any) any { close(started); <-release; return []any{[]any{"stale.srt", ""}} })
			finished := make(chan contracts.SearchResult, 1)
			go func() { result, _ := s.Search(ctx, "stale"); finished <- result }()
			<-started
			if remove {
				if err := s.Remove(ctx, hash, false); err != nil {
					t.Fatal(err)
				}
			} else {
				client.Answer("d.multicall2", searchRows(rtorrent.Row{"d.hash": hash, "d.name": "Movie", "d.directory": "/new"}))
				if _, err := s.Torrents(ctx, "main"); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			if result := <-finished; len(result.Hashes) != 0 {
				t.Fatalf("stale details restored: %+v", result)
			}
		})
	}
}

func TestSearchCancellationStopsTheBatchWithoutCachingAFailure(t *testing.T) {
	s, client := searchService(t, rtorrent.Row{"d.hash": hash, "d.name": "Movie"}, rtorrent.Row{"d.hash": strings.Repeat("B", 40)})
	cancelled, cancel := context.WithCancel(ctx)
	client.Answer("f.multicall", func([]any) any { cancel(); return []any{} })
	if _, err := s.Search(cancelled, "movie"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if len(client.CallsTo("f.multicall")) != 1 || len(client.CallsTo("t.multicall")) != 0 {
		t.Fatal("cancelled request kept indexing")
	}
	result := s.search.snapshot([]string{"movie"})
	if result.Failed != 0 || result.Pending != 2 {
		t.Fatalf("cancel cached a failure: %+v", result)
	}
}
