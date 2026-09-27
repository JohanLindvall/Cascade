package service

import "sync"

// serialTasks runs the mutations of one resource in order; a failure
// releases the next waiter like a success does. Different keys proceed
// independently.
type serialTasks struct {
	mu    sync.Mutex
	tails map[string]chan struct{}
}

func (s *serialTasks) run(key string, task func() error) error {
	s.mu.Lock()
	if s.tails == nil {
		s.tails = map[string]chan struct{}{}
	}
	previous := s.tails[key]
	done := make(chan struct{})
	s.tails[key] = done
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if s.tails[key] == done {
			delete(s.tails, key)
		}
		s.mu.Unlock()
		close(done)
	}()
	if previous != nil {
		<-previous
	}
	return task()
}

// flight shares one in-progress read among everyone who asks while it runs:
// several pages polling together cost rtorrent one read, and delayed
// counters are never folded into the store out of order.
type flight[T any] struct {
	mu      sync.Mutex
	current *flightCall[T]
}

type flightCall[T any] struct {
	done  chan struct{}
	value T
	err   error
}

func (f *flight[T]) do(read func() (T, error)) (T, error) {
	f.mu.Lock()
	if c := f.current; c != nil {
		f.mu.Unlock()
		<-c.done
		return c.value, c.err
	}
	c := &flightCall[T]{done: make(chan struct{})}
	f.current = c
	f.mu.Unlock()

	c.value, c.err = read()
	f.mu.Lock()
	f.current = nil
	f.mu.Unlock()
	close(c.done)
	return c.value, c.err
}
