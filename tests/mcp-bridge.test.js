'use strict';
// mcp-bridge.js - the bridge a hosted route of runtime 'bridge' registers (0.4.0): it fills the URL template from
// .mcps-secrets at each start and runs a pinned mcp-remote through npx, the key in mcp-remote's environment only.
// Each process case copies the bridge and the helper into a throwaway root and runs it with PATH led by this file's own
// `npx` shim (tests/fake-runtime.js), which logs its argv and a SHA-256 of the key, never the key.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'scripts', 'mcp-bridge.js');
const HELPER = path.join(__dirname, '..', 'scripts', 'mcp-headers.js');
const RUNTIME = path.join(__dirname, 'fake-runtime.js');
const T = 'https://mcp.sentry.dev/mcp/{SENTRY_ORG}/{SENTRY_PROJECT?}';
const LOCAL = 'http://127.0.0.1:9/mcp/{SENTRY_ORG}/{SENTRY_PROJECT?}';
const KEY = 'pt-key-7q';
const K = 'SENTRY_ACCESS_TOKEN';
const PKG = 'mcp-remote@0.16.0';
const ARGS_TAIL = ['--header', 'Authorization:${PT_BRIDGE_AUTH}', '--transport', 'http-only'];
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sec = (dir) => path.join(dir, '.mcps-secrets');

const bridge = () => require(BRIDGE);
const helper = () => require(HELPER);

function world()
{
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bridge-')));
    const project = path.join(dir, 'project');
    const root = path.join(project, '.preferred-tools');
    const global = path.join(dir, 'global');
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    for (const d of [root, global, home, bin]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(BRIDGE, path.join(root, 'mcp-bridge.js'));
    fs.copyFileSync(HELPER, path.join(root, 'mcp-headers.js'));
    // only an npx shim: the shared fake world has none, so no other test's starts change
    const shim = path.join(bin, process.platform === 'win32' ? 'npx.cmd' : 'npx');
    if (process.platform === 'win32') fs.writeFileSync(shim, `@echo off\r\nnode "${RUNTIME}" npx %*\r\n`);
    else { fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${RUNTIME}" npx "$@"\n`); fs.chmodSync(shim, 0o755); }
    const log = path.join(dir, 'npx.jsonl');
    const env = (extra = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_RUNTIME_LOG: log, ...extra });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const run = (argv, extra) => spawnSync(process.execPath, [path.join(root, 'mcp-bridge.js'), ...argv], { cwd: project, encoding: 'utf8', env: env(extra), input: '' });
    return { dir, project, root, global, home, log, env, calls, run, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('templateNames reads required and a last optional segment, and refuses the rest', () => {
    const { templateNames } = bridge();
    assert.deepStrictEqual(templateNames(T), [{ name: 'SENTRY_ORG', optional: false }, { name: 'SENTRY_PROJECT', optional: true }]);
    assert.deepStrictEqual(templateNames('https://mcp.sentry.dev/mcp/{SENTRY_ORG}'), [{ name: 'SENTRY_ORG', optional: false }]);
    for (const bad of ['https://h/mcp/{A?}/{B}', 'https://h/mcp/x{A}', 'https://h/mcp/{A}?q=1', 'https://h/mcp/{A}#f', 'https://{A}/mcp', 'https://h/mcp/{1A}', 'https://h/mcp/{A}/{A}'])
        assert.strictEqual(templateNames(bad), null, bad);
});

test('fillTemplate drops an empty optional segment and refuses a value that is not a slug', () => {
    const { fillTemplate } = bridge();
    assert.deepStrictEqual(fillTemplate(T, { SENTRY_ORG: 'acme', SENTRY_PROJECT: 'web' }), { url: 'https://mcp.sentry.dev/mcp/acme/web' });
    assert.deepStrictEqual(fillTemplate(T, { SENTRY_ORG: 'acme', SENTRY_PROJECT: '' }), { url: 'https://mcp.sentry.dev/mcp/acme' });
    assert.deepStrictEqual(fillTemplate(T, { SENTRY_ORG: 'acme' }), { url: 'https://mcp.sentry.dev/mcp/acme' });
    const none = fillTemplate(T, {});
    assert.ok(none.error && none.error.includes('SENTRY_ORG'), JSON.stringify(none));
    for (const bad of ['acme&calc', '../x', 'a b', '-x'])
    {
        const r = fillTemplate(T, { SENTRY_ORG: bad });
        assert.ok(r.error && r.error.includes('SENTRY_ORG'), `${bad}: ${JSON.stringify(r)}`);
        assert.ok(!r.error.includes(bad), `the value stays out of the error: ${r.error}`);
    }
});

test('launch reads each name from the chain: the key from the global root, the slug beside the bridge', () => {
    const w = world();
    try
    {
        put(sec(w.root), 'SENTRY_ORG=acme\n');
        put(sec(w.global), `${K}=${KEY}\n`);
        const r = bridge().launch([T, K, 'Sentry-Bearer', PKG, w.global], { HOME: w.home }, { dir: w.root, platform: 'darwin' });
        assert.ok(!r.error, r.error);
        assert.strictEqual(r.url, 'https://mcp.sentry.dev/mcp/acme');
        assert.strictEqual(r.auth, `Sentry-Bearer ${KEY}`);
        assert.strictEqual(r.keyName, K);
        assert.strictEqual(r.keyFile, sec(w.global));
        assert.strictEqual(r.command, 'npx');
        assert.deepStrictEqual(r.args, ['-y', PKG, r.url, ...ARGS_TAIL]);
        assert.strictEqual(r.childEnv.PT_BRIDGE_AUTH, `Sentry-Bearer ${KEY}`);
        assert.ok(r.args.every((a) => !a.includes(KEY)), 'no arg holds the key');
        const win = bridge().launch([T, K, 'Sentry-Bearer', PKG, w.global], { HOME: w.home, ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, { dir: w.root, platform: 'win32' });
        assert.strictEqual(win.command, 'C:\\Windows\\system32\\cmd.exe');
        assert.deepStrictEqual(win.args, ['/d', '/c', 'npx', '-y', PKG, 'https://mcp.sentry.dev/mcp/acme', ...ARGS_TAIL]);
    }
    finally { w.clean(); }
});

test('an optional name left empty in the nearest file that has it ends the search: the whole organization (review I3)', () => {
    const w = world();
    const at = () => bridge().launch([T, K, 'Sentry-Bearer', PKG, w.global], { HOME: w.home }, { dir: w.root, platform: 'darwin' });
    try
    {
        // the README's 'leave it empty for the whole organization', with another project's slug in the global root
        put(sec(w.root), 'SENTRY_ORG=acme\nSENTRY_PROJECT=\n');
        put(sec(w.global), `${K}=${KEY}\nSENTRY_PROJECT=other-web\n`);
        assert.strictEqual(at().url, 'https://mcp.sentry.dev/mcp/acme');
        // a file without the line does not end it
        put(sec(w.root), 'SENTRY_ORG=acme\n');
        assert.strictEqual(at().url, 'https://mcp.sentry.dev/mcp/acme/other-web');
        // a required name, like the key, takes the first non-empty value
        put(sec(w.root), 'SENTRY_ORG=\nSENTRY_PROJECT=\n');
        put(sec(w.global), `${K}=${KEY}\nSENTRY_ORG=beta\nSENTRY_PROJECT=other-web\n`);
        assert.strictEqual(at().url, 'https://mcp.sentry.dev/mcp/beta');
    }
    finally { w.clean(); }
});

test('launch refuses http to a host that is not loopback', () => {
    const w = world();
    try
    {
        put(sec(w.root), `SENTRY_ORG=acme\n${K}=${KEY}\n`);
        const at = (t) => bridge().launch([t, K, 'Sentry-Bearer', PKG], { HOME: w.home }, { dir: w.root, platform: 'darwin' });
        assert.ok(at('http://example.com/mcp/{SENTRY_ORG}').error, 'a remote host over http');
        assert.ok(at('http://[::1]/mcp/{SENTRY_ORG}').error, 'mcp-remote takes only 127.0.0.1 and localhost');
        const ok = at('http://127.0.0.1:9/mcp/{SENTRY_ORG}');
        assert.ok(!ok.error, ok.error);
        assert.strictEqual(ok.url, 'http://127.0.0.1:9/mcp/acme');
    }
    finally { w.clean(); }
});

test('launch refuses a URL name that is the key or a credential name, before reading any file (Review Focus 1)', () => {
    const w = world();
    try
    {
        // no file at all: the refusal comes before any read
        const at = (t) => bridge().launch([t, K, 'Sentry-Bearer', PKG], { HOME: w.home }, { dir: w.root, platform: 'darwin' });
        assert.strictEqual(at(`https://mcp.sentry.dev/mcp/{${K}}`).error, `${K} in the URL template names a key - a key never goes in a URL`);
        assert.strictEqual(at('https://mcp.sentry.dev/mcp/{MY_API_KEY}').error, 'MY_API_KEY in the URL template names a key - a key never goes in a URL');
        assert.ok(!/names a key/.test(at('https://mcp.sentry.dev/mcp/{SENTRY_ORG}').error || ''), 'a plain name is not refused as a key');
    }
    finally { w.clean(); }
});

test('the bridge starts mcp-remote with the key in its env only', () => {
    const w = world();
    try
    {
        put(sec(w.root), `SENTRY_ORG=acme\nSENTRY_PROJECT=web\n${K}=${KEY}\n`);
        const r = w.run([LOCAL, K, 'Sentry-Bearer', PKG]);
        assert.strictEqual(r.status, 0, r.stderr);
        const calls = w.calls();
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].argv, ['-y', PKG, 'http://127.0.0.1:9/mcp/acme/web', ...ARGS_TAIL]);
        assert.strictEqual(calls[0].authSha256, sha(`Sentry-Bearer ${KEY}`));
        for (const text of [r.stdout, r.stderr, fs.readFileSync(w.log, 'utf8'), ...calls[0].argv]) assert.ok(!text.includes(KEY), 'the key is nowhere but the env');
    }
    finally { w.clean(); }
});

test('a missing key exits 1 before npx starts, naming the files (Review Focus 2)', () => {
    const w = world();
    try
    {
        put(sec(w.root), 'SENTRY_ORG=acme\n');
        const r = w.run([T, K, 'Sentry-Bearer', PKG]);
        assert.strictEqual(r.status, 1);
        const lines = r.stderr.trim().split('\n');
        assert.strictEqual(lines.length, 1, r.stderr);
        assert.ok(lines[0].startsWith(`mcp-bridge: no value for ${K} in ${sec(w.root)}, `), lines[0]);
        assert.deepStrictEqual(w.calls(), [], 'npx never ran');
    }
    finally { w.clean(); }
});

test('a bridge beside helper 3, or with no helper, exits 1 naming /preferred-tools:fix (Review Focus 3)', () => {
    const w = world();
    try
    {
        put(sec(w.root), `SENTRY_ORG=acme\n${K}=${KEY}\n`);
        fs.writeFileSync(path.join(w.root, 'mcp-headers.js'), "'use strict';\nmodule.exports = { HELPER_VERSION: 3 };\n");
        const r = w.run([T, K, 'Sentry-Bearer', PKG]);
        assert.strictEqual(r.status, 1);
        assert.strictEqual(r.stderr.trim(), 'mcp-bridge: mcp-headers.js beside it is helper 3 - the bridge needs 4; run /preferred-tools:fix');
        fs.rmSync(path.join(w.root, 'mcp-headers.js'));
        const gone = w.run([T, K, 'Sentry-Bearer', PKG]);
        assert.strictEqual(gone.status, 1);
        assert.strictEqual(gone.stderr.trim(), 'mcp-bridge: mcp-headers.js beside it is helper missing - the bridge needs 4; run /preferred-tools:fix');
        assert.deepStrictEqual(w.calls(), []);
    }
    finally { w.clean(); }
});

test('a bad value, or a usage error, exits 1 with one line naming no value', () => {
    const w = world();
    try
    {
        put(sec(w.root), `SENTRY_ORG=acme&calc\n${K}=${KEY}\n`);
        const bad = w.run([T, K, 'Sentry-Bearer', PKG]);
        assert.strictEqual(bad.status, 1);
        assert.strictEqual(bad.stderr.trim(), `mcp-bridge: SENTRY_ORG in ${sec(w.root)} is not a plain name (letters, digits, _ . -)`);
        const usage = w.run([T, K]);
        assert.strictEqual(usage.status, 1);
        assert.strictEqual(usage.stderr.trim(), 'mcp-bridge: usage: node mcp-bridge.js <url template> <KEY_NAME> <SCHEME> <package@version> [<root>]');
        assert.deepStrictEqual(w.calls(), []);
    }
    finally { w.clean(); }
});

const waitFor = async (check, ms = 5000) =>
{
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
    return null;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('SIGTERM to the bridge, or its stdin closing, ends mcp-remote and the bridge', { skip: process.platform === 'win32' }, async () => {
    const w = world();
    try
    {
        put(sec(w.root), `SENTRY_ORG=acme\n${K}=${KEY}\n`);
        const start = () =>
        {
            const p = spawn(process.execPath, [path.join(w.root, 'mcp-bridge.js'), LOCAL, K, 'Sentry-Bearer', PKG], { cwd: w.project, env: w.env({ FAKE_RUNTIME_WAIT: '1' }), stdio: ['pipe', 'ignore', 'ignore'] });
            const exited = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
            return { p, exited };
        };
        const a = start();
        const first = await waitFor(() => w.calls()[0]);
        assert.ok(first, 'mcp-remote started');
        const sent = Date.now();
        a.p.kill('SIGTERM');
        const ea = await a.exited;
        assert.ok(ea.at - sent < 2000, 'the bridge exits within 2 s');
        assert.ok(await waitFor(() => !alive(first.pid), 2000), 'mcp-remote is gone');

        const b = start();
        const second = await waitFor(() => w.calls()[1]);
        assert.ok(second, 'mcp-remote started again');
        b.p.stdin.end();
        const eb = await b.exited;
        assert.strictEqual(eb.code, 0, 'the child saw its stdin end and exited 0, and so did the bridge');
        assert.ok(await waitFor(() => !alive(second.pid), 2000));
    }
    finally { w.clean(); }
});

test('a root under a type-module package.json runs with its own commonjs package.json (Review Focus 5)', () => {
    const w = world();
    try
    {
        put(sec(w.root), `SENTRY_ORG=acme\n${K}=${KEY}\n`);
        put(path.join(w.project, 'package.json'), '{ "type": "module" }\n');
        const esm = w.run([LOCAL, K, 'Sentry-Bearer', PKG]);
        assert.notStrictEqual(esm.status, 0, 'loaded as ESM, the CommonJS bridge fails');
        assert.deepStrictEqual(w.calls(), [], 'before npx');
        put(path.join(w.root, 'package.json'), '{"type":"commonjs"}\n');
        const cjs = w.run([LOCAL, K, 'Sentry-Bearer', PKG]);
        assert.strictEqual(cjs.status, 0, cjs.stderr);
        assert.strictEqual(w.calls().length, 1);
    }
    finally { w.clean(); }
});

test('the bridge requires only node: modules and ./mcp-headers.js, and its CREDENTIAL equals keys.js', () => {
    const src = fs.readFileSync(BRIDGE, 'utf8');
    assert.match(src.split('\n')[0], /^\/\/ preferred-tools mcp-bridge 1$/);
    const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(reqs.length && reqs.every((r) => r.startsWith('node:') || r === './mcp-headers.js'), reqs.join(', '));
    const b = bridge();
    assert.strictEqual(b.BRIDGE_VERSION, 1);
    assert.strictEqual(b.NEEDS_HELPER, 4);
    assert.ok(b.CREDENTIAL.test('MY_API_KEY') && !b.CREDENTIAL.test('SENTRY_ORG'));
    assert.strictEqual(helper().HELPER_VERSION, 4);
});
