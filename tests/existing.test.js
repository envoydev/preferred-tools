'use strict';
// Servers already set up (spec D6, F4): a matching registration, a plugin's server and a claude.ai connector. One the user
// leaves on its own is recorded in the root's preferred-tools.json; a managed one has no record.
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

test("a matching registration, a plugin's server and a connector are each one item, with its family and fingerprint", () => {
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
    assert.ok(!('questions' in X), 'install asks nothing about servers already set up (spec F4)');
});

test('a registration whose helper points into a root is not asked about', () => {
    const helper = regOf('github', 'local', { ...GH, headersHelper: 'node /work/shop/keys/mcp-headers.js GITHUB_PERSONAL_ACCESS_TOKEN Bearer' }, 'github', 'remote');
    const data = regOf('memory', 'user', { command: 'uvx', args: ['--from', 'mcp-memory-service', 'memory', 'server'], env: { MCP_MEMORY_SQLITE_PATH: `${HOME}/.preferred-tools/memory/memory.db` } }, 'memory', 'local');
    const elsewhere = regOf('serena', 'user', { command: 'uvx', args: ['--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: { SERENA_HOME: `${HOME}/.serena` } }, 'serena', 'local');
    const retired = regOf('chrome-control', 'local', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] }, 'playwright-chrome', 'local', { alfredRetired: true });
    const inherited = regOf('c7', 'inherited', C7, 'context7', 'remote');
    assert.deepStrictEqual(X.items(invOf({ registrations: [helper, data, elsewhere, retired, inherited] }), [], catalog, ctx).map((x) => x.key), ['mcp:serena~user']);
});

test("a helper file of the user's own - no preferred-tools number line, or not this plugin's arguments - is asked about", () => {
    const w = world();
    try
    {
        const own = path.join(w.dir, 'shop', '.alfred', 'mcp-headers.js');
        fs.mkdirSync(path.dirname(own), { recursive: true });
        fs.writeFileSync(own, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ Authorization: 'Bearer ' + process.env.GH }));\n");
        const real = { home: HOME };
        const hand = regOf('github', 'local', { ...GH, headersHelper: `node ${own} github` }, 'github', 'remote');
        assert.deepStrictEqual(X.items(invOf({ registrations: [hand] }), [], catalog, real).map((x) => x.key), ['mcp:github~local'], 'a hand-made file in place');
        const shape = regOf('github', 'local', { ...GH, headersHelper: 'node /work/shop/.alfred/mcp-headers.js github' }, 'github', 'remote');
        assert.deepStrictEqual(X.items(invOf({ registrations: [shape] }), [], catalog, ctx).map((x) => x.key), ['mcp:github~local'], "no file, and not this plugin's <NAME> <SCHEME>");
        fs.writeFileSync(own, require('../scripts/roots.js').helperSource());
        const ours = regOf('github', 'local', { ...GH, headersHelper: `node ${own} GITHUB_PERSONAL_ACCESS_TOKEN Bearer` }, 'github', 'remote');
        assert.deepStrictEqual(X.items(invOf({ registrations: [ours] }), [], catalog, real), [], "this plugin's helper in place: not asked");
    }
    finally { w.clean(); }
});

test('the record round-trips: a server left on its own is recorded in its family root, a managed one is not', () => {
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
            ['root-ignore', groot], ['record-clean', path.join(groot, 'preferred-tools.json')], ['record-root', groot],
        ]);
        const r = apply(p, { env: w.env, tmp: path.join(w.dir, 'tmp'), log: () => {}, data });
        assert.strictEqual(r.failed, null);
        assert.ok(!fs.existsSync(path.join(proot, 'preferred-tools.json')), 'a managed server has no record');
        assert.deepStrictEqual(readJson(path.join(groot, 'preferred-tools.json')), { version: 1, servers: [{ name: 'github', scope: 'user', fingerprint: 'url:api.githubcopilot.com/mcp', choice: 'own' }, { connector: 'Atlassian', choice: 'own' }] });
        inv = inventory.buildInventory({ project: w.project, env: w.env, data });
        assert.deepStrictEqual(inv.registrations.map((x) => [x.name, x.choice]), [['c7', null], ['github', 'own']]);
        // the same plan again: nothing to write
        const again = plan(inv, {}, { home: w.home, env: w.env, connectors: ['Atlassian'] });
        assert.deepStrictEqual(again.steps.filter((s) => s.op === 'record-clean'), []);
        // handing github back removes its entry; the connector's stays
        const back = plan(inv, { existing: { 'mcp:github~user': 'manage' } }, { home: w.home, env: w.env, connectors: ['Atlassian'] });
        assert.strictEqual(apply(back, { env: w.env, tmp: path.join(w.dir, 'tmp2'), log: () => {}, data }).failed, null);
        assert.deepStrictEqual(readJson(path.join(groot, 'preferred-tools.json')).servers, [{ connector: 'Atlassian', choice: 'own' }]);
        // a launch that changed since is no longer on its own
        assert.strictEqual(cli.run(['mcp', 'remove', 'github', '-s', 'user'], { cwd: w.project, env: w.env }).status, 0);
        register(w, 'github', { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'] }, 'user');
        inv = inventory.buildInventory({ project: w.project, env: w.env, data });
        assert.strictEqual(inv.registrations.find((x) => x.name === 'github').choice, null);
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
