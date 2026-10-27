'use strict';
// Shared test scaffolding: a throwaway project and account dir, and the fake `claude` on PATH.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fake-claude.js');

// A throwaway world: { dir, project, account, home, bin, log, env, calls() }. `claude` on its PATH is the fake.
function world(prefix = 'pt-')
{
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const project = path.join(dir, 'project');
    const account = path.join(dir, 'account');
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    for (const d of [project, account, home, bin, path.join(dir, 'state')]) fs.mkdirSync(d, { recursive: true });
    const claude = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (process.platform === 'win32') fs.writeFileSync(claude, `@echo off\r\nnode "${FAKE}" %*\r\n`);
    else { fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`); fs.chmodSync(claude, 0o755); }
    const log = path.join(dir, 'calls.jsonl');
    const env = {
        ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: account,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STATE: path.join(dir, 'state'),
    };
    delete env.FAKE_CLAUDE_FAIL;
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv) : []);
    const writes = () => calls().filter((a) => (a[0] === 'mcp' && ['add-json', 'remove'].includes(a[1])) || (a[0] === 'plugin' && !['list'].includes(a[1]) && !(a[1] === 'marketplace' && a[2] === 'list')));
    const clean = () => fs.rmSync(dir, { recursive: true, force: true });
    return { dir, project, account, home, bin, log, env, calls, writes, clean };
}

const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

module.exports = { world, writeJson, readJson, FAKE };
