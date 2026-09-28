package xmlrpc

// The codec is hand-written and everything rides on it: every value the UI
// shows came through DecodeResponse, and every command through EncodeCall.
// These pin the wire format against rtorrent's dialect — <i8>, 8-bit strings,
// fault structs — and the parser's tolerance for the XML noise a real
// endpoint emits.

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

// respond wraps a serialized value in a methodResponse, as rtorrent answers.
func respond(valueXML string) []byte {
	return []byte(`<?xml version="1.0"?><methodResponse><params><param><value>` + valueXML +
		`</value></param></params></methodResponse>`)
}

var paramBody = regexp.MustCompile(`(?s)<params><param>(.*)</param></params>`)

// roundTrip serializes a value as a call param and reads it back as a response.
func roundTrip(t *testing.T, value any) any {
	t.Helper()
	call, err := EncodeCall("echo", []any{value})
	if err != nil {
		t.Fatal(err)
	}
	body := paramBody.FindSubmatch(call)
	if body == nil {
		t.Fatalf("no param in serialized call %s", call)
	}
	decoded, err := DecodeResponse([]byte(`<?xml version="1.0"?><methodResponse><params><param>` +
		string(body[1]) + `</param></params></methodResponse>`))
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func decode(t *testing.T, xml []byte) any {
	t.Helper()
	value, err := DecodeResponse(xml)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestScalarsRoundTrip(t *testing.T) {
	for _, c := range []struct{ in, want any }{
		{"plain", "plain"},
		{42, int64(42)},
		{-7, int64(-7)},
		{true, true},
		{false, false},
		{2.5, 2.5},
		// JSON hands every number over as a float64; a whole one is an integer.
		{float64(42), int64(42)},
	} {
		if got := roundTrip(t, c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%#v came back as %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestIntegerPast32BitsTravelsAsI8(t *testing.T) {
	const size = 7_000_000_000 // an ordinary torrent size in bytes
	for _, value := range []any{int64(size), float64(size)} {
		call, err := EncodeCall("echo", []any{value})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(call), "<i8>7000000000</i8>") {
			t.Errorf("%T: %s", value, call)
		}
		if got := roundTrip(t, value); got != int64(size) {
			t.Errorf("%T came back as %#v", value, got)
		}
	}
}

func TestAWholeNumberPastInt64IsRefusedRatherThanSent(t *testing.T) {
	// An <i8> rtorrent cannot read does not fault, it kills rtorrent.
	for _, value := range []any{1e19, -1e19, 1e21, float64(math.MaxInt64), float32(1e19),
		json.Number("9223372036854775808"), json.Number("1e21")} {
		if call, err := EncodeCall("x", []any{value}); err == nil || !strings.Contains(err.Error(), "64-bit") {
			t.Errorf("%T %v: %v\n%s", value, value, err, call)
		}
	}
	// Up to the edges, the float's own value in plain digits.
	for _, c := range []struct {
		value any
		want  string
	}{
		{float64(math.MinInt64), "<i8>-9223372036854775808</i8>"},
		{math.Nextafter(1<<63, 0), "<i8>9223372036854774784</i8>"},
		{json.Number("9.2e18"), "<i8>9200000000000000000</i8>"},
		{json.Number("1e3"), "<i4>1000</i4>"},
		{math.Copysign(0, -1), "<i4>0</i4>"},
	} {
		call, err := EncodeCall("x", []any{c.value})
		if err != nil || !strings.Contains(string(call), c.want) {
			t.Errorf("%v: %v, want %s in\n%s", c.value, err, c.want, call)
		}
	}
}

func TestMarkupInStringsSurvivesBothDirections(t *testing.T) {
	tricky := `a <b> & "c" 'd'`
	if got := roundTrip(t, tricky); got != tricky {
		t.Fatalf("got %q", got)
	}
}

func TestControlCharactersAreStrippedOnTheWayOut(t *testing.T) {
	call, err := EncodeCall("echo", []any{"a\x00b\x01c\nd"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(call), "<string>abc\nd</string>") {
		t.Fatalf("%q", call)
	}
}

func TestArraysAndStructsNest(t *testing.T) {
	value := map[string]any{"list": []any{"x", 2}, "inner": map[string]any{"deep": "yes"}}
	want := map[string]any{"list": []any{"x", int64(2)}, "inner": map[string]any{"deep": "yes"}}
	if got := roundTrip(t, value); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v", got)
	}
}

func TestBase64ValuesBecomeBytes(t *testing.T) {
	data := []byte("raw bytes \xff")
	got, ok := roundTrip(t, data).([]byte)
	if !ok || string(got) != string(data) {
		t.Fatalf("got %#v", got)
	}
}

func TestNumericAndNamedEntitiesDecode(t *testing.T) {
	if got := decode(t, respond("<string>&#229;&amp;&lt;&gt;&quot;&apos;</string>")); got != "å&<>\"'" {
		t.Fatalf("got %q", got)
	}
}

func TestAnUntypedValueIsAString(t *testing.T) {
	if got := decode(t, respond("bare text")); got != "bare text" {
		t.Fatalf("got %q", got)
	}
}

func TestCDATAIsTextAmpersandsIncluded(t *testing.T) {
	if got := decode(t, respond("<string><![CDATA[a & b <c>]]></string>")); got != "a & b <c>" {
		t.Fatalf("got %q", got)
	}
}

func TestWhitespaceBetweenTagsIsNotData(t *testing.T) {
	xml := `<?xml version="1.0"?>
<methodResponse>
  <params>
    <param>
      <value><array><data>
        <value><i4>1</i4></value>
        <value><string>two</string></value>
      </data></array></value>
    </param>
  </params>
</methodResponse>`
	if got := decode(t, []byte(xml)); !reflect.DeepEqual(got, []any{int64(1), "two"}) {
		t.Fatalf("got %#v", got)
	}
}

func TestAFaultComesBackWithItsCodeAndMessage(t *testing.T) {
	xml := `<?xml version="1.0"?><methodResponse><fault><value><struct>
    <member><name>faultCode</name><value><i4>-503</i4></value></member>
    <member><name>faultString</name><value><string>Wrong object type.</string></value></member>
  </struct></value></fault></methodResponse>`
	_, err := DecodeResponse([]byte(xml))
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != -503 || fault.Message != "Wrong object type." {
		t.Fatalf("got %#v", err)
	}
	if err.Error() != "rtorrent fault -503: Wrong object type." {
		t.Fatalf("message %q", err)
	}
}

func TestAResponseWithNoParamIsAnErrorNotEmptyData(t *testing.T) {
	_, err := DecodeResponse([]byte("<html>not xml-rpc</html>"))
	var httpErr *httperr.Error
	if !errors.As(err, &httpErr) || httpErr.Status != 502 || !strings.Contains(err.Error(), "malformed") {
		t.Fatalf("got %#v", err)
	}
}

func TestIsFaultStructTellsMulticallFaultsFromResults(t *testing.T) {
	for _, c := range []struct {
		value any
		want  bool
	}{
		{map[string]any{"faultCode": int64(-501), "faultString": "x"}, true},
		{[]any{"ok"}, false},
		{"ok", false},
		{[]byte("x"), false},
	} {
		if got := IsFaultStruct(c.value); got != c.want {
			t.Errorf("%#v: %v", c.value, got)
		}
	}
}

func TestStructKeysAndNamedEntitiesAreInertData(t *testing.T) {
	result, ok := roundTrip(t, map[string]any{"__proto__": map[string]any{"faultCode": 99}, "constructor": "x"}).(map[string]any)
	if !ok {
		t.Fatal("not a struct")
	}
	if _, has := result["__proto__"]; !has {
		t.Fatal("the __proto__ key was lost")
	}
	if IsFaultStruct(result) {
		t.Fatal("a nested faultCode made the struct a fault")
	}
	if got := decode(t, respond("<string>&constructor;&toString;</string>")); got != "&constructor;&toString;" {
		t.Fatalf("got %q", got)
	}
}

func TestBadCharacterReferencesStayText(t *testing.T) {
	if got := decode(t, respond("<string>&#X1F600;&#99999999;&#xD800;</string>")); got != "😀&#99999999;&#xD800;" {
		t.Fatalf("got %q", got)
	}
}

func TestBrokenResponsesFailInsteadOfBecomingData(t *testing.T) {
	truncated := respond("<string>x</string>")
	for _, c := range []struct {
		xml  string
		want string
	}{
		{string(truncated[:len(truncated)-10]), "malformed"},
		{string(respond("<string>x</i4>")), "malformed"},
		{"<methodResponse><params><param/></params></methodResponse>", "expected <value>"},
		{strings.Repeat("<value>", 200) + strings.Repeat("</value>", 200), "nesting too deep"},
	} {
		if _, err := DecodeResponse([]byte(c.xml)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%.40q: %v, want %q", c.xml, err, c.want)
		}
	}
	for _, value := range []any{math.Inf(1), math.NaN()} {
		if _, err := EncodeCall("x", []any{value}); err == nil || !strings.Contains(err.Error(), "finite") {
			t.Errorf("%v: %v", value, err)
		}
	}
}

func TestAProcessingInstructionEndsAtItsQuestionMark(t *testing.T) {
	// The CDATA keeps the fast path out, so this is the permissive parser's
	// reading: the quoted document inside the declaration is not the answer.
	xml := `<?xml version="1.0" x="<methodResponse><params><param><value>evil</value></param></params></methodResponse>"?>` +
		`<methodResponse><params><param><value><![CDATA[good]]></value></param></params></methodResponse>`
	if got, err := DecodeResponse([]byte(xml)); err != nil || got != "good" {
		t.Fatalf("got %#v, %v", got, err)
	}
}

func TestInvalidTypedValuesDoNotBecomeZeroOrFalse(t *testing.T) {
	for _, value := range []string{"<i4>1.5</i4>", "<i8>bad</i8>", "<double>Infinity</double>", "<double></double>", "<boolean>yes</boolean>"} {
		xml := "<methodResponse><params><param><value>" + value + "</value></param></params></methodResponse>"
		if _, err := DecodeResponse([]byte(xml)); err == nil || !strings.Contains(err.Error(), "invalid XML-RPC") {
			t.Errorf("%s: %v", value, err)
		}
	}
}

/* ------------------------------ Go-specific ----------------------------- */

func TestTypedValuesDecodeToTheirGoTypes(t *testing.T) {
	for _, c := range []struct {
		xml  string
		want any
	}{
		{"<i8>-9223372036854775808</i8>", int64(math.MinInt64)},
		{"<ex.i8>12</ex.i8>", int64(12)},
		{"<int> +5 </int>", int64(5)},
		// Past int64, a number all the same.
		{"<i8>99999999999999999999</i8>", 1e20},
		{"<double>-1.5e3</double>", -1500.0},
		{"<double>.5</double>", 0.5},
		{"<nil/>", ""},
		{"<dateTime.iso8601>20260927T10:00:00</dateTime.iso8601>", "20260927T10:00:00"},
		{"<base64>cmF3\nIGJ5dGVz</base64>", []byte("raw bytes")},
		{"<base64>_-8</base64>", []byte{0xff, 0xef}},
		{"<array><data></data></array>", []any{}},
		{"<struct></struct>", map[string]any{}},
	} {
		if got := decode(t, respond(c.xml)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %#v, want %#v", c.xml, got, c.want)
		}
	}
}

func TestIllFormedUTF8ReadsAsReplacementCharacters(t *testing.T) {
	if got := decode(t, respond("<string>ab\xffcd</string>")); got != "ab\uFFFDcd" {
		t.Fatalf("got %q", got)
	}
}

func TestEncodingOtherGoTypes(t *testing.T) {
	call, err := EncodeCall("m", []any{[]string{"a", "b"}, map[string]any{"b": 1, "a": nil}, int32(-3), uint32(4)})
	if err != nil {
		t.Fatal(err)
	}
	want := "<param><value><array><data><value><string>a</string></value><value><string>b</string></value></data></array></value></param>" +
		"<param><value><struct><member><name>a</name><value><string></string></value></member>" +
		"<member><name>b</name><value><i4>1</i4></value></member></struct></value></param>" +
		"<param><value><i4>-3</i4></value></param><param><value><i4>4</i4></value></param>"
	if !strings.Contains(string(call), want) {
		t.Fatalf("%s", call)
	}
	if _, err := EncodeCall("m", []any{struct{}{}}); err == nil {
		t.Fatal("a type with no XML-RPC shape was encoded")
	}
}

func TestAJSONNumberIntegerIsSentExactly(t *testing.T) {
	// Past 2^53 a float64 would round the last digits away.
	call, err := EncodeCall("m", []any{json.Number("9007199254740993"), json.Number("7"), json.Number("2.5")})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<i8>9007199254740993</i8>", "<i4>7</i4>", "<double>2.5</double>"} {
		if !strings.Contains(string(call), want) {
			t.Errorf("no %s in %s", want, call)
		}
	}
	if _, err := EncodeCall("m", []any{json.Number("junk")}); err == nil {
		t.Error("a json.Number that is no number was encoded")
	}
}

func TestEncodedResponsesAndFaultsDecode(t *testing.T) {
	body, err := EncodeResponse([]any{"x", int64(1)})
	if err != nil {
		t.Fatal(err)
	}
	if got := decode(t, body); !reflect.DeepEqual(got, []any{"x", int64(1)}) {
		t.Fatalf("got %#v", got)
	}
	_, err = DecodeResponse(EncodeFault(-506, "Method 'x' not defined"))
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != -506 || fault.Message != "Method 'x' not defined" {
		t.Fatalf("got %#v", err)
	}
}

func TestFaultFromToleratesMissingParts(t *testing.T) {
	for _, c := range []struct {
		value any
		want  Fault
	}{
		{map[string]any{}, Fault{-1, "unknown fault"}},
		{map[string]any{"faultCode": "junk", "faultString": int64(7)}, Fault{-1, "7"}},
		{map[string]any{"faultCode": "-503"}, Fault{-503, "unknown fault"}},
		// A code is an i4: one far outside it is no code at all.
		{map[string]any{"faultCode": 1e300, "faultString": "x"}, Fault{-1, "x"}},
		{map[string]any{"faultCode": "-Infinity", "faultString": "x"}, Fault{-1, "x"}},
		{"just text", Fault{-1, "just text"}},
	} {
		if got := FaultFrom(c.value); *got != c.want {
			t.Errorf("%#v: got %#v", c.value, *got)
		}
	}
}

func TestToNumberReadsValuesTheBrowserWay(t *testing.T) {
	for _, c := range []struct {
		in   any
		want float64
	}{
		{"", 0},
		{" 12 ", 12},
		{"\n17\t", 17},
		{"0x10", 16},
		{"0B101", 5},
		{"0o17", 15},
		{"1e3", 1000},
		{".5", 0.5},
		{"5.", 5},
		{"-2.5", -2.5},
		{"Infinity", math.Inf(1)},
		{"-Infinity", math.Inf(-1)},
		{"1e999", math.Inf(1)},
		{true, 1},
		{false, 0},
		{int64(42), 42},
		{int(-3), -3},
		{[]byte("17"), 17},
		{[]any{}, 0},
		{[]any{int64(5)}, 5},
	} {
		if got := ToNumber(c.in); got != c.want {
			t.Errorf("ToNumber(%#v) = %v, want %v", c.in, got, c.want)
		}
	}
	for _, in := range []any{nil, "junk", "inf", "nan", "1_000", "-0x10", "0x", "0xg", ".", "+-1", "1e", "0x1p3", []any{int64(1), int64(2)}, map[string]any{}} {
		if got := ToNumber(in); !math.IsNaN(got) {
			t.Errorf("ToNumber(%#v) = %v, want NaN", in, got)
		}
	}
}

func TestToStringReadsValuesTheBrowserWay(t *testing.T) {
	for _, c := range []struct {
		in   any
		want string
	}{
		{nil, ""},
		{"x", "x"},
		{[]byte("n\xc3\xa4mn"), "nämn"},
		{true, "true"},
		{false, "false"},
		{int64(-9), "-9"},
		{2.5, "2.5"},
		{[]any{int64(1), "a", []any{int64(2), int64(3)}, nil}, "1,a,2,3,"},
		{map[string]any{"a": "b"}, "[object Object]"},
	} {
		if got := ToString(c.in); got != c.want {
			t.Errorf("ToString(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDecodeUTF8ReplacesEachIllFormedSubsequenceOnce(t *testing.T) {
	for _, c := range []struct {
		in   string
		want string
	}{
		{"plain", "plain"},
		{"ab\xffcd", "ab\uFFFDcd"},
		// A truncated four-byte sequence is one error, not three.
		{"\xf0\x9f\x98", "\uFFFD"},
		{"\xf0\x9f\x98x", "\uFFFDx"},
		{"\xe2\x82x", "\uFFFDx"},
		// A surrogate's lead is refused at its second byte; the rest are
		// stray continuations.
		{"\xed\xa0\x80", "\uFFFD\uFFFD\uFFFD"},
		{"\xc0\xaf", "\uFFFD\uFFFD"},
		{"\xf0\x9f\x98\x80", "😀"},
	} {
		if got := DecodeUTF8([]byte(c.in)); got != c.want {
			t.Errorf("DecodeUTF8(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
