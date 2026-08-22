/**
 * Keeps the option catalog, the entrypoint and the README in step.
 *
 *   npm run options:check   verify — used by CI, fails on any drift
 *   npm run options:docs    rewrite the generated regions of the README
 *
 * The catalog cannot silently fall behind the shell: every RT_/WEB_/CASCADE_
 * variable the entrypoint reads must be listed in options.ts, and every option
 * listed must actually be used by something. The server side needs no check —
 * config.ts looks its defaults up in the catalog and throws otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OPTIONS, USAGE_EXAMPLE, renderMarkdown } from './options';

const ROOT = path.join(__dirname, '..', '..');
const ENTRYPOINT = path.join(ROOT, 'docker', 'entrypoint.sh');
const CONFIG_TS = path.join(ROOT, 'server', 'src', 'config.ts');
const README = path.join(ROOT, 'README.md');

/** Variables the entrypoint uses for its own plumbing, not user options. */
const INTERNAL = new Set(['RT_VERSION']);

const MARKERS: Array<{ begin: string; end: string; render: () => string }> = [
  {
    begin: '<!-- generated: usage -->',
    end: '<!-- /generated -->',
    render: () => ['```bash', USAGE_EXAMPLE, '```'].join('\n'),
  },
  {
    begin: '<!-- generated: options -->',
    end: '<!-- /generated -->',
    render: renderMarkdown,
  },
];

function envNamesIn(file: string): Set<string> {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set<string>();
  // Shell: ${RT_FOO:-…} or $RT_FOO. TypeScript: str('RT_FOO'), num('WEB_PORT'), …
  const patterns = [
    /\$\{?((?:RT|WEB|CASCADE)_[A-Z0-9_]+|PUID|PGID|TZ)\b/g,
    /\b(?:str|num|bool|optional)\('((?:RT|WEB|CASCADE)_[A-Z0-9_]+)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/** Replace each generated region in place; returns the new README text. */
function generate(readme: string): string {
  let out = readme;
  for (const marker of MARKERS) {
    const start = out.indexOf(marker.begin);
    if (start < 0) throw new Error(`README is missing the ${marker.begin} marker`);
    const from = start + marker.begin.length;
    const end = out.indexOf(marker.end, from);
    if (end < 0) throw new Error(`README is missing the ${marker.end} after ${marker.begin}`);
    out = `${out.slice(0, from)}\n${marker.render()}\n${out.slice(end)}`;
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');
  const problems: string[] = [];

  const used = new Set([...envNamesIn(ENTRYPOINT), ...envNamesIn(CONFIG_TS)]);
  const catalogued = new Set(OPTIONS.map((option) => option.name));

  for (const name of [...used].sort()) {
    if (!catalogued.has(name) && !INTERNAL.has(name)) {
      problems.push(`${name} is read by the container but missing from options.ts`);
    }
  }
  for (const name of [...catalogued].sort()) {
    if (!used.has(name)) {
      problems.push(`${name} is documented in options.ts but nothing reads it`);
    }
  }

  const readme = fs.readFileSync(README, 'utf8');
  const generated = generate(readme);
  if (write) {
    if (generated !== readme) {
      fs.writeFileSync(README, generated);
      console.log('README regenerated');
    } else {
      console.log('README already up to date');
    }
  } else if (generated !== readme) {
    problems.push('README is out of date — run `npm run options:docs`');
  }

  if (problems.length > 0) {
    console.error('option catalog is out of step:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`${OPTIONS.length} options documented, catalog and README in step`);
}

main();
