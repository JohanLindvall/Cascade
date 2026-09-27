// Package xmlrpc is a minimal, dependency-free XML-RPC codec.
//
// rtorrent speaks XML-RPC over SCGI. Its dialect adds <i8> and returns 8-bit
// strings, so the parser is permissive: unknown or absent type tags decode as
// strings, and faults decode into *Fault.
//
// Decoded values are nil-free and take these Go types: string (also for an
// untyped value, an unknown type and <nil/>, which reads as ""), int64 (i4,
// int, i8, ex.i8), float64 (double, and an integer too large for int64),
// bool, []byte (base64), []any (array) and map[string]any (struct).
package xmlrpc

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

// Fault is an XML-RPC fault: rtorrent refusing a command, with its code and
// its own message.
type Fault struct {
	Code    int
	Message string
}

func (f *Fault) Error() string {
	return fmt.Sprintf("rtorrent fault %d: %s", f.Code, f.Message)
}

/* ------------------------------ encoding ------------------------------- */

var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

// XML 1.0 cannot carry these at all, so they are dropped rather than escaped.
var controlChars = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f]")

func escapeXML(value string) string {
	return controlChars.ReplaceAllString(xmlEscaper.Replace(strings.ToValidUTF8(value, "\uFFFD")), "")
}

func encodeValue(out *bytes.Buffer, value any) error {
	out.WriteString("<value>")
	switch v := value.(type) {
	case nil:
		out.WriteString("<string></string>")
	case []byte:
		out.WriteString("<base64>")
		out.WriteString(base64.StdEncoding.EncodeToString(v))
		out.WriteString("</base64>")
	case []any:
		out.WriteString("<array><data>")
		for _, item := range v {
			if err := encodeValue(out, item); err != nil {
				return err
			}
		}
		out.WriteString("</data></array>")
	case []string:
		out.WriteString("<array><data>")
		for _, item := range v {
			_ = encodeValue(out, item)
		}
		out.WriteString("</data></array>")
	case string:
		out.WriteString("<string>")
		out.WriteString(escapeXML(v))
		out.WriteString("</string>")
	case bool:
		out.WriteString("<boolean>")
		if v {
			out.WriteString("1")
		} else {
			out.WriteString("0")
		}
		out.WriteString("</boolean>")
	case int:
		encodeInt(out, int64(v))
	case int32:
		encodeInt(out, int64(v))
	case int64:
		encodeInt(out, v)
	case uint32:
		encodeInt(out, int64(v))
	case float32:
		if err := encodeFloat(out, float64(v)); err != nil {
			return err
		}
	case float64:
		if err := encodeFloat(out, v); err != nil {
			return err
		}
	case json.Number:
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil {
			return fmt.Errorf("xmlrpc: cannot encode the number %q", string(v))
		}
		if err := encodeFloat(out, f); err != nil {
			return err
		}
	case map[string]any:
		out.WriteString("<struct>")
		// A map has no order of its own; sorting keeps the request stable.
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			out.WriteString("<member><name>")
			out.WriteString(escapeXML(key))
			out.WriteString("</name>")
			if err := encodeValue(out, v[key]); err != nil {
				return err
			}
			out.WriteString("</member>")
		}
		out.WriteString("</struct>")
	default:
		return fmt.Errorf("xmlrpc: cannot encode a %T", value)
	}
	out.WriteString("</value>")
	return nil
}

func encodeInt(out *bytes.Buffer, v int64) {
	if v <= math.MaxInt32 && v >= math.MinInt32 {
		out.WriteString("<i4>")
		out.WriteString(strconv.FormatInt(v, 10))
		out.WriteString("</i4>")
		return
	}
	out.WriteString("<i8>")
	out.WriteString(strconv.FormatInt(v, 10))
	out.WriteString("</i8>")
}

// encodeFloat writes a number the way the browser-side model of it, a single
// number type, calls for: a whole value is an integer on the wire (JSON hands
// every parameter over as a float64), anything else a double.
func encodeFloat(out *bytes.Buffer, v float64) error {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return errors.New("XML-RPC numbers must be finite")
	}
	if v == math.Trunc(v) {
		if v <= math.MaxInt32 && v >= math.MinInt32 {
			out.WriteString("<i4>")
			out.WriteString(FormatNumber(v))
			out.WriteString("</i4>")
		} else {
			out.WriteString("<i8>")
			out.WriteString(FormatNumber(v))
			out.WriteString("</i8>")
		}
		return nil
	}
	out.WriteString("<double>")
	out.WriteString(FormatNumber(v))
	out.WriteString("</double>")
	return nil
}

// EncodeCall serializes a methodCall. It fails only for a value XML-RPC
// cannot carry: a non-finite number, or a Go type with no XML-RPC shape.
func EncodeCall(method string, params []any) ([]byte, error) {
	var out bytes.Buffer
	out.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	out.WriteString("<methodCall><methodName>")
	out.WriteString(escapeXML(method))
	out.WriteString("</methodName><params>")
	for _, param := range params {
		out.WriteString("<param>")
		if err := encodeValue(&out, param); err != nil {
			return nil, err
		}
		out.WriteString("</param>")
	}
	out.WriteString("</params></methodCall>")
	return out.Bytes(), nil
}

// EncodeResponse serializes a methodResponse carrying value, the way rtorrent
// answers; test doubles and fakes stand in for it with this.
func EncodeResponse(value any) ([]byte, error) {
	var out bytes.Buffer
	out.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	out.WriteString("<methodResponse><params><param>")
	if err := encodeValue(&out, value); err != nil {
		return nil, err
	}
	out.WriteString("</param></params></methodResponse>")
	return out.Bytes(), nil
}

// EncodeFault serializes a fault methodResponse.
func EncodeFault(code int, message string) []byte {
	var out bytes.Buffer
	out.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	out.WriteString("<methodResponse><fault>")
	_ = encodeValue(&out, map[string]any{"faultCode": int64(code), "faultString": message})
	out.WriteString("</fault></methodResponse>")
	return out.Bytes()
}

/* ------------------------------- parsing ------------------------------- */

var namedEntities = map[string]string{
	"amp":  "&",
	"lt":   "<",
	"gt":   ">",
	"quot": `"`,
	"apos": "'",
}

var entity = regexp.MustCompile(`&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z]+);`)

// decodeEntities resolves the five named entities and character references.
// A reference to no character (a surrogate, past U+10FFFF) and any other name
// stay as they were written.
func decodeEntities(text string) string {
	if !strings.Contains(text, "&") {
		return text
	}
	return entity.ReplaceAllStringFunc(text, func(match string) string {
		body := match[1 : len(match)-1]
		if body[0] == '#' {
			var code uint64
			var err error
			if body[1] == 'x' || body[1] == 'X' {
				code, err = strconv.ParseUint(body[2:], 16, 32)
			} else {
				code, err = strconv.ParseUint(body[1:], 10, 32)
			}
			if err != nil || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) {
				return match
			}
			return string(rune(code))
		}
		if named, ok := namedEntities[body]; ok {
			return named
		}
		return match
	})
}

type tokenKind int

const (
	openTag tokenKind = iota
	closeTag
	textToken
)

type token struct {
	kind tokenKind
	// The tag name, or the text itself.
	name string
}

func isSpace(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' }

func tokenize(xml string) ([]token, error) {
	var tokens []token
	length := len(xml)
	i := 0
	for i < length {
		lt := strings.IndexByte(xml[i:], '<')
		if lt < 0 {
			tokens = append(tokens, token{textToken, xml[i:]})
			break
		}
		lt += i
		if lt > i {
			tokens = append(tokens, token{textToken, xml[i:lt]})
		}
		rest := xml[lt:]
		switch {
		case strings.HasPrefix(rest, "<!--"):
			i = skipPast(xml, lt, "-->")
			continue
		case strings.HasPrefix(rest, "<![CDATA["):
			end := strings.Index(rest, "]]>")
			stop := length
			if end >= 0 {
				stop = lt + end
			}
			// Escaped so the entity decoding every text goes through
			// cannot read CDATA content as markup.
			tokens = append(tokens, token{textToken, strings.ReplaceAll(xml[lt+9:stop], "&", "&amp;")})
			i = skipPast(xml, lt, "]]>")
			continue
		case strings.HasPrefix(rest, "<?"), strings.HasPrefix(rest, "<!"):
			i = skipPast(xml, lt, ">")
			continue
		}
		gt := strings.IndexByte(rest, '>')
		if gt < 0 {
			break
		}
		tag := strings.TrimFunc(rest[1:gt], isSpace)
		closing, selfClosing := false, false
		if strings.HasPrefix(tag, "/") {
			closing = true
			tag = strings.TrimFunc(tag[1:], isSpace)
		}
		if strings.HasSuffix(tag, "/") {
			selfClosing = true
			tag = strings.TrimFunc(tag[:len(tag)-1], isSpace)
		}
		if space := strings.IndexFunc(tag, isSpace); space >= 0 {
			tag = tag[:space]
		}
		if closing {
			tokens = append(tokens, token{closeTag, tag})
		} else {
			tokens = append(tokens, token{openTag, tag})
			if selfClosing {
				tokens = append(tokens, token{closeTag, tag})
			}
		}
		i = lt + gt + 1
	}
	var stack []string
	for _, t := range tokens {
		switch t.kind {
		case openTag:
			stack = append(stack, t.name)
			if len(stack) > 100 {
				return nil, errors.New("malformed XML-RPC response: nesting too deep")
			}
		case closeTag:
			if len(stack) == 0 || stack[len(stack)-1] != t.name {
				return nil, errors.New("malformed XML-RPC response: mismatched closing tag")
			}
			stack = stack[:len(stack)-1]
		}
	}
	if len(stack) > 0 {
		return nil, errors.New("malformed XML-RPC response: truncated document")
	}
	return tokens, nil
}

// skipPast returns the index just after the first end found at or after from,
// or the end of the document when there is none.
func skipPast(xml string, from int, end string) int {
	at := strings.Index(xml[from:], end)
	if at < 0 {
		return len(xml)
	}
	return from + at + len(end)
}

type parser struct {
	tokens []token
	index  int
}

// seekOpen advances to just past the next opening tag called name, unless an
// opening stopAt tag comes first.
func (p *parser) seekOpen(name, stopAt string) bool {
	for p.index < len(p.tokens) {
		t := p.tokens[p.index]
		if t.kind == openTag && t.name == name {
			p.index++
			return true
		}
		if stopAt != "" && t.kind == openTag && t.name == stopAt {
			return false
		}
		p.index++
	}
	return false
}

func (p *parser) atOpen(name string) bool {
	p.skipBlankText()
	return p.index < len(p.tokens) && p.tokens[p.index].kind == openTag && p.tokens[p.index].name == name
}

func (p *parser) atClose(name string) bool {
	p.skipBlankText()
	return p.index < len(p.tokens) && p.tokens[p.index].kind == closeTag && p.tokens[p.index].name == name
}

func (p *parser) skipBlankText() {
	for p.index < len(p.tokens) {
		t := p.tokens[p.index]
		if t.kind != textToken || strings.TrimFunc(t.name, isSpace) != "" {
			return
		}
		p.index++
	}
}

func (p *parser) readTextUntilClose(name string) string {
	var text strings.Builder
	for p.index < len(p.tokens) {
		t := p.tokens[p.index]
		p.index++
		if t.kind == closeTag && t.name == name {
			break
		}
		if t.kind == textToken {
			text.WriteString(t.name)
		}
	}
	return decodeEntities(text.String())
}

func (p *parser) consumeClose(name string) {
	for p.index < len(p.tokens) {
		t := p.tokens[p.index]
		p.index++
		if t.kind == closeTag && t.name == name {
			return
		}
	}
}

// parseValue parses a <value>…</value>; the cursor must sit on the opening tag.
func (p *parser) parseValue() (any, error) {
	p.skipBlankText()
	if p.index >= len(p.tokens) || p.tokens[p.index].kind != openTag || p.tokens[p.index].name != "value" {
		return nil, errors.New("malformed XML-RPC response: expected <value>")
	}
	p.index++

	var raw strings.Builder
	for p.index < len(p.tokens) {
		t := p.tokens[p.index]
		switch {
		case t.kind == textToken:
			raw.WriteString(t.name)
			p.index++
			continue
		case t.kind == closeTag && t.name == "value":
			p.index++
			return decodeEntities(raw.String()), nil
		case t.kind == closeTag:
			// Malformed; bail out without consuming so the caller can resync.
			return decodeEntities(raw.String()), nil
		}
		value, err := p.parseTyped(t.name)
		if err != nil {
			return nil, err
		}
		p.consumeClose("value")
		return value, nil
	}
	return decodeEntities(raw.String()), nil
}

var (
	integerText = regexp.MustCompile(`^[+-]?\d+$`)
	doubleText  = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$`)
)

func (p *parser) parseTyped(kind string) (any, error) {
	p.index++ // the opening type tag
	switch kind {
	case "array":
		items := []any{}
		p.seekOpen("data", "value")
		for !p.atClose("data") && p.index < len(p.tokens) {
			if !p.atOpen("value") {
				break
			}
			item, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		p.consumeClose("array")
		return items, nil
	case "struct":
		result := map[string]any{}
		for p.index < len(p.tokens) {
			p.skipBlankText()
			if p.atClose("struct") {
				p.index++
				break
			}
			if !p.atOpen("member") {
				p.index++
				continue
			}
			p.index++ // <member>
			key := ""
			if p.atOpen("name") {
				p.index++
				key = p.readTextUntilClose("name")
			}
			value, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			result[key] = value
			p.consumeClose("member")
		}
		return result, nil
	case "base64":
		return decodeBase64(p.readTextUntilClose(kind)), nil
	case "boolean":
		text := strings.TrimFunc(p.readTextUntilClose(kind), isSpace)
		if text != "0" && text != "1" {
			return nil, errors.New("invalid XML-RPC boolean")
		}
		return text == "1", nil
	case "int", "i4", "i8", "ex.i8":
		text := strings.TrimFunc(p.readTextUntilClose(kind), isSpace)
		if !integerText.MatchString(text) {
			return nil, errors.New("invalid XML-RPC integer")
		}
		if value, err := strconv.ParseInt(text, 10, 64); err == nil {
			return value, nil
		}
		// Past int64, but still a number: kept as the nearest double, as a
		// reader with a single number type would.
		value, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsInf(value, 0) {
			return nil, errors.New("invalid XML-RPC integer")
		}
		return value, nil
	case "double":
		text := strings.TrimFunc(p.readTextUntilClose(kind), isSpace)
		value, err := strconv.ParseFloat(text, 64)
		if !doubleText.MatchString(text) || err != nil || math.IsInf(value, 0) {
			return nil, errors.New("invalid XML-RPC double")
		}
		return value, nil
	case "nil":
		p.consumeClose(kind)
		return "", nil
	default:
		return p.readTextUntilClose(kind), nil
	}
}

func (p *parser) seekFault() bool {
	for i, t := range p.tokens {
		if t.kind == openTag && t.name == "fault" {
			p.index = i + 1
			return true
		}
	}
	return false
}

// DecodeResponse decodes a <methodResponse>. A fault comes back as a *Fault
// error; a response that is not XML-RPC as a 502 naming what is wrong with it.
func DecodeResponse(xml []byte) (any, error) {
	var value any
	err := errDecline
	if utf8.Valid(xml) {
		value, err = decodeFast(string(xml))
	}
	if errors.Is(err, errDecline) {
		value, err = readResponse(DecodeUTF8(xml))
	}
	if err != nil {
		var fault *Fault
		if errors.As(err, &fault) {
			return nil, fault
		}
		return nil, httperr.Backend(err.Error())
	}
	return value, nil
}

func readResponse(xml string) (any, error) {
	tokens, err := tokenize(xml)
	if err != nil {
		return nil, err
	}
	p := &parser{tokens: tokens}
	if p.seekFault() {
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		return nil, FaultFrom(value)
	}
	p.index = 0
	if !p.seekOpen("param", "") {
		return nil, errors.New("malformed XML-RPC response: no <param> found")
	}
	return p.parseValue()
}

// FaultFrom reads a fault struct, tolerating one that is missing its parts.
func FaultFrom(value any) *Fault {
	if record, ok := value.(map[string]any); ok {
		code := -1.0
		if raw, ok := record["faultCode"]; ok {
			code = ToNumber(raw)
		}
		message := "unknown fault"
		if raw, ok := record["faultString"]; ok {
			message = ToString(raw)
		}
		if math.IsNaN(code) || math.IsInf(code, 0) {
			code = -1
		}
		return &Fault{Code: int(code), Message: message}
	}
	return &Fault{Code: -1, Message: ToString(value)}
}

// IsFaultStruct tells a system.multicall element that carries a fault struct
// from one that carries a result array.
func IsFaultStruct(value any) bool {
	record, ok := value.(map[string]any)
	if !ok {
		return false
	}
	_, has := record["faultCode"]
	return has
}

// decodeBase64 is as forgiving as the reader the wire format was first
// written against: characters outside the alphabet (line breaks, spaces) are
// skipped, the URL-safe alphabet is accepted, decoding stops at padding, and
// a trailing partial group yields the whole bytes it holds.
func decodeBase64(text string) []byte {
	out := make([]byte, 0, len(text)*3/4)
	var group uint32
	n := 0
	for i := 0; i < len(text); i++ {
		c := text[i]
		var v byte
		switch {
		case c >= 'A' && c <= 'Z':
			v = c - 'A'
		case c >= 'a' && c <= 'z':
			v = c - 'a' + 26
		case c >= '0' && c <= '9':
			v = c - '0' + 52
		case c == '+' || c == '-':
			v = 62
		case c == '/' || c == '_':
			v = 63
		case c == '=':
			i = len(text)
			continue
		default:
			continue
		}
		group = group<<6 | uint32(v)
		n++
		if n == 4 {
			out = append(out, byte(group>>16), byte(group>>8), byte(group))
			group, n = 0, 0
		}
	}
	switch n {
	case 2:
		out = append(out, byte(group>>4))
	case 3:
		out = append(out, byte(group>>10), byte(group>>2))
	}
	return out
}

/* ------------------- how the values read as text and numbers ------------------ */

// These define how a decoded value reads as a number or as text, pinned to the
// conversions the original TypeScript server used (Number(v) and String(v)),
// so every reader of rtorrent's answers agrees on them — a junk string is not
// a number, a boolean is 1 or 0, a double prints its shortest form.

// FormatNumber writes f as JavaScript's String(f) does: the shortest digits
// that read back as f, in plain notation from 1e-6 up to 1e21 and in
// exponent notation ("1e+21", "1.5e-7") beyond.
func FormatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	mantissa, exponent, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits)
	e, _ := strconv.Atoi(exponent)
	n := e + 1 // f = 0.digits × 10^n
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	exp := strconv.Itoa(abs(n - 1))
	if k == 1 {
		return sign + digits + "e" + expSign + exp
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + exp
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ToString reads a decoded value as text, as String(v) does: bytes as UTF-8,
// numbers in their shortest form, booleans as "true"/"false", an array as its
// items joined by commas and a struct as "[object Object]". nil — the absent
// value — reads as "".
func ToString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case []byte:
		return DecodeUTF8(v)
	case bool:
		if v {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(v)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case int64:
		return strconv.FormatInt(v, 10)
	case uint32:
		return strconv.FormatUint(uint64(v), 10)
	case float32:
		return FormatNumber(float64(v))
	case float64:
		return FormatNumber(v)
	case json.Number:
		return FormatNumber(ToNumber(v))
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = ToString(item)
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(v, ",")
	default:
		return "[object Object]"
	}
}

// ToNumber reads a decoded value as a number, as Number(v) does: NaN for
// anything that is not one (nil included), 1 or 0 for a boolean, and a string
// by the rules for a numeric literal — surrounding whitespace allowed, "" is
// 0, 0x/0o/0b prefixes and "Infinity" understood, anything else NaN.
func ToNumber(value any) float64 {
	switch v := value.(type) {
	case bool:
		if v {
			return 1
		}
		return 0
	case int:
		return float64(v)
	case int32:
		return float64(v)
	case int64:
		return float64(v)
	case uint32:
		return float64(v)
	case float32:
		return float64(v)
	case float64:
		return v
	case string:
		return stringToNumber(v)
	case json.Number:
		return stringToNumber(string(v))
	case []byte:
		return stringToNumber(DecodeUTF8(v))
	case []any, []string:
		return stringToNumber(ToString(v))
	default:
		return math.NaN()
	}
}

var decimalLiteral = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)

func isNumberSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\uFEFF', '\u2028', '\u2029':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

func stringToNumber(text string) float64 {
	text = strings.TrimFunc(text, isNumberSpace)
	switch text {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(text) > 2 && text[0] == '0' {
		base := 0
		switch text[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			value := 0.0
			for _, c := range text[2:] {
				digit := strings.IndexRune("0123456789abcdef", unicode.ToLower(c))
				if digit < 0 || digit >= base {
					return math.NaN()
				}
				value = value*float64(base) + float64(digit)
			}
			return value
		}
	}
	if !decimalLiteral.MatchString(text) {
		return math.NaN()
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return value
}

// DecodeUTF8 reads bytes as UTF-8 the way a browser (and Node's
// Buffer.toString) does: each maximal ill-formed subsequence becomes one
// U+FFFD, so what a stray byte turns into does not depend on the reader.
func DecodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	out.Grow(len(b) + 8)
	needed, seen := 0, 0
	var code rune
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if needed == 0 {
			i++
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, code = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				needed, code = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				needed, code = 3, rune(c&0x07)
			default:
				out.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// Not a continuation here: the sequence so far is one error, and
			// this byte starts over as whatever it is.
			code, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out.WriteRune(utf8.RuneError)
			continue
		}
		lower, upper = 0x80, 0xBF
		code = code<<6 | rune(c&0x3F)
		seen++
		i++
		if seen == needed {
			out.WriteRune(code)
			code, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out.WriteRune(utf8.RuneError)
	}
	return out.String()
}
