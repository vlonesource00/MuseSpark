// Installs the MuseSpark benchmark registration into the sibling benchmark
// tree (read our bridge, rewrite ONLY the import prefix, patch index +
// subjects manifest idempotently). Benchmark tree edits are mechanical and
// reviewable; rerunning is a no-op once applied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const museRoot = path.resolve(here, '..');
const benchRoot = path.resolve(museRoot, '..', 'benchmark');
const bridgeSrc = path.join(museRoot, 'bridge', 'musespark-bridge.js');
const bridgeDst = path.join(benchRoot, 'sandbox', 'bridges', 'musespark-bridge.js');
const indexPath = path.join(benchRoot, 'sandbox', 'bridges', 'index.js');
const subjectsPath = path.join(benchRoot, 'benchmark', 'subjects.json');

const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice(9) ?? 'c8f7cde2d021f560b1f6cc989fba8ecb22e7bf54';

// 1. Bridge copy with import-prefix rewrite (logic untouched).
let bridge = fs.readFileSync(bridgeSrc, 'utf8');
const rewritten = bridge.split(`'../src/`).join(`'../../subjects/musespark/src/`);
if (!rewritten.includes('../../subjects/musespark/src/')) throw new Error('import rewrite produced no changes — check prefixes');
fs.writeFileSync(bridgeDst, rewritten);
console.log(`BRIDGE ${path.relative(benchRoot, bridgeDst)}`);

// 2. index.js patches (guarded, idempotent).
let index = fs.readFileSync(indexPath, 'utf8');
const importLine = `import { createMuseBridge, MUSE_CANDIDATE } from './musespark-bridge.js';`;
if (!index.includes(importLine)) {
  index = index.replace(
    `import { createCloudBridge, CLOUD_CANDIDATE } from './claude-bridge.js';`,
    `import { createCloudBridge, CLOUD_CANDIDATE } from './claude-bridge.js';\n${importLine}`
  );
  console.log('INDEX import added');
}
const branchLine = `    } else if (id === 'musespark') {\n      bridges[index] = createMuseBridge({ candidate: candidatesList.find((entry) => entry.id === id) ?? MUSE_CANDIDATE, cars, hostTrack, shadowTrack, index });\n    }`;
if (!index.includes(`id === 'musespark'`)) {
  index = index.replace(
    `    } else if (id === 'gemini-nmpcc') {`,
    `${branchLine} else if (id === 'gemini-nmpcc') {`
  );
  console.log('INDEX branch added');
}
if (!index.includes('MUSE_CANDIDATE,')) {
  index = index.replace(
    `export const ALL_KNOWN_CANDIDATES = Object.freeze([\n  ...CANDIDATES_5ARCH,`,
    `export const ALL_KNOWN_CANDIDATES = Object.freeze([\n  MUSE_CANDIDATE,\n  ...CANDIDATES_5ARCH,`
  );
  console.log('INDEX candidate registered');
}
fs.writeFileSync(indexPath, index);

// 3. subjects.json entry (idempotent by id).
const subjects = JSON.parse(fs.readFileSync(subjectsPath, 'utf8'));
if (!subjects.subjects.some((s) => s.id === 'musespark')) {
  subjects.subjects.push({
    id: 'musespark',
    label: 'MuseSpark',
    repoUrl: 'https://github.com/vlonesource00/MuseSpark.git',
    branch: 'master',
    commit,
    testNotes: 'Muse global-optimum + belief + strategy + trajectory + coupled MPCC + safety. Local harness: tools/bridge-smoke.mjs (shared-mode smoke + host-physics solo pace).',
    tests: []
  });
  fs.writeFileSync(subjectsPath, `${JSON.stringify(subjects, null, 2)}\n`);
  console.log(`SUBJECTS musespark pinned @ ${commit.slice(0, 12)}`);
} else {
  console.log('SUBJECTS musespark already registered');
}
console.log('\nNext (from benchmark/): node scripts/prepare-subjects.mjs --subject musespark');
