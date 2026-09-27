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
// can disable them.

import (
	"context"
	"sort"
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

// probeTTL is how long a probe is trusted before the command table is read
// again.
const probeTTL = 5 * time.Minute

// Capabilities probes the backend once and answers from what it learned. It
// is safe for concurrent use.
type Capabilities struct {
	client Client
	fields FieldLists
	now    func() time.Time

	mu       sync.Mutex
	methods  map[string]bool
	probedAt time.Time
	probing  *inflight
	dialect  Dialect
	info     BackendInfo
	ready    bool
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

// Has reports whether the backend listed the command.
func (c *Capabilities) Has(method string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.methods[method]
}

// Resolve returns the first of the candidate commands this backend
// implements, or "" when it implements none.
func (c *Capabilities) Resolve(candidates ...string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, name := range candidates {
		if c.methods[name] {
			return name
		}
	}
	return ""
}

// Supports reports a feature, or a settings key with a working setter.
func (c *Capabilities) Supports(feature string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.info.Supports[feature]
}

// Ready reports whether a probe has completed since the last Invalidate.
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

// MethodNames lists the backend's commands, sorted, for the console.
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
// be another build.
func (c *Capabilities) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ready = false
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
		go func() {
			err := c.probe(context.WithoutCancel(ctx))
			c.mu.Lock()
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

func (c *Capabilities) probe(ctx context.Context) error {
	listed, err := c.client.Call(ctx, "system.listMethods")
	if err != nil {
		return err
	}
	names, ok := listed.([]any)
	if !ok || len(names) == 0 {
		return httperr.Backend("rtorrent returned an invalid system.listMethods response")
	}
	methods := make(map[string]bool, len(names))
	for _, name := range names {
		text, ok := name.(string)
		if !ok {
			return httperr.Backend("rtorrent returned an invalid system.listMethods response")
		}
		methods[text] = true
	}
	c.mu.Lock()
	c.methods = methods
	c.mu.Unlock()

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
		return err
	}
	value := func(index int) string {
		if index >= len(versions) || versions[index].Err != nil {
			return "unknown"
		}
		return Text(versions[index].Value)
	}

	dialect := Dialect{
		DownloadMulticall: "d.multicall",
		LoadRaw:           firstAvailable(methods, []string{"load.raw_verbose", "load.raw"}, "load.raw"),
		LoadRawStart:      firstAvailable(methods, []string{"load.raw_start_verbose", "load.raw_start"}, "load.raw_start"),
		LoadURL:           firstAvailable(methods, []string{"load.verbose", "load.normal"}, "load.normal"),
		LoadURLStart:      firstAvailable(methods, []string{"load.start_verbose", "load.start"}, "load.start"),
		TorrentFields:     pickAvailable(methods, c.fields.Torrent),
		FileFields:        pickAvailable(methods, c.fields.File),
		PeerFields:        pickAvailable(methods, c.fields.Peer),
		TrackerFields:     pickAvailable(methods, c.fields.Tracker),
	}
	if methods["d.multicall2"] {
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
			all = all && methods[name]
		}
		supports[feature] = all
	}
	for _, key := range SettingKeys {
		spec, _ := Spec(key)
		found := false
		for _, name := range spec.Set {
			found = found || methods[name]
		}
		supports[key] = found
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

	c.mu.Lock()
	defer c.mu.Unlock()
	c.dialect = dialect
	c.info = BackendInfo{
		ClientVersion:  value(0),
		LibraryVersion: value(1),
		APIVersion:     value(2),
		MethodCount:    len(methods),
		Flavor:         detectFlavor(methods),
		RPCFacility:    rpcFacility,
		Supports:       supports,
	}
	c.probedAt = c.now()
	c.ready = true
	return nil
}

// pickAvailable filters candidate field commands down to those the backend
// implements, keeping their order.
func pickAvailable(available map[string]bool, candidates []string) []string {
	picked := []string{}
	for _, name := range candidates {
		if available[name] {
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
