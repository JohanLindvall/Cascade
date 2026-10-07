// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	lightning "github.com/JohanLindvall/lightning/pkg/json"
)

const (
	// Rate samples kept for the graph: three minutes at the default interval.
	historyLength = 180
	// How long one round of housekeeping may take before it is abandoned and
	// tried again on the next tick.
	tickTimeout = 2 * time.Minute
)

// Start samples rates and runs the housekeeping on a timer until Stop. Ticks
// are chained rather than scheduled on an interval: a slow or hung rtorrent
// (the SCGI timeout is 30s) would otherwise stack a tick per interval behind
// the request queue.
func (s *Service) Start() {
	s.loopMu.Lock()
	defer s.loopMu.Unlock()
	if s.loopStop != nil {
		return
	}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.loopStop, s.loopDone = stop, done
	go func() {
		defer close(done)
		timer := time.NewTimer(0)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			s.tick(ctx)
			timer.Reset(s.cfg.PollInterval)
		}
	}()
}

// Stop ends the housekeeping and waits for it to finish: a read in flight is
// abandoned, while a change in flight — the restart after a recheck — is
// seen through, so shutting down never leaves a torrent half started.
func (s *Service) Stop() {
	s.loopMu.Lock()
	stop, done := s.loopStop, s.loopDone
	s.loopStop, s.loopDone = nil, nil
	s.loopMu.Unlock()
	if stop != nil {
		stop()
		<-done
	}
}

func (s *Service) tick(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, tickTimeout)
	defer cancel()
	if err := s.housekeep(ctx); err != nil && parent.Err() == nil {
		// rtorrent may be restarting underneath. What a restart forgets is put
		// back once it answers again and shows it did (noteSession); the
		// command table is read afresh either way.
		s.mu.Lock()
		s.lostContact = true
		s.mu.Unlock()
		s.caps.Invalidate()
	}
}

func (s *Service) housekeep(ctx context.Context) error {
	if err := s.sampleRates(ctx); err != nil {
		return err
	}
	if !s.bootSettingsApplied.Load() {
		if err := s.applyBootSettings(ctx); err != nil {
			return err
		}
	}
	if !s.throttlesApplied.Load() {
		if err := s.reapplyThrottles(ctx); err != nil {
			return err
		}
	}
	if !s.logScopesApplied.Load() {
		if err := s.reapplyLogScopes(ctx); err != nil {
			return err
		}
	}
	if err := s.processPendingRestarts(ctx); err != nil {
		return err
	}
	// Keep lifetime counters moving even when no browser is watching. Not
	// through Torrents, whose shared read outlives its caller: this one is
	// the loop's own, so it runs under the tick's context for Stop to
	// abandon, and a read already in flight is left to update the counters.
	if s.cfg.Gamify && s.now().UnixMilli()-s.lastGameUpdate.Load() > 30_000 {
		if err := s.torrentRead.doIfIdle(func() ([]contracts.Torrent, error) { return s.readTorrents(ctx, "main") }); err != nil {
			return err
		}
	}
	return nil
}

// sampleRates records a point of the rate graph, and asks for rtorrent's pid
// in the same request: a pid that changed is how a restart shows itself.
func (s *Service) sampleRates(ctx context.Context) error {
	results, err := s.client.MulticallSettled(ctx, []rtorrent.Call{
		call("throttle.global_down.rate"),
		call("throttle.global_up.rate"),
		call("system.pid"),
	})
	if err != nil {
		return err
	}
	for _, rate := range results[:2] {
		if rate.Err != nil {
			return rate.Err
		}
	}
	pid := ""
	if results[2].Err == nil {
		pid = rtorrent.Text(results[2].Value)
	}
	s.noteSession(pid)

	down, up := int64(results[0].Number()), int64(results[1].Number())
	s.mu.Lock()
	s.history = append(s.history, contracts.RateSample{T: s.now().Unix(), Down: down, Up: up})
	if over := len(s.history) - historyLength; over > 0 {
		s.history = append([]contracts.RateSample(nil), s.history[over:]...)
	}
	s.mu.Unlock()
	if s.cfg.Gamify {
		s.store.RecordRates(float64(down), float64(up))
	}
	return nil
}

// noteSession resets what a restarted rtorrent has forgotten — the startup
// settings, the throttle groups, the log scopes — so the housekeeping puts it
// back. A changed pid says rtorrent restarted; with no pid to go by (a build
// without system.pid), losing contact is taken to mean the same. A passing
// failure against the same rtorrent re-applies nothing: the startup settings
// would otherwise undo whatever was changed in the UI since.
func (s *Service) noteSession(pid string) {
	s.mu.Lock()
	restarted := pid != s.rtorrentPID || (pid == "" && s.lostContact)
	s.rtorrentPID, s.lostContact = pid, false
	if restarted {
		clear(s.attachedScopes)
	}
	s.mu.Unlock()
	if restarted {
		// A fast restart can fall entirely between ticks, without a failed
		// request to invalidate the old command table. Probe the new process
		// before choosing setters for the settings it forgot.
		s.caps.Invalidate()
		s.bootSettingsApplied.Store(false)
		s.throttlesApplied.Store(false)
		s.logScopesApplied.Store(false)
	}
}

// applyBootSettings applies the settings passed as docker env vars.
//
// These deliberately do not go into rtorrent.rc: rtorrent aborts on an
// unknown command in its config file, and the available commands differ
// between 0.9.x, 0.10.x and 0.15.x. Routing them through UpdateSettings means
// the capability probe silently drops whatever this build lacks.
func (s *Service) applyBootSettings(ctx context.Context) error {
	if patch := s.bootSettings(); len(patch) > 0 {
		if err := s.caps.Ensure(ctx); err != nil {
			return err // Tried again on the next tick.
		}
		keys := make([]string, 0, len(patch))
		for key := range patch {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		unsupported := rtorrent.UnsupportedSettingKeys(keys, s.caps.Resolve)
		if err := s.UpdateSettings(ctx, patch); err != nil {
			// Only a failure to get an answer is tried again. Nothing but a
			// new pid resets this step, so one dropped here would leave the
			// settings unapplied for as long as this rtorrent runs; a refusal,
			// on the other hand, would be refused again on every tick.
			if !refused(err) {
				return err
			}
			log.Printf("[cascade] could not apply startup settings: %v", err)
		} else {
			log.Printf("[cascade] applied %d startup setting(s) from the environment", len(keys)-len(unsupported))
			if len(unsupported) > 0 {
				log.Printf("[cascade] rtorrent %s does not support: %s", s.caps.Info().ClientVersion, strings.Join(unsupported, ", "))
			}
		}
	}
	s.bootSettingsApplied.Store(true)
	return nil
}

// refused tells a deterministic refusal — rtorrent faulting a command, or a
// value the settings table rejects (a 4xx) — from a failure to reach
// rtorrent or read its answer, which sending the same thing again may cure.
func refused(err error) bool {
	var status *httperr.Error
	return rtorrent.IsFault(err) || errors.As(err, &status) && status.Status < 500
}

// bootSettings reads the settings the entrypoint staged; nil when there are
// none, or none that can be read.
func (s *Service) bootSettings() map[string]any {
	raw, err := os.ReadFile(s.cfg.BootSettingsFile)
	if err != nil {
		return nil // Nothing to apply.
	}
	parsed, err := lightning.DecodeAny(raw)
	if err == nil {
		var patch map[string]any
		if patch, err = validate.Record(parsed, "startup settings"); err == nil {
			return patch
		}
	}
	log.Printf("[cascade] ignoring malformed %s: %v", s.cfg.BootSettingsFile, err)
	return nil
}

// reapplyThrottles puts our throttle groups back: rtorrent drops them on
// restart.
func (s *Service) reapplyThrottles(ctx context.Context) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if s.caps.Supports("throttleGroups") {
		groups := s.store.Throttles()
		errs := make([]error, len(groups))
		var wg sync.WaitGroup
		for i, group := range groups {
			wg.Add(1)
			go func() {
				defer wg.Done()
				// Through the group's queue, and as the store holds it now: a
				// change made meanwhile must not be overwritten by this one.
				errs[i] = s.throttleWrites.run(group.Name, func() error {
					if current, ok := s.throttle(group.Name); ok {
						_, err := s.client.Multicall(ctx, throttleCalls(current))
						return err
					}
					return nil
				})
			}()
		}
		wg.Wait()
		if err := errors.Join(errs...); err != nil {
			return err
		}
	}
	s.throttlesApplied.Store(true)
	return nil
}

// reapplyLogScopes puts the UI's log scopes back: rtorrent forgets runtime
// log outputs on restart.
func (s *Service) reapplyLogScopes(ctx context.Context) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if extra := SanitizeLogScopes(s.store.LogScopes()); s.caps.Supports("logScopes") && len(extra) > 0 {
		failed, err := s.attachScopes(ctx, extra)
		if err != nil {
			return err
		}
		if len(failed) > 0 {
			// Kept in the store all the same: a scope this build refuses may
			// be one the next build accepts, and losing the owner's choice
			// over a version change would be the quieter, worse failure.
			log.Printf("[cascade] this rtorrent has no log scope(s): %s", strings.Join(failed, ", "))
		}
	}
	s.logScopesApplied.Store(true)
	return nil
}
