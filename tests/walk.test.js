'use strict';
// The walk (spec F1, F2): `asks.next` hands the command one step of one tool at a time - settings first, then each
// tool's route, scope and name, its root when this run has not answered it, its location and extras, its key name and
// settings - and `done` once nothing is left. Each step is answered with its recommended option here, and recorded into
// picks.json as the commands do.
const test = require('node:test');
const assert = require('node:assert');
const asks = require('../scripts/asks.js');
const { plan } = require('../scripts/plan.js');
const catalog = require('../scripts/catalog.js').load();

const MAC = { os: 'darwin', arch: 'arm64', project: '/work/shop' };
const LINUX = { os: 'linux', arch: 'x64', project: '/work/shop' };
const WIN = { os: 'win32', arch: 'x64', project: 'C:\\work\\shop' };
const HOME = { darwin: '/Users/me', linux: '/home/me', win32: 'C:\\Users\\me' };
const inv = (base, extra = {}) => ({ version: 1, ...base, cli: { ok: true }, unreadable: [], registrations: [], plugins: [], pluginServers: [], marketplaces: [], alfredCodeEnabled: false, sources: {}, records: { project: null, global: null }, ...extra });
const OPTS = (base) => ({ env: {}, home: HOME[base.os] });

// one answer: the first option of each question, recorded as install.md and configure.md record it
function record(picks, step)
{
    const t = step.tool;
    for (const q of step.call)
    {
        const label = q.options[0].label;
        const map = step.answers && step.answers[q.id];
        const id = q.id;
        if (id === 'settings') picks.walk = map[label];
        else if (id.startsWith('route-')) (picks.routes = picks.routes || {})[t] = label.startsWith('Hosted') ? 'remote' : 'local';
        else if (id.startsWith('scope-')) (picks.scopes = picks.scopes || {})[t] = asks.scopeOfLabel(label);
        else if (id.startsWith('name-')) (picks.names = picks.names || {})[t] = 'keep';
        else if (id.startsWith('root-')) (picks.roots = picks.roots || {})[map[label].family] = { id: map[label].id };
        else if (id.startsWith('token-')) (picks.tokens = picks.tokens || {})[t] = label.startsWith('Use a key');
        else if (id.startsWith('own-')) (picks.existing = picks.existing || {})[map[label].key] = map[label].choice;
    }
    picks.done = [...(picks.done || []), step.id];
}

// the whole walk: -> [step]
function walk(i, picks, { answer = record, max = 60 } = {})
{
    const steps = [];
    for (let n = 0; n < max; n++)
    {
        const s = asks.next(i, picks, catalog, OPTS(i));
        if (s.id === 'done') return steps;
        steps.push(s);
        answer(picks, s);
    }
    throw new Error(`no end after ${max} steps: ${steps.map((s) => s.id).join(', ')}`);
}

test('three picks: each tool\'s steps are contiguous, and no call names two tools', () => {
    // 'Set each tool' at the settings step, the recommended option after it
    const each = (picks, step) => { record(picks, step); if (step.id === 'settings') picks.walk = 'each'; };
    const steps = walk(inv(MAC), { rows: ['playwright-chrome', 'gitlab', 'serena'] }, { answer: each });
    const ids = steps.map((s) => s.id);
    assert.strictEqual(ids[0], 'settings');
    const tools = steps.slice(1).map((s) => s.tool);
    assert.deepStrictEqual([...new Set(tools)], ['serena', 'gitlab', 'playwright-chrome'], 'catalog group order');
    for (const tool of new Set(tools))
    {
        const at = tools.map((x, k) => (x === tool ? k : -1)).filter((k) => k >= 0);
        assert.strictEqual(at.at(-1) - at[0] + 1, at.length, `${tool}'s steps are contiguous: ${ids.join(', ')}`);
    }
    for (const s of steps.slice(1))
    {
        assert.ok(s.call.length <= 4 && (s.call.length || s.set), s.id);
        if (!s.id.startsWith('root:')) for (const q of s.call) assert.ok(q.id.endsWith(s.tool), `${q.id} in ${s.id}`);
    }
    assert.strictEqual(new Set(ids).size, ids.length, 'no id twice');
});

test('one pick asks the one-tool settings question and nothing about any other tool', () => {
    const s = asks.next(inv(MAC), { rows: ['gitlab'] }, catalog, OPTS(MAC));
    assert.strictEqual(s.id, 'settings');
    assert.deepStrictEqual(s.call, [asks.STATIC.settingsOne('gitlab')]);
    assert.deepStrictEqual(asks.STATIC.settingsOne('gitlab').options.map((o) => [o.label, o.description]), [
        ['Use the recommended settings for gitlab (Recommended)', 'route, scope, name and location as recommended'],
        ['Set gitlab up', 'ask its route, scope, name and location'],
    ]);
    assert.deepStrictEqual(s.answers.settings, { 'Use the recommended settings for gitlab (Recommended)': 'recommended', 'Set gitlab up': 'each' });
    const many = asks.next(inv(MAC), { rows: ['gitlab', 'serena'] }, catalog, OPTS(MAC));
    assert.deepStrictEqual(many.call, [asks.STATIC.settings]);
    for (const step of walk(inv(MAC), { rows: ['gitlab'], walk: 'each', done: ['settings'] })) assert.strictEqual(step.tool, 'gitlab', step.id);
});

test("'Use the recommended settings' ends the walk", () => {
    const picks = { rows: ['gitlab', 'serena'] };
    assert.deepStrictEqual(walk(inv(MAC), picks).map((s) => s.id), ['settings']);
    assert.strictEqual(picks.walk, 'recommended');
    assert.deepStrictEqual(asks.next(inv(MAC), picks, catalog, OPTS(MAC)), { id: 'done' });
});

test('a root is asked once, inside the first tool of its family', () => {
    const ids = walk(inv(MAC), { rows: ['serena', 'playwright-chrome', 'memory'], walk: 'each', done: ['settings'] }).map((s) => s.id);
    assert.strictEqual(ids.filter((x) => x === 'root:project').length, 1, ids.join(', '));
    assert.ok(ids.indexOf('serena:first') < ids.indexOf('root:project'), ids.join(', '));
    const after = ids.indexOf('serena:questions') >= 0 ? ids.indexOf('serena:questions') : ids.indexOf('serena:keys');
    assert.ok(ids.indexOf('root:project') < after, ids.join(', '));
    // a root already answered is not asked
    assert.ok(!walk(inv(MAC), { rows: ['serena'], walk: 'each', done: ['settings'], roots: { project: { id: 'preferred-tools' } } }).some((s) => s.id.startsWith('root:')));
});

test('a key answered No key or OAuth leaves out the key name', () => {
    const noKey = (picks, step) =>
    {
        record(picks, step);
        if (step.id === 'gitlab:questions') picks.tokens = { gitlab: false };
    };
    const ids = walk(inv(MAC), { rows: ['gitlab'], walk: 'each', done: ['settings'] }, { answer: noKey }).map((s) => s.id);
    assert.ok(!ids.includes('gitlab:keys'), ids.join(', '));
    const keyed = walk(inv(MAC), { rows: ['gitlab'], walk: 'each', done: ['settings'] });
    const keys = keyed.find((s) => s.id === 'gitlab:keys');
    assert.deepStrictEqual(keys.call.map((q) => q.id), ['keyname-gitlab']);
    assert.ok(keys.answers['keyname-gitlab']);
});

test("configure: a registration target starts with its own question; 'Leave it on its own' ends it", () => {
    const reg = { name: 'gitlab', scope: 'project', entry: { type: 'http', url: 'https://gitlab.com/api/v4/mcp' }, rowId: 'gitlab', route: 'remote', own: false, alfredRetired: false, choice: null };
    const c7 = { name: 'context7', scope: 'local', entry: { type: 'http', url: 'https://mcp.context7.com/mcp' }, rowId: 'context7', route: 'remote', own: false, alfredRetired: false, choice: null };
    const i = inv(MAC, { registrations: [reg, c7] });
    const first = asks.next(i, { targets: ['mcp:gitlab~project', 'mcp:context7~local'] }, catalog, OPTS(MAC));
    assert.strictEqual(first.id, 'mcp:gitlab~project:own');
    assert.strictEqual(first.tool, 'mcp:gitlab~project');
    const q = first.call[0];
    assert.strictEqual(q.question, 'Who looks after gitlab?');
    assert.deepStrictEqual(q.options.map((o) => [o.label, o.description]), [
        ['preferred-tools (Recommended)', 'configure, update and fix look after it'],
        ['Leave it on its own', 'nothing in this plugin changes its entry again; in .mcp.json it sits with your own servers, after the managed ones; saved in /work/shop/.preferred-tools/preferred-tools.json'],
    ]);
    assert.deepStrictEqual(Object.values(first.answers[q.id]), [{ key: 'mcp:gitlab~project', choice: 'manage' }, { key: 'mcp:gitlab~project', choice: 'own' }]);
    // a local target: no .mcp.json line
    const local = asks.ownStep({ key: 'mcp:context7~local', name: 'context7', scope: 'local' }, '/work/shop/.preferred-tools');
    assert.strictEqual(local.question.options[1].description, 'nothing in this plugin changes its entry again; saved in /work/shop/.preferred-tools/preferred-tools.json');
    // 'Leave it on its own': the next step is the next target's
    const left = asks.next(i, { targets: ['mcp:gitlab~project', 'mcp:context7~local'], existing: { 'mcp:gitlab~project': 'own' }, done: ['mcp:gitlab~project:own'] }, catalog, OPTS(MAC));
    assert.strictEqual(left.id, 'mcp:context7~local:own');
    // 'preferred-tools': its own questions follow
    const managed = walk(i, { targets: ['mcp:gitlab~project'] });
    assert.deepStrictEqual(managed.map((s) => s.id).slice(0, 2), ['mcp:gitlab~project:own', 'mcp:gitlab~project:questions']);
    assert.ok(!managed.some((s) => s.id.startsWith('root:')), 'configure asks no root for a target');
});

test('a tool with nothing to ask is passed over, and no id comes twice', () => {
    const hud = (scope) => ({ id: 'claude-hud@claude-hud', plugin: 'claude-hud', marketplace: 'claude-hud', scope, version: '1.0.0', enabled: true, enabledHere: true, rowId: 'claude-hud', alfredRetired: false });
    const i = inv(MAC, { plugins: [hud('project'), hud('user')] });
    const steps = walk(i, { rows: ['claude-hud', 'gitlab'], walk: 'each', done: ['settings'] });
    assert.ok(!steps.some((s) => s.tool === 'claude-hud'), steps.map((s) => s.id).join(', '));
    for (const s of steps) assert.ok(s.call.length || s.set, s.id);
    const ids = steps.map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    // a plugin with scopes left: one scope step
    const one = walk(inv(MAC, { plugins: [hud('user')] }), { rows: ['claude-hud'], walk: 'each', done: ['settings'] });
    assert.deepStrictEqual(one.map((s) => [s.id, s.call.map((q) => q.id)]), [['claude-hud:questions', ['scope-claude-hud']]]);
});

test('gitlab asks scope, name, host and its key in one call', () => {
    const steps = walk(inv(MAC), { rows: ['gitlab'], walk: 'each', done: ['settings'] });
    const q = steps.find((s) => s.id === 'gitlab:questions');
    assert.deepStrictEqual(q.call.map((x) => x.id), ['scope-gitlab', 'name-gitlab', 'host-gitlab', 'token-gitlab']);
    assert.deepStrictEqual(steps.map((s) => s.id), ['gitlab:questions', 'root:global', 'gitlab:keys']);
});

test('every catalog row on every OS asks at most four questions per step', () => {
    for (const base of [MAC, LINUX, WIN])
    {
        const rows = catalog.tools.filter((r) => r.os.includes(base.os));
        for (const r of rows)
            for (const s of walk(inv(base), { rows: [r.id], walk: 'each', done: ['settings'] }))
            {
                assert.ok(s.call.length <= 4, `${base.os} ${s.id}: ${s.call.length}`);
                assert.ok(s.call.length || s.set, `${base.os} ${s.id}: an empty step`);
            }
        // configure: each MCP row installed once, as its recommended install writes it
        const regs = rows.filter((r) => r.kind === 'mcp').map((r) =>
        {
            const add = plan(inv(base), { picks: { [r.id]: {} } }, { home: HOME[base.os], env: {}, exists: () => false, machine: { docker: true } }).steps.find((x) => x.op === 'mcp-add');
            return add && { name: add.name, scope: add.scope, entry: add.entry, rowId: r.id, route: add.route, own: false, alfredRetired: false, choice: null };
        }).filter(Boolean);
        const i = inv(base, { registrations: regs });
        for (const s of walk(i, { targets: regs.map((x) => `mcp:${x.name}~${x.scope}`) }, { max: 200 }))
            assert.ok(s.call.length <= 4 && (s.call.length || s.set), `${base.os} configure ${s.id}: ${s.call.length}`);
    }
});

test('the key is first and recommended at install for context7, sentry, gitlab and atlassian; configure keeps the current answer first', () => {
    for (const id of ['context7', 'sentry', 'gitlab', 'atlassian'])
    {
        const t = asks.all(inv(MAC), { rows: [id] }, catalog, OPTS(MAC)).tools[id];
        const q = t.questions.find((x) => x.id === `token-${id}`);
        assert.strictEqual(q.options[0].label, 'Use a key from .mcps-secrets (Recommended)', id);
    }
    const hint = (id) => asks.all(inv(MAC), { rows: [id] }, catalog, OPTS(MAC)).tools[id].questions.find((x) => x.id === `token-${id}`).options[0].description;
    assert.match(hint('gitlab'), /; a fine-grained personal access token with the MCP tool resource and the Execute permission - a legacy token is refused \(403\)$/);
    assert.match(hint('atlassian'), /; an org admin must turn API tokens on; the value is email:api_token; some tools are missing with a token - OAuth has them all$/);
    // configure: a registration with no key keeps 'Sign in with OAuth' first
    const reg = { name: 'gitlab', scope: 'user', entry: { type: 'http', url: 'https://gitlab.com/api/v4/mcp' }, rowId: 'gitlab', route: 'remote', own: false, alfredRetired: false, choice: null };
    const t = asks.all(inv(MAC, { registrations: [reg] }), { targets: ['mcp:gitlab~user'] }, catalog, OPTS(MAC)).targets['mcp:gitlab~user'];
    assert.strictEqual(t.questions.find((x) => x.id === 'token-gitlab').options[0].label, 'Sign in with OAuth (Recommended)');
});

test('the recommended scope for a hosted key follows M1', () => {
    for (const id of ['gitlab', 'atlassian', 'context7', 'sentry', 'github'])
        assert.strictEqual(asks.recommendedScope(catalog.byId.get(id), 'remote'), asks.PARENT_HELPER_IN_CHILD ? 'project' : 'user', id);
    assert.strictEqual(asks.recommendedScope(catalog.byId.get('serena'), 'local'), 'local');
});

// ---- the bridge (0.4.0) ---------------------------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sentry offers three routes, Hosted first, and the bridge recommends Project', () => {
    const sentry = catalog.byId.get('sentry');
    const q = asks.routeQuestion(sentry);
    assert.strictEqual(q.question, 'sentry: which route?');
    assert.deepStrictEqual(q.options.map((o) => o.label), ['Hosted (Recommended)', 'Local', 'Bridge']);
    assert.strictEqual(asks.recommendedScope(sentry, 'bridge'), 'project');
    assert.strictEqual(asks.settingsQuestion(sentry, 'bridge'), null);
    assert.ok(asks.scopesFor(sentry, 'bridge').includes('project'));
});

// a real project folder: the URL-name questions read the .mcps-secrets chain from disk
const bridgeWalk = (base, { secrets = null } = {}) =>
{
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bwalk-')));
    const project = path.join(d, 'shop');
    const home = path.join(d, 'home');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    if (secrets) { fs.mkdirSync(path.join(project, '.preferred-tools')); fs.writeFileSync(path.join(project, '.preferred-tools', '.mcps-secrets'), secrets); }
    const i = inv({ ...base, project });
    const steps = [];
    const picks = { rows: ['sentry'], walk: 'each', done: ['settings'], routes: { sentry: 'bridge' } };
    try
    {
        for (let n = 0; n < 20; n++)
        {
            const s = asks.next(i, picks, catalog, { env: {}, home });
            if (s.id === 'done') break;
            steps.push(s);
            record(picks, s);
            picks.routes = { sentry: 'bridge' };
        }
    }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
    return steps;
};

test('the bridge keys step asks the key name and each URL name, a filled SENTRY_SLUG first for the org', () => {
    const steps = bridgeWalk(MAC, { secrets: 'SENTRY_SLUG=x\n' });
    const keys = steps.find((s) => s.id === 'sentry:keys');
    assert.deepStrictEqual(keys.call.map((q) => q.id), ['keyname-sentry', 'urlname-sentry-SENTRY_ORG', 'urlname-sentry-SENTRY_PROJECT']);
    const org = keys.call[1];
    assert.strictEqual(org.header, 'URL name');
    assert.strictEqual(org.question, "Which name holds sentry's organization slug in .mcps-secrets?");
    assert.strictEqual(org.options[0].label, 'SENTRY_SLUG (Recommended)');
    assert.ok(org.options.some((o) => o.label === 'SENTRY_ORG'), 'the catalog name is offered');
    assert.ok(!org.options.some((o) => /SENTRY_ACCESS_TOKEN/.test(o.label)), 'never the key');
    assert.strictEqual(org.options[org.options.length - 1].label, 'A name you choose');
    assert.strictEqual(keys.answers[org.id]['SENTRY_SLUG (Recommended)'], 'SENTRY_SLUG');
    assert.strictEqual(keys.answers[org.id]['A name you choose'], 'named');
    // the project question does not recommend the name the org question already took
    assert.strictEqual(keys.call[2].options[0].label, 'SENTRY_PROJECT (Recommended)');
    // with nothing filled, the catalog's names are recommended
    const plain = bridgeWalk(MAC).find((s) => s.id === 'sentry:keys');
    assert.strictEqual(plain.call[1].options[0].label, 'SENTRY_ORG (Recommended)');
});

test('every bridge step asks at most four questions with two to four options', () => {
    for (const base of [MAC, LINUX, WIN])
        for (const s of bridgeWalk(base, { secrets: 'SENTRY_SLUG=x\nSENTRY_ORG_NAME=y\nSENTRY_TEAM=z\n' }))
        {
            assert.ok(s.call.length >= 1 && s.call.length <= 4, `${base.os} ${s.id}: ${s.call.length}`);
            for (const q of s.call) assert.ok(q.options.length >= 2 && q.options.length <= 4, `${base.os} ${q.id}: ${q.options.length}`);
        }
});
