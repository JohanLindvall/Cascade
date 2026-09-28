package service

import (
	"context"
	"net/http"
	"strconv"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/store"
)

// throttleCalls sets a group's rates, from a group NormalizeThrottle has
// passed (every group the store holds has). Unlike the global .max_rate.set,
// throttle.up/down take whole KiB/s strings.
func throttleCalls(group contracts.ThrottleGroup) []rtorrent.Call {
	return []rtorrent.Call{
		call("throttle.up", "", group.Name, strconv.FormatInt(group.Up/1024, 10)),
		call("throttle.down", "", group.Name, strconv.FormatInt(group.Down/1024, 10)),
	}
}

func (s *Service) throttle(name string) (contracts.ThrottleGroup, bool) {
	for _, group := range s.store.Throttles() {
		if group.Name == name {
			return group, true
		}
	}
	return contracts.ThrottleGroup{}, false
}

// SaveThrottle creates or replaces a throttle group, in rtorrent and in the
// store.
func (s *Service) SaveThrottle(ctx context.Context, group contracts.ThrottleGroup) error {
	ctx = detached(ctx)
	return s.throttleWrites.run(group.Name, func() error { return s.writeThrottle(ctx, group) })
}

// PatchThrottle changes a saved group's rates; a nil rate is left as it is.
func (s *Service) PatchThrottle(ctx context.Context, name string, up, down *int64) error {
	ctx = detached(ctx)
	return s.throttleWrites.run(name, func() error {
		group, ok := s.throttle(name)
		if !ok {
			return httperr.Newf(http.StatusNotFound, `no throttle group named "%s"`, name)
		}
		if up != nil {
			group.Up = *up
		}
		if down != nil {
			group.Down = *down
		}
		return s.writeThrottle(ctx, group)
	})
}

func (s *Service) writeThrottle(ctx context.Context, group contracts.ThrottleGroup) error {
	normalized, err := store.NormalizeThrottle(group)
	if err != nil {
		return err
	}
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if !s.caps.Supports("throttleGroups") {
		return httperr.New(http.StatusNotImplemented, "this rtorrent build does not support throttle groups")
	}
	if _, err := s.client.Multicall(ctx, throttleCalls(normalized)); err != nil {
		return err
	}
	s.store.UpsertThrottle(normalized)
	return nil
}

// DeleteThrottle forgets a saved throttle group.
func (s *Service) DeleteThrottle(ctx context.Context, name string) error {
	ctx = detached(ctx)
	return s.throttleWrites.run(name, func() error {
		if err := s.caps.Ensure(ctx); err != nil {
			return err
		}
		// throttle.up creates a group it does not know, so unlimiting a name
		// the store never saved would conjure one up rather than remove
		// anything.
		if _, ok := s.throttle(name); !ok {
			return httperr.Newf(http.StatusNotFound, `no throttle group named "%s"`, name)
		}
		if s.caps.Supports("throttleGroups") {
			// rtorrent cannot drop a throttle group at runtime; unlimit it
			// instead so torrents still assigned to it are no longer
			// restricted.
			if _, err := s.client.Multicall(ctx, throttleCalls(contracts.ThrottleGroup{Name: name})); err != nil {
				return err
			}
		}
		s.store.RemoveThrottle(name)
		return nil
	})
}

// ThrottleRates is each saved group's current throughput.
func (s *Service) ThrottleRates(ctx context.Context) (map[string]contracts.ThrottleRate, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	rates := map[string]contracts.ThrottleRate{}
	groups := s.store.Throttles()
	if len(groups) == 0 || !s.caps.Has("throttle.up.rate") || !s.caps.Has("throttle.down.rate") {
		return rates, nil
	}
	calls := make([]rtorrent.Call, 0, 2*len(groups))
	for _, group := range groups {
		calls = append(calls, call("throttle.up.rate", "", group.Name), call("throttle.down.rate", "", group.Name))
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	for i, group := range groups {
		rates[group.Name] = contracts.ThrottleRate{
			Up:   int64(results[2*i].Number()),
			Down: int64(results[2*i+1].Number()),
		}
	}
	return rates, nil
}
