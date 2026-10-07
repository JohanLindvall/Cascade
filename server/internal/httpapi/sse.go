// SPDX-License-Identifier: MIT

package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/stream"
)

const (
	// Idle proxies drop a connection that says nothing for a minute or two; a
	// comment line now and then keeps the stream open through them.
	heartbeatEvery = 20 * time.Second
	// How long one event may take to leave. A client that stopped reading
	// is dropped by the hub once its queue fills, but a write blocked on a
	// full socket would never see that; the deadline ends it.
	eventWriteTimeout = 30 * time.Second
)

// serveStream is GET /api/stream: server-sent events carrying a snapshot of
// the state and then only what changed (see internal/stream). A client that
// reconnects names the last event it had — a page back from a hidden tab
// passes ?since=, and EventSource sends Last-Event-ID by itself — and is
// caught up with the deltas it missed when they are still kept.
//
// The events go through the response's compression like everything else,
// one stream flushed after every event, so a delta of a few changed rates
// costs a few dozen bytes on the wire.
func (s *Server) serveStream(w http.ResponseWriter, r *http.Request) {
	// A read like any other to the cross-site rule, yet it keeps rtorrent
	// busy for as long as it is open: another site's page must not be able
	// to hold one open in a visitor's browser. Its answer would be unreadable
	// to that page anyway.
	facts := factsOf(r)
	facts.method = http.MethodPost
	if isCrossSiteRequest(facts) {
		writeJSON(w, r, http.StatusForbidden, map[string]string{"error": "cross-site request refused"})
		return
	}
	// EventSource's own reconnect names the newest event it had, which beats
	// the ?since= of the URL it was first opened with.
	since := r.Header.Get("Last-Event-ID")
	if since == "" {
		since = r.URL.Query().Get("since")
	}
	var sub *stream.Subscriber
	if r.Method != http.MethodHead {
		var err error
		if sub, err = s.hub.Subscribe(since); errors.Is(err, stream.ErrTooManySubscribers) {
			w.Header().Set("Retry-After", "10")
			writeError(w, r, httperr.New(http.StatusServiceUnavailable, err.Error()))
			return
		}
		defer s.hub.Unsubscribe(sub)
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // nginx in front would otherwise hold it back
	w.WriteHeader(http.StatusOK)
	if sub == nil {
		return // HEAD
	}

	control := http.NewResponseController(w)
	send := func(frame []byte) error {
		// Not every writer can set one (a test recorder cannot); the event
		// goes out regardless.
		_ = control.SetWriteDeadline(time.Now().Add(eventWriteTimeout))
		if _, err := w.Write(frame); err != nil {
			return err
		}
		return control.Flush()
	}
	if send([]byte("retry: 3000\n\n")) != nil {
		return
	}
	heartbeat := time.NewTicker(heartbeatEvery)
	defer heartbeat.Stop()
	for {
		select {
		case ev, open := <-sub.Events:
			if !open {
				return // dropped for falling behind; the client reconnects
			}
			if send(ev.Frame()) != nil {
				return
			}
		case <-heartbeat.C:
			if send([]byte(":\n\n")) != nil {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}
