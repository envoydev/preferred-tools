#!/usr/bin/env node
'use strict';
// `claude plugin validate` on what an install receives: a scratch copy of the files git would ship (tracked,
// plus untracked ones not ignored), never the folder on disk. The validator reads the folder as it is, so a file git
// ignores - a Finder .DS_Store - would be reported although it never reaches an install. `--profile directory --strict`:
// any error or warning fails, the checks Anthropic's plugin directory makes (an icon, no OS metadata files) included.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ls = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
if (ls.error || ls.status !== 0) { console.error(`validate: cannot list the repo's files (${ls.error ? ls.error.message : ls.stderr.trim()})`); process.exit(2); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'preferred-tools-validate-'));
const copy = path.join(scratch, 'preferred-tools');
let code = 0;
try
{
    // a file deleted in the working tree but still in the index is not shipped either
    const files = ls.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
    for (const f of files)
    {
        fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
        fs.copyFileSync(path.join(root, f), path.join(copy, f));
    }
    const r = spawnSync('claude', ['plugin', 'validate', copy, '--profile', 'directory', '--strict'], { encoding: 'utf8' });
    if (r.error) { console.error(`validate: cannot run claude (${r.error.message})`); code = 2; }
    else if (r.status !== 0) { console.error(`${r.stdout}${r.stderr}`.trim()); code = 1; }
    else console.log(`validate: passed (--profile directory --strict, nothing to report) on the ${files.length} files git would ship`);
}
finally { fs.rmSync(scratch, { recursive: true, force: true }); }
process.exit(code);
