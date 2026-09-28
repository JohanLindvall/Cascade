package options

// Keeping the catalog, the entrypoint and the README in step:
//
//	cascade options-docs           verify — used by CI, fails on any drift
//	cascade options-docs --write   rewrite the generated regions of the README
//
// The catalog cannot silently fall behind the shell: every RT_/WEB_/CASCADE_
// variable the entrypoint reads must be listed in Options, and every option
// listed must actually be used by something. The server side needs no check
// of its own — internal/config looks its defaults up here and panics
// otherwise — but what it reads counts as a use.

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Where the checked files live, relative to the repository root.
const (
	entrypointFile = "docker/entrypoint.sh"
	configFile     = "server/internal/config/config.go"
	readmeFile     = "README.md"
)

// internal lists variables the entrypoint uses for its own plumbing, not user
// options.
var internal = map[string]bool{"RT_VERSION": true}

type marker struct {
	begin, end string
	render     func() string
}

var markers = []marker{
	{
		begin:  "<!-- generated: usage -->",
		end:    "<!-- /generated -->",
		render: func() string { return strings.Join([]string{"```bash", UsageExample, "```"}, "\n") },
	},
	{
		begin:  "<!-- generated: options -->",
		end:    "<!-- /generated -->",
		render: RenderMarkdown,
	},
}

// Reads of an environment variable: ${RT_FOO:-…} or $RT_FOO in the shell, and
// internal/config's readers — str("RT_FOO"), num("WEB_PORT", …), flag(…),
// optional(…) — in Go. Both patterns run over both files.
var envReads = []*regexp.Regexp{
	regexp.MustCompile(`\$\{?((?:RT|WEB|CASCADE)_[A-Z0-9_]+|PUID|PGID|TZ)\b`),
	regexp.MustCompile(`\b(?:str|num|flag|optional)\("((?:RT|WEB|CASCADE)_[A-Z0-9_]+)"`),
}

func envNamesIn(file string) (map[string]bool, error) {
	text, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, pattern := range envReads {
		for _, match := range pattern.FindAllStringSubmatch(string(text), -1) {
			names[match[1]] = true
		}
	}
	return names, nil
}

// Generate replaces each generated region of a README with a fresh render and
// returns the new text.
func Generate(readme string) (string, error) {
	out := readme
	for _, m := range markers {
		start := strings.Index(out, m.begin)
		if start < 0 {
			return "", fmt.Errorf("README is missing the %s marker", m.begin)
		}
		from := start + len(m.begin)
		end := strings.Index(out[from:], m.end)
		if end < 0 {
			return "", fmt.Errorf("README is missing the %s after %s", m.end, m.begin)
		}
		out = out[:from] + "\n" + m.render() + "\n" + out[from+end:]
	}
	return out, nil
}

// Check verifies the catalog against the repository at root: every variable
// the entrypoint or internal/config reads is catalogued, every catalogued
// option is read by something, and the README's generated regions are what
// Generate would write. It returns the problems it found; err is for a file
// it could not read.
func Check(root string) (problems []string, err error) {
	used := map[string]bool{}
	for _, file := range []string{entrypointFile, configFile} {
		names, err := envNamesIn(filepath.Join(root, file))
		if err != nil {
			return nil, err
		}
		for name := range names {
			used[name] = true
		}
	}
	catalogued := map[string]bool{}
	for _, option := range Options {
		catalogued[option.Name] = true
		if option.Setting != "" {
			used[option.Name] = true
		}
	}

	problems = []string{}
	for _, name := range sortedKeys(used) {
		if !catalogued[name] && !internal[name] {
			problems = append(problems, name+" is read by the container but missing from options.go")
		}
	}
	for _, name := range sortedKeys(catalogued) {
		if !used[name] {
			problems = append(problems, name+" is documented in options.go but nothing reads it")
		}
	}

	readme, err := os.ReadFile(filepath.Join(root, readmeFile))
	if err != nil {
		return nil, err
	}
	generated, err := Generate(string(readme))
	if err != nil {
		return nil, err
	}
	if generated != string(readme) {
		problems = append(problems, "README is out of date — run `cascade options-docs --write`")
	}
	return problems, nil
}

// WriteDocs rewrites the generated regions of the README at root, reporting
// whether anything changed. Check afterwards finds only catalog problems.
func WriteDocs(root string) (changed bool, err error) {
	file := filepath.Join(root, readmeFile)
	readme, err := os.ReadFile(file)
	if err != nil {
		return false, err
	}
	generated, err := Generate(string(readme))
	if err != nil {
		return false, err
	}
	if generated == string(readme) {
		return false, nil
	}
	// The file exists, so its mode is kept; the permission only applies to a
	// file being created.
	if err := os.WriteFile(file, []byte(generated), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func sortedKeys(set map[string]bool) []string {
	return slices.Sorted(maps.Keys(set))
}
