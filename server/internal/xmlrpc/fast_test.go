// SPDX-License-Identifier: MIT

package xmlrpc

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"github.com/JohanLindvall/Cascade/server/internal/utf8text"
)

func document(inner string) string {
	return `<?xml version="1.0"?><methodResponse><params><param>` + inner + `</param></params></methodResponse>`
}

// slowly is what the permissive parser alone makes of a document.
func slowly(xml string) (any, error) {
	return readResponse(utf8text.Decode([]byte(xml)))
}

// agree holds the fast path to the permissive parser: for any document it
// either declines or decodes to exactly the same value or fault.
func agree(t *testing.T, xml string) (declined bool) {
	t.Helper()
	fast, fastErr := decodeFast(xml)
	if errors.Is(fastErr, errDecline) {
		return true
	}
	slow, slowErr := slowly(xml)
	var fastFault, slowFault *Fault
	switch {
	case errors.As(fastErr, &fastFault):
		if !errors.As(slowErr, &slowFault) || *fastFault != *slowFault {
			t.Errorf("fault %v, permissive parser says %v / %v\n%s", fastFault, slow, slowErr, xml)
		}
	case fastErr != nil:
		t.Errorf("the fast path failed rather than declined: %v\n%s", fastErr, xml)
	case slowErr != nil:
		t.Errorf("the fast path read %#v where the permissive parser fails: %v\n%s", fast, slowErr, xml)
	case !reflect.DeepEqual(fast, slow):
		t.Errorf("fast %#v\nslow %#v\n%s", fast, slow, xml)
	}
	return false
}

func TestTheFastPathReadsWhatThePermissiveParserReads(t *testing.T) {
	plain := []string{
		document(`<value><string>x &amp; &lt;y&gt; &#229;</string></value>`),
		document(`<value>untyped &quot;text&quot;</value>`),
		document(`<value></value>`),
		document(`<value/>`),
		document(`<value><string/></value>`),
		document(`<value><i8>-9007199254740993</i8></value>`),
		document(`<value><i4> 42 </i4></value>`),
		document(`<value><ex.i8>7</ex.i8></value>`),
		document(`<value><double>-1.5e3</double></value>`),
		document(`<value><boolean>1</boolean></value>`),
		document(`<value><base64>aGVsbG8=</base64></value>`),
		document(`<value><nil/></value>`),
		document(`<value><array><data/></array></value>`),
		document(`<value><struct/></value>`),
		document("<value>\n  <array>\n    <data>\n      <value><i8>1</i8></value>\n      <value><string>a</string></value>\n    </data>\n  </array>\n</value>"),
		document(`<value><struct><member><name>a&amp;b</name><value><i4>1</i4></value></member><member><name>a&amp;b</name><value>2</value></member></struct></value>`),
		`<methodResponse><fault><value><struct><member><name>faultCode</name><value><i4>-501</i4></value></member><member><name>faultString</name><value><string>Could not find info-hash.</string></value></member></struct></value></fault></methodResponse>`,
		"\uFEFF" + document(`<value><string>after a byte order mark</string></value>`),
	}
	for _, xml := range plain {
		if agree(t, xml) {
			t.Errorf("declined a plain document:\n%s", xml)
		}
	}
	// Documents off the plain shape go to the permissive parser, whatever
	// it makes of them.
	for _, xml := range []string{
		document(`<value><![CDATA[<x>]]></value>`),
		document(`<value><!-- note --><string>x</string></value>`),
		document(`<value><string lang="en">x</string></value>`),
		document(`<value><i8>99999999999999999999</i8></value>`),
		document(`<value><i4>&#52;2</i4></value>`),
		document(`<value><i4>4.2</i4></value>`),
		document(`<value><boolean>yes</boolean></value>`),
		document(`<value><double>1e400</double></value>`),
		document(`<value><dateTime.iso8601>20260927T12:00:00</dateTime.iso8601></value>`),
		document(`<value>text<string>x</string></value>`),
		document(`<value><array/></value>`),
		document(`<value><string>x</string>junk</value>`),
		document(`<value><string>x</string></value>`) + "<trailing/>",
		`<methodResponse><params><param><value>1</value></param><param><value>2</value></param></params></methodResponse>`,
		`<methodResponse><params></params></methodResponse>`,
		document(`<value><string>unterminated</value>`),
		document(strings.Repeat(`<value><array><data>`, 40) + strings.Repeat(`</data></array></value>`, 40)),
	} {
		if !agree(t, xml) {
			t.Errorf("took an irregular document:\n%s", xml)
		}
	}
	// Where the declaration ends decides what reads as tags after it, so a
	// '>' or a '<' inside one must not end it early for either parser.
	for _, xml := range []string{
		`<?xml><0?><methodResponse><params><param><value></value></param></params></methodResponse>`,
		`<?xml version="1.0" x="><params><param><value>evil</value></param></params>"?>` +
			`<methodResponse><params><param><value>hi</value></param></params></methodResponse>`,
		`<?xml-stylesheet href="a><b"?><methodResponse><params><param><value>x</value></param></params></methodResponse>`,
	} {
		agree(t, xml)
	}
}

// random builds a value of the kinds rtorrent sends, nested a few levels.
func random(r *rand.Rand, depth int) any {
	texts := []string{"", "plain", "a & b", "<tag>", `"quoted" 'apos'`, "räksmörgås 😀", "  padded  ", "line\nbreak"}
	switch n := r.Intn(9); {
	case n == 0 && depth < 4:
		items := make([]any, r.Intn(4))
		for i := range items {
			items[i] = random(r, depth+1)
		}
		return items
	case n == 1 && depth < 4:
		record := map[string]any{}
		for range r.Intn(4) {
			record[texts[r.Intn(len(texts))]] = random(r, depth+1)
		}
		return record
	case n == 2:
		return r.Int63n(1<<40) - 1<<39
	case n == 3:
		return int64(r.Intn(1000))
	case n == 4:
		return float64(r.Intn(100000)) / 64
	case n == 5:
		return r.Intn(2) == 1
	case n == 6:
		return []byte(texts[r.Intn(len(texts))])
	default:
		return texts[r.Intn(len(texts))]
	}
}

func TestTheFastPathTakesEverythingTheEncoderWrites(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := range 3000 {
		value := random(r, 0)
		xml, err := EncodeResponse(value)
		if err != nil {
			t.Fatal(err)
		}
		if agree(t, string(xml)) {
			t.Fatalf("case %d: declined the encoder's own output:\n%s", i, xml)
		}
		// rtorrent indents its answers; so can the test.
		indented := strings.NewReplacer("><", ">\n  <").Replace(string(xml))
		agree(t, indented)
	}
	fault := EncodeFault(-506, "Method 'x' not defined")
	if agree(t, string(fault)) {
		t.Fatalf("declined a fault:\n%s", fault)
	}
}

func TestDecodedTextDoesNotHoldTheDocument(t *testing.T) {
	doc := document(`<value><struct><member><name>hash</name><value><string>AAAA</string></value></member>` +
		`<member><name>name</name><value>untyped</value></member></struct></value>`)
	value, err := decodeFast(doc)
	if err != nil {
		t.Fatal(err)
	}
	base := uintptr(unsafe.Pointer(unsafe.StringData(doc)))
	inside := func(text string) bool {
		at := uintptr(unsafe.Pointer(unsafe.StringData(text)))
		return at >= base && at < base+uintptr(len(doc))
	}
	for key, item := range value.(map[string]any) {
		if inside(key) || inside(item.(string)) {
			t.Errorf("%q: %q is a window onto the document, which it would keep alive", key, item)
		}
	}
}

func BenchmarkDecodeListing(b *testing.B) {
	// A listing multicall of 500 torrents, as rtorrent writes it.
	var rows strings.Builder
	for i := range 500 {
		rows.WriteString("<value><array><data>\n")
		fmt.Fprintf(&rows, "<value><string>%040X</string></value>\n<value><string>torrent %d</string></value>\n", i, i)
		for field := range 31 {
			fmt.Fprintf(&rows, "<value><i8>%d</i8></value>\n", i*field*1000)
		}
		rows.WriteString("</data></array></value>\n")
	}
	xml := []byte(document("<value><array><data>\n" + rows.String() + "</data></array></value>"))
	b.SetBytes(int64(len(xml)))
	for b.Loop() {
		if _, err := DecodeResponse(xml); err != nil {
			b.Fatal(err)
		}
	}
}
