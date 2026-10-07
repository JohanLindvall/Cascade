// SPDX-License-Identifier: MIT

package rtorrent

import (
	"context"
	"fmt"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/scgi"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// A listing of 500 torrents as rtorrent answers it, read and mapped the way
// every state read does.
func BenchmarkListing(b *testing.B) {
	rows := make([]any, 500)
	for i := range rows {
		row := make([]any, len(TorrentFields))
		for j, field := range TorrentFields {
			switch field {
			case "d.hash":
				row[j] = fmt.Sprintf("%040X", i)
			case "d.name", "d.message", "d.directory", "d.base_path", "d.custom1", "d.throttle_name":
				row[j] = fmt.Sprintf("torrent %d", i)
			default:
				row[j] = int64(i * j * 1000)
			}
		}
		rows[i] = row
	}
	response, err := xmlrpc.EncodeResponse(rows)
	if err != nil {
		b.Fatal(err)
	}
	client := NewClient(scgi.Target{}, func(context.Context, []byte) ([]byte, error) { return response, nil })
	b.SetBytes(int64(len(response)))
	b.ReportAllocs()
	for b.Loop() {
		listed, err := client.FieldMulticall(context.Background(), "d.multicall2", []any{"", "main"}, TorrentFields)
		if err != nil {
			b.Fatal(err)
		}
		for _, row := range listed {
			_ = MapTorrent(row, 0)
		}
	}
}
