// SPDX-License-Identifier: MIT

// Package stream sends the state to every open page as one snapshot and then
// only what changed: the state is read once per interval however many pages
// are watching, and not at all while none is.
package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The events a subscriber receives, in the order a new one gets them: a
// snapshot (the whole state) or the deltas it missed, then a delta whenever
// the state changes. failure says the state cannot be read right now and ok
// that it can again — without it a recovery that changed nothing would never
// clear the client's error.
const (
	eventSnapshot = "snapshot"
	eventDelta    = "delta"
	eventFailure  = "failure"
	eventOK       = "ok"
)

const (
	// Deltas kept for a client that reconnects (EventSource's Last-Event-ID,
	// or ?since= after a tab was hidden): catching up costs those, not a
	// snapshot. A delta is only made when something changed, so this covers
	// anything from twenty seconds of busy torrents at the fastest interval
	// to hours of an idle list; a client further behind gets a snapshot,
	// which by then is the cheaper of the two anyway.
	keptDeltas = 200
	// What a subscriber may fall behind by before it is dropped; it
	// reconnects and catches up from what is kept.
	subscriberBuffer = 256
	// The open streams one hub serves. Each holds a goroutine, a queue and a
	// compressor for as long as it is open, and without Basic auth anyone who
	// can reach the port can open them; a household's tabs come nowhere near.
	maxSubscribers = 100
	// How long one fetch of the state may take (rtorrent's own SCGI timeout
	// is 30s).
	fetchTimeout = 35 * time.Second
	// The interval is taken from the state (status.statePollMs, the
	// CASCADE_STATE_POLL_MS option or the user's preference), within these.
	minInterval = 100 * time.Millisecond
	maxInterval = time.Minute
)

// ErrTooManySubscribers refuses a subscriber past maxSubscribers.
var ErrTooManySubscribers = errors.New("too many open streams")

// Event is one server-sent event: a snapshot or a delta (which carry an ID a
// reconnecting client can resume from), a failure or an ok.
type Event struct {
	Name string
	ID   string
	Data []byte
	rev  uint64
}

// Frame is the event as it goes on the wire.
func (e Event) Frame() []byte {
	var b strings.Builder
	if e.ID != "" {
		b.WriteString("id: ")
		b.WriteString(e.ID)
		b.WriteByte('\n')
	}
	b.WriteString("event: ")
	b.WriteString(e.Name)
	b.WriteString("\ndata: ")
	b.Write(e.Data)
	b.WriteString("\n\n")
	return []byte(b.String())
}

// Subscriber is one open stream. Events is closed when the hub drops it for
// falling behind.
type Subscriber struct {
	Events chan Event
	// Set until the subscriber has had a snapshot: until then deltas mean
	// nothing to it.
	needsSnapshot bool
}

// Hub polls the state while anyone is subscribed — once, however many are —
// and hands every subscriber the changes.
type Hub struct {
	fetch func(context.Context) ([]byte, error)
	epoch string

	mu       sync.Mutex
	interval time.Duration
	subs     map[*Subscriber]struct{}
	polling  bool
	wake     chan struct{}
	state    map[string]any // normalized; nil until the first good read
	stateAt  time.Time
	rev      uint64
	recent   []Event // the latest deltas, oldest first
	failure  string
	snapshot *Event // cached for the current rev
}

// NewHub makes a hub that reads the state with fetch — JSON, as GET
// /api/state answers — every interval until the state names an interval of
// its own (status.statePollMs).
func NewHub(fetch func(context.Context) ([]byte, error), interval time.Duration) *Hub {
	return &Hub{
		fetch:    fetch,
		epoch:    strconv.FormatInt(time.Now().UnixNano(), 36),
		interval: clampInterval(interval),
		subs:     map[*Subscriber]struct{}{},
		wake:     make(chan struct{}, 1),
	}
}

func clampInterval(d time.Duration) time.Duration {
	return min(maxInterval, max(minInterval, d))
}

func (h *Hub) id(rev uint64) string {
	return h.epoch + "-" + strconv.FormatUint(rev, 10)
}

// Subscribe adds a subscriber and queues what it needs first: the deltas
// after since when they are all still kept, else a snapshot — at once when
// the state is fresh, after the next read when it is not.
func (h *Hub) Subscribe(since string) (*Subscriber, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.subs) >= maxSubscribers {
		return nil, ErrTooManySubscribers
	}
	s := &Subscriber{Events: make(chan Event, subscriberBuffer)}
	h.subs[s] = struct{}{}
	fresh := h.state != nil && time.Since(h.stateAt) <= 2*h.interval+fetchTimeout/10
	switch replay, ok := h.replayAfter(since); {
	case ok:
		for _, ev := range replay {
			s.Events <- ev
		}
	case fresh:
		s.Events <- h.snapshotLocked()
	default:
		s.needsSnapshot = true
	}
	if h.failure != "" {
		s.Events <- h.failureEvent()
	}
	if !h.polling {
		h.polling = true
		go h.run()
	} else if !fresh {
		h.wakeLocked()
	}
	return s, nil
}

// replayAfter returns the deltas after the event since named, and whether
// the subscriber can be brought up to date with them alone.
func (h *Hub) replayAfter(since string) ([]Event, bool) {
	epoch, revText, found := strings.Cut(since, "-")
	if !found || epoch != h.epoch || h.state == nil {
		return nil, false
	}
	rev, err := strconv.ParseUint(revText, 10, 64)
	if err != nil || rev > h.rev {
		return nil, false
	}
	if rev == h.rev {
		return nil, true // already current
	}
	if len(h.recent) == 0 || h.recent[0].rev > rev+1 {
		return nil, false // some of what it missed is no longer kept
	}
	var out []Event
	for _, ev := range h.recent {
		if ev.rev > rev {
			out = append(out, ev)
		}
	}
	return out, len(out) < subscriberBuffer/2
}

// Unsubscribe removes a subscriber; polling stops with the last one.
func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, s)
}

// Wake asks for a read now rather than at the next tick — after an API
// request that may have changed something, so its effect shows at once. It
// does nothing while nobody is subscribed.
func (h *Hub) Wake() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.polling {
		h.wakeLocked()
	}
}

func (h *Hub) wakeLocked() {
	select {
	case h.wake <- struct{}{}:
	default: // a wake is already pending
	}
}

// run reads the state until nobody is subscribed. Reads never overlap, and
// a slow one delays the next rather than stacking up behind it.
func (h *Hub) run() {
	for {
		h.poll()
		h.mu.Lock()
		interval := h.interval
		h.mu.Unlock()
		timer := time.NewTimer(interval)
		select {
		case <-timer.C:
		case <-h.wake:
			timer.Stop()
		}
		h.mu.Lock()
		if len(h.subs) == 0 {
			h.polling = false
			h.mu.Unlock()
			return
		}
		h.mu.Unlock()
	}
}

func (h *Hub) poll() {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	body, err := h.fetch(ctx)
	cancel()
	if err != nil {
		h.fail(err.Error())
		return
	}
	next, err := decodeState(body)
	if err != nil {
		h.fail(fmt.Sprintf("unreadable state: %v", err))
		return
	}
	h.update(next)
}

func (h *Hub) update(next map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stateAt = time.Now()
	if ms, ok := statePollMs(next); ok {
		if d := clampInterval(time.Duration(ms) * time.Millisecond); d != h.interval {
			log.Printf("[cascade] polling the state every %s", d)
			h.interval = d
		}
	}
	if h.failure != "" {
		h.failure = ""
		h.broadcastLocked(Event{Name: eventOK, Data: []byte("{}")})
	}
	if h.state == nil {
		h.state = next
		h.rev++
	} else if patch, changed := diff(h.state, next); changed {
		data, err := encodeJSON(patch)
		if err != nil {
			log.Printf("[cascade] encoding a delta: %v", err)
			return
		}
		h.rev++
		h.state = next
		ev := Event{Name: eventDelta, ID: h.id(h.rev), Data: data, rev: h.rev}
		h.recent = append(h.recent, ev)
		if over := len(h.recent) - keptDeltas; over > 0 {
			h.recent = append([]Event(nil), h.recent[over:]...)
		}
		h.broadcastLocked(ev)
	}
	for s := range h.subs {
		if s.needsSnapshot {
			s.needsSnapshot = false
			h.sendLocked(s, h.snapshotLocked())
		}
	}
}

// statePollMs reads status.statePollMs, the interval the state itself asks
// to be read at: the user's preference, else CASCADE_STATE_POLL_MS.
func statePollMs(state map[string]any) (int64, bool) {
	status, ok := state["status"].(map[string]any)
	if !ok {
		return 0, false
	}
	raw, ok := status["statePollMs"].(json.RawMessage)
	if !ok {
		return 0, false
	}
	ms, err := strconv.ParseInt(string(raw), 10, 64)
	return ms, err == nil && ms > 0
}

func (h *Hub) fail(message string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if message == h.failure {
		return
	}
	h.failure = message
	h.broadcastLocked(h.failureEvent())
}

func (h *Hub) failureEvent() Event {
	data, _ := encodeJSON(map[string]string{"error": h.failure})
	return Event{Name: eventFailure, Data: data}
}

func (h *Hub) snapshotLocked() Event {
	if h.snapshot == nil || h.snapshot.rev != h.rev {
		data, err := encodeJSON(h.state)
		if err != nil {
			data = []byte("{}")
		}
		h.snapshot = &Event{Name: eventSnapshot, ID: h.id(h.rev), Data: data, rev: h.rev}
	}
	return *h.snapshot
}

func (h *Hub) broadcastLocked(ev Event) {
	for s := range h.subs {
		if ev.Name == eventDelta && s.needsSnapshot {
			continue
		}
		h.sendLocked(s, ev)
	}
}

// sendLocked queues an event, dropping a subscriber too far behind to take
// it: its stream ends, and it reconnects and catches up.
func (h *Hub) sendLocked(s *Subscriber, ev Event) {
	select {
	case s.Events <- ev:
	default:
		delete(h.subs, s)
		close(s.Events)
	}
}
