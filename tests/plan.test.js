'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const catalogLib = require('../scripts/catalog.js');
const { plan, render, argvOf } = require('../scripts/plan.js');
const asks = require('../scripts/asks.js');

const catalog = catalogLib.load();
const clone = () => JSON.parse(JSON.stringify({ ...catalog, reserved: [...catalog.reserved], byId: undefined }));
// a catalog where the named local routes may sit in the committed .mcp.json (step 12 measures that per row)
function withProjectScope(...ids)
{
    const raw = clone();
    for (const t of raw.tools) if (ids.includes(t.id)) for (const r of Object.values(t.routes)) r.projectScope = true;
    return { ...raw, reserved: new Set(raw.reserved), byId: new Map(raw.tools.map((r) => [r.id, r])) };
}

const MAC = { os: 'darwin', arch: 'arm64', project: '/work/shop' };
const LINUX = { os: 'linux', arch: 'x64', project: '/work/shop' };
const WIN = { os: 'win32', arch: 'x64', project: 'C:\\work\\shop' };
const WINARM = { os: 'win32', arch: 'arm64', project: 'C:\\work\\shop' };
const inv = (base, extra = {}) => ({ version: 1, ...base, cli: { ok: true }, unreadable: [], registrations: [], plugins: [], marketplaces: [], alfredCodeEnabled: false, sources: {}, ...extra });
const opts = (home, extra = {}) => ({ home, env: {}, exists: () => false, machine: { docker: true }, ...extra });
const pickOne = (id, pick = {}) => ({ picks: { [id]: pick } });
const addStep = (p, i = 0) => p.steps.filter((s) => s.op === 'mcp-add')[i];
const reg = (name, scope, entry, rowId = null, route = null, flags = {}) => ({ name, scope, entry, rowId, route, own: !rowId, alfredRetired: false, ...flags });

test('serena, fresh, per OS: python request, cut-off, telemetry off, home by the OS\'s rules', () => {
    const mac = plan(inv(MAC), pickOne('serena'), opts('/Users/me'));
    assert.deepStrictEqual(mac.errors, []);
    const s = addStep(mac);
    assert.strictEqual(s.scope, 'local');
    assert.deepStrictEqual(s.entry.args.slice(0, 6), ['--python', '3.13', '--exclude-newer', '2026-10-20T23:59:59Z', '--from', 'serena-agent@2.1.0']);
    assert.strictEqual(s.entry.env.SERENA_USAGE_REPORTING, 'false');
    assert.strictEqual(s.entry.env.SERENA_HOME, '/work/shop/.preferred-tools/serena');
    assert.strictEqual(plan(inv(LINUX), pickOne('serena'), opts('/home/me')).steps.find((x) => x.op === 'mcp-add').entry.args[1], '3.13');
});

test('serena on Windows: SERENA_HOME is absolute, in backslashes and space-free; x64 uses 3.13, ARM64 the x64 build', () => {
    const x64 = plan(inv(WIN), pickOne('serena'), opts('C:\\Users\\me'));
    assert.deepStrictEqual(x64.errors, []);
    const e = addStep(x64).entry;
    assert.strictEqual(e.env.SERENA_HOME, 'C:\\Users\\me\\.serena');
    assert.match(e.env.SERENA_HOME, /^[A-Za-z]:\\[^/\s]*$/);
    assert.strictEqual(e.args[1], '3.13');
    const arm = addStep(plan(inv(WINARM), pickOne('serena'), opts('C:\\Users\\me'))).entry;
    assert.strictEqual(arm.args[1], 'cpython-3.13-windows-x86_64-none');
    // an x64 node emulated on ARM is still ARM
    const emu = plan(inv({ ...WIN }), pickOne('serena'), opts('C:\\Users\\me', { env: { PROCESSOR_IDENTIFIER: 'ARMv8 (64-bit) Family 8 Model 1' } }));
    assert.strictEqual(addStep(emu).entry.args[1], 'cpython-3.13-windows-x86_64-none');
});

test('serena on Windows: a profile path with a space asks for a folder; a typed one must be absolute and space-free', () => {
    const spaced = plan(inv(WIN), pickOne('serena'), opts('C:\\Users\\Jo Doe'));
    assert.match(spaced.errors[0], /has a space/);
    assert.strictEqual(spaced.steps.length, 0);
    const typed = plan(inv(WIN), pickOne('serena', { location: { side: 'path', path: 'C:/serena-home' } }), opts('C:\\Users\\Jo Doe'));
    assert.deepStrictEqual(typed.errors, []);
    assert.strictEqual(addStep(typed).entry.env.SERENA_HOME, 'C:\\serena-home');
    const bad = plan(inv(WIN), pickOne('serena', { location: { side: 'path', path: 'C:\\my serena' } }), opts('C:\\Users\\me'));
    assert.match(bad.errors.join(' '), /absolute, in backslashes and space-free/);
    // a relative or ~ spelling is written out absolute, in backslashes
    for (const [typedPath, want] of [['relative\\serena', 'C:\\work\\shop\\relative\\serena'], ['~/serena', 'C:\\Users\\me\\serena']])
        assert.strictEqual(addStep(plan(inv(WIN), pickOne('serena', { location: { side: 'path', path: typedPath } }), opts('C:\\Users\\me'))).entry.env.SERENA_HOME, want);
    // a project folder with a space cannot hold the home: the typed path is refused, not silently moved
    const spacedProject = plan(inv({ ...WIN, project: 'C:\\my work\\shop' }), pickOne('serena', { location: { side: 'path', path: 'sub' } }), opts('C:\\Users\\me'));
    assert.match(spacedProject.errors.join(' '), /space-free/);
    // the Windows rule wins over alfred-code data already on disk
    const alfred = plan(inv(WIN), pickOne('serena'), opts('C:\\Users\\me', { exists: () => true }));
    assert.strictEqual(addStep(alfred).entry.env.SERENA_HOME, 'C:\\Users\\me\\.serena');
});

test('uvx rows get their own python: windows-control 3.14 (x64 build on ARM64), memory 3.13', () => {
    const w = addStep(plan(inv(WIN), pickOne('windows-control'), opts('C:\\Users\\me'))).entry;
    assert.deepStrictEqual(w.args.slice(0, 4), ['--python', '3.14', '--exclude-newer', '2026-10-20T23:59:59Z']);
    assert.deepStrictEqual(w.args.slice(-3), ['serve', '--exclude-tools', 'PowerShell,Registry,Process,FileSystem']);
    assert.strictEqual(w.env.ANONYMIZED_TELEMETRY, 'false');
    const arm = addStep(plan(inv(WINARM), pickOne('windows-control'), opts('C:\\Users\\me'))).entry;
    assert.strictEqual(arm.args[1], 'cpython-3.14-windows-x86_64-none');
    const mem = addStep(plan(inv(MAC), pickOne('memory'), opts('/Users/me'))).entry;
    assert.ok(mem.args.includes('mcp-memory-service[sqlite]==12.1.1'));
    assert.ok(!mem.args.includes('--with'), 'numpy is a core dependency of the pin');
    assert.strictEqual(mem.env.MCP_MEMORY_SQLITE_PATH, '/Users/me/.preferred-tools/memory/memory.db');
});

test('desktop control is offered only on its own OS', () => {
    assert.match(plan(inv(MAC), pickOne('windows-control'), opts('/Users/me')).errors[0], /not offered on darwin/);
    assert.match(plan(inv(WIN), pickOne('macos-control'), opts('C:\\Users\\me')).errors[0], /not offered on win32/);
    assert.match(plan(inv(LINUX), pickOne('macos-control'), opts('/home/me')).errors[0], /not offered on linux/);
    assert.deepStrictEqual(plan(inv(MAC), pickOne('macos-control'), opts('/Users/me')).errors, []);
});

test('npx rows: pinned, with the cut-off in npm_config_before; native Windows gets the cmd /c precaution', () => {
    const mac = addStep(plan(inv(MAC), pickOne('playwright-chrome'), opts('/Users/me'))).entry;
    assert.strictEqual(mac.command, 'npx');
    assert.deepStrictEqual(mac.args.slice(0, 4), ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome']);
    assert.ok(mac.args.includes('--no-webmcp'));
    assert.strictEqual(mac.env.npm_config_before, '2026-10-20T23:59:59Z');
    const win = addStep(plan(inv(WIN), pickOne('playwright-chrome'), opts('C:\\Users\\me'))).entry;
    assert.strictEqual(win.command, 'cmd');
    assert.deepStrictEqual(win.args.slice(0, 3), ['/c', 'npx', '-y']);
    assert.strictEqual(win.env.npm_config_before, '2026-10-20T23:59:59Z');
    const ap = addStep(plan(inv(MAC), pickOne('appium'), opts('/Users/me'))).entry;
    assert.deepStrictEqual(ap.args, ['-y', 'appium-mcp@1.97.1']);
    assert.strictEqual(ap.env.SCREENSHOTS_DIR, '/work/shop/.preferred-tools/appium-mcp/screenshots');
    assert.strictEqual(ap.env.PAGE_SOURCES_DIR, '/work/shop/.preferred-tools/appium-mcp/page-sources');
    assert.strictEqual(ap.env.ALLOW_REMOTE_APP_URLS, 'false');
});

test('routes: context7, github and sentry each build both ways; the others have one', () => {
    const c7r = addStep(plan(inv(MAC), pickOne('context7', { route: 'remote' }), opts('/h'))).entry;
    assert.deepStrictEqual(c7r, { type: 'http', url: 'https://mcp.context7.com/mcp' });
    const c7k = addStep(plan(inv(MAC), pickOne('context7', { route: 'remote', token: true }), opts('/h'))).entry;
    assert.deepStrictEqual(c7k.headers, { Authorization: 'Bearer ${CONTEXT7_API_KEY}' });
    const c7l = addStep(plan(inv(MAC), pickOne('context7', { route: 'local', token: true }), opts('/h'))).entry;
    assert.deepStrictEqual(c7l.args, ['-y', '@upstash/context7-mcp@4.4.4', '--api-key', '${CONTEXT7_API_KEY}']);
    const gh = addStep(plan(inv(MAC), pickOne('github', { route: 'local' }), opts('/h'))).entry;
    assert.deepStrictEqual(gh.args, ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v2.0.2', 'stdio']);
    assert.deepStrictEqual(gh.env, { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' });
    const ghb = addStep(plan(inv(MAC), pickOne('github', { route: 'local' }), opts('/h', { machine: { docker: false } }))).entry;
    assert.deepStrictEqual([ghb.command, ghb.args], ['github-mcp-server', ['stdio']]);
    const ghr = addStep(plan(inv(MAC), pickOne('github', { route: 'remote' }), opts('/h'))).entry;
    assert.deepStrictEqual(ghr.headers, { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' });
    const sr = addStep(plan(inv(MAC), pickOne('sentry', { route: 'remote' }), opts('/h'))).entry;
    assert.deepStrictEqual(sr, { type: 'http', url: 'https://mcp.sentry.dev/mcp' });
    const sl = addStep(plan(inv(MAC), pickOne('sentry', { route: 'local' }), opts('/h'))).entry;
    assert.strictEqual(sl.env.SENTRY_ACCESS_TOKEN, '${SENTRY_ACCESS_TOKEN}');
    assert.match(plan(inv(MAC), pickOne('gitlab', { route: 'local' }), opts('/h')).errors[0], /no local route/);
    assert.match(plan(inv(MAC), pickOne('atlassian', { route: 'local' }), opts('/h')).errors[0], /no local route/);
    assert.strictEqual(addStep(plan(inv(MAC), pickOne('gitlab', { params: { host: 'git.corp.example' } }), opts('/h'))).entry.url, 'https://git.corp.example/api/v4/mcp');
    assert.strictEqual(addStep(plan(inv(MAC), pickOne('gitlab'), opts('/h'))).entry.url, 'https://gitlab.com/api/v4/mcp');
    assert.strictEqual(addStep(plan(inv(MAC), pickOne('atlassian'), opts('/h'))).entry.url, 'https://mcp.atlassian.com/v2/mcp');
});

test('a token route registers the ${VAR} and the plan says whether it is set; no token value is ever in the plan', () => {
    const fake = ['gh', 'p_', 'FAKE0123456789abcdefFAKE0123456789'].join('');
    const p = plan(inv(MAC), pickOne('github', { route: 'remote' }), opts('/h', { env: { GITHUB_PERSONAL_ACCESS_TOKEN: fake } }));
    assert.deepStrictEqual(p.tokens, [{ row: 'github', name: 'github', variable: 'GITHUB_PERSONAL_ACCESS_TOKEN', set: true }]);
    assert.ok(!JSON.stringify(p).includes(fake));
    assert.ok(!render(p).includes(fake));
    assert.match(render(p), /GITHUB_PERSONAL_ACCESS_TOKEN\} - set in this shell/);
    const unset = plan(inv(MAC), pickOne('github', { route: 'remote' }), opts('/h'));
    assert.match(render(unset), /NOT set here/);
});

test('scopes: local and user write absolute paths with ~ expanded; project is refused for a local route', () => {
    const user = addStep(plan(inv(MAC), pickOne('memory', { scope: 'user' }), opts('/Users/me'))).entry;
    assert.strictEqual(user.env.MCP_MEMORY_SQLITE_PATH, '/Users/me/.preferred-tools/memory/memory.db');
    assert.ok(!user.env.MCP_MEMORY_SQLITE_PATH.includes('~'));
    const typed = addStep(plan(inv(MAC), pickOne('playwright-chrome', { scope: 'local', location: { side: 'path', path: '~/pw/chrome' } }), opts('/Users/me'))).entry;
    assert.strictEqual(typed.args[typed.args.indexOf('--user-data-dir') + 1], '/Users/me/pw/chrome');
    assert.strictEqual(typed.args[typed.args.indexOf('--output-dir') + 1], '/Users/me/pw/chrome/output');
    const rel = addStep(plan(inv(MAC), pickOne('playwright-chrome', { location: { side: 'path', path: 'tools/pw' } }), opts('/Users/me'))).entry;
    assert.strictEqual(rel.args[rel.args.indexOf('--user-data-dir') + 1], '/work/shop/tools/pw');
    const p = plan(inv(MAC), pickOne('serena', { scope: 'project' }), opts('/Users/me'));
    assert.match(p.errors[0], /cannot be registered at project scope/);
    assert.strictEqual(p.steps.length, 0);
});

test('project scope (a row measured safe): relative paths and ${VAR} only, never an absolute path', () => {
    const cat = withProjectScope('playwright-chrome', 'memory');
    const o = opts('/Users/me', { catalog: cat });
    const rel = addStep(plan(inv(MAC), pickOne('playwright-chrome', { scope: 'project' }), o)).entry;
    assert.strictEqual(rel.args[rel.args.indexOf('--user-data-dir') + 1], '.preferred-tools/playwright-chrome');
    assert.strictEqual(rel.args[rel.args.indexOf('--output-dir') + 1], '.preferred-tools/playwright-chrome/output');
    const mem = addStep(plan(inv(MAC), pickOne('memory', { scope: 'project' }), o)).entry;
    assert.strictEqual(mem.env.MCP_MEMORY_SQLITE_PATH, '${HOME}/.preferred-tools/memory/memory.db');
    const memWin = addStep(plan(inv(WIN), pickOne('memory', { scope: 'project' }), opts('C:\\Users\\me', { catalog: cat }))).entry;
    assert.strictEqual(memWin.env.MCP_MEMORY_SQLITE_PATH, '${USERPROFILE}/.preferred-tools/memory/memory.db');
    const abs = plan(inv(MAC), pickOne('playwright-chrome', { scope: 'project', location: { side: 'path', path: '/abs/pw' } }), o);
    assert.match(abs.errors[0], /committed file/);
    assert.strictEqual(abs.steps.length, 0);
    const home = addStep(plan(inv(MAC), pickOne('playwright-chrome', { scope: 'project', location: { side: 'account' } }), o)).entry;
    assert.strictEqual(home.args[home.args.indexOf('--user-data-dir') + 1], '${HOME}/.preferred-tools/playwright-chrome');
    for (const e of [rel, mem, memWin, home]) assert.ok(!/\/Users\/|C:\\/.test(JSON.stringify(e)), JSON.stringify(e));
});

test('remote routes may sit at project scope', () => {
    for (const id of ['context7', 'gitlab', 'atlassian', 'sentry'])
    {
        const p = plan(inv(MAC), pickOne(id, { route: 'remote', scope: 'project' }), opts('/h'));
        assert.deepStrictEqual(p.errors, [], id);
        assert.strictEqual(addStep(p).scope, 'project');
    }
    assert.match(plan(inv(MAC), pickOne('sentry', { route: 'local', scope: 'project' }), opts('/h')).errors[0], /cannot be registered at project scope/);
});

test('locations: alfred-code data on disk first, then the project default; memory defaults to the account folder', () => {
    const has = (p) => p === '/work/shop/.alfred/chrome-control' || p === '/Users/me/.alfred-memory' || p === '/work/shop/.alfred/serena/home';
    const o = opts('/Users/me', { exists: has });
    const chrome = addStep(plan(inv(MAC), pickOne('playwright-chrome'), o)).entry;
    assert.strictEqual(chrome.args[chrome.args.indexOf('--user-data-dir') + 1], '/work/shop/.alfred/chrome-control');
    const mem = addStep(plan(inv(MAC), pickOne('memory'), o)).entry;
    assert.strictEqual(mem.env.MCP_MEMORY_SQLITE_PATH, '/Users/me/.alfred-memory/memory.db');
    const serena = addStep(plan(inv(MAC), pickOne('serena'), o)).entry;
    assert.strictEqual(serena.env.SERENA_HOME, '/work/shop/.alfred/serena/home');
    const firefox = addStep(plan(inv(MAC), pickOne('playwright-firefox'), o)).entry;
    assert.strictEqual(firefox.args[firefox.args.indexOf('--user-data-dir') + 1], '/work/shop/.preferred-tools/playwright-firefox');
    // the other place is always offered
    const acct = addStep(plan(inv(MAC), pickOne('playwright-firefox', { location: { side: 'account' } }), o)).entry;
    assert.strictEqual(acct.args[acct.args.indexOf('--user-data-dir') + 1], '/Users/me/.preferred-tools/playwright-firefox');
    const proj = addStep(plan(inv(MAC), pickOne('memory', { location: { side: 'project' } }), o)).entry;
    assert.strictEqual(proj.env.MCP_MEMORY_SQLITE_PATH, '/work/shop/.preferred-tools/memory/memory.db');
});

test('a data folder the plugin creates gets a .gitignore step; one that exists does not', () => {
    const p = plan(inv(MAC), pickOne('playwright-chrome'), opts('/Users/me'));
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['ensure-dir', 'mcp-add']);
    assert.strictEqual(p.steps[0].path, '/work/shop/.preferred-tools/playwright-chrome');
    assert.match(render(p), /\.gitignore {2}\(contents: \*\)/);
    const old = plan(inv(MAC), pickOne('playwright-chrome'), opts('/Users/me', { exists: () => true }));
    assert.deepStrictEqual(old.steps.map((s) => s.op), ['mcp-add']);
});

test('four Playwright engines in one project: four entries, four distinct user data dirs and names', () => {
    const p = plan(inv(MAC), { picks: { 'playwright-chrome': {}, 'playwright-msedge': {}, 'playwright-firefox': {}, 'playwright-webkit': {} } }, opts('/Users/me'));
    assert.deepStrictEqual(p.errors, []);
    const adds = p.steps.filter((s) => s.op === 'mcp-add');
    assert.strictEqual(adds.length, 4);
    assert.strictEqual(new Set(adds.map((a) => a.name)).size, 4);
    const dirs = adds.map((a) => a.entry.args[a.entry.args.indexOf('--user-data-dir') + 1]);
    assert.strictEqual(new Set(dirs).size, 4);
    assert.deepStrictEqual(adds.map((a) => a.entry.args[a.entry.args.indexOf('--browser') + 1]), ['chrome', 'msedge', 'firefox', 'webkit']);
});

test('a browser binary the user names sets --executable-path, and only then', () => {
    const none = addStep(plan(inv(MAC), pickOne('playwright-chrome'), opts('/h'))).entry;
    assert.ok(!none.args.includes('--executable-path'));
    const named = addStep(plan(inv(MAC), pickOne('playwright-chrome', { executablePath: '/Apps/Chromium' }), opts('/h'))).entry;
    assert.strictEqual(named.args[named.args.indexOf('--executable-path') + 1], '/Apps/Chromium');
});

test('names: the 64-character limit, characters, the reserved set, a collision, and the per-project spelling', () => {
    const ok64 = 'a'.repeat(64);
    assert.deepStrictEqual(plan(inv(MAC), pickOne('serena', { name: ok64 }), opts('/h')).errors, []);
    assert.match(plan(inv(MAC), pickOne('serena', { name: 'a'.repeat(65) }), opts('/h')).errors[0], /must match/);
    assert.match(plan(inv(MAC), pickOne('serena', { name: 'has space' }), opts('/h')).errors[0], /must match/);
    assert.match(plan(inv(MAC), pickOne('serena', { name: '' }), opts('/h')).errors[0], /must match/);
    for (const reserved of ['alfred-navigation', 'chrome-control', 'browser', 'windows-control'])
        assert.match(plan(inv(MAC), pickOne('serena', { name: reserved }), opts('/h')).errors[0], /alfred-code once registered/, reserved);
    assert.deepStrictEqual(plan(inv(MAC), pickOne('serena', { name: 'memory-x' }), opts('/h')).errors, []);
    const coll = plan(inv(MAC, { registrations: [reg('serena', 'local', { command: 'node' })] }), pickOne('serena'), opts('/h'));
    assert.match(coll.errors[0], /already belongs to another registration at local scope/);
    assert.strictEqual(coll.steps.length, 0, 'asked, never overwritten');
    // the same name at ANOTHER scope is a note, not a collision
    const other = plan(inv(MAC, { registrations: [reg('serena', 'user', { command: 'node' })] }), pickOne('serena'), opts('/h'));
    assert.deepStrictEqual(other.errors, []);
    assert.match(other.notes.join(' '), /also exists at user scope/);
    const pre = addStep(plan(inv(MAC), pickOne('serena', { name: 'prefixed' }), opts('/h')));
    assert.strictEqual(pre.name, 'shop-serena');
    for (const row of catalog.tools.filter((r) => r.kind === 'mcp')) assert.ok(!catalog.reserved.has(row.name));
});

test('an unreadable scope gets nothing written', () => {
    const p = plan(inv(MAC, { unreadable: [{ scope: 'project', file: '/work/shop/.mcp.json', state: 'malformed' }] }), pickOne('context7', { route: 'remote', scope: 'project' }), opts('/h'));
    assert.match(p.errors[0], /project scope is unreadable/);
    assert.strictEqual(p.steps.length, 0);
    const acct = plan(inv(MAC, { unreadable: [{ scope: 'local', file: '/h/.claude.json', state: 'malformed' }, { scope: 'user', file: '/h/.claude.json', state: 'malformed' }] }), pickOne('serena'), opts('/h'));
    assert.match(acct.errors[0], /unreadable/);
});

// ---- starting from what is installed ----------------------------------------------------------------------------------

function installed(row, answers = {}, base = MAC, home = '/Users/me', extra = {})
{
    const first = plan(inv(base), pickOne(row, answers), opts(home, extra));
    assert.deepStrictEqual(first.errors, []);
    const s = first.steps.find((x) => x.op === 'mcp-add');
    return reg(s.name, s.scope, s.entry, row, answers.route || catalog.byId.get(row).recommendedRoute);
}

test('a re-run with the same answers plans nothing', () => {
    for (const [id, answers] of [['serena', {}], ['memory', {}], ['playwright-chrome', { scope: 'user' }], ['context7', { route: 'remote', token: true }], ['gitlab', { params: { host: 'git.corp.example' } }], ['appium', {}], ['github', { route: 'local' }]])
    {
        const r = installed(id, answers);
        const again = plan(inv(MAC, { registrations: [r] }), pickOne(id, answers), opts('/Users/me'));
        assert.deepStrictEqual(again.errors, [], id);
        assert.strictEqual(again.steps.length, 0, `${id}: ${render(again)}`);
        assert.strictEqual(again.noop, true);
        assert.match(render(again), /Nothing to do/);
    }
});

test('a rename starts from the registration as read: an updated pin and a user-added arg survive', () => {
    const r = installed('serena');
    r.entry.args = r.entry.args.map((a) => a.replace('serena-agent@2.1.0', 'serena-agent@2.4.0')).concat(['--user-added', 'yes']);
    r.entry.env.MY_VAR = 'kept';
    const p = plan(inv(MAC, { registrations: [r] }), pickOne('serena', { name: 'shop-serena' }), opts('/Users/me'));
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['mcp-move']);
    const s = p.steps[0];
    assert.deepStrictEqual([s.from, s.to], [{ name: 'serena', scope: 'local' }, { name: 'shop-serena', scope: 'local' }]);
    assert.ok(s.entry.args.includes('serena-agent@2.4.0'), 'the updated pin is not downgraded to the catalog pin');
    assert.deepStrictEqual(s.entry.args.slice(-2), ['--user-added', 'yes']);
    assert.strictEqual(s.entry.env.MY_VAR, 'kept');
    assert.match(render(p), /add first, read back, then remove the old one/);
});

test('a location change edits only the paths and keeps the pin; the old data is named and left', () => {
    const r = installed('playwright-chrome');
    r.entry.args = r.entry.args.map((a) => a.replace('0.0.83', '0.0.90'));
    const p = plan(inv(MAC, { registrations: [r] }), pickOne('playwright-chrome', { location: { side: 'account' } }), opts('/Users/me'));
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['ensure-dir', 'mcp-replace']);
    const e = p.steps[1].entry;
    assert.ok(e.args.includes('@playwright/mcp@0.0.90'));
    assert.strictEqual(e.args[e.args.indexOf('--user-data-dir') + 1], '/Users/me/.preferred-tools/playwright-chrome');
    assert.strictEqual(e.args[e.args.indexOf('--output-dir') + 1], '/Users/me/.preferred-tools/playwright-chrome/output');
    assert.match(p.notes.join('\n'), /old data stays at \/work\/shop\/\.preferred-tools\/playwright-chrome/);
    assert.deepStrictEqual(p.steps[1].old, r.entry, 'the old entry is kept for the rollback');
});

test('a scope change moves the registration and rewrites its paths for the new scope', () => {
    const r = installed('context7', { route: 'remote', scope: 'project' });
    const p = plan(inv(MAC, { registrations: [r] }), pickOne('context7', { route: 'remote', scope: 'user' }), opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['mcp-move']);
    assert.deepStrictEqual([p.steps[0].from.scope, p.steps[0].to.scope], ['project', 'user']);
    const cat = withProjectScope('playwright-chrome');
    const local = installed('playwright-chrome', { scope: 'local' });
    const toProject = plan(inv(MAC, { registrations: [local] }), pickOne('playwright-chrome', { scope: 'project' }), opts('/Users/me', { catalog: cat }));
    assert.deepStrictEqual(toProject.errors, []);
    const e = toProject.steps.find((s) => s.op === 'mcp-move').entry;
    assert.strictEqual(e.args[e.args.indexOf('--user-data-dir') + 1], '.preferred-tools/playwright-chrome', 'absolute inside the project becomes relative');
});

test('changing the route rebuilds from the catalog; changing only the key adds the header to the entry as read', () => {
    const r = installed('context7', { route: 'remote' });
    const key = plan(inv(MAC, { registrations: [r] }), pickOne('context7', { token: true }), opts('/h'));
    assert.deepStrictEqual(key.steps[0].entry.headers, { Authorization: 'Bearer ${CONTEXT7_API_KEY}' });
    assert.strictEqual(key.steps[0].op, 'mcp-replace');
    // remote at project scope cannot become local there: the plan says so and writes nothing
    assert.match(plan(inv(MAC, { registrations: [r] }), pickOne('context7', { route: 'local' }), opts('/h')).errors[0], /cannot be registered at project scope/);
    const user = installed('context7', { route: 'remote', scope: 'user' });
    const local = plan(inv(MAC, { registrations: [user] }), pickOne('context7', { route: 'local' }), opts('/h'));
    assert.strictEqual(local.steps[0].op, 'mcp-replace');
    assert.strictEqual(local.steps[0].entry.command, 'npx');
    const moved = plan(inv(MAC, { registrations: [r] }), pickOne('context7', { route: 'local', scope: 'local' }), opts('/h'));
    assert.deepStrictEqual(moved.steps.map((s) => s.op), ['mcp-move']);
});

test('registrations that are not the catalog\'s are not touched: a user\'s own, and alfred-code\'s retired names', () => {
    const own = reg('serena', 'user', { command: 'node' });
    const retired = reg('chrome-control', 'local', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome'] }, 'playwright-chrome', 'local', { alfredRetired: true });
    const p = plan(inv(MAC, { registrations: [own, retired] }), { picks: { 'playwright-chrome': {} }, remove: [{ kind: 'mcp', name: 'serena', scope: 'user' }, { kind: 'mcp', name: 'chrome-control', scope: 'local' }] }, opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['ensure-dir', 'mcp-add'], 'a fresh add beside the retired one; nothing removed');
    assert.strictEqual(p.errors.length, 2);
    assert.match(p.errors[0], /your own server/);
    assert.match(p.errors[1], /alfred-code's \(retired\)/);
});

test('remove plans one remove per pick, at the scope shown', () => {
    const r = installed('serena');
    const p = plan(inv(MAC, { registrations: [r] }), { remove: [{ kind: 'mcp', name: 'serena', scope: 'local' }] }, opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => [s.op, s.name, s.scope]), [['mcp-remove', 'serena', 'local']]);
    assert.deepStrictEqual(argvOf(p.steps[0]), ['mcp', 'remove', 'serena', '-s', 'local']);
    assert.match(plan(inv(MAC), { remove: [{ kind: 'mcp', name: 'ghost', scope: 'local' }] }, opts('/h')).errors[0], /no registration/);
});

// ---- plugins ----------------------------------------------------------------------------------------------------------

test('plugins: the marketplace is added when missing, the install is at the recommended scope, never over an installed plugin', () => {
    const p = plan(inv(MAC), { picks: { 'claude-hud': {}, 'typescript-lsp': {}, 'csharp-lsp': {} } }, opts('/h'));
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.steps.map((s) => argvOf(s) && argvOf(s).join(' ')).filter(Boolean), [
        'plugin marketplace add jarrodwatts/claude-hud', 'plugin install claude-hud@claude-hud --scope user',
        'plugin marketplace add anthropics/claude-plugins-official', 'plugin install typescript-lsp@claude-plugins-official --scope project',
        'plugin install csharp-lsp@claude-plugins-official --scope project']);
    const known = [{ name: 'claude-hud', source: '' }, { name: 'claude-plugins-official', source: '' }];
    const enabled = { rowId: 'claude-hud', id: 'claude-hud@claude-hud', scope: 'user', enabled: true, alfredRetired: false };
    const same = plan(inv(MAC, { marketplaces: known, plugins: [enabled] }), pickOne('claude-hud'), opts('/h'));
    assert.deepStrictEqual(same.steps.map((s) => s.op), ['hud'], 'installed and enabled: no install call, only the settings ask');
    const disabled = plan(inv(MAC, { marketplaces: known, plugins: [{ ...enabled, enabled: false }] }), pickOne('claude-hud'), opts('/h'));
    assert.deepStrictEqual(disabled.steps.map((s) => s.op), ['plugin-enable', 'hud']);
    const lsp = plan(inv(MAC, { marketplaces: known, plugins: [{ rowId: 'typescript-lsp', id: 'typescript-lsp@claude-plugins-official', scope: 'project', enabled: true, alfredRetired: false }] }), pickOne('typescript-lsp'), opts('/h'));
    assert.strictEqual(lsp.steps.length, 0);
});

test('plugins at another scope are moved: install first, then uninstall the old copy', () => {
    const known = [{ name: 'claude-plugins-official', source: '' }];
    const old = { rowId: 'csharp-lsp', id: 'csharp-lsp@claude-plugins-official', scope: 'user', enabled: true, alfredRetired: false };
    const p = plan(inv(MAC, { marketplaces: known, plugins: [old] }), pickOne('csharp-lsp', { scope: 'project', moveFrom: ['user'] }), opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => argvOf(s).join(' ')), ['plugin install csharp-lsp@claude-plugins-official --scope project', 'plugin uninstall csharp-lsp@claude-plugins-official --scope user']);
});

test('plugins also managed by alfred-code are marked while it is enabled', () => {
    const known = [{ name: 'claude-plugins-official', source: '' }];
    const p = plan(inv(MAC, { marketplaces: known, alfredCodeEnabled: true }), pickOne('typescript-lsp'), opts('/h'));
    assert.match(p.notes.join(' '), /also managed by alfred-code/);
    const rem = plan(inv(MAC, { alfredCodeEnabled: true, plugins: [{ rowId: 'typescript-lsp', id: 'typescript-lsp@claude-plugins-official', scope: 'project', enabled: true, alfredRetired: false }] }), { remove: [{ kind: 'plugin', id: 'typescript-lsp@claude-plugins-official', scope: 'project' }] }, opts('/h'));
    assert.match(rem.notes.join(' '), /holds only once alfred-code's hand-off has shipped/);
});

test('code-running tools are named in the plan', () => {
    const p = plan(inv(MAC), pickOne('playwright-chrome'), opts('/h'));
    assert.match(render(p), /browser_run_code_unsafe/);
    assert.match(render(plan(inv(MAC), pickOne('macos-control'), opts('/h'))), /Shell/);
});

// ---- the questions ----------------------------------------------------------------------------------------------------

function checkQuestion(q)
{
    assert.ok(q.header.length <= 12, `${q.id}: header '${q.header}'`);
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.id}: ${q.options.length} options`);
    for (const o of q.options) assert.ok(o.label && o.description, q.id);
    if (!q.multiSelect)
    {
        const rec = q.options.filter((o) => o.label.endsWith('(Recommended)'));
        assert.strictEqual(rec.length, 1, `${q.id}: exactly one Recommended`);
        assert.ok(q.options[0].label.endsWith('(Recommended)'), `${q.id}: Recommended is first`);
    }
}

test('every question has 2 to 4 options, one Recommended and first, and a call has at most four questions', () => {
    for (const base of [MAC, LINUX, WIN, WINARM])
    {
        const i = inv(base);
        const calls = asks.pickQuestions(i, catalog);
        for (const call of calls) { assert.ok(call.length >= 1 && call.length <= 4); call.forEach(checkQuestion); }
        const offered = calls.flat().flatMap((q) => q.options).length;
        const rows = catalog.tools.filter((r) => r.os.includes(i.os)).length;
        assert.strictEqual(offered, rows, base.os);
        for (const row of catalog.tools.filter((r) => r.os.includes(i.os)))
        {
            const ctx = { project: i.project, platform: i.os, arch: i.arch, home: base.os === 'win32' ? 'C:\\Users\\me' : '/Users/me', env: {} };
            for (const route of row.kind === 'mcp' ? Object.keys(row.routes) : [undefined])
            {
                const qs = asks.toolQuestions(row, i, { route, ctx, catalog });
                assert.ok(qs.length >= 1 && qs.length <= 4, `${row.id}: ${qs.length} questions in one call`);
                qs.forEach(checkQuestion);
            }
            const rq = row.kind === 'mcp' ? asks.routeQuestion(row) : null;
            if (rq) { checkQuestion(rq); assert.strictEqual(rq.options.length, 2); }
        }
    }
    Object.values(asks.STATIC).map((q) => (typeof q === 'function' ? q(1, 2, 3) : q)).forEach(checkQuestion);
});

test('the grouping: Code, Docs and forges, Browsers, Machine and monitoring; three on Linux, windows-control only on Windows', () => {
    const calls = (b) => asks.pickQuestions(inv(b), catalog)[0];
    assert.deepStrictEqual(calls(MAC).map((q) => q.options.length), [4, 4, 4, 4]);
    assert.deepStrictEqual(calls(LINUX).map((q) => q.options.length), [4, 4, 4, 3]);
    assert.match(calls(WIN)[3].options.map((o) => o.label).join(), /windows-control/);
    assert.doesNotMatch(calls(MAC)[3].options.map((o) => o.label).join(), /windows-control/);
    assert.match(calls(MAC)[3].options.map((o) => o.label).join(), /macos-control/);
    const i = inv(MAC, { registrations: [reg('shop-serena', 'local', { command: 'uvx', args: ['--from', 'serena-agent@2.1.0'] }, 'serena', 'local')] });
    assert.match(asks.pickQuestions(i, catalog)[0][0].options[0].label, /serena \(installed as shop-serena, local\)/);
});

test('the scope question follows the route: project is offered only where the route allows it', () => {
    const i = inv(MAC);
    const scopes = (id, route) => asks.toolQuestions(catalog.byId.get(id), i, { route, ctx: { project: '/p', platform: 'darwin', home: '/h' }, catalog })[0].options.map((o) => o.label.replace(' (Recommended)', ''));
    assert.deepStrictEqual(scopes('serena', 'local'), ['local', 'user']);
    assert.deepStrictEqual(scopes('context7', 'remote'), ['project', 'local', 'user']);
    assert.deepStrictEqual(scopes('context7', 'local'), ['local', 'user']);
    assert.deepStrictEqual(scopes('claude-hud'), ['user', 'project', 'local']);
    assert.deepStrictEqual(scopes('typescript-lsp'), ['project', 'local', 'user']);
});

test('plan.js rejects a route and scope pair its question would not have offered', () => {
    for (const row of catalog.tools.filter((r) => r.kind === 'mcp'))
        for (const [routeId, route] of Object.entries(row.routes))
        {
            const p = plan(inv(row.os.includes('win32') && !row.os.includes('darwin') ? WIN : MAC), pickOne(row.id, { route: routeId, scope: 'project' }), opts('/h'));
            if (route.projectScope) assert.deepStrictEqual(p.errors, [], `${row.id}/${routeId}`);
            else assert.match(p.errors.join(), /cannot be registered at project scope/, `${row.id}/${routeId}`);
        }
});

test('the CLI form prints a plan and writes it for apply.js', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-plan-'));
    try
    {
        fs.writeFileSync(path.join(d, 'inv.json'), JSON.stringify(inv(MAC)));
        fs.writeFileSync(path.join(d, 'ans.json'), JSON.stringify(pickOne('atlassian')));
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'plan.js'), path.join(d, 'inv.json'), path.join(d, 'ans.json'), '--out', path.join(d, 'plan.json')], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /claude mcp add-json atlassian .*-s project/);
        assert.match(r.stdout, /OAuth: run \/mcp once/);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'plan.json'), 'utf8')).steps[0].op, 'mcp-add');
        const q = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'plan.js'), '--questions', path.join(d, 'inv.json')], { encoding: 'utf8' });
        assert.strictEqual(q.status, 0, q.stderr);
        assert.ok(JSON.parse(q.stdout).pick.length >= 1);
    }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
});
