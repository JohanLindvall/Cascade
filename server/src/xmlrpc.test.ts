/**
 * The XML-RPC codec is hand-written and everything rides on it: every value
 * the UI shows came through parseResponse, and every command through
 * serializeCall. These pin the wire format against rtorrent's dialect —
 * <i8>, 8-bit strings, fault structs — and the parser's tolerance for the
 * XML noise a real endpoint emits.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  XmlRpcFault,
  isFaultStruct,
  parseResponse,
  serializeCall,
  type XValue,
} from './xmlrpc';

/** Wrap a serialized param payload in a methodResponse, as rtorrent answers. */
function respond(valueXml: string): string {
  return `<?xml version="1.0"?><methodResponse><params><param><value>${valueXml}</value></param></params></methodResponse>`;
}

/** Round-trip helper: serialize as a call param, read it back as a response. */
function roundTrip(value: XValue): XValue {
  const call = serializeCall('echo', [value]).toString('utf8');
  const body = /<params><param>(.*)<\/param><\/params>/s.exec(call);
  assert.ok(body, 'no param in serialized call');
  return parseResponse(
    `<?xml version="1.0"?><methodResponse><params><param>${body[1]}</param></params></methodResponse>`,
  );
}

test('scalars round-trip', () => {
  assert.equal(roundTrip('plain'), 'plain');
  assert.equal(roundTrip(42), 42);
  assert.equal(roundTrip(-7), -7);
  assert.equal(roundTrip(true), true);
  assert.equal(roundTrip(false), false);
  assert.equal(roundTrip(2.5), 2.5);
});

test('an integer past 32 bits travels as <i8>', () => {
  const size = 7_000_000_000; // an ordinary torrent size in bytes
  const xml = serializeCall('echo', [size]).toString('utf8');
  assert.match(xml, /<i8>7000000000<\/i8>/);
  assert.equal(roundTrip(size), size);
});

test('markup in strings survives both directions', () => {
  const tricky = 'a <b> & "c" \'d\'';
  assert.equal(roundTrip(tricky), tricky);
});

test('control characters are stripped on the way out', () => {
  const xml = serializeCall('echo', ['a\x00b\x01c\nd']).toString('utf8');
  assert.match(xml, /<string>abc\nd<\/string>/);
});

test('arrays and structs nest', () => {
  const value: XValue = { list: ['x', 2], inner: { deep: 'yes' } };
  assert.deepEqual(roundTrip(value), value);
});

test('base64 values become Buffers', () => {
  const data = Buffer.from('raw bytes \xff', 'latin1');
  const back = roundTrip(data);
  assert.ok(Buffer.isBuffer(back));
  assert.deepEqual(back, data);
});

test('numeric and named entities decode', () => {
  assert.equal(parseResponse(respond('<string>&#229;&amp;&lt;&gt;&quot;&apos;</string>')), 'å&<>"\'');
});

test('an untyped value is a string, as the spec says', () => {
  assert.equal(parseResponse(respond('bare text')), 'bare text');
});

test('CDATA is text, ampersands included', () => {
  assert.equal(parseResponse(respond('<string><![CDATA[a & b <c>]]></string>')), 'a & b <c>');
});

test('whitespace between tags is not data', () => {
  const xml = `<?xml version="1.0"?>
<methodResponse>
  <params>
    <param>
      <value><array><data>
        <value><i4>1</i4></value>
        <value><string>two</string></value>
      </data></array></value>
    </param>
  </params>
</methodResponse>`;
  assert.deepEqual(parseResponse(xml), [1, 'two']);
});

test('a fault throws with its code and message', () => {
  const xml = `<?xml version="1.0"?><methodResponse><fault><value><struct>
    <member><name>faultCode</name><value><i4>-503</i4></value></member>
    <member><name>faultString</name><value><string>Wrong object type.</string></value></member>
  </struct></value></fault></methodResponse>`;
  assert.throws(
    () => parseResponse(xml),
    (error: unknown) =>
      error instanceof XmlRpcFault &&
      error.faultCode === -503 &&
      error.faultString === 'Wrong object type.',
  );
});

test('a response with no param at all is an error, not empty data', () => {
  assert.throws(() => parseResponse('<html>not xml-rpc</html>'), /malformed/);
});

test('isFaultStruct tells multicall faults from results', () => {
  assert.equal(isFaultStruct({ faultCode: -501, faultString: 'x' }), true);
  assert.equal(isFaultStruct(['ok']), false);
  assert.equal(isFaultStruct('ok'), false);
  assert.equal(isFaultStruct(Buffer.from('x')), false);
});
