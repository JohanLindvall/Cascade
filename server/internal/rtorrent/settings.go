// SPDX-License-Identifier: MIT

package rtorrent

// The rtorrent global-settings surface, as one declarative table.
//
// Each entry names the getter and setter commands (with alternates, newest
// first, where a release renamed them) and how to coerce the value. The table
// drives reading /api/settings, applying updates, the boot-settings warning
// for unsupported keys, and the per-setting supports map the UI uses to grey
// out controls — so a new knob is one line here plus a form field.
//
// Command names are never called blindly: the capability probe resolves each
// against system.listMethods first, so a setting this backend lacks simply
// disappears instead of faulting — and so does a setter the release lists but
// ignores (inertFrom in capabilities.go), which would otherwise answer 0 and
// change nothing.

import (
	"net"
	"regexp"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// SettingKind is how a value is coerced on its way to (and from) rtorrent.
type SettingKind string

const (
	// KindUint is a non-negative integer.
	KindUint SettingKind = "uint"
	// KindInt is an integer where -1 is allowed ("use the default" /
	// "disabled").
	KindInt SettingKind = "int"
	// KindBool is 0/1 on the wire.
	KindBool   SettingKind = "bool"
	KindString SettingKind = "string"
	// KindFlags is a comma-separated list, sent as one argument per flag.
	KindFlags SettingKind = "flags"
	// KindRate is a global rate in bytes/s, which every release keeps in
	// whole KiB/s in 32 bits: the setter drops the fraction of a KiB — so a
	// positive rate under 1 KiB/s became 0, unlimited — and 0.16.25 refuses a
	// rate over 4294967294 that older releases wrapped around (4 GiB/s read
	// back as 0). A positive rate is rounded up to the next KiB, as a throttle
	// group's is (store.NormalizeThrottle), and held to MaxRate.
	KindRate SettingKind = "rate"
	// KindPort is a port number: 0.16.25 refuses one past 65535, which
	// earlier releases cut to 16 bits (65536 became 0).
	KindPort SettingKind = "port"
	// KindProxy is the global proxy's URL, a string CheckProxyHost has
	// passed.
	KindProxy SettingKind = "proxy"
)

// proxyAuthority is a URL's scheme and authority as rtorrent's parser (curl's)
// reads them: any number of slashes may follow the colon.
var proxyAuthority = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:/*([^/?#]*)`)

// CheckProxyHost refuses a global proxy rtorrent would die on.
// network.proxy.global.set (0.16.16 on) looks its host up as a numeric
// address and, when that finds nothing, goes on with no address at all and
// crashes: a host name does it, and so does an IPv6 address, which curl hands
// over in its brackets — measured on 0.16.24 and 0.16.25, and given as
// RT_PROXY_GLOBAL it crashed rtorrent again after every restart. Anything
// else wrong with the URL, rtorrent refuses in its own words, so only an
// authority whose host is not an IPv4 address is refused here.
func CheckProxyHost(value, field string) error {
	match := proxyAuthority.FindStringSubmatch(value)
	if match == nil {
		return nil
	}
	host := match[1]
	if at := strings.LastIndexByte(host, '@'); at >= 0 {
		host = host[at+1:]
	}
	if colon := strings.LastIndexByte(host, ':'); colon >= 0 && !strings.HasSuffix(host, "]") {
		host = host[:colon]
	}
	// No host at all is rtorrent's to refuse; a colon left is IPv6.
	if host == "" || !strings.Contains(host, ":") && net.ParseIP(host) != nil {
		return nil
	}
	return httperr.Newf(400, "%q must give the proxy by its IPv4 address: rtorrent crashes on a host name or an IPv6 address there", field)
}

// MaxRate is the highest global rate the settings take: the largest whole
// KiB/s under 0.16.25's bound of 4294967294 bytes/s. Releases before 0.16.25
// wrap a rate around at 2^32 (4 GiB/s became 0, unlimited), 0.9.8 included,
// which itself refuses a rate over 2^30 and under 2^32.
const MaxRate = 4194303 * 1024

// Range is the whole numbers a numeric kind takes.
func (k SettingKind) Range() (low, high int64) {
	switch k {
	case KindInt:
		return -1, validate.MaxSafeInteger
	case KindRate:
		return 0, MaxRate
	case KindPort:
		return 0, 65535
	}
	return 0, validate.MaxSafeInteger
}

// Numeric reports whether a kind is a whole number.
func (k SettingKind) Numeric() bool {
	return k == KindUint || k == KindInt || k == KindRate || k == KindPort
}

// SettingSpec describes one global setting.
type SettingSpec struct {
	// Get is the getter command(s), newest first; nil for write-only settings.
	Get []string
	// Set is the setter command(s), newest first; nil for read-only settings.
	Set  []string
	Kind SettingKind
}

func one(name string) []string { return []string{name} }

var settingTable = []struct {
	key  string
	spec SettingSpec
}{
	{"downloadRate", SettingSpec{Get: one("throttle.global_down.max_rate"), Set: one("throttle.global_down.max_rate.set"), Kind: KindRate}},
	{"uploadRate", SettingSpec{Get: one("throttle.global_up.max_rate"), Set: one("throttle.global_up.max_rate.set"), Kind: KindRate}},
	{"maxUploads", SettingSpec{Get: one("throttle.max_uploads"), Set: one("throttle.max_uploads.set"), Kind: KindUint}},
	{"minUploads", SettingSpec{Get: one("throttle.min_uploads"), Set: one("throttle.min_uploads.set"), Kind: KindUint}},
	{"maxDownloads", SettingSpec{Get: one("throttle.max_downloads"), Set: one("throttle.max_downloads.set"), Kind: KindUint}},
	{"minDownloads", SettingSpec{Get: one("throttle.min_downloads"), Set: one("throttle.min_downloads.set"), Kind: KindUint}},
	{"maxUploadsGlobal", SettingSpec{Get: one("throttle.max_uploads.global"), Set: one("throttle.max_uploads.global.set"), Kind: KindUint}},
	{"maxDownloadsGlobal", SettingSpec{Get: one("throttle.max_downloads.global"), Set: one("throttle.max_downloads.global.set"), Kind: KindUint}},
	{"maxUploadsDiv", SettingSpec{Get: one("throttle.max_uploads.div"), Set: one("throttle.max_uploads.div.set"), Kind: KindUint}},
	{"maxDownloadsDiv", SettingSpec{Get: one("throttle.max_downloads.div"), Set: one("throttle.max_downloads.div.set"), Kind: KindUint}},
	{"maxPeers", SettingSpec{Get: one("throttle.max_peers.normal"), Set: one("throttle.max_peers.normal.set"), Kind: KindUint}},
	{"minPeers", SettingSpec{Get: one("throttle.min_peers.normal"), Set: one("throttle.min_peers.normal.set"), Kind: KindUint}},
	// -1 disables the seeding peer range, so these must not be clamped to zero.
	{"maxPeersSeed", SettingSpec{Get: one("throttle.max_peers.seed"), Set: one("throttle.max_peers.seed.set"), Kind: KindInt}},
	{"minPeersSeed", SettingSpec{Get: one("throttle.min_peers.seed"), Set: one("throttle.min_peers.seed.set"), Kind: KindInt}},
	// The setter's name is in every release, but from 0.16.15 it only logs a
	// deprecation warning: inertFrom (capabilities.go) makes the value
	// read-only there, while the getter still reads it.
	{"maxOpenFiles", SettingSpec{Get: one("network.max_open_files"), Set: one("network.max_open_files.set"), Kind: KindUint}},
	{"maxOpenSockets", SettingSpec{Get: one("network.max_open_sockets"), Set: one("network.max_open_sockets.set"), Kind: KindUint}},
	// 0.16 dropped network.http.max_open; its max_total_connections successor
	// registers a .set that has no effect, so the value is read-only there and
	// the UI greys the field out rather than pretending it applied.
	{"maxHttpOpen", SettingSpec{
		Get:  []string{"network.http.max_open", "network.http.max_total_connections"},
		Set:  one("network.http.max_open.set"),
		Kind: KindUint,
	}},
	{"httpMaxHostConnections", SettingSpec{Get: one("network.http.max_host_connections"), Set: one("network.http.max_host_connections.set"), Kind: KindUint}},
	{"dnsCacheTimeout", SettingSpec{Get: one("network.http.dns_cache_timeout"), Set: one("network.http.dns_cache_timeout.set"), Kind: KindUint}},
	{"memoryMax", SettingSpec{Get: one("pieces.memory.max"), Set: one("pieces.memory.max.set"), Kind: KindUint}},
	{"syncTimeout", SettingSpec{Get: one("pieces.sync.timeout"), Set: one("pieces.sync.timeout.set"), Kind: KindUint}},
	{"preloadType", SettingSpec{Get: one("pieces.preload.type"), Set: one("pieces.preload.type.set"), Kind: KindUint}},
	{"preloadMinSize", SettingSpec{Get: one("pieces.preload.min_size"), Set: one("pieces.preload.min_size.set"), Kind: KindUint}},
	{"preloadMinRate", SettingSpec{Get: one("pieces.preload.min_rate"), Set: one("pieces.preload.min_rate.set"), Kind: KindUint}},
	// 0.16 moved the listen-port commands under network.listen.*.
	{"portRange", SettingSpec{
		Get:  []string{"network.listen.port.range", "network.port_range"},
		Set:  []string{"network.listen.port.range.set", "network.port_range.set"},
		Kind: KindString,
	}},
	{"portRandom", SettingSpec{
		Get:  []string{"network.listen.port.random", "network.port_random"},
		Set:  []string{"network.listen.port.random.set", "network.port_random.set"},
		Kind: KindBool,
	}},
	// Removed in 0.16 (the listening port is always open there).
	{"portOpen", SettingSpec{Get: one("network.port_open"), Set: one("network.port_open.set"), Kind: KindBool}},
	// dht.mode has a setter but no getter, so its current value cannot be shown.
	{"dhtMode", SettingSpec{Set: one("dht.mode.set"), Kind: KindString}},
	// From 0.16.1 the setter is a stub (inertFrom) and dht.port reports the
	// port the running DHT has; dhtOverridePort is what sets one there.
	{"dhtPort", SettingSpec{Get: one("dht.port"), Set: one("dht.port.set"), Kind: KindPort}},
	{"dhtOverridePort", SettingSpec{Get: one("dht.override_port"), Set: one("dht.override_port.set"), Kind: KindPort}},
	{"pex", SettingSpec{Get: one("protocol.pex"), Set: one("protocol.pex.set"), Kind: KindBool}},
	// Always on from 0.16.12, whose setter is a stub (inertFrom).
	{"udpTrackers", SettingSpec{Get: one("trackers.use_udp"), Set: one("trackers.use_udp.set"), Kind: KindBool}},
	{"trackersNumwant", SettingSpec{Get: one("trackers.numwant"), Set: one("trackers.numwant.set"), Kind: KindInt}},
	// Write-only on purpose: 0.16 grew a getter, but it reports internal flag
	// names (handshake_allow, ...) that the setter refuses, so the value cannot
	// round-trip.
	{"encryption", SettingSpec{Set: one("protocol.encryption.set"), Kind: KindFlags}},
	{"preallocate", SettingSpec{Get: one("system.file.allocate"), Set: one("system.file.allocate.set"), Kind: KindBool}},
	{"checkHashOnCompletion", SettingSpec{Get: one("pieces.hash.on_completion"), Set: one("pieces.hash.on_completion.set"), Kind: KindBool}},
	{"adviseRandomHashing", SettingSpec{Get: one("system.files.advise_random.hashing"), Set: one("system.files.advise_random.hashing.set"), Kind: KindBool}},
	// rtorrent names a torrent as it loads it, the session's included, so the
	// two name switches reach only what is loaded after a change — which is
	// why the entrypoint also writes their variables into rtorrent.rc
	// (AGENTS.md quirk 6).
	//
	// 0.16.22 saves a "/" in a torrent's name as system.file_name.replace_slash
	// ("_"), where earlier releases refused the torrent; this picks whether
	// d.name is that name or the torrent's own.
	{"useSanitizedName", SettingSpec{Get: one("system.torrent_name.use_sanitized"), Set: one("system.torrent_name.use_sanitized.set"), Kind: KindBool}},
	// 0.16.25 names a torrent from name.utf-8, and a multi-file torrent's
	// directory and files from it and path.utf-8, which older torrent makers
	// wrote beside names in a legacy encoding. Unlike the switch above, this
	// moves a multi-file torrent's files on disk; a single-file torrent's file
	// keeps its legacy name either way (libtorrent's parse_single_file reads
	// only "name"), so there only d.name follows the switch.
	{"allowLegacyUtf8", SettingSpec{Get: one("system.file_name.allow_legacy_utf8"), Set: one("system.file_name.allow_legacy_utf8.set"), Kind: KindBool}},
	{"directory", SettingSpec{Get: one("directory.default"), Set: one("directory.default.set"), Kind: KindString}},
	// Changing the session directory of a running rtorrent is not supported.
	{"sessionDirectory", SettingSpec{Get: one("session.path"), Kind: KindString}},
	{"bindAddress", SettingSpec{Get: one("network.bind_address"), Set: one("network.bind_address.set"), Kind: KindString}},
	{"bindAddressV4", SettingSpec{Get: one("network.bind_address.ipv4"), Set: one("network.bind_address.ipv4.set"), Kind: KindString}},
	{"bindAddressV6", SettingSpec{Get: one("network.bind_address.ipv6"), Set: one("network.bind_address.ipv6.set"), Kind: KindString}},
	{"localAddress", SettingSpec{Get: one("network.local_address"), Set: one("network.local_address.set"), Kind: KindString}},
	{"proxyAddress", SettingSpec{Get: one("network.http.proxy_address"), Set: one("network.http.proxy_address.set"), Kind: KindString}},
	{"proxyHttp", SettingSpec{Get: one("network.proxy.http"), Set: one("network.proxy.http.set"), Kind: KindString}},
	{"proxyGlobal", SettingSpec{Get: one("network.proxy.global"), Set: one("network.proxy.global.set"), Kind: KindProxy}},
	{"httpCapath", SettingSpec{Get: one("network.http.capath"), Set: one("network.http.capath.set"), Kind: KindString}},
	{"httpCacert", SettingSpec{Get: one("network.http.cacert"), Set: one("network.http.cacert.set"), Kind: KindString}},
	{"sslVerifyPeer", SettingSpec{Get: one("network.http.ssl_verify_peer"), Set: one("network.http.ssl_verify_peer.set"), Kind: KindBool}},
	{"sslVerifyHost", SettingSpec{Get: one("network.http.ssl_verify_host"), Set: one("network.http.ssl_verify_host.set"), Kind: KindBool}},
	{"xmlrpcSizeLimit", SettingSpec{Get: one("network.xmlrpc.size_limit"), Set: one("network.xmlrpc.size_limit.set"), Kind: KindUint}},
	{"receiveBuffer", SettingSpec{Get: one("network.receive_buffer.size"), Set: one("network.receive_buffer.size.set"), Kind: KindUint}},
	{"sendBuffer", SettingSpec{Get: one("network.send_buffer.size"), Set: one("network.send_buffer.size.set"), Kind: KindUint}},
	{"maxFileSize", SettingSpec{Get: one("system.file.max_size"), Set: one("system.file.max_size.set"), Kind: KindUint}},
	{"blockOutgoing", SettingSpec{Get: one("network.block.outgoing"), Set: one("network.block.outgoing.set"), Kind: KindBool}},
}

var settingSpecs = func() map[string]SettingSpec {
	specs := make(map[string]SettingSpec, len(settingTable))
	for _, entry := range settingTable {
		specs[entry.key] = entry.spec
	}
	return specs
}()

// SettingKeys lists every setting, in the table's order.
var SettingKeys = func() []string {
	keys := make([]string, len(settingTable))
	for i, entry := range settingTable {
		keys[i] = entry.key
	}
	return keys
}()

// Spec returns the spec of a setting key.
func Spec(key string) (SettingSpec, bool) {
	spec, ok := settingSpecs[key]
	return spec, ok
}

// ResolveMethod picks the first command name this backend implements, or ""
// when there is none. (*Capabilities).Resolve is one.
type ResolveMethod func(candidates ...string) string

// Setter is the command that sets key on this backend: the first of its
// setters resolve finds, or "" for a read-only setting, an unknown key or
// one this backend has no working setter for. The supports map,
// SettingEntries and UnsupportedSettingKeys all ask it, so what the UI
// offers, what a write sends and what the boot-settings warning names
// cannot disagree.
func Setter(key string, resolve ResolveMethod) string {
	spec, ok := settingSpecs[key]
	if !ok || spec.Set == nil {
		return ""
	}
	return resolve(spec.Set...)
}

// ReadableSetting is a setting this backend can report, with the getter
// resolved for it.
type ReadableSetting struct {
	Key    string
	Getter string
}

// ReadableSettings lists the settings this backend can report.
func ReadableSettings(resolve ResolveMethod) []ReadableSetting {
	readable := []ReadableSetting{}
	for _, entry := range settingTable {
		if entry.spec.Get == nil {
			continue
		}
		if getter := resolve(entry.spec.Get...); getter != "" {
			readable = append(readable, ReadableSetting{Key: entry.key, Getter: getter})
		}
	}
	return readable
}

// DecodeSettingValue decodes one raw XML-RPC value into the shape the
// settings API promises: a bool, a number or a string by the setting's kind.
func DecodeSettingValue(key string, value any) any {
	if raw, ok := value.([]byte); ok {
		value = Text(raw)
	}
	spec := settingSpecs[key]
	switch spec.Kind {
	case KindBool:
		// Anything that does not read as zero is on, junk included.
		return xmlrpc.ToNumber(value) != 0
	case KindUint, KindInt, KindRate, KindPort:
		if v, ok := value.(int64); ok {
			return v
		}
		return Number(value)
	}
	switch value.(type) {
	case string, int, int32, int64, float32, float64:
		return Text(value)
	}
	return ""
}

// coerce validates one patch value and turns it into the setter's arguments.
// A string reaches rtorrent as text, and is refused, named by its key, where
// it never could (validate.RtorrentString): the whole multicall would fail.
func coerce(kind SettingKind, value any, key string) ([]any, error) {
	switch kind {
	case KindUint, KindInt, KindRate, KindPort:
		low, high := kind.Range()
		n, err := validate.Int(value, key, low, high)
		if kind == KindRate {
			n = (n + 1023) / 1024 * 1024
		}
		return []any{n}, err
	case KindBool:
		on, err := validate.Bool(value, key)
		if err != nil {
			return nil, err
		}
		if on {
			return []any{int64(1)}, nil
		}
		return []any{int64(0)}, nil
	case KindFlags:
		text, err := validate.RtorrentString(value, key, true)
		if err != nil {
			return nil, err
		}
		// rtorrent takes each flag as its own argument, mirroring the
		// comma-separated form used in rtorrent.rc.
		flags := []any{}
		for _, flag := range strings.Split(text, ",") {
			if flag = validate.Trim(flag); flag != "" {
				flags = append(flags, flag)
			}
		}
		if len(flags) == 0 {
			return []any{"none"}, nil
		}
		return flags, nil
	case KindProxy:
		text, err := validate.RtorrentString(value, key, true)
		if err == nil {
			err = CheckProxyHost(text, key)
		}
		return []any{text}, err
	}
	text, err := validate.RtorrentString(value, key, true)
	return []any{text}, err
}

// SettingEntries turns a settings patch into setter calls, validating every
// value. Every setter is invoked against the empty-string target: rtorrent
// commands take a target argument, and omitting it makes rtorrent read the
// value as the target and fault with -503 "Wrong object type".
func SettingEntries(patch any, resolve ResolveMethod) ([]Call, error) {
	values, err := validate.Record(patch, "settings")
	if err != nil {
		return nil, err
	}
	calls := []Call{}
	for _, entry := range settingTable {
		value, present := values[entry.key]
		if !present {
			continue
		}
		method := Setter(entry.key, resolve)
		if method == "" {
			continue
		}
		args, err := coerce(entry.spec.Kind, value, entry.key)
		if err != nil {
			return nil, err
		}
		calls = append(calls, Call{Method: method, Params: append([]any{""}, args...)})
	}
	return calls, nil
}

// UnsupportedSettingKeys names the patch keys this backend has no working
// setter for (the boot-settings warning). Unknown keys are simply ignored.
func UnsupportedSettingKeys(keys []string, resolve ResolveMethod) []string {
	unsupported := []string{}
	for _, key := range keys {
		if _, ok := settingSpecs[key]; ok && Setter(key, resolve) == "" {
			unsupported = append(unsupported, key)
		}
	}
	return unsupported
}
