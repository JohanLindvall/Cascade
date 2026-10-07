// SPDX-License-Identifier: MIT

/**
 * What rtorrent can be sent as text — the rule the server holds every value
 * typed for rtorrent to (server/internal/validate/rtorrent.go), so a field
 * can refuse what the server would, in the server's words, before anything
 * is sent. Strings reach rtorrent as XML-RPC text, which xmlrpc-c, the
 * image's RPC layer, takes only within the Basic Multilingual Plane: a
 * character beyond U+FFFF, such as an emoji, fails the whole call (fault
 * -503), and a directory change used to stop the torrent before that came
 * back. XML cannot carry U+FFFE, U+FFFF or a control character other than
 * tab and line feed, and reads a carriage return as a line feed. Labels need
 * none of it: they are sent URL-encoded.
 */

const hex = (code: number) => code.toString(16).toUpperCase().padStart(4, '0');

/**
 * What in text rtorrent cannot be sent as it is, the first such thing,
 * worded to follow a field's name as the server's 400 is (`"directory"
 * contains …`); null when there is none. A lone surrogate is refused too: a
 * request carries it as U+FFFD, which would be sent in its place.
 */
export function unsendable(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      return `contains "${char}" (U+${hex(code)}): rtorrent's XML-RPC layer takes no character beyond U+FFFF, such as an emoji`;
    }
    if (code >= 0xd800 && code <= 0xdfff) return `contains U+${hex(code)}, half of a surrogate pair`;
    if (code === 0xfffe || code === 0xffff) return `contains U+${hex(code)}, which XML cannot carry`;
    if (code === 0x0d) return 'contains a carriage return, which XML reads as a line feed';
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return `contains U+${hex(code)}, a control character XML cannot carry`;
  }
  return null;
}

/** validate.Directory's refusal of the root, after the field's name. */
export const ROOT_DIRECTORY =
  'cannot be "/": rtorrent strips a directory\'s trailing slashes and would put a single file in ".", the directory it runs in';

/**
 * What is wrong with a directory typed for rtorrent to keep a torrent's data
 * in, or null: what it cannot be sent, and the root, which rtorrent strips to
 * nothing and reads as "." — the server refuses both (validate.Directory).
 * Nothing at all is no problem here; an add reads it as the default directory.
 */
export function directoryProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed !== '' && /^\/+$/.test(trimmed)) return ROOT_DIRECTORY;
  return unsendable(trimmed);
}

/**
 * What is wrong with a list of links, one per line, or null: the first line
 * rtorrent cannot be sent, by its number in the field (the server's
 * uploadURLs refuses the whole list for it).
 */
export function linesProblem(text: string): string | null {
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const problem = unsendable(lines[index].trim());
    if (problem !== null) return `line ${index + 1} ${problem}`;
  }
  return null;
}

/** A problem as a field shows it, beneath the control: a sentence of its own. */
export function sentence(problem: string): string {
  return problem.charAt(0).toUpperCase() + problem.slice(1);
}
