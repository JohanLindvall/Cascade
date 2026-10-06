/**
 * The name the image's patched libtorrent gives a path component longer than
 * the 255 bytes Linux allows (docker/patches/path_fit.h): the stem cut at a
 * UTF-8 boundary, "~" and an FNV-1a tag of the original, the extension kept.
 * Ported so the Files tab's "on disk as …" shows what the real image writes.
 */
const MAX_BYTES = 255;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tag(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function fitComponent(name: string): string {
  const bytes = encoder.encode(name);
  if (bytes.length <= MAX_BYTES) return name;
  // A short, ordinary extension; a "." deep inside a title is not one.
  const dot = bytes.lastIndexOf(0x2e);
  const ext = dot > 0 && bytes.length - dot <= 16 && !bytes.subarray(dot).some((b) => b === 0x20 || b === 0x09)
    ? bytes.subarray(dot) : new Uint8Array(0);
  const suffix = `~${tag(bytes)}`;
  let cut = MAX_BYTES - suffix.length - ext.length;
  // Never split a character: back off past continuation bytes, then past
  // trailing spaces and dots, which read as a typo.
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  while (cut > 0 && (bytes[cut - 1] === 0x20 || bytes[cut - 1] === 0x2e)) cut--;
  return decoder.decode(bytes.subarray(0, cut)) + suffix + decoder.decode(ext);
}
