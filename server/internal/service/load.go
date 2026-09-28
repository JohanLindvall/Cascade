package service

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/torrentfile"
)

// AddTorrentFile loads a .torrent and confirms it landed.
func (s *Service) AddTorrentFile(ctx context.Context, data []byte, options contracts.LoadOptions) error {
	// rtorrent reports success for anything, so junk is refused before it is
	// handed over — otherwise a mistyped file just vanishes — and before
	// rtorrent is asked anything at all.
	parsed, err := torrentfile.Parse(data)
	if err != nil {
		return httperr.New(http.StatusBadRequest, err.Error())
	}
	if err := checkLoadOptions(options); err != nil {
		return err
	}
	// Detached: a load that was sent is waited for even when the caller has
	// gone, or the next add in the queue could take it for its own.
	ctx = detached(ctx)
	return s.loads.run("session", func() error { return s.loadTorrentFile(ctx, data, parsed, options) })
}

func (s *Service) loadTorrentFile(ctx context.Context, data []byte, parsed torrentfile.Info, options contracts.LoadOptions) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	if err := s.refuseLoaded(ctx, parsed.InfoHash); err != nil {
		return err
	}
	dialect := s.caps.Dialect()
	method := dialect.LoadRaw
	if options.Start {
		method = dialect.LoadRawStart
	}
	params := append([]any{"", data}, s.loadCommands(options)...)
	if _, err := s.client.Call(ctx, method, params...); err != nil {
		return err
	}
	// load.* is queued rather than immediate, so confirm the torrent
	// actually landed instead of assuming it did.
	landed, err := s.waitForTorrent(ctx, parsed.InfoHash, 3*time.Second)
	if err != nil {
		return err
	}
	if !landed {
		name := parsed.Name
		if name == "" {
			name = parsed.InfoHash
		}
		return httperr.Newf(http.StatusBadGateway, `rtorrent did not accept "%s" — see the rtorrent log`, name)
	}
	return nil
}

// refuseLoaded is a 409 naming a torrent the session already holds, and nil
// when it does not. rtorrent drops a second load of a hash without a word —
// the label and directory it carried with it — and the wait that follows
// would take the copy already there for the new one, reporting success for a
// load that did nothing. A fetched URL has no hash to ask about beforehand;
// its wait for a new torrent fails instead, and its message says why it may.
func (s *Service) refuseLoaded(ctx context.Context, hash string) error {
	results, err := s.client.MulticallSettled(ctx, []rtorrent.Call{call("d.hash", hash), call("d.name", hash)})
	if err != nil {
		return err
	}
	if results[0].Err != nil || !strings.EqualFold(rtorrent.Text(results[0].Value), hash) {
		return nil
	}
	name := hash
	if results[1].Err == nil && rtorrent.Text(results[1].Value) != "" {
		name = rtorrent.Text(results[1].Value)
	}
	return httperr.Newf(http.StatusConflict, `"%s" is already loaded`, name)
}

// waitForTorrent polls briefly for a hash to appear in the session.
func (s *Service) waitForTorrent(ctx context.Context, hash string, timeout time.Duration) (bool, error) {
	deadline := s.now().Add(timeout)
	for {
		results, err := s.client.MulticallSettled(ctx, []rtorrent.Call{call("d.hash", hash)})
		if err != nil {
			return false, err
		}
		if results[0].Err == nil && strings.ToUpper(rtorrent.Text(results[0].Value)) == hash {
			return true, nil
		}
		if !s.now().Before(deadline) {
			return false, nil
		}
		if err := sleep(ctx, 150*time.Millisecond); err != nil {
			return false, err
		}
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var (
	fetchable = regexp.MustCompile(`(?i)^(magnet:\?|https?://|ftp://)`)
	magnet    = regexp.MustCompile(`(?i)^magnet:`)
)

// AddTorrentURL loads a magnet link or a torrent URL and confirms it landed.
func (s *Service) AddTorrentURL(ctx context.Context, url string, options contracts.LoadOptions) error {
	// load.* silently queues whatever it is given; a link rtorrent cannot
	// fetch would just vanish, so refuse anything that is not fetchable up
	// front.
	link := strings.TrimSpace(url)
	if !fetchable.MatchString(link) {
		return httperr.Newf(http.StatusBadRequest,
			`"%s" is not a magnet link or a torrent URL (magnet:, http(s):, ftp:)`, prefix(link, 80))
	}
	// A magnet carries its own info hash, so the load can be confirmed
	// exactly; one without a usable hash could never be.
	wanted := torrentfile.MagnetInfoHash(link)
	if magnet.MatchString(link) && wanted == "" {
		return httperr.New(http.StatusBadRequest, "magnet link must contain a valid xt=urn:btih: info hash")
	}
	if err := checkLoadOptions(options); err != nil {
		return err
	}
	ctx = detached(ctx)
	// URL loads have no known hash. Concurrent additions through this service
	// must not satisfy another URL's "a new torrent appeared" confirmation.
	return s.loads.run("session", func() error { return s.loadTorrentURL(ctx, link, wanted, options) })
}

func (s *Service) loadTorrentURL(ctx context.Context, link, wanted string, options contracts.LoadOptions) error {
	if err := s.caps.Ensure(ctx); err != nil {
		return err
	}
	dialect := s.caps.Dialect()
	method := dialect.LoadURL
	if options.Start {
		method = dialect.LoadURLStart
	}
	params := append([]any{"", link}, s.loadCommands(options)...)

	if wanted != "" {
		if err := s.refuseLoaded(ctx, wanted); err != nil {
			return err
		}
		if _, err := s.client.Call(ctx, method, params...); err != nil {
			return err
		}
		landed, err := s.waitForTorrent(ctx, wanted, 3*time.Second)
		if err != nil || landed {
			return err
		}
		return httperr.Newf(http.StatusBadGateway, "rtorrent did not accept the magnet for %s — see the rtorrent log", wanted)
	}

	// For a fetched URL there is nothing to compare against, so note what the
	// session held first and watch for something new to appear.
	before, err := s.sessionHashes(ctx)
	if err != nil {
		return err
	}
	if _, err := s.client.Call(ctx, method, params...); err != nil {
		return err
	}
	// rtorrent has to fetch the file first, so allow longer than a raw
	// upload. The wait is bounded, so the wording admits that a slow fetch
	// may still land rather than claiming the link is definitely broken.
	appeared, err := s.waitForNewTorrent(ctx, before, 10*time.Second)
	if err != nil || appeared {
		return err
	}
	return httperr.Newf(http.StatusBadGateway,
		`rtorrent loaded nothing from "%s" within 10s — the link may need a login, may not point at a .torrent, `+
			`or may already be loaded. Check the rtorrent log; if it was merely slow it may still appear.`, prefix(link, 120))
}

// prefix is at most n characters of text.
func prefix(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n])
}

// sessionHashes is every info hash currently in the session.
func (s *Service) sessionHashes(ctx context.Context) (map[string]bool, error) {
	dialect := s.caps.Dialect()
	rows, err := s.client.FieldMulticall(ctx, dialect.DownloadMulticall, dialect.DownloadMulticallPrefix("main"), []string{"d.hash"})
	if err != nil {
		return nil, err
	}
	hashes := make(map[string]bool, len(rows))
	for _, row := range rows {
		hashes[strings.ToUpper(rtorrent.Text(row["d.hash"]))] = true
	}
	return hashes, nil
}

// waitForNewTorrent polls until a hash the session did not have before
// turns up.
func (s *Service) waitForNewTorrent(ctx context.Context, before map[string]bool, timeout time.Duration) (bool, error) {
	deadline := s.now().Add(timeout)
	for {
		hashes, err := s.sessionHashes(ctx)
		if err != nil {
			return false, err
		}
		for hash := range hashes {
			if !before[hash] {
				return true, nil
			}
		}
		if !s.now().Before(deadline) {
			return false, nil
		}
		if err := sleep(ctx, 250*time.Millisecond); err != nil {
			return false, err
		}
	}
}

// checkLoadOptions refuses a directory with a control character in it. The
// directory rides into rtorrent inside a command string (d.directory.set=…),
// where quotes and backslashes are escaped but a line break could end the
// command and start another; no real path has one.
func checkLoadOptions(options contracts.LoadOptions) error {
	if strings.ContainsFunc(options.Directory, unicode.IsControl) {
		return httperr.New(http.StatusBadRequest, `"directory" contains control characters`)
	}
	return nil
}

// loadCommands are the commands a load runs on the new torrent: its
// directory, and its label URL-encoded (see quirk 11).
func (s *Service) loadCommands(options contracts.LoadOptions) []any {
	commands := []any{}
	if options.Directory != "" {
		commands = append(commands, `d.directory.set="`+escapeArg(options.Directory)+`"`)
	}
	if options.Label != "" && s.caps.Supports("labels") {
		commands = append(commands, `d.custom1.set="`+escapeArg(encodeURIComponent(options.Label))+`"`)
	}
	return commands
}

// escapeArg quotes for rtorrent's command parser, which uses double quotes
// around loading commands.
func escapeArg(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`)
}

// encodeURIComponent is the browser's: labels live URL-encoded in d.custom1
// (the ruTorrent convention), and other clients decode them the same way.
func encodeURIComponent(text string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(text); i++ {
		c := text[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
