'use strict';
// The key cases end to end (spec D3-D7): the REAL claude CLI in throwaway homes and accounts (tests/harness.js), a stub
// HTTP MCP server on 127.0.0.1 (tests/fake-mcp-http.js) standing in for github's hosted server, and a fake key in the
// throwaway root's .mcps-secrets, filled after the apply wrote its name - as the user does. Every result is read back
// from the files the CLI wrote, and the stub reports whether the key reached it - never the key.
//
//   K1  the helper sends the key at project, local and global scope; the written files hold no key and no ${VAR}
//   K2  a chosen key name (ACME_GITHUB_TOKEN) at project scope
//   K3  an untrusted folder: no header reaches the server, and fix notes the trust
//   K4  the helper deleted: connects without the header; fix finds helper-missing; after the fix the header is back
//   K5  a server matching atlassian at global scope, recorded on its own: update and fix leave it byte-identical
//   K6  update moves a 0.1.x key header to the helper and ignores the key file in git (the user's ruling, 2026-11-12):
//       offered, applied, the key arrives, nothing left to move
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../../scripts/claude-cli.js');
const account = require('../../scripts/account.js');
const roots = require('../../scripts/roots.js');
const E = require('../../scripts/entries.js');
const fix = require('../../scripts/fix.js');
const update = require('../../scripts/update.js');
const fake = require('../fake-mcp-http.js');
const { stubCatalog, trust, fill } = fake;
const { Harness } = require('../harness.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const T = { skip: skipAll, timeout: 600000 };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-keys-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const KEY = `mx-${crypto.randomBytes(12).toString('hex')}`;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ok = (r) => { assert.deepStrictEqual(r.plan.errors, [], r.rendered); assert.strictEqual(r.report.failed, null, `${r.rendered}\n${r.text}`); };

// A world: a throwaway home and account, every project server approved, and the stub
async function world(name)
{
    const h = new Harness({ root: path.join(base, name) });
    fs.writeFileSync(path.join(h.account, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const s = await fake.stub({ expected: `Bearer ${KEY}` });
    return { h, s, catalog: stubCatalog(s.port) };
}

// The registration as the CLI wrote it at its scope
function written(h, dir, scope, name)
{
    if (scope === 'project') return { file: path.join(dir, '.mcp.json'), entry: readJson(path.join(dir, '.mcp.json')).mcpServers[name] };
    const file = account.accountFile(h.env);
    const doc = readJson(file);
    return { file, entry: scope === 'user' ? doc.mcpServers[name] : account.projectEntry(doc.projects, dir).mcpServers[name] };
}

function helperOnly(w)
{
    assert.ok(w.entry && typeof w.entry.headersHelper === 'string', `${w.file}: a headersHelper`);
    assert.ok(!Object.keys(w.entry.headers || {}).some((k) => k.toLowerCase() === 'authorization'), `${w.file}: no Authorization header`);
    const text = JSON.stringify(w.entry);
    assert.ok(!text.includes(KEY), `${w.file}: no key`);
    assert.ok(!text.includes('${'), `${w.file}: no \${VAR}`);
    assert.ok(!fs.readFileSync(w.file, 'utf8').includes(KEY), `${w.file}: the whole file holds no key`);
}

test('K1 - the helper sends the key at project, local and global scope; the written files hold no key and no ${VAR}', T, async () =>
{
    const { h, s, catalog } = await world('k1');
    try
    {
        for (const scope of ['project', 'local', 'user'])
        {
            const dir = h.project(`at-${scope}`);
            trust(h, dir);
            const r = h.run(dir, { picks: { github: { route: 'remote', scope } } }, { catalog });
            ok(r);
            assert.ok(!`${r.rendered}\n${r.text}`.includes(KEY), 'no key printed');
            const root = scope === 'user' ? path.join(h.home, '.preferred-tools') : path.join(dir, '.preferred-tools');
            const secrets = path.join(root, roots.FILES.secrets);
            assert.deepStrictEqual(fs.readFileSync(secrets, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')), [`${G}=`], `${scope}: the apply wrote the name only`);
            assert.strictEqual(roots.helperState(path.join(root, roots.FILES.helper)).state, 'same', `${scope}: the helper in the root`);
            const w = written(h, dir, scope, 'github');
            helperOnly(w);
            assert.deepStrictEqual(await fake.authOnGet(s, dir, 'github', h.env).then((x) => x.auth), 'none', `${scope}: before the user fills the key`);
            fill(secrets, G, KEY);
            const got = await fake.authOnGet(s, dir, 'github', h.env);
            assert.strictEqual(got.auth, 'expected', `${scope}: the key reached the server (${got.status})`);
            helperOnly(written(h, dir, scope, 'github'));
            if (scope === 'user') ok(h.run(dir, { remove: [{ kind: 'mcp', name: 'github', scope: 'user' }] }, { catalog }));
        }
    }
    finally { await s.close(); }
});

test('K2 - a chosen key name (ACME_GITHUB_TOKEN) at project scope', T, async () =>
{
    const { h, s, catalog } = await world('k2');
    try
    {
        const dir = h.project('named');
        trust(h, dir);
        const r = h.run(dir, { picks: { github: { route: 'remote', scope: 'project' } }, keyNames: { github: 'ACME_GITHUB_TOKEN' } }, { catalog });
        ok(r);
        const w = written(h, dir, 'project', 'github');
        helperOnly(w);
        // absolute since 0.3.0 at every scope, project included
        const style = process.platform === 'win32' ? 'win32' : 'posix';
        assert.strictEqual(w.entry.headersHelper, `node ${E.shellArg(path.join(dir, '.preferred-tools', roots.FILES.helper), style)} ACME_GITHUB_TOKEN Bearer`);
        const secrets = path.join(dir, '.preferred-tools', roots.FILES.secrets);
        assert.ok(fs.readFileSync(secrets, 'utf8').split('\n').includes('ACME_GITHUB_TOKEN='), 'the chosen name written');
        fill(secrets, G, 'not-this-one');
        assert.notStrictEqual((await fake.authOnGet(s, dir, 'github', h.env)).auth, 'expected', 'the default name is not read');
        fill(secrets, 'ACME_GITHUB_TOKEN', KEY);
        assert.strictEqual((await fake.authOnGet(s, dir, 'github', h.env)).auth, 'expected');
    }
    finally { await s.close(); }
});

test('K3 - an untrusted folder: no header reaches the server, and fix notes the trust', T, async () =>
{
    const { h, s, catalog } = await world('k3');
    try
    {
        const dir = h.project('untrusted');
        const r = h.run(dir, { picks: { github: { route: 'remote', scope: 'project' } } }, { catalog });
        ok(r);
        fill(path.join(dir, '.preferred-tools', roots.FILES.secrets), G, KEY);
        assert.strictEqual((await fake.authOnGet(s, dir, 'github', h.env)).auth, 'none');
        const notes = fix.detectAll(fix.makeCtx({ inv: h.inventory(dir, { catalog }), catalog, env: h.env, data: h.data })).notes;
        assert.ok(notes.some((n) => n.startsWith('github (project): accept the trust dialog')), notes.join('\n'));
        trust(h, dir);
        assert.strictEqual((await fake.authOnGet(s, dir, 'github', h.env)).auth, 'expected', 'trusted: the key reaches the server');
    }
    finally { await s.close(); }
});

test('K4 - the helper deleted: connects without the header; fix finds helper-missing; after the fix the header is back', T, async () =>
{
    const { h, s, catalog } = await world('k4');
    try
    {
        const dir = h.project('missing');
        trust(h, dir);
        ok(h.run(dir, { picks: { github: { route: 'remote', scope: 'local' } } }, { catalog }));
        const root = path.join(dir, '.preferred-tools');
        fill(path.join(root, roots.FILES.secrets), G, KEY);
        assert.strictEqual((await fake.authOnGet(s, dir, 'github', h.env)).auth, 'expected');
        fs.rmSync(path.join(root, roots.FILES.helper));
        const got = await fake.authOnGet(s, dir, 'github', h.env);
        assert.strictEqual(got.auth, 'none', 'a missing helper: connected without the header');
        const ctx = () => fix.makeCtx({ inv: h.inventory(dir, { catalog }), catalog, env: h.env, data: h.data });
        const found = fix.detectAll(ctx(), { only: 'helper-missing' }).found;
        assert.deepStrictEqual(found.map((f) => [f.id, f.path]), [['helper-missing', path.join(root, roots.FILES.helper)]]);
        const lines = [];
        const res = fix.applyFixes(ctx(), ['helper-missing'], { only: 'helper-missing', tmp: path.join(h.root, 'tmp', 'fix'), log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        assert.strictEqual(roots.helperState(path.join(root, roots.FILES.helper)).state, 'same', 'read back from disk');
        assert.strictEqual((await fake.authOnGet(s, dir, 'github', h.env)).auth, 'expected', 'the header is back');
        assert.ok(!lines.join('\n').includes(KEY), 'no key printed');
    }
    finally { await s.close(); }
});

test('K5 - a server matching atlassian at global scope, recorded on its own: update and fix leave it byte-identical', T, async () =>
{
    const h = new Harness({ root: path.join(base, 'k5') });
    const dir = h.project('own');
    const entry = { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', headers: { 'X-Team': 'mine' } };
    assert.strictEqual(h.claude(dir, ['mcp', 'add-json', 'atl', JSON.stringify(entry), '-s', 'user']).status, 0);
    const before = () => JSON.stringify(readJson(account.accountFile(h.env)).mcpServers.atl);
    const was = before();
    const inv0 = h.inventory(dir);
    assert.ok(inv0.registrations.some((r) => r.name === 'atl' && r.rowId === 'atlassian' && r.scope === 'user'), 'matched to the atlassian row');
    const r = h.run(dir, { existing: { 'mcp:atl~user': 'own' } });
    ok(r);
    const record = readJson(path.join(h.home, '.preferred-tools', roots.FILES.record));
    assert.deepStrictEqual(record.servers.map((e) => [e.name, e.scope, e.choice]), [['atl', 'user', 'own']], 'recorded in the global root');
    assert.strictEqual(readJson(path.join(h.data, roots.FILES.map)).global, path.join(h.home, '.preferred-tools'), 'the roots map names the global root');

    const inv = h.inventory(dir);
    assert.strictEqual(inv.registrations.find((x) => x.name === 'atl').choice, 'own', 'the inventory reads the record');
    const ctx = fix.makeCtx({ inv, env: h.env, data: h.data });
    const d = fix.detectAll(ctx);
    assert.deepStrictEqual(d.own, [{ name: 'atl', scope: 'user' }]);
    assert.ok(!d.found.some((f) => f.name === 'atl'), 'no detector reads it');
    assert.ok(fix.render(d).includes('atl (user): on its own - not checked'));
    const lines = [];
    const res = fix.applyFixes(ctx, ['all'], { only: 'atl', tmp: path.join(h.root, 'tmp', 'fix'), log: (...a) => lines.push(a.join(' ')) });
    assert.strictEqual(res.failed, null, lines.join('\n'));

    const uctx = update.makeCtx({ inv, project: dir, env: h.env, refresh: false });
    const out = await update.check(uctx);
    assert.ok(out.skipped.includes('atl (user): on its own - not checked'), out.skipped.join('\n'));
    assert.ok(!out.offers.some((o) => o.id === 'mcp:atl~user'), 'not offered');
    const u = update.applyUpdates(uctx, ['mcp:atl~user'], out, { tmp: path.join(h.root, 'tmp', 'update'), log: () => {} });
    assert.deepStrictEqual(u.unknown, ['mcp:atl~user'], 'an update by its id is refused');
    assert.strictEqual(before(), was, 'byte-identical');
});

test('K6 - update moves a 0.1.x key header to the helper and keeps the key file out of git: offered, applied with fix\'s code, the key arrives', T, async () =>
{
    const { h, s, catalog } = await world('k6');
    try
    {
        const dir = h.project('upgrade');
        trust(h, dir);
        // as 0.1.x wrote it: the key in an Authorization header, its value from the environment
        const old = { type: 'http', url: catalog.byId.get('github').routes.remote.url, headers: { Authorization: `Bearer \${${G}}` } };
        assert.strictEqual(h.claude(dir, ['mcp', 'add-json', 'github', JSON.stringify(old), '-s', 'local']).status, 0);
        const root = path.join(dir, '.preferred-tools');
        fs.mkdirSync(root, { recursive: true });
        fill(path.join(root, roots.FILES.secrets), G, KEY);
        const uctx = update.makeCtx({ inv: h.inventory(dir, { catalog }), project: dir, catalog, env: h.env, refresh: false, data: h.data });
        const out = await update.check(uctx);
        // the project is a git work tree and the root a 0.1.x folder with no .gitignore: both ways are offered
        const ids = out.offers.filter((o) => o.kind === 'upgrade').map((o) => o.id);
        assert.deepStrictEqual(ids, ['upgrade:key-to-helper:github~local', `upgrade:root-ignore:${root}`], update.render(out));
        assert.match(update.render(out), /New ways to pass data:\n {2}github \(local\) +key-to-helper: /);
        const lines = [];
        const res = update.applyUpdates(uctx, ids, out, { tmp: path.join(h.root, 'tmp', 'update'), log: (...a) => lines.push(a.join(' ')) });
        assert.deepStrictEqual(res.applied, ids, lines.join('\n'));
        const ignored = (f) => require('node:child_process').spawnSync('git', ['check-ignore', '-q', f], { cwd: dir }).status === 0;
        assert.ok(ignored(path.join(root, roots.FILES.secrets)), 'git ignores the key file');
        assert.ok(!ignored(path.join(root, roots.FILES.helper)), 'git keeps the helper a project-scope server would need');
        helperOnly(written(h, dir, 'local', 'github'));
        assert.strictEqual(roots.helperState(path.join(root, roots.FILES.helper)).state, 'same', 'the helper in the project root');
        const got = await fake.authOnGet(s, dir, 'github', h.env);
        assert.strictEqual(got.auth, 'expected', `the key reached the server through the helper (${got.status})`);
        assert.ok(!lines.join('\n').includes(KEY), 'no key printed');
        const again = await update.check(update.makeCtx({ inv: h.inventory(dir, { catalog }), project: dir, catalog, env: h.env, refresh: false, data: h.data }));
        assert.deepStrictEqual(again.offers.filter((o) => o.kind === 'upgrade').map((o) => `${o.id}: ${o.found}`), [], 'nothing left to move');
    }
    finally { await s.close(); }
});
