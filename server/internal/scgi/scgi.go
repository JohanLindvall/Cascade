// SPDX-License-Identifier: MIT

// Package scgi is the transport to rtorrent's XML-RPC endpoint.
//
// rtorrent listens either on a unix socket (network.scgi.open_local) or a TCP
// port (network.scgi.open_port). Both speak SCGI: a netstring of NUL-separated
// header pairs followed by the body, answered with an HTTP-ish response.
package scgi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
)

// The kinds of Target.
const (
	Unix = "unix"
	TCP  = "tcp"
)

// Target is where rtorrent listens: a unix socket (Kind Unix, Path) or a TCP
// port (Kind TCP, Host and Port).
type Target struct {
	Kind string
	Path string
	Host string
	Port int
}

var (
	hostPort = regexp.MustCompile(`^(?:scgi://)?(\[[^\]]+\]|[^:]+):(\d+)$`)
	digits   = regexp.MustCompile(`^\d+$`)
)

// ParseTarget accepts every way an endpoint is written in the wild:
// unix:/path, /path, ./path, host:port, scgi://host:port, [v6]:port, a bare
// port (on 127.0.0.1), and anything else as a socket path.
func ParseTarget(raw string) (Target, error) {
	// Trimmed as the TypeScript server trimmed it: JavaScript's whitespace.
	value := strings.TrimFunc(raw, jsnum.IsSpace)
	if value == "" || value == "unix:" {
		return Target{}, errors.New("SCGI endpoint must not be empty")
	}
	port := func(text string) (int, error) {
		number, err := strconv.Atoi(text)
		if err != nil || number < 1 || number > 65535 {
			return 0, errors.New("SCGI port must be from 1 to 65535")
		}
		return number, nil
	}
	if path, ok := strings.CutPrefix(value, "unix:"); ok {
		return Target{Kind: Unix, Path: path}, nil
	}
	if strings.HasPrefix(value, "/") || strings.HasPrefix(value, "./") {
		return Target{Kind: Unix, Path: value}, nil
	}
	if match := hostPort.FindStringSubmatch(value); match != nil {
		host := match[1]
		if strings.HasPrefix(host, "[") {
			host = host[1 : len(host)-1]
		}
		number, err := port(match[2])
		if err != nil {
			return Target{}, err
		}
		return Target{Kind: TCP, Host: host, Port: number}, nil
	}
	if digits.MatchString(value) {
		number, err := port(value)
		if err != nil {
			return Target{}, err
		}
		return Target{Kind: TCP, Host: "127.0.0.1", Port: number}, nil
	}
	return Target{Kind: Unix, Path: value}, nil
}

// String describes the target for log lines and error messages.
func (t Target) String() string {
	if t.Kind == Unix {
		return "unix:" + t.Path
	}
	return t.address()
}

func (t Target) network() string {
	if t.Kind == Unix {
		return "unix"
	}
	return "tcp"
}

func (t Target) address() string {
	if t.Kind == Unix {
		return t.Path
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
}

func buildHeaders(bodyLength int) []byte {
	// CONTENT_LENGTH must come first: the SCGI spec says so, and rtorrent's
	// reader relies on it.
	pairs := []string{
		"CONTENT_LENGTH", strconv.Itoa(bodyLength),
		"SCGI", "1",
		"REQUEST_METHOD", "POST",
		"REQUEST_URI", "/RPC2",
		"CONTENT_TYPE", "text/xml",
	}
	headers := strings.Join(pairs, "\x00") + "\x00"
	return []byte(strconv.Itoa(len(headers)) + ":" + headers + ",")
}

// stripHTTPHeaders drops the CGI-style header block rtorrent puts before the
// XML. A reply that starts with the XML has none, and is not searched for a
// blank line — its body may well contain one.
func stripHTTPHeaders(response []byte) []byte {
	if bytes.HasPrefix(bytes.TrimLeft(response, " \t\r\n"), []byte("<")) {
		return response
	}
	for _, separator := range []string{"\r\n\r\n", "\n\n"} {
		if index := bytes.Index(response, []byte(separator)); index >= 0 {
			return response[index+len(separator):]
		}
	}
	return response
}

const (
	// An inactivity timeout alone lets a trickling endpoint occupy a queue
	// slot forever, so this bounds the entire exchange, connection included.
	requestTimeout   = 30 * time.Second
	maxResponseBytes = 64 << 20
)

// Request sends one XML-RPC body and returns the response body, with the
// SCGI response headers stripped. Failures are 502s that say what is wrong
// in terms of rtorrent; a cancelled ctx returns ctx.Err().
func Request(ctx context.Context, target Target, body []byte) ([]byte, error) {
	return request(ctx, target, body, requestTimeout, maxResponseBytes)
}

func request(ctx context.Context, target Target, body []byte, timeout time.Duration, maxBytes int) ([]byte, error) {
	deadline := time.Now().Add(timeout)
	fail := func(err error) ([]byte, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !time.Now().Before(deadline) || isTimeout(err) {
			return nil, httperr.Backend(fmt.Sprintf("SCGI request to %s timed out after %dms", target, timeout.Milliseconds()))
		}
		return nil, httperr.Backend(describeError(target, err))
	}

	dialCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(dialCtx, target.network(), target.address())
	if err != nil {
		return fail(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)
	// A cancelled request stops waiting at once rather than at the deadline.
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()

	if _, err := conn.Write(append(buildHeaders(len(body)), body...)); err != nil {
		return fail(err)
	}
	raw, err := io.ReadAll(io.LimitReader(conn, int64(maxBytes)+1))
	if len(raw) > maxBytes {
		return nil, httperr.Backend(fmt.Sprintf("SCGI response exceeds %d bytes", maxBytes))
	}
	if err != nil {
		return fail(err)
	}
	if len(raw) == 0 {
		// A closed connection with no bytes is rtorrent dropping the request —
		// typically mid-startup or under load. An empty body would otherwise
		// surface as a confusing XML parse error.
		return nil, httperr.Backend(fmt.Sprintf("rtorrent closed the SCGI connection on %s without responding", target))
	}
	return stripHTTPHeaders(raw), nil
}

func isTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func describeError(target Target, err error) string {
	switch {
	case errors.Is(err, syscall.ENOENT):
		return fmt.Sprintf("rtorrent is not running — no SCGI socket at %s", target)
	case errors.Is(err, syscall.ECONNREFUSED):
		// The socket file outlives the process, so this is the usual symptom
		// of rtorrent having died or failed to start.
		return fmt.Sprintf("rtorrent is not accepting connections on %s — "+
			"it has stopped or failed to start; check the container log", target)
	case errors.Is(err, syscall.EACCES):
		return fmt.Sprintf("permission denied opening %s — check PUID/PGID", target)
	}
	return fmt.Sprintf("SCGI error talking to %s: %v", target, err)
}
