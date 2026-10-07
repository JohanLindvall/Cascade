// SPDX-License-Identifier: MIT

// Package options is every environment variable Cascade understands, in one
// place.
//
// This catalog is the single source of truth, not a copy of one:
//
//   - internal/config takes its defaults from here, so a server option cannot
//     be read without being documented: Default panics on an unknown name.
//   - --help renders it, which is what `docker run cascade --help` prints.
//   - The README's configuration tables are generated from it.
//   - Check (`cascade options-docs`) fails the build if docker/entrypoint.sh
//     reads a variable that is missing here, or if the README has drifted.
//
// Adding an option means adding it here; there is nowhere else to update.
package options

import (
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
)

// Option is one environment variable.
type Option struct {
	Name string
	// Setting is the live setting (a key of the rtorrent settings table) the
	// option is applied through at startup, validated like a change made in
	// the UI. Empty when the entrypoint or the server reads the variable itself.
	Setting string
	// KiB marks a rate given in KiB/s for a setting that takes bytes/s.
	KiB     bool
	Section string
	Summary string
	// Default is the value the code falls back to when unset, and nil when it
	// has none — which the renderers show differently from an empty default.
	Default *string
	// Note is shown in place of a default when the code has none.
	Note string
}

// Sections in order, which is also the order everything is rendered in.
var Sections = []string{
	"Paths and identity",
	"Bandwidth and slots",
	"Peers",
	"Network",
	"Trackers and DHT",
	"Storage",
	"Resource limits",
	"RPC",
	"Web server",
	"Escape hatches",
}

// SectionNotes are shown under a section's heading, where a whole group needs
// one caveat.
var SectionNotes = map[string]string{
	"Bandwidth and slots": "Rates are in KiB/s; 0 means unlimited.",
	"Escape hatches": "Settings given as environment variables are applied over XML-RPC at startup rather than " +
		"written into rtorrent.rc, so changes made in the UI last until the container restarts.",
}

const rtorrentDefault = "rtorrent default"

// Options is the catalog, in the order it is documented.
var Options = []Option{
	// --------------------------- paths and identity --------------------------
	{
		Name:    "PUID",
		Section: "Paths and identity",
		Summary: "User id rtorrent and the web server run as",
		Default: ptr("1000"),
	},
	{
		Name:    "PGID",
		Section: "Paths and identity",
		Summary: "Group id rtorrent and the web server run as",
		Default: ptr("1000"),
	},
	{
		Name:    "TZ",
		Section: "Paths and identity",
		Summary: "Container timezone",
		Default: ptr("UTC"),
	},
	{
		Name:    "RT_DOWNLOAD_DIR",
		Section: "Paths and identity",
		Summary: "Default download directory",
		Default: ptr("/downloads"),
	},
	{
		Name:    "RT_COMPLETED_DIR",
		Section: "Paths and identity",
		Summary: "Move finished downloads here",
		Note:    "unset",
	},
	{
		Name:    "RT_SESSION_DIR",
		Section: "Paths and identity",
		Summary: "rtorrent's session state",
		Default: ptr("/config/session"),
	},
	{
		Name:    "RT_WATCH_DIR",
		Section: "Paths and identity",
		Summary: ".torrent files dropped here are loaded and started",
		Default: ptr("/watch"),
	},
	{
		Name:    "RT_WATCH_ENABLE",
		Section: "Paths and identity",
		Summary: "Set 0 to ignore the watch directory",
		Default: ptr("1"),
	},
	{
		Name:    "RT_WATCH_INTERVAL",
		Section: "Paths and identity",
		Summary: "Watch-directory poll interval: seconds, MM:SS or HH:MM:SS",
		Default: ptr("10"),
	},
	{
		Name:    "RT_LOG_FILE",
		Section: "Paths and identity",
		Summary: "rtorrent's log file, surfaced in the UI",
		Default: ptr("/config/rtorrent.log"),
	},
	{
		Name:    "RT_LOG_LEVEL",
		Section: "Paths and identity",
		Summary: "Log scopes: info, debug, dht_debug, tracker_debug, … (more can be raised live from the log dialog)",
		Default: ptr("info"),
	},
	{
		Name:    "RT_UMASK",
		Section: "Paths and identity",
		Summary: "umask rtorrent creates files with, in octal",
		Default: ptr("0022"),
	},
	{
		Name:    "CASCADE_STATE_FILE",
		Section: "Paths and identity",
		Summary: "Preferences, progress, add times and throttle groups",
		Default: ptr("/config/cascade-state.json"),
	},
	{
		Name:    "CASCADE_CHOWN_DOWNLOADS",
		Section: "Paths and identity",
		Summary: "Set 1 to chown the download directory at startup (slow on large libraries)",
		Default: ptr("0"),
	},
	{
		Name:    "RT_SESSION_LOCK_KEEP",
		Section: "Paths and identity",
		Summary: "Set 1 to keep a leftover rtorrent.lock instead of clearing it",
		Default: ptr("0"),
	},

	// --------------------------- bandwidth and slots -------------------------
	{
		Name:    "RT_DOWNLOAD_RATE",
		Setting: "downloadRate",
		KiB:     true,
		Section: "Bandwidth and slots",
		Summary: "Global download limit",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_UPLOAD_RATE",
		Setting: "uploadRate",
		KiB:     true,
		Section: "Bandwidth and slots",
		Summary: "Global upload limit",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_UPLOADS",
		Setting: "maxUploads",
		Section: "Bandwidth and slots",
		Summary: "Upload slots per torrent",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MIN_UPLOADS",
		Setting: "minUploads",
		Section: "Bandwidth and slots",
		Summary: "Minimum upload slots per torrent",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_UPLOADS_GLOBAL",
		Setting: "maxUploadsGlobal",
		Section: "Bandwidth and slots",
		Summary: "Upload slots across all torrents",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_DOWNLOADS",
		Setting: "maxDownloads",
		Section: "Bandwidth and slots",
		Summary: "Download slots per torrent",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MIN_DOWNLOADS",
		Setting: "minDownloads",
		Section: "Bandwidth and slots",
		Summary: "Minimum download slots per torrent",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_DOWNLOADS_GLOBAL",
		Setting: "maxDownloadsGlobal",
		Section: "Bandwidth and slots",
		Summary: "Download slots across all torrents",
		Note:    rtorrentDefault,
	},

	// --------------------------------- peers ---------------------------------
	{
		Name:    "RT_MIN_PEERS",
		Setting: "minPeers",
		Section: "Peers",
		Summary: "Minimum peers while leeching",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_PEERS",
		Setting: "maxPeers",
		Section: "Peers",
		Summary: "Maximum peers while leeching",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MIN_PEERS_SEED",
		Setting: "minPeersSeed",
		Section: "Peers",
		Summary: "Minimum peers while seeding (-1 disables)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_PEERS_SEED",
		Setting: "maxPeersSeed",
		Section: "Peers",
		Summary: "Maximum peers while seeding (-1 disables)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_PEX",
		Setting: "pex",
		Section: "Peers",
		Summary: "Peer exchange, yes/no",
		Note:    rtorrentDefault,
	},

	// -------------------------------- network --------------------------------
	{
		Name:    "RT_PORT_RANGE",
		Section: "Network",
		Summary: "Incoming peer port range",
		Default: ptr("50000-50000"),
	},
	{
		Name:    "RT_PORT_RANDOM",
		Section: "Network",
		Summary: "Pick a random port from the range, yes/no",
		Default: ptr("no"),
	},
	{
		Name:    "RT_PORT_OPEN",
		Setting: "portOpen",
		Section: "Network",
		Summary: "Open the listening port, yes/no (removed in rtorrent 0.16)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_ENCRYPTION",
		Setting: "encryption",
		Section: "Network",
		Summary: "e.g. allow_incoming,try_outgoing,enable_retry",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_BIND",
		Setting: "bindAddress",
		Section: "Network",
		Summary: "Bind address for outgoing connections",
		Note:    "unset",
	},
	{
		Name:    "RT_IP",
		Setting: "localAddress",
		Section: "Network",
		Summary: "Address reported to trackers",
		Note:    "unset",
	},
	{
		Name:    "RT_BIND_IPV4",
		Setting: "bindAddressV4",
		Section: "Network",
		Summary: "IPv4 bind address (rtorrent 0.16+)",
		Note:    "unset",
	},
	{
		Name:    "RT_BIND_IPV6",
		Setting: "bindAddressV6",
		Section: "Network",
		Summary: "IPv6 bind address (rtorrent 0.16+)",
		Note:    "unset",
	},
	{
		Name:    "RT_PROXY",
		Setting: "proxyAddress",
		Section: "Network",
		Summary: "HTTP proxy for tracker announces",
		Note:    "unset",
	},
	{
		Name:    "RT_PROXY_HTTP",
		Setting: "proxyHttp",
		Section: "Network",
		Summary: "Proxy for all HTTP traffic (rtorrent 0.16+)",
		Note:    "unset",
	},
	{
		Name:    "RT_PROXY_GLOBAL",
		Setting: "proxyGlobal",
		Section: "Network",
		Summary: "Proxy for all traffic (rtorrent 0.16+)",
		Note:    "unset",
	},
	{
		Name:    "RT_BLOCK_OUTGOING",
		Setting: "blockOutgoing",
		Section: "Network",
		Summary: "yes refuses outgoing connections (rtorrent 0.16+)",
		Note:    rtorrentDefault,
	},

	// ----------------------------- trackers and DHT ---------------------------
	{
		Name:    "RT_DHT",
		Setting: "dhtMode",
		Section: "Trackers and DHT",
		Summary: "disable, off, auto or on",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_DHT_PORT",
		Setting: "dhtPort",
		Section: "Trackers and DHT",
		Summary: "DHT UDP port",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_DHT_OVERRIDE_PORT",
		Setting: "dhtOverridePort",
		Section: "Trackers and DHT",
		Summary: "Announce a different DHT port (rtorrent 0.16+)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_UDP_TRACKERS",
		Setting: "udpTrackers",
		Section: "Trackers and DHT",
		Summary: "Allow UDP trackers, yes/no",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_TRACKER_NUMWANT",
		Setting: "trackersNumwant",
		Section: "Trackers and DHT",
		Summary: "Peers requested per announce (-1 leaves it to the tracker)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_HTTP_CAPATH",
		Setting: "httpCapath",
		Section: "Trackers and DHT",
		Summary: "Directory of CA certificates for tracker TLS",
		Note:    "unset",
	},
	{
		Name:    "RT_HTTP_CACERT",
		Setting: "httpCacert",
		Section: "Trackers and DHT",
		Summary: "CA bundle file for tracker TLS",
		Note:    "unset",
	},
	{
		Name:    "RT_SSL_VERIFY_PEER",
		Setting: "sslVerifyPeer",
		Section: "Trackers and DHT",
		Summary: "Verify tracker TLS certificates, yes/no",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_SSL_VERIFY_HOST",
		Setting: "sslVerifyHost",
		Section: "Trackers and DHT",
		Summary: "Verify tracker TLS hostnames, yes/no",
		Note:    rtorrentDefault,
	},

	// -------------------------------- storage --------------------------------
	{
		Name:    "RT_PREALLOCATE",
		Setting: "preallocate",
		Section: "Storage",
		Summary: "Preallocate files, yes/no",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_HASH_ON_COMPLETION",
		Setting: "checkHashOnCompletion",
		Section: "Storage",
		Summary: "Re-verify on completion, yes/no",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_ADVISE_RANDOM_HASHING",
		Setting: "adviseRandomHashing",
		Section: "Storage",
		Summary: "Random-access hint while hashing, yes/no (rtorrent 0.16+)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MEMORY_MAX",
		Setting: "memoryMax",
		Section: "Storage",
		Summary: "Piece memory cap, bytes",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_FILE_SIZE",
		Setting: "maxFileSize",
		Section: "Storage",
		Summary: "Largest accepted file, bytes",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_SYNC_TIMEOUT",
		Setting: "syncTimeout",
		Section: "Storage",
		Summary: "Piece disk-sync timeout, seconds",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_PRELOAD_TYPE",
		Setting: "preloadType",
		Section: "Storage",
		Summary: "Piece preload: 0 off, 1 madvise, 2 direct paging",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_PRELOAD_MIN_SIZE",
		Setting: "preloadMinSize",
		Section: "Storage",
		Summary: "Only preload torrents above this piece size, bytes",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_PRELOAD_MIN_RATE",
		Setting: "preloadMinRate",
		Section: "Storage",
		Summary: "Only preload above this upload rate, bytes/s",
		Note:    rtorrentDefault,
	},

	// ----------------------------- resource limits ----------------------------
	{
		Name:    "RT_MAX_OPEN_FILES",
		Setting: "maxOpenFiles",
		Section: "Resource limits",
		Summary: "Open file handle cap",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_OPEN_SOCKETS",
		Setting: "maxOpenSockets",
		Section: "Resource limits",
		Summary: "Open socket cap",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_MAX_HTTP_OPEN",
		Setting: "maxHttpOpen",
		Section: "Resource limits",
		Summary: "Concurrent HTTP requests (read-only on rtorrent 0.16+)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_HTTP_MAX_HOST",
		Setting: "httpMaxHostConnections",
		Section: "Resource limits",
		Summary: "HTTP connections per host (rtorrent 0.16+)",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_DNS_CACHE_TIMEOUT",
		Setting: "dnsCacheTimeout",
		Section: "Resource limits",
		Summary: "DNS cache lifetime, seconds",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_RECEIVE_BUFFER",
		Setting: "receiveBuffer",
		Section: "Resource limits",
		Summary: "Socket receive buffer, bytes",
		Note:    rtorrentDefault,
	},
	{
		Name:    "RT_SEND_BUFFER",
		Setting: "sendBuffer",
		Section: "Resource limits",
		Summary: "Socket send buffer, bytes",
		Note:    rtorrentDefault,
	},

	// ---------------------------------- RPC ----------------------------------
	{
		Name:    "RT_SCGI_SOCKET",
		Section: "RPC",
		Summary: "Unix socket rtorrent listens on, unless RT_SCGI_PORT is set",
		Default: ptr("/run/rtorrent/rpc.socket"),
	},
	{
		Name:    "RT_SCGI_PORT",
		Section: "RPC",
		Summary: "Listen for SCGI on this TCP port instead of the socket (unauthenticated — keep it private)",
		Note:    "unset",
	},
	{
		Name:    "RT_SCGI_BIND",
		Section: "RPC",
		Summary: "Address RT_SCGI_PORT listens on; 0.0.0.0 lets a published port reach it",
		Default: ptr("127.0.0.1"),
	},
	{
		Name:    "RT_XMLRPC_SIZE_LIMIT",
		Setting: "xmlrpcSizeLimit",
		Section: "RPC",
		Summary: "Max XML-RPC request size, bytes (raises the .torrent upload ceiling)",
		Default: ptr("16777216"),
	},
	{
		Name:    "CASCADE_SCGI",
		Section: "RPC",
		Summary: "Endpoint the web server talks to — a path, or host:port for a remote rtorrent",
		Note:    "RT_SCGI_SOCKET, or RT_SCGI_PORT (on 127.0.0.1 for a wildcard RT_SCGI_BIND)",
	},

	// ------------------------------- web server -------------------------------
	{
		Name:    "WEB_PORT",
		Section: "Web server",
		Summary: "HTTP port",
		Default: ptr("8080"),
	},
	{
		Name:    "WEB_HOST",
		Section: "Web server",
		Summary: "Bind address",
		Default: ptr("0.0.0.0"),
	},
	{
		Name:    "WEB_USER",
		Section: "Web server",
		Summary: "Basic-auth user; auth is enabled only when both are set",
		Note:    "unset (no auth)",
	},
	{
		Name:    "WEB_PASS",
		Section: "Web server",
		Summary: "Basic-auth password",
		Note:    "unset (no auth)",
	},
	{
		Name:    "WEB_BASE_PATH",
		Section: "Web server",
		Summary: "Serve under a sub-path, e.g. /rtorrent",
		Default: ptr("/"),
	},
	{
		Name:    "CASCADE_ALLOW_RAW_RPC",
		Section: "Web server",
		Summary: "Set 0 to disable the API console and /RPC2",
		Default: ptr("1"),
	},
	{
		Name:    "CASCADE_ALLOW_DATA_DELETE",
		Section: "Web server",
		Summary: "Set 0 to forbid deleting downloaded data",
		Default: ptr("1"),
	},
	{
		Name:    "CASCADE_DELETE_ROOTS",
		Section: "Web server",
		Summary: "Extra :-separated roots data may be deleted from",
		Note:    "download + completed dirs",
	},
	{
		Name:    "CASCADE_MAX_UPLOAD_MB",
		Section: "Web server",
		Summary: "Maximum combined .torrent file size per upload batch, MiB",
		Default: ptr("64"),
	},
	{
		Name:    "CASCADE_POLL_MS",
		Section: "Web server",
		Summary: "Backend sampling interval for the rate graph, ms",
		Default: ptr("1000"),
	},
	{
		Name:    "CASCADE_STATE_POLL_MS",
		Section: "Web server",
		Summary: "How often the torrent list is read while a page is open, ms (100-60000; the UI can override it)",
		Default: ptr("500"),
	},
	{
		Name:    "CASCADE_GAMIFY",
		Section: "Web server",
		Summary: "Set 0 to remove levels, badges and celebrations",
		Default: ptr("1"),
	},
	{
		Name:    "CASCADE_WEB_ROOT",
		Section: "Web server",
		Summary: "Directory the built UI is served from",
		Default: ptr("/app/web"),
	},

	// ----------------------------- escape hatches -----------------------------
	{
		Name:    "RT_EXTRA_CONFIG",
		Section: "Escape hatches",
		Summary: "Raw rtorrent.rc lines appended to the generated config",
		Note:    "unset",
	},
	{
		Name:    "RT_EXTRA_CONFIG_FILE",
		Section: "Escape hatches",
		Summary: "File of extra rtorrent.rc lines to append",
		Note:    "unset",
	},
	{
		Name:    "RT_CONFIG_FILE",
		Section: "Escape hatches",
		Summary: "Use this rtorrent.rc verbatim instead of generating one",
		Default: ptr("/config/rtorrent.rc"),
	},
	{
		Name:    "RT_CONFIG_KEEP",
		Section: "Escape hatches",
		Summary: "Set 0 to regenerate RT_CONFIG_FILE on every start",
		Default: ptr("1"),
	},
	{
		Name:    "CASCADE_BOOT_SETTINGS",
		Section: "Escape hatches",
		Summary: "Where the entrypoint stages the settings it hands the server",
		Default: ptr("/run/cascade/boot-settings.json"),
	},
}

func ptr(value string) *string { return &value }

// UsageExample is the canonical `docker run` invocation, shown by --help and
// pasted into the README by `cascade options-docs --write`, so the two can
// never disagree.
const UsageExample = `docker run \
  -d \
  --name=cascade \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=Europe/Stockholm \
  -e WEB_USER=admin \
  -e WEB_PASS=change-me \
  -e RT_PORT_RANGE=50000-50000 \
  -p 8080:8080 \
  -p 50000:50000 \
  -p 50000:50000/udp \
  -v /home/torrent/config:/config \
  -v /home/torrent/downloads:/downloads \
  -v /home/torrent/watch:/watch \
  --restart unless-stopped \
  --stop-timeout 60 \
  ghcr.io/johanlindvall/cascade:latest`

var byName = func() map[string]Option {
	options := make(map[string]Option, len(Options))
	for _, option := range Options {
		options[option.Name] = option
	}
	return options
}()

// Lookup returns the catalogued option of that name.
func Lookup(name string) (Option, bool) {
	option, ok := byName[name]
	return option, ok
}

// Default returns the documented default of an option, with ok false when the
// option has none.
//
// It panics for a name that is not catalogued, which is what stops the server
// reading an undocumented environment variable: internal/config goes through
// here, and its tests read every variable it knows.
func Default(name string) (value string, ok bool) {
	option, found := byName[name]
	if !found {
		panic(name + " is read but not listed in options.go — add it there")
	}
	if option.Default == nil {
		return "", false
	}
	return *option.Default, true
}

// InSection returns the options of one section, in catalog order.
func InSection(section string) []Option {
	var options []Option
	for _, option := range Options {
		if option.Section == section {
			options = append(options, option)
		}
	}
	return options
}

// defaultLabel is what the help shows in place of a default when the code has
// no fallback.
func defaultLabel(option Option) string {
	switch {
	case option.Default != nil:
		return *option.Default
	case option.Note != "":
		return option.Note
	default:
		return "—"
	}
}

/* -------------------------------- rendering ------------------------------- */

// HelpWidth is the width --help is rendered at.
const HelpWidth = 96

// textWidth measures text as the renderer always has, in UTF-16 code units:
// an em dash is one column rather than its three bytes, and the output stays
// identical to the published help and README tables.
func textWidth(text string) int {
	width := 0
	for _, r := range text {
		if r > 0xFFFF {
			width += 2
		} else {
			width++
		}
	}
	return width
}

func wrap(text string, width int) []string {
	var lines []string
	line, lineWidth := "", 0
	// Words split on JavaScript's \s, as the rendering always has: not
	// U+0085, but the byte order mark.
	for _, word := range strings.FieldsFunc(text, jsnum.IsSpace) {
		wordWidth := textWidth(word)
		switch {
		case line != "" && lineWidth+1+wordWidth > width:
			lines = append(lines, line)
			line, lineWidth = word, wordWidth
		case line != "":
			line += " " + word
			lineWidth += 1 + wordWidth
		default:
			line, lineWidth = word, wordWidth
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}

// RenderHelp renders `docker run --rm cascade --help` for a terminal of the
// given width.
func RenderHelp(width int) string {
	nameWidth := 0
	for _, option := range Options {
		nameWidth = max(nameWidth, textWidth(option.Name))
	}
	// The default rides at the end of the description rather than in a column of
	// its own: one long note would otherwise squeeze every summary on the page.
	summaryWidth := max(32, width-nameWidth-4)

	out := []string{
		"Cascade — a web UI for rtorrent, with rtorrent itself in the image.",
		"",
		"Usage:",
	}
	for _, line := range strings.Split(UsageExample, "\n") {
		out = append(out, "  "+line)
	}
	out = append(out,
		"",
		"Volumes:",
		"  /config     rtorrent session, log, and Cascade state — keep this one",
		"  /downloads  where the data lands",
		"  /watch      .torrent files dropped here are loaded and started",
		"",
		"Ports:",
		"  8080        the web UI and API (WEB_PORT)",
		"  50000       peer traffic, TCP and UDP (RT_PORT_RANGE)",
		"",
		"Everything else is an environment variable (-e NAME=value). Only what you",
		"set is applied; anything left unset keeps the default shown below.",
	)

	indent := strings.Repeat(" ", nameWidth)
	for _, section := range Sections {
		options := InSection(section)
		if len(options) == 0 {
			continue
		}
		out = append(out, "", strings.ToUpper(section))
		if note := SectionNotes[section]; note != "" {
			for _, line := range wrap(note, width-2) {
				out = append(out, "  "+line)
			}
		}
		for _, option := range options {
			lines := wrap(option.Summary+" ["+defaultLabel(option)+"]", summaryWidth)
			name := option.Name + strings.Repeat(" ", nameWidth-textWidth(option.Name))
			out = append(out, "  "+name+"  "+lines[0])
			for _, extra := range lines[1:] {
				out = append(out, "  "+indent+"  "+extra)
			}
		}
	}

	out = append(out, "", "Full documentation: https://github.com/JohanLindvall/Cascade")
	return strings.Join(out, "\n")
}

// RenderMarkdown renders the README's configuration tables.
func RenderMarkdown() string {
	var out []string
	for _, section := range Sections {
		options := InSection(section)
		if len(options) == 0 {
			continue
		}
		out = append(out, "### "+section, "")
		if note := SectionNotes[section]; note != "" {
			out = append(out, note, "")
		}
		out = append(out, "| Variable | Default | Meaning |", "| --- | --- | --- |")
		for _, option := range options {
			value := option.Note
			switch {
			case option.Default != nil && *option.Default != "":
				value = "`" + *option.Default + "`"
			case value == "":
				value = "—"
			}
			out = append(out, "| `"+option.Name+"` | "+value+" | "+option.Summary+" |")
		}
		out = append(out, "")
	}
	return strings.TrimRightFunc(strings.Join(out, "\n"), jsnum.IsSpace)
}
