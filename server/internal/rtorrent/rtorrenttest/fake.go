// Package rtorrenttest provides a scripted stand-in for rtorrent, so the
// layers above the socket can be tested without one.
package rtorrenttest

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sync"

	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// Answer is what a scripted method answers: a value, an error (a fault,
// or any other failure), or a function of the parameters — a
// func(params []any) (any, error), or a func(params []any) any.
type Answer = any

// Answers maps a method to its Answer.
type Answers = map[string]Answer

// FakeClient is an rtorrent.Client that answers from a table instead of a
// socket and records every call, so a test can assert on exactly what would
// have reached rtorrent — and, just as importantly, what would not have. It
// is safe for concurrent use.
//
// Answers are handed back the way the real decoder produces values (see
// Decoded): a Go int becomes an int64, a []string a []any — so a test can
// script with literals and the code under test still sees what rtorrent
// would send.
type FakeClient struct {
	mu      sync.Mutex
	answers Answers
	calls   []rtorrent.Call
}

var _ rtorrent.Client = (*FakeClient)(nil)

// New returns a FakeClient answering from answers (which it takes over).
func New(answers Answers) *FakeClient {
	if answers == nil {
		answers = Answers{}
	}
	return &FakeClient{answers: answers}
}

// Answer adds or replaces an answer after construction.
func (f *FakeClient) Answer(method string, answer Answer) *FakeClient {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[method] = answer
	return f
}

// Calls returns every recorded call, in order. A multicall is recorded as its
// entries, not as system.multicall.
func (f *FakeClient) Calls() []rtorrent.Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// CallsTo returns every recorded call of one method, in order.
func (f *FakeClient) CallsTo(method string) []rtorrent.Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var calls []rtorrent.Call
	for _, call := range f.calls {
		if call.Method == method {
			calls = append(calls, call)
		}
	}
	return calls
}

// Methods returns the recorded method names, in order, for asserting on a
// sequence of commands.
func (f *FakeClient) Methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	methods := make([]string, len(f.calls))
	for i, call := range f.calls {
		methods[i] = call.Method
	}
	return methods
}

// resolve answers from the table. A command that system.listMethods lists
// but that is not scripted answers 0, the way rtorrent's setters and
// lifecycle commands do, and anything unlisted faults the way rtorrent
// faults.
func (f *FakeClient) resolve(method string, params []any) (any, error) {
	f.mu.Lock()
	f.calls = append(f.calls, rtorrent.Call{Method: method, Params: slices.Clone(params)})
	answer, ok := f.answers[method]
	listed := f.answers["system.listMethods"]
	f.mu.Unlock()

	if !ok {
		if lists(listed, method) {
			return int64(0), nil
		}
		return nil, &xmlrpc.Fault{Code: -506, Message: fmt.Sprintf("Method '%s' not defined", method)}
	}
	switch a := answer.(type) {
	case func(params []any) (any, error):
		value, err := a(params)
		if err != nil {
			return nil, err
		}
		return Decoded(value), nil
	case func(params []any) any:
		return Decoded(a(params)), nil
	case error:
		return nil, a
	}
	return Decoded(answer), nil
}

func lists(listed any, method string) bool {
	switch names := listed.(type) {
	case []string:
		return slices.Contains(names, method)
	case []any:
		return slices.Contains(names, any(method))
	}
	return false
}

// Endpoint names the fake.
func (f *FakeClient) Endpoint() string { return "fake" }

// Raw answers an empty methodResponse.
func (f *FakeClient) Raw(context.Context, []byte) ([]byte, error) {
	return []byte("<methodResponse/>"), nil
}

// Call answers from the table.
func (f *FakeClient) Call(_ context.Context, method string, params ...any) (any, error) {
	return f.resolve(method, params)
}

// Multicall answers each entry, failing with the first fault.
func (f *FakeClient) Multicall(ctx context.Context, calls []rtorrent.Call) ([]any, error) {
	results, err := f.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	return rtorrent.Values(results)
}

// MulticallSettled answers each entry, naming the command in each fault the
// way the real client does.
func (f *FakeClient) MulticallSettled(_ context.Context, calls []rtorrent.Call) ([]rtorrent.Result, error) {
	results := make([]rtorrent.Result, len(calls))
	for i, call := range calls {
		value, err := f.resolve(call.Method, call.Params)
		var fault *xmlrpc.Fault
		switch {
		case errors.As(err, &fault):
			results[i] = rtorrent.Result{Err: &xmlrpc.Fault{Code: fault.Code, Message: call.Method + ": " + fault.Message}}
		case err != nil:
			results[i] = rtorrent.Result{Err: &xmlrpc.Fault{Code: -1, Message: call.Method + ": " + err.Error()}}
		default:
			results[i] = rtorrent.Result{Value: value}
		}
	}
	return results, nil
}

// FieldMulticall answers the multicall from the table and zips the rows; an
// answer that is not a list reads as no rows.
func (f *FakeClient) FieldMulticall(ctx context.Context, method string, leading []any, fields []string) ([]rtorrent.Row, error) {
	params := slices.Clone(leading)
	for _, field := range fields {
		params = append(params, field+"=")
	}
	result, err := f.Call(ctx, method, params...)
	if err != nil {
		return nil, err
	}
	rows, ok := result.([]any)
	if !ok {
		return []rtorrent.Row{}, nil
	}
	return rtorrent.ZipRows(rows, fields), nil
}

// Decoded converts a scripted value into the types the XML-RPC decoder
// produces — int64, float64, string, bool, []byte, []any and map[string]any —
// recursively, so a test can script with whatever literal is handy.
func Decoded(value any) any {
	switch value.(type) {
	case nil, string, bool, int64, float64, []byte:
		return value
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return int64(v.Uint())
	case reflect.Float32, reflect.Float64:
		return v.Float()
	case reflect.String:
		return v.String()
	case reflect.Bool:
		return v.Bool()
	case reflect.Slice, reflect.Array:
		items := make([]any, v.Len())
		for i := range items {
			items[i] = Decoded(v.Index(i).Interface())
		}
		return items
	case reflect.Map:
		if v.Type().Key().Kind() == reflect.String {
			record := make(map[string]any, v.Len())
			for entries := v.MapRange(); entries.Next(); {
				record[entries.Key().String()] = Decoded(entries.Value().Interface())
			}
			return record
		}
	}
	return value
}

// MethodList is the system.listMethods answer of a fake backend: every
// command the service tests care about, plus extra.
func MethodList(extra ...string) []any {
	names := []string{
		"system.listMethods",
		"system.client_version",
		"system.library_version",
		"system.api_version",
		"system.multicall",
		"d.multicall2",
		"d.hash",
		"d.name",
		"d.open",
		"d.start",
		"d.stop",
		"d.close",
		"d.erase",
		"d.base_path",
		"d.custom1.set",
		"d.check_hash",
		"d.message.set",
		"load.raw_start",
		"load.raw",
		"load.start",
		"load.normal",
		"throttle.up",
		"throttle.down",
		"throttle.global_down.max_rate",
		"throttle.global_down.max_rate.set",
		"throttle.global_up.max_rate",
		"throttle.global_up.max_rate.set",
		"network.listen.port",
		"directory.default",
		"protocol.pex",
		"protocol.pex.set",
		"log.add_output",
	}
	list := make([]any, 0, len(names)+len(extra))
	for _, name := range append(names, extra...) {
		list = append(list, name)
	}
	return list
}
