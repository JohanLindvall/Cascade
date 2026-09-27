package httpapi

import (
	"errors"
	"net/http"
	"time"
)

// Idle proxies drop a connection that says nothing for a minute or two; a
// comment line now and then keeps the stream open through them.
const heartbeatEvery = 20 * time.Second

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
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, errors.New("streaming is not supported here"))
		return
	}
	// EventSource's own reconnect names the newest event it had, which beats
	// the ?since= of the URL it was first opened with.
	since := r.Header.Get("Last-Event-ID")
	if since == "" {
		since = r.URL.Query().Get("since")
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // nginx in front would otherwise hold it back
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	send := func(frame []byte) error {
		if _, err := w.Write(frame); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}

	sub := s.hub.Subscribe(since)
	defer s.hub.Unsubscribe(sub)
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
