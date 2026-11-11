'use strict';
// The workspace cases end to end: the REAL claude CLI in throwaway homes and accounts (tests/harness.js), alfred-code
// built by its own installer where a case needs it (tests/probes/alfred-workspace.js), every result read back from the
// files the CLI wrote.
//
//   W1  no alfred-code: a parent folder's .mcp.json, its server seen inherited from the child, the child's own copy
//   W2  alfred-code solo, root and child: the same steps, a pasted key moved by configure, a server of the user's own,
//       and every file alfred-code wrote left as it was
//   W3  a subfolder session: the project file and the local key land where Claude Code puts them (M4)
//   W4  keys: the project root and its ignores, a stdio key written in from .mcps-secrets, github's helper at local and
//       project scope against a stub, token-sync, a 0.1.x header moved by key-to-helper; with alfred-code, the .alfred
//       root, and a key left in a 0.1.x store named by the plan and never read
//   W5  a root's project-scope tool in alfred-code's folder, absolute: inherited by the child, a 0.2.0 copy found in
//       a child (data-folder-ignore), and the environment a server starts with
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
const roots = require('../../scripts/roots.js');
const fake = require('../fake-mcp-http.js');
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
// No key on either side: since 0.3.0 a key is recommended for every hosted route, and a key writes a root folder that
// configure would list beside the registration; this case is about inheritance.
function inheritSteps(h, parent, child)
{
    const top = h.run(parent, { picks: { context7: { route: 'remote', scope: 'project', token: false } } });
    noErrors(top);
    ok(top);
    const file = path.join(parent, '.mcp.json');
    const before = sha(file);
    const inv = h.inventory(child);
    const inh = inv.registrations.filter((r) => r.scope === 'inherited' && r.name === 'context7');
    assert.deepStrictEqual(inh.map((r) => [r.from, r.approval]), [[parent, 'pending']], 'listed inherited from the parent, pending here');
    const option = asks.pickQuestions(inv, catalog).flat().flatMap((q) => q.options).find((o) => o.label.startsWith('context7'));
    assert.strictEqual(option.label, 'context7 (inherited from .. as context7, pending)');
    const mine = h.run(child, { picks: { context7: { route: 'remote', scope: 'local', token: false } } });
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
// every file alfred-code wrote into a folder: its .claude/ and .alfred/ trees, without the files preferred-tools puts in
// an .alfred root (spec D2: the key file, the helper, the record; 0.4.0: the bridge and package.json, type commonjs),
// which alfred-code never wrote
const PT_FILES = new Set([roots.FILES.secrets, roots.FILES.helper, roots.FILES.record, roots.FILES.bridge, 'package.json']);
function alfredOwn(dir)
{
    const h = crypto.createHash('sha256');
    const walk = (d, top) =>
    {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)); } catch { h.update(`missing:${d}`); return; }
        for (const e of entries)
        {
            if (top && PT_FILES.has(e.name)) continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) { h.update(`d:${e.name}`); walk(f, false); }
            else { h.update(`f:${e.name}:`); h.update(fs.readFileSync(f)); }
        }
    };
    walk(path.join(dir, '.alfred'), true);
    return h.digest('hex');
}
const alfredTrees = (dir) => ({ claude: hashTree(path.join(dir, '.claude')), alfred: alfredOwn(dir) });

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
        // the plan was made from the inventory as inventory.js writes it, so the apply restored the value it reads back
        assert.ok(![pasted, own].some((v) => JSON.stringify(moved.plan).includes(v) || moved.rendered.includes(v) || moved.text.includes(v)), 'no live value in the plan, as plan.js writes and prints it, or in the report');
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

// A hosted registration that reads its key through the helper: a headersHelper, no Authorization header, no ${VAR}, and
// not the key - looked for by its random tail, which JSON leaves unescaped
function helperOnly(entry, key)
{
    assert.ok(entry && typeof entry.headersHelper === 'string', `a headersHelper: ${JSON.stringify(entry)}`);
    assert.ok(!Object.keys(entry.headers || {}).some((k) => k.toLowerCase() === 'authorization'), 'no Authorization header');
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('${'), 'no ${VAR}');
    assert.ok(!text.includes(key.split('-').pop()), 'no key');
}

test('W4 - keys without alfred-code: the root and its ignores, a stdio key written in, the helper at local and project scope, token-sync, a 0.1.x header moved to the helper', T, async () =>
{
    const h = new Harness({ root: path.join(root, 'w4') });
    fs.writeFileSync(path.join(h.account, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const ws = gitDir(path.join(h.projects, 'ws'));
    const api = gitDir(path.join(ws, 'api'));
    fake.trust(h, api);
    const [s1, s2, g] = [keyValue('s1'), keyValue('s2'), keyValue('g')];
    const s = await fake.stub({ expected: `Bearer ${g}` });
    const catalog = fake.stubCatalog(s.port);
    const texts = [];
    const run = (answers) => { const r = h.run(api, answers, { catalog }); texts.push(r.text, r.rendered); noErrors(r); ok(r); return r; };
    try
    {
        // github's hosted route at local scope makes the project root: its .gitignore keeps the key file out of git and
        // lets the helper in
        run({ picks: { github: { route: 'remote', scope: 'local' } } });
        const ptRoot = path.join(api, '.preferred-tools');
        const secrets = path.join(ptRoot, roots.FILES.secrets);
        assert.strictEqual(fs.readFileSync(path.join(ptRoot, '.gitignore'), 'utf8'), roots.GITIGNORE);
        const ignored = (f) => spawnSync('git', ['check-ignore', '-q', `.preferred-tools/${f}`], { cwd: api }).status === 0;
        assert.strictEqual(ignored(roots.FILES.secrets), true, 'git ignores the key file');
        assert.strictEqual(ignored(roots.FILES.helper), false, 'and not the helper');
        helperOnly(localOf(h, api).github, g);
        fake.fill(secrets, S, s1);
        fake.fill(secrets, G, g);
        assert.strictEqual((await fake.authOnGet(s, api, 'github', h.env)).auth, 'expected', 'local scope: the helper sends the key');

        // a stdio key is written in at local scope, from the project root's .mcps-secrets
        run({ picks: { sentry: { route: 'local', scope: 'local' } } });
        assert.strictEqual(localOf(h, api).sentry.env[S], s1, 'the value from .preferred-tools/.mcps-secrets');

        // the move to project scope keeps the helper: the committed file holds no key and no ${VAR}
        run({ change: { 'mcp:github~local': { scope: 'project' } } });
        helperOnly(readJson(path.join(api, '.mcp.json')).mcpServers.github, g);
        assert.ok(!fs.readFileSync(path.join(api, '.mcp.json'), 'utf8').includes(g.split('-').pop()));
        assert.strictEqual((await fake.authOnGet(s, api, 'github', h.env)).auth, 'expected', 'project scope: the helper sends the key');

        // token-sync: a changed stdio value is written in
        fake.fill(secrets, S, s2);
        const ctx = () => fix.makeCtx({ inv: h.inventory(api, { catalog }), catalog, env: h.env, data: h.data });
        assert.ok(fix.detectAll(ctx()).found.some((f) => f.id === 'token-sync' && f.name === 'sentry' && !f.blocked), 'token-sync names it');
        const lines = [];
        const log = (...a) => lines.push(a.join(' '));
        let res = fix.applyFixes(ctx(), ['token-sync'], { tmp: path.join(h.root, 'tmp', 'fix'), log });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        assert.strictEqual(localOf(h, api).sentry.env[S], s2, 'the new value written');

        // a 0.1.x registration - a ${VAR} in its Authorization header - moved to the helper by key-to-helper
        run({ remove: [{ kind: 'mcp', name: 'github', scope: 'project' }] });
        const was = { type: 'http', url: catalog.byId.get('github').routes.remote.url, headers: { Authorization: `Bearer \${${G}}` } };
        assert.strictEqual(h.claude(api, ['mcp', 'add-json', 'github', JSON.stringify(was), '-s', 'project']).status, 0);
        const found = fix.detectAll(ctx()).found.filter((f) => f.id === 'key-to-helper');
        assert.deepStrictEqual(found.map((f) => [f.name, f.scope, f.keyName, f.blocked || null]), [['github', 'project', G, null]]);
        res = fix.applyFixes(ctx(), ['key-to-helper'], { tmp: path.join(h.root, 'tmp', 'fix'), log });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        helperOnly(readJson(path.join(api, '.mcp.json')).mcpServers.github, g);
        assert.strictEqual((await fake.authOnGet(s, api, 'github', h.env)).auth, 'expected', 'moved: the stub sees the key');

        for (const v of [s1, s2, g]) assert.ok(![...texts, ...lines].join('\n').includes(v), 'no value printed');
        noValueInTmp(h, [s1, s2, g]);
    }
    finally { await s.close(); }
});

test('W4 - keys with alfred-code: the root is .alfred, a key left in a 0.1.x store is named and never read, alfred-code\'s .gitignore kept', T, async (t) =>
{
    const b = alfredWorld();
    if (b.notRun) return t.skip(`NOT RUN - ${b.notRun}`);
    if (b.workspaceNotRun) return t.skip(`NOT RUN - workspace: ${b.workspaceNotRun}`);
    const h = b.harness;
    const ignore = (d) => sha(path.join(d, '.alfred', '.gitignore'));
    const ignores = [ignore(b.root), ignore(b.child)];
    const [sv, tg, near] = [keyValue('ws'), keyValue('tg'), keyValue('near')];

    // the child's root is its .alfred: a stdio key written in from .alfred/.mcps-secrets
    fake.fill(path.join(b.child, '.alfred', roots.FILES.secrets), S, sv);
    const r = h.run(b.child, { picks: { sentry: { route: 'local', scope: 'local', name: 'sentry-keys' } } });
    noErrors(r);
    ok(r);
    assert.strictEqual(localOf(h, b.child)['sentry-keys'].env[S], sv, "the child's .alfred/.mcps-secrets");
    assert.ok(!fs.existsSync(path.join(b.child, '.preferred-tools')), 'no .preferred-tools root made');
    noValueInTmp(h, [sv]);

    // a key left only in the root's 0.1.x store, alfred-code's own key file: the key-name ask offers the near-miss name
    // from it, the plan's line names the file, and the helper never reads it
    const store = path.join(b.root, '.alfred', '.secrets');
    putKeys(store, { [G]: tg, ACME_GITHUB_ACCESS_TOKEN: near });
    const s = await fake.stub({ expected: `Bearer ${tg}` });
    const catalog = fake.stubCatalog(s.port);
    try
    {
        const q = asks.all(h.inventory(b.root, { catalog }), { rows: ['github'], routes: { github: 'remote' }, scopes: { github: 'local' } }, catalog, { env: h.env, home: h.home });
        const opts = q.keyNames.github.question.options;
        assert.ok(opts.some((o) => o.label === 'ACME_GITHUB_ACCESS_TOKEN' && o.description === `in ${store} - move it to .mcps-secrets under this name`), JSON.stringify(opts));
        const gh = h.run(b.root, { picks: { github: { route: 'remote', scope: 'local' } } }, { catalog });
        noErrors(gh);
        ok(gh);
        const secrets = path.join(b.root, '.alfred', roots.FILES.secrets);
        assert.ok(gh.rendered.includes(`${G} is in ${store}, which preferred-tools no longer reads: move it to ${secrets}`), gh.rendered);
        helperOnly(localOf(h, b.root).github, tg);
        fake.trust(h, b.root);
        assert.strictEqual((await fake.authOnGet(s, b.root, 'github', h.env)).auth, 'none', 'the 0.1.x store is never read for a value');
        assert.ok(![gh.rendered, gh.text, JSON.stringify(gh.plan), JSON.stringify(q)].join('\n').includes(tg.split('-').pop()), 'no value printed');
        assert.ok(![gh.rendered, gh.text, JSON.stringify(q)].join('\n').includes(near.split('-').pop()), 'no value printed');
        noValueInTmp(h, [sv, tg, near]);
        ok(h.run(b.root, { remove: [{ kind: 'mcp', name: 'github', scope: 'local' }] }, { catalog }));
    }
    finally { await s.close(); }
    assert.deepStrictEqual([ignore(b.root), ignore(b.child)], ignores, "alfred-code's .alfred/.gitignore is left as it wrote it");
});

// ---- W5 ---------------------------------------------------------------------------------------------------------------

test('W5 - a root\'s project-scope tool in alfred-code\'s folder, absolute: the child inherits it, and a 0.2.0 copy in a child is found and ignored', T, (t) =>
{
    const b = alfredWorld();
    if (b.notRun) return t.skip(`NOT RUN - ${b.notRun}`);
    if (b.workspaceNotRun) return t.skip(`NOT RUN - workspace: ${b.workspaceNotRun}`);
    const lacking = [b.root, b.child].filter((d) => !fs.existsSync(path.join(d, '.alfred', '.gitignore')));
    if (lacking.length) return t.skip(`NOT RUN - alfred-code wrote no .alfred/.gitignore in ${lacking.map((d) => path.basename(d)).join(', ')}`);
    const h = b.harness;
    const r = h.run(b.root, { picks: { 'playwright-chrome': { scope: 'project' } } });
    noErrors(r);
    ok(r);
    // 0.3.0 (spec F7): the project file names this machine's absolute folder in the root in use - alfred-code's here
    const args = readJson(path.join(b.root, '.mcp.json')).mcpServers['playwright-chrome'].args;
    assert.strictEqual(args[args.indexOf('--user-data-dir') + 1], path.join(b.root, '.alfred', 'playwright-chrome'), "alfred-code's folder, absolute");
    assert.ok(h.inventory(b.child).registrations.some((x) => x.scope === 'inherited' && x.name === 'playwright-chrome' && x.from === b.root), 'the child lists it inherited');

    // a session started in a child or a subfolder uses the root's folder: no copy is made there, so nothing is found
    const ctxAt = (dir) => fix.makeCtx({ inv: h.inventory(dir), env: h.env });
    const findings = (dir) => fix.detectAll(ctxAt(dir), { only: 'data-folder-ignore' }).found;
    const bare = gitDir(path.join(b.root, 'bare'));
    const src = path.join(b.child, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (const d of [b.child, bare, src]) assert.deepStrictEqual(findings(d), [], `${path.basename(d)}: no copy of the root's folder`);
    // a 0.2.0 copy left in a child that alfred-code does not cover: found once, and its .gitignore written
    const want = path.join(bare, '.alfred', 'playwright-chrome');
    fs.mkdirSync(want, { recursive: true });
    assert.deepStrictEqual(findings(bare).map((f) => f.proposal.path), [want], 'the 0.2.0 copy is found');
    const lines = [];
    const res = fix.applyFixes(ctxAt(bare), ['data-folder-ignore'], { tmp: path.join(h.root, 'tmp', 'fix-w5'), log: (...a) => lines.push(a.join(' ')) });
    assert.strictEqual(res.failed, null, lines.join('\n'));
    assert.strictEqual(fs.readFileSync(path.join(want, '.gitignore'), 'utf8'), '*\n', 'read back from disk');
    assert.deepStrictEqual(findings(bare), [], 'covered after the fix');
    ok(h.run(b.root, { remove: [{ kind: 'mcp', name: 'playwright-chrome', scope: 'project' }] }));
});

// What a `claude -p` needs and nothing more (tests/probes/mcp-tree.js): no credential of the shell running the matrix.
const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR', 'PROGRAMFILES', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM']);
const FAKE = path.resolve(__dirname, '..', 'fake-mcp-server.js');

test('W5 - a stdio server inherits the environment Claude Code starts with: a parent\'s project server started from its child', T, (t) =>
{
    const h = new Harness({ root: path.join(root, 'w5-env') });
    const ws = gitDir(path.join(h.projects, 'ws'));
    const api = gitDir(path.join(ws, 'api'));
    const log = path.join(h.root, 'env.log');
    const entry = { command: process.execPath, args: [FAKE, 'answer', '--log', log, '--tag', 'env'], env: { FAKE_MCP_LOG_ENV: 'ANDROID_HOME' } };
    assert.strictEqual(h.claude(ws, ['mcp', 'add-json', 'env-probe', JSON.stringify(entry), '-s', 'project']).status, 0);
    // approves every project server, a parent's included (M7, M8)
    fs.writeFileSync(path.join(h.account, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const env = Object.fromEntries(Object.entries(h.env).filter(([k]) => KEEP.has(k.toUpperCase())));
    Object.assign(env, {
        HOME: h.home, USERPROFILE: h.home, APPDATA: path.join(h.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(h.home, 'AppData', 'Local'),
        CLAUDE_CONFIG_DIR: h.account, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MCP_SERVER_CONNECTION_BATCH_SIZE: '20',
    });
    const auth = cli.run(['auth', 'status'], { cwd: api, env });
    if (!/"loggedIn":\s*false/.test(`${auth.stdout || ''}${auth.stderr || ''}`)) return t.skip('NOT RUN - the throwaway account is not reported logged out, and a claude -p never runs logged in');
    for (const [value, want] of [[path.join(h.home, 'android-sdk'), 'set'], [null, 'unset']])
    {
        fs.rmSync(log, { force: true });
        cli.run(['-p', 'hi'], { cwd: api, env: value ? { ...env, ANDROID_HOME: value } : env, timeout: 90000 });
        const starts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
        assert.ok(starts.length > 0, `the parent's server started from the child (ANDROID_HOME ${want})`);
        for (const s of starts) assert.deepStrictEqual([s.cwd, s.env], [api, [`env:ANDROID_HOME=${want}`]], 'in the folder Claude started in, with the variable as Claude Code had it');
    }
});
