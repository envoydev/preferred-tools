#!/usr/bin/env node
'use strict';
// FETCH - the slow half of an apply: fills the runtime caches for what apply.js just registered, starts each new server
// once, then asks the CLI for each status.
//
//   node fetch.js <fetch.json>
//
// apply.js (and update.js, fix.js) write fetch.json once the registrations are written and read back. Claude Code gives a
// server 30 seconds to answer its first start, and a first start can take minutes - measured on macOS, memory's package
// came down in about 6 s and its first start then took 110 s more, downloading its embedding model, while its second
// and third starts took 2 s. So each server is first fetched (its package, image or tool environment) and then started
// once as the CLI wrote it, with no 30-second limit, and stopped once it answers `initialize`. That outlasts the Bash
// tool's 2-minute default, so the command runs this in the background and the apply itself is never cut off halfway.
//
// One server at a time: two first installs of the same runtime at once is the one case that broke a start (an npx
// cache entry left without its package.json). A failed fetch or start is a warning, never a change: the registration
// stays, and its first session start tries again. `claude mcp get` comes last, so its own 30-second health check meets a
// filled cache instead of starting a download it then kills.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const cli = require('./claude-cli.js');
const account = require('./account.js');
const kept = require('./kept.js');
const tmpdir = require('./tmpdir.js');
const { blockingStdio } = require('./json-file.js');

const VERSION = 1;
const START_MS = 600000;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preferred-tools', version: '0' } } };
// ${VAR} and ${VAR:-default}, as Claude Code expands them in an MCP entry
const expand = (s, env) => String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => (env[k] !== undefined ? env[k] : d || ''));
// the first ${VAR} with no default that is not set: a start without it only fails
const unsetVar = (entry, env) => [...JSON.stringify([entry.command, entry.args || [], entry.env || {}]).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).find((k) => env[k] === undefined) || null;

// The runtime itself (npm, uvx, docker), never the claude CLI, and with no limit of Claude Code's. On Windows it goes
// through the shell so npm.cmd resolves.
const realFetch = (argv, { cwd, env }) => spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 1800000, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });

// A server and everything it started: TERM, then KILL after 5 s (Windows: taskkill /T /F). -> Promise, once it is gone
function stopTree(child)
{
    return new Promise((resolve) =>
    {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); return resolve(); }
        const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
        const hard = setTimeout(() => { kill('SIGKILL'); resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(hard); kill('SIGKILL'); resolve(); });
        kill('SIGTERM');
    });
}

// The server started exactly as written - command, args and env, ${VAR} expanded - and sent `initialize` over stdio,
// as Claude Code's first start sends it. -> Promise<{ ok, ms, why? }>
function realStart(entry, { cwd, env, ms = START_MS })
{
    return new Promise((resolve) =>
    {
        const childEnv = { ...env };
        for (const [k, v] of Object.entries(entry.env || {})) childEnv[k] = expand(v, env);
        const t0 = Date.now();
        let child;
        try { child = spawn(expand(entry.command, env), (entry.args || []).map((a) => expand(a, env)), { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
        catch (e) { resolve({ ok: false, ms: 0, why: e.message }); return; }
        let out = '';
        let err = '';
        let settled = false;
        const done = (r) =>
        {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const took = Date.now() - t0;
            stopTree(child).then(() => resolve({ ...r, ms: took }));
        };
        const timer = setTimeout(() => done({ ok: false, why: `no answer in ${ms / 1000}s` }), ms);
        child.on('error', (e) => done({ ok: false, why: e.message }));
        child.on('exit', (code) => done({ ok: false, why: `exited ${code} before answering${err.trim() ? `: ${err.trim().split('\n').slice(-1)[0]}` : ''}` }));
        child.stdin.on('error', () => { /* it exited; 'exit' says so */ });
        child.stderr.on('data', (d) => { err = `${err}${d}`.slice(-4000); });
        child.stdout.on('data', (d) =>
        {
            const lines = `${out}${d}`.split('\n');
            out = lines.pop();
            for (const line of lines)
            {
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id === 1) return done(msg.result ? { ok: true } : { ok: false, why: `initialize error: ${JSON.stringify(msg.error)}` });
            }
        });
        child.stdin.write(`${JSON.stringify(INIT)}\n`);
    });
}

// -> the job apply.js hands over: { version, project, fetch: [fetch steps, each with the scope it was written at], check: [server names] }
const job = (project, fetch, check) => ({ version: VERSION, project, fetch, check: [...new Set(check)] });

// Each step's argv and env as kept.js keeps them, so the file a command line names holds no live credential: a download
// needs none (a kept value expands to ''), and the first start reads the registration itself.
function writeJob(file, j)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fetch = j.fetch.map((s) => { const k = kept.keep({ args: s.argv, env: s.env }, null); return { ...s, argv: k.args, env: k.env }; });
    fs.writeFileSync(file, `${JSON.stringify({ ...j, fetch }, null, 2)}\n`);
    return file;
}

// The lines apply.js prints for the command: the file, and what fetch.js will do with it.
const nextLines = (file, j) => [
    `Fetch next, in the background (a first download can take minutes): ${file}`,
    `  fetches ${j.fetch.map((s) => s.what).join(', ')} and starts each once, then reports the status of ${j.check.join(', ')} (claude mcp get)`,
];

// Each server's status line as `claude mcp get` prints it - a health check of up to 30 s each. -> [{ name, out }]
function status(names, { cwd, env, runCli = cli.run, log = console.log })
{
    if (names.length) log('', 'Status, from the CLI:');
    return names.map((name) =>
    {
        const g = runCli(['mcp', 'get', name], { cwd, env });
        const lines = `${g.stdout || ''}${g.stderr || ''}`.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const out = lines.find((l) => /^Status:/i.test(l)) || lines.slice(-1)[0] || '(no output)';
        log(`  ${name}: ${out}`);
        return { name, out };
    });
}

// -> Promise<{ fetched: [what], started: [name], skipped: [line], warnings: [detail], status: [{ name, out }] }>
async function run(j, { env = process.env, runFetch = realFetch, start = realStart, runCli = cli.run, log = console.log } = {})
{
    const res = { fetched: [], started: [], skipped: [], warnings: [], status: [] };
    const cwd = j.project;
    const warn = (n, detail) => { res.warnings.push(detail); log(`${n}. warn   ${detail}`); };
    for (const [i, step] of j.fetch.entries())
    {
        const n = i + 1;
        const stepEnv = { ...env };
        for (const [k, v] of Object.entries(step.env || {})) stepEnv[k] = expand(v, env);
        log(`${n}. ...    fetching ${step.what} for '${step.name}'`);
        const t0 = Date.now();
        const r = runFetch(step.argv, { cwd, env: stepEnv });
        if (r.error || r.status !== 0)
        {
            const why = r.error ? r.error.message : `exit ${r.status}: ${`${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-2).join(' | ')}`;
            warn(n, `could not fetch ${step.what} for '${step.name}' (${why}) - the registration stays; its first start fetches it and may time out once`);
            continue;
        }
        res.fetched.push(step.what);
        log(`${n}. ok     ${step.what} is in the cache (${Math.round((Date.now() - t0) / 1000)}s)`);

        // the first start, as written: whatever it downloads or builds on top of the package happens now
        const entry = step.scope ? account.readRegistration(step.name, step.scope, cwd, env) : undefined;
        if (!entry || !entry.command) { warn(n, `'${step.name}' is not at ${step.scope || 'a known'} scope any more - not started`); continue; }
        const missing = unsetVar(entry, env);
        if (missing)
        {
            const line = `'${step.name}' not started: \${${missing}} is not set - its first session start with it set does the first-run work`;
            res.skipped.push(line);
            log(`${n}. skip   ${line}`);
            continue;
        }
        log(`${n}. ...    starting '${step.name}' once (a first start can download more, such as a model)`);
        const s = await start(entry, { cwd, env });
        if (s.ok) { res.started.push(step.name); log(`${n}. ok     '${step.name}' answered its first start in ${(s.ms / 1000).toFixed(1)}s`); }
        else warn(n, `'${step.name}' did not answer its first start (${s.why}) - the registration stays; its first session start tries again`);
    }
    res.status = status(j.check, { cwd, env, runCli, log });
    log('', res.warnings.length
        ? `Done, with ${res.warnings.length} warning${res.warnings.length > 1 ? 's' : ''}. Restart Claude Code now so the registrations load.`
        : 'Done. Restart Claude Code now so the registrations load.');
    return res;
}

async function main(argv)
{
    blockingStdio();
    const file = argv[0];
    if (!file) { console.error('usage: fetch.js <fetch.json>'); return 2; }
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`fetch: cannot read ${file} (${e.message})`); return 2; }
    if (j.version !== VERSION || !Array.isArray(j.fetch) || !Array.isArray(j.check) || !j.project) { console.error(`fetch: ${file} is not a fetch file of version ${VERSION}`); return 2; }
    const log = (...a) => console.log(a.join('\n'));
    const res = await run(j, { log });
    // the last script on the command's <tmp>: the folder the fetch file sits in goes with it
    tmpdir.release(path.dirname(path.resolve(file)), log);
    return res.warnings.length ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
module.exports = { job, writeJob, nextLines, run, status, realFetch, realStart, expand, unsetVar };
