// SPDX-License-Identifier: MIT

package rtorrent

// The settings table drives reads, writes and the supports map, and its one
// absolute rule is the empty-string target: a setter called without it makes
// rtorrent read the value as the target and fault (quirk 1 in AGENTS.md).

import (
	"errors"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
)

func resolveAll(candidates ...string) string { return candidates[0] }

func resolveNone(...string) string { return "" }

func TestEverySetterIsInvokedAgainstTheEmptyStringTarget(t *testing.T) {
	calls, err := SettingEntries(map[string]any{
		"downloadRate": 1024.0, "pex": true, "encryption": "allow_incoming,try_outgoing", "directory": "/d",
	}, resolveAll)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) < 4 {
		t.Fatalf("%d calls", len(calls))
	}
	for _, call := range calls {
		if call.Params[0] != "" {
			t.Errorf("%s lost its target argument", call.Method)
		}
	}
}

func entry(t *testing.T, patch map[string]any) (Call, error) {
	t.Helper()
	calls, err := SettingEntries(patch, resolveAll)
	if err != nil {
		return Call{}, err
	}
	if len(calls) != 1 {
		t.Fatalf("%d calls for %v", len(calls), patch)
	}
	return calls[0], nil
}

func requireFieldError(t *testing.T, err error, field string) {
	t.Helper()
	var httpErr *httperr.Error
	if !errors.As(err, &httpErr) || httpErr.Status != 400 || !strings.Contains(err.Error(), field) {
		t.Fatalf("want a 400 naming %s, got %v", field, err)
	}
}

func TestCoercionByKind(t *testing.T) {
	_, err := entry(t, map[string]any{"downloadRate": -5.0})
	requireFieldError(t, err, "downloadRate")
	_, err = entry(t, map[string]any{"maxPeersSeed": -9.0})
	requireFieldError(t, err, "maxPeersSeed")
	for _, c := range []struct {
		patch map[string]any
		want  []any
	}{
		{map[string]any{"maxPeersSeed": -1.0}, []any{"", int64(-1)}}, // int keeps -1
		{map[string]any{"pex": true}, []any{"", int64(1)}},
		{map[string]any{"pex": false}, []any{"", int64(0)}},
		// One argument per flag — quirk 2: a joined string is refused by rtorrent.
		{map[string]any{"encryption": "allow_incoming, try_outgoing"}, []any{"", "allow_incoming", "try_outgoing"}},
		{map[string]any{"encryption": ""}, []any{"", "none"}},
		{map[string]any{"directory": " /data "}, []any{"", "/data"}},
		{map[string]any{"downloadRate": "2048"}, []any{"", int64(2048)}},
	} {
		call, err := entry(t, c.patch)
		if err != nil || !reflect.DeepEqual(call.Params, c.want) {
			t.Errorf("%v: %#v %v", c.patch, call.Params, err)
		}
	}
}

// rtorrent keeps a global rate in whole KiB/s, in 32 bits, and a port in 16:
// a rate is rounded up to the next KiB (rtorrent drops the fraction, so a
// sub-KiB rate became 0, unlimited), and what 0.16.25 refuses — and an older
// release wraps around — is a 400 naming the field before it is sent.
func TestRatesAndPortsStayWithinWhatRtorrentKeeps(t *testing.T) {
	for _, c := range []struct {
		patch map[string]any
		want  int64
	}{
		{map[string]any{"downloadRate": 1.0}, 1024},
		{map[string]any{"downloadRate": 800.0}, 1024},
		{map[string]any{"uploadRate": 1025.0}, 2048},
		{map[string]any{"uploadRate": 0.0}, 0},
		{map[string]any{"downloadRate": float64(MaxRate)}, MaxRate},
		{map[string]any{"dhtOverridePort": 65535.0}, 65535},
		{map[string]any{"dhtPort": 0.0}, 0},
	} {
		call, err := entry(t, c.patch)
		if err != nil || !reflect.DeepEqual(call.Params, []any{"", c.want}) {
			t.Errorf("%v: %#v %v", c.patch, call.Params, err)
		}
	}
	for key, value := range map[string]float64{"downloadRate": MaxRate + 1, "uploadRate": 4294967296, "dhtOverridePort": 65536, "dhtPort": -1} {
		_, err := SettingEntries(map[string]any{key: value}, resolveAll)
		requireFieldError(t, err, key)
	}
}

// network.proxy.global.set kills rtorrent (0.16.24 and 0.16.25, measured) when
// its host is not a numeric address: a host name, or an IPv6 address, which
// curl hands over in brackets. Those are a 400 before anything is sent, in
// every spelling curl reads; whatever else is wrong with a URL rtorrent
// refuses in its own words, and the HTTP proxy, which curl looks up itself,
// takes a name.
func TestAGlobalProxyRtorrentWouldCrashOnIsRefusedFirst(t *testing.T) {
	for _, value := range []string{
		"http://proxy.example.org:3128", "socks5h://localhost:1080", "HTTP://Proxy.Example.org:3128",
		"http://user:pw@proxy.example.org:3128", "http://proxy.example.org:3128/", "http:/proxy.example.org:3128",
		"http:///proxy.example.org:3128", "socks5://[::1]:1080", "http://[::1]:3128", "http://[::ffff:10.0.0.1]",
		"http://proxy.example.org", " socks5://localhost:1080 ",
	} {
		_, err := SettingEntries(map[string]any{"proxyGlobal": value}, resolveAll)
		requireFieldError(t, err, "proxyGlobal")
	}
	for _, value := range []string{
		"", "socks5://10.0.0.1:1080", "http://10.0.0.1:3128/", "socks5://user@10.0.0.1:1080", " http://10.0.0.1:3128 ",
		// rtorrent's own refusals: no scheme, no host, no port, another scheme.
		"bogus", "10.0.0.1:3128", "http://:3128", "http://10.0.0.1", "ftp://10.0.0.1:21",
	} {
		call, err := entry(t, map[string]any{"proxyGlobal": value})
		if err != nil || call.Method != "network.proxy.global.set" || call.Params[1] != validate.Trim(value) {
			t.Errorf("%q: %#v %v", value, call, err)
		}
	}
	if _, err := entry(t, map[string]any{"proxyHttp": "http://proxy.example.org:3128"}); err != nil {
		t.Fatal(err)
	}
}

// A setting's text reaches rtorrent as XML-RPC, which xmlrpc-c refuses for a
// character beyond U+FFFF — the whole multicall, every other setting in the
// patch with it (0.9.8 and 0.16.25, -503) — and XML for a carriage return or
// a byte that is not UTF-8, which would arrive as something else. Each is a
// 400 naming the setting before anything is sent.
func TestATextSettingRtorrentCannotBeSentIsRefusedByName(t *testing.T) {
	for key, value := range map[string]string{
		"directory":   "/downloads/films \U0001F3AC",
		"httpCapath":  "/etc/ssl/Caf\xe9",
		"bindAddress": "0.0.0.0\rx",
		"encryption":  "allow_incoming,\U0001F512",
		"proxyGlobal": "socks5://10.0.0.1:1080/\U0001F9E6",
		"portRange":   "50000-50000\U0001F6AA",
	} {
		calls, err := SettingEntries(map[string]any{"pex": true, key: value}, resolveAll)
		requireFieldError(t, err, `"`+key+`" contains`)
		if calls != nil {
			t.Errorf("%s: %v", key, calls)
		}
	}
	if call, err := entry(t, map[string]any{"directory": "/downloads/Café 中文"}); err != nil ||
		!reflect.DeepEqual(call.Params, []any{"", "/downloads/Café 中文"}) {
		t.Fatalf("%#v %v", call.Params, err)
	}
}

// The torrent-name switches (0.16.22 and 0.16.25) are booleans like the rest:
// 0 or 1 after the empty target, read back as true or false.
func TestTheTorrentNameSwitchesAreBooleans(t *testing.T) {
	for key, setter := range map[string]string{
		"useSanitizedName": "system.torrent_name.use_sanitized.set",
		"allowLegacyUtf8":  "system.file_name.allow_legacy_utf8.set",
	} {
		for value, want := range map[any]int64{false: 0, "on": 1} {
			call, err := entry(t, map[string]any{key: value})
			if err != nil || call.Method != setter || !reflect.DeepEqual(call.Params, []any{"", want}) {
				t.Errorf("%s=%v: %#v %v", key, value, call, err)
			}
		}
		_, err := SettingEntries(map[string]any{key: 2.0}, resolveAll)
		requireFieldError(t, err, key)
		if DecodeSettingValue(key, int64(0)) != false || DecodeSettingValue(key, int64(1)) != true {
			t.Errorf("%s decodes as %#v", key, DecodeSettingValue(key, int64(1)))
		}
	}
}

func TestMalformedValuesNeverBecomeZeroUnlimitedOrTruthy(t *testing.T) {
	for _, value := range []any{nil, "", "fast", false, []any{}, map[string]any{}, math.Inf(1), math.NaN(), 1.5, float64(validate.MaxSafeInteger + 1)} {
		_, err := SettingEntries(map[string]any{"downloadRate": value}, resolveAll)
		requireFieldError(t, err, "downloadRate")
	}
	for _, value := range []any{nil, "", []any{}, map[string]any{}, "perhaps"} {
		_, err := SettingEntries(map[string]any{"pex": value}, resolveAll)
		requireFieldError(t, err, "pex")
	}
	if call, err := entry(t, map[string]any{"pex": "false"}); err != nil || !reflect.DeepEqual(call.Params, []any{"", int64(0)}) {
		t.Fatalf("%#v %v", call.Params, err)
	}
	for _, patch := range []any{nil, []any{}, 1.0} {
		_, err := SettingEntries(patch, resolveAll)
		requireFieldError(t, err, "object")
	}
}

func TestAKeyWithNoSetterOrNoResolvedSetterNeverProducesAnEntry(t *testing.T) {
	if calls, err := SettingEntries(map[string]any{"sessionDirectory": "/x"}, resolveAll); err != nil || len(calls) != 0 || calls == nil {
		t.Fatalf("%#v %v", calls, err)
	}
	if calls, err := SettingEntries(map[string]any{"downloadRate": 1.0}, resolveNone); err != nil || len(calls) != 0 {
		t.Fatalf("%#v %v", calls, err)
	}
}

func TestEntriesFollowTheTableOrderWithTheResolvedSetter(t *testing.T) {
	resolve := func(candidates ...string) string { return candidates[len(candidates)-1] }
	calls, err := SettingEntries(map[string]any{"pex": 1.0, "portRange": "50000-50000", "downloadRate": 0.0}, resolve)
	if err != nil {
		t.Fatal(err)
	}
	var methods []string
	for _, call := range calls {
		methods = append(methods, call.Method)
	}
	if want := []string{"throttle.global_down.max_rate.set", "network.port_range.set", "protocol.pex.set"}; !reflect.DeepEqual(methods, want) {
		t.Fatalf("methods %v", methods)
	}
}

func TestReadableSettingsSkipsWriteOnlyKeysAndUnresolvedGetters(t *testing.T) {
	var keys []string
	for _, readable := range ReadableSettings(resolveAll) {
		keys = append(keys, readable.Key)
	}
	if slices.Contains(keys, "encryption") || slices.Contains(keys, "dhtMode") || !slices.Contains(keys, "downloadRate") {
		t.Fatalf("keys %v", keys)
	}
	// A backend with nothing resolves nothing.
	if got := ReadableSettings(resolveNone); got == nil || len(got) != 0 {
		t.Fatalf("got %#v", got)
	}
}

func TestDecodeSettingValueFollowsTheDeclaredKind(t *testing.T) {
	for _, c := range []struct {
		key   string
		value any
		want  any
	}{
		{"pex", "1", true},
		{"pex", "0", false},
		{"pex", int64(1), true},
		{"pex", "junk", true},
		{"downloadRate", "2048", 2048.0},
		{"downloadRate", int64(2048), int64(2048)},
		{"downloadRate", "junk", 0.0},
		{"directory", []byte("/dl"), "/dl"},
		{"portRange", "50000-50000", "50000-50000"},
		{"portRange", int64(5), "5"},
		{"portRange", true, ""},
	} {
		if got := DecodeSettingValue(c.key, c.value); !reflect.DeepEqual(got, c.want) {
			t.Errorf("DecodeSettingValue(%s, %#v) = %#v, want %#v", c.key, c.value, got, c.want)
		}
	}
}

func TestUnsupportedSettingKeysNamesWhatThisBackendCannotSet(t *testing.T) {
	// Read-only; unknown keys pass silently.
	if got := UnsupportedSettingKeys([]string{"downloadRate", "sessionDirectory", "unknown"}, resolveAll); !reflect.DeepEqual(got, []string{"sessionDirectory"}) {
		t.Fatalf("got %v", got)
	}
	if got := UnsupportedSettingKeys([]string{"downloadRate"}, resolveNone); !reflect.DeepEqual(got, []string{"downloadRate"}) {
		t.Fatalf("got %v", got)
	}
}

func TestTheSpecTableIsInternallyConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, key := range SettingKeys {
		spec, ok := Spec(key)
		if !ok || (spec.Get == nil && spec.Set == nil) {
			t.Errorf("%s has neither getter nor setter", key)
		}
		if seen[key] {
			t.Errorf("%s is listed twice", key)
		}
		seen[key] = true
	}
	if _, ok := Spec("nope"); ok {
		t.Error("an unknown key has a spec")
	}
}
