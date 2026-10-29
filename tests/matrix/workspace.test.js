'use strict';
// The workspace cases end to end: the REAL claude CLI in throwaway homes and accounts (tests/harness.js), alfred-code
// built by its own installer where a case needs it (tests/probes/alfred-workspace.js), every result read back from the
// files the CLI wrote.
//
//   W1  no alfred-code: a parent folder's .mcp.json, its server seen inherited from the child, the child's own copy
//   W2  alfred-code solo, root and child: the same steps, a pasted key moved by configure, a server of the user's own,
//       and every file alfred-code wrote left as it was
//   W3  a subfolder session: the project file and the local key land where Claude Code puts them (M4)
//   W4  key files: the key written in from the file the scope reads, ${VAR} at project scope, token-sync after a change
//
// alfred-code's source is --alfred, else PREFERRED_TOOLS_ALFRED, else ../alfred-code (Global Constraints); a version it
// cannot resolve is NOT RUN, named.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../../scripts/claude-cli.js');
const account = require('../../scripts/account.js');
const asks = require('../../scripts/asks.js');
const catalogLib = require('../../scripts/catalog.js');
const fix = require('../../scripts/fix.js');
const { Harness, hashTree } = require('../harness.js');
const { buildAlfred } = require('../probes/alfred-workspace.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ws-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const catalog = catalogLib.load();
const T = { skip: skipAll, timeout: 900000 };
const S = 'SENTRY_ACCESS_TOKEN';
const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';

const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');
const gitDir = (dir) => { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(path.join(dir, '.git'))) spawnSync('git', ['init', '-q', dir]); return fs.realpathSync(dir); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const accountDoc = (h) => readJson(account.accountFile(h.env));
const localOf = (h, dir) => (account.readAccount(h.env, dir).local || {});
const ok = (r) => assert.strictEqual(r.report.failed, null, `${r.rendered}\n${r.text}`);
const noErrors = (r) => assert.deepStrictEqual(r.plan.errors, [], r.rendered);
// a value with the characters cmd.exe quoting must survive
const keyValue = (tag) => `${tag}%a^b"c-${crypto.randomBytes(8).toString('hex')}`;
const putKeys = (file, pairs) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join('')); };
// no file under a world's temp folders holds any of the values - a `tmp` folder inside the world, never the system's
// temp folder above it (/tmp on Linux, the run's TEMP on Windows)
function noValueInTmp(h, values)
{
    for (const f of h.files().filter((x) => path.relative(h.root, x).split(path.sep).includes('tmp')))
        for (const v of values) assert.ok(!fs.readFileSync(f, 'utf8').includes(v), `a key value in ${path.relative(h.root, f)}`);
}

// The W1 steps on a parent and its child: the parent's project server is seen inherited from the child, the child gets
// its own local copy beside it, configure offers no inherited option, and the parent's file never changes.
function inheritSteps(h, parent, child)
{
    const top = h.run(parent, { picks: { context7: { route: 'remote', scope: 'project' } } });
    noErrors(top);
    ok(top);
    const file = path.join(parent, '.mcp.json');
    const before = sha(file);
    const inv = h.inventory(child);
    const inh = inv.registrations.filter((r) => r.scope === 'inherited' && r.name === 'context7');
    assert.deepStrictEqual(inh.map((r) => [r.from, r.approval]), [[parent, 'pending']], 'listed inherited from the parent, pending here');
    const option = asks.pickQuestions(inv, catalog).flat().flatMap((q) => q.options).find((o) => o.label.startsWith('context7'));
    assert.strictEqual(option.label, 'context7 (inherited from .. as context7, pending)');
    const mine = h.run(child, { picks: { context7: { route: 'remote', scope: 'local' } } });
    noErrors(mine);
    ok(mine);
    assert.ok(localOf(h, child).context7, "the child's own local copy");
    assert.ok(!localOf(h, parent).context7, "the parent's account entry is not written");
    assert.strictEqual(sha(file), before, "the parent's .mcp.json is byte-identical");
    assert.deepStrictEqual(Object.values(asks.changeQuestions(h.inventory(child), catalog).keys), ['mcp:context7~local'], 'configure: no inherited option');
    const rm = h.run(child, { remove: [{ kind: 'mcp', name: 'context7', scope: 'local' }] });
    ok(rm);
    assert.ok(!localOf(h, child).context7);
    assert.strictEqual(sha(file), before, 'and after the remove');
}

test('W1 - no alfred-code: a parent server is inherited, the child gets its own copy, the parent file never changes', T, () =>
{
    const h = new Harness({ root: path.join(root, 'w1') });
    const ws = gitDir(path.join(h.projects, 'ws'));
    const api = gitDir(path.join(ws, 'api'));
    assert.strictEqual(h.inventory(api).alfredCodeEnabled, false);
    inheritSteps(h, ws, api);
});

// ---- W2 ---------------------------------------------------------------------------------------------------------------

let alfred = null;
const alfredWorld = () =>
{
    if (!alfred) alfred = buildAlfred(path.join(root, 'w2'), { version: '3.2.1', workspace: true });
    return alfred;
};
// every file alfred-code wrote into a folder: its .claude/ and .alfred/ trees
const alfredTrees = (dir) => ({ claude: hashTree(path.join(dir, '.claude')), alfred: hashTree(path.join(dir, '.alfred')) });

test('W2 - alfred-code solo, root and child: the W1 steps, a pasted key moved by configure, an own server left alone', T, (t) =>
{
    const b = alfredWorld();
    if (b.notRun) return t.skip(`NOT RUN - ${b.notRun}`);
    if (b.workspaceNotRun) return t.skip(`NOT RUN - workspace: ${b.workspaceNotRun}`);
    const h = b.harness;
    const folders = [b.solo, b.root, b.child];
    const trees = Object.fromEntries(folders.map((d) => [d, alfredTrees(d)]));
    for (const d of folders) assert.strictEqual(h.inventory(d).alfredCodeEnabled, true, d);

    // the solo project takes the root's steps; the child sees the root's server inherited
    const solo = h.run(b.solo, { picks: { context7: { route: 'remote', scope: 'project' } } });
    ok(solo);
    inheritSteps(h, b.root, b.child);

    for (const d of folders)
    {
        const pasted = `sntryu_${crypto.randomBytes(16).toString('hex')}`;
        const own = `sk-own-${crypto.randomBytes(12).toString('hex')}`;
        assert.strictEqual(h.claude(d, ['mcp', 'add-json', 'sentry', JSON.stringify({ command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { [S]: pasted } }), '-s', 'local']).status, 0);
        const mine = { command: 'node', args: ['my-server.js'], env: { API_KEY: own } };
        assert.strictEqual(h.claude(d, ['mcp', 'add-json', 'my-own', JSON.stringify(mine), '-s', 'local']).status, 0);
        const moved = h.run(d, { change: { 'mcp:sentry~local': { name: 'sentry-moved' } } });
        noErrors(moved);
        ok(moved);
        assert.strictEqual(localOf(h, d)['sentry-moved'].env[S], pasted, 'the pasted value reads back at the target');
        assert.ok(!localOf(h, d).sentry);
        assert.ok(h.inventory(d).registrations.some((r) => r.name === 'my-own' && r.own), 'listed as your own');
        assert.ok(h.run(d, { change: { 'mcp:my-own~local': { name: 'x' } } }).plan.errors.some((e) => /your own/.test(e)), 'configure refuses it');
        assert.deepStrictEqual(localOf(h, d)['my-own'], mine, 'unchanged');
        noValueInTmp(h, [pasted, own]);
    }
    for (const d of folders) assert.deepStrictEqual(alfredTrees(d), trees[d], `every file alfred-code wrote in ${path.basename(d)} is unchanged`);
});

// ---- W3 ---------------------------------------------------------------------------------------------------------------

test('W3 - a subfolder session: the project file and the local key land where Claude Code puts them (M4)', T, () =>
{
    const h = new Harness({ root: path.join(root, 'w3') });
    const ws = gitDir(path.join(h.projects, 'ws'));
    const api = gitDir(path.join(ws, 'api'));
    const src = path.join(api, 'src');
    fs.mkdirSync(src, { recursive: true });
    ok(h.run(api, { picks: { atlassian: { scope: 'project' } } }));
    const inv = h.inventory(src);
    assert.deepStrictEqual(inv.registrations.filter((r) => r.scope === 'inherited').map((r) => [r.name, r.from]), [['atlassian', api]], "the repo root's file, inherited from the subfolder");
    const r = h.run(src, { picks: { context7: { route: 'remote', scope: 'project' }, serena: { scope: 'local' } } });
    noErrors(r);
    ok(r);
    assert.deepStrictEqual(Object.keys(readJson(path.join(src, '.mcp.json')).mcpServers), ['context7'], "project scope: the subfolder's own .mcp.json");
    assert.deepStrictEqual(Object.keys(readJson(path.join(api, '.mcp.json')).mcpServers), ['atlassian'], "the root's file is not touched");
    // the account file's own key for the repo root - on Windows the cwd as typed with `/` (D6)
    assert.ok(account.projectEntry(accountDoc(h).projects, api).mcpServers.serena, 'local scope: keyed on the repo root');
    assert.deepStrictEqual(r.report.readback.map((x) => x.found), [true, true], 'both read back from the subfolder');
});

// ---- W4 ---------------------------------------------------------------------------------------------------------------

test('W4 - key files without alfred-code: written in at local scope, ${VAR} at project scope, token-sync after a change', T, () =>
{
    const h = new Harness({ root: path.join(root, 'w4') });
    const ws = gitDir(path.join(h.projects, 'ws'));
    const api = gitDir(path.join(ws, 'api'));
    const [s1, s2, g] = [keyValue('s1'), keyValue('s2'), keyValue('g')];
    const file = path.join(api, '.preferred-tools', '.secrets');
    putKeys(file, { [S]: s1, [G]: g });
    const sentry = h.run(api, { picks: { sentry: { route: 'local', scope: 'local' } } });
    noErrors(sentry);
    ok(sentry);
    assert.strictEqual(localOf(h, api).sentry.env[S], s1, 'the value from .preferred-tools/.secrets');
    assert.strictEqual(fs.readFileSync(path.join(api, '.preferred-tools', '.gitignore'), 'utf8'), '*\n');
    assert.strictEqual(spawnSync('git', ['check-ignore', '-q', '.preferred-tools/.secrets'], { cwd: api }).status, 0, 'git reports it ignored');

    const proj = h.run(api, { picks: { github: { route: 'remote', scope: 'project' } } });
    ok(proj);
    assert.strictEqual(readJson(path.join(api, '.mcp.json')).mcpServers.github.headers.Authorization, `Bearer \${${G}}`);
    ok(h.run(api, { remove: [{ kind: 'mcp', name: 'github', scope: 'project' }] }));
    const local = h.run(api, { picks: { github: { route: 'remote', scope: 'local' } } });
    ok(local);
    assert.strictEqual(localOf(h, api).github.headers.Authorization, `Bearer ${g}`, 'filled at local scope');
    const move = h.run(api, { change: { 'mcp:github~local': { scope: 'project' } } });
    noErrors(move);
    ok(move);
    assert.strictEqual(readJson(path.join(api, '.mcp.json')).mcpServers.github.headers.Authorization, `Bearer \${${G}}`, 'the move to project scope writes the variable');
    assert.ok(!fs.readFileSync(path.join(api, '.mcp.json'), 'utf8').includes(g));

    putKeys(file, { [S]: s2, [G]: g });
    const ctx = () => fix.makeCtx({ inv: h.inventory(api), env: h.env });
    assert.ok(fix.detectAll(ctx()).found.some((f) => f.id === 'token-sync' && f.name === 'sentry' && !f.blocked), 'token-sync names it');
    const lines = [];
    const res = fix.applyFixes(ctx(), ['token-sync'], { tmp: path.join(h.root, 'tmp', 'fix'), log: (...a) => lines.push(a.join(' ')) });
    assert.strictEqual(res.failed, null, lines.join('\n'));
    assert.strictEqual(localOf(h, api).sentry.env[S], s2, 'the new value written');
    for (const v of [s1, s2, g]) assert.ok(![sentry.text, local.text, move.text, lines.join('\n')].join('\n').includes(v), 'no value printed');
    noValueInTmp(h, [s1, s2, g]);
});

test('W4 - key files with alfred-code: the child reads its parent\'s store; v2.9.0 reads .alfred/.sensitive-data', T, (t) =>
{
    const b = alfredWorld();
    if (b.notRun) return t.skip(`NOT RUN - ${b.notRun}`);
    if (b.workspaceNotRun) return t.skip(`NOT RUN - workspace: ${b.workspaceNotRun}`);
    const h = b.harness;
    const s = keyValue('ws');
    putKeys(path.join(b.root, '.alfred', '.secrets'), { [S]: s });
    const r = h.run(b.child, { picks: { sentry: { route: 'local', scope: 'local', name: 'sentry-keys' } } });
    noErrors(r);
    ok(r);
    assert.strictEqual(localOf(h, b.child)['sentry-keys'].env[S], s, "the workspace parent's store, through alfred-code's own chain");
    assert.ok(!fs.existsSync(path.join(b.child, '.preferred-tools')), 'no preferred-tools key file named or made');
    noValueInTmp(h, [s]);

    const old = buildAlfred(path.join(root, 'w4-old'), { version: '2.9.0' });
    if (old.notRun) return t.diagnostic(`NOT RUN - v2.9.0: ${old.notRun}`);
    const o = keyValue('old');
    putKeys(path.join(old.solo, '.alfred', '.sensitive-data'), { [S]: o });
    const r2 = old.harness.run(old.solo, { picks: { sentry: { route: 'local', scope: 'local' } } });
    ok(r2);
    assert.strictEqual(localOf(old.harness, old.solo).sentry.env[S], o, 'the older store name, read with no engine');
    noValueInTmp(old.harness, [o]);
});
