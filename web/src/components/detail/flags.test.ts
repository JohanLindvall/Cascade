// SPDX-License-Identifier: MIT

/**
 * A peer's Flags cell and a tracker's State cell hold one line however many
 * flags there are. They used to wrap in their fixed column: a peer the polls
 * marked snubbed grew its row by a line (every flag, by two; in retro on a
 * phone, by four) and shrank again when the flag went, and every row below
 * jumped with it. The cell shows the tags it has room for and an ellipsis
 * for the rest, so the order decides which are left out, and the title names
 * them all. The node runner has no layout to measure (that was done in
 * Firefox), so this checks the order, the title, the space between the tags
 * and the rules they rest on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { Peer, Tracker } from '../../types';
import { flagsTitle, peerFlags, trackerFlags, type Flag } from './flags.ts';

const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const source = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
/** The body of Flags in parts.tsx, which the runner cannot load: it is JSX. */
const flagsBody = () => /export function Flags\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source('./parts.tsx'))?.[1] ?? '';

/** The declarations of the top-level rule with exactly this selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `no top-level rule for ${selector}`);
  return match[1];
}

/** The number a declaration of that rule holds, in px or unitless. */
function value(selector: string, property: string, unit: 'px' | '' = 'px'): number {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+(?:\\.\\d+)?)${unit};`).exec(rule(selector));
  assert.ok(match, `${selector} has no ${property}${unit ? ` in ${unit}` : ''}`);
  return Number(match[1]);
}

const PEER_FLAGS = ['banned', 'snubbed', 'unwanted', 'preferred', 'encrypted', 'obfuscated', 'incoming'] as const;
const TRACKER_FLAGS = ['busy', 'open', 'extra'] as const;

function peer(flags: Partial<Peer>): Peer {
  return {
    id: '', address: '192.0.2.1', port: 51413, client: '', progress: 0, upRate: 0, downRate: 0,
    upTotal: 0, downTotal: 0, peerRate: 0, peerTotal: 0, encrypted: false, obfuscated: false,
    incoming: false, snubbed: false, preferred: false, unwanted: false, banned: false, options: '',
    ...flags,
  };
}

function tracker(flags: Partial<Tracker>): Tracker {
  return {
    index: 0, url: 'udp://tracker.example:6969', type: 2, group: 0, trackerId: '', enabled: true,
    usable: true, open: false, busy: false, extra: false, canScrape: true, seeders: 0, leechers: 0,
    downloaded: 0, lastScrape: 0, scrapes: 0, successes: 0, lastSuccess: 0, nextSuccess: 0, failures: 0,
    lastFailure: 0, nextFailure: 0, latestEvent: 0, newPeers: 0, sumPeers: 0, interval: 0,
    minInterval: 0, lastActivity: 0, nextActivity: 0,
    ...flags,
  };
}

/** Every combination of the named switches, each one on or off. */
function* combinations<K extends string>(keys: readonly K[]): Generator<Record<K, boolean>> {
  for (let bits = 0; bits < 1 << keys.length; bits++) {
    yield Object.fromEntries(keys.map((key, i) => [key, (bits & (1 << i)) !== 0])) as Record<K, boolean>;
  }
}

const SEVERITY: Record<string, number> = { bad: 0, warn: 1, good: 2, plain: 3 };
const severity = (flag: Flag) => SEVERITY[flag.tone ?? 'plain'];

function assertWorstFirst(flags: Flag[]): void {
  for (let i = 1; i < flags.length; i++) {
    const [before, after] = [flags[i - 1], flags[i]];
    assert.ok(severity(before) <= severity(after), `${before.label} before ${after.label}`);
  }
}

const labels = (flags: Flag[]) => flags.map((flag) => flag.label);

test('what is wrong comes first, the plain details every peer shares last', () => {
  // A narrow cell keeps the start of the list, so a snubbed peer shows "snub"
  // rather than the encryption it has in common with most of the swarm.
  const every = Object.fromEntries(PEER_FLAGS.map((flag) => [flag, true]));
  assert.deepEqual(labels(peerFlags(peer(every))), ['banned', 'snub', 'unwanted', 'pref', 'enc', 'obf', 'in']);
  assert.deepEqual(labels(peerFlags(peer({ encrypted: true, incoming: true, snubbed: true }))), ['snub', 'enc', 'in']);
  for (const flags of combinations(PEER_FLAGS)) assertWorstFirst(peerFlags(peer(flags)));
});

test('a tracker that fails comes first, then one not usable, then what it is doing', () => {
  const failing = { failures: 3, successes: 0 };
  assert.deepEqual(
    labels(trackerFlags(tracker({ ...failing, usable: false, busy: true, open: true, extra: true }))),
    ['failing', 'unusable', 'announcing', 'open', 'extra'],
  );
  assert.deepEqual(labels(trackerFlags(tracker({ successes: 2 }))), ['ok']);
  assert.deepEqual(trackerFlags(tracker({})), []);
  for (const flags of combinations(TRACKER_FLAGS)) {
    for (const usable of [true, false]) {
      for (const [failures, successes] of [[0, 0], [2, 0], [0, 2], [2, 2]]) {
        assertWorstFirst(trackerFlags(tracker({ ...flags, usable, failures, successes })));
      }
    }
  }
});

test('the title names every flag and what it means, one to a line', () => {
  const every = Object.fromEntries(PEER_FLAGS.map((flag) => [flag, true]));
  const flags = peerFlags(peer(every));
  const lines = flagsTitle(flags)?.split('\n') ?? [];
  assert.equal(lines.length, PEER_FLAGS.length);
  assert.deepEqual(lines, flags.map((flag) => `${flag.label}: ${flag.title}`));
  assert.equal(lines[1], 'snub: Snubbed — sent us nothing recently');
  // Nothing to name, so no title at all rather than an empty one.
  assert.equal(flagsTitle([]), undefined);
});

test('the expanded row names every flag in words', () => {
  // The cell may have room for its first tag alone, and a touch screen shows
  // no title: what it leaves out has to be found in the expanded row.
  const words: Record<string, [tab: 'Peers' | 'Trackers', key: string]> = {
    banned: ['Peers', 'Banned'],
    snub: ['Peers', 'Snubbed'],
    unwanted: ['Peers', 'Unwanted'],
    pref: ['Peers', 'Preferred'],
    enc: ['Peers', 'Encryption'],
    obf: ['Peers', 'Obfuscated header'],
    in: ['Peers', 'Direction'],
    failing: ['Trackers', 'Last failure'],
    unusable: ['Trackers', 'Usable'],
    announcing: ['Trackers', 'Announcing'],
    open: ['Trackers', 'Connection open'],
    extra: ['Trackers', 'Added at runtime'],
    ok: ['Trackers', 'Last success'],
  };
  const flags = [
    ...peerFlags(peer(Object.fromEntries(PEER_FLAGS.map((flag) => [flag, true])))),
    ...trackerFlags(tracker({ failures: 1, usable: false, busy: true, open: true, extra: true })),
    ...trackerFlags(tracker({ successes: 1 })),
  ];
  for (const flag of flags) {
    const entry = words[flag.label];
    assert.ok(entry, `"${flag.label}" is in no expanded row`);
    const [tab, key] = entry;
    assert.ok(source(`./${tab}Tab.tsx`).includes(`['${key}', `), `the ${tab} tab's block has no ${key}`);
  }
});

test('the cell is one line as tall as a tag, under a line of the table text', () => {
  const box = rule('.flags');
  assert.match(box, /display:\s*block/);
  assert.match(box, /white-space:\s*nowrap/);
  assert.match(box, /overflow:\s*hidden/);
  assert.match(box, /text-overflow:\s*ellipsis/);
  for (const match of css.matchAll(/([^{}]*\.flags\b[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(match[2], /flex-wrap|display:\s*(inline-)?flex/, match[1].trim());
  }
  const height = value('.flags', 'height');
  assert.equal(value('.flags', 'line-height'), height);
  assert.ok(value('.tag', 'height') <= height, 'a tag taller than the box would be clipped');
  // Under a line of the cells beside it, the box never sets the row's height.
  const line = value('table.grid', 'font-size') * value('body', 'line-height', '');
  assert.ok(height <= line, `${height}px box in a ${line.toFixed(2)}px line`);
  // Whole tags or none: the ellipsis hides a tag only as an inline block.
  assert.match(rule('.tag'), /display:\s*inline-flex/);
});

test('no flags at all is the dash in the same box', () => {
  // A cell holding a bare dash and one holding tags differed by a fraction of
  // a pixel, so a peer's first flag still nudged its row.
  const body = flagsBody();
  assert.equal(body.match(/\breturn\b/g)?.length, 1, 'Flags renders one box for every case');
  assert.match(body, /return \(\s*<span className="flags"/);
  assert.match(body, /'—'/);
});

test('a space parts the tags, drawn zero wide', () => {
  // Inline tags back to back have no text between them, so the accessible
  // name, innerText and a copy read a peer's "banned" and "snub" as
  // "bannedsnub". A space before every tag but the first makes them words.
  assert.match(flagsBody(), /\{i > 0 && <span className="flag-gap">\{' '\}<\/span>\}\s*<span className=\{flag\.tone/);
  // It draws nothing, so the cell looks as it did without it. Its
  // letter-spacing goes too: retro sets 0.02em on the body, which every
  // element inherits as 0.27px.
  const gap = '.flags > .flag-gap';
  assert.equal(value(gap, 'font-size', ''), 0);
  assert.equal(value(gap, 'letter-spacing', ''), 0);
  // On top, as the tags are: on the baseline its 16px line hung below the box.
  assert.match(rule(gap), /vertical-align:\s*top/);
  // The 4px between tags stays the next tag's margin, not the space's, so an
  // ellipsis sits against the last tag shown rather than 4px after it.
  assert.equal(value('.flags > .tag ~ .tag', 'margin-left'), 4);
  assert.doesNotMatch(rule(gap), /margin/);
});
