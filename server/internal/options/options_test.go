// SPDX-License-Identifier: MIT

package options

// The catalog is load-bearing: internal/config trusts Default to panic on an
// unknown name, and --help and the README render from it verbatim.

import (
	"flag"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The golden files hold the renderers' output as the TypeScript implementation
// produced it when the catalog moved to Go, so --help and the README tables
// came across unchanged. A change to the catalog changes them too: regenerate
// with `go test ./internal/options -update`, then check the diff.
var update = flag.Bool("update", false, "rewrite the golden files from the current renderers")

func TestOptionNamesAreUniqueAndSectioned(t *testing.T) {
	seen := map[string]bool{}
	for _, option := range Options {
		if seen[option.Name] {
			t.Errorf("%s is catalogued twice", option.Name)
		}
		seen[option.Name] = true
		if !slices.Contains(Sections, option.Section) {
			t.Errorf("%s is in the unknown section %q", option.Name, option.Section)
		}
	}
}

func panicOf(f func()) (message any) {
	defer func() { message = recover() }()
	f()
	return nil
}

func TestDefaultAnswersForTheCataloguedAndPanicsForTheRest(t *testing.T) {
	if value, ok := Default("WEB_PORT"); !ok || value != "8080" {
		t.Errorf("WEB_PORT: %q, %v", value, ok)
	}
	// Documented, with no default.
	if value, ok := Default("RT_COMPLETED_DIR"); ok || value != "" {
		t.Errorf("RT_COMPLETED_DIR: %q, %v", value, ok)
	}
	message := panicOf(func() { Default("CASCADE_TYPO") })
	if message == nil || !regexp.MustCompile(`missing|not listed`).MatchString(fmt.Sprint(message)) {
		t.Errorf("an uncatalogued name gave %v", message)
	}
}

func TestLookup(t *testing.T) {
	option, ok := Lookup("RT_DOWNLOAD_RATE")
	if !ok || option.Setting != "downloadRate" || !option.KiB || option.Default != nil || option.Note != rtorrentDefault {
		t.Errorf("RT_DOWNLOAD_RATE: %+v, %v", option, ok)
	}
	if _, ok := Lookup("CASCADE_TYPO"); ok {
		t.Error("an uncatalogued name was found")
	}
}

func TestHelpNamesEveryOption(t *testing.T) {
	help := RenderHelp(HelpWidth)
	for _, option := range Options {
		if !strings.Contains(help, option.Name) {
			t.Errorf("%s missing from --help", option.Name)
		}
	}
}

func TestReadmeTablesNameEveryOption(t *testing.T) {
	markdown := RenderMarkdown()
	for _, option := range Options {
		if !strings.Contains(markdown, "`"+option.Name+"`") {
			t.Errorf("%s missing from the tables", option.Name)
		}
	}
}

// firstDifference describes where two texts part, which reads better than
// two 9 KB strings side by side.
func firstDifference(got, want string) string {
	gotLines, wantLines := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := range max(len(gotLines), len(wantLines)) {
		var g, w string
		if i < len(gotLines) {
			g = gotLines[i]
		}
		if i < len(wantLines) {
			w = wantLines[i]
		}
		if g != w || i >= len(gotLines) || i >= len(wantLines) {
			return fmt.Sprintf("line %d:\n got %q\nwant %q", i+1, g, w)
		}
	}
	return "no difference"
}

func TestRenderersMatchTheGoldenFiles(t *testing.T) {
	for _, c := range []struct{ file, got string }{
		// What `cascade --help` prints: the render and a newline.
		{"testdata/help.golden", RenderHelp(HelpWidth) + "\n"},
		{"testdata/markdown.golden", RenderMarkdown() + "\n"},
	} {
		if *update {
			if err := os.WriteFile(c.file, []byte(c.got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(c.file)
		if err != nil {
			t.Fatal(err)
		}
		if c.got != string(want) {
			t.Errorf("%s differs from the render, %s", c.file, firstDifference(c.got, string(want)))
		}
	}
}

// An empty default is still a default: --help shows it as [], while the
// README falls back to the note, as for an option with no default at all.
func TestAnEmptyDefaultIsNotAMissingOne(t *testing.T) {
	saved := Options
	t.Cleanup(func() { Options = saved })
	Options = []Option{
		{Name: "CASCADE_EMPTY", Section: "Web server", Summary: "Empty default", Default: ptr(""), Note: "a note"},
		{Name: "CASCADE_NOTED", Section: "Web server", Summary: "No default", Note: "a note"},
		{Name: "CASCADE_BARE", Section: "Web server", Summary: "Nothing to show"},
		{Name: "CASCADE_SET", Section: "Web server", Summary: "A default", Default: ptr("7")},
	}

	help := RenderHelp(HelpWidth)
	for _, want := range []string{"Empty default []", "No default [a note]", "Nothing to show [—]", "A default [7]"} {
		if !strings.Contains(help, want) {
			t.Errorf("--help lacks %q", want)
		}
	}
	markdown := RenderMarkdown()
	for _, want := range []string{
		"| `CASCADE_EMPTY` | a note | Empty default |",
		"| `CASCADE_NOTED` | a note | No default |",
		"| `CASCADE_BARE` | — | Nothing to show |",
		"| `CASCADE_SET` | `7` | A default |",
	} {
		if !strings.Contains(markdown, want) {
			t.Errorf("the tables lack %q", want)
		}
	}
}

func TestWrap(t *testing.T) {
	nbsp, bom, nel := string(rune(0x00A0)), string(rune(0xFEFF)), string(rune(0x0085))
	for _, c := range []struct {
		text  string
		width int
		want  []string
	}{
		{"one two three", 7, []string{"one two", "three"}},
		{"one two three", 100, []string{"one two three"}},
		// A word longer than the width gets a line of its own rather than being cut.
		{"a verylongword b", 4, []string{"a", "verylongword", "b"}},
		// A column is a UTF-16 unit: seven of them, though "—" is three bytes.
		{"ab — cd", 7, []string{"ab — cd"}},
		{"ab — cd", 6, []string{"ab —", "cd"}},
		// Words split on runs of JavaScript's \s, byte order mark included and
		// U+0085 not.
		{"  a \t\n b" + nbsp + "c" + bom + "d  ", 100, []string{"a b c d"}},
		{"a" + nel + "b c", 100, []string{"a" + nel + "b c"}},
		{"", 10, nil},
		{"   ", 10, nil},
	} {
		if got := wrap(c.text, c.width); !slices.Equal(got, c.want) {
			t.Errorf("wrap(%q, %d) = %q, want %q", c.text, c.width, got, c.want)
		}
	}
}

func TestTextWidthCountsUTF16Units(t *testing.T) {
	for text, want := range map[string]int{"": 0, "abc": 3, "—": 1, "…x": 2, string(rune(0x1F600)): 2} {
		if got := textWidth(text); got != want {
			t.Errorf("textWidth(%q) = %d, want %d", text, got, want)
		}
	}
}
