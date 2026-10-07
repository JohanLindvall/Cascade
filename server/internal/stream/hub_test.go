// SPDX-License-Identifier: MIT

package stream

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// scripted is a state source a test sets the next answer of.
type scripted struct {
	mu    sync.Mutex
	body  string
	err   error
	reads int
}

func (s *scripted) set(body string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.body, s.err = body, err
}

func (s *scripted) fetch(context.Context) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	return []byte(s.body), s.err
}

func (s *scripted) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reads
}

func next(t *testing.T, sub *Subscriber) Event {
	t.Helper()
	select {
	case ev, ok := <-sub.Events:
		if !ok {
			t.Fatal("the subscriber was dropped")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("no event")
	}
	return Event{}
}

func quiet(t *testing.T, sub *Subscriber) {
	t.Helper()
	select {
	case ev := <-sub.Events:
		t.Fatalf("unexpected %s event: %s", ev.Name, ev.Data)
	case <-time.After(150 * time.Millisecond):
	}
}

func subscribe(t *testing.T, hub *Hub, since string) *Subscriber {
	t.Helper()
	sub, err := hub.Subscribe(since)
	if err != nil {
		t.Fatal(err)
	}
	return sub
}

// A long interval, so every read in these tests is one they asked for.
func newTestHub(src *scripted) *Hub { return NewHub(src.fetch, time.Minute) }

func TestSnapshotThenOnlyTheChanges(t *testing.T) {
	src := &scripted{body: `{"torrents":[{"hash":"AA","upRate":0}],"status":{"upRate":0}}`}
	hub := newTestHub(src)
	sub := subscribe(t, hub, "")
	defer hub.Unsubscribe(sub)

	snap := next(t, sub)
	if snap.Name != eventSnapshot || !strings.HasSuffix(snap.ID, "-1") {
		t.Fatalf("first event %s %s", snap.Name, snap.ID)
	}
	if string(snap.Data) != `{"status":{"upRate":0},"torrents":{"AA":{"hash":"AA","upRate":0}}}` {
		t.Fatalf("snapshot %s", snap.Data)
	}

	src.set(`{"torrents":[{"hash":"AA","upRate":512}],"status":{"upRate":512}}`, nil)
	hub.Wake()
	delta := next(t, sub)
	if delta.Name != eventDelta || !strings.HasSuffix(delta.ID, "-2") {
		t.Fatalf("second event %s %s", delta.Name, delta.ID)
	}
	if string(delta.Data) != `{"status":{"upRate":512},"torrents":{"AA":{"upRate":512}}}` {
		t.Fatalf("delta %s", delta.Data)
	}

	// The same state again is no event at all.
	hub.Wake()
	quiet(t, sub)
}

func TestReconnectCatchesUpFromWhatIsKept(t *testing.T) {
	src := &scripted{body: `{"n":1}`}
	hub := newTestHub(src)
	first := subscribe(t, hub, "")
	snap := next(t, first)
	for _, body := range []string{`{"n":2}`, `{"n":3}`} {
		src.set(body, nil)
		hub.Wake()
		next(t, first)
	}

	// Back from the first snapshot: the two deltas since, no snapshot.
	again := subscribe(t, hub, snap.ID)
	defer hub.Unsubscribe(again)
	for _, want := range []string{`{"n":2}`, `{"n":3}`} {
		ev := next(t, again)
		if ev.Name != eventDelta || string(ev.Data) != want {
			t.Fatalf("replayed %s %s, want delta %s", ev.Name, ev.Data, want)
		}
	}
	quiet(t, again)

	// Already current: nothing to send.
	current := subscribe(t, hub, hub.id(3))
	defer hub.Unsubscribe(current)
	quiet(t, current)

	// From another server's lifetime, or too far back: a snapshot.
	for _, since := range []string{"otherepoch-2", "junk", hub.id(99)} {
		sub := subscribe(t, hub, since)
		if ev := next(t, sub); ev.Name != eventSnapshot || string(ev.Data) != `{"n":3}` {
			t.Fatalf("since %q: %s %s", since, ev.Name, ev.Data)
		}
		hub.Unsubscribe(sub)
	}
	hub.Unsubscribe(first)
}

func TestFailureIsSaidOnceAndRecoveryClearsIt(t *testing.T) {
	src := &scripted{body: `{"n":1}`}
	hub := newTestHub(src)
	sub := subscribe(t, hub, "")
	defer hub.Unsubscribe(sub)
	next(t, sub)

	src.set("", errors.New("rtorrent is not responding"))
	hub.Wake()
	ev := next(t, sub)
	var problem struct{ Error string }
	if ev.Name != eventFailure || json.Unmarshal(ev.Data, &problem) != nil || problem.Error != "rtorrent is not responding" {
		t.Fatalf("got %s %s", ev.Name, ev.Data)
	}
	hub.Wake()
	quiet(t, sub) // the same failure is not repeated

	// A subscriber arriving now hears about it at once.
	late := subscribe(t, hub, "")
	defer hub.Unsubscribe(late)
	if ev := next(t, late); ev.Name != eventSnapshot {
		t.Fatalf("late subscriber first got %s", ev.Name)
	}
	if ev := next(t, late); ev.Name != eventFailure {
		t.Fatalf("late subscriber then got %s", ev.Name)
	}

	// Back, and unchanged: ok with no delta.
	src.set(`{"n":1}`, nil)
	hub.Wake()
	if ev := next(t, sub); ev.Name != eventOK {
		t.Fatalf("recovery sent %s", ev.Name)
	}
	quiet(t, sub)
}

func TestTheStateSetsTheInterval(t *testing.T) {
	src := &scripted{body: `{"status":{"statePollMs":2000}}`}
	hub := NewHub(src.fetch, 500*time.Millisecond)
	sub := subscribe(t, hub, "")
	defer hub.Unsubscribe(sub)
	next(t, sub)
	hub.mu.Lock()
	got := hub.interval
	hub.mu.Unlock()
	if got != 2*time.Second {
		t.Fatalf("interval %s after the state asked for 2000ms", got)
	}
	// Out of range values are held to the bounds.
	src.set(`{"status":{"statePollMs":1}}`, nil)
	hub.Wake()
	time.Sleep(100 * time.Millisecond)
	hub.mu.Lock()
	got = hub.interval
	hub.mu.Unlock()
	if got != minInterval {
		t.Fatalf("interval %s, want the %s floor", got, minInterval)
	}
}

func TestPollingStopsWithTheLastSubscriber(t *testing.T) {
	src := &scripted{body: `{"n":1}`}
	hub := NewHub(src.fetch, minInterval)
	sub := subscribe(t, hub, "")
	next(t, sub)
	hub.Unsubscribe(sub)
	time.Sleep(3 * minInterval)
	reads := src.count()
	time.Sleep(3 * minInterval)
	if src.count() != reads {
		t.Fatalf("still reading with nobody subscribed: %d -> %d", reads, src.count())
	}
	hub.mu.Lock()
	polling := hub.polling
	hub.mu.Unlock()
	if polling {
		t.Fatal("still marked as polling")
	}
	// A new subscriber starts it again, from a snapshot.
	again := subscribe(t, hub, "")
	defer hub.Unsubscribe(again)
	if ev := next(t, again); ev.Name != eventSnapshot {
		t.Fatalf("got %s", ev.Name)
	}
}

func TestASubscriberThatFallsBehindIsDropped(t *testing.T) {
	src := &scripted{body: `{"n":0}`}
	hub := newTestHub(src)
	slow := subscribe(t, hub, "")
	next(t, slow)
	hub.mu.Lock()
	for i := 0; i <= subscriberBuffer; i++ {
		hub.broadcastLocked(Event{Name: eventDelta, Data: []byte("{}")})
	}
	_, still := hub.subs[slow]
	hub.mu.Unlock()
	if still {
		t.Fatal("a subscriber with a full buffer is still subscribed")
	}
	for range slow.Events { // drains, then ends: the channel is closed
	}
}

func TestTheOpenStreamsAreBounded(t *testing.T) {
	hub := newTestHub(&scripted{body: `{"n":0}`})
	subs := make([]*Subscriber, maxSubscribers)
	for i := range subs {
		subs[i] = subscribe(t, hub, "")
	}
	if _, err := hub.Subscribe(""); !errors.Is(err, ErrTooManySubscribers) {
		t.Fatalf("subscriber %d: %v", maxSubscribers+1, err)
	}
	hub.Unsubscribe(subs[0])
	defer func() {
		for _, sub := range subs {
			hub.Unsubscribe(sub)
		}
	}()
	subs[0] = subscribe(t, hub, "") // a closed stream makes room again
}

func TestAnEventIsFramedForServerSentEvents(t *testing.T) {
	for _, c := range []struct {
		ev   Event
		want string
	}{
		{Event{Name: eventDelta, ID: "e-2", Data: []byte(`{"n":2}`)}, "id: e-2\nevent: delta\ndata: {\"n\":2}\n\n"},
		{Event{Name: eventOK, Data: []byte("{}")}, "event: ok\ndata: {}\n\n"},
	} {
		if got := string(c.ev.Frame()); got != c.want {
			t.Errorf("%q, want %q", got, c.want)
		}
	}
}
