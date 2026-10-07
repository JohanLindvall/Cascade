// SPDX-License-Identifier: MIT

package rtorrent

// The field model: which commands each multicall asks for, and how a row of
// their answers becomes what the UI shows.

import (
	"encoding/base64"
	"math"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
	"github.com/JohanLindvall/Cascade/server/internal/utf8text"
)

// TorrentFields are asked for in the listing multicall. Only fields something
// maps: every stray field is one more command per torrent per poll on a
// single-threaded rtorrent.
var TorrentFields = []string{
	"d.hash",
	"d.name",
	"d.size_bytes",
	"d.completed_bytes",
	"d.left_bytes",
	"d.down.rate",
	"d.up.rate",
	"d.down.total",
	"d.up.total",
	"d.ratio",
	"d.is_open",
	"d.is_active",
	"d.is_private",
	"d.is_multi_file",
	"d.complete",
	"d.hashing",
	"d.hashing_failed",
	"d.message",
	"d.priority",
	"d.directory",
	"d.base_path",
	"d.custom1",
	"d.throttle_name",
	"d.chunk_size",
	"d.completed_chunks",
	"d.size_chunks",
	"d.peers_connected",
	"d.peers_not_connected",
	"d.peers_complete",
	"d.tracker_size",
	"d.timestamp.started",
	"d.timestamp.finished",
	"d.creation_date",
}

// ExactFields maps a name or path field to the variant that carries its bytes
// exactly, as base64 (rtorrent 0.16.13 and later). Where a backend has the
// variant it is asked for in the field's place, at the same cost: the plain
// field arrives as a stand-in for any name that is not UTF-8 or holds an
// emoji (see standin.go). d.directory has no such variant.
var ExactFields = map[string]string{
	"d.name":        "d.name.base64",
	"d.base_path":   "d.base_path.base64",
	"f.path":        "f.path_components.base64",
	"f.frozen_path": "f.frozen_path.base64",
}

// FileFields are asked for in f.multicall.
var FileFields = []string{
	"f.path",
	"f.frozen_path",
	"f.size_bytes",
	"f.completed_chunks",
	"f.size_chunks",
	"f.priority",
	"f.is_created",
}

// PeerFields are asked for in p.multicall.
var PeerFields = []string{
	"p.id",
	"p.address",
	"p.port",
	"p.client_version",
	"p.completed_percent",
	"p.up_rate",
	"p.down_rate",
	"p.up_total",
	"p.down_total",
	"p.peer_rate",
	"p.peer_total",
	"p.is_encrypted",
	"p.is_obfuscated",
	"p.is_incoming",
	"p.is_snubbed",
	"p.is_preferred",
	"p.is_unwanted",
	"p.banned",
	"p.options_str",
}

// TrackerFields are asked for in t.multicall.
var TrackerFields = []string{
	"t.url",
	"t.type",
	"t.group",
	"t.id",
	"t.is_enabled",
	"t.is_usable",
	"t.is_open",
	"t.is_busy",
	"t.is_extra_tracker",
	"t.can_scrape",
	"t.scrape_complete",
	"t.scrape_incomplete",
	"t.scrape_downloaded",
	"t.scrape_time_last",
	"t.scrape_counter",
	"t.success_counter",
	"t.success_time_last",
	"t.success_time_next",
	"t.failed_counter",
	"t.failed_time_last",
	"t.failed_time_next",
	"t.latest_event",
	"t.latest_new_peers",
	"t.latest_sum_peers",
	"t.normal_interval",
	"t.min_interval",
	"t.activity_time_last",
	"t.activity_time_next",
}

// number reads a field as a number; a field this backend lacks, or junk,
// reads as 0.
func (r Row) number(key string) float64 {
	return Number(r[key])
}

// integer reads a field as an integer, exactly when rtorrent sent one.
func (r Row) integer(key string) int64 {
	if v, ok := r[key].(int64); ok {
		return v
	}
	n := r.number(key)
	if n >= math.MaxInt64 || n <= math.MinInt64 {
		return 0
	}
	return int64(n)
}

func (r Row) flag(key string) bool { return r.number(key) != 0 }

// text reads a field as text; 8-bit strings arrive as bytes and read as
// UTF-8, and a list or struct where text belongs reads as "".
func (r Row) text(key string) string {
	switch v := r[key].(type) {
	case []any, map[string]any:
		return ""
	default:
		return Text(v)
	}
}

// bytes reads a name or path field: the bytes rtorrent holds when the row
// carries its exact variant (ExactFields), and rtorrent's text otherwise.
// exact says which.
func (r Row) bytes(key string) (value string, exact bool) {
	encoded, ok := r[ExactFields[key]]
	if !ok {
		return r.text(key), false
	}
	// f.path_components.base64 is a list, a component each.
	if parts, isList := encoded.([]any); isList {
		decoded := make([]string, len(parts))
		for i, part := range parts {
			decoded[i] = fromBase64(Text(part))
		}
		return strings.Join(decoded, "/"), true
	}
	return fromBase64(Text(encoded)), true
}

// fromBase64 is the bytes base64 text carries, or the text itself should
// rtorrent ever answer with something else.
func fromBase64(text string) string {
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return text
	}
	return string(raw)
}

// shown is a name or path as the UI shows it: exact bytes are read as UTF-8
// the way a browser reads them, U+FFFD for what is not; rtorrent's own text
// is already text.
func shown(value string, exact bool) string {
	if exact {
		return utf8text.Decode([]byte(value))
	}
	return value
}

// TextOf reads the answer to a name or path field, or to its exact variant,
// as text to show.
func TextOf(field string, value any) string {
	for plain, variant := range ExactFields {
		if field == variant {
			return shown(Row{variant: value}.bytes(plain))
		}
	}
	return Text(value)
}

// isRealError tells a torrent that is broken from one whose tracker is
// merely complaining: rtorrent puts transient announce failures in the
// message too, prefixed "Tracker:" in any case.
func isRealError(message string, hashingFailed int64) bool {
	if hashingFailed != 0 {
		return true
	}
	const tracker = "Tracker:"
	return message != "" && !(len(message) >= len(tracker) && strings.EqualFold(message[:len(tracker)], tracker))
}

// decodeLabel undoes the URL encoding labels are stored under in d.custom1
// (the ruTorrent convention). Another client may have written a raw string
// there; a stray "%" must not take the whole torrent list down.
func decodeLabel(value string) string {
	if decoded, ok := decodeURIComponent(value); ok {
		return decoded
	}
	return value
}

// decodeURIComponent decodes %XX escapes as the browser's function of that
// name does, refusing — so the caller keeps the raw text — a malformed escape
// or escapes that do not spell UTF-8.
func decodeURIComponent(value string) (string, bool) {
	if !strings.Contains(value, "%") {
		return value, true
	}
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] != '%' {
			out.WriteByte(value[i])
			continue
		}
		b, ok := escapedByte(value, i)
		if !ok {
			return "", false
		}
		i += 2
		if b < 0x80 {
			out.WriteByte(b)
			continue
		}
		var n int
		switch {
		case b&0xE0 == 0xC0:
			n = 2
		case b&0xF0 == 0xE0:
			n = 3
		case b&0xF8 == 0xF0:
			n = 4
		default:
			return "", false
		}
		sequence := []byte{b}
		for j := 1; j < n; j++ {
			i++
			if i >= len(value) || value[i] != '%' {
				return "", false
			}
			next, ok := escapedByte(value, i)
			if !ok || next&0xC0 != 0x80 {
				return "", false
			}
			i += 2
			sequence = append(sequence, next)
		}
		// Overlong forms, surrogates and code points past U+10FFFF are
		// refused here just as they are there.
		if r, size := utf8.DecodeRune(sequence); r == utf8.RuneError && size <= 1 {
			return "", false
		}
		out.Write(sequence)
	}
	return out.String(), true
}

func escapedByte(value string, at int) (byte, bool) {
	if at+2 >= len(value) {
		return 0, false
	}
	b, err := strconv.ParseUint(value[at+1:at+3], 16, 8)
	return byte(b), err == nil
}

// MapTorrent turns a listing row into a Torrent. addedAt is when Cascade
// first saw it, which rtorrent does not keep.
func MapTorrent(row Row, addedAt int64) contracts.Torrent {
	size := row.integer("d.size_bytes")
	completed := row.integer("d.completed_bytes")
	left := row.integer("d.left_bytes")
	downRate := row.integer("d.down.rate")
	isOpen := row.flag("d.is_open")
	isActive := row.flag("d.is_active")
	complete := row.flag("d.complete")
	hashing := row.integer("d.hashing")
	message := row.text("d.message")
	name, exactName := row.bytes("d.name")
	base, exactBase := row.bytes("d.base_path")

	var status contracts.TorrentStatus
	switch {
	case isRealError(message, row.integer("d.hashing_failed")):
		status = contracts.StatusError
	case hashing > 0:
		status = contracts.StatusChecking
	case !isOpen:
		status = contracts.StatusStopped
	case !isActive:
		status = contracts.StatusPaused
	case complete:
		status = contracts.StatusSeeding
	default:
		status = contracts.StatusDownloading
	}

	var eta *int64
	switch {
	case !complete && downRate > 0 && left > 0:
		seconds := int64(jsnum.Round(float64(left) / float64(downRate)))
		eta = &seconds
	case complete:
		zero := int64(0)
		eta = &zero
	}

	progress := 0.0
	switch {
	case complete:
		progress = 1
	case size > 0:
		progress = math.Min(1, math.Max(0, float64(completed)/float64(size)))
	}

	return contracts.Torrent{
		Hash:              row.text("d.hash"),
		Name:              shown(name, exactName),
		Status:            status,
		Progress:          progress,
		Size:              size,
		Completed:         completed,
		Left:              left,
		DownRate:          downRate,
		UpRate:            row.integer("d.up.rate"),
		DownTotal:         row.integer("d.down.total"),
		UpTotal:           row.integer("d.up.total"),
		Ratio:             row.number("d.ratio") / 1000,
		ETA:               eta,
		Priority:          row.integer("d.priority"),
		Label:             decodeLabel(row.text("d.custom1")),
		Message:           message,
		Directory:         shownDirectory(row),
		BasePath:          shown(base, exactBase),
		Throttle:          row.text("d.throttle_name"),
		IsOpen:            isOpen,
		IsActive:          isActive,
		IsPrivate:         row.flag("d.is_private"),
		IsMultiFile:       row.flag("d.is_multi_file"),
		Hashing:           hashing,
		ChunkSize:         row.integer("d.chunk_size"),
		ChunksDone:        row.integer("d.completed_chunks"),
		ChunksTotal:       row.integer("d.size_chunks"),
		PeersConnected:    row.integer("d.peers_connected"),
		PeersNotConnected: row.integer("d.peers_not_connected"),
		PeersComplete:     row.integer("d.peers_complete"),
		TrackerCount:      row.integer("d.tracker_size"),
		AddedAt:           addedAt,
		StartedAt:         row.integer("d.timestamp.started"),
		FinishedAt:        row.integer("d.timestamp.finished"),
		CreatedAt:         row.integer("d.creation_date"),
	}
}

func baseName(path string) string {
	return path[strings.LastIndexByte(path, '/')+1:]
}

// MapFile turns an f.multicall row into a TorrentFile.
func MapFile(row Row, index int) contracts.TorrentFile {
	sizeChunks := row.integer("f.size_chunks")
	done := row.integer("f.completed_chunks")
	path, exactPath := row.bytes("f.path")
	// f.frozen_path is the absolute path the file was opened under; only its
	// last component is compared, since the directories above it are the
	// torrent's base path and already shown as such. rtorrent sends a
	// stand-in for a string as a whole (see standin.go), so a name that
	// arrives as itself in f.path arrives escaped in a frozen path whose
	// directory is not UTF-8: the same name, not a shortened one.
	frozen, exactFrozen := row.bytes("f.frozen_path")
	onDisk := ""
	if name, disk := baseName(path), baseName(frozen); frozen != "" && disk != name && !Reports(name, disk) {
		onDisk = shown(disk, exactFrozen)
	}
	progress := 0.0
	if sizeChunks > 0 {
		progress = math.Min(1, float64(done)/float64(sizeChunks))
	}
	return contracts.TorrentFile{
		Index:           index,
		Path:            shown(path, exactPath),
		OnDisk:          onDisk,
		Size:            row.integer("f.size_bytes"),
		CompletedChunks: done,
		SizeChunks:      sizeChunks,
		Priority:        row.integer("f.priority"),
		Progress:        progress,
		Created:         row.flag("f.is_created"),
	}
}

// MapPeer turns a p.multicall row into a Peer.
func MapPeer(row Row) contracts.Peer {
	return contracts.Peer{
		ID:         row.text("p.id"),
		Address:    row.text("p.address"),
		Port:       row.integer("p.port"),
		Client:     row.text("p.client_version"),
		Progress:   row.number("p.completed_percent") / 100,
		UpRate:     row.integer("p.up_rate"),
		DownRate:   row.integer("p.down_rate"),
		UpTotal:    row.integer("p.up_total"),
		DownTotal:  row.integer("p.down_total"),
		PeerRate:   row.integer("p.peer_rate"),
		PeerTotal:  row.integer("p.peer_total"),
		Encrypted:  row.flag("p.is_encrypted"),
		Obfuscated: row.flag("p.is_obfuscated"),
		Incoming:   row.flag("p.is_incoming"),
		Snubbed:    row.flag("p.is_snubbed"),
		Preferred:  row.flag("p.is_preferred"),
		Unwanted:   row.flag("p.is_unwanted"),
		Banned:     row.flag("p.banned"),
		Options:    row.text("p.options_str"),
	}
}

// MapTracker turns a t.multicall row into a Tracker.
func MapTracker(row Row, index int) contracts.Tracker {
	return contracts.Tracker{
		Index:        index,
		URL:          row.text("t.url"),
		Type:         row.integer("t.type"),
		Group:        row.integer("t.group"),
		TrackerID:    row.text("t.id"),
		Enabled:      row.flag("t.is_enabled"),
		Usable:       row.flag("t.is_usable"),
		Open:         row.flag("t.is_open"),
		Busy:         row.flag("t.is_busy"),
		Extra:        row.flag("t.is_extra_tracker"),
		CanScrape:    row.flag("t.can_scrape"),
		Seeders:      row.integer("t.scrape_complete"),
		Leechers:     row.integer("t.scrape_incomplete"),
		Downloaded:   row.integer("t.scrape_downloaded"),
		LastScrape:   row.integer("t.scrape_time_last"),
		Scrapes:      row.integer("t.scrape_counter"),
		Successes:    row.integer("t.success_counter"),
		LastSuccess:  row.integer("t.success_time_last"),
		NextSuccess:  row.integer("t.success_time_next"),
		Failures:     row.integer("t.failed_counter"),
		LastFailure:  row.integer("t.failed_time_last"),
		NextFailure:  row.integer("t.failed_time_next"),
		LatestEvent:  row.integer("t.latest_event"),
		NewPeers:     row.integer("t.latest_new_peers"),
		SumPeers:     row.integer("t.latest_sum_peers"),
		Interval:     row.integer("t.normal_interval"),
		MinInterval:  row.integer("t.min_interval"),
		LastActivity: row.integer("t.activity_time_last"),
		NextActivity: row.integer("t.activity_time_next"),
	}
}

// specialSchemes are the schemes whose host is a domain, which the browser's
// URL lower-cases; any other scheme (udp:, most trackers) keeps its host as
// written.
var specialSchemes = map[string]bool{"http": true, "https": true, "ws": true, "wss": true, "ftp": true, "file": true}

// TrackerHost reads the host out of a tracker URL of any scheme, as the
// browser's URL.hostname does for the URLs trackers use: an IPv6 address
// keeps its brackets, and a URL with no host — or that is not a URL — is
// "unknown".
func TrackerHost(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Scheme == "" {
		return "unknown"
	}
	host := u.Hostname()
	if host == "" {
		return "unknown"
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if specialSchemes[strings.ToLower(u.Scheme)] {
		host = strings.ToLower(host)
	}
	return host
}
