// Command cascade is the Cascade server: the web UI, its API and the state
// stream for the rtorrent in the same container. Its subcommands are what the
// container's entrypoint needs before the server starts:
//
//	cascade                       serve
//	cascade help                  every option, as `docker run cascade --help` prints it
//	cascade boot-settings         the startup settings in the environment, as JSON
//	cascade log-scopes FILE       the log scopes the UI raised, from the state file
//	cascade health                whether the running server answers, for HEALTHCHECK
//	cascade options-docs [--write] [ROOT]
//	                              check (or rewrite) the README against the option catalog
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/config"
	"github.com/JohanLindvall/Cascade/server/internal/httpapi"
	"github.com/JohanLindvall/Cascade/server/internal/options"
	"github.com/JohanLindvall/Cascade/server/internal/service"
	"github.com/JohanLindvall/Cascade/server/internal/store"
	lightning "github.com/JohanLindvall/lightning/pkg/json"
)

func main() {
	log.SetFlags(0) // The container log carries its own timestamps.
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// run is the command line: the exit status of what args asked for.
func run(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	// Before anything is opened or read: `docker run --rm cascade --help`
	// should print and exit whatever the environment looks like.
	if slices.ContainsFunc(args, func(arg string) bool { return arg == "-h" || arg == "--help" || arg == "help" }) {
		fmt.Fprintln(stdout, options.RenderHelp(options.HelpWidth))
		return 0
	}
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	switch command {
	case "", "serve":
		if err := serve(getenv); err != nil {
			fmt.Fprintf(stderr, "[cascade] %v\n", err)
			return 1
		}
		return 0
	case "boot-settings":
		return bootSettings(getenv, stdout, stderr)
	case "log-scopes":
		if len(args) != 2 {
			fmt.Fprintln(stderr, "usage: cascade log-scopes STATE-FILE")
			return 2
		}
		logScopes(args[1], stdout)
		return 0
	case "options-docs":
		return optionsDocs(args[1:], stdout, stderr)
	case "health":
		return health(getenv, stderr)
	default:
		fmt.Fprintf(stderr, "cascade: unknown command %q (try --help)\n", command)
		return 2
	}
}

// How long a keep-alive connection may sit idle between requests; an open
// state stream is a request in progress, not an idle connection.
const idleTimeout = 2 * time.Minute

func serve(getenv func(string) string) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	st := store.Open(cfg.StateFile)
	svc := service.New(cfg, st, nil)

	// Cancelled on the way down, which ends every open state stream: a
	// graceful shutdown otherwise waits on them forever. A change in flight
	// is detached from it and still runs to its end.
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &http.Server{
		Handler:           httpapi.New(svc, cfg, st),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       idleTimeout,
		BaseContext:       func(net.Listener) context.Context { return base },
	}
	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	log.Printf("[cascade] listening on http://%s%s", address, cfg.BasePath)
	log.Printf("[cascade] rtorrent SCGI endpoint: %s", cfg.SCGI)
	if cfg.User == "" || cfg.Password == "" {
		log.Printf("[cascade] authentication disabled (set WEB_USER and WEB_PASS to enable)")
	}
	svc.Start()
	failed := make(chan error, 1)
	go func() { failed <- server.Serve(listener) }()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	select {
	case sig := <-signals:
		log.Printf("[cascade] %s received, shutting down", signalName(sig))
	case err := <-failed:
		svc.Stop()
		return err
	}
	svc.Stop()
	cancel()
	// A request already in flight may still change preferences or counters,
	// so the store is flushed once more after the server has drained.
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if err := server.Shutdown(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		log.Printf("[cascade] shutting down: %v", err)
	}
	if err := st.Flush(); err != nil {
		return fmt.Errorf("saving %s: %w", cfg.StateFile, err)
	}
	return nil
}

func signalName(sig os.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGINT:
		return "SIGINT"
	}
	return sig.String()
}

// bootSettings prints the startup settings for the entrypoint to stage in
// CASCADE_BOOT_SETTINGS. JSON encoding and input validation happen here, once,
// so a quoted path cannot corrupt the whole file and a bad value fails the
// start by its environment name.
func bootSettings(getenv func(string) string, stdout, stderr io.Writer) int {
	settings, err := config.StartupSettings(getenv)
	if err != nil {
		fmt.Fprintf(stderr, "[cascade] invalid startup setting: %v\n", err)
		return 1
	}
	data, err := json.Marshal(settings)
	if err != nil {
		fmt.Fprintf(stderr, "[cascade] %v\n", err)
		return 1
	}
	fmt.Fprintln(stdout, string(data))
	return 0
}

// healthTimeout stays inside the image HEALTHCHECK's own five seconds, so a
// hung server is reported as unhealthy rather than as a timed-out check.
const healthTimeout = 4 * time.Second

// health asks the running server's /healthz, for the image's HEALTHCHECK —
// which is why the image needs no curl. /healthz answers at the root whatever
// WEB_BASE_PATH is, and outside Basic auth. It is asked on the address the
// server listens on (a WEB_HOST bound to one interface does not answer on
// loopback), directly: a proxy in the environment is for rtorrent's traffic,
// not for this.
func health(getenv func(string) string, stderr io.Writer) int {
	cfg, err := config.Load(getenv)
	if err != nil {
		fmt.Fprintf(stderr, "[cascade] %v\n", err)
		return 1
	}
	host := strings.Trim(cfg.Host, "[]")
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	client := http.Client{Timeout: healthTimeout, Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Get("http://" + net.JoinHostPort(host, strconv.Itoa(cfg.Port)) + "/healthz")
	if err != nil {
		fmt.Fprintf(stderr, "[cascade] unhealthy: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(stderr, "[cascade] unhealthy: /healthz answered %s\n", resp.Status)
		return 1
	}
	return 0
}

// A scope name, and nothing that could carry an rc line with it.
var scopeName = regexp.MustCompile(`^[a-z][a-z_]{1,30}$`)

// logScopes prints the log scopes the UI raised in an earlier run, for the
// entrypoint to bake into rtorrent.rc. Anything unreadable — no file yet, or
// corrupt JSON — prints nothing rather than failing the start, and the names
// are filtered to the shape a scope has so a hand-edited file cannot inject
// rc lines.
func logScopes(file string, stdout io.Writer) {
	data, err := os.ReadFile(file)
	if err != nil || !lightning.Valid(data) {
		return
	}
	scopes := []string{}
	_ = lightning.ArrayEach(data, func(value []byte) error {
		if scope, err := lightning.String(value); err == nil && scopeName.MatchString(scope) {
			scopes = append(scopes, scope)
		}
		return nil
	}, "logScopes")
	fmt.Fprintln(stdout, strings.Join(scopes, " "))
}

// optionsDocs keeps the option catalog, the entrypoint and the README in
// step: it fails on any drift, and with --write regenerates the README's
// generated regions first.
func optionsDocs(args []string, stdout, stderr io.Writer) int {
	write := slices.Contains(args, "--write")
	root := ""
	for _, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			root = arg
		}
	}
	if root == "" {
		root = repositoryRoot()
	}
	if write {
		changed, err := options.WriteDocs(root)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if changed {
			fmt.Fprintln(stdout, "README regenerated")
		} else {
			fmt.Fprintln(stdout, "README already up to date")
		}
	}
	problems, err := options.Check(root)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if len(problems) > 0 {
		fmt.Fprintln(stderr, "option catalog is out of step:")
		for _, problem := range problems {
			fmt.Fprintf(stderr, "  - %s\n", problem)
		}
		return 1
	}
	fmt.Fprintf(stdout, "%d options documented, catalog and README in step\n", len(options.Options))
	return 0
}

// repositoryRoot is the nearest directory up from here holding both the
// README and the entrypoint.
func repositoryRoot() string {
	dir, _ := os.Getwd()
	for {
		_, readme := os.Stat(filepath.Join(dir, "README.md"))
		_, entrypoint := os.Stat(filepath.Join(dir, "docker", "entrypoint.sh"))
		if readme == nil && entrypoint == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "."
		}
		dir = parent
	}
}
