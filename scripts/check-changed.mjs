#!/usr/bin/env node
// Scoped inner-loop checks for the files changed on this branch.
// See docs/agents/checks.md. Does not replace `yarn lint` / `yarn typecheck` /
// `yarn test`, which stay the phase gate.
//
//   yarn check:changed [--branch | --base <ref>] [--skip lint,test,types,rust]
//
// Default scope: uncommitted and untracked files (the inner loop). `--branch`
// widens it to everything differing from merge-base(HEAD, canary); `--base`
// picks another ref.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const skip = new Set((opt('--skip') ?? '').split(',').filter(Boolean));
const working = !args.includes('--branch') && !opt('--base');

// Fail on a clean Windows checkout too; see docs/agents/checks.md.
const knownFailingCargoTests = win
  ? [
      'storage::tests::vacuum_into_exports_a_compacted_database',
      'storage::tests::validate_import_schema_accepts_initial_v2_schema',
      'doc::tests::get_doc_reads_snapshot_and_updates_from_one_view',
    ]
  : [];
const knownFailingSpecs = win
  ? [
      '**/src/__tests__/share-page.spec.ts',
      '**/*-preview.integration.spec.ts',
      '**/utils/__tests__/first-app-data.spec.ts',
    ]
  : [];

const env = {
  ...process.env,
  PATH: [join(homedir(), '.cargo', 'bin'), process.env.PATH].join(delimiter),
};

function run(cmd, cmdArgs, { quiet = false } = {}) {
  const q = a => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
  const bin = cmd.startsWith('node_modules/')
    ? join(root, cmd) + (win ? '.cmd' : '')
    : cmd;
  const r = spawnSync(q(bin), cmdArgs.map(q), {
    cwd: root,
    env,
    shell: true,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return quiet ? r : r.status === 0;
}

const git = a =>
  spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();

let base = opt('--base');
if (!base && !working) {
  for (const ref of ['canary', 'origin/canary']) {
    base = git(['merge-base', 'HEAD', ref]);
    if (base) break;
  }
}
const names = new Set(
  [
    ...(base && !working ? git(['diff', '--name-only', base]).split('\n') : []),
    ...git(['diff', '--name-only', 'HEAD']).split('\n'),
    ...git(['ls-files', '-o', '--exclude-standard']).split('\n'),
  ].filter(f => f && existsSync(join(root, f)))
);
const files = [...names];
console.log(
  `[check-changed] ${files.length} changed file(s)` +
    (base && !working ? ` vs ${base.slice(0, 9)}` : ' (working tree)')
);

const js = files.filter(f => /\.(m?[jt]sx?)$/.test(f));
const ts = files.filter(f => /\.tsx?$/.test(f));
const rs = files.filter(f => f.endsWith('.rs'));
const results = [];
const step = (name, enabled, fn) => {
  if (!enabled || skip.has(name.split(/[: ]/)[0])) return;
  console.log(`\n[check-changed] ${name}`);
  const t = Date.now();
  const ok = fn();
  results.push([name, ok, ((Date.now() - t) / 1000).toFixed(1)]);
};

step('lint: oxfmt', files.length > 0, () =>
  run('node_modules/.bin/oxfmt', [
    '--check',
    '--no-error-on-unmatched-pattern',
    ...files,
  ])
);
step('lint: oxlint', js.length > 0, () =>
  run('node_modules/.bin/oxlint', ['--deny-warnings', ...js])
);

// Each changed .ts(x) maps to its nearest tsconfig.json; `tsc -b` on that
// project also rebuilds stale references, and is a no-op when up to date.
const projects = new Set();
for (const f of ts) {
  let d = dirname(join(root, f));
  while (d.startsWith(root) && d !== root) {
    if (existsSync(join(d, 'tsconfig.json'))) {
      projects.add(d);
      break;
    }
    d = dirname(d);
  }
}
step('types', projects.size > 0, () =>
  [...projects].every(p => {
    console.log(`  tsc -b ${p.slice(root.length + 1)}`);
    return run('node_modules/.bin/tsc', ['-b', join(p, 'tsconfig.json')]);
  })
);

// Rust before vitest: they must never run at the same time (Vite's watcher
// crashes with EBUSY on files under target/ while cargo builds).
const crates = new Set();
for (const f of rs) {
  let d = dirname(join(root, f));
  while (d.startsWith(root) && d !== root) {
    const manifest = join(d, 'Cargo.toml');
    if (existsSync(manifest)) {
      const m = /^\s*name\s*=\s*"([^"]+)"/m.exec(
        readFileSync(manifest, 'utf8').split(/^\[dependencies/m)[0]
      );
      if (m) crates.add(m[1]);
      break;
    }
    d = dirname(d);
  }
}
step('rust', crates.size > 0, () =>
  [...crates].every(c =>
    run('cargo', [
      'test',
      '-p',
      c,
      '--',
      ...knownFailingCargoTests.flatMap(t => ['--skip', t]),
    ])
  )
);

const testable = ts.filter(f => /^packages\/(common|frontend)\//.test(f));
step('test', testable.length > 0, () =>
  run('node_modules/.bin/vitest', [
    'related',
    '--run',
    '--passWithNoTests',
    ...knownFailingSpecs.flatMap(g => ['--exclude', g]),
    ...testable,
  ])
);

console.log('\n[check-changed] summary');
for (const [n, ok, s] of results)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n} (${s}s)`);
if (crates.size)
  console.log(
    '  note: see docs/agents/checks.md for known Windows-only cargo failures'
  );
process.exit(results.every(r => r[1]) ? 0 : 1);
