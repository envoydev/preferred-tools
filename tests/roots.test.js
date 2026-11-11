'use strict';
// roots.js - one root folder per scope family (spec D2): the options, the root in use, a named folder, the roots map and
// the record file. Pure where a ctx stands in for the disk; the map and record tests use a throwaway folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const roots = require('../scripts/roots.js');
const asks = require('../scripts/asks.js');
const catalogLib = require('../scripts/catalog.js');

const catalog = catalogLib.load();
// alfred-code 3.9.2's pattern, cited where it lives
const { OTHER_RE } = require('./ask-texts.js');
const inv = (extra = {}) => ({ version: 1, project: '/work/shop', os: 'darwin', arch: 'arm64', cli: { ok: true }, unreadable: [], registrations: [], plugins: [], marketplaces: [], alfredCodeEnabled: false, sources: {}, ...extra });
const ctxOf = (present = [], extra = {}) => ({ project: '/work/shop', home: '/Users/me', platform: 'darwin', catalog, exists: (p) => present.includes(p), ...extra });
const ids = (list) => list.map((o) => o.id);
const reg = (name, scope, entry, rowId, route) => ({ name, scope, entry, rowId, route, own: !rowId, alfredRetired: false });
const ALFRED_SET_UP = '/work/shop/.alfred/.gitignore';

test('project root options: .alfred first where alfred-code is set up, else .preferred-tools; \'A folder you name\' last', () => {
    const set = roots.options(inv({ alfredCodeEnabled: true }), 'project', ctxOf([ALFRED_SET_UP]));
    assert.deepStrictEqual(ids(set), ['alfred', 'preferred-tools', 'named']);
    assert.deepStrictEqual(set.map((o) => o.root), ['/work/shop/.alfred', '/work/shop/.preferred-tools', null]);
    assert.strictEqual(set[2].label, 'A folder you name');
    assert.deepStrictEqual(ids(roots.options(inv({ alfredCodeEnabled: false }), 'project', ctxOf([ALFRED_SET_UP]))), ['preferred-tools', 'named'], 'alfred-code not enabled');
    assert.deepStrictEqual(ids(roots.options(inv({ alfredCodeEnabled: true }), 'project', ctxOf([]))), ['preferred-tools', 'named'], 'no .alfred/.gitignore');
});

test('global root options: ~/.preferred-tools first; ~/.alfred only when it exists', () => {
    assert.deepStrictEqual(ids(roots.options(inv(), 'global', ctxOf([]))), ['preferred-tools', 'named']);
    const both = roots.options(inv(), 'global', ctxOf(['/Users/me/.alfred']));
    assert.deepStrictEqual(ids(both), ['preferred-tools', 'home-alfred', 'named']);
    assert.deepStrictEqual(both.map((o) => o.root), ['/Users/me/.preferred-tools', '/Users/me/.alfred', null]);
    assert.deepStrictEqual(both.map((o) => o.label).slice(0, 2), ['~/.preferred-tools', '~/.alfred']);
});

test('a root in use is listed first and recommended: the map, else a managed registration\'s helper or data folder, else the root holding .mcps-secrets', () => {
    const named = '/work/shop/tools/keys';
    const helper = reg('gh', 'local', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: 'node "/work/shop/kit/mcp-headers.js" GITHUB_PERSONAL_ACCESS_TOKEN Bearer' }, 'github', 'remote');
    const data = reg('pw', 'local', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '/work/shop/.preferred-tools/playwright-chrome'] }, 'playwright-chrome', 'local');
    const secrets = '/work/shop/.preferred-tools/.mcps-secrets';
    const map = { version: 1, global: '/k', projects: { '/work/shop': named } };
    const on = [ALFRED_SET_UP, named, '/k', secrets];
    const base = { alfredCodeEnabled: true };

    assert.deepStrictEqual(roots.inUse(inv({ ...base, roots: { map }, registrations: [helper, data] }), 'project', ctxOf(on)), { path: named, from: 'map' });
    assert.deepStrictEqual(roots.inUse(inv({ ...base, roots: { map }, registrations: [helper] }), 'global', ctxOf(on)), { path: '/k', from: 'map' });
    assert.deepStrictEqual(roots.inUse(inv({ ...base, registrations: [data, helper] }), 'project', ctxOf(on)), { path: '/work/shop/kit', from: 'registration' }, 'a helper before a data folder');
    assert.deepStrictEqual(roots.inUse(inv({ ...base, registrations: [data] }), 'project', ctxOf(on)), { path: '/work/shop/.preferred-tools', from: 'registration' });
    assert.deepStrictEqual(roots.inUse(inv(base), 'project', ctxOf(on)), { path: '/work/shop/.preferred-tools', from: 'secrets' });
    assert.strictEqual(roots.inUse(inv(base), 'project', ctxOf([ALFRED_SET_UP])), null);
    assert.strictEqual(roots.inUse(inv({ ...base, roots: { map } }), 'project', ctxOf([])), null, 'a mapped folder that is gone is not in use');
    const own = { ...helper, rowId: null, own: true };
    assert.strictEqual(roots.inUse(inv({ ...base, registrations: [own] }), 'project', ctxOf([ALFRED_SET_UP])), null, 'the user\'s own server is not read');
    const user = { ...helper, scope: 'user' };
    assert.strictEqual(roots.inUse(inv({ ...base, registrations: [user] }), 'project', ctxOf([ALFRED_SET_UP])), null, 'a user registration is the global family\'s');
    assert.deepStrictEqual(roots.inUse(inv({ ...base, registrations: [user] }), 'global', ctxOf([])), { path: '/work/shop/kit', from: 'registration' });

    // listed first and recommended in its place
    const mapped = roots.options(inv({ ...base, roots: { map } }), 'project', ctxOf(on));
    assert.deepStrictEqual(ids(mapped), ['in-use', 'alfred', 'preferred-tools', 'named']);
    assert.strictEqual(mapped[0].root, named);
    const standard = roots.options(inv({ ...base, registrations: [data] }), 'project', ctxOf(on));
    assert.deepStrictEqual(ids(standard), ['preferred-tools', 'alfred', 'named'], 'a standard folder in use moves first');
});

test('a named project root must lie inside the project', () => {
    const ctx = ctxOf();
    for (const [text, rule] of [['../x', /\.\./], ['/abs', /inside the project/], ['.git', /\.git/], ['.claude', /\.claude/], ['.claude/keys', /\.claude/], ['tools/../../x', /\.\./], ['', /folder/], ['.', /inside the project/]])
    {
        const r = roots.resolveNamed('project', text, ctx);
        assert.ok(r.error && !r.root, `${text}: ${JSON.stringify(r)}`);
        assert.match(r.error, rule, text);
    }
    assert.deepStrictEqual(roots.resolveNamed('project', 'tools/keys', ctx), { root: '/work/shop/tools/keys' });
    assert.deepStrictEqual(roots.resolveNamed('project', './tools/keys/', ctx), { root: '/work/shop/tools/keys' });
    const win = { project: 'C:\\ws', home: 'C:\\Users\\mac', platform: 'win32' };
    assert.deepStrictEqual(roots.resolveNamed('project', 'tools\\keys', win), { root: 'C:\\ws\\tools\\keys' });
    assert.match(roots.resolveNamed('project', 'D:\\keys', win).error, /inside the project/);
});

test('a named global root takes ~ and any absolute folder', () => {
    const ctx = ctxOf();
    assert.deepStrictEqual(roots.resolveNamed('global', '~/keys', ctx), { root: '/Users/me/keys' });
    assert.deepStrictEqual(roots.resolveNamed('global', '/srv/keys/', ctx), { root: '/srv/keys' });
    assert.match(roots.resolveNamed('global', 'keys', ctx).error, /absolute|~/);
    assert.match(roots.resolveNamed('global', '', ctx).error, /folder/);
    assert.deepStrictEqual(roots.resolveNamed('global', '~\\keys', { project: 'C:\\ws', home: 'C:\\Users\\mac', platform: 'win32' }), { root: 'C:\\Users\\mac\\keys' });
});

test('each option\'s description gives the exact folder on this machine; the global \'A folder you name\' adds that a project-scope helper does not read keys there', () => {
    const win = { project: 'C:\\ws', home: 'C:\\Users\\mac', platform: 'win32', catalog, exists: (p) => ['C:\\ws\\.alfred\\.gitignore', 'C:\\Users\\mac\\.alfred'].includes(p) };
    const project = roots.options(inv({ project: 'C:\\ws', os: 'win32', alfredCodeEnabled: true }), 'project', win);
    assert.match(project[0].description, /^C:\\ws\\\.alfred - kept out of git by alfred-code/);
    assert.match(project[1].description, /^C:\\ws\\\.preferred-tools - /);
    assert.match(project[2].description, /asked next/);
    const global = roots.options(inv({ project: 'C:\\ws', os: 'win32' }), 'global', win);
    assert.match(global[0].description, /^C:\\Users\\mac\\\.preferred-tools - one folder for every project on this machine/);
    assert.match(global[1].description, /^C:\\Users\\mac\\\.alfred - /);
    assert.match(global[2].description, /asked next/);
    assert.match(global[2].description, /a project-scope helper does not read keys here/);
    assert.doesNotMatch(project[2].description, /does not read keys/);
});

test('roots map: missing or malformed reads empty with a note; a second project goes beside the first; the key is the trust root', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-roots-')));
    try
    {
        const empty = { version: 1, global: null, projects: {} };
        assert.deepStrictEqual(roots.readMap(dir), empty, 'missing: empty, no note');
        assert.deepStrictEqual(roots.readMap(null), empty, 'no data folder given');
        const file = path.join(dir, roots.FILES.map);
        fs.writeFileSync(file, '{ not json');
        const bad = roots.readMap(dir);
        assert.deepStrictEqual([bad.global, bad.projects], [null, {}]);
        assert.match(bad.note, /roots\.json/);
        fs.writeFileSync(file, JSON.stringify({ version: 2, global: '/x', projects: {} }));
        assert.match(roots.readMap(dir).note, /version/);
        fs.writeFileSync(file, '[]');
        assert.ok(roots.readMap(dir).note, 'an array is malformed');

        // the key is the trust root: a git repository's root for a folder inside it
        const repo = path.join(dir, 'repo');
        const child = path.join(repo, 'web');
        fs.mkdirSync(child, { recursive: true });
        spawnSync('git', ['init', '-q'], { cwd: repo });
        assert.strictEqual(roots.mapKey(child), fs.realpathSync.native(repo));
        const other = path.join(dir, 'other');
        fs.mkdirSync(other);
        const one = roots.withRoot(empty, 'project', child, path.join(repo, '.alfred'));
        const two = roots.withRoot(one, 'project', other, path.join(other, '.preferred-tools'));
        const three = roots.withRoot(two, 'global', other, '/k');
        assert.deepStrictEqual(three, { version: 1, global: '/k', projects: { [fs.realpathSync.native(repo)]: path.join(repo, '.alfred'), [fs.realpathSync.native(other)]: path.join(other, '.preferred-tools') } });
        assert.deepStrictEqual(empty, { version: 1, global: null, projects: {} }, 'withRoot leaves its input as it was');
        fs.writeFileSync(file, JSON.stringify(three));
        assert.deepStrictEqual(roots.readMap(dir), three);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a record file: missing is null, malformed or another version reads empty with a note', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-record-')));
    try
    {
        const file = path.join(dir, roots.FILES.record);
        assert.strictEqual(roots.readRecord(file), null);
        fs.writeFileSync(file, 'nope');
        assert.deepStrictEqual([roots.readRecord(file).servers, Boolean(roots.readRecord(file).note)], [[], true]);
        fs.writeFileSync(file, JSON.stringify({ version: 3, servers: [{ name: 'x' }] }));
        assert.deepStrictEqual([roots.readRecord(file).servers, /version/.test(roots.readRecord(file).note)], [[], true]);
        const good = { version: 1, servers: [{ name: 'gh', scope: 'local', fingerprint: 'api.githubcopilot.com/mcp/', choice: 'own' }] };
        fs.writeFileSync(file, JSON.stringify(good));
        assert.deepStrictEqual(roots.readRecord(file), good);
        // where the commands look: the mapped root, the two standard folders, every root a managed registration points into
        const helper = reg('gh', 'local', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: 'node "/work/shop/kit/mcp-headers.js" GITHUB_PERSONAL_ACCESS_TOKEN Bearer' }, 'github', 'remote');
        const files = roots.recordFiles(inv({ roots: { map: { version: 1, global: null, projects: { '/work/shop': '/work/shop/tools/keys' } } }, registrations: [helper] }), 'project', ctxOf(['/work/shop/tools/keys']));
        assert.deepStrictEqual(files, ['/work/shop/tools/keys', '/work/shop/.preferred-tools', '/work/shop/.alfred', '/work/shop/kit'].map((d) => `${d}/preferred-tools.json`));
        assert.deepStrictEqual(roots.recordFiles(inv(), 'global', ctxOf()), ['/Users/me/.preferred-tools/preferred-tools.json', '/Users/me/.alfred/preferred-tools.json']);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no option text mentions Other', () => {
    const on = [ALFRED_SET_UP, '/Users/me/.alfred', '/work/shop/tools/keys'];
    const map = { version: 1, global: null, projects: { '/work/shop': '/work/shop/tools/keys' } };
    const all = ['project', 'global'].flatMap((f) => [...roots.options(inv({ alfredCodeEnabled: true }), f, ctxOf(on)), ...roots.options(inv({ alfredCodeEnabled: true, roots: { map } }), f, ctxOf(on))]);
    const q = asks.all(inv({ alfredCodeEnabled: true }), { rows: ['playwright-chrome', 'github'], scopes: { github: 'user' } }, catalog, { home: '/Users/me' });
    assert.deepStrictEqual(q.roots.questions.map((x) => x.id), ['root-project', 'root-global']);
    for (const text of [...all.flatMap((o) => [o.label, o.description]), ...q.roots.questions.flatMap((x) => [x.question, x.header, ...x.options.flatMap((o) => [o.label, o.description])])])
    {
        assert.doesNotMatch(text, OTHER_RE, text);
        assert.doesNotMatch(text, /under Other/, text);
    }
});

test('a root is asked for a family only a pick records into', () => {
    const qs = (picks) => asks.all(inv(), picks, catalog, { home: '/Users/me' }).roots;
    // an answer about a server already set up asks no root: a server left on its own goes to the root in use (Ruling 3)
    assert.deepStrictEqual(qs({ existing: { 'mcp:atlassian~user': 'own', 'connector:Atlassian': 'own', 'plugin-mcp:x@m/srv': 'add' } }).questions, []);
    assert.deepStrictEqual(qs({ rows: ['playwright-chrome'] }).questions.map((x) => x.id), ['root-project'], 'a local route: local scope, the project family');
    assert.deepStrictEqual(qs({ rows: ['playwright-chrome'], scopes: { 'playwright-chrome': 'user' } }).questions.map((x) => x.id), ['root-global']);
    assert.deepStrictEqual(qs({ rows: ['claude-hud'] }).questions, [], 'a plugin needs no root');
    assert.deepStrictEqual(qs(null).questions, []);
    // one question per family, however many picks; the answers map each label to its root
    const r = qs({ rows: ['playwright-chrome', 'serena', 'memory'] });
    assert.strictEqual(r.questions.length, 1);
    const q = r.questions[0];
    assert.ok(q.header.length <= 12, q.header);
    assert.match(q.options[0].label, / \(Recommended\)$/);
    assert.strictEqual(q.options.filter((o) => /\(Recommended\)/.test(o.label)).length, 1);
    assert.deepStrictEqual(r.answers['root-project'][q.options[0].label], { family: 'project', id: 'preferred-tools', root: '/work/shop/.preferred-tools' });
    assert.deepStrictEqual(r.answers['root-project']['A folder you name'], { family: 'project', id: 'named', root: null });
});

// ---- 0.3.0: the record holds the servers left on their own, each in its scope family's root (spec F4) -----------------
test('recordFamily: user scope and a connector are global; project, local and a plugin server are project', () => {
    assert.strictEqual(roots.recordFamily({ name: 'gh', scope: 'user', choice: 'own' }), 'global');
    assert.strictEqual(roots.recordFamily({ connector: 'GitLab', choice: 'own' }), 'global');
    assert.strictEqual(roots.recordFamily({ name: 'gh', scope: 'project', choice: 'own' }), 'project');
    assert.strictEqual(roots.recordFamily({ name: 'gh', scope: 'local', choice: 'own' }), 'project');
    assert.strictEqual(roots.recordFamily({ plugin: 'docs@m', server: 'c7', choice: 'own' }), 'project');
    const own = { name: 'a', scope: 'local', choice: 'own' };
    assert.deepStrictEqual(roots.ownOnly([own, { ...own, name: 'b', choice: 'manage' }, { connector: 'X', choice: 'add' }, null]), [own]);
});

test('shippedState reads the bridge like the helper: absent, lower, same, edited, higher', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shipped-'));
    try
    {
        const file = path.join(dir, roots.FILES.bridge);
        assert.strictEqual(roots.FILES.bridge, 'mcp-bridge.js');
        const src = roots.shippedSource('bridge');
        const { BRIDGE_VERSION } = require('../scripts/mcp-bridge.js');
        assert.deepStrictEqual(roots.shippedState('bridge', file), { state: 'absent', number: null });
        fs.writeFileSync(file, src.replace(/^\/\/ preferred-tools mcp-bridge \d+/, '// preferred-tools mcp-bridge 0'));
        assert.deepStrictEqual(roots.shippedState('bridge', file), { state: 'lower', number: 0 });
        fs.writeFileSync(file, src);
        assert.deepStrictEqual(roots.shippedState('bridge', file), { state: 'same', number: BRIDGE_VERSION });
        fs.writeFileSync(file, `${src}// mine\n`);
        assert.deepStrictEqual(roots.shippedState('bridge', file), { state: 'edited', number: BRIDGE_VERSION });
        fs.writeFileSync(file, src.replace(/^\/\/ preferred-tools mcp-bridge \d+/, `// preferred-tools mcp-bridge ${BRIDGE_VERSION + 1}`));
        assert.deepStrictEqual(roots.shippedState('bridge', file), { state: 'higher', number: BRIDGE_VERSION + 1 });
        // the helper reads through the same function
        assert.deepStrictEqual(roots.helperState(path.join(dir, 'none.js')), roots.shippedState('helper', path.join(dir, 'none.js')));
        assert.strictEqual(roots.helperSource(), roots.shippedSource('helper'));
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
