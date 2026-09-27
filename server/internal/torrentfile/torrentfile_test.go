package torrentfile

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The bencode gate: rtorrent's load.raw reports success for any payload, so
// this parser is the only thing standing between a junk upload and a torrent
// that silently never appears. The info hash must match what rtorrent will
// compute, which is why it is hashed from the verbatim byte span.

// ben is a minimal bencode encoder, independent of the parser under test.
func ben(value any) []byte {
	switch v := value.(type) {
	case int:
		return []byte("i" + strconv.Itoa(v) + "e")
	case float64:
		return []byte("i" + strconv.FormatFloat(v, 'f', -1, 64) + "e")
	case []byte:
		return append([]byte(strconv.Itoa(len(v))+":"), v...)
	case string:
		return ben([]byte(v))
	case []any:
		out := []byte("l")
		for _, item := range v {
			out = append(out, ben(item)...)
		}
		return append(out, 'e')
	case map[string]any:
		out := []byte("d")
		for _, key := range slices.Sorted(maps.Keys(v)) {
			out = append(out, ben(key)...)
			out = append(out, ben(v[key])...)
		}
		return append(out, 'e')
	}
	panic(fmt.Sprintf("cannot encode %T", value))
}

var pieces = bytes.Repeat([]byte{7}, 20)

func singleFileInfo() map[string]any {
	return map[string]any{"piece length": 262144, "length": 12345, "name": "a file.bin", "pieces": pieces}
}

func singleFile() []byte {
	return ben(map[string]any{"announce": "http://tracker.invalid/announce", "info": singleFileInfo()})
}

func sha1Hex(data []byte) string {
	sum := sha1.Sum(data)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func mustFail(t *testing.T, data []byte, want string) {
	t.Helper()
	_, err := Parse(data)
	if err == nil || !strings.HasPrefix(err.Error(), "not a valid .torrent file (") || !strings.Contains(err.Error(), want) {
		t.Errorf("%q: got %v, want a refusal mentioning %q", data, err, want)
	}
}

func TestASingleFileTorrentParsesWithTheRightHashNameAndSize(t *testing.T) {
	parsed, err := Parse(singleFile())
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Name != "a file.bin" || parsed.Size != 12345 || parsed.InfoHash != sha1Hex(ben(singleFileInfo())) {
		t.Fatalf("got %+v", parsed)
	}
}

func TestAMultiFileTorrentSumsItsFileLengths(t *testing.T) {
	data := ben(map[string]any{"info": map[string]any{
		"name": "release", "piece length": 262144, "pieces": pieces,
		"files": []any{
			map[string]any{"length": 100, "path": []any{"a.bin"}},
			map[string]any{"length": 250, "path": []any{"sub", "b.bin"}},
		},
	}})
	parsed, err := Parse(data)
	if err != nil || parsed.Size != 350 {
		t.Fatalf("got %+v %v", parsed, err)
	}
}

func TestJunkTruncationAndWrongShapesAreRefusedWithAReason(t *testing.T) {
	mustFail(t, []byte("not a torrent"), "")
	mustFail(t, singleFile()[:20], "")
	mustFail(t, ben([]any{1, 2, 3}), "expected a dictionary")
	mustFail(t, ben(map[string]any{"announce": "x"}), "no info dictionary")
	mustFail(t, nil, "truncated")
	mustFail(t, ben(map[string]any{"info": "not a dict"}), "no info dictionary")
}

func TestADictionaryKeyNamedProtoIsData(t *testing.T) {
	// A JavaScript parser once rewired its objects on this key; here it must
	// stay what it is: data.
	data := ben(map[string]any{
		"__proto__x": "ignored", // sorted before "info"
		"info":       map[string]any{"piece length": 1, "length": 1, "name": "x", "pieces": pieces},
	})
	patched := bytes.Replace(data, []byte("10:__proto__x7:ignored"), []byte("9:__proto__7:ignored"), 1)
	parsed, err := Parse(patched)
	if err != nil || parsed.Name != "x" {
		t.Fatalf("got %+v %v", parsed, err)
	}
}

func TestMagnetInfoHashesReadInHexAndBase32(t *testing.T) {
	const hash = "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678"
	if got := MagnetInfoHash("magnet:?xt=urn:btih:" + strings.ToLower(hash) + "&dn=x"); got != hash {
		t.Fatalf("hex: %q", got)
	}
	// The same 20 bytes, base32 encoded by hand for the fixture.
	raw, _ := hex.DecodeString(hash)
	var bits strings.Builder
	for _, b := range raw {
		fmt.Fprintf(&bits, "%08b", b)
	}
	var b32 strings.Builder
	for i := 0; i < 160; i += 5 {
		n, _ := strconv.ParseUint(bits.String()[i:i+5], 2, 8)
		b32.WriteByte(base32Alphabet[n])
	}
	if got := MagnetInfoHash("magnet:?xt=urn:btih:" + b32.String()); got != hash {
		t.Fatalf("base32: %q", got)
	}
	if got := MagnetInfoHash("magnet:?xt=urn:btih:" + strings.ToLower(b32.String())); got != hash {
		t.Fatalf("lower-case base32: %q", got)
	}
}

func TestAMagnetWithoutAUsableHashHasNone(t *testing.T) {
	for _, link := range []string{
		"magnet:?dn=nameless",
		"magnet:?xt=urn:btih:tooshort",
		"https://example.invalid/file.torrent",
		"",
		"magnet",
		"not a url",
		"1magnet:?xt=urn:btih:" + strings.Repeat("A", 40),
		"mag net:?xt=urn:btih:" + strings.Repeat("A", 40),
		"magnet:?xt=urn:btih:" + strings.Repeat("A", 39) + "G", // 40 characters, not hex
		"magnet:?xt=urn:btih:" + strings.Repeat("A", 31) + "1", // 32 characters, not base32
		"magnet:#?xt=urn:btih:" + strings.Repeat("A", 40),      // in the fragment
		"magnet:?dn=x#&xt=urn:btih:" + strings.Repeat("A", 40), // likewise
	} {
		if got := MagnetInfoHash(link); got != "" {
			t.Errorf("%q gave %q", link, got)
		}
	}
}

func TestMagnetTopicsAreURLDecodedFullyMatchedAndScopedToTheXtParameter(t *testing.T) {
	hash := strings.Repeat("A", 40)
	for link, want := range map[string]string{
		"magnet:?xt=urn%3Abtih%3A" + hash:                    hash,
		"magnet:?xt=urn:btmh:123&xt=urn:btih:" + hash:        hash,
		"magnet:?dn=xt=urn:btih:" + hash:                     "",
		"magnet:?xt=urn:btih:" + hash + "!":                  "",
		"https://example.org/?xt=urn:btih:" + hash:           "",
		"MAGNET:?XT=URN:BTIH:" + strings.ToLower(hash):       hash,
		"  magnet:?xt=urn:btih:" + hash + "\n":               hash, // trimmed as a URL parser trims
		"magnet:?xt=urn:bt\tih:" + hash:                      hash, // tabs and newlines dropped anywhere
		"magnet:?x%74=urn:btih:" + hash:                      hash, // the name is decoded too
		"magnet:?xt=urn:btih:" + hash[:20] + "+" + hash[20:]: "",   // + is a space
		"magnet:?xt=urn:btih:" + hash + "%":                  "",   // a stray % stays
		"magnet:?&&xt=urn:btih:" + hash + "&&":               hash,
		"magnet://host/?xt=urn:btih:" + hash:                 hash,
	} {
		if got := MagnetInfoHash(link); got != want {
			t.Errorf("%q: got %q, want %q", link, got, want)
		}
	}
}

func TestMalformedBencodeAndIncompleteMetadataAreRejectedBeforeLoad(t *testing.T) {
	info := map[string]any{"name": "file", "length": 1, "piece length": 1, "pieces": pieces}
	with := func(key string, value any) []byte {
		patched := map[string]any{}
		for k, v := range info {
			patched[k] = v
		}
		patched[key] = value
		return ben(map[string]any{"info": patched})
	}
	for _, data := range [][]byte{
		with("name", ""), with("length", -1), with("length", 1.5), with("piece length", 0),
		with("pieces", make([]byte, 19)), with("pieces", make([]byte, 40)), with("files", []any{}),
	} {
		mustFail(t, data, "")
	}
	for key := range info {
		partial := map[string]any{}
		for k, v := range info {
			if k != key {
				partial[k] = v
			}
		}
		mustFail(t, ben(map[string]any{"info": partial}), "")
	}
	mustFail(t, append(singleFile(), "junk"...), "trailing data")
	for _, integer := range []string{"ie", "i01e", "i-0e", "i1.5e", "i1e3e"} {
		mustFail(t, []byte("d4:info"+integer+"e"), "")
	}
	mustFail(t, []byte("d4:infode4:infodee"), "duplicate")
	mustFail(t, []byte(strings.Repeat("l", 200)+strings.Repeat("e", 200)), "nesting too deep")
}

func TestMetadataKeysCannotImpersonateTheInfoByteSpan(t *testing.T) {
	data := ben(map[string]any{
		"__span_info": "ordinary data",
		"info":        map[string]any{"name": "x", "length": 1, "piece length": 1, "pieces": pieces},
	})
	parsed, err := Parse(data)
	if err != nil || parsed.Name != "x" {
		t.Fatalf("got %+v %v", parsed, err)
	}
}

func TestEachRefusalNamesItsReason(t *testing.T) {
	info := `4:name1:x12:piece lengthi1e6:pieces20:` + string(pieces)
	for data, want := range map[string]string{
		"i9007199254740992e":                 "bad integer", // past the safe range
		"i9007199254740991e":                 "expected a dictionary",
		"i-9007199254740991e":                "expected a dictionary",
		"i1":                                 "unterminated integer",
		"x":                                  "bad string length",
		"5":                                  "unterminated string",
		"05:hello":                           "bad string length",
		"9007199254740992:x":                 "bad string length",
		"5:abc":                              "string past end of data",
		"di1e1:xe":                           "non-string dictionary key",
		"d1:b1:x1:a1:xe":                     "duplicate or unsorted dictionary key",
		"d4:infod" + info + "6:lengthi1eee":  "duplicate or unsorted dictionary key", // length sorts before name
		"d4:infod6:lengthi-1e" + info + "ee": "invalid file length",
	} {
		_, err := Parse([]byte(data))
		if err == nil || err.Error() != "not a valid .torrent file ("+want+")" {
			t.Errorf("%q: got %v, want %q", data, err, want)
		}
	}
}

func TestTheInfoChecksInOrder(t *testing.T) {
	base := map[string]any{"name": "x", "length": 3, "piece length": 2, "pieces": bytes.Repeat([]byte{1}, 40)}
	with := func(changes map[string]any, drop ...string) []byte {
		info := map[string]any{}
		for k, v := range base {
			info[k] = v
		}
		for k, v := range changes {
			info[k] = v
		}
		for _, k := range drop {
			delete(info, k)
		}
		return ben(map[string]any{"info": info})
	}
	if _, err := Parse(with(nil)); err != nil {
		t.Fatalf("3 bytes in pieces of 2 is 2 pieces: %v", err)
	}
	for _, c := range []struct {
		data []byte
		want string
	}{
		{with(map[string]any{"meta version": 2}, "pieces"), "v2-only torrents are not supported by rtorrent"},
		{with(map[string]any{"name": "."}), "invalid path component"},
		{with(map[string]any{"name": ".."}), "invalid path component"},
		{with(map[string]any{"name": "a/b"}), "invalid path component"},
		{with(map[string]any{"name": "a\x00b"}), "invalid path component"},
		{with(map[string]any{"name": 5}), "invalid path component"},
		{with(map[string]any{"piece length": "2"}), "invalid piece length"},
		{with(map[string]any{"piece length": -2}), "invalid piece length"},
		{with(nil, "pieces"), "invalid pieces"},
		{with(map[string]any{"pieces": 20}), "invalid pieces"},
		{with(nil, "length"), "expected either length or files"},
		{with(map[string]any{"length": "3"}), "invalid file length"},
		{with(map[string]any{"length": 5}), "piece count does not match torrent size"},
		{with(map[string]any{"files": "x"}, "length"), "invalid file list"},
		{with(map[string]any{"files": []any{"x"}}, "length"), "invalid file entry"},
		{with(map[string]any{"files": []any{map[string]any{"path": []any{"a"}}}}, "length"), "invalid file length"},
		{with(map[string]any{"files": []any{map[string]any{"length": 3}}}, "length"), "invalid file path"},
		{with(map[string]any{"files": []any{map[string]any{"length": 3, "path": []any{}}}}, "length"), "invalid file path"},
		{with(map[string]any{"files": []any{map[string]any{"length": 3, "path": []any{"a", ".."}}}}, "length"), "invalid path component"},
		{with(map[string]any{"files": []any{
			map[string]any{"length": 9007199254740991, "path": []any{"a"}},
			map[string]any{"length": 1, "path": []any{"b"}},
		}}, "length"), "torrent is too large"},
	} {
		_, err := Parse(c.data)
		if err == nil || err.Error() != "not a valid .torrent file ("+c.want+")" {
			t.Errorf("%q: got %v, want %q", c.data, err, c.want)
		}
	}
	// A hybrid torrent keeps its v1 pieces and loads.
	if _, err := Parse(with(map[string]any{"meta version": 2})); err != nil {
		t.Errorf("a hybrid torrent was refused: %v", err)
	}
	// An empty torrent has no pieces at all.
	if _, err := Parse(with(map[string]any{"length": 0, "pieces": []byte{}})); err != nil {
		t.Errorf("an empty torrent was refused: %v", err)
	}
}

func TestTheNameIsDecodedAsTheBrowserDecodesIt(t *testing.T) {
	for raw, want := range map[string]string{
		"plain":            "plain",
		"caf\xc3\xa9":      "caf\u00e9",
		"a\xe2\x82b":       "a\ufffdb",           // one replacement for a broken-off sequence
		"a\xffb":           "a\ufffdb",           // an impossible byte
		"\xf0\x9f\x98":     "\ufffd",             // truncated at the end
		"\xed\xa0\x80":     "\ufffd\ufffd\ufffd", // a surrogate is three errors
		"\xc0\xaf":         "\ufffd\ufffd",       // an overlong form is two
		"\xf4\x90\x80\x80": "\ufffd\ufffd\ufffd\ufffd",
	} {
		if got := decodeUTF8([]byte(raw)); got != want {
			t.Errorf("%q: got %q, want %q", raw, got, want)
		}
	}
	data := ben(map[string]any{"info": map[string]any{"name": "x\xe2\x82y", "length": 1, "piece length": 1, "pieces": pieces}})
	if parsed, err := Parse(data); err != nil || parsed.Name != "x\ufffdy" {
		t.Fatalf("got %+v %v", parsed, err)
	}
}
