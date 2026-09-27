// Command cascade is the Cascade server: the web UI, its API and the state
// stream for the rtorrent in the same container. Its subcommands are what the
// container's entrypoint needs before the server starts:
//
//	cascade                       serve
//	cascade help                  every option, as `docker run cascade --help` prints it
//	cascade boot-settings         the startup settings in the environment, as JSON
//	cascade log-scopes FILE       the log scopes the UI raised, from the state file
//	cascade options-docs [--write] [ROOT]
//	                              check (or rewrite) the README against the option catalog
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	args := os.Args[1:]
	// Before anything is opened or read: `docker run --rm cascade --help`
	// should print and exit whatever the environment looks like.
	if slices.ContainsFunc(args, func(arg string) bool { return arg == "-h" || arg == "--help" || arg == "help" }) {
		fmt.Println(options.RenderHelp(options.HelpWidth))
		return
	}
	command := ""
	if len(args) > 0 {
		command = args[0]
	}
	switch command {
	case "", "serve":
		serve()
	case "boot-settings":
		bootSettings()
	case "log-scopes":
		logScopes(args[1:])
	case "options-docs":
		os.Exit(optionsDocs(args[1:]))
	default:
		fmt.Fprintf(os.Stderr, "cascade: unknown command %q (try --help)\n", command)
		os.Exit(2)
	}
}

func serve() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatalf("[cascade] %v", err)
	}
	st := store.Open(cfg.StateFile)
	svc := service.New(cfg, st, nil)

	// Cancelled on the way down, which ends every open state stream: a
	// graceful shutdown otherwise waits on them forever.
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &http.Server{
		Handler:           httpapi.New(svc, cfg, st),
		ReadHeaderTimeout: 30 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return base },
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		log.Fatalf("[cascade] %v", err)
	}
	log.Printf("[cascade] listening on http://%s:%d%s", cfg.Host, cfg.Port, cfg.BasePath)
	log.Printf("[cascade] rtorrent SCGI endpoint: %s", cfg.SCGI)
	if cfg.User == "" || cfg.Password == "" {
		log.Printf("[cascade] authentication disabled (set WEB_USER and WEB_PASS to enable)")
	}
	svc.Start()
	failed := make(chan error, 1)
	go func() { failed <- server.Serve(listener) }()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	select {
	case sig := <-signals:
		log.Printf("[cascade] %s received, shutting down", signalName(sig))
	case err := <-failed:
		log.Fatalf("[cascade] %v", err)
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
		log.Printf("[cascade] saving %s: %v", cfg.StateFile, err)
	}
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
func bootSettings() {
	settings, err := config.StartupSettings(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[cascade] invalid startup setting: %v\n", err)
		os.Exit(1)
	}
	data, err := json.Marshal(settings)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[cascade] %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(data))
}

// A scope name, and nothing that could carry an rc line with it.
var scopeName = regexp.MustCompile(`^[a-z][a-z_]{1,30}$`)

// logScopes prints the log scopes the UI raised in an earlier run, for the
// entrypoint to bake into rtorrent.rc. Anything unreadable — no file yet, or
// corrupt JSON — prints nothing rather than failing the start, and the names
// are filtered to the shape a scope has so a hand-edited file cannot inject
// rc lines.
func logScopes(args []string) {
	file := os.Getenv("CASCADE_STATE_FILE")
	if len(args) > 0 {
		file = args[0]
	}
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
	fmt.Println(strings.Join(scopes, " "))
}

// optionsDocs keeps the option catalog, the entrypoint and the README in
// step: it fails on any drift, and with --write regenerates the README's
// generated regions first.
func optionsDocs(args []string) int {
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
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if changed {
			fmt.Println("README regenerated")
		} else {
			fmt.Println("README already up to date")
		}
	}
	problems, err := options.Check(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if len(problems) > 0 {
		fmt.Fprintln(os.Stderr, "option catalog is out of step:")
		for _, problem := range problems {
			fmt.Fprintf(os.Stderr, "  - %s\n", problem)
		}
		return 1
	}
	fmt.Printf("%d options documented, catalog and README in step\n", len(options.Options))
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
