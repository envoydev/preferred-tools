'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { world, writeJson, readJson, tempOf } = require('./helpers.js');
const inventory = require('../scripts/inventory.js');
const { plan } = require('../scripts/plan.js');
const { apply } = require('../scripts/apply.js');
const cli = require('../scripts/claude-cli.js');
const update = require('../scripts/update.js');
const registry = require('../scripts/registry.js');
const { pinnedVersion } = require('../scripts/fixes/common.js');

const DAY = 86400000;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const ago = (days) => NOW - days * DAY;

// a fake registry: { 'pypi:serena-agent': [{ version, time }] }
const fakeRegistry = (table) => ({ versionsOf: async (reg, name) => { const v = table[`${reg}:${name}`]; if (!v) throw new Error(`no such package ${name}`); return v; } });
// no language servers on this machine
const noLsp = { which: () => null, run: () => ({ status: 1, stdout: '', stderr: '' }), nodeVersion: process.versions.node };

const install = (w, answers) =>
{
    const inv = inventory.buildInventory({ project: w.project, env: w.env });
    const p = plan(inv, answers, { home: w.home, env: w.env });
    assert.deepStrictEqual(p.errors, []);
    const r = apply(p, { env: w.env, tmp: path.join(w.dir, 'tmp'), log: () => {} });
    assert.strictEqual(r.failed, null);
};

async function run(w, argv, opts = {})
{
    const lines = [];
    const code = await update.main([...argv, '--project', w.project], { env: w.env, out: (s) => lines.push(s), machine: noLsp, now: NOW, registry: fakeRegistry({}), ...opts });
    return { code, text: lines.join('\n') };
}

const pypiSerena = (...v) => ({ 'pypi:serena-agent': v.map(([version, days]) => ({ version, time: ago(days) })) });

// ---- the pin edit --------------------------------------------------------------------------------------------------

test('bumpEntry moves the pin and the cut-off beside it, and nothing else', () =>
{
    const serena = { command: 'uvx', args: ['--python', '3.13', '--exclude-newer', '2026-10-20T23:59:59Z', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server', '--my-flag'], env: { SERENA_HOME: '/x' } };
    const b = update.bumpEntry(serena, 'serena-agent', '2.2.0', '2026-10-27T23:59:59Z');
    assert.deepStrictEqual(b.args, ['--python', '3.13', '--exclude-newer', '2026-10-27T23:59:59Z', '--from', 'serena-agent@2.2.0', 'serena', 'start-mcp-server', '--my-flag']);
    assert.deepStrictEqual(b.env, serena.env);
    assert.strictEqual(serena.args[5], 'serena-agent@2.1.0', 'the input is not mutated');

    const memory = { command: 'uvx', args: ['--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'] };
    assert.strictEqual(update.bumpEntry(memory, 'mcp-memory-service', '12.2.0', 'C').args[1], 'mcp-memory-service[sqlite]==12.2.0');
    assert.deepStrictEqual(update.bumpEntry(memory, 'mcp-memory-service', '12.2.0', 'C').args.includes('--exclude-newer'), false, 'a cut-off the user removed stays removed');

    const npx = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '/p'], env: { npm_config_before: '2026-10-20T23:59:59Z', MINE: '1' } };
    const n = update.bumpEntry(npx, '@playwright/mcp', '0.0.90', '2026-10-27T23:59:59Z');
    assert.deepStrictEqual(n.args, ['-y', '@playwright/mcp@0.0.90', '--browser', 'chrome', '--user-data-dir', '/p']);
    assert.deepStrictEqual(n.env, { npm_config_before: '2026-10-27T23:59:59Z', MINE: '1' });

    const win = { command: 'cmd', args: ['/c', 'npx', '-y', 'appium-mcp@1.97.1'], env: { npm_config_before: 'old' } };
    assert.deepStrictEqual(update.bumpEntry(win, 'appium-mcp', '1.98.0', 'new').args, ['/c', 'npx', '-y', 'appium-mcp@1.98.0']);

    assert.strictEqual(update.bumpEntry({ command: 'npx', args: ['-y', 'appium-mcp'] }, 'appium-mcp', '1.98.0', 'x'), null, 'no pin, no edit');
});

// ---- the age gate --------------------------------------------------------------------------------------------------

test('choose: newest stable release at least 7 days old and newer than the pin; younger ones are held back', () =>
{
    const v = (version, days, extra = {}) => ({ version, time: ago(days), ...extra });
    const list = [v('2.1.0', 40), v('2.2.0', 20), v('2.3.0', 8), v('2.4.0', 2), v('2.5.0rc1', 30), v('2.4.1.dev3', 30)];
    const r = registry.choose(list, { registry: 'pypi', now: NOW, current: '2.1.0' });
    assert.strictEqual(r.offer.version, '2.3.0');
    assert.deepStrictEqual(r.held, [{ version: '2.4.0', ageDays: 2 }], 'a pre-release is neither offered nor held back');
    assert.strictEqual(registry.choose(list, { registry: 'pypi', now: NOW, current: '2.3.0' }).offer, null, 'at the newest eligible already');
    assert.strictEqual(registry.choose(list, { registry: 'pypi', now: NOW, current: '9.0.0' }).offer, null, 'a pin ahead of the registry is left');
    // exactly 7 days old is eligible
    assert.strictEqual(registry.choose([v('1.0.0', 8), v('1.1.0', 7)], { registry: 'npm', now: NOW, current: '1.0.0' }).offer.version, '1.1.0');
    assert.strictEqual(registry.choose([v('1.0.0', 8), v('1.1.0-beta.1', 30)], { registry: 'npm', now: NOW, current: '1.0.0' }).offer, null);
    assert.strictEqual(registry.cutoffOf(NOW), '2026-10-27T23:59:59Z');
});

test('versionsOf reads the npm and PyPI document shapes (a deprecated or yanked release is left out)', async () =>
{
    const server = http.createServer((req, res) =>
    {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/@scope%2Fpkg') return res.end(JSON.stringify({ versions: { '1.0.0': {}, '1.1.0': { deprecated: 'use 1.2' }, '1.2.0': {} }, time: { created: '2026-01-01T00:00:00Z', '1.0.0': '2026-01-01T00:00:00Z', '1.1.0': '2026-02-01T00:00:00Z', '1.2.0': '2026-03-01T00:00:00Z' } }));
        if (req.url === '/mypkg/json') return res.end(JSON.stringify({ releases: { '1.0': [{ upload_time_iso_8601: '2026-01-01T00:00:00.000000Z', yanked: false }], '1.1': [{ upload_time_iso_8601: '2026-02-01T00:00:00.000000Z', yanked: true }], '1.2': [] } }));
        res.statusCode = 404;
        res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try
    {
        const env = { PREFERRED_TOOLS_NPM_URL: base, PREFERRED_TOOLS_PYPI_URL: base };
        assert.deepStrictEqual((await registry.versionsOf('npm', '@scope/pkg', { env })).map((x) => x.version), ['1.0.0', '1.2.0']);
        assert.deepStrictEqual((await registry.versionsOf('pypi', 'mypkg', { env })).map((x) => x.version), ['1.0']);
        await assert.rejects(registry.versionsOf('npm', 'missing', { env }), /HTTP 404/);
    }
    finally { server.close(); }
});

// ---- MCP pins ------------------------------------------------------------------------------------------------------

test('an offer: serena is behind, the table shows current -> offered, apply rewrites it under the same name and scope', async () =>
{
    const w = world();
    try
    {
        install(w, { picks: { serena: { scope: 'local' } } });
        const before = inventory.buildInventory({ project: w.project, env: w.env }).registrations.find((r) => r.name === 'serena');
        // the user's own addition, which an update must keep
        const mine = { ...before.entry, args: [...before.entry.args, '--my-flag'] };
        cli.run(['mcp', 'remove', 'serena', '-s', 'local'], { cwd: w.project, env: w.env });
        cli.run(['mcp', 'add-json', 'serena', JSON.stringify(mine), '-s', 'local'], { cwd: w.project, env: w.env });

        const reg = fakeRegistry(pypiSerena(['2.1.0', 60], ['2.2.0', 20]));
        const setupWrites = w.writes().length;
        const c = await run(w, ['--check', '--no-refresh'], { registry: reg });
        assert.strictEqual(c.code, 0);
        assert.match(c.text, /MCP servers \(pin -> newest release at least 7 days old\):\n\s+serena \(local\)\s+2\.1\.0 -> 2\.2\.0\s+\(20 days old\)/);
        assert.doesNotMatch(c.text, /everything current/);
        assert.strictEqual(w.writes().length, setupWrites, 'a check writes nothing');

        const a = await run(w, ['--apply', 'mcp:serena~local'], { registry: reg });
        assert.strictEqual(a.code, 0, a.text);
        assert.match(a.text, /ok\s+serena \(local\): serena-agent 2\.1\.0 -> 2\.2\.0/);
        const after = inventory.buildInventory({ project: w.project, env: w.env }).registrations.find((r) => r.name === 'serena');
        assert.strictEqual(after.scope, 'local');
        assert.strictEqual(pinnedVersion(after.entry, 'serena-agent'), '2.2.0');
        assert.ok(after.entry.args.includes('--my-flag'), 'the user\'s added arg survives');
        assert.strictEqual(after.entry.args[after.entry.args.indexOf('--exclude-newer') + 1], '2026-10-27T23:59:59Z', 'the cut-off is the bump day');
        assert.deepStrictEqual(after.entry.env, before.entry.env);
        assert.strictEqual(after.rowId, 'serena', 'still matched by what it launches');
    }
    finally { w.clean(); }
});

test('nothing behind: one line, and no write call', async () =>
{
    const w = world();
    try
    {
        install(w, { picks: { serena: { scope: 'local' } } });
        const c = await run(w, ['--check', '--no-refresh'], { registry: fakeRegistry(pypiSerena(['2.1.0', 60])) });
        assert.match(c.text, /^preferred-tools: everything current$/m);
        const writesBefore = w.writes().length;
        const q = await run(w, ['--questions', '--no-refresh'], { registry: fakeRegistry(pypiSerena(['2.1.0', 60])) });
        assert.deepStrictEqual(JSON.parse(q.text), { offer: null, pick: [] });
        assert.strictEqual(w.writes().length, writesBefore);
    }
    finally { w.clean(); }
});

test('a release younger than 7 days is held back, never offered', async () =>
{
    const w = world();
    try
    {
        install(w, { picks: { serena: { scope: 'local' } } });
        const c = await run(w, ['--check', '--no-refresh'], { registry: fakeRegistry(pypiSerena(['2.1.0', 60], ['2.2.0', 3])) });
        assert.match(c.text, /serena \(local\): serena-agent 2\.2\.0 is 3 day\(s\) old - held back until it is 7/);
        assert.doesNotMatch(c.text, /->\s*2\.2\.0/);
        const a = await run(w, ['--apply', 'all', '--no-refresh'], { registry: fakeRegistry(pypiSerena(['2.1.0', 60], ['2.2.0', 3])) });
        assert.strictEqual(a.code, 0);
        assert.strictEqual(w.calls().filter((x) => x[1] === 'add-json').length, 1, 'only the install add; the update changed nothing');
    }
    finally { w.clean(); }
});

test('a remote route, a docker tag and the user\'s own server are skipped or left alone; a registry failure is reported, not read as current', async () =>
{
    const w = world();
    try
    {
        install(w, { picks: { context7: { route: 'remote', scope: 'project' }, serena: { scope: 'local' } } });
        cli.run(['mcp', 'add-json', 'my-own', JSON.stringify({ command: 'npx', args: ['-y', 'some-pkg@1.0.0'] }), '-s', 'user'], { cwd: w.project, env: w.env });
        const c = await run(w, ['--check', '--no-refresh'], { registry: fakeRegistry({ 'npm:some-pkg': [{ version: '2.0.0', time: ago(90) }] }) });
        assert.match(c.text, /context7 \(project\): a hosted URL has no pin/);
        assert.match(c.text, /Could not check:\n\s+serena \(local\): pypi lookup for serena-agent failed - no such package/);
        assert.doesNotMatch(c.text, /everything current/);
        assert.doesNotMatch(c.text, /my-own|some-pkg/, 'a registration that matches no row is not looked at');
    }
    finally { w.clean(); }
});

test('an inherited server is skipped with its folder named', async () =>
{
    const w = world();
    try
    {
        writeJson(path.join(w.dir, '.mcp.json'), { mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@2.0.0'] } } });
        const c = await run(w, ['--check', '--no-refresh'], { registry: fakeRegistry({ 'npm:@upstash/context7-mcp': [{ version: '9.0.0', time: ago(90) }] }) });
        assert.match(c.text, /context7 \(inherited\): inherited from \.\. - update it there/);
        assert.doesNotMatch(c.text, /2\.0\.0 -> 9\.0\.0/, 'never offered, however far behind');
    }
    finally { w.clean(); }
});

test('apply names an id nothing is behind under, and exits 1', async () =>
{
    const w = world();
    try
    {
        install(w, { picks: { serena: { scope: 'local' } } });
        const a = await run(w, ['--apply', 'mcp:serena~user', '--no-refresh'], { registry: fakeRegistry(pypiSerena(['2.1.0', 60], ['2.2.0', 20])) });
        assert.strictEqual(a.code, 1);
        assert.match(a.text, /NOT OFFERED mcp:serena~user/);
    }
    finally { w.clean(); }
});

// ---- plugins -------------------------------------------------------------------------------------------------------

// a marketplace clone the fake lists, holding the given plugin entries; plugin folders carry their own plugin.json
function marketplace(w, name, plugins)
{
    const loc = path.join(w.dir, 'clones', name);
    writeJson(path.join(loc, '.claude-plugin', 'marketplace.json'), { name, owner: { name: 'o' }, plugins: plugins.map((p) => ({ name: p.name, source: p.source || `./plugins/${p.name}`, ...(p.entryVersion ? { version: p.entryVersion } : {}) })) });
    for (const p of plugins) if (p.version) writeJson(path.join(loc, 'plugins', p.name, '.claude-plugin', 'plugin.json'), { name: p.name, version: p.version });
    return loc;
}
function seed(w, { markets, installed })
{
    const f = path.join(w.dir, 'state', 'plugins.json');
    writeJson(f, {
        marketplaces: markets.map(([name, loc]) => ({ name, repo: `x/${name}`, installLocation: loc })),
        installed: installed.map(([id, version, scope]) => ({ id, version, scope, enabled: true, installPath: path.join(w.dir, 'cache', id), ...(scope === 'user' ? {} : { projectPath: fs.realpathSync(w.project) }) })),
    });
}

test('plugins: catalog and other plugins are two groups; the marketplace is refreshed; apply updates at the plugin\'s own scope and reads the version back', async () =>
{
    const w = world();
    try
    {
        const official = marketplace(w, 'claude-plugins-official', [{ name: 'typescript-lsp', version: '1.1.0' }]);
        const mine = marketplace(w, 'someone', [{ name: 'tidy', version: '0.5.0' }, { name: 'same', version: '1.0.0' }]);
        seed(w, { markets: [['claude-plugins-official', official], ['someone', mine]], installed: [['typescript-lsp@claude-plugins-official', '1.0.0', 'project'], ['tidy@someone', '0.4.0', 'user'], ['same@someone', '1.0.0', 'user']] });
        const c = await run(w, ['--check']);
        assert.match(c.text, /Catalog plugins:\n\s+typescript-lsp@claude-plugins-official \(project\)\s+1\.0\.0 -> 1\.1\.0/);
        assert.match(c.text, /Other plugins:\n\s+tidy@someone \(user\)\s+0\.4\.0 -> 0\.5\.0/);
        assert.doesNotMatch(c.text, /same@someone/, 'a plugin at the listed version is not offered');
        assert.ok(w.calls().some((a) => a.join(' ') === 'plugin marketplace update someone'), 'each marketplace is refreshed');

        const env = { ...w.env, FAKE_CLAUDE_VERSIONS: JSON.stringify({ 'typescript-lsp@claude-plugins-official': '1.1.0', 'tidy@someone': '0.5.0' }) };
        const a = await run(w, ['--apply', 'all', '--no-refresh'], { env });
        assert.strictEqual(a.code, 0, a.text);
        assert.match(a.text, /ok\s+typescript-lsp@claude-plugins-official \(project\): 1\.0\.0 -> 1\.1\.0/);
        assert.match(a.text, /ok\s+tidy@someone \(user\): 0\.4\.0 -> 0\.5\.0/);
        const updates = w.calls().filter((x) => x[0] === 'plugin' && x[1] === 'update');
        assert.deepStrictEqual(updates.map((x) => x.slice(2)), [['typescript-lsp@claude-plugins-official', '--scope', 'project'], ['tidy@someone', '--scope', 'user']]);
    }
    finally { w.clean(); }
});

test('a marketplace entry with no version is unchecked: listed, and updated only on its own id', async () =>
{
    const w = world();
    try
    {
        const loc = path.join(w.dir, 'clones', 'gh');
        writeJson(path.join(loc, '.claude-plugin', 'marketplace.json'), { name: 'gh', owner: { name: 'o' }, plugins: [{ name: 'remote-one', source: { source: 'github', repo: 'a/b' } }] });
        seed(w, { markets: [['gh', loc]], installed: [['remote-one@gh', '1.0.0', 'user']] });
        const env = { ...w.env, FAKE_CLAUDE_VERSIONS: JSON.stringify({ 'remote-one@gh': '1.0.1' }) };
        const c = await run(w, ['--check', '--no-refresh'], { env });
        assert.match(c.text, /lists no version.*\n\s+remote-one@gh \(user\)\s+1\.0\.0/);
        assert.doesNotMatch(c.text, /everything current/);
        const all = await run(w, ['--apply', 'all', '--no-refresh'], { env });
        assert.strictEqual(w.calls().filter((x) => x[1] === 'update').length, 0, '"all" does not run an update that has no known newer version');
        assert.strictEqual(all.code, 0);
        const one = await run(w, ['--apply', 'plugin:remote-one@gh~user', '--no-refresh'], { env });
        assert.match(one.text, /ok\s+remote-one@gh \(user\): 1\.0\.0 -> 1\.0\.1/);
    }
    finally { w.clean(); }
});

test('a marketplace that is not registered is skipped with a line, and a failed refresh is said, not hidden', async () =>
{
    const w = world();
    try
    {
        const loc = marketplace(w, 'known', [{ name: 'p', version: '2.0.0' }]);
        seed(w, { markets: [['known', loc]], installed: [['p@known', '1.0.0', 'user'], ['q@gone', '1.0.0', 'user']] });
        const env = { ...w.env, FAKE_CLAUDE_FAIL: 'marketplace update known' };
        const c = await run(w, ['--check'], { env });
        assert.match(c.text, /q@gone \(user\): its marketplace 'gone' is not registered/);
        assert.match(c.text, /marketplace known did not refresh .* compared against its last clone/);
        assert.match(c.text, /p@known \(user\)\s+1\.0\.0 -> 2\.0\.0/);
    }
    finally { w.clean(); }
});

// ---- language servers ----------------------------------------------------------------------------------------------

test('language servers on PATH are reported; typescript-language-server is offered when behind and updated only when picked', async () =>
{
    const w = world();
    try
    {
        let ts = '4.0.0';
        const calls = [];
        const machine = {
            nodeVersion: process.versions.node,
            which: (n) => (['typescript-language-server', 'csharp-ls'].includes(n) ? `/bin/${n}` : null),
            run: (cmd, args) => { calls.push([cmd, ...args]); if (cmd === 'npm') { ts = '4.1.0'; return { status: 0, stdout: '', stderr: '' }; } return { status: 0, stdout: cmd === 'csharp-ls' ? 'csharp-ls 0.20.0\n' : `${ts}\n`, stderr: '' }; },
        };
        const reg = fakeRegistry({ 'npm:typescript-language-server': [{ version: '4.0.0', time: ago(90) }, { version: '4.1.0', time: ago(30) }] });
        const c = await run(w, ['--check', '--no-refresh'], { machine, registry: reg });
        assert.match(c.text, /Language servers:\n\s+typescript-language-server \(global npm\)\s+4\.0\.0 -> 4\.1\.0/);
        assert.match(c.text, /csharp-ls 0\.20\.0 \(latest not checked/);
        assert.ok(!calls.some((x) => x[0] === 'npm'), 'a check installs nothing');
        const a = await run(w, ['--apply', 'lsp:typescript', '--no-refresh'], { machine, registry: reg });
        assert.strictEqual(a.code, 0, a.text);
        assert.deepStrictEqual(calls.find((x) => x[0] === 'npm'), ['npm', 'install', '-g', 'typescript-language-server', 'typescript@6']);
        assert.match(a.text, /ok\s+typescript-language-server \(global npm\): 4\.0\.0 -> 4\.1\.0/);
    }
    finally { w.clean(); }
});

// ---- the asks ------------------------------------------------------------------------------------------------------

test('the asks stay within the AskUserQuestion limits; every pick option carries its offer id', () =>
{
    const mk = (n, group, kind) => Array.from({ length: n }, (_, i) => ({ kind, id: `${kind}:${group}${i}~user`, group, label: `${group}${i}`, from: '1.0.0', to: '1.1.0' }));
    const out = { offers: [...mk(6, 'catalog', 'plugin'), ...mk(5, 'other', 'plugin'), ...mk(3, 'mcp', 'mcp')], unchecked: mk(2, 'other', 'plugin').map((o) => ({ ...o, id: o.id + 'u', to: null })), skipped: [], held: [], errors: [], lsp: [], notes: [] };
    const q = update.questions(out);
    assert.deepStrictEqual(q.offer.options.map((o) => o.label), ['All of them (Recommended)', 'Pick which', 'Skip']);
    assert.ok(q.pick.length >= 1);
    for (const call of q.pick)
    {
        assert.ok(call.length >= 1 && call.length <= 4);
        for (const item of call)
        {
            assert.ok(item.options.length <= 4);
            for (const o of item.options) assert.match(o.description, /^(plugin|mcp|lsp):/);
        }
    }
    const labels = q.pick.flat().flatMap((i) => i.options.map((o) => o.label));
    assert.strictEqual(new Set(labels).size, labels.length, 'labels are unique');
    // only unchecked plugins: 'All of them' would update nothing, so the recommended option is 'Pick which'
    const only = update.questions({ ...out, offers: [] });
    assert.deepStrictEqual(only.offer.options.map((o) => o.label), ['Pick which (Recommended)', 'Skip']);
});

test('arguments: exactly one mode, and a stray flag is refused', async () =>
{
    const w = world();
    try
    {
        assert.strictEqual((await run(w, [])).code, 2);
        assert.strictEqual((await run(w, ['--check', '--questions'])).code, 2);
        assert.match((await run(w, ['--nope'])).text, /unknown argument/);
    }
    finally { w.clean(); }
});

test('update --apply keeps <tmp> while a fetch file is handed on, and apply() called per server never removes it', async () =>
{
    const w = world();
    // update.main runs in this process: its os.tmpdir() is pointed at the world's own temp folder for the test
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try
    {
        const t = tempOf(w);
        Object.assign(process.env, { TMPDIR: t.root, TEMP: t.root, TMP: t.root });
        install(w, { picks: { sentry: { route: 'local', scope: 'local' }, serena: { scope: 'local' } } });
        // a live token in the sentry registration, as a user may have written it there
        const token = `sntryu_${crypto.randomBytes(16).toString('hex')}`;
        const before = inventory.buildInventory({ project: w.project, env: w.env }).registrations.find((r) => r.rowId === 'sentry');
        cli.run(['mcp', 'remove', before.name, '-s', 'local'], { cwd: w.project, env: w.env });
        cli.run(['mcp', 'add-json', before.name, JSON.stringify({ ...before.entry, env: { ...before.entry.env, SENTRY_ACCESS_TOKEN: token } }), '-s', 'local'], { cwd: w.project, env: w.env });
        const reg = fakeRegistry({ ...pypiSerena(['2.1.0', 60], ['2.2.0', 20]), 'npm:@sentry/mcp-server': [{ version: '0.42.0', time: ago(60) }, { version: '0.43.0', time: ago(20) }] });

        const dir = t.made();
        fs.writeFileSync(path.join(dir, 'inventory.json'), '{}');
        const a = await run(w, ['--apply', `mcp:serena~local,mcp:${before.name}~local`, '--tmp', dir], { registry: reg });
        assert.strictEqual(a.code, 0, a.text);
        assert.ok(fs.existsSync(path.join(dir, 'inventory.json')), 'apply() per server never removes the shared folder');
        const job = fs.readFileSync(path.join(dir, 'fetch.json'), 'utf8');
        assert.deepStrictEqual(JSON.parse(job).fetch.map((s) => s.name).sort(), [before.name, 'serena'].sort());
        assert.ok(!job.includes(token), 'the fetch file holds no live value');
        assert.ok(!a.text.includes(token));

        const none = t.made();
        const b = await run(w, ['--apply', 'mcp:nothing~local', '--tmp', none], { registry: reg });
        assert.strictEqual(b.code, 1);
        assert.ok(!fs.existsSync(none), 'nothing handed on: the folder is removed');
    }
    finally
    {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        w.clean();
    }
});
