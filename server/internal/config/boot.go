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
		switch {
		case spec.Kind.Numeric():
			factor := int64(1)
			if option.KiB {
				factor = 1024
			}
			// The setting's own bounds, in the variable's unit: a value the
			// settings table would refuse — and every startup setting with
			// it — stops the start here, by name.
			low, high := spec.Kind.Range()
			var n int64
			n, err = validate.Int(raw, option.Name, low, high/factor)
			values[option.Setting] = n * factor
		case spec.Kind == rtorrent.KindBool:
			values[option.Setting], err = validate.Bool(raw, option.Name)
		default:
			var text string
			text, err = validate.String(raw, option.Name, true)
			if err == nil && spec.Kind == rtorrent.KindProxy {
				// Applied at every start, a proxy rtorrent dies on would
				// kill it again after each restart.
				err = rtorrent.CheckProxyHost(text, option.Name)
			}
			values[option.Setting] = text
		}
		if err != nil {
			return nil, err
		}
	}
	return values, nil
}
