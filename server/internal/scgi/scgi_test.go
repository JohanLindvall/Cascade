package scgi

// ParseTarget accepts every way an endpoint is written in the wild, and
// Request frames a request the way rtorrent's SCGI reader expects.

import (
	"bytes"
	"context"
	"errors"
	"net"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

func TestUnixSocketForms(t *testing.T) {
	for raw, want := range map[string]Target{
		"unix:/run/rt/rpc.socket": {Kind: Unix, Path: "/run/rt/rpc.socket"},
		"/run/rt/rpc.socket":      {Kind: Unix, Path: "/run/rt/rpc.socket"},
		"./rpc.socket":            {Kind: Unix, Path: "./rpc.socket"},
		"  rpc.socket ":           {Kind: Unix, Path: "rpc.socket"},
	} {
		if got, err := ParseTarget(raw); err != nil || got != want {
			t.Errorf("ParseTarget(%q) = %#v, %v", raw, got, err)
		}
	}
}

func TestTCPForms(t *testing.T) {
	for raw, want := range map[string]Target{
		"rt.internal:5000":         {Kind: TCP, Host: "rt.internal", Port: 5000},
		"scgi://rt.internal:5000":  {Kind: TCP, Host: "rt.internal", Port: 5000},
		"[::1]:5000":               {Kind: TCP, Host: "::1", Port: 5000},
		"5000":                     {Kind: TCP, Host: "127.0.0.1", Port: 5000},
		"scgi://127.0.0.1:0005000": {Kind: TCP, Host: "127.0.0.1", Port: 5000},
	} {
		if got, err := ParseTarget(raw); err != nil || got != want {
			t.Errorf("ParseTarget(%q) = %#v, %v", raw, got, err)
		}
	}
}

func TestDescribeRoundTripsIntoLogLines(t *testing.T) {
	for raw, want := range map[string]string{"unix:/a/b": "unix:/a/b", "h:1": "h:1", "[::1]:5000": "[::1]:5000"} {
		target, err := ParseTarget(raw)
		if err != nil || target.String() != want {
			t.Errorf("%q described as %q (%v)", raw, target.String(), err)
		}
	}
	for _, raw := range []string{"unix:", "", "  ", "host:0", "65536", "h:99999999999999999999"} {
		if _, err := ParseTarget(raw); err == nil {
			t.Errorf("%q was accepted", raw)
		}
	}
}

/* ------------------------------ the wire ------------------------------- */

// fakeSCGI is a one-shot SCGI server on a unix socket: it records the request
// it was sent and answers with reply once all of it is in, so the framing on
// both sides is checked against something that reads it like rtorrent does.
func fakeSCGI(t *testing.T, reply []byte) (Target, <-chan []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rpc.socket")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	received := make(chan []byte, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var raw []byte
		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			raw = append(raw, buf[:n]...)
			// Netstring header, then CONTENT_LENGTH bytes of body: answer once
			// all of it is in.
			if colon := bytes.IndexByte(raw, ':'); colon >= 0 {
				headerLength, _ := strconv.Atoi(string(raw[:colon]))
				if len(raw) >= colon+1+headerLength {
					headers := strings.Split(string(raw[colon+1:colon+1+headerLength]), "\x00")
					bodyLength, _ := strconv.Atoi(headers[1])
					if len(raw) >= colon+1+headerLength+1+bodyLength {
						received <- raw
						_, _ = conn.Write(reply)
						return
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return Target{Kind: Unix, Path: path}, received
}

func requireBackendError(t *testing.T, err error, pattern string) {
	t.Helper()
	var httpErr *httperr.Error
	if !errors.As(err, &httpErr) || httpErr.Status != 502 {
		t.Fatalf("want a 502, got %#v", err)
	}
	if !regexp.MustCompile(pattern).MatchString(err.Error()) {
		t.Fatalf("%q does not match %q", err, pattern)
	}
}

func TestARequestIsFramedAsANetstringAndTheRepliesHeadersStripped(t *testing.T) {
	body := []byte("<methodCall><methodName>system.pid</methodName></methodCall>")
	target, received := fakeSCGI(t, []byte("Status: 200 OK\r\nContent-Type: text/xml\r\n\r\n<methodResponse/>"))
	reply, err := Request(context.Background(), target, body)
	if err != nil {
		t.Fatal(err)
	}
	if string(reply) != "<methodResponse/>" {
		t.Fatalf("reply %q", reply)
	}
	sent := string(<-received)
	// CONTENT_LENGTH must lead, per the SCGI spec, and the body must follow the comma.
	if !regexp.MustCompile("^\\d+:CONTENT_LENGTH\x00\\d+\x00SCGI\x001\x00").MatchString(sent) {
		t.Fatalf("sent %q", sent)
	}
	if !strings.HasSuffix(sent, ","+string(body)) {
		t.Fatalf("sent %q", sent)
	}
}

func TestBareNewlinesSeparateHeadersToo(t *testing.T) {
	target, _ := fakeSCGI(t, []byte("Status: 200 OK\n\n<methodResponse/>"))
	if reply, err := Request(context.Background(), target, []byte("x")); err != nil || string(reply) != "<methodResponse/>" {
		t.Fatalf("%q %v", reply, err)
	}
}

func TestAnEmptyReplyIsRtorrentDroppingTheRequest(t *testing.T) {
	target, _ := fakeSCGI(t, nil)
	_, err := Request(context.Background(), target, []byte("x"))
	requireBackendError(t, err, `closed the SCGI connection .* without responding`)
}

func TestResponsesCannotGrowPastTheMemoryBound(t *testing.T) {
	target, _ := fakeSCGI(t, make([]byte, 101))
	_, err := request(context.Background(), target, []byte("x"), time.Minute, 100)
	requireBackendError(t, err, `response exceeds 100 bytes`)
}

func TestATricklingEndpointStillReachesTheTotalDeadline(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, err := conn.Write([]byte("x")); err != nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	_, err = request(context.Background(), Target{Kind: TCP, Host: "127.0.0.1", Port: port}, []byte("x"), 100*time.Millisecond, 1<<20)
	requireBackendError(t, err, `timed out after 100ms`)
}

func TestAMissingSocketSaysRtorrentIsNotRunningWithThePath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-socket")
	_, err := Request(context.Background(), Target{Kind: Unix, Path: missing}, []byte("x"))
	requireBackendError(t, err, `rtorrent is not running`)
	if !strings.Contains(err.Error(), missing) {
		t.Fatalf("%q does not name %s", err, missing)
	}
}

func TestASocketWithNobodyBehindItSaysSo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rpc.socket")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	// The socket file outlives the process that made it, as it does when
	// rtorrent dies.
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	listener.Close()
	_, err = Request(context.Background(), Target{Kind: Unix, Path: path}, []byte("x"))
	requireBackendError(t, err, `rtorrent is not accepting connections on unix:.* — it has stopped or failed to start`)
}

func TestACancelledRequestStopsWaitingAtOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rpc.socket")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			time.Sleep(5 * time.Second) // never answers in time
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	started := time.Now()
	_, err = Request(ctx, Target{Kind: Unix, Path: path}, []byte("x"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %s to notice the cancellation", elapsed)
	}
}
