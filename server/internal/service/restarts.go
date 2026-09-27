package service

import (
	"sync"
	"time"
)

// pendingRestarts are the torrents to start again once their hash check
// finishes.
//
// "Recheck & restart" exists for rtorrent's own dead end: "Download
// registered as completed, but hash check returned unfinished chunks" stops
// the torrent, and a plain recheck leaves it stopped when the check ends —
// so fixing it by hand is two actions timed around a progress bar. The check
// itself can run for however long the disk takes, far past any HTTP request,
// so the action only *registers* the wish here and the poll tick feeds
// readings in until one of them says start.
//
// The decision is pure so it can be tested: feed it d.hashing readings and
// it answers wait, start or drop. A reading above zero proves the check is
// running (rtorrent marks even a queued check); the first zero after that
// means it finished. A check so fast every poll missed it entirely is
// covered by the zero-reading floor — after a few polls of nothing, the only
// explanation left is that it already ran.
type pendingRestarts struct {
	mu      sync.Mutex
	entries map[string]*pendingRestart
	order   []string
}

type pendingRestart struct {
	sawHashing bool
	zeroReads  int
	since      time.Time
}

type restartStep int

const (
	restartWait restartStep = iota
	restartStart
	restartDrop
)

const (
	// How long a pending restart may wait: a full rehash of a huge torrent on
	// a slow disk is hours, so the ceiling is generous.
	restartMaxAge = 24 * time.Hour
	// Zero readings that mean "the check came and went between polls".
	restartZeroReadsFloor = 3
)

func (p *pendingRestarts) add(hash string, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.entries == nil {
		p.entries = map[string]*pendingRestart{}
	}
	if _, known := p.entries[hash]; !known {
		p.order = append(p.order, hash)
	}
	p.entries[hash] = &pendingRestart{since: now}
}

func (p *pendingRestarts) cancel(hash string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deleteLocked(hash)
}

func (p *pendingRestarts) deleteLocked(hash string) {
	if _, known := p.entries[hash]; !known {
		return
	}
	delete(p.entries, hash)
	for i, h := range p.order {
		if h == hash {
			p.order = append(p.order[:i:i], p.order[i+1:]...)
			break
		}
	}
}

func (p *pendingRestarts) has(hash string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, known := p.entries[hash]
	return known
}

func (p *pendingRestarts) size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.entries)
}

// hashes are the pending torrents in the order they were registered.
func (p *pendingRestarts) hashes() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.order...)
}

// step folds one d.hashing reading in. A nil reading means the torrent could
// not be asked (erased, or the call faulted): nothing left to restart.
func (p *pendingRestarts) step(hash string, hashing *float64, now time.Time) restartStep {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, known := p.entries[hash]
	if !known {
		return restartDrop
	}
	if hashing == nil || now.Sub(entry.since) > restartMaxAge {
		p.deleteLocked(hash)
		return restartDrop
	}
	if *hashing > 0 {
		entry.sawHashing = true
		entry.zeroReads = 0
		return restartWait
	}
	entry.zeroReads++
	if entry.sawHashing || entry.zeroReads >= restartZeroReadsFloor {
		p.deleteLocked(hash)
		return restartStart
	}
	return restartWait
}
