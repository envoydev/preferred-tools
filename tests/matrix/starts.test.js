'use strict';
// Do the tools START? The other matrix files prove a registration is written right; this one launches it. Each local
// row is installed through the real CLI in the throwaway world, its packages fetched by fetch.js as the command runs it,
// read back from the file the CLI wrote, and started exactly as written - command, args and env, ${VAR} expanded as
// Claude Code expands it - then sent an MCP `initialize` over stdio. A server passes when it answers with its serverInfo
// within Claude Code's 30-second limit. A remote route is sent the same `initialize` over HTTP with no credentials: an
// answer (200, or 401/403 asking for a sign-in) proves the endpoint is there.
//
//   npm run matrix        (slow on a first run: uvx and npx fetch each package into the throwaway home)
//
// A row this OS is not offered, a missing runtime, a token route with no token, or no network is NOT RUN, with the reason.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const cli = require('../../scripts/claude-cli.js');
const catalogLib = require('../../scripts/catalog.js');
const { plan } = require('../../scripts/plan.js');
const { Harness } = require('../harness.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-start-'));
const h = new Harness({ root });
const catalog = catalogLib.load();
const NETWORK = /could not resolve|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network/i;
const START_MS = 600000;
// Claude Code's own limit for a server's first answer (`claude mcp get` reports 'timed out after 30000ms' past it)
const CLAUDE_MS = 30000;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preferred-tools-matrix', version: '0' } } };

const children = [];
const stop = (child) =>
{
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
};
test.after(() => { children.forEach(stop); fs.rmSync(root, { recursive: true, force: true }); });

const which = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
// ${VAR} and ${VAR:-default}, as Claude Code expands them in an MCP entry
const expand = (s, env) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => (env[k] !== undefined ? env[k] : d !== undefined ? d : ''));

// -> { ok, info?, why?, ms }: the server's own answer to initialize, or what it printed before it gave up
function initialize(entry, cwd)
{
    return new Promise((resolve) =>
    {
        const env = { ...h.env };
        for (const [k, v] of Object.entries(entry.env || {})) env[k] = expand(v, h.env);
        const args = (entry.args || []).map((a) => expand(a, h.env));
        const child = spawn(expand(entry.command, h.env), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        children.push(child);
        let out = '';
        let err = '';
        const t0 = Date.now();
        const done = (r) => { clearTimeout(timer); stop(child); resolve({ ...r, ms: Date.now() - t0 }); };
        const timer = setTimeout(() => done({ ok: false, why: `no answer in ${START_MS / 1000}s; stderr: ${err.slice(-400)}` }), START_MS);
        child.on('error', (e) => done({ ok: false, why: e.message }));
        child.on('exit', (code) => done({ ok: false, why: `exited ${code} before answering; stderr: ${err.slice(-600)}` }));
        child.stderr.on('data', (d) => { err += d; });
        child.stdout.on('data', (d) =>
        {
            out += d;
            for (const line of out.split('\n'))
            {
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id === 1 && msg.result) return done({ ok: true, info: msg.result.serverInfo || {} });
                if (msg.id === 1 && msg.error) return done({ ok: false, why: `initialize error: ${JSON.stringify(msg.error)}` });
            }
        });
        child.stdin.write(`${JSON.stringify(INIT)}\n`);
    });
}

// The local rows, with what each needs before it can start at all.
const LOCAL = [
    { row: 'serena', needs: ['uvx'] },
    { row: 'memory', needs: ['uvx'] },
    { row: 'context7', route: 'local', needs: ['npx'] },
    { row: 'playwright-chrome', needs: ['npx'] },
    { row: 'appium', needs: ['npx'] },
    { row: 'macos-control', needs: ['uvx'] },
    { row: 'windows-control', needs: ['uvx'] },
    { row: 'sentry', route: 'local', needs: ['npx'], token: 'SENTRY_ACCESS_TOKEN' },
    { row: 'github', route: 'local', needs: ['docker'], token: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
];

for (const c of LOCAL)
{
    const row = catalog.byId.get(c.row);
    test(`starts: ${c.row}${c.route ? ` (${c.route})` : ''} answers initialize, launched from its registration as read`, { skip: skipAll, timeout: START_MS + 120000 }, async (t) =>
    {
        if (!row.os.includes(process.platform)) return t.skip(`NOT RUN: ${c.row} is offered on ${row.os.join(', ')}, this is ${process.platform}`);
        const missing = c.needs.filter((b) => !which(b));
        if (missing.length) return t.skip(`NOT RUN: ${missing.join(', ')} not on PATH`);
        if (c.token && !process.env[c.token]) return t.skip(`NOT RUN: the route needs \${${c.token}}, which is not set (a real token; none is written by this plugin)`);

        const p = h.project(`start-${c.row}`);
        const name = `start-${c.row}`;
        const r = h.run(p, { picks: { [c.row]: { scope: 'local', name, ...(c.route ? { route: c.route } : {}) } } });
        assert.deepStrictEqual(r.plan.errors, []);
        assert.strictEqual(r.report.failed, null, r.text);
        const reg = h.inventory(p).registrations.find((x) => x.name === name && x.scope === 'local');
        assert.ok(reg, 'read back from the account file');
        if (c.row === 'serena')
        {
            // never open a browser tab on the machine running the matrix (fetch.js starts it too)
            const a = reg.entry.args;
            if (a[a.indexOf('--enable-web-dashboard') + 1] !== 'false') return t.skip('NOT RUN: the registration does not turn the web dashboard off, so starting it would open a browser');
        }
        // fetch.js as the command runs it: the fetch, the first start with no 30-second limit, the status
        assert.ok(r.report.fetchFile, `apply wrote no fetch file:\n${r.text}`);
        const f = await h.fetch(r.report.fetchFile);
        if (f.warnings.some((w) => NETWORK.test(w))) return t.skip(`NOT RUN: no network (${f.warnings[0].slice(0, 160)})`);
        assert.deepStrictEqual(f.warnings, [], f.text);
        t.diagnostic(`${c.row}: ${f.text.split('\n').filter((l) => /ok |skip |: Status/.test(l)).map((l) => l.trim()).join('; ')}`);
        assert.match(f.status[0].out, /Connected/, `claude mcp get after fetch.js: ${f.status[0].out}`);
        // then a start as the next session makes it, inside Claude Code's 30 seconds
        const got = await initialize(reg.entry, p);
        if (!got.ok && NETWORK.test(got.why)) return t.skip(`NOT RUN: no network (${got.why.slice(0, 160)})`);
        assert.ok(got.ok, `${c.row} did not start: ${got.why}`);
        t.diagnostic(`${c.row} on ${process.platform}: ${`${got.info.name || '?'} ${got.info.version || ''}`.trim()}, answered in ${(got.ms / 1000).toFixed(1)}s after fetch.js`);
        assert.ok(got.ms <= CLAUDE_MS, `${c.row} answered in ${got.ms} ms, past Claude Code's ${CLAUDE_MS} ms, even after fetch.js`);
        h.claude(p, ['mcp', 'remove', name, '-s', 'local']);
    });
}

// The remote routes: the endpoint as the plan builds it, sent initialize with no credentials.
for (const id of catalog.tools.filter((r) => r.kind === 'mcp' && r.routes.remote).map((r) => r.id))
{
    test(`answers: ${id} (remote) - the endpoint takes an MCP initialize`, { skip: skipAll, timeout: 60000 }, async (t) =>
    {
        const pl = plan({ version: 1, os: process.platform, arch: process.arch, project: root, cli: { ok: true }, unreadable: [], registrations: [], plugins: [], marketplaces: [], alfredCodeEnabled: false, sources: {} }, { picks: { [id]: { route: 'remote', scope: 'local' } } }, { home: h.home, env: {} });
        const add = pl.steps.find((s) => s.op === 'mcp-add');
        assert.ok(add && add.entry.url, JSON.stringify(pl.errors));
        let res;
        try
        {
            res = await fetch(add.entry.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(INIT), signal: AbortSignal.timeout(30000) });
        }
        catch (e) { return t.skip(`NOT RUN: no network (${e.message})`); }
        assert.ok([200, 401, 403].includes(res.status), `${add.entry.url} answered HTTP ${res.status}`);
        t.diagnostic(`${id}: ${add.entry.url} -> HTTP ${res.status}${res.status === 200 ? '' : ' (sign-in required, as the route expects)'}`);
    });
}

// The language servers the typescript-lsp and csharp-lsp plugins launch: the binary on PATH, started with --stdio as
// the plugin's lspServers entry starts it, sent an LSP initialize (Content-Length framing). That the plugin itself is
// loaded by a session is the live check's, since no session runs here.
function lspInitialize(command, args)
{
    return new Promise((resolve) =>
    {
        const child = spawn(command, args, { env: h.env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
        children.push(child);
        let buf = Buffer.alloc(0);
        let err = '';
        const done = (r) => { clearTimeout(timer); stop(child); resolve(r); };
        const timer = setTimeout(() => done({ ok: false, why: `no answer in 120s; stderr: ${err.slice(-400)}; stdout: ${buf.toString().slice(-400)}` }), 120000);
        child.on('error', (e) => done({ ok: false, why: e.message }));
        child.on('exit', (code) => done({ ok: false, why: `exited ${code}; stderr: ${err.slice(-400)}` }));
        child.stderr.on('data', (d) => { err += d; });
        // Content-Length framed messages, one after another; a server may log or notify before it answers
        child.stdout.on('data', (d) =>
        {
            buf = Buffer.concat([buf, d]);
            for (;;)
            {
                const end = buf.indexOf('\r\n\r\n');
                if (end < 0) return;
                const len = Number((/content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString()) || [])[1]);
                if (!len || buf.length < end + 4 + len) return;
                const body = buf.subarray(end + 4, end + 4 + len).toString();
                buf = buf.subarray(end + 4 + len);
                let msg;
                try { msg = JSON.parse(body); } catch { continue; }
                if (msg.id === 1 && !msg.method) return done(msg.result ? { ok: true, info: msg.result.serverInfo || {} } : { ok: false, why: JSON.stringify(msg.error) });
            }
        });
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
}

for (const [plugin, bin] of [['typescript-lsp', 'typescript-language-server'], ['csharp-lsp', 'csharp-ls']])
{
    test(`starts: ${bin} (the ${plugin} plugin's server) answers an LSP initialize`, { skip: skipAll, timeout: 180000 }, async (t) =>
    {
        if (!which(bin)) return t.skip(`NOT RUN: ${bin} not on PATH (prereq.js names the install line)`);
        const got = await lspInitialize(bin, bin === 'csharp-ls' ? [] : ['--stdio']);
        assert.ok(got.ok, `${bin} did not start: ${got.why}`);
        t.diagnostic(`${bin} on ${process.platform}: ${got.info.name || bin} ${got.info.version || ''}`.trim());
    });
}

test('the real account is untouched by the start checks', { skip: skipAll }, () =>
{
    const real = h.realUntouched();
    assert.ok(real.ok, `real account changed: ${real.changed.join(', ')}`);
});
