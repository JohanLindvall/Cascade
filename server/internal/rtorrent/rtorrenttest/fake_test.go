package rtorrenttest

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

func TestListedButUnscriptedCommandsAnswerZeroAndUnlistedOnesFault(t *testing.T) {
	fake := New(Answers{"system.listMethods": MethodList()})
	if got, err := fake.Call(context.Background(), "d.start", "A"); err != nil || got != int64(0) {
		t.Fatalf("%#v %v", got, err)
	}
	_, err := fake.Call(context.Background(), "d.nope", "A")
	var fault *xmlrpc.Fault
	if !errors.As(err, &fault) || fault.Code != -506 || fault.Message != "Method 'd.nope' not defined" {
		t.Fatalf("got %v", err)
	}
}

func TestAnswersComeBackAsTheDecoderWouldProduceThem(t *testing.T) {
	fake := New(Answers{
		"plain":    7,
		"list":     []string{"a"},
		"nested":   map[string]any{"n": []any{1, float32(0.5)}},
		"rows":     [][]any{{"AAA", uint16(3)}},
		"record":   map[string]int{"n": 1},
		"function": func(params []any) any { return len(params) },
		"failing":  func([]any) (any, error) { return nil, errors.New("disk on fire") },
		"error":    &xmlrpc.Fault{Code: -501, Message: "Could not find info-hash."},
	})
	for method, want := range map[string]any{
		"plain":    int64(7),
		"list":     []any{"a"},
		"nested":   map[string]any{"n": []any{int64(1), float64(0.5)}},
		"rows":     []any{[]any{"AAA", int64(3)}},
		"record":   map[string]any{"n": int64(1)},
		"function": int64(2),
	} {
		if got, err := fake.Call(context.Background(), method, "x", "y"); err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %#v %v", method, got, err)
		}
	}
	if _, err := fake.Call(context.Background(), "failing"); err == nil || err.Error() != "disk on fire" {
		t.Errorf("failing: %v", err)
	}
	if _, err := fake.Call(context.Background(), "error"); !rtorrent.IsFault(err) {
		t.Errorf("error: %v", err)
	}
}

func TestAMulticallIsRecordedAsItsEntriesWithEachFaultNamed(t *testing.T) {
	fake := New(Answers{
		"system.listMethods": MethodList(),
		"d.name":             "a release",
		"d.erase":            errors.New("busy"),
	})
	results, err := fake.MulticallSettled(context.Background(), []rtorrent.Call{
		{Method: "d.name", Params: []any{"A"}},
		{Method: "d.nope", Params: []any{"A"}},
		{Method: "d.erase", Params: []any{"A"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Value != "a release" {
		t.Errorf("first %#v", results[0])
	}
	var fault *xmlrpc.Fault
	if !errors.As(results[1].Err, &fault) || fault.Code != -506 || fault.Message != "d.nope: Method 'd.nope' not defined" {
		t.Errorf("second %#v", results[1].Err)
	}
	if !errors.As(results[2].Err, &fault) || fault.Code != -1 || fault.Message != "d.erase: busy" {
		t.Errorf("third %#v", results[2].Err)
	}
	if got := fake.Methods(); !reflect.DeepEqual(got, []string{"d.name", "d.nope", "d.erase"}) {
		t.Errorf("recorded %v", got)
	}
	if _, err := fake.Multicall(context.Background(), []rtorrent.Call{{Method: "d.erase", Params: []any{"A"}}}); err == nil {
		t.Error("Multicall swallowed a fault")
	}
	if calls := fake.CallsTo("d.erase"); len(calls) != 2 || calls[0].Params[0] != "A" {
		t.Errorf("d.erase calls %#v", calls)
	}
}

func TestFieldMulticallZipsRowsAndAsksForFieldsWithEquals(t *testing.T) {
	fake := New(Answers{"d.multicall2": []any{[]any{"AAA", 1}, []any{"BBB"}}, "f.multicall": "junk"})
	rows, err := fake.FieldMulticall(context.Background(), "d.multicall2", []any{"", "main"}, []string{"d.hash", "d.size_bytes"})
	if err != nil {
		t.Fatal(err)
	}
	want := []rtorrent.Row{{"d.hash": "AAA", "d.size_bytes": int64(1)}, {"d.hash": "BBB", "d.size_bytes": ""}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %#v", rows)
	}
	if params := fake.CallsTo("d.multicall2")[0].Params; !reflect.DeepEqual(params, []any{"", "main", "d.hash=", "d.size_bytes="}) {
		t.Fatalf("params %#v", params)
	}
	// Unlike the real client, the fake reads a non-list as no rows.
	if rows, err := fake.FieldMulticall(context.Background(), "f.multicall", []any{"A", ""}, []string{"f.path"}); err != nil || len(rows) != 0 {
		t.Fatalf("%#v %v", rows, err)
	}
}

func TestTheFakeIsSafeForConcurrentUse(t *testing.T) {
	fake := New(Answers{"system.listMethods": MethodList()})
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = fake.Call(context.Background(), "d.start", "A")
		}()
		go func() {
			defer wg.Done()
			fake.Answer("d.name", "x")
			_ = fake.Calls()
		}()
	}
	wg.Wait()
	if n := len(fake.CallsTo("d.start")); n != 16 {
		t.Fatalf("%d calls recorded", n)
	}
}
