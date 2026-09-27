package xmlrpc

import (
	"errors"
	"strconv"
	"strings"
)

// The fast path. rtorrent's answers are plain, well-formed XML-RPC — no
// comments, no CDATA, no attributes — and the listing multicall alone is
// half a megabyte of them several times a second. Tokenizing all of that
// before parsing it cost more than rtorrent spent producing it, so this reads
// the plain shape in a single pass instead. Anything it does not recognise it
// declines, and the permissive parser reads the document from the start:
// what a response decodes to never depends on which of the two read it.

var errDecline = errors.New("xmlrpc: not the plain shape")

// The deepest nesting the fast path follows before leaving the document to
// the permissive parser and its own limit.
const fastDepth = 25

type scanner struct {
	s     string
	i     int
	depth int
}

// decodeFast decodes a well-formed response, or returns errDecline.
func decodeFast(xml string) (any, error) {
	p := &scanner{s: strings.TrimPrefix(xml, "\uFEFF")}
	p.skipSpace()
	if strings.HasPrefix(p.rest(), "<?xml") {
		end := strings.Index(p.rest(), "?>")
		if end < 0 {
			return nil, errDecline
		}
		p.i += end + 2
		p.skipSpace()
	}
	if !p.lit("<methodResponse>") {
		return nil, errDecline
	}
	p.skipSpace()
	fault := p.lit("<fault>")
	if !fault && !(p.lit("<params>") && p.space() && p.lit("<param>")) {
		return nil, errDecline
	}
	p.skipSpace()
	value, err := p.value()
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if fault {
		if !p.lit("</fault>") {
			return nil, errDecline
		}
	} else if !(p.lit("</param>") && p.space() && p.lit("</params>")) {
		return nil, errDecline
	}
	p.skipSpace()
	if !p.lit("</methodResponse>") {
		return nil, errDecline
	}
	p.skipSpace()
	if p.i != len(p.s) {
		return nil, errDecline
	}
	if fault {
		return nil, FaultFrom(value)
	}
	return value, nil
}

func (p *scanner) rest() string { return p.s[p.i:] }

// lit consumes text that must come next.
func (p *scanner) lit(text string) bool {
	if strings.HasPrefix(p.s[p.i:], text) {
		p.i += len(text)
		return true
	}
	return false
}

// skipSpace skips the whitespace between tags. Anything more exotic than
// these four is left for the permissive parser.
func (p *scanner) skipSpace() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\r', '\n':
			p.i++
		default:
			return
		}
	}
}

// space is skipSpace for use inside a condition.
func (p *scanner) space() bool {
	p.skipSpace()
	return true
}

// textUntil reads the text up to the closing tag of name. Markup inside —
// a comment, CDATA, a child element — is not the plain shape.
func (p *scanner) textUntil(name string) (string, bool) {
	lt := strings.IndexByte(p.s[p.i:], '<')
	if lt < 0 {
		return "", false
	}
	text := p.s[p.i : p.i+lt]
	p.i += lt
	if !p.lit("</") || !p.lit(name) || !p.lit(">") {
		return "", false
	}
	return text, true
}

// trimmed is a number's or a boolean's text. The permissive parser also
// trims Unicode space and decodes entities first; text that needs either
// fails the strict checks below and is declined.
func trimmed(text string) string {
	return strings.Trim(text, " \t\r\n")
}

func (p *scanner) value() (any, error) {
	if p.lit("<value/>") {
		return "", nil
	}
	if !p.lit("<value>") {
		return nil, errDecline
	}
	lt := strings.IndexByte(p.s[p.i:], '<')
	if lt < 0 {
		return nil, errDecline
	}
	text := p.s[p.i : p.i+lt]
	p.i += lt
	if p.lit("</value>") {
		return decodeEntities(text), nil // an untyped value is a string
	}
	if strings.Trim(text, " \t\r\n") != "" {
		return nil, errDecline
	}
	value, err := p.typed()
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if !p.lit("</value>") {
		return nil, errDecline
	}
	return value, nil
}

func (p *scanner) typed() (any, error) {
	if p.i >= len(p.s) || p.s[p.i] != '<' {
		return nil, errDecline
	}
	gt := strings.IndexByte(p.s[p.i:], '>')
	if gt < 0 {
		return nil, errDecline
	}
	tag := p.s[p.i+1 : p.i+gt]
	empty := strings.HasSuffix(tag, "/")
	tag = strings.TrimSuffix(tag, "/")
	if tag == "" || strings.ContainsAny(tag, " \t\r\n/<>?!=\"'") {
		return nil, errDecline
	}
	p.i += gt + 1

	switch tag {
	case "string":
		if empty {
			return "", nil
		}
		if text, ok := p.textUntil(tag); ok {
			return decodeEntities(text), nil
		}
	case "i4", "i8", "int", "ex.i8":
		// In base 10 ParseInt takes exactly what integerText describes, and
		// past int64, where the permissive parser falls back to a double, it
		// fails and the document is declined.
		text, ok := p.textUntil(tag)
		if value, err := strconv.ParseInt(trimmed(text), 10, 64); ok && !empty && err == nil {
			return value, nil
		}
	case "double":
		text, ok := p.textUntil(tag)
		if text := trimmed(text); ok && !empty && doubleText.MatchString(text) {
			if value, err := strconv.ParseFloat(text, 64); err == nil {
				return value, nil
			}
		}
	case "boolean":
		text, ok := p.textUntil(tag)
		if text := trimmed(text); ok && !empty && (text == "0" || text == "1") {
			return text == "1", nil
		}
	case "base64":
		if empty {
			return decodeBase64(""), nil
		}
		if text, ok := p.textUntil(tag); ok {
			return decodeBase64(decodeEntities(text)), nil
		}
	case "nil":
		if empty {
			return "", nil
		}
	case "array":
		if empty {
			break
		}
		if p.depth++; p.depth > fastDepth {
			return nil, errDecline
		}
		items := []any{}
		p.skipSpace()
		if !p.lit("<data/>") {
			if !p.lit("<data>") {
				return nil, errDecline
			}
			for p.skipSpace(); !p.lit("</data>"); p.skipSpace() {
				item, err := p.value()
				if err != nil {
					return nil, err
				}
				items = append(items, item)
			}
		}
		p.skipSpace()
		if p.lit("</array>") {
			p.depth--
			return items, nil
		}
	case "struct":
		record := map[string]any{}
		if empty {
			return record, nil
		}
		if p.depth++; p.depth > fastDepth {
			return nil, errDecline
		}
		for p.skipSpace(); !p.lit("</struct>"); p.skipSpace() {
			if !p.lit("<member>") || !p.space() || !p.lit("<name>") {
				return nil, errDecline
			}
			name, ok := p.textUntil("name")
			if !ok {
				return nil, errDecline
			}
			p.skipSpace()
			value, err := p.value()
			if err != nil {
				return nil, err
			}
			p.skipSpace()
			if !p.lit("</member>") {
				return nil, errDecline
			}
			record[decodeEntities(name)] = value
		}
		p.depth--
		return record, nil
	}
	return nil, errDecline
}
