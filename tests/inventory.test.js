'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { world, writeJson, accountKey } = require('./helpers.js');
const inv = require('../scripts/inventory.js');
const catalogLib = require('../scripts/catalog.js');
const account = require('../scripts/account.js');

const catalog = catalogLib.load();
const SERENA = { command: 'uvx', args: ['--python', '3.13', '--exclude-newer', '2026-10-20T23:59:59Z', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: { SERENA_HOME: '/x' } };
const PW = (engine, ver = '0.0.83') => ({ command: 'npx', args: ['-y', `@playwright/mcp@${ver}`, '--browser', engine, '--user-data-dir', `/p/${engine}`] });
const URL_ = (u) => ({ type: 'http', url: u });
const build = (w, extra = {}) => inv.buildInventory({ project: w.project, env: w.env, catalog, ...extra });

function accountWith(w, { user = {}, local = {} } = {})
{
    writeJson(account.accountFile(w.env), { mcpServers: user, projects: { [accountKey(w.project)]: { mcpServers: local } } });
}

test('a registration is matched by what it launches, under any name', () => {
    const cases = [
        [SERENA, 'serena'],
        [{ command: 'uvx', args: ['--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'] }, 'memory'],
        [PW('chrome'), 'playwright-chrome'], [PW('msedge'), 'playwright-msedge'], [PW('firefox'), 'playwright-firefox'], [PW('webkit'), 'playwright-webkit'],
        [{ command: 'npx', args: ['-y', 'appium-mcp@1.97.1'] }, 'appium'],
        [{ command: 'uvx', args: ['--from', 'macos-mcp==0.4.6', 'macos-mcp', 'serve'] }, 'macos-control'],
        [{ command: 'uvx', args: ['--from', 'windows-mcp==0.8.8', 'windows-mcp', 'serve'] }, 'windows-control'],
        [URL_('https://mcp.context7.com/mcp'), 'context7'],
        [{ command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4'] }, 'context7'],
        [URL_('https://api.githubcopilot.com/mcp/'), 'github'],
        [{ command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v2.0.2', 'stdio'] }, 'github'],
        [{ command: 'github-mcp-server', args: ['stdio'] }, 'github'],
        [URL_('https://gitlab.com/api/v4/mcp'), 'gitlab'],
        [URL_('https://git.corp.example/api/v4/mcp'), 'gitlab'], // a self-managed host is recognised too
        [URL_('https://mcp.atlassian.com/v2/mcp'), 'atlassian'], [URL_('https://mcp.atlassian.com/v1/mcp'), 'atlassian'],
        [URL_('https://mcp.sentry.dev/mcp'), 'sentry'], [URL_('https://mcp.sentry.dev/mcp/acme/web'), 'sentry'],
        [{ command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'] }, 'sentry'],
    ];
    for (const [entry, row] of cases)
    {
        const m = inv.matchEntry(entry, catalog);
        assert.ok(m, `${JSON.stringify(entry)} should match ${row}`);
        assert.strictEqual(m.rowId, row, JSON.stringify(entry));
    }
});

test('the cmd /c wrapper is looked through, and a bare Playwright with no --browser is nobody\'s', () => {
    assert.strictEqual(inv.matchEntry({ command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@0.0.83', '--browser', 'firefox'] }, catalog).rowId, 'playwright-firefox');
    assert.strictEqual(inv.matchEntry({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', '-y', 'appium-mcp@1.97.1'] }, catalog).rowId, 'appium');
    assert.strictEqual(inv.matchEntry({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, catalog), null);
    assert.strictEqual(inv.matchEntry({ command: 'npx', args: ['-y', '@playwright/mcp@latest', '--browser=webkit'] }, catalog).rowId, 'playwright-webkit');
});

test('a user\'s own server is never matched, even under a catalog name', () => {
    const own = [
        { command: 'node', args: ['/home/me/my-serena/server.js'] },
        { command: 'uvx', args: ['--from', 'git+https://example.com/fork/serena', 'serena'] },
        URL_('https://example.com/mcp'),
        URL_('https://github.example.com/mcp'),
        { command: 'npx', args: ['-y', '@playwright/mcp-extras', '--browser', 'chrome'] },
    ];
    for (const e of own) assert.strictEqual(inv.matchEntry(e, catalog), null, JSON.stringify(e));
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { serena: own[0], memory: own[2] } });
        const i = build(w);
        assert.deepStrictEqual(i.registrations.map((r) => [r.name, r.rowId, r.own]), [['serena', null, true], ['memory', null, true]]);
        assert.strictEqual(inv.installedOf(i, 'serena').length, 0);
        assert.strictEqual(inv.installedOf(i, 'memory').length, 0);
    }
    finally { w.clean(); }
});

test('a row installed at two scopes under two names is both found', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { 'docs-lib': URL_('https://mcp.context7.com/mcp') } });
        accountWith(w, { user: { c7: URL_('https://mcp.context7.com/mcp') }, local: { 'proj-serena': SERENA } });
        const i = build(w);
        const c7 = inv.installedOf(i, 'context7');
        assert.deepStrictEqual(c7.map((x) => [x.name, x.scope, x.route]).sort(), [['c7', 'user', 'remote'], ['docs-lib', 'project', 'remote']]);
        assert.deepStrictEqual(inv.installedOf(i, 'serena').map((x) => [x.name, x.scope]), [['proj-serena', 'local']]);
        assert.strictEqual(i.unreadable.length, 0);
    }
    finally { w.clean(); }
});

test('local entries of another project are not this project\'s', () => {
    const w = world();
    try
    {
        writeJson(account.accountFile(w.env), { projects: { '/somewhere/else': { mcpServers: { serena: SERENA } }, [accountKey(w.project)]: { mcpServers: {} } } });
        assert.strictEqual(build(w).registrations.length, 0);
    }
    finally { w.clean(); }
});

test('Windows: local servers are found under the key Claude Code writes - the cwd as typed, `/` for `\\`, its case kept', () => {
    const w = world();
    try
    {
        const local = (projects, project, platform = 'win32') =>
        {
            writeJson(account.accountFile(w.env), { projects });
            return Object.keys(account.readAccount(w.env, project, platform).local);
        };
        const entry = (name) => ({ mcpServers: { [name]: SERENA } });
        assert.deepStrictEqual(local({ 'C:/work/shop': entry('serena') }, 'C:\\work\\shop'), ['serena'], 'the slash form');
        assert.deepStrictEqual(local({ 'C:/Work/Shop': entry('serena') }, 'c:\\work\\shop'), ['serena'], 'typed in another case, the same NTFS folder');
        assert.deepStrictEqual(local({ 'C:/work/shop': entry('upper'), 'c:/work/shop': entry('lower') }, 'c:\\work\\shop'), ['lower'], 'the key typed as this cwd wins');
        assert.deepStrictEqual(local({ 'C:/work/shop2': entry('serena') }, 'C:\\work\\shop'), [], 'a longer name is another folder');
        assert.deepStrictEqual(local({ '/work/Shop': entry('serena') }, '/work/shop', 'linux'), [], 'Linux keys stay exact');
    }
    finally { w.clean(); }
});

test('a missing, an empty and a malformed .mcp.json each say what they are', () => {
    const w = world();
    try
    {
        const f = path.join(w.project, '.mcp.json');
        let i = build(w);
        assert.strictEqual(i.sources.project.state, 'missing');
        assert.deepStrictEqual(i.unreadable, []);
        fs.writeFileSync(f, '');
        i = build(w);
        assert.strictEqual(i.sources.project.state, 'empty');
        assert.deepStrictEqual(i.unreadable, []);
        fs.writeFileSync(f, '{ "mcpServers": { "a": ');
        i = build(w);
        assert.strictEqual(i.sources.project.state, 'malformed');
        assert.deepStrictEqual(i.unreadable.map((u) => [u.scope, u.state]), [['project', 'malformed']]);
        assert.strictEqual(i.registrations.length, 0);
        fs.writeFileSync(f, '{"mcpServers": []}');
        assert.doesNotThrow(() => build(w));
    }
    finally { w.clean(); }
});

test('a BOM at the start of .mcp.json does not read as an empty file', () => {
    const w = world();
    try
    {
        fs.writeFileSync(path.join(w.project, '.mcp.json'), `﻿${JSON.stringify({ mcpServers: { serena: SERENA } })}`);
        const i = build(w);
        assert.strictEqual(i.sources.project.state, 'ok');
        assert.strictEqual(i.registrations[0].rowId, 'serena');
    }
    finally { w.clean(); }
});

test('a malformed account file makes the local and user scopes unreadable and does not hide the project scope', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { serena: SERENA } });
        fs.writeFileSync(account.accountFile(w.env), '{ nope');
        const i = build(w);
        assert.deepStrictEqual(i.unreadable.map((u) => u.scope).sort(), ['local', 'user']);
        assert.strictEqual(i.registrations.length, 1);
    }
    finally { w.clean(); }
});

test('CLAUDE_CONFIG_DIR picks the account file, and a missing one is just empty', () => {
    const w = world();
    try
    {
        assert.strictEqual(account.accountFile(w.env), path.join(w.account, '.claude.json'));
        assert.strictEqual(account.accountFile({ HOME: '/h' }), path.join('/h', '.claude.json'));
        assert.strictEqual(account.configDir({ HOME: '/h' }), path.join('/h', '.claude'));
        assert.strictEqual(build(w).sources.account.state, 'missing');
    }
    finally { w.clean(); }
});

test('servers under a name alfred-code once registered are marked retired, whatever they launch', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { 'chrome-control': PW('chrome'), 'alfred-navigation': SERENA, serena: SERENA } });
        const i = build(w);
        const by = Object.fromEntries(i.registrations.map((r) => [r.name, r]));
        assert.strictEqual(by['chrome-control'].alfredRetired, true);
        assert.strictEqual(by['alfred-navigation'].alfredRetired, true);
        assert.strictEqual(by.serena.alfredRetired, false);
        // offered nothing over: installedOf skips them
        assert.deepStrictEqual(inv.installedOf(i, 'playwright-chrome'), []);
        assert.strictEqual(inv.installedOf(i, 'serena').length, 1);
    }
    finally { w.clean(); }
});

test('plugins: catalog rows by exact id, enabled read from the settings file at their scope, errors kept', () => {
    const w = world();
    try
    {
        const proj = account.projectKey(w.project);
        writeJson(path.join(w.dir, 'state', 'plugins.json'), { marketplaces: [{ name: 'claude-hud', repo: 'jarrodwatts/claude-hud', installLocation: '/m' }], installed: [
            { id: 'claude-hud@claude-hud', version: '0.12.1', scope: 'user', enabled: false, installPath: '/c' },
            { id: 'typescript-lsp@claude-plugins-official', version: '1.0.0', scope: 'project', enabled: false, projectPath: proj, installPath: '/c' },
            { id: 'csharp-lsp@claude-plugins-official', version: '1.0.0', scope: 'project', enabled: true, projectPath: '/other/project', installPath: '/c' },
            { id: 'alfred-code@envoydev', version: '2.9.0', scope: 'user', enabled: true, installPath: '/c' },
            { id: 'alfred-navigation@envoydev', version: '2.9.0', scope: 'user', enabled: true, installPath: '/c' },
            { id: 'broken@somewhere', version: '1.0.0', scope: 'user', enabled: false, errors: ['cannot load'], installPath: '/c' },
        ] });
        // the list's flag says false for claude-hud, the settings file at its scope says true: the file wins
        writeJson(path.join(w.account, 'settings.json'), { enabledPlugins: { 'claude-hud@claude-hud': true, 'alfred-code@envoydev': true } });
        writeJson(path.join(w.project, '.claude', 'settings.json'), { enabledPlugins: { 'typescript-lsp@claude-plugins-official': true } });
        const i = build(w);
        const by = Object.fromEntries(i.plugins.map((p) => [p.id, p]));
        assert.strictEqual(by['claude-hud@claude-hud'].enabled, true);
        assert.strictEqual(by['claude-hud@claude-hud'].enabledFrom, 'settings');
        assert.strictEqual(by['claude-hud@claude-hud'].rowId, 'claude-hud');
        assert.strictEqual(by['typescript-lsp@claude-plugins-official'].enabled, true);
        assert.ok(!('csharp-lsp@claude-plugins-official' in by), 'another project\'s plugin row is not this project\'s');
        assert.strictEqual(by['alfred-navigation@envoydev'].alfredRetired, true);
        assert.deepStrictEqual(by['broken@somewhere'].errors, ['cannot load']);
        assert.strictEqual(by['broken@somewhere'].rowId, null);
        assert.strictEqual(i.alfredCodeEnabled, true);
        assert.deepStrictEqual(i.marketplaces.map((m) => m.name), ['claude-hud']);
    }
    finally { w.clean(); }
});

test('the inventory reads only: no write call reaches the CLI and no server starts', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { serena: SERENA } });
        build(w);
        assert.deepStrictEqual(w.writes(), []);
        assert.ok(w.calls().every((a) => a[0] === '--version' || a[0] === 'plugin'), JSON.stringify(w.calls()));
    }
    finally { w.clean(); }
});

test('the CLI form writes the JSON file and prints one line; a missing claude stops with one line', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { a: SERENA, b: { command: 'node' } } });
        const out = path.join(w.dir, 'inv.json');
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'inventory.js'), '--project', w.project, '--json', out], { encoding: 'utf8', env: w.env });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /inventory: 2 registrations \(1 match a catalog row, 1 are your own\), 0 plugins/);
        assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).registrations.length, 2);
        // an empty PATH, not node's own folder: on Linux a global npm install puts claude beside node
        const empty = path.join(w.dir, 'empty-bin');
        fs.mkdirSync(empty);
        const bare = { ...w.env, PATH: empty };
        const r2 = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'inventory.js'), '--project', w.project], { encoding: 'utf8', env: bare });
        assert.strictEqual(r2.status, 3);
        assert.match(r2.stderr, /the claude CLI is not on PATH/);
        assert.strictEqual(r2.stderr.trim().split('\n').length, 1);
    }
    finally { w.clean(); }
});
