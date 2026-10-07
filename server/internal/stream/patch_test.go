// SPDX-License-Identifier: MIT

package stream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
)

// canonical renders a value for comparison: encoding/json sorts object keys,
// and numbers are kept as their text.
func canonical(t *testing.T, v any) string {
	t.Helper()
	b, err := encodeJSON(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func decodeValue(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The cases the web client's tests apply too (web/src/stream.test.ts): what
// diff writes here is what stream.ts reads.
func TestGoldenPatches(t *testing.T) {
	raw, err := os.ReadFile("testdata/patches.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string          `json:"name"`
		Prev  json.RawMessage `json:"prev"`
		Next  json.RawMessage `json:"next"`
		Patch json.RawMessage `json:"patch"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			prev, next := decodeValue(t, c.Prev), decodeValue(t, c.Next)
			patch, changed := diff(prev, next)
			want := decodeValue(t, c.Patch)
			if want == nil {
				if changed {
					t.Fatalf("diff found a change: %s", canonical(t, patch))
				}
				return
			}
			if !changed {
				t.Fatal("diff found nothing to patch")
			}
			if got, exp := canonical(t, patch), canonical(t, want); got != exp {
				t.Fatalf("patch\n got %s\nwant %s", got, exp)
			}
			// Through the wire and back, as the client gets it.
			if got, exp := canonical(t, apply(prev, want)), canonical(t, next); got != exp {
				t.Fatalf("apply\n got %s\nwant %s", got, exp)
			}
		})
	}
}

// materialize decodes every leaf of a state, for looking inside it.
func materialize(v any) any {
	switch v := v.(type) {
	case json.RawMessage:
		return decodeLeaf(v)
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = materialize(item)
		}
		return out
	}
	return v
}

func TestDecodingKeysTheListedArrays(t *testing.T) {
	decoded, err := decodeState([]byte(`{
		"torrents": [{"hash": "AA", "name": "a"}, {"hash": "BB", "name": "b"}],
		"status": {"history": [{"t": 100, "up": 1}, {"t": 101, "up": 2}]},
		"throttles": [{"name": "slow"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	state := materialize(decoded).(map[string]any)
	torrents, ok := state["torrents"].(map[string]any)
	if !ok || len(torrents) != 2 || torrents["BB"].(map[string]any)["name"] != "b" {
		t.Fatalf("torrents not keyed by hash: %#v", state["torrents"])
	}
	history, ok := state["status"].(map[string]any)["history"].(map[string]any)
	if !ok || history["101"].(map[string]any)["up"] != json.Number("2") {
		t.Fatalf("history not keyed by t: %#v", state["status"])
	}
	if _, still := state["throttles"].([]any); !still {
		t.Fatal("an array nobody listed was keyed")
	}
}

func TestDecodingLeavesAnArrayItCannotKey(t *testing.T) {
	for _, input := range []string{
		`{"torrents": [{"hash": "AA"}, {"name": "no hash"}]}`,
		`{"torrents": [{"hash": "AA"}, {"hash": "AA"}]}`, // a repeated key would lose an entry
		`{"torrents": [{"hash": ""}]}`,
		`{"torrents": [{"hash": true}]}`,
		`{"torrents": ["not an object"]}`,
	} {
		state, err := decodeState([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		if _, still := materialize(state).(map[string]any)["torrents"].([]any); !still {
			t.Errorf("%s: keyed anyway: %#v", input, state["torrents"])
		}
	}
	for _, input := range []string{`{"torrents": [`, `[1, 2]`, `"text"`, ``} {
		if _, err := decodeState([]byte(input)); err == nil {
			t.Errorf("%q decoded", input)
		}
	}
}

// eager is the plain way to read a state — decode all of it, then key the
// listed arrays — which the leaves must be indistinguishable from.
func eager(t *testing.T, data []byte) map[string]any {
	t.Helper()
	state := decodeLeaf(data).(map[string]any)
	for _, k := range keyed {
		parent, ok := state, true
		for _, name := range k.path[:len(k.path)-1] {
			if parent, ok = parent[name].(map[string]any); !ok {
				break
			}
		}
		last := k.path[len(k.path)-1]
		list, isList := parent[last].([]any)
		if !ok || !isList {
			continue
		}
		byKey := map[string]any{}
		for _, item := range list {
			entry, _ := item.(map[string]any)
			var key string
			switch v := entry[k.field].(type) {
			case string:
				key = v
			case json.Number:
				key = string(v)
			}
			if key == "" {
				byKey = nil
				break
			}
			byKey[key] = entry
		}
		if byKey != nil && len(byKey) == len(list) {
			parent[last] = byKey
		}
	}
	return state
}

// Edits of a state shaped like the real one: the patch diff writes from the
// leaves must be the one it writes from the fully decoded states.
func TestLeavesPatchLikeDecodedStates(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	state := func() []byte {
		var torrents []string
		for i := range 3 + rng.Intn(4) {
			torrents = append(torrents, fmt.Sprintf(`{"hash":"H%d","upRate":%d,"name":"t \"%d\"","eta":%s,"files":[%d,%d]}`,
				rng.Intn(8), rng.Intn(3), i, []string{"null", "5", "1.5"}[rng.Intn(3)], rng.Intn(2), rng.Intn(2)))
		}
		var history []string
		for i := range rng.Intn(4) {
			history = append(history, fmt.Sprintf(`{"t":%d,"down":%d}`, 100+i+rng.Intn(2), rng.Intn(3)))
		}
		return []byte(fmt.Sprintf(`{"status":{"connected":%v,"statePollMs":500,"history":[%s]},"torrents":[%s],"game":{"xp":%d}}`,
			rng.Intn(2) == 0, strings.Join(history, ","), strings.Join(torrents, ","), rng.Intn(3)))
	}
	for range 3000 {
		prev, next := state(), state()
		lazyPrev, err := decodeState(prev)
		if err != nil {
			t.Fatalf("%s: %v", prev, err)
		}
		lazyNext, err := decodeState(next)
		if err != nil {
			t.Fatalf("%s: %v", next, err)
		}
		// A leaf is written as it arrived, members in their own order, so
		// the two are compared as JSON rather than as bytes.
		sameJSON := func(a, b any) bool {
			return canonical(t, decodeLeaf(json.RawMessage(canonical(t, a)))) == canonical(t, b)
		}
		lazy, lazyChanged := diff(lazyPrev, lazyNext)
		full, fullChanged := diff(eager(t, prev), eager(t, next))
		if lazyChanged != fullChanged || (lazyChanged && !sameJSON(lazy, full)) {
			t.Fatalf("prev %s\nnext %s\nleaves  %s\ndecoded %s", prev, next, canonical(t, lazy), canonical(t, full))
		}
		if !sameJSON(lazyNext, eager(t, next)) {
			t.Fatalf("snapshot\n got %s\nwant %s", canonical(t, lazyNext), canonical(t, eager(t, next)))
		}
	}
}

// Random edits of a state shaped like the real one: whatever diff writes,
// apply must land exactly on the next state.
func TestDiffApplyRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	number := func() any { return json.Number(fmt.Sprint(rng.Intn(5))) }
	var value func(depth int) any
	value = func(depth int) any {
		switch n := rng.Intn(7); {
		case depth > 2 || n < 3:
			return []any{nil, true, "s", number(), json.Number("1.5")}[rng.Intn(5)]
		case n < 5:
			m := map[string]any{}
			for i := rng.Intn(4); i > 0; i-- {
				m[fmt.Sprint("k", rng.Intn(5))] = value(depth + 1)
			}
			return m
		default:
			a := make([]any, rng.Intn(4))
			for i := range a {
				a[i] = value(depth + 1)
			}
			return a
		}
	}
	for i := 0; i < 5000; i++ {
		prev, next := value(0), value(0)
		if rng.Intn(3) == 0 {
			next = prev // unchanged states happen most of all
		}
		patch, changed := diff(prev, next)
		if !changed {
			if !reflect.DeepEqual(prev, next) {
				t.Fatalf("no patch for a change:\nprev %s\nnext %s", canonical(t, prev), canonical(t, next))
			}
			continue
		}
		wire := decodeValue(t, json.RawMessage(canonical(t, patch)))
		if got, want := canonical(t, apply(prev, wire)), canonical(t, next); got != want {
			t.Fatalf("round trip\nprev  %s\nnext  %s\npatch %s\ngot   %s",
				canonical(t, prev), want, canonical(t, patch), got)
		}
	}
}

func TestEncodeJSONLeavesAmpersandsAlone(t *testing.T) {
	b, err := encodeJSON(map[string]any{"name": "Rock & Roll <live>"})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"name":"Rock & Roll <live>"}` {
		t.Fatalf("got %s", b)
	}
}

func BenchmarkDiffListing(b *testing.B) {
	// A state of 500 torrents shaped like the real one, three of them moving.
	state := func(moving int) []byte {
		var torrents []string
		for i := range 500 {
			rate := 0
			if i < 3 {
				rate = moving
			}
			torrents = append(torrents, fmt.Sprintf(`{"hash":"%040X","name":"torrent %d","status":"seeding","progress":1,`+
				`"size":%d,"completed":%d,"left":0,"downRate":0,"upRate":%d,"downTotal":%d,"upTotal":%d,"ratio":1.25,`+
				`"eta":0,"priority":2,"label":"","message":"","directory":"/downloads/t%d","basePath":"/downloads/t%d",`+
				`"throttle":"","isOpen":true,"isActive":true,"isPrivate":false,"isMultiFile":false,"hashing":0,`+
				`"chunkSize":262144,"chunksDone":40,"chunksTotal":40,"peersConnected":0,"peersNotConnected":0,`+
				`"peersComplete":0,"trackerCount":1,"addedAt":1790000000,"startedAt":1790000000,"finishedAt":1790000000,`+
				`"createdAt":1780000000}`, i, i, i<<20, i<<20, rate, i<<20, i<<21, i, i))
		}
		return []byte(`{"status":{"connected":true,"upRate":` + fmt.Sprint(moving) + `,"statePollMs":500,"history":[]},` +
			`"torrents":[` + strings.Join(torrents, ",") + `],"throttles":[],"game":{"xp":0}}`)
	}
	prev, err := decodeState(state(0))
	if err != nil {
		b.Fatal(err)
	}
	next := state(1024)
	b.SetBytes(int64(len(next)))
	for b.Loop() {
		current, err := decodeState(next)
		if err != nil {
			b.Fatal(err)
		}
		patch, _ := diff(prev, current)
		if _, err := encodeJSON(patch); err != nil {
			b.Fatal(err)
		}
	}
}
