#!/usr/bin/env node
'use strict';
// THE RELATIVE DATA FOLDER - does a tool resolve the relative data folder project scope writes against the folder it
// starts in? Each row is launched as plan.js builds it at project scope (data folder `.preferred-tools/<name>`), over
// stdio, from a root folder R and then from R/child, under a throwaway HOME, and the file the tool writes into its data
// folder is looked for. A row with two passes may carry `locations.relative: true` in catalog/tools.json.
//
//   node tests/probes/relative-root.js [--rows serena,memory,playwright-chrome,appium] [--list] [--keep] [--scratch <dir>]
//
// Per run: initialize, notifications/initialized, tools/list, the row's call, then the data file is looked for:
//   serena   serena_config.yml   written into SERENA_HOME at start (no call)
//   memory   memory.db           created at start (no call)
//   browsers Local State         the browser profile's own file: browser_navigate about:blank, then browser_close
//   appium   *.png               appium_screenshot, which needs a device session
// PASS: the file is under <cwd>/.preferred-tools/<name>, and no new copy of it appeared anywhere else under HOME or R.
// A named tool missing from tools/list fails the row loudly (a pin bump renamed it: run --list and update CALLS).
//
// One line per run: RESULT <row> <root|child> <pass|fail> <where the data file was found>. Exit 1 when a named tool is
// missing, else 0. Packages download into the throwaway folder's cache on the first run (minutes). The browser runs
// headless (no window; it does not change where the profile goes). --list prints each server's tool names and exits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const E = require('../../scripts/entries.js');
const catalog = require('../../scripts/catalog.js').load();

const DATA_FILE = { serena: 'serena_config.yml', memory: 'memory.db', appium: '.png' };
const CALLS = {
    appium: [{ name: 'appium_screenshot', arguments: {} }],
};
const isBrowser = (id) => id.startsWith('playwright-');
const dataFile = (id) => (isBrowser(id) ? 'Local State' : DATA_FILE[id]);
const callsOf = (id) => (isBrowser(id) ? [{ name: 'browser_navigate', arguments: { url: 'about:blank' } }, { name: 'browser_close', arguments: {} }] : CALLS[id] || []);
const matches = (id, file) => (dataFile(id).startsWith('.') ? file.endsWith(dataFile(id)) : file === dataFile(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv)
{
    const out = { rows: ['serena', 'memory', 'playwright-chrome', 'appium'], list: false, keep: false, scratch: null };
    for (let i = 0; i < argv.length; i++)
    {
        if (argv[i] === '--rows') out.rows = argv[++i].split(',').filter(Boolean);
        else if (argv[i] === '--list') out.list = true;
        else if (argv[i] === '--keep') out.keep = true;
        else if (argv[i] === '--scratch') out.scratch = argv[++i];
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return out;
}

// every file named like the row's data file under a folder -> [absolute path]
function copies(id, dir)
{
    const out = [];
    const walk = (d, depth) =>
    {
        if (depth > 12) return;
        let list;
        try { list = fs.readdirSync(d, { withFileTypes: true }); }
        catch { return; }
        for (const e of list)
        {
            const p = path.join(d, e.name);
            if (e.isDirectory() && !e.isSymbolicLink()) walk(p, depth + 1);
            else if (matches(id, e.name)) out.push(p);
        }
    };
    walk(dir, 0);
    return out;
}

// One stdio session: initialize, tools/list, the calls in order. -> { tools, replies, error }
function session(entry, { cwd, env, calls, timeoutMs = 600000 })
{
    return new Promise((resolve) =>
    {
        const win = process.platform === 'win32';
        const p = spawn(entry.command, entry.args || [], { cwd, env: { ...env, ...(entry.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], detached: !win, shell: false });
        let buf = '';
        let stderr = '';
        let done = false;
        const out = { tools: [], replies: [], error: null };
        const finish = (error) =>
        {
            if (done) return;
            done = true;
            out.error = error || null;
            clearTimeout(timer);
            try { if (win) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f']); else process.kill(-p.pid, 'SIGKILL'); }
            catch { /* already gone */ }
            resolve(out);
        };
        const timer = setTimeout(() => finish(`no reply in ${timeoutMs / 1000}s`), timeoutMs);
        const send = (m) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
        let next = 3;
        const callNext = () =>
        {
            const c = calls.shift();
            if (!c) return finish(null);
            send({ id: next++, method: 'tools/call', params: c });
            return undefined;
        };
        p.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
        p.on('error', (e) => finish(`could not start: ${e.message}`));
        p.on('exit', (code) => finish(`exited ${code} before the calls ended: ${stderr.trim().split('\n').slice(-2).join(' | ')}`));
        p.stdout.on('data', (d) =>
        {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf('\n')) >= 0)
            {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let m;
                try { m = JSON.parse(line); }
                catch { continue; }
                if (m.id === 1)
                {
                    send({ method: 'notifications/initialized' });
                    send({ id: 2, method: 'tools/list' });
                }
                else if (m.id === 2)
                {
                    out.tools = ((m.result && m.result.tools) || []).map((t) => t.name);
                    const missing = calls.filter((c) => !out.tools.includes(c.name)).map((c) => c.name);
                    if (missing.length) return finish(`MISSING TOOL ${missing.join(', ')}`);
                    callNext();
                }
                else if (typeof m.id === 'number' && m.id >= 3)
                {
                    out.replies.push(m);
                    callNext();
                }
            }
            return undefined;
        });
        send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relative-root-probe', version: '1' } } });
    });
}

async function runRow(id, base, cache, opts)
{
    const row = catalog.byId.get(id);
    if (!row || !row.locations) throw new Error(`${id}: not a catalog row with a data folder`);
    const dir = fs.mkdtempSync(path.join(base, `${id}-`));
    const HOME = path.join(dir, 'home');
    const R = path.join(dir, 'R');
    const child = path.join(R, 'child');
    for (const d of [HOME, child]) fs.mkdirSync(d, { recursive: true });
    const ctx = { platform: process.platform, arch: process.arch, project: R, home: HOME, env: {}, machine: {} };
    const entry = E.buildEntry(row, 'local', { rootStr: `.preferred-tools/${row.name}`, scope: 'project', params: {} }, ctx, catalog.rules);
    if (isBrowser(id)) entry.args = [...entry.args, '--headless'];
    console.log(`LAUNCH ${id} ${entry.command} ${(entry.args || []).join(' ')} ${JSON.stringify(entry.env || {})}`);
    const env = {
        ...process.env, HOME, USERPROFILE: HOME,
        // one cache for every row and run, outside HOME and R, so a package downloads once
        XDG_CACHE_HOME: cache, npm_config_cache: path.join(cache, 'npm'), UV_CACHE_DIR: path.join(cache, 'uv'), UV_PYTHON_INSTALL_DIR: path.join(cache, 'uv-python'),
    };
    let missing = false;
    for (const [where, cwd] of [['root', R], ['child', child]])
    {
        const before = new Set([...copies(id, HOME), ...copies(id, R)]);
        const s = await session(entry, { cwd, env, calls: opts.list ? [] : callsOf(id).map((c) => ({ ...c })) });
        if (opts.list) { console.log(`TOOLS ${id} ${s.tools.join(' ')}`); break; }
        if (s.error && /^MISSING TOOL/.test(s.error)) { missing = true; console.log(`RESULT ${id} ${where} fail - ${s.error}`); break; }
        const expected = path.join(cwd, '.preferred-tools', row.name);
        // a browser may flush its profile on close: give the file a moment to land
        let fresh = [];
        for (let t = 0; t < 30; t++)
        {
            fresh = [...copies(id, HOME), ...copies(id, R)].filter((f) => !before.has(f));
            if (fresh.length) break;
            await sleep(500);
        }
        const failedCall = s.replies.find((m) => m.error || (m.result && m.result.isError));
        const show = (f) => path.relative(dir, f);
        if (!fresh.length)
        {
            const why = id === 'appium' && failedCall ? 'no device' : s.error || (failedCall ? `the call failed: ${JSON.stringify(failedCall.error || failedCall.result.content).slice(0, 160)}` : 'no data file written');
            console.log(`RESULT ${id} ${where} fail - ${why}`);
            continue;
        }
        const inside = fresh.filter((f) => f.startsWith(expected + path.sep));
        const outside = fresh.filter((f) => !inside.includes(f));
        console.log(`RESULT ${id} ${where} ${inside.length && !outside.length ? 'pass' : 'fail'} ${fresh.map(show).join(', ')}`);
    }
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`KEPT ${dir}`);
    return { missing };
}

(async () =>
{
    const opts = args(process.argv.slice(2));
    const base = fs.realpathSync(fs.mkdtempSync(path.join(opts.scratch || os.tmpdir(), 'relative-root-')));
    const cache = path.join(base, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    console.log(`probe: node ${process.versions.node}, ${process.platform} ${process.arch}; rows ${opts.rows.join(', ')}`);
    let missing = false;
    for (const id of opts.rows)
    {
        missing = (await runRow(id, base, cache, opts)).missing || missing;
    }
    if (!opts.keep) fs.rmSync(base, { recursive: true, force: true });
    process.exit(missing ? 1 : 0);
})();
