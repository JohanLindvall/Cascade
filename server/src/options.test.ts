/**
 * The option catalog is load-bearing: config.ts trusts documentedDefault to
 * throw on unknown names, and --help / the README render from it verbatim.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPTIONS, SECTIONS, documentedDefault, renderHelp, renderMarkdown } from './options';

test('option names are unique and sectioned', () => {
  const names = new Set(OPTIONS.map((option) => option.name));
  assert.equal(names.size, OPTIONS.length);
  for (const option of OPTIONS) {
    assert.ok((SECTIONS as readonly string[]).includes(option.section), option.name);
  }
});

test('documentedDefault answers for the catalogued and throws for the rest', () => {
  assert.equal(documentedDefault('WEB_PORT'), '8080');
  assert.equal(documentedDefault('RT_COMPLETED_DIR'), undefined); // documented, no default
  assert.throws(() => documentedDefault('CASCADE_TYPO'), /missing|not listed/);
});

test('--help names every option', () => {
  const help = renderHelp();
  for (const option of OPTIONS) {
    assert.ok(help.includes(option.name), `${option.name} missing from --help`);
  }
});

test('the README tables name every option', () => {
  const markdown = renderMarkdown();
  for (const option of OPTIONS) {
    assert.ok(markdown.includes(`\`${option.name}\``), `${option.name} missing from the tables`);
  }
});
