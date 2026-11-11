'use strict';
// The 0.3.0 field fixes end to end: the REAL claude CLI in throwaway homes and accounts (tests/harness.js), a stub HTTP
// MCP server on 127.0.0.1 (tests/fake-mcp-http.js) standing in for a hosted server, every result read back from the
// files the CLI wrote.
//
//   X1  gitlab at project scope with a key: an absolute helper path in the project root, the Key: line names GITLAB_TOKEN
//   X2  playwright-chrome and serena at project scope: their data folders absolute in the root
//   X3  every MCP row for this OS, added in reverse at project scope beside a user's own server: .mcp.json in
//       catalog.order, the user's server last
//   X4  fix on a 0.2.0 project file - relative paths, a relative helper, out of order: absolute and in order, the pins
//       and the cut-off kept
//   X5  a 0.2.0 record of managed servers: the install plan cleans it, and the file is gone after the apply
//   X6  configure answered 'Leave it on its own': one record in the family root; update and fix list it, not checked
//   X7  a refused key: what `claude mcp get` prints for a 401 and a 403 from a hosted server whose key is filled
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../../scripts/claude-cli.js');
const roots = require('../../scripts/roots.js');
const catalogLib = require('../../scripts/catalog.js');
const E = require('../../scripts/entries.js');
const existing = require('../../scripts/existing.js');
const fix = require('../../scripts/fix.js');
const update = require('../../scripts/update.js');
const { REFUSED } = require('../../scripts/apply.js');
const fake = require('../fake-mcp-http.js');
const { Harness } = require('../harness.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const T = { skip: skipAll, timeout: 900000 };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-x-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const KEY = `mx-${crypto.randomBytes(12).toString('hex')}`;
const ok = (r) => { assert.deepStrictEqual(r.plan.errors, [], r.rendered); assert.strictEqual(r.report.failed, null, `${r.rendered}\n${r.text}`); };
const catalog = catalogLib.load();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const servers = (dir) => readJson(path.join(dir, '.mcp.json')).mcpServers;
const arg = (e, flag) => e.args[e.args.indexOf(flag) + 1];
const style = process.platform === 'win32' ? 'win32' : 'posix';
// a world: a throwaway home and account, every project server approved
function world(name)
{
    const h = new Harness({ root: path.join(base, name) });
    fs.writeFileSync(path.join(h.account, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    return h;
}

test('X1 - gitlab at project scope with a key: the helper named by its absolute path in the project root', T, () =>
{
    const h = world('x1');
    const dir = h.project('p');
    const r = h.run(dir, { picks: { gitlab: { scope: 'project', token: true } } });
    ok(r);
    const root = path.join(dir, '.preferred-tools');
    const e = servers(dir).gitlab;
    assert.strictEqual(e.headersHelper, `node ${E.shellArg(path.join(root, roots.FILES.helper), style)} GITLAB_TOKEN Bearer`);
    assert.ok(fs.existsSync(path.join(root, roots.FILES.helper)), 'the helper is in the root');
    assert.match(r.rendered, /^Key: gitlab \(project scope\) - GITLAB_TOKEN;/m);
    assert.match(fs.readFileSync(path.join(root, roots.FILES.secrets), 'utf8'), /^GITLAB_TOKEN=$/m, 'the name, empty, for the user to fill');
});

test('X2 - playwright-chrome and serena at project scope: their data folders absolute in the root', T, () =>
{
    const h = world('x2');
    const dir = h.project('p');
    ok(h.run(dir, { picks: { 'playwright-chrome': { scope: 'project' }, serena: { scope: 'project' } } }));
    const root = path.join(dir, '.preferred-tools');
    const s = servers(dir);
    assert.strictEqual(arg(s['playwright-chrome'], '--user-data-dir'), path.join(root, 'playwright-chrome'));
    assert.strictEqual(arg(s['playwright-chrome'], '--output-dir'), path.join(root, 'playwright-chrome', 'output'));
    assert.strictEqual(s.serena.env.SERENA_HOME, path.join(root, 'serena'));
});

test('X3 - every MCP row for this OS, added in reverse at project scope beside a user\'s own server: .mcp.json in catalog.order', T, () =>
{
    const h = world('x3');
    const dir = h.project('p');
    assert.strictEqual(h.claude(dir, ['mcp', 'add-json', 'mine', JSON.stringify({ command: 'my-server' }), '-s', 'project']).status, 0);
    const mine = servers(dir).mine;
    const rows = catalog.order.filter((id) => catalog.byId.get(id).os.includes(process.platform));
    for (const id of [...rows].reverse())
    {
        const r = h.run(dir, { picks: { [id]: { scope: 'project', token: false } } });
        ok(r);
    }
    assert.deepStrictEqual(Object.keys(servers(dir)), [...rows.map((id) => catalog.byId.get(id).name), 'mine']);
    assert.deepStrictEqual(servers(dir).mine, mine, 'the user\'s entry is left as it was');
});

test('X4 - fix on a 0.2.0 project file: relative paths and helper written absolute, the order fixed, the pins and the cut-off kept', T, () =>
{
    const h = world('x4');
    const dir = h.project('p');
    const ctx = { platform: process.platform, arch: process.arch, env: h.env, home: h.home, project: dir };
    // what 0.2.0 wrote: relative folders, a relative helper, and the servers in the order they were added
    const pw = E.buildEntry(catalog.byId.get('playwright-chrome'), 'local', { rootStr: '.preferred-tools/playwright-chrome', scope: 'project', token: false }, ctx, catalog.rules);
    pw.args = pw.args.map((a) => (a.startsWith('@playwright/mcp@') ? '@playwright/mcp@0.0.70' : a === path.join('.preferred-tools/playwright-chrome', 'output') ? '.preferred-tools/playwright-chrome/output' : a));
    const serena = E.buildEntry(catalog.byId.get('serena'), 'local', { rootStr: '.preferred-tools/serena', scope: 'project', token: false }, ctx, catalog.rules);
    const c7 = { type: 'http', url: catalog.byId.get('context7').routes.remote.url, headersHelper: 'node .preferred-tools/mcp-headers.js CONTEXT7_API_KEY Bearer' };
    for (const [name, entry] of [['playwright-chrome', pw], ['serena', serena], ['context7', c7]])
        assert.strictEqual(h.claude(dir, ['mcp', 'add-json', name, JSON.stringify(entry), '-s', 'project']).status, 0);
    const before = servers(dir);
    const cutoff = arg(before.serena, '--exclude-newer');
    const lines = [];
    const fctx = fix.makeCtx({ inv: h.inventory(dir), env: h.env, data: h.data });
    const found = fix.detectAll(fctx).found.map((f) => f.id);
    for (const id of ['project-relative-path', 'mcp-order']) assert.ok(found.includes(id), `${id} found: ${found.join(', ')}`);
    const res = fix.applyFixes(fctx, ['all'], { tmp: path.join(h.root, 'tmp', 'fix'), log: (...a) => lines.push(a.join(' ')) });
    assert.strictEqual(res.failed, null, lines.join('\n'));
    const after = servers(dir);
    const root = path.join(dir, '.preferred-tools');
    assert.deepStrictEqual(Object.keys(after), ['context7', 'serena', 'playwright-chrome'], 'in catalog order');
    assert.strictEqual(arg(after['playwright-chrome'], '--user-data-dir'), path.join(root, 'playwright-chrome'));
    assert.strictEqual(arg(after['playwright-chrome'], '--output-dir'), path.join(root, 'playwright-chrome', 'output'));
    assert.ok(after['playwright-chrome'].args.includes('@playwright/mcp@0.0.70'), 'the pin as seeded');
    assert.strictEqual(after.serena.env.SERENA_HOME, path.join(root, 'serena'));
    assert.strictEqual(arg(after.serena, '--exclude-newer'), cutoff, 'the cut-off as seeded');
    assert.deepStrictEqual(after.serena.args, before.serena.args, 'serena\'s args as seeded');
    assert.strictEqual(after.context7.headersHelper, `node ${E.shellArg(path.join(root, roots.FILES.helper), style)} CONTEXT7_API_KEY Bearer`);
    const left = fix.detectAll(fix.makeCtx({ inv: h.inventory(dir), env: h.env, data: h.data })).found.map((f) => f.id);
    assert.ok(!left.includes('project-relative-path') && !left.includes('mcp-order'), left.join(', '));
});

test('X5 - a 0.2.0 record of managed servers: the install plan cleans it, and the file is gone after the apply', T, () =>
{
    const h = world('x5');
    const dir = h.project('p');
    const c7 = { type: 'http', url: catalog.byId.get('context7').routes.remote.url };
    assert.strictEqual(h.claude(dir, ['mcp', 'add-json', 'context7', JSON.stringify(c7), '-s', 'project']).status, 0);
    const record = path.join(dir, '.preferred-tools', roots.FILES.record);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ version: 1, servers: [{ name: 'context7', scope: 'project', fingerprint: existing.fingerprintOf(c7, catalog), choice: 'manage' }] }, null, 2));
    const r = h.run(dir, { picks: { 'playwright-chrome': { scope: 'project' } } });
    ok(r);
    const clean = r.plan.steps.find((x) => x.op === 'record-clean' && x.file === record);
    assert.ok(clean, r.rendered);
    assert.deepStrictEqual([clean.entries, clean.keep], [[], []]);
    assert.ok(!fs.existsSync(record), 'the record is gone');
});

test('X6 - configure answered \'Leave it on its own\': one record in the family root; update and fix list it as not checked', T, async () =>
{
    const h = world('x6');
    const dir = h.project('p');
    ok(h.run(dir, { picks: { context7: { scope: 'project', token: false } } }));
    ok(h.run(dir, { existing: { 'mcp:context7~project': 'own' } }));
    const record = path.join(dir, '.preferred-tools', roots.FILES.record);
    assert.deepStrictEqual(readJson(record).servers.map((e) => [e.name, e.scope, e.choice]), [['context7', 'project', 'own']]);
    assert.ok(!fs.existsSync(path.join(h.home, '.preferred-tools', roots.FILES.record)), 'no record in the global root');
    const inv = h.inventory(dir);
    const d = fix.detectAll(fix.makeCtx({ inv, env: h.env, data: h.data }));
    assert.ok(fix.render(d).includes('context7 (project): on its own - not checked'), fix.render(d));
    const out = await update.check(update.makeCtx({ inv, project: dir, env: h.env, refresh: false }));
    assert.ok(out.skipped.includes('context7 (project): on its own - not checked'), out.skipped.join('\n'));
});


test('X7 - a refused key: claude mcp get on a hosted server that answers 401 or 403 with its key filled', T, async () =>
{
    for (const status of [401, 403])
    {
        const h = new Harness({ root: path.join(base, `x7-${status}`) });
        const s = await fake.stub({ expected: `Bearer ${KEY}`, status });
        const catalog = fake.stubCatalog(s.port);
        try
        {
            const dir = h.project('p');
            fake.trust(h, dir);
            ok(h.run(dir, { picks: { github: { route: 'remote', scope: 'local', token: true } } }, { catalog }));
            fake.fill(path.join(dir, '.preferred-tools', roots.FILES.secrets), G, KEY);
            // the first get in a fresh world was once seen to print no Issue line (docs/sources.md): one more get, then the words
            let out = '';
            for (let i = 0; i < 2 && !/^\s*Issue:/m.test(out); i++) out = (await fake.claude(dir, ['mcp', 'get', 'github'], h.env)).out;
            const line = (re) => (out.split('\n').find((l) => re.test(l)) || '').trim();
            console.log(`X7 ${status}: ${line(/Status:/)} | ${line(/Issue:/).slice(0, 120)}`);
            assert.ok(s.seen.some((x) => x.auth === 'expected'), 'the key reached the server');
            assert.strictEqual(line(/Status:/), 'Status: ✘ Failed to connect');
            assert.match(line(/Issue:/), REFUSED);
            assert.ok(!out.includes(KEY), 'the CLI prints no key');
        }
        finally { await s.close(); }
    }
});
