package game

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite web/src/game-catalog.json from the tables")

// catalogPath is the browser's copy of the badge ids and level titles. The
// black metal theme carves its own copy of each (web/src/grim.ts), and
// grim.test.ts checks every entry here has one — so a badge or title added
// to the tables without a carving fails the web suite rather than showing
// its plain name in that theme.
var catalogPath = filepath.Join("..", "..", "..", "web", "src", "game-catalog.json")

// renderCatalog is the fixture as the tables say it should read: badge ids in
// table order, titles lowest level first, two-space indented like the rest of
// the repository's JSON.
func renderCatalog(t *testing.T) []byte {
	t.Helper()
	catalog := struct {
		Achievements []string `json:"achievements"`
		Titles       []string `json:"titles"`
	}{Achievements: []string{}, Titles: []string{}}
	for _, def := range Achievements {
		catalog.Achievements = append(catalog.Achievements, def.ID)
	}
	for i := len(Titles) - 1; i >= 0; i-- {
		catalog.Titles = append(catalog.Titles, Titles[i].Name)
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(catalog); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestCatalog(t *testing.T) {
	want := renderCatalog(t)
	// Built on its own (the image's Go stage), the module has no web sources
	// beside it to check against.
	if _, err := os.Stat(filepath.Dir(catalogPath)); err != nil {
		t.Skipf("no web sources beside the module: %v", err)
	}
	if *update {
		if err := os.WriteFile(catalogPath, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatalf("%v — run go test ./internal/game -run Catalog -update", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is out of step with the badge and title tables — run go test ./internal/game -run Catalog -update\nwant:\n%s", catalogPath, want)
	}
}
