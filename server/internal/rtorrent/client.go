// SPDX-License-Identifier: MIT

// Package rtorrent knows rtorrent's command set: the RPC client every call
// goes through, the capability probe that picks command names from what the
// running build implements, the table of global settings, and the field model
// that turns multicall rows into what the UI shows.
package rtorrent

import (
	"context"
	"errors"
	"math"
	"net/http"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/scgi"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// Call is one command and its parameters, as a system.multicall entry.
type Call struct {
	Method string
	Params []any
}

// Transport is one request/response exchange with rtorrent; the SCGI socket
// unless a test supplies another.
type Transport func(ctx context.Context, body []byte) ([]byte, error)

// Row is one multicall row, keyed by the field command that produced each
// value.
type Row map[string]any

// Result is one slot of a settled multicall: a value, or the fault rtorrent
// answered that command with, named after the command.
type Result struct {
	Value any
	Err   error
}

// Number reads the slot as a number: a fault, junk and anything non-finite
// read as zero, which is what every gauge in the UI wants from a probe that
// failed.
func (r Result) Number() float64 {
	if r.Err != nil {
		return 0
	}
	return Number(r.Value)
}

// Client is what the layers above need from a client — kept narrow so a test
// can hand the service or the capability probe a scripted stand-in instead of
// a socket.
type Client interface {
	// Endpoint describes where rtorrent is, for the UI and log lines.
	Endpoint() string
	// Raw sends a raw XML-RPC body and returns the raw response (the /RPC2
	// passthrough).
	Raw(ctx context.Context, body []byte) ([]byte, error)
	// Call runs one command; a fault comes back as a *xmlrpc.Fault error.
	Call(ctx context.Context, method string, params ...any) (any, error)
	// Multicall batches commands into one round trip; the first fault fails
	// the whole batch.
	Multicall(ctx context.Context, calls []Call) ([]any, error)
	// MulticallSettled is Multicall with each fault reported in its own slot.
	MulticallSettled(ctx context.Context, calls []Call) ([]Result, error)
	// FieldMulticall runs a *.multicall command (d./f./p./t.) and zips the
	// flat result rows into rows keyed by the field names.
	FieldMulticall(ctx context.Context, method string, leading []any, fields []string) ([]Row, error)
}

// MaxConcurrency caps the requests in flight. rtorrent processes commands on
// its single main thread, so hammering it with parallel multicalls stalls the
// torrent engine itself.
const MaxConcurrency = 4

type client struct {
	target    scgi.Target
	transport Transport
	// A slot per request in flight. Blocked senders on a channel are queued
	// in arrival order, so waiters are served first come, first served.
	slots chan struct{}
}

// NewClient returns a client for the endpoint at target. A nil transport
// means the SCGI socket there.
func NewClient(target scgi.Target, transport Transport) Client {
	if transport == nil {
		transport = func(ctx context.Context, body []byte) ([]byte, error) {
			return scgi.Request(ctx, target, body)
		}
	}
	return &client{target: target, transport: transport, slots: make(chan struct{}, MaxConcurrency)}
}

func (c *client) Endpoint() string { return c.target.String() }

func (c *client) Raw(ctx context.Context, body []byte) ([]byte, error) {
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.slots }()
	return c.transport(ctx, body)
}

func (c *client) Call(ctx context.Context, method string, params ...any) (any, error) {
	body, err := xmlrpc.EncodeCall(method, params)
	if err != nil {
		// The service validates what it sends, so a value XML-RPC cannot
		// carry came from the raw RPC console: the request's to fix, not a
		// server failure.
		return nil, httperr.New(http.StatusBadRequest, err.Error())
	}
	response, err := c.Raw(ctx, body)
	if err != nil {
		return nil, err
	}
	return xmlrpc.DecodeResponse(response)
}

func (c *client) Multicall(ctx context.Context, calls []Call) ([]any, error) {
	results, err := c.MulticallSettled(ctx, calls)
	if err != nil {
		return nil, err
	}
	return Values(results)
}

// Values unwraps settled results, failing with the first fault among them.
func Values(results []Result) ([]any, error) {
	values := make([]any, len(results))
	for i, result := range results {
		if result.Err != nil {
			return nil, result.Err
		}
		values[i] = result.Value
	}
	return values, nil
}

func (c *client) MulticallSettled(ctx context.Context, calls []Call) ([]Result, error) {
	if len(calls) == 0 {
		return []Result{}, nil
	}
	payload := make([]any, len(calls))
	for i, call := range calls {
		params := call.Params
		if params == nil {
			params = []any{}
		}
		// rtorrent built on its own XML-RPC parser (tinyxml2, not xmlrpc-c)
		// reads an entry by position rather than by name: the first member is
		// the method, the next one its params, and one out of that order fails
		// the whole request — from 0.16.25 as "multicall struct's first member
		// must be methodName". A map has no order of its own; the encoder
		// writes a struct's members sorted by name, and "methodName" sorts
		// before "params", which client_test pins.
		payload[i] = map[string]any{"methodName": call.Method, "params": params}
	}
	result, err := c.Call(ctx, "system.multicall", payload)
	if err != nil {
		return nil, err
	}
	items, ok := result.([]any)
	if !ok {
		return nil, httperr.Backend("system.multicall returned a non-array")
	}
	if len(items) != len(calls) {
		return nil, httperr.Backend("system.multicall returned the wrong number of results")
	}
	return settleItems(calls, items), nil
}

// NamedFault is the fault one entry of a multicall answered with, named after
// its command: "-503 Wrong object type" on its own does not say which of a
// dozen batched calls went wrong.
func NamedFault(method string, fault *xmlrpc.Fault) *xmlrpc.Fault {
	return &xmlrpc.Fault{Code: fault.Code, Message: method + ": " + fault.Message}
}

// settleItems turns system.multicall's answer, one item per call, into
// results: each item is a one-element array holding the value, or a fault
// struct.
func settleItems(calls []Call, items []any) []Result {
	results := make([]Result, len(items))
	for i, item := range items {
		if xmlrpc.IsFaultStruct(item) {
			results[i] = Result{Err: NamedFault(calls[i].Method, xmlrpc.FaultFrom(item))}
			continue
		}
		if list, ok := item.([]any); ok && len(list) > 0 {
			results[i] = Result{Value: list[0]}
		} else {
			results[i] = Result{Value: ""}
		}
	}
	return results
}

func (c *client) FieldMulticall(ctx context.Context, method string, leading []any, fields []string) ([]Row, error) {
	result, err := c.Call(ctx, method, fieldParams(leading, fields)...)
	if err != nil {
		return nil, err
	}
	list, ok := result.([]any)
	if !ok {
		return nil, httperr.Backend(method + " returned a non-array")
	}
	return ZipRows(list, fields), nil
}

// fieldParams asks for each field as "<command>=", the form *.multicall
// wants, after the parameters that select what to list.
func fieldParams(leading []any, fields []string) []any {
	params := make([]any, 0, len(leading)+len(fields))
	params = append(params, leading...)
	for _, field := range fields {
		params = append(params, field+"=")
	}
	return params
}

// ZipRows pairs each multicall row with the field names asked for; a short
// row's missing fields read as "".
func ZipRows(list []any, fields []string) []Row {
	rows := make([]Row, len(list))
	for i, item := range list {
		values, ok := item.([]any)
		if !ok {
			values = []any{item}
		}
		row := make(Row, len(fields))
		for j, field := range fields {
			if j < len(values) && values[j] != nil {
				row[field] = values[j]
			} else {
				row[field] = ""
			}
		}
		rows[i] = row
	}
	return rows
}

// Number reads a decoded value as a number the forgiving way the UI's gauges
// want it: a numeric string or bytes are parsed, a boolean is 1 or 0, and
// anything that is not a finite number — junk, NaN, an infinity — reads as 0.
// So does -0, which would otherwise reach the JSON as "-0".
func Number(value any) float64 {
	if v, ok := value.(int64); ok { // what rtorrent sends for almost every field
		return float64(v)
	}
	n := xmlrpc.ToNumber(value)
	if math.IsNaN(n) || math.IsInf(n, 0) || n == 0 {
		return 0
	}
	return n
}

// Text reads a decoded value as text: bytes as UTF-8, numbers in their
// shortest form, and nil as "".
func Text(value any) string {
	return xmlrpc.ToString(value)
}

// IsFault reports whether err is rtorrent refusing a command, as opposed to
// rtorrent not being reachable at all.
func IsFault(err error) bool {
	var fault *xmlrpc.Fault
	return errors.As(err, &fault)
}
