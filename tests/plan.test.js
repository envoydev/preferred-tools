'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const catalogLib = require('../scripts/catalog.js');
const { plan, render, argvOf } = require('../scripts/plan.js');
const asks = require('../scripts/asks.js');
const inventoryLib = require('../scripts/inventory.js');
const { MARKER } = require('../scripts/kept.js');

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
const changeOf = (r, answers = {}) => ({ change: { [`mcp:${r.name}~${r.scope}`]: answers } });

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

test('locations: the plugin\'s own folder by default, even with alfred-code data on disk; memory defaults to the account folder', () => {
    const has = (p) => p === '/work/shop/.alfred/chrome-control' || p === '/Users/me/.alfred-memory' || p === '/work/shop/.alfred/serena/home';
    const o = opts('/Users/me', { exists: has });
    const chrome = addStep(plan(inv(MAC), pickOne('playwright-chrome'), o)).entry;
    assert.strictEqual(chrome.args[chrome.args.indexOf('--user-data-dir') + 1], '/work/shop/.preferred-tools/playwright-chrome');
    const mem = addStep(plan(inv(MAC), pickOne('memory'), o)).entry;
    assert.strictEqual(mem.env.MCP_MEMORY_SQLITE_PATH, '/Users/me/.preferred-tools/memory/memory.db');
    const serena = addStep(plan(inv(MAC), pickOne('serena'), o)).entry;
    assert.strictEqual(serena.env.SERENA_HOME, '/work/shop/.preferred-tools/serena');
    // alfred-code's folder only on the user's pick, and only when it is on disk
    const reuse = addStep(plan(inv(MAC), pickOne('playwright-chrome', { location: { side: 'alfred' } }), o)).entry;
    assert.strictEqual(reuse.args[reuse.args.indexOf('--user-data-dir') + 1], '/work/shop/.alfred/chrome-control');
    const reuseMem = addStep(plan(inv(MAC), pickOne('memory', { location: { side: 'alfred' } }), o)).entry;
    assert.strictEqual(reuseMem.env.MCP_MEMORY_SQLITE_PATH, '/Users/me/.alfred-memory/memory.db');
    assert.match(plan(inv(MAC), pickOne('playwright-firefox', { location: { side: 'alfred' } }), o).errors[0], /no alfred-code data folder/);
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
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['ensure-dir', 'mcp-add', 'fetch']);
    assert.strictEqual(p.steps[0].path, '/work/shop/.preferred-tools/playwright-chrome');
    assert.match(render(p), /\.gitignore {2}\(contents: \*\)/);
    // alfred-code's folder, picked, is the user's data as it is: no step creates or marks it
    const old = plan(inv(MAC), pickOne('playwright-chrome', { location: { side: 'alfred' } }), opts('/Users/me', { exists: () => true }));
    assert.deepStrictEqual(old.steps.map((s) => s.op), ['mcp-add', 'fetch']);
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
    const p = plan(inv(MAC, { registrations: [r] }), changeOf(r, { name: 'shop-serena' }), opts('/Users/me'));
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
    const p = plan(inv(MAC, { registrations: [r] }), changeOf(r, { location: { side: 'account' } }), opts('/Users/me'));
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
    const p = plan(inv(MAC, { registrations: [r] }), changeOf(r, { route: 'remote', scope: 'user' }), opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['mcp-move']);
    assert.deepStrictEqual([p.steps[0].from.scope, p.steps[0].to.scope], ['project', 'user']);
    const cat = withProjectScope('playwright-chrome');
    const local = installed('playwright-chrome', { scope: 'local' });
    const toProject = plan(inv(MAC, { registrations: [local] }), changeOf(local, { scope: 'project' }), opts('/Users/me', { catalog: cat }));
    assert.deepStrictEqual(toProject.errors, []);
    const e = toProject.steps.find((s) => s.op === 'mcp-move').entry;
    assert.strictEqual(e.args[e.args.indexOf('--user-data-dir') + 1], '.preferred-tools/playwright-chrome', 'absolute inside the project becomes relative');
});

test('changing the route rebuilds from the catalog; changing only the key adds the header to the entry as read', () => {
    const r = installed('context7', { route: 'remote' });
    const key = plan(inv(MAC, { registrations: [r] }), changeOf(r, { token: true }), opts('/h'));
    assert.deepStrictEqual(key.steps[0].entry.headers, { Authorization: 'Bearer ${CONTEXT7_API_KEY}' });
    assert.strictEqual(key.steps[0].op, 'mcp-replace');
    // remote at project scope cannot become local there: the plan says so and writes nothing
    assert.match(plan(inv(MAC, { registrations: [r] }), changeOf(r, { route: 'local' }), opts('/h')).errors[0], /cannot be registered at project scope/);
    const user = installed('context7', { route: 'remote', scope: 'user' });
    const local = plan(inv(MAC, { registrations: [user] }), changeOf(user, { route: 'local' }), opts('/h'));
    assert.strictEqual(local.steps[0].op, 'mcp-replace');
    assert.strictEqual(local.steps[0].entry.command, 'npx');
    const moved = plan(inv(MAC, { registrations: [r] }), changeOf(r, { route: 'local', scope: 'local' }), opts('/h'));
    assert.deepStrictEqual(moved.steps.map((s) => s.op), ['mcp-move', 'fetch'], 'a hosted route had nothing in the cache');
});

test('registrations that are not the catalog\'s are not touched: a user\'s own, and alfred-code\'s retired names', () => {
    const own = reg('serena', 'user', { command: 'node' });
    const retired = reg('chrome-control', 'local', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome'] }, 'playwright-chrome', 'local', { alfredRetired: true });
    const p = plan(inv(MAC, { registrations: [own, retired] }), { picks: { 'playwright-chrome': {} }, remove: [{ kind: 'mcp', name: 'serena', scope: 'user' }, { kind: 'mcp', name: 'chrome-control', scope: 'local' }] }, opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['ensure-dir', 'mcp-add', 'fetch'], 'a fresh add beside the retired one; nothing removed');
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
    const p = plan(inv(MAC, { marketplaces: known, plugins: [old] }), { change: { 'plugin:csharp-lsp@claude-plugins-official~user': { scope: 'project' } } }, opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => argvOf(s).join(' ')), ['plugin install csharp-lsp@claude-plugins-official --scope project', 'plugin uninstall csharp-lsp@claude-plugins-official --scope user']);
});

test('plugins also managed by alfred-code are marked while it is enabled', () => {
    const known = [{ name: 'claude-plugins-official', source: '' }];
    const p = plan(inv(MAC, { marketplaces: known, alfredCodeEnabled: true }), pickOne('typescript-lsp'), opts('/h'));
    assert.match(p.notes.join(' '), /alfred-code installs it too/);
    const rem = plan(inv(MAC, { alfredCodeEnabled: true, plugins: [{ rowId: 'typescript-lsp', id: 'typescript-lsp@claude-plugins-official', scope: 'project', enabled: true, alfredRetired: false }] }), { remove: [{ kind: 'plugin', id: 'typescript-lsp@claude-plugins-official', scope: 'project' }] }, opts('/h'));
    assert.match(rem.notes.join(' '), /alfred-code installs it too - its next update may add it back/);
    // with alfred-code absent, nothing names it
    const absent = plan(inv(MAC, { plugins: [{ rowId: 'typescript-lsp', id: 'typescript-lsp@claude-plugins-official', scope: 'project', enabled: true, alfredRetired: false }] }), { remove: [{ kind: 'plugin', id: 'typescript-lsp@claude-plugins-official', scope: 'project' }] }, opts('/h'));
    assert.doesNotMatch(absent.notes.join(' '), /alfred-code/);
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

test('no ask names git or remote state: alfred-code\'s stop guard reads such a word as a repository measurement and sends Claude to git fetch', () => {
    // alfred-code v3.2.1 stack/hooks/guard-stop-contract.js :2528 (REMOTE_STATE_RE) and :2871 (git state), as written there
    const REMOTE_STATE_RE = /\b(?:merged?|merging|pull request|PRs?|remote|upstream|deploy(?:ed|ment)?|pipeline|CI|workflow run)\b/i;
    const GIT_STATE_RE = /\b(commit|branch|pull request|\bPRs?\b|merge|rebase|stash|staged|unstaged|uncommitted|untracked|remote|upstream|deploy(ed|ment)?|pipeline|\bCI\b|workflow run|job)\b/i;
    const texts = [];
    const add = (q) => texts.push(q.question, ...q.options.flatMap((o) => [o.label, o.description || '']));
    const collect = (node) =>
    {
        if (Array.isArray(node)) return node.forEach(collect);
        if (!node || typeof node !== 'object') return undefined;
        for (const [k, v] of Object.entries(node)) if (['question', 'label', 'description'].includes(k) && typeof v === 'string') texts.push(v); else collect(v);
        return undefined;
    };
    for (const base of [MAC, LINUX, WIN])
    {
        const home = base.os === 'win32' ? 'C:\\Users\\me' : '/Users/me';
        const rows = catalog.tools.filter((r) => r.os.includes(base.os));
        // nothing installed, and every MCP row installed at each of its routes: install's picks, configure's change pick
        // and each target's questions, the remove pick
        const regs = rows.filter((r) => r.kind === 'mcp').flatMap((r) => Object.keys(r.routes).map((route) => installed(r.id, { route }, base, home)));
        for (const i of [inv(base), inv(base, { registrations: regs })])
            collect(asks.all(i, { rows: rows.map((r) => r.id), targets: i.registrations.map((r) => `mcp:${r.name}~${r.scope}`) }, catalog));
        const i = inv(base);
        for (const row of rows)
        {
            const ctx = { project: i.project, platform: i.os, arch: i.arch, home, env: {} };
            for (const route of row.kind === 'mcp' ? Object.keys(row.routes) : [undefined]) asks.toolQuestions(row, i, { route, ctx, catalog }).forEach(add);
        }
    }
    Object.values(asks.STATIC).map((q) => (typeof q === 'function' ? q(1, 2, 3) : q)).forEach(add);
    const fs = require('node:fs');
    const { parseAskBlocks } = require('./ask-blocks.js');
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'commands'))) parseAskBlocks(fs.readFileSync(path.join(__dirname, '..', 'commands', f), 'utf8')).forEach(add);
    const hits = [...new Set(texts.filter((t) => REMOTE_STATE_RE.test(t) || GIT_STATE_RE.test(t)))];
    assert.deepStrictEqual(hits, []);
});

test('the grouping: Code, Docs and forges, Browsers, Machine and monitoring; three on Linux, windows-control only on Windows', () => {
    const calls = (b) => asks.pickQuestions(inv(b), catalog)[0];
    assert.deepStrictEqual(calls(MAC).map((q) => q.options.length), [4, 4, 4, 4]);
    assert.deepStrictEqual(calls(LINUX).map((q) => q.options.length), [4, 4, 4, 3]);
    assert.match(calls(WIN)[3].options.map((o) => o.label).join(), /windows-control/);
    assert.doesNotMatch(calls(MAC)[3].options.map((o) => o.label).join(), /windows-control/);
    assert.match(calls(MAC)[3].options.map((o) => o.label).join(), /macos-control/);
});

test('install offers only what is not installed; configure offers what is, one option per registration', () => {
    const i = inv(MAC, {
        registrations: [reg('shop-serena', 'local', { command: 'uvx', args: ['--from', 'serena-agent@2.1.0'] }, 'serena', 'local'), reg('serena', 'user', { command: 'uvx', args: ['--from', 'serena-agent@2.1.0'] }, 'serena', 'local'), reg('mine', 'user', { command: 'my-server' })],
        plugins: [{ id: 'claude-hud@claude-hud', plugin: 'claude-hud', scope: 'user', version: '0.13.1', enabled: true, rowId: 'claude-hud', alfredRetired: false }],
    });
    const offered = asks.pickQuestions(i, catalog).flat().flatMap((q) => q.options.map((o) => o.label));
    assert.ok(!offered.includes('serena') && !offered.includes('claude-hud'), 'installed rows are configure\'s');
    assert.strictEqual(offered.length, catalog.tools.filter((r) => r.os.includes('darwin')).length - 2);
    const ch = asks.changeQuestions(i, catalog);
    const labels = ch.calls.flat().flatMap((q) => q.options.map((o) => o.label));
    assert.deepStrictEqual(labels, ['shop-serena (serena, local)', 'serena (serena, user)', 'claude-hud (user)'], 'a row at two scopes is two options; the user\'s own server is not offered');
    assert.deepStrictEqual(ch.keys, { 'shop-serena (serena, local)': 'mcp:shop-serena~local', 'serena (serena, user)': 'mcp:serena~user', 'claude-hud (user)': 'plugin:claude-hud@claude-hud~user' });
    assert.match(ch.calls[0][0].options[0].description, /^local route, pin 2\.1\.0$/);
});

test('a multi-select never has one option: a lone item joins a neighbour or takes one from it, and one in all gets None', () => {
    const g = (id) => ({ id, label: id });
    const items = (spec) => spec.flatMap(([grp, n]) => Array.from({ length: n }, (_, k) => ({ group: grp, label: `${grp.id}${k}`, description: 'd' })));
    const sizes = (spec) => asks.packed(items(spec), { id: 'x', question: 'which?', none: 'nothing' }).flat().map((q) => q.options.length);
    const [a, b, c, d] = ['code', 'docs', 'browsers', 'machine'].map(g);
    assert.deepStrictEqual(sizes([[a, 4], [b, 4], [c, 4], [d, 4]]), [4, 4, 4, 4]);
    assert.deepStrictEqual(sizes([[a, 3], [b, 1], [c, 4]]), [4, 4], 'a lone item joins the group before it that has room');
    assert.deepStrictEqual(sizes([[a, 4], [b, 1], [c, 4]]), [3, 2, 4], 'both neighbours full: it takes one from the one before');
    assert.deepStrictEqual(sizes([[a, 1], [b, 4]]), [2, 3]);
    assert.deepStrictEqual(sizes([[a, 5]]), [3, 2], 'a group of five splits 3 + 2, never 4 + 1');
    const one = asks.packed(items([[a, 1]]), { id: 'x', question: 'which?', none: 'nothing' })[0][0];
    assert.deepStrictEqual(one.options.map((o) => o.label), ['code0', 'None of these']);
    const mixed = asks.packed(items([[a, 3], [b, 1]]), { id: 'x', question: 'which?', none: 'nothing' })[0][0];
    assert.strictEqual(mixed.header, 'Tools');
    assert.strictEqual(mixed.question, 'Which?');
    for (const n of [1, 2, 3, 5, 6, 7, 9, 13, 17])
        for (const call of asks.packed(items([[a, n], [b, 1], [c, 2]]), { id: 'x', question: 'which?', none: 'nothing' })) { assert.ok(call.length <= 4); call.forEach(checkQuestion); }
});

test('install only adds: a tool installed for every project gets this project\'s own copy, and the account-wide one is never touched', () => {
    const glob = installed('memory', { scope: 'user' });
    const i = inv(MAC, { registrations: [glob] });
    const p = plan(i, pickOne('memory'), opts('/Users/me'));
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.steps.map((s) => [s.op, s.name, s.scope]), [['ensure-dir', undefined, undefined], ['mcp-add', 'memory', 'local'], ['fetch', 'memory', undefined]]);
    assert.strictEqual(addStep(p).entry.env.MCP_MEMORY_SQLITE_PATH, '/work/shop/.preferred-tools/memory/memory.db', 'its own data, in the project folder');
    assert.ok(!p.steps.some((s) => /remove|move|replace|uninstall/.test(s.op)), 'nothing happens to the copy for every project');
    assert.match(p.notes.join(' '), /also installed as 'memory' at user scope - left as it is/);
    assert.match(p.notes.join(' '), /nearer one wins/);
    // an answer that names the copy for every project is not a change of it
    const again = plan(i, pickOne('memory', { scope: 'user', name: 'keep' }), opts('/Users/me'));
    assert.strictEqual(again.noop, true);
    assert.match(again.unchanged.join(' '), /already installed at user scope - a change to it is \/preferred-tools:configure/);
    const renamed = plan(i, pickOne('memory', { scope: 'user', name: 'mem2' }), opts('/Users/me'));
    assert.deepStrictEqual(renamed.steps.map((s) => s.op).filter((o) => o !== 'ensure-dir' && o !== 'fetch'), ['mcp-add'], 'a second name at the same scope is a second copy, never a rename');
    // plugins: a project copy beside the user-scope one, which stays
    const known = [{ name: 'claude-plugins-official', source: '' }];
    const ts = { rowId: 'typescript-lsp', id: 'typescript-lsp@claude-plugins-official', scope: 'user', enabled: true, alfredRetired: false };
    const pp = plan(inv(MAC, { marketplaces: known, plugins: [ts] }), pickOne('typescript-lsp'), opts('/h'));
    assert.deepStrictEqual(pp.steps.map((s) => argvOf(s).join(' ')), ['plugin install typescript-lsp@claude-plugins-official --scope project']);
    assert.match(pp.notes.join(' '), /also installed at user scope - left as it is/);
});

test('a copy and a configure change on Windows and Linux: each OS\'s paths, the Windows cmd /c, the user-scope one untouched', () => {
    const cases = [
        [WIN, 'C:\\Users\\me', 'C:\\work\\shop\\.preferred-tools\\memory\\memory.db', 'C:\\Users\\me\\.preferred-tools\\pw2', 'cmd'],
        [LINUX, '/home/me', '/work/shop/.preferred-tools/memory/memory.db', '/home/me/.preferred-tools/pw2', 'npx'],
    ];
    for (const [base, home, memDb, pwDir, command] of cases)
    {
        const first = plan(inv(base), { picks: { memory: { scope: 'user' }, 'playwright-chrome': { scope: 'user' } } }, opts(home));
        const regs = first.steps.filter((s) => s.op === 'mcp-add').map((s) => reg(s.name, s.scope, s.entry, s.row, 'local'));
        const copy = plan(inv(base, { registrations: regs }), { picks: { memory: {}, 'playwright-chrome': {} } }, opts(home));
        assert.deepStrictEqual(copy.errors, [], base.os);
        assert.deepStrictEqual(copy.steps.filter((s) => s.op === 'mcp-add').map((s) => [s.name, s.scope]), [['memory', 'local'], ['playwright-chrome', 'local']]);
        assert.strictEqual(addStep(copy).entry.env.MCP_MEMORY_SQLITE_PATH, memDb, base.os);
        assert.strictEqual(addStep(copy, 1).entry.command, command, base.os);
        assert.ok(!copy.steps.some((s) => s.scope === 'user' || s.from), `${base.os}: nothing at user scope is touched`);
        const ch = plan(inv(base, { registrations: regs }), changeOf(regs[1], { name: 'pw2', location: { side: 'account' } }), opts(home));
        assert.deepStrictEqual(ch.errors, [], base.os);
        const mv = ch.steps.find((s) => s.op === 'mcp-move');
        assert.deepStrictEqual([mv.from, mv.to], [{ name: 'playwright-chrome', scope: 'user' }, { name: 'pw2', scope: 'user' }]);
        assert.strictEqual(mv.entry.command, command, `${base.os}: the launch as read is kept`);
        assert.strictEqual(mv.entry.args[mv.entry.args.indexOf('--user-data-dir') + 1], pwDir, base.os);
    }
});

test('install questions for a copy: the taken scope is not offered, and an account-default folder becomes the project one', () => {
    const i = inv(MAC, { registrations: [reg('memory', 'user', { command: 'uvx', args: ['--from', 'mcp-memory-service[sqlite]==12.1.1'] }, 'memory', 'local')], plugins: [{ id: 'claude-hud@claude-hud', scope: 'user', enabled: true, rowId: 'claude-hud', alfredRetired: false }, { id: 'typescript-lsp@claude-plugins-official', scope: 'user', enabled: true, rowId: 'typescript-lsp', alfredRetired: false }] });
    const offered = asks.pickQuestions(i, catalog).flat().flatMap((q) => q.options);
    const mem = offered.find((o) => o.label.startsWith('memory'));
    assert.strictEqual(mem.label, 'memory (installed for every project as memory)');
    assert.match(mem.description, /adds this project's own copy; the one for every project stays/);
    assert.ok(offered.some((o) => o.label === 'typescript-lsp (installed for every project)'), 'a plugin at user scope below its recommended project scope');
    assert.ok(!offered.some((o) => o.label.startsWith('claude-hud')), 'installed at its recommended scope: configure\'s');
    const q = asks.all(i, { rows: ['memory', 'typescript-lsp'] }, catalog);
    const ids = q.tools.memory.questions.map((x) => x.id);
    assert.ok(!ids.includes('scope-memory'), 'local is the one scope left: no scope question');
    assert.match(q.tools.memory.questions.find((x) => x.id === 'name-memory').options[0].description, /used instead of the copy for every project/);
    assert.match(q.tools.memory.questions.find((x) => x.id === 'location-memory').options[0].label, /^Use `\.preferred-tools\/memory` \(Recommended\)$/);
    assert.deepStrictEqual(q.tools['typescript-lsp'].questions[0].options.map((o) => o.label), ['project (Recommended)', 'local']);
    for (const t of Object.values(q.tools)) t.questions.forEach(checkQuestion);
});

test('configure: one of two registrations of a row is changed by its key, the other is left and not noted', () => {
    const e = (name) => ({ command: 'uvx', args: ['--python', '3.13', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: { SERENA_HOME: `/work/shop/.preferred-tools/${name}` } });
    const i = inv(MAC, { registrations: [reg('serena', 'local', e('serena'), 'serena', 'local'), reg('serena', 'user', e('serena'), 'serena', 'local')] });
    const p = plan(i, { change: { 'mcp:serena~user': { row: 'serena', name: 'nav' } } }, opts('/h'));
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.steps.length, 1);
    assert.deepStrictEqual([p.steps[0].op, p.steps[0].from, p.steps[0].to], ['mcp-move', { name: 'serena', scope: 'user' }, { name: 'nav', scope: 'user' }]);
    assert.match(p.notes.join(' '), /also installed as 'serena' at local scope - left as it is/);
    const both = plan(i, { change: { 'mcp:serena~user': { name: 'nav' }, 'mcp:serena~local': { name: 'nav-here' } } }, opts('/h'));
    assert.deepStrictEqual(both.errors, []);
    assert.strictEqual(both.steps.length, 2);
    assert.doesNotMatch(both.notes.join(' '), /left as it is/, 'a registration changed in the same plan is not called left');
    assert.strictEqual(plan(i, { change: { 'mcp:serena~user': { row: 'serena' } } }, opts('/h')).noop, true, 'every answer kept: nothing to do');
});

test('configure: a plugin at another scope is a move, an unknown key or a user\'s own server is refused', () => {
    const known = [{ name: 'claude-plugins-official', source: '' }];
    const old = { rowId: 'csharp-lsp', id: 'csharp-lsp@claude-plugins-official', scope: 'user', enabled: true, alfredRetired: false };
    const i = inv(MAC, { marketplaces: known, plugins: [old], registrations: [reg('mine', 'user', { command: 'my-server' })] });
    const p = plan(i, { change: { 'plugin:csharp-lsp@claude-plugins-official~user': { row: 'csharp-lsp', scope: 'project' } } }, opts('/h'));
    assert.deepStrictEqual(p.steps.map((s) => argvOf(s).join(' ')), ['plugin install csharp-lsp@claude-plugins-official --scope project', 'plugin uninstall csharp-lsp@claude-plugins-official --scope user']);
    assert.strictEqual(plan(i, { change: { 'plugin:csharp-lsp@claude-plugins-official~user': {} } }, opts('/h')).noop, true);
    assert.match(plan(i, { change: { 'mcp:serena~local': {} } }, opts('/h')).errors.join(), /nothing is installed as 'mcp:serena~local'/);
    assert.match(plan(i, { change: { 'mcp:mine~user': { name: 'x' } } }, opts('/h')).errors.join(), /'mine' is your own .* left alone/);
    assert.match(plan(i, { change: { 'serena': {} } }, opts('/h')).errors.join(), /a key is mcp:<name>~<scope>/);
});

test('configure questions start from what is installed: its route, scope, name, data folder, binary, key and host are Keep', () => {
    const play = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '/work/shop/.preferred-tools/pw/profile', '--executable-path', '/opt/chrome'] };
    const c7 = { type: 'http', url: 'https://mcp.context7.com/mcp' };
    const i = inv(MAC, { registrations: [reg('pw', 'local', play, 'playwright-chrome', 'local'), reg('c7', 'project', c7, 'context7', 'remote')] });
    const q = asks.all(i, { targets: ['mcp:pw~local', 'mcp:c7~project', 'mcp:none~user'] }, catalog);
    const first = (key, id) => q.targets[key].questions.find((x) => x.id.startsWith(id)).options[0].label;
    assert.strictEqual(q.targets['mcp:pw~local'].row, 'playwright-chrome');
    assert.strictEqual(first('mcp:pw~local', 'scope'), 'local (Recommended)');
    assert.strictEqual(first('mcp:pw~local', 'name'), 'Keep `pw` (Recommended)');
    assert.strictEqual(first('mcp:pw~local', 'browser'), 'Keep `/opt/chrome` (Recommended)');
    assert.strictEqual(q.targets['mcp:c7~project'].route.options[0].label, 'Hosted (Recommended)');
    assert.strictEqual(first('mcp:c7~project', 'scope'), 'project (Recommended)');
    assert.match(q.targets['mcp:none~user'].error, /not a catalog tool installed here/);
    const local = asks.all(inv(MAC, { registrations: [reg('c7', 'local', { command: 'npx', args: ['-y', '@upstash/context7-mcp@2.0.0'] }, 'context7', 'local')] }), { targets: ['mcp:c7~local'] }, catalog);
    assert.strictEqual(local.targets['mcp:c7~local'].route.options[0].label, 'Local (Recommended)', 'the route it has now is recommended, not the catalog\'s');
    for (const t of Object.values(q.targets).filter((x) => !x.error)) { t.questions.forEach(checkQuestion); if (t.route) checkQuestion(t.route); }
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

test('answers.machine from prereq.js reaches the plan: no docker picks the github binary, docker keeps the image; an explicit option wins', () => {
    const entryOf = (answers, machine) => addStep(plan(inv(MAC), answers, opts('/Users/me', { machine }))).entry;
    const github = { picks: { github: { route: 'local' } } };
    assert.strictEqual(entryOf({ ...github, machine: { docker: true } }).command, 'docker');
    const bin = entryOf({ ...github, machine: { docker: false } });
    assert.deepStrictEqual([bin.command, bin.args], ['github-mcp-server', ['stdio']]);
    assert.strictEqual(entryOf(github).command, 'docker', 'unsaid means the image');
    assert.strictEqual(entryOf({ ...github, machine: { docker: false } }, { docker: true }).command, 'docker', 'the option wins over the answers');
});

test("hud: 'defer' plans the install and leaves the settings ask for after it; an installed claude-hud keeps its step", () => {
    const fresh = plan(inv(MAC), { picks: { 'claude-hud': {} }, hud: 'defer' }, opts('/h'));
    assert.deepStrictEqual(fresh.steps.map((s) => s.op), ['plugin-marketplace-add', 'plugin-install']);
    assert.strictEqual(fresh.hudAfter, true);
    assert.strictEqual(fresh.hud, null);
    assert.ok(fresh.notes.some((n) => /asked after the install/.test(n)));
    const known = [{ name: 'claude-hud', source: '' }];
    const enabled = { rowId: 'claude-hud', id: 'claude-hud@claude-hud', scope: 'user', enabled: true, alfredRetired: false };
    const kept = plan(inv(MAC, { marketplaces: known, plugins: [enabled] }), { picks: { 'claude-hud': {} }, hud: 'replace' }, opts('/h'));
    assert.deepStrictEqual(kept.steps.map((s) => [s.op, s.mode]), [['hud', 'replace']]);
    assert.ok(!kept.hudAfter);
});

test('--questions takes the route answered so far: a remote context7 may sit in the committed file, a local one may not', () => {
    const i = inv(MAC);
    const scopes = (route) => asks.all(i, { rows: ['context7'], routes: { context7: route } }, catalog).tools.context7.questions.find((q) => q.id === 'scope-context7').options.map((o) => o.label.replace(/ \(Recommended\)$/, ''));
    assert.deepStrictEqual(scopes('remote'), ['project', 'local', 'user']);
    assert.deepStrictEqual(scopes('local'), ['local', 'user']);
    assert.strictEqual(asks.all(i, { rows: ['serena'] }, catalog).tools.serena.route, null, 'a one-route row has no route ask');
});

test('the remove asks carry what to remove in their descriptions, in a form the walk can read back', () => {
    const i = inv(MAC, {
        registrations: [
            { name: 'proj-serena', scope: 'local', entry: { command: 'uvx' }, rowId: 'serena', route: 'local', own: false, alfredRetired: false },
            { name: 'context7', scope: 'project', entry: { type: 'http' }, rowId: 'context7', route: 'remote', own: false, alfredRetired: false },
        ],
        plugins: [{ id: 'claude-hud@claude-hud', plugin: 'claude-hud', scope: 'user', version: '0.13.1', enabled: true, errors: [], rowId: 'claude-hud', alfredRetired: false }],
    });
    const options = asks.removeQuestions(i, catalog).flat().flatMap((q) => q.options);
    assert.strictEqual(options.length, 3);
    for (const o of options) assert.match(o.description, /^claude (mcp remove \S+ -s (local|project|user)|plugin uninstall \S+ --scope (local|project|user))$/);
    assert.deepStrictEqual(options.map((o) => o.description), ['claude mcp remove proj-serena -s local', 'claude mcp remove context7 -s project', 'claude plugin uninstall claude-hud@claude-hud --scope user']);
});

test('location: alfred-code data on disk is a second answer, not the recommended one, and absent without the folder', () => {
    const ctx = (exists) => ({ project: '/work/shop', platform: 'darwin', arch: 'arm64', home: '/Users/me', env: {}, exists });
    const loc = (exists) => asks.toolQuestions(catalog.byId.get('playwright-chrome'), inv(MAC), { route: 'local', ctx: ctx(exists), catalog }).find((q) => q.id === 'location-playwright-chrome');
    const withData = loc((p) => p === '/work/shop/.alfred/chrome-control');
    checkQuestion(withData);
    assert.match(withData.options[0].label, /^Keep `\.preferred-tools\/playwright-chrome` \(Recommended\)$/);
    assert.strictEqual(withData.options[1].label, "Use alfred-code's `.alfred/chrome-control`");
    assert.match(withData.options[1].description, /deleting it erases this tool's data/);
    assert.ok(!loc(() => false).options.some((o) => /alfred/.test(o.label)), 'no alfred-code folder, no answer for it');
});

test('plan.js from a kept inventory file leaves location keys as they are', () => {
    // memory at user scope, renamed by configure from the inventory as inventory.js writes it
    const live = `sk-live-${require('node:crypto').randomBytes(16).toString('hex')}`;
    const db = '/h/.preferred-tools/memory/memory.db';
    const r = reg('memory', 'user', { command: 'uvx', args: ['--python', '3.13', '--exclude-newer', '2026-10-20T23:59:59Z', '--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'], env: { MCP_MEMORY_STORAGE_BACKEND: 'sqlite_vec', MCP_MEMORY_SQLITE_PATH: db, MEMORY_API_TOKEN: live } }, 'memory', 'local');
    const kept = inventoryLib.keptOf(inv(MAC, { registrations: [r] }), catalog);
    assert.strictEqual(kept.registrations[0].entry.env.MEMORY_API_TOKEN, MARKER);
    const p = plan(kept, changeOf(r, { name: 'mem' }), opts('/h'));
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.steps.map((s) => s.op), ['mcp-move']);
    assert.strictEqual(p.steps[0].entry.env.MCP_MEMORY_SQLITE_PATH, db);
    assert.strictEqual(p.steps[0].entry.env.MEMORY_API_TOKEN, MARKER, 'the value travels as the marker');
    assert.ok(!JSON.stringify(p).includes(live));
});

test('configure plan.js from a kept inventory prints no live value', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const token = `sntryu_${require('node:crypto').randomBytes(16).toString('hex')}`;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-plan-'));
    try
    {
        const r = reg('sentry-live', 'local', { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: token } }, 'sentry', 'local');
        fs.writeFileSync(path.join(d, 'inv.json'), JSON.stringify(inventoryLib.keptOf(inv(MAC, { registrations: [r] }), catalog)));
        fs.writeFileSync(path.join(d, 'ans.json'), JSON.stringify(changeOf(r, { name: 'sentry-moved' })));
        const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'plan.js'), path.join(d, 'inv.json'), path.join(d, 'ans.json'), '--out', path.join(d, 'plan.json')], { encoding: 'utf8' });
        assert.strictEqual(out.status, 0, out.stderr);
        assert.match(out.stdout, /claude mcp add-json sentry-moved .*\$\{PREFERRED_TOOLS_KEPT\}/);
        for (const where of [out.stdout, out.stderr, fs.readFileSync(path.join(d, 'plan.json'), 'utf8')]) assert.ok(!where.includes(token));
    }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
});
