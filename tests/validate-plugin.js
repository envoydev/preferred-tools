#!/usr/bin/env node
'use strict';
// `claude plugin validate . --strict`, minus the one warning this repo keeps on purpose: CLAUDE.md at the plugin root
// (the repo's own working rules; Claude Code never loads it, and the plugin does not depend on it). Anything else the
// validator reports - an error, or any other warning - fails here.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const KNOWN = /^CLAUDE\.md at the plugin root is not loaded as project context/;
const root = path.resolve(__dirname, '..');
const r = spawnSync('claude', ['plugin', 'validate', root, '--json'], { encoding: 'utf8' });
if (r.error) { console.error(`validate: cannot run claude (${r.error.message})`); process.exit(2); }
let doc;
try { doc = JSON.parse(r.stdout); } catch { console.error(`validate: not JSON:\n${r.stdout}${r.stderr}`); process.exit(2); }

const problems = [];
for (const part of [doc.manifest, ...(doc.contents || [])])
{
    if (!part) continue;
    for (const e of part.errors || []) problems.push(`error   ${part.file}: ${e.path || ''} ${e.message}`);
    for (const w of part.warnings || [])
        if (!KNOWN.test(w.message)) problems.push(`warning ${part.file}: ${w.path || ''} ${w.message}`);
}
if (!doc.success) problems.push('validator reported success: false');
if (problems.length)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('validate: passed (the CLAUDE.md warning is the repo\'s own, allowed)');
