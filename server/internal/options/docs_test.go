// SPDX-License-Identifier: MIT

package options

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const readmeTemplate = `# Cascade

<!-- generated: usage -->
stale usage
<!-- /generated -->

Prose between the regions stays as it is.

<!-- generated: options -->
stale tables
<!-- /generated -->

More prose.
`

func writeFile(t *testing.T, root, name, content string) {
	t.Helper()
	file := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeRepo lays out what Check reads under a temporary root, in step with the
// catalog: an entrypoint that reads every option without a setting (in both
// shell spellings) plus its own RT_VERSION, a config.go that reads nothing,
// and a README whose regions are current. The options with a setting appear
// nowhere: the startup settings read those.
func fakeRepo(t *testing.T, skip ...string) string {
	t.Helper()
	root := t.TempDir()
	shell := []string{"#!/bin/sh", `log "starting rtorrent $RT_VERSION"`}
	for i, option := range Options {
		if option.Setting != "" || slices.Contains(skip, option.Name) {
			continue
		}
		if i%2 == 0 {
			shell = append(shell, `: "${`+option.Name+`:-}"`)
		} else {
			shell = append(shell, `echo "$`+option.Name+`"`)
		}
	}
	writeFile(t, root, entrypointFile, strings.Join(shell, "\n")+"\n")
	writeFile(t, root, configFile, "package config\n")
	readme, err := Generate(readmeTemplate)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, readmeFile, readme)
	return root
}

func check(t *testing.T, root string) []string {
	t.Helper()
	problems, err := Check(root)
	if err != nil {
		t.Fatal(err)
	}
	return problems
}

func TestCheckPassesARepositoryInStep(t *testing.T) {
	if problems := check(t, fakeRepo(t)); len(problems) != 0 {
		t.Fatalf("problems in step: %q", problems)
	}
}

func TestCheckNamesAnUncataloguedRead(t *testing.T) {
	root := fakeRepo(t)
	entrypoint, _ := os.ReadFile(filepath.Join(root, entrypointFile))
	writeFile(t, root, entrypointFile, string(entrypoint)+`echo "${RT_NEW_KNOB:-1}"`+"\n")
	writeFile(t, root, configFile, "package config\n\nvar knob = num(\"CASCADE_NEW_KNOB\", 10)\n")
	want := []string{
		"CASCADE_NEW_KNOB is read by the container but missing from options.go",
		"RT_NEW_KNOB is read by the container but missing from options.go",
	}
	if problems := check(t, root); !slices.Equal(problems, want) {
		t.Fatalf("got %q, want %q", problems, want)
	}
}

func TestCheckNamesAnOptionNothingReads(t *testing.T) {
	want := []string{
		"RT_UMASK is documented in options.go but nothing reads it",
		"WEB_PORT is documented in options.go but nothing reads it",
	}
	if problems := check(t, fakeRepo(t, "WEB_PORT", "RT_UMASK")); !slices.Equal(problems, want) {
		t.Fatalf("got %q, want %q", problems, want)
	}
}

// Every reader internal/config uses counts, whatever its arguments.
func TestCheckCountsTheServersReads(t *testing.T) {
	root := fakeRepo(t, "WEB_PORT", "CASCADE_GAMIFY", "WEB_USER", "CASCADE_STATE_FILE")
	writeFile(t, root, configFile, `package config

func load() {
	_ = num("WEB_PORT", 65535)
	_ = flag("CASCADE_GAMIFY")
	_ = optional("WEB_USER")
	_ = str("CASCADE_STATE_FILE")
}
`)
	if problems := check(t, root); len(problems) != 0 {
		t.Fatalf("problems: %q", problems)
	}
}

func TestCheckNamesADriftedReadme(t *testing.T) {
	root := fakeRepo(t)
	writeFile(t, root, readmeFile, readmeTemplate)
	want := []string{"README is out of date — run `cascade options-docs --write`"}
	if problems := check(t, root); !slices.Equal(problems, want) {
		t.Fatalf("got %q, want %q", problems, want)
	}
}

func TestCheckFailsOnAFileItCannotRead(t *testing.T) {
	for _, file := range []string{entrypointFile, configFile, readmeFile} {
		root := fakeRepo(t)
		if err := os.Remove(filepath.Join(root, file)); err != nil {
			t.Fatal(err)
		}
		if _, err := Check(root); err == nil {
			t.Errorf("no error without %s", file)
		}
	}
}

func TestGenerateFillsOnlyTheRegions(t *testing.T) {
	readme, err := Generate(readmeTemplate)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.NewReplacer(
		"stale usage", "```bash\n"+UsageExample+"\n```",
		"stale tables", RenderMarkdown(),
	).Replace(readmeTemplate)
	if readme != want {
		t.Fatalf("generated %s", firstDifference(readme, want))
	}
	if again, _ := Generate(readme); again != readme {
		t.Fatal("generating twice changed the README")
	}
}

func TestGenerateNamesAMissingMarker(t *testing.T) {
	for _, c := range []struct{ readme, want string }{
		{
			strings.Replace(readmeTemplate, "<!-- generated: usage -->", "", 1),
			"README is missing the <!-- generated: usage --> marker",
		},
		{
			readmeTemplate[:strings.LastIndex(readmeTemplate, "<!-- /generated -->")],
			"README is missing the <!-- /generated --> after <!-- generated: options -->",
		},
	} {
		if _, err := Generate(c.readme); err == nil || err.Error() != c.want {
			t.Errorf("got %v, want %q", err, c.want)
		}
	}
}

func TestWriteDocsRewritesADriftedReadme(t *testing.T) {
	root := fakeRepo(t)
	file := filepath.Join(root, readmeFile)
	writeFile(t, root, readmeFile, readmeTemplate)
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}

	changed, err := WriteDocs(root)
	if err != nil || !changed {
		t.Fatalf("first write: %v, %v", changed, err)
	}
	written, _ := os.ReadFile(file)
	if want, _ := Generate(readmeTemplate); string(written) != want {
		t.Fatalf("wrote %s", firstDifference(string(written), want))
	}
	if info, _ := os.Stat(file); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v after the write", info.Mode().Perm())
	}
	if problems := check(t, root); len(problems) != 0 {
		t.Errorf("problems after the write: %q", problems)
	}

	if changed, err := WriteDocs(root); err != nil || changed {
		t.Fatalf("second write: %v, %v", changed, err)
	}
}

// The repository itself: the entrypoint and the config reader read only
// catalogued variables, and every catalogued one is read by something.
func TestTheRepositoryIsInStep(t *testing.T) {
	problems, err := Check(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) > 0 {
		t.Fatalf("option catalog is out of step:\n  %s", strings.Join(problems, "\n  "))
	}
}

// The repository's own README, read-only: its generated regions must be what
// the catalog renders today.
func TestTheReadmeIsInStep(t *testing.T) {
	readme, err := os.ReadFile(filepath.Join("..", "..", "..", readmeFile))
	if err != nil {
		t.Fatal(err)
	}
	generated, err := Generate(string(readme))
	if err != nil {
		t.Fatal(err)
	}
	if generated != string(readme) {
		t.Fatalf("README.md is out of step with the catalog — run `cascade options-docs --write`; %s",
			firstDifference(generated, string(readme)))
	}
}
