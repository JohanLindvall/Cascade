package service

import (
	"errors"
	"sync"
)

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
	c, leader := f.join()
	if !leader {
		<-c.done
		return c.value, c.err
	}
	return f.lead(c, read)
}

// doIfIdle runs read unless one is in flight already. It is for a caller
// that needs the work done rather than the answer — the read in flight does
// the same work — and that must be able to give up: waiting on a read that
// someone else started is a wait it could not abandon.
func (f *flight[T]) doIfIdle(read func() (T, error)) error {
	c, leader := f.join()
	if !leader {
		return nil
	}
	_, err := f.lead(c, read)
	return err
}

// join returns the read in flight, or a new one the caller has to lead.
func (f *flight[T]) join() (*flightCall[T], bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.current != nil {
		return f.current, false
	}
	// The error stands unless the read returns: a read that panics must not
	// leave the next caller waiting forever, nor the waiters a zero answer.
	f.current = &flightCall[T]{done: make(chan struct{}), err: errReadFailed}
	return f.current, true
}

func (f *flight[T]) lead(c *flightCall[T], read func() (T, error)) (T, error) {
	defer func() {
		f.mu.Lock()
		f.current = nil
		f.mu.Unlock()
		close(c.done)
	}()
	c.value, c.err = read()
	return c.value, c.err
}

var errReadFailed = errors.New("the shared read failed")
