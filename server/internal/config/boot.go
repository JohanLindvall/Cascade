// SPDX-License-Identifier: MIT

package config

import (
	"fmt"

	"github.com/JohanLindvall/Cascade/server/internal/options"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
)

// StartupSettings turns the environment options that name a live setting into
// the settings patch applied over XML-RPC once rtorrent is up. The entrypoint
// writes it to CASCADE_BOOT_SETTINGS (`cascade boot-settings`) rather than
// into rtorrent.rc, which aborts on a command the build does not know; the
// server applies it through the same capability-filtered path as the UI.
//
// Every value is validated here, by its environment name, so one bad value
// fails the start loudly instead of silently dropping every setting.
func StartupSettings(getenv func(string) string) (map[string]any, error) {
	values := map[string]any{}
	for _, option := range options.Options {
		if option.Setting == "" {
			continue
		}
		raw := getenv(option.Name)
		if raw == "" {
			raw, _ = options.Default(option.Name)
		}
		if raw == "" {
			continue
		}
		spec, ok := rtorrent.Spec(option.Setting)
		if !ok {
			return nil, fmt.Errorf("%s names %q, which is not a setting", option.Name, option.Setting)
		}
		var err error
		switch spec.Kind {
		case rtorrent.KindUint, rtorrent.KindInt:
			factor := int64(1)
			if option.KiB {
				factor = 1024
			}
			min := int64(0)
			if spec.Kind == rtorrent.KindInt {
				min = -1
			}
			var n int64
			n, err = validate.Int(raw, option.Name, min, validate.MaxSafeInteger/factor)
			values[option.Setting] = n * factor
		case rtorrent.KindBool:
			values[option.Setting], err = validate.Bool(raw, option.Name)
		default:
			values[option.Setting], err = validate.String(raw, option.Name, true)
		}
		if err != nil {
			return nil, err
		}
	}
	return values, nil
}
