package stream

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
	"strconv"

	lightning "github.com/JohanLindvall/lightning/pkg/json"
)

// A patch turns one state into the next. It mirrors the state's shape and
// holds only what changed:
//
//   - an object patches an object key by key, recursively, and its "-" key
//     lists the keys that are gone;
//   - an object patches an array of the same length index by index ("0",
//     "1", …);
//   - {"=": value} replaces whatever was there with value — needed only
//     where an object takes the place of an array, which the rule above
//     would read as an index patch;
//   - anything else (an array, a scalar, null) replaces the old value.
//
// The web client applies patches with the same rules (web/src/stream.ts),
// and testdata/patches.json holds cases both sides are tested against.
const (
	deleteKey  = "-"
	replaceKey = "="
)

// keyed names the arrays sent as objects keyed by one of their fields, so an
// entry added, removed or moved patches that one entry instead of every
// index after it. The web client turns them back into arrays (KEYED in
// web/src/stream.ts).
var keyed = []struct {
	path  []string
	field string
}{
	{[]string{"torrents"}, "hash"},
	{[]string{"status", "history"}, "t"},
}

// A state is held as a tree whose branches are decoded and whose leaves stay
// the JSON they arrived as (json.RawMessage) until something has to look
// inside one. Every read of the state is hundreds of torrents of which a
// handful changed, so most leaves are only ever compared byte for byte and
// never decoded: that is what keeps a read of 500 torrents to a fraction of
// a millisecond of diffing. The branches are the root, and whatever the keyed
// paths run through; each torrent, each history sample and each value under
// status is a leaf. The scanning, validation and decoding are lightning's
// (github.com/JohanLindvall/lightning), which walks the bytes without
// building anything it is not asked for.

// decodeState parses a state. Numbers are kept as their exact text, so an
// unchanged value compares equal and is written back byte for byte.
func decodeState(data []byte) (map[string]any, error) {
	if !lightning.Valid(data) {
		// The decoder says what is wrong.
		if _, err := lightning.DecodeAnyNumber(data); err != nil {
			return nil, err
		}
		return nil, errors.New("invalid JSON")
	}
	state, ok := object(data)
	if !ok {
		return nil, errors.New("the state is not a JSON object")
	}
	for _, k := range keyed {
		parent := state
		for _, name := range k.path[:len(k.path)-1] {
			parent = branch(parent, name)
			if parent == nil {
				break
			}
		}
		if parent == nil {
			continue
		}
		last := k.path[len(k.path)-1]
		if raw, ok := parent[last].(json.RawMessage); ok {
			if byKey, ok := keyedBy(raw, k.field); ok {
				parent[last] = byKey
			}
		}
	}
	return state, nil
}

// leaf is a value's bytes as a leaf. It aliases the state it was read from,
// which is never written to again; the capacity is capped so that nothing
// appended to it could reach the bytes after it.
func leaf(raw []byte) json.RawMessage {
	return json.RawMessage(raw[:len(raw):len(raw)])
}

// object is an object's members as leaves.
func object(raw []byte) (map[string]any, bool) {
	if lightning.KindOf(raw) != lightning.KindObject {
		return nil, false
	}
	members := map[string]any{}
	err := lightning.ObjectEach(raw, func(key string, value []byte) error {
		members[key] = leaf(value)
		return nil
	})
	return members, err == nil
}

// branch turns parent[name] into a branch when it is an object, in place.
func branch(parent map[string]any, name string) map[string]any {
	switch v := parent[name].(type) {
	case map[string]any:
		return v
	case json.RawMessage:
		if members, ok := object(v); ok {
			parent[name] = members
			return members
		}
	}
	return nil
}

var errUnkeyed = errors.New("an entry without its key")

// keyedBy turns an array into an object keyed by one field of its entries,
// each entry left a leaf. An array with an entry that lacks its key, or with
// a key twice, is not keyed: it still patches correctly, only less
// compactly.
func keyedBy(raw json.RawMessage, field string) (map[string]any, bool) {
	if lightning.KindOf(raw) != lightning.KindArray {
		return nil, false
	}
	byKey := map[string]any{}
	entries := 0
	err := lightning.ArrayEach(raw, func(entry []byte) error {
		entries++
		if lightning.KindOf(entry) != lightning.KindObject {
			return errUnkeyed
		}
		// The first member of the name: the state is written by
		// encoding/json, which never repeats a key.
		value, err := lightning.Lookup(entry, field)
		if err != nil {
			return errUnkeyed
		}
		key, ok := keyString(value)
		if !ok {
			return errUnkeyed
		}
		byKey[key] = leaf(entry)
		return nil
	})
	return byKey, err == nil && len(byKey) == entries
}

// keyString is a key as the client keys it: a non-empty string, or a
// number's exact text.
func keyString(raw []byte) (string, bool) {
	switch lightning.KindOf(raw) {
	case lightning.KindString:
		key, err := lightning.String(raw)
		return key, err == nil && key != ""
	case lightning.KindNumber:
		return string(raw), true
	}
	return "", false
}

// decodeLeaf decodes a leaf, numbers kept as their text.
func decodeLeaf(raw json.RawMessage) any {
	value, err := lightning.DecodeAnyNumber(raw)
	if err != nil {
		return nil
	}
	return value
}

// diff returns the patch that turns prev into next, and whether there is
// anything to patch at all.
func diff(prev, next any) (any, bool) {
	// A leaf is compared as the bytes it arrived as, and decoded only when
	// those differ.
	if raw, ok := next.(json.RawMessage); ok {
		if old, ok := prev.(json.RawMessage); ok && bytes.Equal(old, raw) {
			return nil, false
		}
		next = decodeLeaf(raw)
	}
	if raw, ok := prev.(json.RawMessage); ok {
		prev = decodeLeaf(raw)
	}
	switch n := next.(type) {
	case map[string]any:
		p, ok := prev.(map[string]any)
		if !ok {
			if _, wasArray := prev.([]any); wasArray {
				return map[string]any{replaceKey: n}, true
			}
			return n, true
		}
		out := map[string]any{}
		for key, nv := range n {
			pv, had := p[key]
			if !had {
				out[key] = nv
				continue
			}
			if d, changed := diff(pv, nv); changed {
				out[key] = d
			}
		}
		var gone []string
		for key := range p {
			if _, still := n[key]; !still {
				gone = append(gone, key)
			}
		}
		if len(gone) > 0 {
			sort.Strings(gone)
			out[deleteKey] = gone
		}
		return out, len(out) > 0
	case []any:
		p, ok := prev.([]any)
		if !ok || len(p) != len(n) {
			return n, true
		}
		out := map[string]any{}
		for i := range n {
			if d, changed := diff(p[i], n[i]); changed {
				out[strconv.Itoa(i)] = d
			}
		}
		return out, len(out) > 0
	default:
		if scalarEqual(prev, next) {
			return nil, false
		}
		return next, true
	}
}

func scalarEqual(a, b any) bool {
	switch a := a.(type) {
	case nil:
		return b == nil
	case json.Number:
		bn, ok := b.(json.Number)
		return ok && a == bn
	case string:
		bs, ok := b.(string)
		return ok && a == bs
	case bool:
		bb, ok := b.(bool)
		return ok && a == bb
	}
	return false
}

// apply turns cur into the next state with patch, the way the web client
// does. The server itself never needs it; the tests hold diff to it.
func apply(cur, patch any) any {
	if raw, ok := cur.(json.RawMessage); ok {
		cur = decodeLeaf(raw)
	}
	p, ok := patch.(map[string]any)
	if !ok {
		return patch
	}
	if v, ok := p[replaceKey]; ok && len(p) == 1 {
		return v
	}
	switch c := cur.(type) {
	case map[string]any:
		out := make(map[string]any, len(c)+len(p))
		for key, v := range c {
			out[key] = v
		}
		for key, v := range p {
			if key == deleteKey {
				for _, name := range stringList(v) {
					delete(out, name)
				}
				continue
			}
			out[key] = apply(out[key], v)
		}
		return out
	case []any:
		out := append([]any(nil), c...)
		for key, v := range p {
			if i, err := strconv.Atoi(key); err == nil && i >= 0 && i < len(out) {
				out[i] = apply(out[i], v)
			}
		}
		return out
	}
	return p
}

// stringList reads a deletion list, which is a []string when diff made it
// and a []any once it has been through JSON.
func stringList(v any) []string {
	switch v := v.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// encodeJSON is json.Marshal without the HTML escaping: nothing here goes into
// a page, and "&" in a torrent name would otherwise cost six bytes a time.
func encodeJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
