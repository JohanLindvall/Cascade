// SPDX-License-Identifier: MIT

package rtorrent

// Where a torrent's data goes, read the way it is set.
//
// d.directory reports libtorrent's root directory: the directory a single
// file is in, but a multi-file torrent's own folder ("/downloads/X").
// d.directory.set does not take that back. It takes the directory the data
// goes into — what a load's d.directory.set names, the Add dialog's directory
// — and appends the torrent's name for a multi-file torrent, so handing it
// what d.directory reports nests the torrent a folder deeper
// ("/downloads/X/X"), on 0.9.8 as on 0.16.25. d.directory_base.set
// (d.directory.base.set from 0.16.22, which keeps the old name as a redirect)
// sets the root itself. Both strip the trailing slashes of the root they set
// — "/" or "" leaves "." — and expand a leading "~".
//
// A multi-file torrent's folder is not always named after it: a root set with
// d.directory_base.set — by another tool, or in rtorrent's own console — is
// whatever it was set to, and the image's libtorrent shortens a name too long
// for a path component (AGENTS.md quirk 12). A change keeps the folder there
// is, by its bytes on disk (Folder).
//
// d.base_path is the root as of the torrent's last open, when libtorrent
// freezes it, and empty until the first: a change shows in d.directory at
// once, in d.base_path only once the torrent opens again.

import (
	"strings"
	"unicode/utf8"
)

// shownDirectory is d.directory as the UI shows it. d.directory has no exact
// variant, but it is the base path of a multi-file torrent and the directory
// above a single file's, unless it was changed since the torrent last opened:
// where its stand-in fits the base path's bytes, they are the same path.
func shownDirectory(row Row) string {
	directory := row.text("d.directory")
	if base, exact := row.bytes("d.base_path"); exact && base != "" && MayStandIn(directory) {
		if same := parentUnlessMulti(base, row.flag("d.is_multi_file")); Reports(same, directory) {
			return shown(same, true)
		}
	}
	return directory
}

// parentUnlessMulti is the directory a torrent's base path is in, or the
// base path itself for a multi-file torrent: what d.directory names.
func parentUnlessMulti(base string, multi bool) string {
	if multi {
		return base
	}
	if cut := strings.LastIndexByte(base, '/'); cut > 0 {
		return base[:cut]
	}
	return "/"
}

// DataDirectory is the directory a torrent's data goes into, as the UI shows
// it: d.directory for a single file, the directory above a multi-file
// torrent's own folder. It is what "Change directory" offers and takes — what
// an add's directory names — and the UI reads its listing the same way
// (dataFolder in web/src/dataFolder.ts).
func DataDirectory(row Row) string {
	directory := shownDirectory(row)
	if !row.flag("d.is_multi_file") {
		return directory
	}
	switch cut := strings.LastIndexByte(directory, '/'); {
	case cut > 0:
		return directory[:cut]
	case cut == 0:
		return "/"
	}
	return ""
}

// Folder is the name of a multi-file torrent's own folder as the bytes on
// disk, to hand back to rtorrent. ok is false when rtorrent reports it by a
// stand-in (standin.go) the row cannot undo, or when rtorrent could not be
// sent it (Sendable); a root with no folder of its own, such as ".", has "",
// ok.
func Folder(row Row) (folder string, ok bool) {
	reported := baseName(row.text("d.directory"))
	switch {
	case reported == "" || reported == "." || reported == "..":
		return "", true
	case !MayStandIn(reported):
		folder = reported
	default:
		// From 0.16.13 the base path carries the bytes. It is the root as of
		// the last open, so it vouches only for a folder its own fits: the
		// directory above may have changed since, the folder seldom has.
		if base, exact := row.bytes("d.base_path"); exact && Reports(baseName(base), reported) {
			folder = baseName(base)
		}
	}
	if folder == "" || !Sendable(folder) {
		return "", false
	}
	return folder, true
}

// Sendable reports whether text reaches rtorrent as it is. XML-RPC text is
// UTF-8 — the encoder makes it so, a byte that is not becoming U+FFFD —
// xmlrpc-c 1.51 refuses a character beyond the Basic Multilingual Plane, an
// emoji, with a fault (-503 "Call XML not a proper XML-RPC call", on 0.9.8 as
// on 0.16.25), and XML cannot carry U+FFFE, U+FFFF or most control characters
// (the encoder drops them) and reads a carriage return as a line feed.
func Sendable(text string) bool {
	if !utf8.ValidString(text) {
		return false
	}
	for _, r := range text {
		if r > 0xFFFD || r == '\r' || (r < 0x20 && r != '\t' && r != '\n') {
			return false
		}
	}
	return true
}

// NamedAfterTorrent reports whether a multi-file torrent's folder is, as far
// as rtorrent's text tells, the torrent's own name — the one d.directory.set
// gives it.
func NamedAfterTorrent(row Row) bool {
	name, _ := row.bytes("d.name")
	return name != "" && Reports(name, baseName(row.text("d.directory")))
}

// JoinDirectory puts name inside directory the way d.directory.set does.
func JoinDirectory(directory, name string) string {
	if directory == "" || strings.HasSuffix(directory, "/") {
		return directory + name
	}
	return directory + "/" + name
}
