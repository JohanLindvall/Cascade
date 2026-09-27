// Package config reads the server's configuration out of the environment.
package config

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/JohanLindvall/Cascade/server/internal/jsnum"
	"github.com/JohanLindvall/Cascade/server/internal/options"
	"github.com/JohanLindvall/Cascade/server/internal/prefs"
	"github.com/JohanLindvall/Cascade/server/internal/scgi"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
)

type Config struct {
	SCGI     scgi.Target
	Host     string
	Port     int
	BasePath string
	// Basic auth is on only when both are set.
	User     string
	Password string
	WebRoot  string
	// The one JSON file Cascade keeps its state in.
	StateFile   string
	DownloadDir string
	// Empty when completed downloads are not moved.
	CompletedDir string
	// Where deleting a torrent's data is allowed, resolved.
	DeleteRoots     []string
	AllowRawRPC     bool
	AllowDataDelete bool
	MaxUploadBytes  int64
	// How often rates are sampled and the housekeeping runs.
	PollInterval time.Duration
	// How often the state is read for open pages, ms, unless a preference
	// says otherwise.
	StatePollMs int
	LogFile     string
	// The scopes RT_LOG_LEVEL baked into rtorrent.rc at container start.
	LogLevel         string
	BootSettingsFile string
	Gamify           bool
}

var (
	truthy   = regexp.MustCompile(`(?i)^(1|true|yes|on)$`)
	basePath = regexp.MustCompile(`^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)$`)
)

func normalizeBase(base string) (string, error) {
	value := validate.Trim(base)
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	value = strings.TrimRight(value, "/")
	if value == "" {
		value = "/"
	}
	if value != "/" {
		traversal := false
		for _, part := range strings.Split(value, "/") {
			traversal = traversal || part == "." || part == ".."
		}
		if !basePath.MatchString(value) || traversal {
			return "", fmt.Errorf("WEB_BASE_PATH must be a URL path without traversal or route pattern characters")
		}
	}
	return value, nil
}

// Load reads the configuration out of an environment; getenv is os.Getenv
// outside tests.
//
// Every value comes from the catalog in internal/options: the readers below
// look their default up by name, and that lookup panics for a name the
// catalog does not list. An environment variable therefore cannot reach the
// server without also appearing in --help and the README. (The options docs
// check scans this file for the str("NAME"), num("NAME"), flag("NAME") and
// optional("NAME") calls, so the reader names are part of that contract.)
func Load(getenv func(string) string) (cfg Config, err error) {
	raw := func(name string) (string, bool) {
		value := getenv(name)
		return value, value != ""
	}
	documented := func(name string) string {
		value, _ := options.Default(name)
		return value
	}
	str := func(name string, fallback ...string) string {
		def := documented(name)
		if len(fallback) > 0 {
			def = fallback[0]
		}
		if value, ok := raw(name); ok {
			return value
		}
		return def
	}
	optional := func(name string) string {
		documented(name) // Asserts the option is catalogued.
		value, _ := raw(name)
		return value
	}
	// The first failure is the one reported; later readers still run, which
	// keeps every name checked against the catalog.
	fail := func(e error) {
		if err == nil {
			err = e
		}
	}
	num := func(name string, max int64) int64 {
		text, ok := raw(name)
		if !ok {
			text = documented(name)
		}
		value := jsnum.Parse(text)
		if value != math.Trunc(value) || value < 1 || value > float64(max) {
			fail(fmt.Errorf("%s must be a whole number from 1 to %d", name, max))
			return 0
		}
		return int64(value)
	}
	// An option with no documented default reads as false rather than true,
	// so a new flag cannot arrive switched on by accident.
	flag := func(name string) bool {
		if value, ok := raw(name); ok {
			return truthy.MatchString(value)
		}
		return truthy.MatchString(documented(name))
	}

	cfg.DownloadDir = str("RT_DOWNLOAD_DIR")
	cfg.CompletedDir = optional("RT_COMPLETED_DIR")
	roots := append([]string{cfg.DownloadDir, cfg.CompletedDir}, strings.Split(str("CASCADE_DELETE_ROOTS", ""), ":")...)
	cfg.DeleteRoots = []string{}
	for _, root := range roots {
		if validate.Trim(root) == "" {
			continue
		}
		resolved, absErr := filepath.Abs(root)
		if absErr != nil {
			fail(absErr)
			continue
		}
		cfg.DeleteRoots = append(cfg.DeleteRoots, resolved)
	}

	target, scgiErr := scgi.ParseTarget(str("CASCADE_SCGI", str("RT_SCGI_SOCKET")))
	if scgiErr != nil {
		fail(scgiErr)
	}
	cfg.SCGI = target
	cfg.Host = str("WEB_HOST")
	cfg.Port = int(num("WEB_PORT", 65535))
	base, baseErr := normalizeBase(str("WEB_BASE_PATH"))
	if baseErr != nil {
		fail(baseErr)
	}
	cfg.BasePath = base
	cfg.User = optional("WEB_USER")
	cfg.Password = optional("WEB_PASS")
	// Falls back to the directory beside the binary's, so a source checkout
	// runs too.
	webRoot := filepath.Join("..", "web", "dist")
	if exe, exeErr := os.Executable(); exeErr == nil {
		webRoot = filepath.Join(filepath.Dir(exe), "..", "web", "dist")
	}
	resolved, absErr := filepath.Abs(str("CASCADE_WEB_ROOT", webRoot))
	if absErr != nil {
		fail(absErr)
	}
	cfg.WebRoot = resolved
	cfg.StateFile = str("CASCADE_STATE_FILE")
	cfg.AllowRawRPC = flag("CASCADE_ALLOW_RAW_RPC")
	cfg.AllowDataDelete = flag("CASCADE_ALLOW_DATA_DELETE")
	cfg.MaxUploadBytes = num("CASCADE_MAX_UPLOAD_MB", validate.MaxSafeInteger/(1024*1024)) * 1024 * 1024
	cfg.PollInterval = time.Duration(num("CASCADE_POLL_MS", math.MaxInt32)) * time.Millisecond
	cfg.StatePollMs = max(prefs.StatePollMsMin, int(num("CASCADE_STATE_POLL_MS", prefs.StatePollMsMax)))
	cfg.LogFile = str("RT_LOG_FILE")
	cfg.LogLevel = str("RT_LOG_LEVEL")
	cfg.BootSettingsFile = str("CASCADE_BOOT_SETTINGS")
	cfg.Gamify = flag("CASCADE_GAMIFY")
	return cfg, err
}
