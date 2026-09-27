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
// disappears instead of faulting.

import (
	"strings"

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
)

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
	{"downloadRate", SettingSpec{Get: one("throttle.global_down.max_rate"), Set: one("throttle.global_down.max_rate.set"), Kind: KindUint}},
	{"uploadRate", SettingSpec{Get: one("throttle.global_up.max_rate"), Set: one("throttle.global_up.max_rate.set"), Kind: KindUint}},
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
	{"dhtPort", SettingSpec{Get: one("dht.port"), Set: one("dht.port.set"), Kind: KindUint}},
	{"dhtOverridePort", SettingSpec{Get: one("dht.override_port"), Set: one("dht.override_port.set"), Kind: KindUint}},
	{"pex", SettingSpec{Get: one("protocol.pex"), Set: one("protocol.pex.set"), Kind: KindBool}},
	{"udpTrackers", SettingSpec{Get: one("trackers.use_udp"), Set: one("trackers.use_udp.set"), Kind: KindBool}},
	{"trackersNumwant", SettingSpec{Get: one("trackers.numwant"), Set: one("trackers.numwant.set"), Kind: KindInt}},
	// Write-only on purpose: 0.16 grew a getter, but it reports internal flag
	// names (handshake_allow, ...) that the setter refuses, so the value cannot
	// round-trip.
	{"encryption", SettingSpec{Set: one("protocol.encryption.set"), Kind: KindFlags}},
	{"preallocate", SettingSpec{Get: one("system.file.allocate"), Set: one("system.file.allocate.set"), Kind: KindBool}},
	{"checkHashOnCompletion", SettingSpec{Get: one("pieces.hash.on_completion"), Set: one("pieces.hash.on_completion.set"), Kind: KindBool}},
	{"adviseRandomHashing", SettingSpec{Get: one("system.files.advise_random.hashing"), Set: one("system.files.advise_random.hashing.set"), Kind: KindBool}},
	{"directory", SettingSpec{Get: one("directory.default"), Set: one("directory.default.set"), Kind: KindString}},
	// Changing the session directory of a running rtorrent is not supported.
	{"sessionDirectory", SettingSpec{Get: one("session.path"), Kind: KindString}},
	{"bindAddress", SettingSpec{Get: one("network.bind_address"), Set: one("network.bind_address.set"), Kind: KindString}},
	{"bindAddressV4", SettingSpec{Get: one("network.bind_address.ipv4"), Set: one("network.bind_address.ipv4.set"), Kind: KindString}},
	{"bindAddressV6", SettingSpec{Get: one("network.bind_address.ipv6"), Set: one("network.bind_address.ipv6.set"), Kind: KindString}},
	{"localAddress", SettingSpec{Get: one("network.local_address"), Set: one("network.local_address.set"), Kind: KindString}},
	{"proxyAddress", SettingSpec{Get: one("network.http.proxy_address"), Set: one("network.http.proxy_address.set"), Kind: KindString}},
	{"proxyHttp", SettingSpec{Get: one("network.proxy.http"), Set: one("network.proxy.http.set"), Kind: KindString}},
	{"proxyGlobal", SettingSpec{Get: one("network.proxy.global"), Set: one("network.proxy.global.set"), Kind: KindString}},
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
	case KindUint, KindInt:
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
func coerce(kind SettingKind, value any, key string) ([]any, error) {
	switch kind {
	case KindUint:
		n, err := validate.Int(value, key, 0, validate.MaxSafeInteger)
		return []any{n}, err
	case KindInt:
		n, err := validate.Int(value, key, -1, validate.MaxSafeInteger)
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
		text, err := validate.String(value, key, true)
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
	}
	text, err := validate.String(value, key, true)
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
		if !present || entry.spec.Set == nil {
			continue
		}
		method := resolve(entry.spec.Set...)
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
		spec, ok := settingSpecs[key]
		if !ok {
			continue
		}
		if spec.Set == nil || resolve(spec.Set...) == "" {
			unsupported = append(unsupported, key)
		}
	}
	return unsupported
}
