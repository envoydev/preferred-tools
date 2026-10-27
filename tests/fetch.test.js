'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { world, writeJson } = require('./helpers.js');
const E = require('../scripts/entries.js');
const fetchLib = require('../scripts/fetch.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fetch.js');
const NPX = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '/p/a'] };
const UVX = { command: 'uvx', args: ['--python', '3.13', '--exclude-newer', '2026-10-20', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server', '--context', 'claude-code'] };

test('a fetch step fetches exactly what the registration launches, and nothing for a launch with nothing to fetch', () => {
    assert.deepStrictEqual(E.fetchStep('pw', NPX, 'playwright-chrome').argv, ['npm', 'exec', '--yes', '--package', '@playwright/mcp@0.0.83', '--', 'node', '-e', '0']);
    const uvx = E.fetchStep('serena', UVX, 'serena');
    assert.deepStrictEqual(uvx.argv, ['uvx', '--python', '3.13', '--exclude-newer', '2026-10-20', '--from', 'serena-agent@2.1.0', 'serena', '--help'], 'the same python, cut-off and pin; the tool runs nothing but --help');
    assert.strictEqual(uvx.what, 'serena-agent@2.1.0');
    const docker = E.fetchStep('gh', { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v1.2.3'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' } }, 'github');
    assert.deepStrictEqual(docker.argv, ['docker', 'pull', 'ghcr.io/github/github-mcp-server:v1.2.3']);
    // Windows: cmd /c stays in front, so npx.cmd resolves the way the registration resolves it
    assert.deepStrictEqual(E.fetchStep('pw', { command: 'cmd', args: ['/c', 'npx', ...NPX.args] }).argv.slice(0, 4), ['cmd', '/c', 'npm', 'exec']);
    assert.strictEqual(E.fetchStep('c7', { type: 'http', url: 'https://mcp.context7.com/mcp' }), null, 'a hosted URL');
    assert.strictEqual(E.fetchStep('ls', { command: 'csharp-ls' }), null, 'a binary');
});

test('a change that keeps the package fetches nothing; a new pin, a new python or a new cut-off is fetched', () => {
    const moved = { ...NPX, args: NPX.args.map((a) => (a === '/p/a' ? '/h/b' : a)) };
    assert.strictEqual(E.fetchStep('pw', moved, 'playwright-chrome', NPX), null, 'a location change');
    assert.ok(E.fetchStep('pw', { ...NPX, args: NPX.args.map((a) => a.replace('0.0.83', '0.0.90')) }, 'playwright-chrome', NPX), 'a new pin');
    assert.ok(E.fetchStep('serena', { ...UVX, args: UVX.args.map((a) => (a === '3.13' ? '3.12' : a)) }, 'serena', UVX), 'a python request');
    assert.ok(E.fetchStep('serena', { ...UVX, args: UVX.args.map((a) => (a === '2026-10-20' ? '2026-10-27' : a)) }, 'serena', UVX), 'a cut-off');
    assert.ok(E.fetchStep('pw', NPX, 'playwright-chrome', { type: 'http', url: 'https://x/mcp' }), 'a hosted route that becomes a local one');
});

test('fetch.js fetches and then starts each server in turn, from its registration as read, then asks the CLI for each status', async () => {
    const w = world();
    try
    {
        const TOKEN = { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: '${PT_UNSET_TOKEN}' } };
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { pw: NPX, serena: UVX, sentry: TOKEN } });
        const steps = [
            { ...E.fetchStep('pw', NPX, 'playwright-chrome'), scope: 'project' },
            { ...E.fetchStep('serena', UVX, 'serena'), env: { UV_CACHE_DIR: '${PT_TEST_CACHE:-/fallback}' }, scope: 'project' },
            { ...E.fetchStep('sentry', TOKEN, 'sentry'), scope: 'project' },
        ];
        const file = fetchLib.writeJob(path.join(w.dir, 'tmp', 'fetch.json'), fetchLib.job(w.project, steps, ['pw', 'serena', 'sentry', 'c7', 'pw']));
        const order = [];
        const env = { ...w.env, PT_TEST_CACHE: '/set' };
        delete env.PT_UNSET_TOKEN;
        const res = await fetchLib.run(JSON.parse(fs.readFileSync(file, 'utf8')), {
            env,
            runFetch: (argv, o) => { order.push(['fetch', argv[0], o.env.UV_CACHE_DIR, o.cwd]); return { status: 0 }; },
            start: async (entry, o) => { order.push(['start', entry.command, o.cwd]); return { ok: true, ms: 1200 }; },
            log: () => {},
        });
        assert.deepStrictEqual(order, [
            ['fetch', 'npm', w.env.UV_CACHE_DIR, w.project], ['start', 'npx', w.project],
            ['fetch', 'uvx', '/set', w.project], ['start', 'uvx', w.project],
            ['fetch', 'npm', w.env.UV_CACHE_DIR, w.project],
        ], 'one at a time, each fetch then its start, ${VAR} expanded; a start that needs an unset variable is left out');
        assert.deepStrictEqual(res.started, ['pw', 'serena']);
        assert.match(res.skipped[0], /'sentry' not started: \$\{PT_UNSET_TOKEN\} is not set/);
        assert.deepStrictEqual(res.warnings, []);
        assert.deepStrictEqual(res.status.map((s) => s.name), ['pw', 'serena', 'sentry', 'c7'], 'each server once');
        assert.deepStrictEqual(w.calls().filter((a) => a[1] === 'get').map((a) => a[2]), ['pw', 'serena', 'sentry', 'c7']);
        assert.deepStrictEqual(w.writes(), [], 'fetch.js writes no registration');
    }
    finally { w.clean(); }
});

test('the CLI form: a real first start is answered and stopped; a failed fetch or start is a warning that changes nothing (exit 1); a bad file exits 2', () => {
    const w = world();
    try
    {
        const server = (mode) => ({ command: process.execPath, args: [path.join(__dirname, 'fake-mcp-server.js'), mode] });
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { pw: server('answer'), bad: server('exit') } });
        const pw = { ...E.fetchStep('pw', NPX, 'playwright-chrome'), scope: 'project' };
        const bad = { ...E.fetchStep('bad', UVX, 'serena'), name: 'bad', scope: 'project' };
        const okFile = fetchLib.writeJob(path.join(w.dir, 'ok.json'), fetchLib.job(w.project, [pw], ['pw']));
        const ok = spawnSync(process.execPath, [SCRIPT, okFile], { encoding: 'utf8', env: w.env, timeout: 60000 });
        assert.strictEqual(ok.status, 0, `${ok.stdout}${ok.stderr}`);
        assert.deepStrictEqual(w.fetches().map((f) => f.runtime), ['npm'], 'the runtime on PATH, the fake one here');
        assert.match(ok.stdout, /1\. ok {5}@playwright\/mcp@0\.0\.83 is in the cache/);
        assert.match(ok.stdout, /1\. ok {5}'pw' answered its first start in \d+\.\ds/);
        assert.match(ok.stdout, /Done\. Restart Claude Code now/);
        const badFile = fetchLib.writeJob(path.join(w.dir, 'bad.json'), fetchLib.job(w.project, [pw, bad], ['pw', 'bad']));
        const r = spawnSync(process.execPath, [SCRIPT, badFile], { encoding: 'utf8', env: { ...w.env, FAKE_RUNTIME_FAIL: 'npm' }, timeout: 60000 });
        assert.strictEqual(r.status, 1);
        assert.match(r.stdout, /1\. warn {3}could not fetch @playwright\/mcp@0\.0\.83 for 'pw' \(exit 1: npm: fake failure\) - the registration stays/);
        assert.doesNotMatch(r.stdout, /starting 'pw'/, 'nothing fetched, nothing started');
        assert.match(r.stdout, /2\. ok {5}serena-agent@2\.1\.0 is in the cache/, 'the next one still runs');
        assert.match(r.stdout, /2\. warn {3}'bad' did not answer its first start \(exited 3 before answering: fake server: cannot start\)/);
        assert.match(r.stdout, /Done, with 2 warnings\./);
        assert.deepStrictEqual(w.writes(), []);
        writeJson(path.join(w.dir, 'other.json'), { version: 9 });
        assert.strictEqual(spawnSync(process.execPath, [SCRIPT, path.join(w.dir, 'other.json')], { encoding: 'utf8', env: w.env }).status, 2);
        assert.strictEqual(spawnSync(process.execPath, [SCRIPT, path.join(w.dir, 'missing.json')], { encoding: 'utf8', env: w.env }).status, 2);
    }
    finally { w.clean(); }
});

test('a first start that never answers is stopped at its limit, with everything it started', async () => {
    const w = world();
    try
    {
        const marker = path.join(w.dir, 'child.pid');
        // a server that starts a child of its own and never answers
        const entry = { command: process.execPath, args: ['-e', `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`] };
        const s = await fetchLib.realStart(entry, { cwd: w.project, env: w.env, ms: 1500 });
        assert.strictEqual(s.ok, false);
        assert.match(s.why, /no answer in 1\.5s/);
        const pid = Number(fs.readFileSync(marker, 'utf8'));
        const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
        for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(alive(), false, 'the server\'s own child is gone too');
    }
    finally { w.clean(); }
});
