// SPDX-License-Identifier: MIT

// Package torrentfile has just enough bencode to validate a .torrent and
// derive its info hash.
//
// rtorrent's load.raw_start returns 0 whether or not the payload is a real
// torrent — a bad file only shows up later in its log — so an upload that is
// never going to work has to be caught here if the user is to hear about it.
package torrentfile

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"math"
	"strings"

	"github.com/JohanLindvall/Cascade/server/internal/utf8text"
)

// Info is what an upload needs from a torrent: the hash rtorrent will list it
// under, and a name and size to report.
type Info struct {
	InfoHash string
	Name     string
	Size     int64
}

// maxSafeInteger bounds every bencode integer: past it a JSON number, and so
// the browser, could not carry a size exactly, and no loadable torrent is
// that large.
const maxSafeInteger = 1<<53 - 1

// A torrent is read in two passes over the bytes, and neither builds the
// document: an upload may be tens of megabytes, and a tree of it — a boxed
// value per list item, a map per dictionary — cost many times that in memory
// for input that only has to be checked. The first pass validates the whole
// structure (so a broken document is reported as broken, whatever else is
// wrong with it); the second looks up the few values an upload needs by
// their offsets.

// check validates the value at start and returns where it ends.
func check(buf []byte, start, depth int) (int, error) {
	if depth > 100 {
		return 0, errors.New("nesting too deep")
	}
	if start >= len(buf) {
		return 0, errors.New("truncated")
	}
	switch marker := buf[start]; {
	case marker == 'i':
		end := bytes.IndexByte(buf[start+1:], 'e')
		if end < 0 {
			return 0, errors.New("unterminated integer")
		}
		end += start + 1
		if _, ok := integer(buf[start+1:end], true); !ok {
			return 0, errors.New("bad integer")
		}
		return end + 1, nil

	case marker == 'l':
		offset := start + 1
		for offset >= len(buf) || buf[offset] != 'e' {
			end, err := check(buf, offset, depth+1)
			if err != nil {
				return 0, err
			}
			offset = end
		}
		return offset + 1, nil

	case marker == 'd':
		var previous []byte
		offset := start + 1
		for offset >= len(buf) || buf[offset] != 'e' {
			keyEnd, err := check(buf, offset, depth+1)
			if err != nil {
				return 0, err
			}
			name, _, ok := stringAt(buf, offset)
			if !ok {
				return 0, errors.New("non-string dictionary key")
			}
			if previous != nil && bytes.Compare(previous, name) >= 0 {
				return 0, errors.New("duplicate or unsorted dictionary key")
			}
			previous = name
			if offset, err = check(buf, keyEnd, depth+1); err != nil {
				return 0, err
			}
		}
		return offset + 1, nil

	case marker < '0' || marker > '9':
		return 0, errors.New("bad string length")
	}

	colon := bytes.IndexByte(buf[start:], ':')
	if colon < 0 {
		return 0, errors.New("unterminated string")
	}
	colon += start
	length, ok := integer(buf[start:colon], false)
	if !ok {
		return 0, errors.New("bad string length")
	}
	from := colon + 1
	if length > int64(len(buf)-from) {
		return 0, errors.New("string past end of data")
	}
	return from + int(length), nil
}

/* What follows reads a buffer check has passed, so it never re-validates. */

// end is where the value at start ends.
func end(buf []byte, start int) int {
	switch buf[start] {
	case 'i':
		return start + bytes.IndexByte(buf[start:], 'e') + 1
	case 'l', 'd':
		offset := start + 1
		for buf[offset] != 'e' {
			offset = end(buf, offset)
		}
		return offset + 1
	}
	_, stop, _ := stringAt(buf, start)
	return stop
}

// stringAt is the string at start and where it ends, or false for another
// kind of value.
func stringAt(buf []byte, start int) ([]byte, int, bool) {
	if buf[start] < '0' || buf[start] > '9' {
		return nil, 0, false
	}
	colon := start + bytes.IndexByte(buf[start:], ':')
	length, _ := integer(buf[start:colon], false)
	stop := colon + 1 + int(length)
	return buf[colon+1 : stop], stop, true
}

// integerAt is the integer at start, or false for another kind of value.
func integerAt(buf []byte, start int) (int64, bool) {
	if buf[start] != 'i' {
		return 0, false
	}
	n, _ := integer(buf[start+1:start+bytes.IndexByte(buf[start:], 'e')], true)
	return n, true
}

// lookup finds a key of the dictionary at start and returns where its value
// begins; check has made the keys unique, so the first match is the only one.
func lookup(buf []byte, start int, key string) (int, bool) {
	if buf[start] != 'd' {
		return 0, false
	}
	offset := start + 1
	for buf[offset] != 'e' {
		name, value, _ := stringAt(buf, offset)
		if string(name) == key {
			return value, true
		}
		offset = end(buf, value)
	}
	return 0, false
}

// each calls visit with where every item of the list at start begins.
func each(buf []byte, start int, visit func(item int) error) error {
	for offset := start + 1; buf[offset] != 'e'; offset = end(buf, offset) {
		if err := visit(offset); err != nil {
			return err
		}
	}
	return nil
}

// integer reads canonical decimal — no leading zeros, no "-0" — within the
// safe-integer range.
func integer(text []byte, signed bool) (int64, bool) {
	digits := text
	if signed && len(digits) > 0 && digits[0] == '-' {
		digits = digits[1:]
		if len(digits) > 0 && digits[0] == '0' {
			return 0, false
		}
	}
	if len(digits) == 0 || (digits[0] == '0' && len(digits) > 1) || len(digits) > 16 {
		return 0, false
	}
	var n int64
	for _, c := range digits {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int64(c-'0')
	}
	if n > maxSafeInteger {
		return 0, false
	}
	if len(digits) < len(text) {
		n = -n
	}
	return n, true
}

// Parse validates a .torrent and derives its info hash, or says why it is not
// one.
func Parse(data []byte) (Info, error) {
	info, err := parse(data)
	if err != nil {
		return Info{}, errors.New("not a valid .torrent file (" + err.Error() + ")")
	}
	return info, nil
}

// absent marks a value that is not there, for the readers below.
const absent = -1

func parse(data []byte) (Info, error) {
	rootEnd, err := check(data, 0, 0)
	if err != nil {
		return Info{}, err
	}
	if rootEnd != len(data) {
		return Info{}, errors.New("trailing data")
	}
	if data[0] != 'd' {
		return Info{}, errors.New("expected a dictionary")
	}
	info, ok := lookup(data, 0, "info")
	if !ok || data[info] != 'd' {
		return Info{}, errors.New("no info dictionary")
	}
	field := func(key string) int {
		if at, ok := lookup(data, info, key); ok {
			return at
		}
		return absent
	}
	pieces, piecesIsString := stringField(data, field("pieces"))
	if version, ok := integerField(data, field("meta version")); ok && version == 2 && !piecesIsString {
		return Info{}, errors.New("v2-only torrents are not supported by rtorrent")
	}
	name, err := component(data, field("name"))
	if err != nil {
		return Info{}, err
	}
	pieceLength, ok := integerField(data, field("piece length"))
	if !ok || pieceLength <= 0 {
		return Info{}, errors.New("invalid piece length")
	}
	if !piecesIsString || len(pieces)%20 != 0 {
		return Info{}, errors.New("invalid pieces")
	}
	length, files := field("length"), field("files")
	if (length == absent) == (files == absent) {
		return Info{}, errors.New("expected either length or files")
	}
	var size int64
	if length != absent {
		if size, err = fileLength(data, length); err != nil {
			return Info{}, err
		}
	} else {
		if data[files] != 'l' || data[files+1] == 'e' {
			return Info{}, errors.New("invalid file list")
		}
		err := each(data, files, func(file int) error {
			if data[file] != 'd' {
				return errors.New("invalid file entry")
			}
			at := func(key string) int {
				if at, ok := lookup(data, file, key); ok {
					return at
				}
				return absent
			}
			n, err := fileLength(data, at("length"))
			if err != nil {
				return err
			}
			if size += n; size > maxSafeInteger {
				return errors.New("torrent is too large")
			}
			path := at("path")
			if path == absent || data[path] != 'l' || data[path+1] == 'e' {
				return errors.New("invalid file path")
			}
			return each(data, path, func(part int) error { return checkComponent(data, part) })
		})
		if err != nil {
			return Info{}, err
		}
	}
	// In floating point, as JavaScript computed it before: for every size a
	// torrent can have this is the exact ceiling, and it stays identical.
	if float64(len(pieces))/20 != math.Ceil(float64(size)/float64(pieceLength)) {
		return Info{}, errors.New("piece count does not match torrent size")
	}
	sum := sha1.Sum(data[info:end(data, info)])
	return Info{InfoHash: strings.ToUpper(hex.EncodeToString(sum[:])), Name: name, Size: size}, nil
}

func stringField(buf []byte, at int) ([]byte, bool) {
	if at == absent {
		return nil, false
	}
	text, _, ok := stringAt(buf, at)
	return text, ok
}

func integerField(buf []byte, at int) (int64, bool) {
	if at == absent {
		return 0, false
	}
	return integerAt(buf, at)
}

func fileLength(buf []byte, at int) (int64, error) {
	n, ok := integerField(buf, at)
	if !ok || n < 0 {
		return 0, errors.New("invalid file length")
	}
	return n, nil
}

// component is a path component as text. It is checked on the raw bytes, so
// the thousands of components of a large torrent cost no allocations: "."
// and ".." are ASCII, and no ill-formed byte decodes to either.
func component(buf []byte, at int) (string, error) {
	if err := checkComponent(buf, at); err != nil {
		return "", err
	}
	raw, _ := stringField(buf, at)
	return utf8text.Decode(raw), nil
}

// checkComponent is component for a file path, whose text nothing keeps.
func checkComponent(buf []byte, at int) error {
	raw, ok := stringField(buf, at)
	if !ok || len(raw) == 0 || bytes.IndexByte(raw, 0) >= 0 || bytes.IndexByte(raw, '/') >= 0 ||
		string(raw) == "." || string(raw) == ".." {
		return errors.New("invalid path component")
	}
	return nil
}
