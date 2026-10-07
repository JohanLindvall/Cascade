// SPDX-License-Identifier: MIT

package rtorrent

// Backend capability probing.
//
// rtorrent's command set differs noticeably between releases: 0.9.6 has
// d.multicall but not d.multicall2, the *_verbose load variants arrived in
// 0.9.7, d.throttle_name and the throttle.* group commands are not present
// everywhere, and forks (jesec/rtorrent 0.10.x) add commands of their own.
//
// Rather than hard-coding a version matrix, the running instance is asked
// what it supports via system.listMethods, and command names are picked from
// what is actually there. Unsupported settings are reported to the UI so it
// can disable them. The one thing the listing cannot tell — a command a
// release still registers but ignores — is declared in inertFrom by release.

import (
	"context"
	"maps"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

// Dialect is the command names this backend answers to.
type Dialect struct {
	// Multicall over the download list; DownloadMulticallPrefix gives the
	// parameters that precede the fields.
	DownloadMulticall string
	// Load a torrent from raw bytes / from a URL or magnet link.
	LoadRaw      string
	LoadRawStart string
	LoadURL      string
	LoadURLStart string
	// Field commands that this backend actually implements.
	TorrentFields []string
	FileFields    []string
	PeerFields    []string
	TrackerFields []string
}

// DownloadMulticallPrefix is what precedes the fields in a download-list
// multicall: d.multicall2 takes an empty target before the view, the legacy
// d.multicall only the view.
func (d Dialect) DownloadMulticallPrefix(view string) []any {
	if d.DownloadMulticall == "d.multicall" {
		return []any{view}
	}
	return []any{"", view}
}

func (d Dialect) clone() Dialect {
	d.TorrentFields = append([]string{}, d.TorrentFields...)
	d.FileFields = append([]string{}, d.FileFields...)
	d.PeerFields = append([]string{}, d.PeerFields...)
	d.TrackerFields = append([]string{}, d.TrackerFields...)
	return d
}

// BackendInfo is what the probe learned about the backend.
type BackendInfo struct {
	ClientVersion  string
	LibraryVersion string
	APIVersion     string
	MethodCount    int
	Flavor         string
	// The RPC facility system.capabilities reports (0.16+), e.g.
	// "xmlrpc-c 1.51.8".
	RPCFacility string
	Supports    map[string]bool
}

// FieldLists are the candidate field commands for each multicall, before the
// probe filters them.
type FieldLists struct {
	Torrent []string
	File    []string
	Peer    []string
	Tracker []string
}

// featureMethods maps a feature to the commands it needs, for capabilities
// that are not global settings. Every settings key additionally becomes a
// feature of its own (true when the backend has a working setter), so the UI
// greys a settings control out by its own field name rather than through a
// parallel list.
var featureMethods = map[string][]string{
	"labels":                 {"d.custom1.set"},
	"throttleGroups":         {"throttle.up", "throttle.down"},
	"perTorrentThrottle":     {"d.throttle_name.set"},
	"perTorrentMaxUploads":   {"d.uploads_max.set"},
	"perTorrentMaxDownloads": {"d.downloads_max.set"},
	"perTorrentDirectory":    {"d.directory.set", "d.save_full_session", "d.stop", "d.close"},
	"dhtStatistics":          {"dht.statistics"},
	"trackerInsert":          {"d.tracker.insert"},
	"trackerToggle":          {"t.is_enabled.set"},
	"trackerAnnounce":        {"d.tracker_announce"},
	"logScopes":              {"log.add_output"},
}

// inertFrom names commands a release still lists in system.listMethods but
// ignores, with the first release that does: rtorrent answers 0 and the
// getter reads the old value back (AGENTS.md quirk 7). From that release on
// the probe treats the command as absent, and since everything resolves its
// commands through the probe, a feature needing it is unsupported and a
// setting it sets is read-only in the supports map, in SettingEntries and in
// the boot-settings warning alike. Only the console's method list still
// shows it, as rtorrent does. Measure on both sides of the release before
// adding one.
var inertFrom = map[string]string{
	// 0.16.15 left it as a stub that only logs "network.max_open_files.set is
	// deprecated, use system.sockets.files.min_alloc.set instead"; every
	// release before it applies the value.
	"network.max_open_files.set": "0.16.15",
	// 0.16.1 (rtorrent 677f8f45) took the DHT port from the listening port,
	// or dht.override_port: dht.port.set only logs "dht.port.set is no longer
	// supported, use dht.override_port.set" to the dht scope, and dht.port
	// reports the port the running DHT has (0 while it is off). 0.9.8 and
	// 0.16.0 read back what they were given.
	"dht.port.set": "0.16.1",
	// 0.16.12 dropped the switch (rtorrent 840a5791): trackers.use_udp.set
	// only logs "trackers.use_udp.set is no longer supported" and
	// trackers.use_udp reads 1 whatever it was given. 0.9.8, 0.16.0, 0.16.1
	// and 0.16.11 apply it.
	"trackers.use_udp.set": "0.16.12",
}

// probeTTL is how long a probe is trusted before the command table is read
// again.
const probeTTL = 5 * time.Minute

// Capabilities probes the backend once and answers from what it learned. It
// is safe for concurrent use.
type Capabilities struct {
	client Client
	fields FieldLists
	now    func() time.Time

	mu sync.Mutex
	// Every command the backend listed, for the console; usable leaves out
	// the ones this release ignores (inertFrom), and every choice of command
	// is made from it.
	methods  map[string]bool
	usable   map[string]bool
	probedAt time.Time
	probing  *inflight
	dialect  Dialect
	info     BackendInfo
	ready    bool
	// Bumped by Invalidate, so a probe that was already running when the
	// connection dropped cannot vouch for whatever rtorrent answers now.
	generation uint64
}

// probed is what one probe learned, committed all at once so a probe that
// fails part way leaves the last good answers standing.
type probed struct {
	methods map[string]bool
	usable  map[string]bool
	dialect Dialect
	info    BackendInfo
}

// inflight is a probe in flight, which concurrent callers share.
type inflight struct {
	done chan struct{}
	err  error
}

// NewCapabilities returns an unprobed Capabilities; Ensure probes.
func NewCapabilities(client Client, fields FieldLists) *Capabilities {
	return &Capabilities{
		client:  client,
		fields:  fields,
		now:     time.Now,
		methods: map[string]bool{},
		usable:  map[string]bool{},
		dialect: defaultDialect(),
		info: BackendInfo{
			ClientVersion:  "unknown",
			LibraryVersion: "unknown",
			APIVersion:     "0",
			Flavor:         "unknown",
			Supports:       map[string]bool{},
		},
	}
}

// Has reports whether the backend listed the command and this release does
// not ignore it (inertFrom).
func (c *Capabilities) Has(method string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.usable[method]
}

// Resolve returns the first of the candidate commands this backend
// implements, or "" when it implements none; one the release lists but
// ignores (inertFrom) counts as not implemented.
func (c *Capabilities) Resolve(candidates ...string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return firstAvailable(c.usable, candidates, "")
}

// Supports reports a feature, or a settings key with a working setter.
func (c *Capabilities) Supports(feature string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.info.Supports[feature]
}

// Ready reports whether a probe started since the last Invalidate has
// completed successfully; one that was already in flight at the Invalidate
// does not count, since what it learned may predate the reconnect.
func (c *Capabilities) Ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ready
}

// Dialect returns the command names picked by the last probe.
func (c *Capabilities) Dialect() Dialect {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dialect.clone()
}

// Info returns what the last probe learned.
func (c *Capabilities) Info() BackendInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	info := c.info
	info.Supports = make(map[string]bool, len(c.info.Supports))
	for key, value := range c.info.Supports {
		info.Supports[key] = value
	}
	return info
}

// MethodNames lists the backend's commands, sorted, for the console: all it
// listed, the ones it ignores included.
func (c *Capabilities) MethodNames() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	names := make([]string, 0, len(c.methods))
	for name := range c.methods {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Invalidate makes the next Ensure probe again: a reconnected rtorrent may
// be another build. A probe already in flight still answers its callers, but
// no longer marks the backend ready.
func (c *Capabilities) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ready = false
	c.generation++
}

// Ensure probes unless a recent probe stands. Concurrent callers share the
// probe in flight, which runs to completion even if the caller that started
// it gives up — the others are still waiting on it.
func (c *Capabilities) Ensure(ctx context.Context) error {
	c.mu.Lock()
	if c.ready && c.now().Sub(c.probedAt) < probeTTL {
		c.mu.Unlock()
		return nil
	}
	p := c.probing
	if p == nil {
		p = &inflight{done: make(chan struct{})}
		c.probing = p
		generation := c.generation
		go func() {
			learned, err := c.probe(context.WithoutCancel(ctx))
			c.mu.Lock()
			if err == nil {
				c.methods, c.usable, c.dialect, c.info = learned.methods, learned.usable, learned.dialect, learned.info
				c.probedAt = c.now()
				c.ready = generation == c.generation
			}
			p.err = err
			c.probing = nil
			c.mu.Unlock()
			close(p.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-p.done:
		return p.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Capabilities) probe(ctx context.Context) (probed, error) {
	invalid := httperr.Backend("rtorrent returned an invalid system.listMethods response")
	listed, err := c.client.Call(ctx, "system.listMethods")
	if err != nil {
		return probed{}, err
	}
	names, ok := listed.([]any)
	if !ok || len(names) == 0 {
		return probed{}, invalid
	}
	methods := make(map[string]bool, len(names))
	for _, name := range names {
		text, ok := name.(string)
		if !ok {
			return probed{}, invalid
		}
		methods[text] = true
	}

	probes := []Call{
		{Method: "system.client_version"},
		{Method: "system.library_version"},
		{Method: "system.api_version"},
	}
	// 0.16 describes its RPC layer through system.capabilities.
	if methods["system.capabilities"] {
		probes = append(probes, Call{Method: "system.capabilities"})
	}
	versions, err := c.client.MulticallSettled(ctx, probes)
	if err != nil {
		return probed{}, err
	}
	value := func(index int) string {
		if index >= len(versions) || versions[index].Err != nil {
			return "unknown"
		}
		return Text(versions[index].Value)
	}
	usable := withoutInert(methods, value(0))

	dialect := Dialect{
		DownloadMulticall: "d.multicall",
		LoadRaw:           firstAvailable(usable, []string{"load.raw_verbose", "load.raw"}, "load.raw"),
		LoadRawStart:      firstAvailable(usable, []string{"load.raw_start_verbose", "load.raw_start"}, "load.raw_start"),
		LoadURL:           firstAvailable(usable, []string{"load.verbose", "load.normal"}, "load.normal"),
		LoadURLStart:      firstAvailable(usable, []string{"load.start_verbose", "load.start"}, "load.start"),
		TorrentFields:     pickAvailable(usable, c.fields.Torrent),
		FileFields:        pickAvailable(usable, c.fields.File),
		PeerFields:        pickAvailable(usable, c.fields.Peer),
		TrackerFields:     pickAvailable(usable, c.fields.Tracker),
	}
	if usable["d.multicall2"] {
		dialect.DownloadMulticall = "d.multicall2"
	}
	// A backend that answers listMethods but exposes none of our fields is
	// not something we can drive; fall back to the full list and let calls
	// fault.
	if len(dialect.TorrentFields) == 0 {
		dialect.TorrentFields = append([]string{}, c.fields.Torrent...)
	}

	supports := map[string]bool{}
	for feature, needed := range featureMethods {
		all := true
		for _, name := range needed {
			all = all && usable[name]
		}
		supports[feature] = all
	}
	// The same question SettingEntries and UnsupportedSettingKeys ask, of the
	// same commands, so the UI never offers what a write would skip.
	resolve := func(candidates ...string) string { return firstAvailable(usable, candidates, "") }
	for _, key := range SettingKeys {
		supports[key] = Setter(key, resolve) != ""
	}

	rpcFacility := ""
	if len(versions) > 3 && versions[3].Err == nil {
		if record, ok := versions[3].Value.(map[string]any); ok {
			var parts []string
			for _, key := range []string{"version_major", "version_minor", "version_point"} {
				if part, ok := record[key]; ok {
					parts = append(parts, Text(part))
				}
			}
			facility := "unknown"
			if raw, ok := record["facility"]; ok {
				facility = Text(raw)
			}
			rpcFacility = facility
			if joined := strings.Join(parts, "."); joined != "" {
				rpcFacility += " " + joined
			}
		}
	}

	return probed{
		methods: methods,
		usable:  usable,
		dialect: dialect,
		info: BackendInfo{
			ClientVersion:  value(0),
			LibraryVersion: value(1),
			APIVersion:     value(2),
			MethodCount:    len(methods),
			Flavor:         detectFlavor(methods),
			RPCFacility:    rpcFacility,
			Supports:       supports,
		},
	}, nil
}

// withoutInert is methods less the commands the release named by version
// ignores (inertFrom). A version that cannot be read keeps them all, since
// nothing says which side of the release it is on.
func withoutInert(methods map[string]bool, version string) map[string]bool {
	usable := maps.Clone(methods)
	for name, from := range inertFrom {
		if releaseAtLeast(version, from) {
			delete(usable, name)
		}
	}
	return usable
}

// releaseAtLeast reports whether version is release or a later one, number
// by number: 0.16.9 comes before 0.16.15, and a missing number counts as 0.
// A suffix after the numbers ("0.9.8-rc1") is ignored, and a version that
// does not start with one ("unknown") is at least nothing.
func releaseAtLeast(version, release string) bool {
	have, want := releaseNumbers(version), releaseNumbers(release)
	if len(have) == 0 {
		return false
	}
	for i := range max(len(have), len(want)) {
		h, w := 0, 0
		if i < len(have) {
			h = have[i]
		}
		if i < len(want) {
			w = want[i]
		}
		if h != w {
			return h > w
		}
	}
	return true
}

// releaseNumbers reads the dotted numbers a version starts with.
func releaseNumbers(version string) []int {
	var numbers []int
	for part := range strings.SplitSeq(version, ".") {
		digits := len(part) - len(strings.TrimLeft(part, "0123456789"))
		n, err := strconv.Atoi(part[:digits])
		if err != nil {
			break
		}
		numbers = append(numbers, n)
		if digits < len(part) {
			break
		}
	}
	return numbers
}

// pickAvailable filters candidate field commands down to those the backend
// implements, keeping their order, and asks for a field's exact variant
// (ExactFields) in its place where the backend has one.
func pickAvailable(available map[string]bool, candidates []string) []string {
	picked := []string{}
	for _, name := range candidates {
		if exact, ok := ExactFields[name]; ok && available[exact] {
			picked = append(picked, exact)
		} else if available[name] {
			picked = append(picked, name)
		}
	}
	return picked
}

func firstAvailable(available map[string]bool, candidates []string, fallback string) string {
	for _, name := range candidates {
		if available[name] {
			return name
		}
	}
	return fallback
}

// detectFlavor describes the command dialect rather than guessing at a fork:
// several builds report indistinguishable version strings, and naming the
// wrong upstream is worse than naming none.
func detectFlavor(methods map[string]bool) string {
	switch {
	case !methods["d.multicall2"]:
		return "legacy dialect (pre-0.9.7)"
	case methods["load.raw_start_verbose"]:
		return "modern dialect (0.9.7+)"
	}
	return "modern dialect"
}

func defaultDialect() Dialect {
	return Dialect{
		DownloadMulticall: "d.multicall2",
		LoadRaw:           "load.raw",
		LoadRawStart:      "load.raw_start",
		LoadURL:           "load.normal",
		LoadURLStart:      "load.start",
		TorrentFields:     []string{},
		FileFields:        []string{},
		PeerFields:        []string{},
		TrackerFields:     []string{},
	}
}
