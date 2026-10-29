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

test('the CLI form writes every credential value as the marker; nothing it prints holds one', () => {
    const w = world();
    try
    {
        const crypto = require('node:crypto');
        const { MARKER } = require('../scripts/kept.js');
        const token = `sntryu_${crypto.randomBytes(16).toString('hex')}`;
        const key = `sk-live-${crypto.randomBytes(16).toString('hex')}`;
        accountWith(w, { local: {
            'sentry-live': { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: token } },
            mine: { command: 'node', args: ['srv.js'], env: { API_KEY: key, MODE: 'x' } },
        } });
        const script = path.join(__dirname, '..', 'scripts', 'inventory.js');
        const out = path.join(w.dir, 'inv.json');
        const r = spawnSync(process.execPath, [script, '--project', w.project, '--json', out], { encoding: 'utf8', env: w.env });
        assert.strictEqual(r.status, 0, r.stderr);
        const printed = spawnSync(process.execPath, [script, '--project', w.project], { encoding: 'utf8', env: w.env });
        const text = fs.readFileSync(out, 'utf8');
        for (const v of [token, key]) for (const where of [text, r.stdout, r.stderr, printed.stdout]) assert.ok(!where.includes(v), 'no live value written or printed');
        const regs = JSON.parse(text).registrations;
        const sentry = regs.find((x) => x.name === 'sentry-live');
        assert.strictEqual(sentry.entry.env.SENTRY_ACCESS_TOKEN, MARKER);
        assert.strictEqual(sentry.rowId, 'sentry', 'still matched by what it launches');
        assert.deepStrictEqual(regs.find((x) => x.name === 'mine').entry.env, { API_KEY: MARKER, MODE: 'x' });
    }
    finally { w.clean(); }
});

// ---- inherited servers: the .mcp.json files above the project, as Claude Code reads them (docs/sources.md, '.mcp.json
// in parent folders', M1-M7). A tree shaped like tests/probes/mcp-tree.js's under the world's folder: a file above
// HOME, in HOME, in ws and in ws/api; ws/api and ws/web are git repos, ws one only when `gitWs`.

const SRV = (tag) => ({ command: 'node', args: ['server.js', tag] });
function tree(w, { gitWs = true } = {})
{
    const t = { above: w.dir, home: w.home, ws: path.join(w.home, 'ws') };
    Object.assign(t, { api: path.join(t.ws, 'api'), src: path.join(t.ws, 'api', 'src'), web: path.join(t.ws, 'web'), notes: path.join(t.ws, 'notes') });
    for (const d of [t.src, t.web, t.notes]) fs.mkdirSync(d, { recursive: true });
    writeJson(path.join(t.above, '.mcp.json'), { mcpServers: { 'p-above': SRV('p-above') } });
    writeJson(path.join(t.home, '.mcp.json'), { mcpServers: { 'p-home': SRV('p-home') } });
    writeJson(path.join(t.ws, '.mcp.json'), { mcpServers: { 'p-ws': SRV('p-ws'), dup: SRV('ws') } });
    writeJson(path.join(t.api, '.mcp.json'), { mcpServers: { 'p-api': SRV('p-api'), dup: SRV('api') } });
    for (const repo of gitWs ? [t.ws, t.api, t.web] : [t.api, t.web]) spawnSync('git', ['init', '-q', repo]);
    return t;
}
// what came from inside the world (a real file above the temp folder is the machine's, not the test's)
const inherited = (w, i) => i.registrations.filter((r) => r.scope === 'inherited' && !path.relative(w.dir, r.from).startsWith('..'));
const fromOf = (w, i) => inherited(w, i).map((r) => `${r.name}@${path.relative(w.dir, r.from).split(path.sep).join('/') || '.'}`);
const atProject = (w, project) => inv.buildInventory({ project, env: w.env, catalog });

test('the walk reads the parent .mcp.json files Claude Code reads (M1)', () => {
    for (const gitWs of [true, false])
    {
        const w = world();
        try
        {
            const t = tree(w, { gitWs });
            const dirs = (p) => inv.ancestorMcpFiles(p).map((f) => f.dir).filter((d) => !path.relative(w.dir, d).startsWith('..'));
            assert.deepStrictEqual(dirs(t.api), [t.ws, t.home, t.above], `ws/api, nearest first, HOME and above included (git ws: ${gitWs})`);
            assert.deepStrictEqual(dirs(t.src), [t.api, t.ws, t.home, t.above], `ws/api/src (git ws: ${gitWs})`);
            assert.deepStrictEqual(fromOf(w, atProject(w, t.src)), ['p-api@home/ws/api', 'dup@home/ws/api', 'p-ws@home/ws', 'dup@home/ws', 'p-home@home', 'p-above@.']);
            assert.deepStrictEqual(fromOf(w, atProject(w, t.api)), ['p-ws@home/ws', 'dup@home/ws', 'p-home@home', 'p-above@.'], "the project's own file is not inherited");
            const r = inherited(w, atProject(w, t.src)).find((x) => x.name === 'p-api');
            assert.deepStrictEqual([r.file, r.own, r.rowId], [path.join(t.api, '.mcp.json'), true, null]);
        }
        finally { w.clean(); }
    }
});

test('the same name nearer wins, the farther one is shadowed (M2)', () => {
    const w = world();
    try
    {
        const t = tree(w);
        const dups = (p) => inherited(w, atProject(w, p)).filter((r) => r.name === 'dup').map((r) => [path.relative(w.home, r.from).split(path.sep).join('/'), r.shadowed]);
        assert.deepStrictEqual(dups(t.src), [['ws/api', null], ['ws', { scope: 'inherited', from: t.api }]]);
        assert.deepStrictEqual(dups(t.api), [['ws', { scope: 'project', from: t.api }]], "the project's own .mcp.json is nearer still");
    }
    finally { w.clean(); }
});

test('a local copy shadows the inherited one (M3)', () => {
    const w = world();
    try
    {
        const t = tree(w);
        writeJson(account.accountFile(w.env), { projects: { [accountKey(t.web)]: { mcpServers: { dup: SRV('local') } } } });
        const i = atProject(w, t.web);
        assert.deepStrictEqual(inherited(w, i).find((r) => r.name === 'dup').shadowed, { scope: 'local', from: null });
        assert.ok(i.registrations.some((r) => r.name === 'dup' && r.scope === 'local'));
    }
    finally { w.clean(); }
});

test('a malformed parent .mcp.json is named, not fatal', () => {
    const w = world();
    try
    {
        const t = tree(w);
        fs.writeFileSync(path.join(t.ws, '.mcp.json'), '{ not json');
        const i = atProject(w, t.api);
        assert.deepStrictEqual(fromOf(w, i), ['p-home@home', 'p-above@.'], 'only that file is lost, as M6 measured');
        const u = i.unreadable.filter((x) => x.scope === 'inherited');
        assert.deepStrictEqual(u.map((x) => [x.file, x.state]), [[path.join(t.ws, '.mcp.json'), 'malformed']]);
        assert.ok(i.sources.inherited.some((s) => s.file === path.join(t.ws, '.mcp.json') && s.state === 'malformed'));
        assert.deepStrictEqual(i.registrations.filter((r) => r.scope === 'project').map((r) => r.name), ['p-api', 'dup'], 'its own file still read');
    }
    finally { w.clean(); }
});

test('the walk follows a symlinked cwd the way Claude Code does (M5)', () => {
    const w = world();
    try
    {
        const t = tree(w);
        const link = path.join(w.dir, 'link');
        fs.symlinkSync(t.api, link, process.platform === 'win32' ? 'junction' : 'dir');
        const i = atProject(w, link);
        assert.deepStrictEqual(fromOf(w, i), ['p-ws@home/ws', 'dup@home/ws', 'p-home@home', 'p-above@.'], "the real folder's parents, not the link's");
        assert.deepStrictEqual(inherited(w, i).map((r) => inv.fromHere(i, r.from)), ['..', '..', '../..', '../../..'], 'named from the real folder, as Claude Code walks it');
    }
    finally { w.clean(); }
});

test('the approval of an inherited server follows the measured rules (M7)', () => {
    const w = world();
    try
    {
        const t = tree(w);
        const acct = account.accountFile(w.env);
        const childLocal = path.join(t.web, '.claude', 'settings.local.json');
        const parentLocal = path.join(t.ws, '.claude', 'settings.local.json');
        const user = path.join(w.account, 'settings.json');
        const approval = ({ trusted = false, entry = {}, files = {} } = {}) =>
        {
            for (const f of [childLocal, parentLocal, user]) fs.rmSync(f, { force: true });
            for (const [f, doc] of Object.entries(files)) writeJson(f, doc);
            writeJson(acct, { projects: { [accountKey(t.web)]: { hasTrustDialogAccepted: trusted, ...entry } } });
            return inherited(w, atProject(w, t.web)).find((r) => r.name === 'p-ws').approval;
        };
        const on = { enabledMcpjsonServers: ['p-ws'] };
        const off = { disabledMcpjsonServers: ['p-ws'] };
        assert.strictEqual(approval({ trusted: true }), 'pending', 'nothing set');
        assert.strictEqual(approval({ trusted: true, entry: on }), 'approved', "the account file's entry, trusted");
        assert.strictEqual(approval({ trusted: false, entry: on }), 'pending', "the account file's entry, untrusted");
        assert.strictEqual(approval({ trusted: true, files: { [childLocal]: on } }), 'approved', "the folder's settings.local.json, trusted");
        assert.strictEqual(approval({ trusted: false, files: { [childLocal]: on } }), 'pending', "the folder's settings.local.json, untrusted");
        assert.strictEqual(approval({ trusted: true, files: { [parentLocal]: on } }), 'pending', "a parent folder's settings approve nothing");
        assert.strictEqual(approval({ trusted: false, entry: off }), 'rejected', "disabled in the account file's entry");
        assert.strictEqual(approval({ trusted: true, files: { [childLocal]: off } }), 'rejected', "disabled in the folder's settings.local.json");
        assert.strictEqual(approval({ trusted: false, files: { [user]: { enableAllProjectMcpServers: true } } }), 'approved', 'enableAllProjectMcpServers in the user settings, untrusted');
    }
    finally { w.clean(); }
});

test('no parent file, no inherited entry', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { mine: SRV('mine') } });
        const i = build(w);
        assert.deepStrictEqual(inherited(w, i), []);
        assert.deepStrictEqual(i.sources.inherited.filter((s) => !path.relative(w.dir, s.file).startsWith('..')), []);
    }
    finally { w.clean(); }
});

test('a subfolder session reads the project file and key M4 measured', () => {
    for (const gitWs of [true, false])
    {
        const w = world();
        try
        {
            const t = tree(w, { gitWs });
            writeJson(path.join(t.src, '.mcp.json'), { mcpServers: { here: SRV('here') } });
            // inside a repo the local key is the repo root; in no repo, the folder itself
            const notesKey = gitWs ? t.ws : t.notes;
            writeJson(account.accountFile(w.env), { projects: {
                [accountKey(t.api)]: { mcpServers: { 'at-root': SRV('root') } },
                [accountKey(t.src)]: { mcpServers: { 'at-cwd': SRV('cwd') } },
                [accountKey(notesKey)]: { mcpServers: { 'notes-key': SRV('notes') } },
            } });
            const src = atProject(w, t.src);
            assert.deepStrictEqual(src.registrations.filter((r) => r.scope === 'project').map((r) => r.name), ['here'], "ws/api/src's own .mcp.json is its project file");
            assert.deepStrictEqual(src.registrations.filter((r) => r.scope === 'local').map((r) => r.name), ['at-root'], 'ws/api/src: the local servers keyed on the repo root');
            assert.deepStrictEqual(atProject(w, t.notes).registrations.filter((r) => r.scope === 'local').map((r) => r.name), ['notes-key'], `ws/notes (git ws: ${gitWs})`);
            assert.strictEqual(account.readRegistration('at-root', 'local', t.src, w.env).args[1], 'root');
            assert.strictEqual(account.readRegistration('here', 'project', t.src, w.env).args[1], 'here');
        }
        finally { w.clean(); }
    }
});

// ---- windows-mcp: the servers that start here ------------------------------------------------------------------------

const WM = (scope, name, extra = {}) => ({ name, scope, entry: {}, rowId: 'windows-control', route: 'local', own: false, alfredRetired: false, ...extra });
const PLUG = (id, enabled, scope = 'user') => { const [plugin, marketplace] = id.split('@'); return { id, plugin, marketplace, scope, enabled, rowId: null, alfredRetired: plugin === 'windows-control' }; };
const startsHere = (registrations, plugins = []) => inv.windowsMcpServers({ registrations, plugins }).map((s) => `${s.name} ${s.scope} ${s.owner}`);

test('windowsMcpServers: one per name at its nearest scope, approved inherited only, enabled alfred-code plugins only', () => {
    const registrations = [
        WM('user', 'windows-desktop'),
        WM('local', 'windows-desktop'),
        { name: 'windows-control', scope: 'local', entry: {}, rowId: null, route: null, own: true, alfredRetired: true },
        WM('inherited', 'wd-parent', { from: '/a', approval: 'approved', shadowed: null }),
        WM('inherited', 'wd-pending', { from: '/a', approval: 'pending', shadowed: null }),
        WM('inherited', 'wd-shadowed', { from: '/b', approval: 'approved', shadowed: { scope: 'inherited', from: '/a' } }),
    ];
    const plugins = [PLUG('windows-control@envoydev', true), PLUG('windows-desktop@envoydev', false), PLUG('windows-desktop@other', true)];
    assert.deepStrictEqual(startsHere(registrations, plugins),
        ['windows-desktop local catalog', 'windows-control local alfred-code', 'wd-parent inherited catalog', 'windows-control@envoydev user alfred-code']);
    // an approved parent's copy ranks above user scope (M2, M3): one server, the inherited one
    assert.deepStrictEqual(startsHere([WM('user', 'wd-parent'), WM('inherited', 'wd-parent', { from: '/a', approval: 'approved', shadowed: null })]), ['wd-parent inherited catalog']);
    // a nearer server of the same name that is not windows-mcp is the one that starts
    assert.deepStrictEqual(startsHere([{ name: 'windows-desktop', scope: 'local', entry: {}, rowId: null, route: null, own: true, alfredRetired: false }, WM('user', 'windows-desktop')]), []);
    // alfred-code's 2.4.0 plugin name launches it too
    assert.deepStrictEqual(startsHere([], [PLUG('windows-desktop@envoydev', true, 'local')]), ['windows-desktop@envoydev local alfred-code']);
});

test('windowsMcpServers: a plugin that cannot load is not counted - a dropped id says so only in its errors (S13, S25)', () => {
    const dropped = { ...PLUG('windows-control@envoydev', true), errors: ['plugin windows-control not found in marketplace envoydev'] };
    assert.deepStrictEqual(startsHere([WM('local', 'windows-desktop')], [dropped]), ['windows-desktop local catalog']);
});
