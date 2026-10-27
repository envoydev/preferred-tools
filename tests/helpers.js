'use strict';
// Shared test scaffolding: a throwaway project and account dir, and the fake `claude` on PATH.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE = path.join(__dirname, 'fake-claude.js');
const RUNTIME = path.join(__dirname, 'fake-runtime.js');

// A throwaway world: { dir, project, account, home, bin, log, env, calls() }. `claude` on its PATH is the fake.
function world(prefix = 'pt-')
{
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const project = path.join(dir, 'project');
    const account = path.join(dir, 'account');
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    for (const d of [project, account, home, bin, path.join(dir, 'state')]) fs.mkdirSync(d, { recursive: true });
    const shim = (name, script, ...pre) =>
    {
        const file = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
        if (process.platform === 'win32') fs.writeFileSync(file, `@echo off\r\nnode "${script}" ${pre.join(' ')} %*\r\n`);
        else { fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${pre.join(' ')} "$@"\n`); fs.chmodSync(file, 0o755); }
    };
    shim('claude', FAKE);
    // the runtimes a fetch step calls: recorded, never run (tests/fake-runtime.js)
    for (const rt of ['npm', 'uvx', 'docker']) shim(rt, RUNTIME, rt);
    const log = path.join(dir, 'calls.jsonl');
    const fetchLog = path.join(dir, 'fetches.jsonl');
    const env = {
        ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: account,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STATE: path.join(dir, 'state'), FAKE_RUNTIME_LOG: fetchLog,
    };
    delete env.FAKE_CLAUDE_FAIL;
    delete env.FAKE_RUNTIME_FAIL;
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv) : []);
    const fetches = () => (fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const writes = () => calls().filter((a) => (a[0] === 'mcp' && ['add-json', 'remove'].includes(a[1])) || (a[0] === 'plugin' && !['list'].includes(a[1]) && !(a[1] === 'marketplace' && a[2] === 'list')));
    const clean = () => fs.rmSync(dir, { recursive: true, force: true });
    return { dir, project, account, home, bin, log, env, calls, writes, fetches, clean };
}

const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

module.exports = { world, writeJson, readJson, FAKE };
