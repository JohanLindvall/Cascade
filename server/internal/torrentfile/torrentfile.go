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
	"strconv"
	"strings"
	"unicode/utf8"
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

// dict keys are the key bytes as a string: one-to-one, so distinct keys stay
// distinct whatever their encoding.
type dict map[string]any

type decoded struct {
	value    any // int64, []byte, []any or dict
	end      int
	infoSpan []int // [start, end) of the top-level info value, verbatim
}

func decode(buf []byte, start, depth int) (decoded, error) {
	if depth > 100 {
		return decoded{}, errors.New("nesting too deep")
	}
	if start >= len(buf) {
		return decoded{}, errors.New("truncated")
	}
	switch marker := buf[start]; {
	case marker == 'i':
		end := bytes.IndexByte(buf[start+1:], 'e')
		if end < 0 {
			return decoded{}, errors.New("unterminated integer")
		}
		end += start + 1
		n, ok := integer(buf[start+1:end], true)
		if !ok {
			return decoded{}, errors.New("bad integer")
		}
		return decoded{value: n, end: end + 1}, nil

	case marker == 'l':
		items := []any{}
		offset := start + 1
		for offset >= len(buf) || buf[offset] != 'e' {
			item, err := decode(buf, offset, depth+1)
			if err != nil {
				return decoded{}, err
			}
			items = append(items, item.value)
			offset = item.end
		}
		return decoded{value: items, end: offset + 1}, nil

	case marker == 'd':
		result := dict{}
		var infoSpan []int
		var previous []byte
		offset := start + 1
		for offset >= len(buf) || buf[offset] != 'e' {
			key, err := decode(buf, offset, depth+1)
			if err != nil {
				return decoded{}, err
			}
			name, ok := key.value.([]byte)
			if !ok {
				return decoded{}, errors.New("non-string dictionary key")
			}
			if previous != nil && bytes.Compare(previous, name) >= 0 {
				return decoded{}, errors.New("duplicate or unsorted dictionary key")
			}
			previous = name
			item, err := decode(buf, key.end, depth+1)
			if err != nil {
				return decoded{}, err
			}
			result[string(name)] = item.value
			if depth == 0 && string(name) == "info" {
				infoSpan = []int{key.end, item.end}
			}
			offset = item.end
		}
		return decoded{value: result, end: offset + 1, infoSpan: infoSpan}, nil

	case marker < '0' || marker > '9':
		return decoded{}, errors.New("bad string length")
	}

	colon := bytes.IndexByte(buf[start:], ':')
	if colon < 0 {
		return decoded{}, errors.New("unterminated string")
	}
	colon += start
	length, ok := integer(buf[start:colon], false)
	if !ok {
		return decoded{}, errors.New("bad string length")
	}
	from := colon + 1
	if length > int64(len(buf)-from) {
		return decoded{}, errors.New("string past end of data")
	}
	return decoded{value: buf[from : from+int(length)], end: from + int(length)}, nil
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
	if len(digits) == 0 || (digits[0] == '0' && len(digits) > 1) {
		return 0, false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(string(text), 10, 64)
	if err != nil || n > maxSafeInteger || n < -maxSafeInteger {
		return 0, false
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

func parse(data []byte) (Info, error) {
	root, err := decode(data, 0, 0)
	if err != nil {
		return Info{}, err
	}
	if root.end != len(data) {
		return Info{}, errors.New("trailing data")
	}
	top, ok := root.value.(dict)
	if !ok {
		return Info{}, errors.New("expected a dictionary")
	}
	info, ok := top["info"].(dict)
	if !ok || root.infoSpan == nil {
		return Info{}, errors.New("no info dictionary")
	}
	pieces, piecesIsString := info["pieces"].([]byte)
	if version, ok := info["meta version"].(int64); ok && version == 2 && !piecesIsString {
		return Info{}, errors.New("v2-only torrents are not supported by rtorrent")
	}
	name, err := component(info["name"])
	if err != nil {
		return Info{}, err
	}
	pieceLength, ok := info["piece length"].(int64)
	if !ok || pieceLength <= 0 {
		return Info{}, errors.New("invalid piece length")
	}
	if !piecesIsString || len(pieces)%20 != 0 {
		return Info{}, errors.New("invalid pieces")
	}
	length, hasLength := info["length"]
	files, hasFiles := info["files"]
	if hasLength == hasFiles {
		return Info{}, errors.New("expected either length or files")
	}
	var size int64
	if hasLength {
		if size, err = fileLength(length); err != nil {
			return Info{}, err
		}
	} else {
		list, ok := files.([]any)
		if !ok || len(list) == 0 {
			return Info{}, errors.New("invalid file list")
		}
		for _, value := range list {
			file, ok := value.(dict)
			if !ok {
				return Info{}, errors.New("invalid file entry")
			}
			n, err := fileLength(file["length"])
			if err != nil {
				return Info{}, err
			}
			size += n
			if size > maxSafeInteger {
				return Info{}, errors.New("torrent is too large")
			}
			path, ok := file["path"].([]any)
			if !ok || len(path) == 0 {
				return Info{}, errors.New("invalid file path")
			}
			for _, part := range path {
				if _, err := component(part); err != nil {
					return Info{}, err
				}
			}
		}
	}
	// In floating point, as JavaScript computed it before: for every size a
	// torrent can have this is the exact ceiling, and it stays identical.
	if float64(len(pieces))/20 != math.Ceil(float64(size)/float64(pieceLength)) {
		return Info{}, errors.New("piece count does not match torrent size")
	}
	sum := sha1.Sum(data[root.infoSpan[0]:root.infoSpan[1]])
	return Info{InfoHash: strings.ToUpper(hex.EncodeToString(sum[:])), Name: name, Size: size}, nil
}

func fileLength(value any) (int64, error) {
	n, ok := value.(int64)
	if !ok || n < 0 {
		return 0, errors.New("invalid file length")
	}
	return n, nil
}

func component(value any) (string, error) {
	raw, ok := value.([]byte)
	if !ok || len(raw) == 0 || bytes.IndexByte(raw, 0) >= 0 || bytes.IndexByte(raw, '/') >= 0 {
		return "", errors.New("invalid path component")
	}
	text := decodeUTF8(raw)
	if text == "." || text == ".." {
		return "", errors.New("invalid path component")
	}
	return text, nil
}

// decodeUTF8 decodes as the browser and Node do (the WHATWG decoder): each
// maximal ill-formed subsequence becomes one U+FFFD. Go's own conversions
// replace per byte or per run instead, and the name reaches the user.
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	var point rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if needed == 0 {
			i++
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, point = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				} else if c == 0xED {
					upper = 0x9F
				}
				needed, point = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				} else if c == 0xF4 {
					upper = 0x8F
				}
				needed, point = 3, rune(c&0x07)
			default:
				out.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// The sequence broke off: one replacement for what was read, and
			// this byte starts over.
			needed, seen, point = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out.WriteRune(utf8.RuneError)
			continue
		}
		lower, upper = 0x80, 0xBF
		point = point<<6 | rune(c&0x3F)
		seen++
		i++
		if seen == needed {
			out.WriteRune(point)
			needed, seen, point = 0, 0, 0
		}
	}
	if needed != 0 {
		out.WriteRune(utf8.RuneError)
	}
	return out.String()
}
