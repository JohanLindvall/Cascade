// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// LogScopes are the log scopes the UI may attach at runtime, which is also
// the input allowlist: rtorrent faults on a name it does not know, and there
// is no reason to let arbitrary strings ride to it.
//
// This is a union across the supported releases, because the subsystem
// groups moved — measured against real builds rather than guessed at: 0.9.8
// has connection/dht/peer/tracker_debug and no tracker_events, while 0.16.20
// dropped those four and offers tracker_events instead; the six severities
// plus storage_debug, torrent_debug and rpc_events exist in both. There is no
// command that lists groups and attaching is the only probe (and cannot be
// undone), so the offer is the union and a scope this build refuses is
// reported by name rather than sinking the batch.
var LogScopes = []string{
	"critical",
	"error",
	"warn",
	"notice",
	"info",
	"debug",
	"connection_debug",
	"dht_debug",
	"peer_debug",
	"rpc_events",
	"storage_debug",
	"torrent_debug",
	"tracker_debug",
	"tracker_events",
}

// SanitizeLogScopes keeps the known scopes of a request, in catalog order,
// deduplicated.
func SanitizeLogScopes(input []string) []string {
	out := []string{}
	for _, scope := range LogScopes {
		if slices.Contains(input, scope) {
			out = append(out, scope)
		}
	}
	return out
}

var scopeSeparators = regexp.MustCompile(`[,\s]+`)

// LogScopes is the log's scope state.
func (s *Service) LogScopes() contracts.LogScopeState {
	// What RT_LOG_LEVEL baked into rtorrent.rc at container start — shown as
	// fixed, since the rc reasserts it on every rtorrent start.
	boot := []string{}
	for _, scope := range scopeSeparators.Split(s.cfg.LogLevel, -1) {
		if scope = strings.TrimSpace(scope); scope != "" {
			boot = append(boot, scope)
		}
	}
	return contracts.LogScopeState{
		Boot:      boot,
		Extra:     SanitizeLogScopes(s.store.LogScopes()),
		Available: slices.Clone(LogScopes),
		Supported: s.caps.Supports("logScopes"),
	}
}

// SetLogScopes sets the scopes raised on top of RT_LOG_LEVEL.
//
// Raising is live: log.add_output attaches a scope to the running log.
// Lowering is not — rtorrent has no command to detach one — so a removed
// scope keeps writing until a restart. The container must restart to also
// regenerate rtorrent.rc, which can carry the scope from an earlier boot.
func (s *Service) SetLogScopes(ctx context.Context, requested []string) (contracts.LogScopeChange, error) {
	ctx = detached(ctx)
	// One change at a time: each reads what the last one stored.
	s.logScopeWrites.Lock()
	defer s.logScopeWrites.Unlock()
	if err := s.caps.Ensure(ctx); err != nil {
		return contracts.LogScopeChange{}, err
	}
	if !s.caps.Supports("logScopes") {
		return contracts.LogScopeChange{}, httperr.New(http.StatusNotImplemented, "this rtorrent build does not expose log.add_output")
	}
	scopes := SanitizeLogScopes(requested)
	previous := s.store.LogScopes()
	// A scope this build refuses must not sink the rest: the subsystem groups
	// differ between releases (see LogScopes), so one stale name is ordinary,
	// not exceptional. What took is kept; what did not is named.
	failed, err := s.attachScopes(ctx, scopes)
	if err != nil {
		return contracts.LogScopeChange{}, err
	}
	kept := []string{}
	for _, scope := range scopes {
		if !slices.Contains(failed, scope) {
			kept = append(kept, scope)
		}
	}
	s.store.SetLogScopes(kept)
	// What was on and stays on for this rtorrent session despite being
	// switched off — there is nothing to detach it with.
	stillActive := []string{}
	s.mu.Lock()
	for _, scope := range previous {
		if !slices.Contains(scopes, scope) && s.attachedScopes[scope] && !slices.Contains(stillActive, scope) {
			stillActive = append(stillActive, scope)
		}
	}
	s.mu.Unlock()
	return contracts.LogScopeChange{LogScopeState: s.LogScopes(), StillActive: stillActive, Failed: failed}, nil
}

// attachScopes attaches scopes to the running log and returns the ones this
// build refused.
func (s *Service) attachScopes(ctx context.Context, scopes []string) ([]string, error) {
	s.mu.Lock()
	missing := []string{}
	for _, scope := range scopes {
		if !s.attachedScopes[scope] {
			missing = append(missing, scope)
		}
	}
	s.mu.Unlock()
	failed := []string{}
	if len(missing) == 0 {
		return failed, nil
	}
	calls := make([]rtorrent.Call, len(missing))
	for i, scope := range missing {
		// "cascade" is the output the entrypoint opened in rtorrent.rc.
		calls[i] = call("log.add_output", "", scope, "cascade")
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, scope := range missing {
		if results[i].Err != nil {
			failed = append(failed, scope)
		} else {
			s.attachedScopes[scope] = true
		}
	}
	return failed, nil
}

const logTailBytes = 512 * 1024

// Log is the tail of the rtorrent log. It reads only the end — the log grows
// without bound.
func (s *Service) Log(_ context.Context, lines int) ([]string, error) {
	file, err := os.Open(s.cfg.LogFile)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	start := max(0, info.Size()-logTailBytes)
	data, err := io.ReadAll(io.NewSectionReader(file, start, info.Size()-start))
	if err != nil {
		return nil, err
	}
	rows := []string{}
	for _, row := range strings.Split(strings.ToValidUTF8(string(data), "\uFFFD"), "\n") {
		if row != "" {
			rows = append(rows, row)
		}
	}
	if start > 0 && len(rows) > 0 {
		rows = rows[1:] // The first row is almost certainly cut mid-line.
	}
	if lines = max(0, lines); len(rows) > lines {
		rows = rows[len(rows)-lines:]
	}
	return rows, nil
}
