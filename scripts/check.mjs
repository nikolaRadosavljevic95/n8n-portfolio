// Static checks that need no Docker, so a typo is caught in seconds instead of
// fifteen minutes into the end-to-end run (or at runtime inside n8n).
//
//   1. Every Code node file parses the way n8n will parse it (an async function
//      body, so a top level `return` is legal).
//   2. Every workflow definition, script and test parses as a module.
//   3. Every file under src/code is actually used by a workflow.
//
// Run with `npm run check`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../src/lib/wf.mjs';

const problems = [];

function walk(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, ext);
    return e.name.endsWith(ext) ? [full] : [];
  });
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function report(label, files, check) {
  let failed = 0;
  for (const file of files) {
    const error = check(file);
    if (error) {
      failed += 1;
      problems.push(`${rel(file)}: ${error}`);
    }
  }
  console.log(`${failed ? 'FAIL' : 'ok  '}  ${label} (${files.length} file${files.length === 1 ? '' : 's'})`);
}

const codeFiles = walk(path.join(ROOT, 'src', 'code'), '.js');
report('Code node syntax', codeFiles, (file) => {
  try {
    // n8n runs the body of a Code node inside an async function, which is why
    // these files use a top level `return` and cannot be parsed as modules.
    new vm.Script(`(async function () {\n${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
    return null;
  } catch (e) {
    return e.message;
  }
});

const moduleFiles = [
  ...walk(path.join(ROOT, 'src'), '.mjs'),
  ...walk(path.join(ROOT, 'scripts'), '.mjs'),
  ...walk(path.join(ROOT, 'tests'), '.mjs'),
];
report('Module syntax', moduleFiles, (file) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (e) {
    return String(e.stderr || e.message).trim().split('\n').slice(0, 3).join(' ');
  }
});

const referenced = new Set();
for (const file of walk(path.join(ROOT, 'src', 'workflows'), '.mjs')) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/\bcode\(\s*'([\w./-]+\.js)'\s*\)/g)) referenced.add(m[1]);
}
const orphans = codeFiles.filter((f) => !referenced.has(rel(f).replace('src/code/', '')));
console.log(`${orphans.length ? 'FAIL' : 'ok  '}  Code node files are used (${referenced.size} referenced)`);
for (const f of orphans) problems.push(`${rel(f)}: not referenced by any workflow`);

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('\nAll static checks passed.');
