// Builds the runtime node_modules that electron-forge packs into the desktop
// app, without the "hoisting off" reinstall. See
// docs/agents/building-clients.md ("Windows desktop build").
//
// usage: node scripts/fork/stage-electron-node-modules.mjs <out dir outside the repo>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const rootNm = path.join(root, 'node_modules');
const out = process.argv[2];
if (!out) {
  console.error('usage: stage-electron-node-modules.mjs <out dir>');
  process.exit(1);
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pkg = readJson(
  path.join(root, 'packages/frontend/apps/electron/package.json')
);
const scoped = scope =>
  fs.readdirSync(path.join(rootNm, scope)).map(n => `${scope}/${n}`);

// Runtime deps, plus the devDependencies forge and forge.config.mjs load.
const real = [
  ...Object.keys(pkg.dependencies),
  'semver',
  ...scoped('@electron-forge'),
  ...scoped('@electron'),
  'electron',
  'electron-squirrel-startup',
  'electron-log',
  'app-builder-lib',
  'builder-util-runtime',
  'zod',
];

const seen = new Set();
const queue = [...real];

// Walks a package and the packages nested in its node_modules. A dependency
// that no node_modules up the chain provides is taken from the root.
const visit = (dir, chain) => {
  const p = readJson(path.join(dir, 'package.json'));
  const here = [path.join(dir, 'node_modules'), ...chain];
  const deps = {
    ...p.dependencies,
    ...p.optionalDependencies,
    ...p.peerDependencies,
  };
  for (const d of Object.keys(deps)) {
    if (!here.some(nm => fs.existsSync(path.join(nm, d)))) queue.push(d);
  }
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return;
  for (const n of fs.readdirSync(nm)) {
    const names = n.startsWith('@')
      ? fs.readdirSync(path.join(nm, n)).map(m => `${n}/${m}`)
      : [n];
    for (const m of names) {
      if (fs.existsSync(path.join(nm, m, 'package.json'))) {
        visit(path.join(nm, m), here);
      }
    }
  }
};

while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  const dir = path.join(rootNm, name);
  // Missing optional deps and deps that exist only nested elsewhere.
  if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
  seen.add(name);
  visit(dir, []);
}

fs.rmSync(out, { recursive: true, force: true });
for (const name of seen) {
  fs.cpSync(path.join(rootNm, name), path.join(out, name), {
    recursive: true,
    dereference: true,
  });
}

// Forge's dependency walker only needs the other devDependencies to exist.
let stubs = 0;
for (const d of Object.keys(pkg.devDependencies)) {
  if (seen.has(d)) continue;
  fs.mkdirSync(path.join(out, d), { recursive: true });
  fs.writeFileSync(
    path.join(out, d, 'package.json'),
    JSON.stringify({ name: d, version: '0.0.0' })
  );
  stubs++;
}
console.log(`copied ${seen.size} packages, ${stubs} stubs`);
