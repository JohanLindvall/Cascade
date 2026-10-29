// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/redact"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// Search keeps the large file and tracker lists on the server. Only matching
// hashes and indexing progress reach the browser. A request does a small batch
// of work; there is no background queue left running after a search is closed.
func (s *Service) Search(ctx context.Context, query string) (contracts.SearchResult, error) {
	if _, err := s.Torrents(ctx, "main"); err != nil {
		return contracts.SearchResult{}, err
	}
	words := searchWords(query)
	if len(words) > 0 {
		s.loadSearch(ctx)
	}
	if err := ctx.Err(); err != nil {
		return contracts.SearchResult{}, err
	}
	return s.search.snapshot(words), nil
}

// Names and arriving magnet metadata invalidate paths; transfer counters do
// not. Trackers may be edited outside Cascade without changing their count,
// so their text is also refreshed once a minute while a search is open.
type searchKey struct {
	name, directory, basePath string
	meta                      bool
	trackers, addedAt         int64
}

func metadataKey(t contracts.Torrent) searchKey {
	return searchKey{t.Name, t.Directory, t.BasePath, t.IsMeta, t.TrackerCount, t.AddedAt}
}

type searchSource struct {
	text  string
	ready bool
	err   string
	tried time.Time
}

func (s searchSource) due(now time.Time, refresh bool) bool {
	if s.tried.IsZero() {
		return true
	}
	if !s.ready || s.err != "" {
		return now.Sub(s.tried) >= 5*time.Second
	}
	return refresh && now.Sub(s.tried) >= time.Minute
}

type searchEntry struct {
	key             searchKey
	files, trackers searchSource
}

type searchIndex struct {
	mu       sync.Mutex
	entries  map[string]*searchEntry
	torrents []contracts.Torrent
	running  bool
}

// Called in listing order, under listingGate. Delayed detail reads can only
// update their original entry, never a new path or a removed/re-added torrent.
func (s *searchIndex) sync(torrents []contracts.Torrent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = make(map[string]*searchEntry)
	}
	live := make(map[string]bool, len(torrents))
	for _, t := range torrents {
		live[t.Hash] = true
		key := metadataKey(t)
		if entry := s.entries[t.Hash]; entry == nil || entry.key != key {
			s.entries[t.Hash] = &searchEntry{key: key}
		}
	}
	for hash := range s.entries {
		if !live[hash] {
			delete(s.entries, hash)
		}
	}
	s.torrents = torrents
}

func (s *searchIndex) forget(hash string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, hash)
}

const searchBatch = 8

type searchWork struct {
	hash            string
	entry           *searchEntry
	files, trackers bool
}

func (s *searchIndex) batch(now time.Time) []searchWork {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return nil // Other tabs can read the matches already available.
	}
	batch := make([]searchWork, 0, searchBatch)
	// New torrents precede retries, so a broken tracker cannot starve the list.
	for _, fresh := range []bool{true, false} {
		for _, t := range s.torrents {
			e := s.entries[t.Hash]
			if e == nil || (e.files.tried.IsZero() || e.trackers.tried.IsZero()) != fresh {
				continue
			}
			files, trackers := e.files.due(now, false), e.trackers.due(now, true)
			if files || trackers {
				batch = append(batch, searchWork{t.Hash, e, files, trackers})
				if len(batch) == searchBatch {
					s.running = true
					return batch
				}
			}
		}
	}
	s.running = len(batch) > 0
	return batch
}

func (s *Service) loadSearch(ctx context.Context) {
	batch := s.search.batch(s.now())
	if len(batch) == 0 {
		return
	}
	defer func() {
		s.search.mu.Lock()
		s.search.running = false
		s.search.mu.Unlock()
	}()
	deadline := time.Now().Add(200 * time.Millisecond)
	for _, work := range batch {
		if ctx.Err() != nil {
			return
		}
		s.search.mu.Lock()
		current := s.search.entries[work.hash] == work.entry
		s.search.mu.Unlock()
		if !current {
			continue
		}
		for _, files := range []bool{true, false} {
			if (files && !work.files) || (!files && !work.trackers) {
				continue
			}
			text, err := s.searchText(ctx, work.hash, files)
			if ctx.Err() != nil {
				return
			}
			s.search.mu.Lock()
			if s.search.entries[work.hash] == work.entry {
				source := &work.entry.trackers
				if files {
					source = &work.entry.files
				}
				source.tried = s.now()
				if err != nil {
					source.err = redact.Secrets(err.Error())
				} else {
					source.text, source.ready, source.err = text, true, ""
				}
			}
			s.search.mu.Unlock()
		}
		// Bound work between torrents as well as by count. An individual RPC
		// still has the transport's timeout and this request's cancellation.
		if time.Now().After(deadline) {
			return
		}
	}
}

func (s *Service) searchText(ctx context.Context, hash string, files bool) (string, error) {
	dialect := s.caps.Dialect()
	method, fields := "t.multicall", dialect.TrackerFields
	wanted := []string{"t.url", "t.id"}
	if files {
		method, fields = "f.multicall", dialect.FileFields
		wanted = []string{"f.path", "f.frozen_path", rtorrent.ExactFields["f.path"], rtorrent.ExactFields["f.frozen_path"]}
	}
	// Keep the capability probe's exact-name variants, but don't fetch file
	// progress or tracker counters just to search their names.
	selected := make([]string, 0, len(wanted))
	for _, field := range fields {
		if slices.Contains(wanted, field) {
			selected = append(selected, field)
		}
	}
	rows, err := s.client.FieldMulticall(ctx, method, []any{hash, ""}, selected)
	if err != nil {
		return "", err
	}
	var text strings.Builder
	for i, row := range rows {
		if files {
			file := rtorrent.MapFile(row, i)
			text.WriteString(file.Path + "\n" + file.OnDisk + "\n")
		} else {
			tracker := rtorrent.MapTracker(row, i)
			text.WriteString(redact.URL(tracker.URL) + "\n" + redact.Secrets(tracker.TrackerID) + "\n")
			if i == 0 {
				text.WriteString(rtorrent.TrackerHost(tracker.URL) + "\n")
			}
		}
	}
	if !files && len(rows) == 0 {
		text.WriteString("unknown") // The sidebar's primary tracker group.
	}
	return searchLower(text.String()), nil
}

func (s *searchIndex) snapshot(words []string) contracts.SearchResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := contracts.SearchResult{Hashes: []string{}}
	for _, t := range s.torrents {
		e := s.entries[t.Hash]
		if e == nil {
			continue
		}
		if len(words) == 0 {
			result.Hashes = append(result.Hashes, t.Hash)
			continue
		}
		if e.files.tried.IsZero() || e.trackers.tried.IsZero() {
			result.Pending++
		}
		if e.files.err != "" || e.trackers.err != "" {
			result.Failed++
			if result.Error == "" {
				result.Error = e.files.err
				if result.Error == "" {
					result.Error = e.trackers.err
				}
			}
		}
		text := searchLower(strings.Join([]string{
			t.Name, t.Hash, t.Label, t.Directory, t.BasePath, string(t.Status), t.Throttle, redact.Secrets(t.Message),
		}, "\n"))
		if everyWord(words, text, e.files.text, e.trackers.text) {
			result.Hashes = append(result.Hashes, t.Hash)
		}
	}
	return result
}

func everyWord(words []string, texts ...string) bool {
	for _, word := range words {
		if !slices.ContainsFunc(texts, func(text string) bool { return strings.Contains(text, word) }) {
			return false
		}
	}
	return true
}

func searchWords(query string) []string {
	return strings.FieldsFunc(searchLower(query), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

func searchLower(text string) string {
	// Unicode's full lowercase of dotted I expands to two code points;
	// strings.ToLower applies only the one-rune mapping.
	return strings.ReplaceAll(strings.ToLower(strings.ReplaceAll(text, "İ", "i\u0307")), "ς", "σ")
}
