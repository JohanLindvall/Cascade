// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
)

func TestARemovalCannotMakeAnEarlierListingCreditTrafficTwice(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		client := backend("d.up.total", "d.down.total").Answer("d.multicall2", func(p []any) any {
			close(entered)
			<-release
			row := make([]any, len(p)-2)
			for i, field := range p[2:] {
				switch strings.TrimSuffix(field.(string), "=") {
				case "d.hash":
					row[i] = hash
				case "d.name":
					row[i] = "example"
				case "d.up.total":
					row[i] = 1200
				case "d.down.total":
					row[i] = 800
				}
			}
			return []any{row}
		})
		s := newService(t, client, nil)
		s.store.AddedAt(hash, 1)
		s.store.RecordTorrents([]contracts.Torrent{{Hash: hash, UpTotal: 1200, DownTotal: 800}})
		read, removed := make(chan error, 1), make(chan error, 1)
		go func() { _, err := s.Torrents(ctx, "main"); read <- err }()
		<-entered
		go func() { removed <- s.Remove(ctx, hash, false) }()
		synctest.Wait() // Let the removal run while the older listing is delayed.
		close(release)
		if err := <-read; err != nil {
			t.Fatal(err)
		}
		if err := <-removed; err != nil {
			t.Fatal(err)
		}
		stats := s.store.Stats()
		if stats.EverAdded != 1 || stats.LifetimeUp != 1200 || stats.LifetimeDown != 800 {
			t.Fatalf("the removed torrent was credited again: %+v", stats)
		}
		if added := s.store.AddedAt(hash, 2); added != 2 {
			t.Fatalf("the old listing restored the removed torrent's add time: %d", added)
		}
		if err := s.store.Flush(); err != nil {
			t.Fatal(err)
		}
	})
}

func TestACountersReadWaitingForRemovalCanBeCancelled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		client := backend().Answer("d.erase", func([]any) any {
			close(entered)
			<-release
			return 0
		})
		s := newService(t, client, nil)
		removed := make(chan error, 1)
		go func() { removed <- s.Remove(ctx, hash, false) }()
		<-entered
		reading, cancel := context.WithCancel(ctx)
		read := make(chan error, 1)
		go func() { _, err := s.readTorrents(reading, "main"); read <- err }()
		synctest.Wait()
		cancel()
		if err := <-read; !errors.Is(err, context.Canceled) {
			t.Fatalf("read after cancellation: %v", err)
		}
		close(release)
		if err := <-removed; err != nil {
			t.Fatal(err)
		}
		if calls := client.CallsTo("d.multicall2"); len(calls) != 0 {
			t.Fatalf("the cancelled read reached rtorrent: %v", calls)
		}
	})
}
