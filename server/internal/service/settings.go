// SPDX-License-Identifier: MIT

package service

import (
	"context"

	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
)

// Settings reads every global setting this backend can report.
func (s *Service) Settings(ctx context.Context) (map[string]any, error) {
	if err := s.caps.Ensure(ctx); err != nil {
		return nil, err
	}
	usable := rtorrent.ReadableSettings(s.caps.Resolve)
	calls := make([]rtorrent.Call, len(usable))
	for i, setting := range usable {
		calls[i] = call(setting.Getter)
	}
	results, err := s.client.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	settings := map[string]any{}
	for i, setting := range usable {
		if results[i].Err == nil {
			settings[setting.Key] = rtorrent.DecodeSettingValue(setting.Key, results[i].Value)
		}
	}
	return settings, nil
}

// UpdateSettings applies a settings patch through whatever setters this
// backend has.
func (s *Service) UpdateSettings(ctx context.Context, patch any) error {
	ctx = detached(ctx)
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	calls, err := rtorrent.SettingEntries(patch, s.caps.Resolve)
	if err != nil || len(calls) == 0 {
		return err
	}
	_, err = s.client.Multicall(ctx, calls)
	return err
}
