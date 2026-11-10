'use strict';
// Servers already set up (spec D6): a matching registration, a plugin's server and a claude.ai connector, each asked about
// once - 'on its own' or managed - and the answer recorded in the root's preferred-tools.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { world, writeJson, readJson } = require('./helpers.js');
const catalog = require('../scripts/catalog.js').load();
const X = require('../scripts/existing.js');
const inventory = require('../scripts/inventory.js');
const { plan } = require('../scripts/plan.js');
const { apply } = require('../scripts/apply.js');
const cli = require('../scripts/claude-cli.js');

const GH = { type: 'http', url: 'https://api.githubcopilot.com/mcp/' };
const C7 = { type: 'http', url: 'https://mcp.context7.com/mcp' };
const HOME = '/Users/me';
const ctx = { home: HOME, exists: () => false };
const invOf = (extra = {}) => ({
    version: 1, project: '/work/shop', os: 'darwin', arch: 'arm64', registrations: [], plugins: [], pluginServers: [],
    records: { project: null, global: null }, roots: { map: { version: 1, global: null, projects: {} } }, ...extra,
});
const regOf = (name, scope, entry, rowId, route, extra = {}) => ({ name, scope, entry, rowId, route, own: !rowId, alfredRetired: false, choice: null, ...extra });
const register = (w, name, entry, scope) => assert.strictEqual(cli.run(['mcp', 'add-json', name, JSON.stringify(entry), '-s', scope], { cwd: w.project, env: w.env }).status, 0);
const NOTE = ' - connectors this session has not loaded are not seen';

test('connector names match a hosted row by prefix', () => {
    assert.deepStrictEqual(X.HOSTED_ROWS, ['context7', 'github', 'gitlab', 'atlassian', 'sentry']);
    assert.deepStrictEqual(['Atlassian', 'Atlassian_Rovo', 'GitHub', 'Sentry', 'Context7', 'GitLab'].map(X.matchConnector), ['atlassian', 'atlassian', 'github', 'sentry', 'context7', 'gitlab']);
    assert.deepStrictEqual(['Notion', 'Memory', '', 'Serena', 'My-GitHub'].map(X.matchConnector), [null, null, null, null, null]);
    assert.deepStrictEqual(X.parseConnectors(',Atlassian,,Atlassian ,'), ['Atlassian']);
    assert.deepStrictEqual([X.parseConnectors(''), X.parseConnectors(null)], [[], []]);
});

test("a plugin's servers are read from its .mcp.json and its manifest", () => {
    const w = world();
    try
    {
        const a = path.join(w.dir, 'cache', 'a');
        writeJson(path.join(a, '.mcp.json'), { mcpServers: { docs: C7 } });
        writeJson(path.join(a, '.claude-plugin', 'plugin.json'), { name: 'a', mcpServers: { gh: GH } });
        assert.deepStrictEqual(X.pluginServers(a), [{ server: 'docs', entry: C7 }, { server: 'gh', entry: GH }]);
        // a map at the top of .mcp.json, and a manifest path to a file
        const b = path.join(w.dir, 'cache', 'b');
        const MEM = { command: 'uvx', args: ['--from', 'mcp-memory-service', 'memory', 'server'] };
        writeJson(path.join(b, '.mcp.json'), { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } });
        writeJson(path.join(b, 'servers.json'), { mcpServers: { mem: MEM } });
        writeJson(path.join(b, '.claude-plugin', 'plugin.json'), { name: 'b', mcpServers: './servers.json' });
        assert.deepStrictEqual(X.pluginServers(b).map((s) => s.server), ['sentry', 'mem']);
        // a broken file, a path above the root, nothing there: nothing read, nothing thrown
        const c = path.join(w.dir, 'cache', 'c');
        fs.mkdirSync(path.join(c, '.claude-plugin'), { recursive: true });
        fs.writeFileSync(path.join(c, '.mcp.json'), '{oops');
        writeJson(path.join(c, '.claude-plugin', 'plugin.json'), { name: 'c', mcpServers: '../b/servers.json' });
        assert.deepStrictEqual(X.pluginServers(c), []);
        assert.deepStrictEqual([X.pluginServers(path.join(w.dir, 'none')), X.pluginServers(null)], [[], []]);
    }
    finally { w.clean(); }
});

test("a matching registration, a plugin's server and a connector are each one question; 'Leave it on its own' recommended", () => {
    const i = invOf({
        registrations: [regOf('github', 'user', { ...GH, headers: { Authorization: 'Bearer ${GH}' } }, 'github', 'remote'), regOf('mine', 'local', { command: 'my' }, null, null)],
        pluginServers: [{ plugin: 'docs@m', server: 'c7', entry: C7, rowId: 'context7', route: 'remote', choice: null }, { plugin: 'docs@m', server: 'x', entry: { command: 'x' }, rowId: null, route: null, choice: null }],
    });
    const items = X.items(i, ['Atlassian', 'Notion'], catalog, ctx);
    assert.deepStrictEqual(items.map((x) => [x.key, x.kind, x.rowId, x.family, x.fingerprint, x.choice]), [
        ['mcp:github~user', 'mcp', 'github', 'global', 'url:api.githubcopilot.com/mcp', null],
        ['plugin-mcp:docs@m/c7', 'plugin', 'context7', 'project', 'url:mcp.context7.com/mcp', null],
        ['connector:Atlassian', 'connector', 'atlassian', 'global', null, null],
    ]);
    const q = X.questions(items, []);
    assert.strictEqual(q.calls.length, 1);
    const [a, b, c] = q.calls[0];
    assert.strictEqual(a.question, `github (global) is already set up here. Who looks after it?${NOTE}`);
    assert.deepStrictEqual(a.options.map((o) => o.label), ['Leave it on its own (Recommended)', 'Let preferred-tools manage it']);
    assert.strictEqual(b.question, "The docs plugin already provides context7 as 'c7'. Who looks after it?");
    assert.deepStrictEqual(b.options.map((o) => o.label), ['Leave it with docs (Recommended)', "Add preferred-tools' own registration as well"]);
    assert.strictEqual(c.question, 'Atlassian is connected through your claude.ai account. Who looks after it?');
    assert.deepStrictEqual(c.options.map((o) => o.label), ['Leave it with claude.ai (Recommended)', "Add preferred-tools' own registration as well"]);
    for (const x of q.calls[0]) assert.ok(x.header.length <= 12 && x.multiSelect === false && x.options.every((o) => o.description), JSON.stringify(x));
    assert.deepStrictEqual(q.answers[a.id], { 'Leave it on its own (Recommended)': { key: 'mcp:github~user', choice: 'own' }, 'Let preferred-tools manage it': { key: 'mcp:github~user', choice: 'manage' } });
    assert.deepStrictEqual(q.answers[c.id]["Add preferred-tools' own registration as well"], { key: 'connector:Atlassian', choice: 'add' });
    // five servers: two calls, the note on the first question only
    const five = X.questions(X.items(invOf(), ['Context7', 'GitHub', 'GitLab', 'Atlassian', 'Sentry'], catalog, ctx), []);
    assert.deepStrictEqual(five.calls.map((call) => call.length), [4, 1]);
    assert.deepStrictEqual(five.calls.flat().map((x) => x.question.endsWith(NOTE)), [true, false, false, false, false]);
    assert.strictEqual(new Set(five.calls.flat().map((x) => x.id)).size, 5);
});

test("'Let preferred-tools manage it' is recommended when a fix detector finds a repair, and 'Leave it on its own' names it", () => {
    const i = invOf({ registrations: [regOf('github', 'user', GH, 'github', 'remote'), regOf('c7', 'local', C7, 'context7', 'remote')] });
    const found = [
        { id: 'key-to-helper', name: 'github', scope: 'user', found: 'its key is sent from an Authorization header' },
        { id: 'advice-row', name: 'c7', scope: 'local', found: 'something', blocked: 'advice only - nothing here is applied' },
        { id: 'other', name: 'github', scope: 'local', found: 'not this one' },
    ];
    const q = X.questions(X.items(i, [], catalog, ctx), found);
    const byKey = (key) => q.calls.flat().find((x) => Object.values(q.answers[x.id])[0].key === key);
    const gh = byKey('mcp:github~user');
    assert.deepStrictEqual(gh.options.map((o) => o.label), ['Let preferred-tools manage it (Recommended)', 'Leave it on its own']);
    assert.strictEqual(gh.options[1].description, 'key-to-helper will not repair it: its key is sent from an Authorization header');
    assert.deepStrictEqual(q.answers[gh.id]['Let preferred-tools manage it (Recommended)'], { key: 'mcp:github~user', choice: 'manage' });
    assert.strictEqual(byKey('mcp:c7~local').options[0].label, 'Leave it on its own (Recommended)', 'a blocked finding is no repair');
});

test('a registration whose helper points into a root is not asked about', () => {
    const helper = regOf('github', 'local', { ...GH, headersHelper: 'node /work/shop/keys/mcp-headers.js GITHUB_PERSONAL_ACCESS_TOKEN Bearer' }, 'github', 'remote');
    const data = regOf('memory', 'user', { command: 'uvx', args: ['--from', 'mcp-memory-service', 'memory', 'server'], env: { MCP_MEMORY_SQLITE_PATH: `${HOME}/.preferred-tools/memory/memory.db` } }, 'memory', 'local');
    const elsewhere = regOf('serena', 'user', { command: 'uvx', args: ['--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: { SERENA_HOME: `${HOME}/.serena` } }, 'serena', 'local');
    const retired = regOf('chrome-control', 'local', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] }, 'playwright-chrome', 'local', { alfredRetired: true });
    const inherited = regOf('c7', 'inherited', C7, 'context7', 'remote');
    assert.deepStrictEqual(X.items(invOf({ registrations: [helper, data, elsewhere, retired, inherited] }), [], catalog, ctx).map((x) => x.key), ['mcp:serena~user']);
});

test('the record round-trips, and a second run asks nothing about a server already answered, either way', () => {
    const w = world();
    try
    {
        const data = path.join(w.dir, 'data');
        register(w, 'github', GH, 'user');
        register(w, 'c7', C7, 'local');
        let inv = inventory.buildInventory({ project: w.project, env: w.env, data });
        assert.deepStrictEqual(X.items(inv, ['Atlassian'], catalog, { home: w.home }).map((x) => x.key), ['mcp:c7~local', 'mcp:github~user', 'connector:Atlassian']);
        const p = plan(inv, { existing: { 'mcp:github~user': 'own', 'mcp:c7~local': 'manage', 'connector:Atlassian': 'own' } }, { home: w.home, env: w.env, connectors: ['Atlassian'] });
        assert.deepStrictEqual(p.errors, []);
        const proot = path.join(w.project, '.preferred-tools');
        const groot = path.join(w.home, '.preferred-tools');
        assert.deepStrictEqual(p.steps.map((s) => [s.op, s.file || s.path || s.root]), [
            ['root-ignore', proot], ['root-ignore', groot],
            ['record-choice', path.join(proot, 'preferred-tools.json')], ['record-choice', path.join(groot, 'preferred-tools.json')],
            ['record-root', proot], ['record-root', groot],
        ]);
        const r = apply(p, { env: w.env, tmp: path.join(w.dir, 'tmp'), log: () => {}, data });
        assert.strictEqual(r.failed, null);
        assert.deepStrictEqual(readJson(path.join(proot, 'preferred-tools.json')), { version: 1, servers: [{ name: 'c7', scope: 'local', fingerprint: 'url:mcp.context7.com/mcp', choice: 'manage' }] });
        assert.deepStrictEqual(readJson(path.join(groot, 'preferred-tools.json')), { version: 1, servers: [{ name: 'github', scope: 'user', fingerprint: 'url:api.githubcopilot.com/mcp', choice: 'own' }, { connector: 'Atlassian', choice: 'own' }] });
        inv = inventory.buildInventory({ project: w.project, env: w.env, data });
        assert.deepStrictEqual(inv.registrations.map((x) => [x.name, x.choice]), [['c7', 'manage'], ['github', 'own']]);
        const again = X.items(inv, ['Atlassian'], catalog, { home: w.home });
        assert.deepStrictEqual(again.map((x) => x.choice), ['manage', 'own', 'own']);
        assert.deepStrictEqual(X.questions(again, []).calls, [], 'nothing is asked again');
        // a launch that changed since is asked about again
        assert.strictEqual(cli.run(['mcp', 'remove', 'c7', '-s', 'local'], { cwd: w.project, env: w.env }).status, 0);
        register(w, 'c7', { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, 'local');
        inv = inventory.buildInventory({ project: w.project, env: w.env, data });
        assert.strictEqual(inv.registrations.find((x) => x.name === 'c7').choice, null);
    }
    finally { w.clean(); }
});

test('a record in a named root no registration points into is found through the roots map', () => {
    const w = world();
    try
    {
        const data = path.join(w.dir, 'data');
        const named = path.join(w.home, 'my-keys');
        writeJson(path.join(named, 'preferred-tools.json'), { version: 1, servers: [{ name: 'github', scope: 'user', fingerprint: 'url:api.githubcopilot.com/mcp', choice: 'own' }] });
        register(w, 'github', GH, 'user');
        assert.strictEqual(inventory.buildInventory({ project: w.project, env: w.env, data }).registrations[0].choice, null, 'no map: not found');
        writeJson(path.join(data, 'roots.json'), { version: 1, global: named, projects: {} });
        const inv = inventory.buildInventory({ project: w.project, env: w.env, data });
        assert.strictEqual(inv.registrations[0].choice, 'own');
        assert.strictEqual(inv.records.global.file, path.join(named, 'preferred-tools.json'));
    }
    finally { w.clean(); }
});
