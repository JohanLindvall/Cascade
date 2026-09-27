package rtorrent

// The client sits between every service call and the socket: it queues
// requests behind a concurrency cap (rtorrent is single-threaded), names the
// failing command in a multicall fault, and zips the flat multicall rows into
// rows. All of it is exercised here through a scripted transport.

import (
	"context"
	"errors"
	"math"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/scgi"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

var target = scgi.Target{Kind: scgi.Unix, Path: "/nowhere/rpc.socket"}

// respond serializes a value the way rtorrent would answer it, SCGI headers
// and all.
func respond(t *testing.T, value any) []byte {
	t.Helper()
	body, err := xmlrpc.EncodeResponse(value)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte("Status: 200 OK\r\nContent-Type: text/xml\r\n\r\n"), body...)
}

var methodName = regexp.MustCompile(`<methodName>([^<]+)</methodName>`)

// methodOf reads the method name out of a serialized call, so a transport
// can script by it.
func methodOf(body []byte) string {
	if match := methodName.FindSubmatch(body); match != nil {
		return string(match[1])
	}
	return ""
}

func answering(t *testing.T, value any) Transport {
	reply := respond(t, value)
	return func(context.Context, []byte) ([]byte, error) { return reply, nil }
}

func TestCallRoundTripsThroughTheTransport(t *testing.T) {
	var seen []string
	client := NewClient(target, func(_ context.Context, body []byte) ([]byte, error) {
		seen = append(seen, methodOf(body))
		return respond(t, "0.16.20"), nil
	})
	got, err := client.Call(context.Background(), "system.client_version")
	if err != nil || got != "0.16.20" {
		t.Fatalf("%#v %v", got, err)
	}
	if !reflect.DeepEqual(seen, []string{"system.client_version"}) {
		t.Fatalf("seen %v", seen)
	}
	if client.Endpoint() != "unix:/nowhere/rpc.socket" {
		t.Fatalf("endpoint %q", client.Endpoint())
	}
}

func TestNeverMoreThanMaxConcurrencyRequestsInFlight(t *testing.T) {
	var inFlight, peak atomic.Int32
	reply := respond(t, 1)
	client := NewClient(target, func(context.Context, []byte) ([]byte, error) {
		now := inFlight.Add(1)
		for {
			old := peak.Load()
			if now <= old || peak.CompareAndSwap(old, now) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		inFlight.Add(-1)
		return reply, nil
	})
	var wg sync.WaitGroup
	for range MaxConcurrency * 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := client.Call(context.Background(), "d.hash"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if peak.Load() != MaxConcurrency || inFlight.Load() != 0 {
		t.Fatalf("peak %d, in flight %d", peak.Load(), inFlight.Load())
	}
}

func TestAQueuedCallGivesUpWithItsContext(t *testing.T) {
	release := make(chan struct{})
	reply := respond(t, 1)
	client := NewClient(target, func(context.Context, []byte) ([]byte, error) {
		<-release
		return reply, nil
	})
	var wg sync.WaitGroup
	for range MaxConcurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = client.Call(context.Background(), "d.hash")
		}()
	}
	time.Sleep(20 * time.Millisecond) // every slot taken
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := client.Call(ctx, "d.name"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	close(release)
	wg.Wait()
}

func TestAFaultInsideAMulticallNamesTheCommandThatFaulted(t *testing.T) {
	client := NewClient(target, answering(t, []any{
		[]any{"ok"},
		map[string]any{"faultCode": -503, "faultString": "Wrong object type."},
	}))
	calls := []Call{
		{Method: "d.name", Params: []any{"A"}},
		{Method: "throttle.global_up.max_rate.set", Params: []any{1}},
	}
	settled, err := client.MulticallSettled(context.Background(), calls)
	if err != nil {
		t.Fatal(err)
	}
	if settled[0].Value != "ok" || settled[0].Err != nil {
		t.Fatalf("first %#v", settled[0])
	}
	var fault *xmlrpc.Fault
	if !errors.As(settled[1].Err, &fault) || fault.Code != -503 ||
		!strings.HasPrefix(fault.Message, "throttle.global_up.max_rate.set: Wrong object type") {
		t.Fatalf("second %#v", settled[1].Err)
	}

	// Multicall surfaces the same fault as its error.
	if _, err := client.Multicall(context.Background(), calls); !errors.As(err, &fault) || fault.Code != -503 {
		t.Fatalf("got %v", err)
	}
}

func TestAMulticallSendsEachEntryWithItsParams(t *testing.T) {
	var sent []byte
	client := NewClient(target, func(_ context.Context, body []byte) ([]byte, error) {
		sent = body
		return respond(t, []any{[]any{int64(0)}, []any{int64(0)}}), nil
	})
	if _, err := client.Multicall(context.Background(), []Call{
		{Method: "d.start", Params: []any{"A"}},
		{Method: "session.save"},
	}); err != nil {
		t.Fatal(err)
	}
	want := "<methodName>system.multicall</methodName><params><param><value><array><data>" +
		"<value><struct><member><name>methodName</name><value><string>d.start</string></value></member>" +
		"<member><name>params</name><value><array><data><value><string>A</string></value></data></array></value></member></struct></value>" +
		"<value><struct><member><name>methodName</name><value><string>session.save</string></value></member>" +
		"<member><name>params</name><value><array><data></data></array></value></member></struct></value>"
	if !strings.Contains(string(sent), want) {
		t.Fatalf("sent %s", sent)
	}
}

func TestAnEmptyMulticallNeverTouchesTheTransport(t *testing.T) {
	calls := 0
	client := NewClient(target, func(context.Context, []byte) ([]byte, error) {
		calls++
		return respond(t, []any{}), nil
	})
	results, err := client.MulticallSettled(context.Background(), nil)
	if err != nil || results == nil || len(results) != 0 || calls != 0 {
		t.Fatalf("%#v %v, %d calls", results, err, calls)
	}
}

func TestFieldMulticallAsksForEachFieldAndZipsTheRowsBack(t *testing.T) {
	var sent []byte
	client := NewClient(target, func(_ context.Context, body []byte) ([]byte, error) {
		sent = body
		return respond(t, []any{
			[]any{"AAA", "first", 100},
			[]any{"BBB", "second"}, // a short row: the missing field reads as ""
		}), nil
	})
	rows, err := client.FieldMulticall(context.Background(), "d.multicall2", []any{"", "main"},
		[]string{"d.hash", "d.name", "d.size_bytes"})
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?s)d\.hash=.*d\.name=.*d\.size_bytes=`).Match(sent) {
		t.Fatalf("sent %s", sent)
	}
	want := []Row{
		{"d.hash": "AAA", "d.name": "first", "d.size_bytes": int64(100)},
		{"d.hash": "BBB", "d.name": "second", "d.size_bytes": ""},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %#v", rows)
	}
}

func TestSettledNumberReadsFaultsAndJunkAsZero(t *testing.T) {
	for _, c := range []struct {
		result Result
		want   float64
	}{
		{Result{Value: int64(42)}, 42},
		{Result{Value: "17"}, 17},
		{Result{Err: &xmlrpc.Fault{Code: -1, Message: "x"}}, 0},
		{Result{Value: "junk"}, 0},
		{Result{}, 0},
		{Result{Value: "Infinity"}, 0},
	} {
		if got := c.result.Number(); got != c.want {
			t.Errorf("%#v: %v", c.result, got)
		}
	}
}

func TestMalformedMulticallsCannotMasqueradeAsEmptyOrSuccess(t *testing.T) {
	client := NewClient(target, answering(t, "not a list"))
	if _, err := client.FieldMulticall(context.Background(), "d.multicall2", []any{"", "main"}, []string{"d.hash"}); err == nil ||
		!strings.Contains(err.Error(), "non-array") {
		t.Fatalf("got %v", err)
	}
	short := NewClient(target, answering(t, []any{}))
	if _, err := short.Multicall(context.Background(), []Call{{Method: "d.start", Params: []any{"A"}}}); err == nil ||
		!strings.Contains(err.Error(), "number of results") {
		t.Fatalf("got %v", err)
	}
}

func TestNumberAndText(t *testing.T) {
	for _, c := range []struct {
		in   any
		want float64
	}{
		{int64(7), 7}, {"12", 12}, {true, 1}, {[]byte("3"), 3}, {"junk", 0}, {nil, 0},
		{math.NaN(), 0}, {math.Inf(1), 0}, {"-Infinity", 0}, {math.Copysign(0, -1), 0},
	} {
		if got := Number(c.in); got != c.want || math.Signbit(got) != math.Signbit(c.want) {
			t.Errorf("Number(%#v) = %v", c.in, got)
		}
	}
	for _, c := range []struct {
		in   any
		want string
	}{
		{nil, ""}, {"x", "x"}, {[]byte("/dl"), "/dl"}, {int64(5), "5"}, {1.5, "1.5"}, {false, "false"},
	} {
		if got := Text(c.in); got != c.want {
			t.Errorf("Text(%#v) = %q", c.in, got)
		}
	}
}

func TestIsFaultTellsRefusalsFromOutages(t *testing.T) {
	if !IsFault(&xmlrpc.Fault{Code: -506}) || IsFault(errors.New("socket gone")) || IsFault(nil) {
		t.Fatal("IsFault is wrong")
	}
}
