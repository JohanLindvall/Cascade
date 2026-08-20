/**
 * Minimal, dependency-free XML-RPC codec.
 *
 * rtorrent speaks XML-RPC over SCGI. Its dialect adds <i8> and returns 8-bit
 * strings, so we keep the parser permissive: unknown/absent type tags decode as
 * strings, faults decode into XmlRpcFault.
 */

export type XValue =
  | string
  | number
  | boolean
  | Buffer
  | XValue[]
  | { [key: string]: XValue };

export class XmlRpcFault extends Error {
  constructor(readonly faultCode: number, readonly faultString: string) {
    super(`rtorrent fault ${faultCode}: ${faultString}`);
    this.name = 'XmlRpcFault';
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeXml(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[&<>"]/g, (c) => ESCAPES[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

function serializeValue(value: XValue, out: string[]): void {
  out.push('<value>');
  if (value === null || value === undefined) {
    out.push('<string></string>');
  } else if (Buffer.isBuffer(value)) {
    out.push('<base64>', value.toString('base64'), '</base64>');
  } else if (Array.isArray(value)) {
    out.push('<array><data>');
    for (const item of value) serializeValue(item, out);
    out.push('</data></array>');
  } else if (typeof value === 'string') {
    out.push('<string>', escapeXml(value), '</string>');
  } else if (typeof value === 'boolean') {
    out.push('<boolean>', value ? '1' : '0', '</boolean>');
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (value <= INT32_MAX && value >= INT32_MIN) out.push('<i4>', String(value), '</i4>');
      else out.push('<i8>', String(value), '</i8>');
    } else {
      out.push('<double>', String(value), '</double>');
    }
  } else {
    out.push('<struct>');
    for (const [key, member] of Object.entries(value)) {
      out.push('<member><name>', escapeXml(key), '</name>');
      serializeValue(member as XValue, out);
      out.push('</member>');
    }
    out.push('</struct>');
  }
  out.push('</value>');
}

export function serializeCall(method: string, params: XValue[]): Buffer {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<methodCall><methodName>',
    escapeXml(method),
    '</methodName><params>',
  ];
  for (const param of params) {
    out.push('<param>');
    serializeValue(param, out);
    out.push('</param>');
  }
  out.push('</params></methodCall>');
  return Buffer.from(out.join(''), 'utf8');
}

/* ------------------------------- parsing -------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

const enum Kind {
  Open = 0,
  Close = 1,
  Text = 2,
}

interface Token {
  kind: Kind;
  name: string;
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      tokens.push({ kind: Kind.Text, name: xml.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: Kind.Text, name: xml.slice(i, lt) });
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      const stop = end < 0 ? len : end;
      tokens.push({ kind: Kind.Text, name: xml.slice(lt + 9, stop).replace(/&/g, '&amp;') });
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end < 0 ? len : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    let tag = xml.slice(lt + 1, gt).trim();
    let closing = false;
    let selfClosing = false;
    if (tag.startsWith('/')) {
      closing = true;
      tag = tag.slice(1).trim();
    }
    if (tag.endsWith('/')) {
      selfClosing = true;
      tag = tag.slice(0, -1).trim();
    }
    const space = tag.search(/\s/);
    if (space >= 0) tag = tag.slice(0, space);
    if (closing) {
      tokens.push({ kind: Kind.Close, name: tag });
    } else {
      tokens.push({ kind: Kind.Open, name: tag });
      if (selfClosing) tokens.push({ kind: Kind.Close, name: tag });
    }
    i = gt + 1;
  }
  return tokens;
}

class ValueParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  /** Advance to the next opening tag with the given name, or return false. */
  seekOpen(name: string, stopAt?: string): boolean {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token.kind === Kind.Open && token.name === name) {
        this.index++;
        return true;
      }
      if (stopAt && token.kind === Kind.Open && token.name === stopAt) return false;
      this.index++;
    }
    return false;
  }

  atOpen(name: string): boolean {
    this.skipBlankText();
    const token = this.tokens[this.index];
    return !!token && token.kind === Kind.Open && token.name === name;
  }

  atClose(name: string): boolean {
    this.skipBlankText();
    const token = this.tokens[this.index];
    return !!token && token.kind === Kind.Close && token.name === name;
  }

  private skipBlankText(): void {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token.kind === Kind.Text && token.name.trim() === '') this.index++;
      else break;
    }
  }

  private readTextUntilClose(name: string): string {
    let text = '';
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token.kind === Kind.Close && token.name === name) {
        this.index++;
        return decodeEntities(text);
      }
      if (token.kind === Kind.Text) text += token.name;
      this.index++;
    }
    return decodeEntities(text);
  }

  private consumeClose(name: string): void {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index++;
      if (token.kind === Kind.Close && token.name === name) return;
    }
  }

  /** Parse a <value>...</value>; the cursor must sit on the opening tag. */
  parseValue(): XValue {
    this.skipBlankText();
    const token = this.tokens[this.index];
    if (!token || token.kind !== Kind.Open || token.name !== 'value') return '';
    this.index++;

    let raw = '';
    while (this.index < this.tokens.length) {
      const next = this.tokens[this.index];
      if (next.kind === Kind.Text) {
        raw += next.name;
        this.index++;
        continue;
      }
      if (next.kind === Kind.Close && next.name === 'value') {
        this.index++;
        return decodeEntities(raw);
      }
      if (next.kind === Kind.Close) {
        // Malformed; bail out without consuming so the caller can resync.
        return decodeEntities(raw);
      }
      const value = this.parseTyped(next.name);
      this.consumeClose('value');
      return value;
    }
    return decodeEntities(raw);
  }

  private parseTyped(type: string): XValue {
    this.index++; // consume the opening type tag
    switch (type) {
      case 'array': {
        const items: XValue[] = [];
        this.seekOpen('data', 'value');
        while (!this.atClose('data') && this.index < this.tokens.length) {
          if (!this.atOpen('value')) break;
          items.push(this.parseValue());
        }
        this.consumeClose('array');
        return items;
      }
      case 'struct': {
        const result: Record<string, XValue> = {};
        while (this.index < this.tokens.length) {
          this.skipBlankText();
          if (this.atClose('struct')) {
            this.index++;
            break;
          }
          if (!this.atOpen('member')) {
            this.index++;
            continue;
          }
          this.index++; // <member>
          let key = '';
          if (this.atOpen('name')) {
            this.index++;
            key = this.readTextUntilClose('name');
          }
          result[key] = this.parseValue();
          this.consumeClose('member');
        }
        return result;
      }
      case 'base64':
        return Buffer.from(this.readTextUntilClose(type), 'base64');
      case 'boolean':
        return this.readTextUntilClose(type).trim() === '1';
      case 'int':
      case 'i4':
      case 'i8':
      case 'ex.i8': {
        const text = this.readTextUntilClose(type).trim();
        const value = Number(text);
        return Number.isFinite(value) ? value : 0;
      }
      case 'double': {
        const value = Number(this.readTextUntilClose(type).trim());
        return Number.isFinite(value) ? value : 0;
      }
      case 'nil':
        this.consumeClose(type);
        return '';
      default:
        return this.readTextUntilClose(type);
    }
  }

  seekFault(): boolean {
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.kind === Kind.Open && token.name === 'fault') {
        this.index = i + 1;
        return true;
      }
    }
    return false;
  }

  reset(): void {
    this.index = 0;
  }
}

/** Decode a <methodResponse>. Throws XmlRpcFault when the response is a fault. */
export function parseResponse(xml: string): XValue {
  const parser = new ValueParser(tokenize(xml));
  if (parser.seekFault()) {
    const fault = parser.parseValue();
    throw faultFrom(fault);
  }
  parser.reset();
  if (!parser.seekOpen('param')) {
    throw new Error('malformed XML-RPC response: no <param> found');
  }
  return parser.parseValue();
}

export function faultFrom(value: XValue): XmlRpcFault {
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    const record = value as Record<string, XValue>;
    const code = Number(record.faultCode ?? -1);
    const message = String(record.faultString ?? 'unknown fault');
    return new XmlRpcFault(Number.isFinite(code) ? code : -1, message);
  }
  return new XmlRpcFault(-1, String(value));
}

/** True when a system.multicall element carries a fault struct rather than a result array. */
export function isFaultStruct(value: XValue): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    'faultCode' in (value as Record<string, XValue>)
  );
}
