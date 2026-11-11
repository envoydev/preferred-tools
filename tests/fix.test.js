'use strict';
// Step 9: the fix engine - every detector found and not found, the fixes as pure edits of the entry as read, the
// composition into one replace per registration, the asks, and the apply path against the fake claude.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { world, readJson } = require('./helpers.js');
const catalogLib = require('../scripts/catalog.js');
const inventory = require('../scripts/inventory.js');
const E = require('../scripts/entries.js');
const cli = require('../scripts/claude-cli.js');
const account = require('../scripts/account.js');
const F = require('../scripts/fixes/index.js');
const fix = require('../scripts/fix.js');
const C = require('../scripts/fixes/common.js');

const catalog = catalogLib.load();
const row = (id) => catalog.byId.get(id);

// ---- a hand-built inventory and ctx -------------------------------------------------------------------------------

const noMachine = (over = {}) => ({ exists: () => false, realpath: () => null, which: () => null, run: () => ({ status: 1, stdout: '', stderr: '' }), nodeVersion: '24.0.0', ...over });

function reg(rowId, entry, { name = row(rowId).name, scope = 'local', route = 'local' } = {}) { return { name, scope, entry, rowId, route, own: false, alfredRetired: false }; }

function ctxFor({ platform = 'darwin', arch = 'x64', registrations = [], plugins = [], env = {}, machine = noMachine(), project, home } = {})
{
    const win = platform === 'win32';
    const inv = { version: 1, project: project || (win ? 'C:\\proj' : '/proj'), os: platform, arch, registrations, plugins, cli: { ok: true } };
    return fix.makeCtx({ inv, catalog, env: { ...env, HOME: home || (win ? 'C:\\Users\\dev' : '/home/dev') }, machine, platform, arch });
}

// a fresh entry the way the catalog builds it, for the row's local route
function fresh(rowId, platform = 'darwin', arch = 'x64', scope = 'local')
{
    const win = platform === 'win32';
    const r = row(rowId);
    const ctx = { platform, arch, env: {}, home: win ? 'C:\\Users\\dev' : '/home/dev', project: win ? 'C:\\proj' : '/proj' };
    const rootStr = r.locations ? (win ? 'C:\\Users\\dev\\.pt\\x' : '/home/dev/.pt/x') : undefined;
    return E.buildEntry(r, 'local', { rootStr, scope, token: false }, ctx, catalog.rules);
}

const ids = (list) => list.map((f) => f.id);
const detect = (ctx, only) => fix.detectAll(ctx, { only });

// ---- the catalog is wired ------------------------------------------------------------------------------------------

test('every live fix row names a detector and a fix that exist, a tool the catalog has, and an OS; a held row is listed, not run', () =>
{
    const seen = new Set();
    for (const f of catalog.fixes)
    {
        assert.ok(!seen.has(f.id), `duplicate fix id ${f.id}`);
        seen.add(f.id);
        for (const t of f.tool) assert.ok(catalog.byId.has(t), `${f.id}: unknown tool ${t}`);
        for (const o of f.os) assert.ok(['darwin', 'linux', 'win32'].includes(o), `${f.id}: ${o}`);
        for (const k of ['symptom', 'verifiedOn', 'source']) assert.ok(f[k], `${f.id}: no ${k}`);
        if (f.hold) continue;
        assert.strictEqual(typeof F[f.detect], 'function', `${f.id}: no ${f.detect}`);
        if (f.advice) assert.strictEqual(f.fix, null, `${f.id}: an advice row has no fix`);
        else assert.strictEqual(typeof F[f.fix], 'function', `${f.id}: no ${f.fix}`);
    }
    const held = detect(ctxFor({ platform: 'win32' })).held;
    assert.deepStrictEqual(ids(held), ['serena-windows-ts-shim']);
});

test('a fresh entry from the catalog is clean on every OS - no detector fires on what the installer writes', () =>
{
    for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'x64'], ['win32', 'arm64']])
    {
        for (const r of catalog.tools.filter((t) => t.kind === 'mcp' && t.routes.local && t.os.includes(platform)))
        {
            const entry = fresh(r.id, platform, arch);
            const m = inventory.matchEntry(entry, catalog);
            assert.deepStrictEqual(m, { rowId: r.id, route: 'local' }, `${r.id} on ${platform} is recognised`);
            const found = detect(ctxFor({ platform, arch, registrations: [reg(r.id, entry, { route: 'local' })] })).found;
            // appium's SDK paths are looked up on the machine by this very fix: with none on it, the finding is blocked
            assert.deepStrictEqual(found.filter((f) => f.id !== 'appium-sdk-env'), [], `${r.id} on ${platform}/${arch}`);
            for (const f of found) assert.ok(f.blocked, `${r.id}: ${f.id} should be blocked with nothing on the machine`);
        }
    }
});

// ---- serena-windows-home --------------------------------------------------------------------------------------------

test('serena-windows-home: slashes keep the folder, a space needs another one, a relative path resolves against the project', () =>
{
    const homes = (ctx) => detect(ctx).found.filter((f) => f.id === 'serena-windows-home');
    const mk = (home, extra = {}, opts = {}) => ctxFor({ platform: 'win32', registrations: [reg('serena', { command: 'uvx', args: ['--python', '3.13'], env: { SERENA_HOME: home, ...extra } }, opts)], ...opts.ctx });
    // slashes only
    let [f] = homes(mk('C:/Users/dev/.serena'));
    assert.strictEqual(f.id, 'serena-windows-home');
    assert.deepStrictEqual(f.proposal, { SERENA_HOME: 'C:\\Users\\dev\\.serena' });
    assert.match(f.note, /same folder/);
    const edited = F.serenaWindowsHomeFix({ command: 'uvx', args: ['x'], env: { SERENA_HOME: 'C:/Users/dev/.serena', KEEP: '1' } }, f, ctxFor({ platform: 'win32' }));
    assert.deepStrictEqual(edited.env, { SERENA_HOME: 'C:\\Users\\dev\\.serena', KEEP: '1' }, 'the other env survives');
    // already right
    assert.deepStrictEqual(homes(mk('C:\\Users\\dev\\.serena')), []);
    // a space, a profile without one: a new home, said plainly
    [f] = homes(mk('C:\\Users\\dev\\my serena'));
    assert.deepStrictEqual(f.proposal, { SERENA_HOME: 'C:\\Users\\dev\\.serena' });
    assert.match(f.note, /not moved/);
    // a space and a profile with one: it asks, and applies nothing without the answer
    const spaced = ctxFor({ platform: 'win32', home: 'C:\\Users\\Jo Doe', registrations: [reg('serena', { command: 'uvx', args: [], env: { SERENA_HOME: 'C:\\Users\\Jo Doe\\.serena' } })] });
    [f] = homes(spaced);
    assert.strictEqual(f.input.id, 'serenaHome');
    assert.throws(() => F.serenaWindowsHomeFix({ env: {} }, f, spaced, {}), /absolute Windows folder/);
    assert.throws(() => F.serenaWindowsHomeFix({ env: {} }, f, spaced, { serenaHome: 'C:\\has space' }), /absolute Windows folder/);
    assert.strictEqual(F.serenaWindowsHomeFix({ env: {} }, f, spaced, { serenaHome: 'C:\\serena-home' }).env.SERENA_HOME, 'C:\\serena-home');
    // relative -> the project folder
    [f] = homes(mk('.serena\\home'));
    assert.deepStrictEqual(f.proposal, { SERENA_HOME: 'C:\\proj\\.serena\\home' });
    // a ${VAR} form at project scope is 0.2.0's: project-relative-path writes it out absolute, not this row
    assert.deepStrictEqual(homes(mk('${USERPROFILE}/.serena', {}, { scope: 'project' })), []);
    // not Windows, or no SERENA_HOME at all: nothing
    assert.deepStrictEqual(detect(ctxFor({ platform: 'darwin', registrations: [reg('serena', { command: 'uvx', args: [], env: { SERENA_HOME: 'C:/x' } })] })).found.filter((x) => x.id === 'serena-windows-home'), []);
    assert.deepStrictEqual(detect(ctxFor({ platform: 'win32', registrations: [reg('serena', { command: 'uvx', args: ['--python', '3.13'], env: { SERENA_USAGE_REPORTING: 'false' } })] })).found, []);
});

test('serena-windows-home: no SERENA_HOME is serena\'s default <profile>\\.serena - found on a profile with a space, never on one without', () =>
{
    const homes = (ctx) => detect(ctx).found.filter((f) => f.id === 'serena-windows-home');
    // a registration made by hand, as alfred-code's guide writes it: no SERENA_HOME
    const bare = (scope = 'local') => reg('serena', { command: 'uvx', args: ['--python', '3.13'], env: { SERENA_USAGE_REPORTING: 'false' } }, { scope });
    assert.deepStrictEqual(homes(ctxFor({ platform: 'win32', home: 'C:\\Users\\dev', registrations: [bare()] })), [], 'a space-free profile: the default home works');
    // a profile with a space: the space-free folder install offers in its place (E.serenaSpaceFree)
    const spaced = ctxFor({ platform: 'win32', home: 'C:\\Users\\Jo Doe', env: { SystemDrive: 'D:' }, registrations: [bare()] });
    const [f] = homes(spaced);
    assert.ok(f, 'found');
    assert.match(f.found, /no SERENA_HOME/);
    assert.ok(f.found.includes('C:\\Users\\Jo Doe\\.serena'), f.found);
    assert.deepStrictEqual(f.proposal, { SERENA_HOME: 'D:\\serena-home' });
    assert.match(f.note, /not moved/);
    assert.deepStrictEqual(F.serenaWindowsHomeFix(bare().entry, f, spaced).env, { SERENA_USAGE_REPORTING: 'false', SERENA_HOME: 'D:\\serena-home' });
    // project scope: named, with the Location question to pick a space-free folder
    const [p] = homes(ctxFor({ platform: 'win32', home: 'C:\\Users\\Jo Doe', registrations: [bare('project')] }));
    assert.match(p.blocked, /pick a space-free folder with \/preferred-tools:configure, Location/);
    assert.deepStrictEqual(homes(ctxFor({ platform: 'darwin', home: '/Users/Jo Doe', registrations: [bare()] })), [], 'not Windows');
});

// ---- uvx-python / windows-arm-python --------------------------------------------------------------------------------

test('uvx-python: a uvx server with no --python gets the row\'s minor first, its pin and cut-off untouched', () =>
{
    const entry = fresh('serena');
    const bare = { ...entry, args: entry.args.filter((a, i, all) => a !== '--python' && all[i - 1] !== '--python') };
    bare.args = bare.args.map((a) => (a === 'serena-agent@2.1.0' ? 'serena-agent@2.0.0' : a)); // the user's own, older pin
    const ctx = ctxFor({ registrations: [reg('serena', bare)] });
    const found = detect(ctx).found.filter((f) => f.id === 'uvx-python');
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0].proposal, { python: '3.13' });
    const out = F.uvxPythonFix(bare, found[0], ctx);
    assert.deepStrictEqual(out.args.slice(0, 2), ['--python', '3.13']);
    assert.deepStrictEqual(out.args.slice(2), bare.args, 'everything the user had follows, in order');
    assert.ok(out.args.includes('serena-agent@2.0.0'), 'the pin is not moved to the catalog\'s');
    // present: nothing; the other forms of the flag count
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('serena', entry)] })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('serena', { ...bare, args: ['--python=3.12', ...bare.args] })] })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('serena', { ...bare, args: ['-p', '3.12', ...bare.args] })] })).found, []);
    // on Windows ARM64 the request is the x64 build
    const arm = ctxFor({ platform: 'win32', arch: 'arm64', registrations: [reg('memory', { command: 'uvx', args: ['--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'], env: {} })] });
    assert.strictEqual(detect(arm).found.find((f) => f.id === 'uvx-python').proposal.python, 'cpython-3.13-windows-x86_64-none');
});

test('windows-arm-python: a plain minor on Windows ARM64 becomes the x64 build; a build the user chose, or another CPU, is left', () =>
{
    const entry = { command: 'uvx', args: ['--python', '3.12', '--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'], env: {} };
    const arm = ctxFor({ platform: 'win32', arch: 'arm64', registrations: [reg('memory', entry)] });
    const [f] = detect(arm).found;
    assert.strictEqual(f.id, 'windows-arm-python');
    assert.strictEqual(f.proposal.python, 'cpython-3.12-windows-x86_64-none', 'the entry\'s own minor, not the catalog\'s');
    assert.strictEqual(F.windowsArmPythonFix(entry, f).args[1], 'cpython-3.12-windows-x86_64-none');
    // x64 node emulated on ARM: the machine-wide identifier tells the truth
    const emulated = ctxFor({ platform: 'win32', arch: 'x64', env: { PROCESSOR_IDENTIFIER: 'ARMv8 (64-bit) Family 8 Model 1' }, registrations: [reg('memory', entry)] });
    assert.deepStrictEqual(ids(detect(emulated).found), ['windows-arm-python']);
    assert.deepStrictEqual(detect(ctxFor({ platform: 'win32', arch: 'x64', registrations: [reg('memory', entry)] })).found, []);
    const chosen = { ...entry, args: ['--python', 'cpython-3.12-windows-x86_64-none', ...entry.args.slice(2)] };
    assert.deepStrictEqual(detect(ctxFor({ platform: 'win32', arch: 'arm64', registrations: [reg('memory', chosen)] })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ platform: 'darwin', arch: 'arm64', registrations: [reg('memory', entry)] })).found, []);
});

// ---- windows-npx-cmd ------------------------------------------------------------------------------------------------

test('windows-npx-cmd: a direct npx on Windows is wrapped in cmd /c, flagged as an unproved precaution; a wrapped one and other OSes are clean', () =>
{
    const direct = { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4'], env: { npm_config_before: '2026-10-20T23:59:59Z' } };
    const win = ctxFor({ platform: 'win32', registrations: [reg('context7', direct, { name: 'context7' })] });
    const [f] = detect(win).found;
    assert.strictEqual(f.id, 'windows-npx-cmd');
    assert.strictEqual(f.documented, false);
    assert.match(f.note, /no longer documents/);
    assert.deepStrictEqual(F.windowsNpxCmdFix(direct), { command: 'cmd', args: ['/c', 'npx', '-y', '@upstash/context7-mcp@4.4.4'], env: direct.env });
    assert.deepStrictEqual(detect(ctxFor({ platform: 'win32', registrations: [reg('context7', fresh('context7', 'win32'))] })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ platform: 'darwin', registrations: [reg('context7', direct)] })).found, []);
    assert.deepStrictEqual(ids(detect(ctxFor({ platform: 'win32', registrations: [reg('context7', { ...direct, command: 'npx.cmd' })] })).found), ['windows-npx-cmd']);
});

// ---- playwright-webmcp ----------------------------------------------------------------------------------------------

test('playwright-webmcp: --no-webmcp goes right after --browser, an executable path is kept, an older pin blocks it', () =>
{
    const base = fresh('playwright-chrome');
    const without = { ...base, args: base.args.filter((a) => a !== '--no-webmcp').concat(['--executable-path', '/Applications/Chrome']) };
    const ctx = ctxFor({ registrations: [reg('playwright-chrome', without)] });
    const [f] = detect(ctx).found;
    assert.strictEqual(f.id, 'playwright-webmcp');
    assert.ok(!f.blocked);
    const out = F.playwrightWebmcpFix(without, f);
    const at = out.args.indexOf('--browser');
    assert.deepStrictEqual(out.args.slice(at, at + 3), ['--browser', 'chrome', '--no-webmcp']);
    assert.deepStrictEqual(out.args.slice(-2), ['--executable-path', '/Applications/Chrome']);
    // through the Windows wrapper
    const wrapped = { command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@0.0.83', '--browser', 'msedge'], env: {} };
    const w = detect(ctxFor({ platform: 'win32', registrations: [reg('playwright-msedge', wrapped)] })).found[0];
    assert.deepStrictEqual(F.playwrightWebmcpFix(wrapped, w).args, ['/c', 'npx', '-y', '@playwright/mcp@0.0.83', '--browser', 'msedge', '--no-webmcp']);
    // present: clean
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('playwright-chrome', base)] })).found, []);
    // a pin older than the documented version
    const old = { ...without, args: without.args.map((a) => (a.startsWith('@playwright/mcp@') ? '@playwright/mcp@0.0.50' : a)) };
    const [b] = detect(ctxFor({ registrations: [reg('playwright-chrome', old)] })).found;
    assert.match(b.blocked, /older than 0\.0\.83/);
    // the floor is the release that documents the flag, not the catalog's moving pin: 0.0.83 is fixed, never blocked
    const at83 = { ...without, args: without.args.map((a) => (a.startsWith('@playwright/mcp@') ? '@playwright/mcp@0.0.83' : a)) };
    const [ok83] = detect(ctxFor({ registrations: [reg('playwright-chrome', at83)] })).found;
    assert.strictEqual(ok83.id, 'playwright-webmcp');
    assert.strictEqual(ok83.blocked, undefined, 'a pin that documents --no-webmcp is not blocked by a newer catalog pin');
    // a dist-tag compares as unknown, so it is not blocked
    const tagged = { ...without, args: without.args.map((a) => (a.startsWith('@playwright/mcp@') ? '@playwright/mcp@latest' : a)) };
    assert.ok(!detect(ctxFor({ registrations: [reg('playwright-chrome', tagged)] })).found[0].blocked);
});

// ---- appium-sdk-env -------------------------------------------------------------------------------------------------

test('appium-sdk-env: ANDROID_HOME and JAVA_HOME are looked up on the machine and added, never over a value the user set', () =>
{
    const appium = fresh('appium');
    const files = ['/Users/dev/Library/Android/sdk', '/opt/jdk-21', '/opt/jdk-21/bin/java'];
    const machine = noMachine({
        exists: (p) => files.includes(p),
        run: (cmd) => (cmd === '/usr/libexec/java_home' ? { status: 0, stdout: '/opt/jdk-21\n' } : { status: 1 }),
    });
    const ctx = ctxFor({ platform: 'darwin', home: '/Users/dev', machine, registrations: [reg('appium', appium, { name: 'appium-mcp' })] });
    const [f] = detect(ctx).found;
    assert.strictEqual(f.id, 'appium-sdk-env');
    assert.deepStrictEqual(f.proposal, { ANDROID_HOME: '/Users/dev/Library/Android/sdk', JAVA_HOME: '/opt/jdk-21' });
    const out = F.appiumSdkEnvFix(appium, f);
    assert.strictEqual(out.env.ANDROID_HOME, '/Users/dev/Library/Android/sdk');
    assert.strictEqual(out.env.NO_UI, 'true', 'the rest of the env stays');
    // the shell's variables win over the default folders
    const viaEnv = ctxFor({ platform: 'darwin', home: '/Users/dev', env: { ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk' }, machine: noMachine({ exists: (p) => ['/sdk', '/jdk'].includes(p) }), registrations: [reg('appium', appium, { name: 'appium-mcp' })] });
    assert.deepStrictEqual(detect(viaEnv).found[0].proposal, { ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk' });
    // java found by the PATH, resolved through the symlink to its home (Linux)
    const linux = ctxFor({
        platform: 'linux', home: '/home/dev', registrations: [reg('appium', appium, { name: 'appium-mcp' })],
        machine: noMachine({ exists: (p) => ['/home/dev/Android/Sdk', '/usr/lib/jvm/java-21/bin/java'].includes(p), which: (n) => (n === 'java' ? '/usr/bin/java' : null), realpath: () => '/usr/lib/jvm/java-21/bin/java' }),
    });
    assert.deepStrictEqual(detect(linux).found[0].proposal, { ANDROID_HOME: '/home/dev/Android/Sdk', JAVA_HOME: '/usr/lib/jvm/java-21' });
    // one found, one not: apply the one, say so
    const half = ctxFor({ platform: 'darwin', home: '/Users/dev', machine: noMachine({ exists: (p) => p === '/Users/dev/Library/Android/sdk' }), registrations: [reg('appium', appium, { name: 'appium-mcp' })] });
    const h = detect(half).found[0];
    assert.deepStrictEqual(h.proposal, { ANDROID_HOME: '/Users/dev/Library/Android/sdk' });
    assert.match(h.note, /JAVA_HOME not found on this machine and left unset/);
    // neither found: blocked, with what to install
    const none = detect(ctxFor({ registrations: [reg('appium', appium, { name: 'appium-mcp' })] })).found[0];
    assert.match(none.blocked, /ANDROID_HOME and JAVA_HOME not found/);
    // already set: clean; the user's value is never replaced
    const set = { ...appium, env: { ...appium.env, ANDROID_HOME: '/mine', JAVA_HOME: '/mine-jdk' } };
    assert.deepStrictEqual(detect(ctxFor({ machine, registrations: [reg('appium', set, { name: 'appium-mcp' })] })).found, []);
    const partly = { ...appium, env: { ...appium.env, ANDROID_HOME: '/mine' } };
    assert.deepStrictEqual(Object.keys(detect(ctxFor({ home: '/Users/dev', machine, registrations: [reg('appium', partly, { name: 'appium-mcp' })] })).found[0].proposal), ['JAVA_HOME']);
    // project scope holds this machine's paths too: the same proposal
    const committed = detect(ctxFor({ home: '/Users/dev', machine, registrations: [reg('appium', appium, { name: 'appium-mcp', scope: 'project' })] })).found[0];
    assert.deepStrictEqual(committed.proposal, { ANDROID_HOME: '/Users/dev/Library/Android/sdk', JAVA_HOME: '/opt/jdk-21' });
});

// ---- serena-telemetry -----------------------------------------------------------------------------------------------

test('serena-telemetry: an absent variable is set to false; a value the user chose, either way, is left', () =>
{
    const entry = fresh('serena');
    const stripped = { ...entry, env: { SERENA_HOME: entry.env.SERENA_HOME } };
    const ctx = ctxFor({ registrations: [reg('serena', stripped)] });
    const [f] = detect(ctx).found;
    assert.strictEqual(f.id, 'serena-telemetry');
    assert.deepStrictEqual(F.serenaTelemetryFix(stripped).env, { SERENA_HOME: entry.env.SERENA_HOME, SERENA_USAGE_REPORTING: 'false' });
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('serena', entry)] })).found, []);
    const optedIn = { ...entry, env: { ...entry.env, SERENA_USAGE_REPORTING: 'true' } };
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('serena', optedIn)] })).found, []);
    // an entry with no env at all
    const bare = { command: 'uvx', args: entry.args };
    assert.deepStrictEqual(F.serenaTelemetryFix(bare).env, { SERENA_USAGE_REPORTING: 'false' });
});

// ---- data-folder-ignore ---------------------------------------------------------------------------------------------

test('data-folder-ignore: a relative folder here with no ignore is found and fixed; its own .gitignore or alfred-code\'s covers it', () =>
{
    const fs = require('node:fs');
    const w = world();
    try
    {
        const pw = (root) => ({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', root] });
        // a parent's .mcp.json server: it starts here too, and this row reads it (the other rows never do)
        const parent = (root, extra = {}) => ({ ...reg('playwright-chrome', pw(root), { scope: 'inherited' }), from: path.dirname(w.project), approval: 'pending', shadowed: null, ...extra });
        // a real git: this world is no work tree, so git cannot answer and the folder's own files decide
        const ctx = (registrations) => ctxFor({ platform: process.platform, project: w.project, registrations, machine: noMachine({ exists: (p) => fs.existsSync(p), run: C.realMachine().run }) });
        const found = (registrations) => F.dataFolderIgnoreDetect(ctx(registrations));
        const folder = path.join(w.project, '.preferred-tools', 'playwright-chrome');

        const f = found([parent('.preferred-tools/playwright-chrome')]);
        assert.deepStrictEqual(f.map((x) => [x.id, x.name, x.scope, x.proposal.path]), [['data-folder-ignore', 'playwright-chrome', 'inherited', folder]]);
        assert.match(f[0].found, /\.preferred-tools\/playwright-chrome .*not git-ignored/);
        // through the engine: a machine fix, offered
        const d = fix.detectAll(ctx([parent('.preferred-tools/playwright-chrome')]), { only: 'data-folder-ignore' });
        assert.deepStrictEqual(d.found.map((x) => [x.id, x.kind, Boolean(x.blocked)]), [['data-folder-ignore', 'machine', false]]);

        const r = F.dataFolderIgnoreFix(f[0], ctx([]));
        assert.strictEqual(r.ok, true, r.detail);
        assert.strictEqual(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'), '*\n');
        assert.deepStrictEqual(found([parent('.preferred-tools/playwright-chrome')]), [], 'read back: covered');
        // a .gitignore already there is left as it is
        fs.writeFileSync(path.join(folder, '.gitignore'), 'mine\n');
        assert.strictEqual(F.dataFolderIgnoreFix(f[0], ctx([])).ok, true);
        assert.strictEqual(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'), 'mine\n');

        // .alfred/<name>: alfred-code's .alfred/.gitignore covers it, and only it
        assert.deepStrictEqual(found([parent('.alfred/playwright-chrome')]).map((x) => x.proposal.path), [path.join(w.project, '.alfred', 'playwright-chrome')]);
        fs.mkdirSync(path.join(w.project, '.alfred'));
        fs.writeFileSync(path.join(w.project, '.alfred', '.gitignore'), '*\n');
        assert.deepStrictEqual(found([parent('.alfred/playwright-chrome')]), []);
        assert.strictEqual(found([parent('.preferred-tools/pw2')]).length, 1, "alfred-code's file does not cover .preferred-tools");

        // what is not found: a parent's server rejected here or shadowed, an absolute, ${HOME} or ~ folder, a user's own server
        assert.deepStrictEqual(found([parent('.preferred-tools/pw3', { approval: 'rejected' })]), []);
        assert.deepStrictEqual(found([parent('.preferred-tools/pw3', { shadowed: { scope: 'project' } })]), []);
        for (const root of [path.join(w.home, 'pw'), '${HOME}/.preferred-tools/pw', '~/.preferred-tools/pw']) assert.deepStrictEqual(found([parent(root)]), [], root);
        assert.deepStrictEqual(found([{ ...parent('.preferred-tools/pw3'), own: true, rowId: null }]), []);
        // this folder's own project-scope server; local and user scope write absolute folders, never relative ones
        assert.strictEqual(found([reg('playwright-chrome', pw('.preferred-tools/pw3'), { scope: 'project' })]).length, 1);
        assert.deepStrictEqual(found([reg('playwright-chrome', pw('.preferred-tools/pw3'), { scope: 'local' })]), []);
        // two registrations naming one folder are one finding
        assert.strictEqual(found([parent('.preferred-tools/pw3'), reg('playwright-chrome', pw('.preferred-tools/pw3'), { scope: 'project', name: 'pw' })]).length, 1);
    }
    finally { w.clean(); }
});

// ---- npx-cache-entry ------------------------------------------------------------------------------------------------

// npx's folder for one package spec, as npm 11.6.1's libnpmexec names it: sha512 of the spec, hex, the first 16
const npxFolder = (cache, spec) => path.join(cache, '_npx', require('node:crypto').createHash('sha512').update(spec).digest('hex').slice(0, 16));
// npm in force with this cache, as npm 10.9.2 and 11.6.1 answer (measured): `config get cache` is refused, and
// `config ls -l` prints each source's value, all but the one in force commented out; any other call fails
const npmAt = (cache, over = {}) => noMachine({
    exists: (p) => require('node:fs').existsSync(p),
    run: (cmd, args) =>
    {
        const a = `${cmd} ${args.join(' ')}`;
        if (a === 'npm config get cache') return { status: 1, stdout: '', stderr: 'npm error The cache option is protected, and can not be retrieved in this way\n' };
        if (a === 'npm config ls -l') return { status: 0, stdout: `; "default" config\n; cache = ${JSON.stringify(path.join(cache, 'not-this'))} ; overridden by env\ncache-max = null\n\n; "env" config from environment\ncache = ${JSON.stringify(cache)}\r\n`, stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
    },
    ...over,
});

test('npx-cache-entry: an npx server whose cache folder lost its package.json is found; the fix removes that folder only and fetches it again', () =>
{
    const fs = require('node:fs');
    const w = world();
    try
    {
        const cache = path.join(w.home, '.npm');
        const spec = '@playwright/mcp@0.0.84';
        const folder = npxFolder(cache, spec);
        const pw = reg('playwright-chrome', { command: 'npx', args: ['-y', spec, '--browser', 'chrome'], env: { npm_config_before: '2026-11-10T23:59:59Z' } }, { scope: 'project' });
        const ctx = (registrations = [pw], machine = npmAt(cache)) => ctxFor({ platform: process.platform, project: w.project, registrations, machine });
        const found = (registrations, machine) => F.npxCacheEntryDetect(ctx(registrations, machine));

        assert.deepStrictEqual(found(), [], 'no folder yet: npx has not run');
        fs.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(folder, 'package.json'), '{}\n');
        assert.deepStrictEqual(found(), [], 'a whole folder');
        fs.rmSync(path.join(folder, 'package.json'));
        const [f] = found();
        assert.deepStrictEqual([f.id, f.row, f.name, f.scope, f.proposal], ['npx-cache-entry', 'playwright-chrome', 'playwright-chrome', 'project', { path: folder, what: spec }]);
        assert.match(f.found, /no package\.json/);
        assert.match(f.found, /ENOENT/);
        assert.ok(!JSON.stringify(f).includes('npm_config_before'), 'a finding carries no env - a key could be in it');
        assert.deepStrictEqual(fix.detectAll(ctx(), { only: 'npx-cache-entry' }).found.map((x) => [x.id, x.kind, Boolean(x.blocked)]), [['npx-cache-entry', 'machine', false]]);
        // Windows' cmd /c npx is the same package, the same folder: two registrations of it, one finding
        const edge = reg('playwright-msedge', { command: 'cmd', args: ['/c', 'npx', '-y', spec, '--browser', 'msedge'] }, { scope: 'local' });
        assert.strictEqual(found([pw, edge]).length, 1);
        // a parent folder's server, as a child folder inherits it: npx's cache is the machine's, so fix run here finds
        // it too; one a nearer server of its name shadows, or one rejected here, does not start here
        const parentDir = path.dirname(w.project);
        const inherited = { ...pw, scope: 'inherited', from: parentDir, approval: 'pending', shadowed: null };
        const [fi] = found([inherited]);
        assert.deepStrictEqual([fi && fi.scope, fi && fi.proposal.path], ['inherited', folder]);
        assert.deepStrictEqual(found([{ ...inherited, shadowed: { scope: 'local', from: null } }]), []);
        assert.deepStrictEqual(found([{ ...inherited, approval: 'rejected' }]), []);
        assert.deepStrictEqual(found([{ ...pw, approval: 'rejected' }]), []);
        // the registration's own npm_config_cache wins over npm's answer
        const other = path.join(w.home, 'other-cache');
        fs.mkdirSync(npxFolder(other, spec), { recursive: true });
        const own = reg('playwright-chrome', { command: 'npx', args: ['-y', spec], env: { npm_config_cache: other } }, { name: 'pw-own' });
        assert.deepStrictEqual(found([own], npmAt(path.join(w.home, 'nowhere'))).map((x) => x.proposal.path), [npxFolder(other, spec)]);
        // npm_config_cache in the environment fix runs in is npm's own first source, ahead of any .npmrc - and npm prints
        // a UUID-shaped part of a path as *** (measured), so a value it redacted is no folder
        const inEnv = (env, machine) => F.npxCacheEntryDetect(ctxFor({ platform: process.platform, project: w.project, registrations: [pw], machine, env }));
        assert.deepStrictEqual(inEnv({ NPM_CONFIG_CACHE: other }, npmAt(path.join(w.home, 'nowhere'))).map((x) => x.proposal.path), [npxFolder(other, spec)]);
        assert.deepStrictEqual(inEnv({ npm_config_cache: '' }, npmAt(cache)).map((x) => x.proposal.path), [folder], 'an empty value is no value to npm');
        assert.deepStrictEqual(inEnv({}, npmAt(path.join(w.home, '***', 'npm-cache'), { exists: (p) => !p.endsWith('package.json') })), []);

        // what is not found: npm cannot answer, a user's own server, an alfred-code leftover, a uvx server
        assert.deepStrictEqual(found([pw], noMachine({ exists: (p) => fs.existsSync(p) })), []);
        assert.deepStrictEqual(found([{ ...pw, own: true, rowId: null }]), []);
        assert.deepStrictEqual(found([{ ...pw, alfredRetired: true }]), []);
        assert.deepStrictEqual(found([reg('serena', { command: 'uvx', args: ['--from', 'serena-agent@2.1.0', 'serena'] })]), []);

        // the fix: that folder goes, its neighbour stays, and the package is asked for again from the registration as read
        const neighbour = path.join(cache, '_npx', '0123456789abcdef');
        fs.mkdirSync(neighbour, { recursive: true });
        const r = F.npxCacheEntryFix(f, ctx());
        assert.strictEqual(r.ok, true, r.detail);
        assert.ok(!fs.existsSync(folder));
        assert.ok(fs.existsSync(neighbour));
        assert.deepStrictEqual([r.fetch.op, r.fetch.name, r.fetch.scope, r.fetch.what, r.fetch.argv], ['fetch', 'playwright-chrome', 'project', spec, ['npm', 'exec', '--yes', '--package', spec, '--', 'node', '-e', '0']]);
        assert.deepStrictEqual(r.fetch.env, { npm_config_before: '2026-11-10T23:59:59Z' }, 'the fetch resolves as the registration does');
        assert.deepStrictEqual(found(), [], 'read back');
        // a parent's server: the fetch reads it from the nearest parent's .mcp.json naming it, never a farther one it shadows
        fs.mkdirSync(folder, { recursive: true });
        const farther = { ...inherited, from: path.dirname(parentDir), entry: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.80'] }, shadowed: { scope: 'inherited', from: parentDir } };
        const ri = F.npxCacheEntryFix(fi, ctx([farther, inherited]));
        assert.strictEqual(ri.ok, true, ri.detail);
        assert.deepStrictEqual([ri.fetch.name, ri.fetch.scope, ri.fetch.from, ri.fetch.what], ['playwright-chrome', 'project', parentDir, spec]);
        assert.ok(!fs.existsSync(folder));
        // never a folder that is not an npx cache folder
        for (const bad of [w.project, path.join(cache, '_npx'), path.join(w.home, 'x', '0123456789abcdef')])
        {
            const no = F.npxCacheEntryFix({ ...f, proposal: { ...f.proposal, path: bad } }, ctx());
            assert.strictEqual(no.ok, false, bad);
            assert.match(no.detail, /not an npx cache folder/);
        }
        assert.ok(fs.existsSync(w.project) && fs.existsSync(neighbour));
    }
    finally { w.clean(); }
});

test('apply: npx-cache-entry removes the folder and hands the package to fetch.js; the restart waits for the fetch', () =>
{
    const fs = require('node:fs');
    const w = world();
    try
    {
        const spec = '@playwright/mcp@0.0.84';
        seed(w, 'playwright-chrome', 'user', { command: 'npx', args: ['-y', spec, '--browser', 'chrome', '--no-webmcp'], env: {} });
        const cache = path.join(w.home, '.npm');
        const folder = npxFolder(cache, spec);
        fs.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
        const lines = [];
        const res = fix.applyFixes(ctxOf(w, { machine: npmAt(cache) }), ['npx-cache-entry'], { tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        const text = lines.join('\n');
        assert.strictEqual(res.failed, null, text);
        assert.ok(!fs.existsSync(folder));
        assert.deepStrictEqual(res.applied.map((f) => f.id), ['npx-cache-entry']);
        assert.strictEqual(res.steps, 0, 'no registration is rewritten');
        assert.ok(res.fetchFile && fs.existsSync(res.fetchFile), text);
        const job = readJson(res.fetchFile);
        assert.deepStrictEqual(job.fetch.map((s) => [s.name, s.scope, s.what]), [['playwright-chrome', 'user', spec]]);
        assert.deepStrictEqual(job.check, ['playwright-chrome']);
        assert.match(text, /Fetch next, in the background/);
        assert.match(text, /fixed +npx-cache-entry on playwright-chrome/);
        assert.match(text, /Restart Claude Code.*after the fetch reports/);
        assert.deepStrictEqual(w.writes(), [['mcp', 'add-json', 'playwright-chrome', JSON.stringify({ command: 'npx', args: ['-y', spec, '--browser', 'chrome', '--no-webmcp'], env: {} }), '-s', 'user']], 'only the seed: the fix writes no registration');
    }
    finally { w.clean(); }
});

// ---- typescript-lsp-ts7 ---------------------------------------------------------------------------------------------

test('typescript-lsp-ts7: a global TypeScript 7 under the installed plugin is found, fixed with typescript@6 and read back', () =>
{
    const plugin = { id: 'typescript-lsp@claude-plugins-official', plugin: 'typescript-lsp', scope: 'project', enabled: true, rowId: 'typescript-lsp', alfredRetired: false };
    let installed = '7.0.2';
    const calls = [];
    const machine = noMachine({
        run: (cmd, args) =>
        {
            calls.push([cmd, ...args].join(' '));
            if (args[0] === 'ls') return { status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: installed } } }) };
            installed = '6.0.3';
            return { status: 0, stdout: '' };
        },
    });
    const ctx = ctxFor({ plugins: [plugin], machine });
    const [f] = detect(ctx).found;
    assert.strictEqual(f.id, 'typescript-lsp-ts7');
    assert.strictEqual(f.kind, 'machine');
    assert.match(f.found, /global typescript is 7\.0\.2/);
    const res = F.typescriptLspTs7Fix(f, ctx);
    assert.deepStrictEqual(res, { ok: true, detail: 'global typescript is now 6.0.3' });
    assert.ok(calls.includes('npm install -g typescript-language-server typescript@6'));
    assert.deepStrictEqual(detect(ctx).found, [], 'read back: the detector finds nothing now');
    // 6.x, no npm, no plugin, a disabled plugin: nothing
    assert.deepStrictEqual(detect(ctxFor({ plugins: [plugin], machine: noMachine({ run: () => ({ status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: '6.0.3' } } }) }) }) })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ plugins: [plugin], machine: noMachine() })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ machine: noMachine({ run: () => ({ status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: '7.0.2' } } }) }) }) })).found, []);
    assert.deepStrictEqual(detect(ctxFor({ plugins: [{ ...plugin, enabled: false }], machine: noMachine({ run: () => ({ status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: '7.0.2' } } }) }) }) })).found, []);
    // too old a Node: blocked, and says why
    installed = '7.0.2';
    const old = detect(ctxFor({ plugins: [plugin], machine: { ...machine, nodeVersion: '20.11.0' } })).found[0];
    assert.match(old.blocked, /needs Node 22\.22\.2/);
    // a failing install is reported, not swallowed
    const failing = { ...ctx, machine: noMachine({ run: (c, a) => (a[0] === 'ls' ? { status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: '7.0.2' } } }) } : { status: 1, stderr: 'EACCES: permission denied' }) }) };
    const r = F.typescriptLspTs7Fix(f, failing);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /EACCES/);
});

// ---- windows-mcp-one-per-desktop ------------------------------------------------------------------------------------

test('windows-mcp-one-per-desktop: two servers give one blocked finding naming both and how to drop each; one gives none; non-win32 gives none', () =>
{
    const wd = reg('windows-control', fresh('windows-control', 'win32'));
    const alfred = { id: 'windows-control@envoydev', plugin: 'windows-control', marketplace: 'envoydev', scope: 'user', enabled: true, rowId: null, alfredRetired: true };
    const two = (platform) => ctxFor({ platform, registrations: [wd], plugins: [alfred] });
    const mine = (d) => d.found.filter((f) => f.id === 'windows-mcp-one-per-desktop');
    const found = mine(detect(two('win32')));
    assert.strictEqual(found.length, 1);
    assert.match(found[0].found, /^2 windows-mcp servers start in this project: windows-desktop \(local\), windows-control@envoydev \(user\)/);
    assert.match(found[0].blocked, /claude plugin disable windows-control@envoydev --scope user/);
    assert.match(found[0].blocked, /\/preferred-tools:configure/);
    assert.match(found[0].blocked, /a stuck one recovers only in a new Claude Code session/);
    assert.strictEqual(mine(detect(two('win32'), 'windows-control')).length, 1, '--only by the tool finds it');
    assert.deepStrictEqual(F.windowsMcpOneDetect(ctxFor({ platform: 'win32', registrations: [wd] })), []);
    assert.deepStrictEqual(mine(detect(two('darwin'))), []);
});

test("windows-mcp-one-per-desktop: each owner's own drop line", () =>
{
    const wd = reg('windows-control', fresh('windows-control', 'win32'));
    const blockedWith = (other) => F.windowsMcpOneDetect(ctxFor({ platform: 'win32', project: '/proj', registrations: [wd, other] }))[0].blocked;
    const alfred = { name: 'windows-control', scope: 'local', entry: {}, rowId: null, route: null, own: true, alfredRetired: true };
    const parent = (r) => ({ ...r, scope: 'inherited', from: '/', approval: 'approved', shadowed: null });
    assert.match(blockedWith(alfred), /claude mcp remove windows-control -s local/);
    assert.match(blockedWith(parent(reg('windows-control', fresh('windows-control', 'win32'), { name: 'wd-parent' }))), /\/preferred-tools:configure \(Remove\), run in \.\./);
    assert.match(blockedWith(parent(alfred)), /claude mcp remove windows-control -s project, run in \.\./);
});

test('questions: only NOT APPLICABLE findings give no apply ask', () =>
{
    const advice = { id: 'windows-mcp-one-per-desktop', name: 'windows-desktop', scope: 'local', kind: 'registration', found: 'x', blocked: 'y' };
    assert.deepStrictEqual(fix.questions({ found: [advice], held: [] }), { choose: null, pick: [] });
    assert.deepStrictEqual(fix.questions({ found: [], held: [] }), { choose: null, pick: [] });
    const q = fix.questions({ found: [advice, { id: 'uvx-python', name: 'memory', scope: 'local', kind: 'registration', found: 'z' }], held: [] });
    assert.strictEqual(q.choose.question, '1 known problem found. Apply?');
});

// ---- narrowing and rendering ----------------------------------------------------------------------------------------

test('data-folder-ignore: in a git work tree git decides - the project\'s own ignore covers the folder, a .gitignore that leaves its data out does not', () =>
{
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const w = world();
    try
    {
        spawnSync('git', ['init', '-q'], { cwd: w.project });
        const pw = (root) => reg('playwright-chrome', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', root] }, { scope: 'project' });
        const found = (root) => F.dataFolderIgnoreDetect(ctxFor({ platform: process.platform, project: w.project, registrations: [pw(root)], machine: noMachine({ exists: (p) => fs.existsSync(p), run: C.realMachine().run }) }));
        // the project ignores .preferred-tools/: covered, though the folder has no .gitignore of its own
        fs.writeFileSync(path.join(w.project, '.gitignore'), '.preferred-tools/\n');
        assert.deepStrictEqual(found('.preferred-tools/playwright-chrome'), []);
        // a folder's own .gitignore that ignores only logs: its data is not covered, and the fix leaves the user's file
        const own = path.join(w.project, 'tools', 'pw');
        fs.mkdirSync(own, { recursive: true });
        fs.writeFileSync(path.join(own, '.gitignore'), '*.log\n');
        const [f] = found('tools/pw');
        assert.ok(f, 'a .gitignore that leaves the data out is a finding');
        assert.match(f.blocked, /tools\/pw\/\.gitignore .*does not ignore .*add \*/);
        // alfred-code's .alfred/.gitignore, when git reads it, covers .alfred/<name>
        fs.mkdirSync(path.join(w.project, '.alfred'));
        fs.writeFileSync(path.join(w.project, '.alfred', '.gitignore'), '*\n');
        assert.deepStrictEqual(found('.alfred/playwright-chrome'), []);
    }
    finally { w.clean(); }
});

test('fix detectors never return an inherited registration (data-folder-ignore, project-relative-path, mcp-order and helper-child-folder read the parents, in their own tests)', () =>
{
    const entry = fresh('serena');
    const stripped = { ...entry, env: { SERENA_HOME: entry.env.SERENA_HOME } };
    assert.deepStrictEqual(ids(detect(ctxFor({ registrations: [reg('serena', stripped)] })).found), ['serena-telemetry'], 'the same entry at local scope has a finding');
    assert.deepStrictEqual(detect(ctxFor({ registrations: [reg('serena', stripped, { scope: 'inherited' })] })).found, []);
});

test('--only narrows by fix id, tool or registration name; the table names the held row; nothing found says so', () =>
{
    const entry = fresh('serena');
    const stripped = { command: 'uvx', args: entry.args.filter((a, i, all) => a !== '--python' && all[i - 1] !== '--python'), env: {} };
    const ctx = ctxFor({ registrations: [reg('serena', stripped), reg('memory', { command: 'uvx', args: ['--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'] })] });
    assert.deepStrictEqual(ids(detect(ctx).found).sort(), ['serena-telemetry', 'uvx-python', 'uvx-python']);
    assert.strictEqual(detect(ctx, 'serena').found.length, 2);
    assert.strictEqual(detect(ctx, 'memory').found.length, 1);
    assert.strictEqual(detect(ctx, 'serena-telemetry').found.length, 1);
    assert.deepStrictEqual(detect(ctx, 'nope').found, []);
    const text = fix.render(detect(ctx));
    assert.match(text, /Known problems found \(3\):/);
    assert.match(text, /uvx-python +serena \(local\) +no --python/);
    assert.match(fix.render(detect(ctxFor({ platform: 'win32' }))), /^No known problem found\.\n\nHeld, not checked: serena-windows-ts-shim - left out by the user's ruling/);
});

test('the asks stay inside the AskUserQuestion limits: one Recommended, first; four options a question; four questions a call', () =>
{
    const mkFound = (n) => Array.from({ length: n }, (_, i) => ({ id: `fix-${i}`, name: `t${i}`, scope: 'local', kind: 'registration', found: 'x' }));
    for (const n of [1, 2, 4, 5, 9, 17])
    {
        const q = fix.questions({ found: mkFound(n), held: [] });
        const rec = q.choose.options.filter((o) => /\(Recommended\)$/.test(o.label));
        assert.strictEqual(rec.length, 1, 'exactly one Recommended');
        assert.strictEqual(q.choose.options[0], rec[0], 'and it is first');
        assert.ok(q.choose.options.length >= 2 && q.choose.options.length <= 4);
        assert.strictEqual(q.choose.options.some((o) => o.label === 'Pick which'), n > 1);
        for (const call of q.pick)
        {
            assert.ok(call.length >= 1 && call.length <= 4, `${call.length} questions in a call`);
            for (const question of call) assert.ok(question.options.length >= 2 || n % 4 === 1, 'a lone last option is allowed only as the remainder');
        }
        assert.strictEqual(q.pick.flat().flatMap((x) => x.options).length, n);
    }
    // a blocked finding is not offered
    const q = fix.questions({ found: [{ id: 'a', name: 'x', scope: 'local', kind: 'registration', found: 'f', blocked: 'no' }, { id: 'b', name: 'y', scope: 'local', kind: 'registration', found: 'f' }], held: [] });
    assert.deepStrictEqual(q.pick.flat().flatMap((x) => x.options).map((o) => o.label), ['b']);
});

// ---- applying, against the fake claude ------------------------------------------------------------------------------

function seed(w, name, scope, entry)
{
    const r = cli.run(['mcp', 'add-json', name, JSON.stringify(entry), '-s', scope], { cwd: w.project, env: w.env });
    assert.strictEqual(r.status, 0, r.stderr);
}
const ctxOf = (w, over = {}) => fix.makeCtx({ inv: inventory.buildInventory({ project: w.project, env: w.env }), env: w.env, machine: noMachine(), ...over });
const userEntry = (w, name) => account.readAccount(w.env, w.project).user[name];

test('apply: two fixes on one registration are ONE replace, from the entry as read - the user\'s pin and extra args survive', () =>
{
    const w = world();
    try
    {
        // the entry as the installer writes it on this machine, so the same two fixes apply on every OS
        const entry = fresh('serena', process.platform, process.arch);
        const theirs = {
            command: 'uvx',
            args: entry.args.filter((a, i, all) => a !== '--python' && all[i - 1] !== '--python').map((a) => (a === 'serena-agent@2.1.0' ? 'serena-agent@2.0.0' : a)).concat(['--verbose']),
            env: { SERENA_HOME: entry.env.SERENA_HOME },
        };
        seed(w, 'serena', 'user', theirs);
        const own = { command: 'node', args: ['mine.js'] };
        seed(w, 'my-own-server', 'user', own);
        const before = w.calls().length;
        const lines = [];
        const res = fix.applyFixes(ctxOf(w), ['all'], { tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        const mine = w.calls().slice(before).filter((a) => a[0] === 'mcp' && ['add-json', 'remove'].includes(a[1]));
        assert.deepStrictEqual(mine.map((a) => [a[1], a[2]]), [['remove', 'serena'], ['add-json', 'serena']], 'one remove and one add, nothing else touched');
        const now = userEntry(w, 'serena');
        // the row's minor, as this machine takes it: on Windows ARM64 the x64 build (windows-arm-python)
        const c = ctxOf(w);
        assert.deepStrictEqual(now.args.slice(0, 2), ['--python', E.pythonRequest({ python: '3.13' }, c, c.rules)]);
        assert.ok(now.args.includes('serena-agent@2.0.0') && now.args.includes('--verbose'));
        assert.strictEqual(now.env.SERENA_USAGE_REPORTING, 'false');
        assert.strictEqual(now.env.SERENA_HOME, entry.env.SERENA_HOME);
        assert.deepStrictEqual(userEntry(w, 'my-own-server'), own, 'a registration that matches no row is never touched');
        assert.deepStrictEqual(res.applied.map((f) => f.id).sort(), ['serena-telemetry', 'uvx-python']);
        assert.deepStrictEqual(res.remaining, []);
        assert.match(lines.join('\n'), /fixed +uvx-python on serena \(user\)/);
        assert.match(lines.join('\n'), /Restart Claude Code/);
        // a second run finds nothing and writes nothing
        const again = w.calls().length;
        const lines2 = [];
        fix.applyFixes(ctxOf(w), ['all'], { log: (...a) => lines2.push(a.join(' ')) });
        assert.match(lines2.join('\n'), /Nothing to apply/);
        assert.strictEqual(w.calls().slice(again).filter((a) => a[0] === 'mcp' && ['add-json', 'remove'].includes(a[1])).length, 0);
    }
    finally { w.clean(); }
});

test('apply: picked ids only; --only narrows to one registration; an unknown id fails before anything is written', () =>
{
    const w = world();
    try
    {
        const bare = { command: 'uvx', args: ['--python', '3.13', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: {} };
        seed(w, 'serena', 'user', bare);
        seed(w, 'serena-two', 'user', bare);
        const before = w.calls().length;
        const res = fix.applyFixes(ctxOf(w), ['serena-telemetry'], { only: 'serena-two', tmp: path.join(w.dir, 'tmp'), log: () => {} });
        assert.strictEqual(res.failed, null);
        assert.strictEqual(userEntry(w, 'serena-two').env.SERENA_USAGE_REPORTING, 'false');
        assert.strictEqual(userEntry(w, 'serena').env.SERENA_USAGE_REPORTING, undefined, 'the other registration is left');
        const bad = fix.applyFixes(ctxOf(w), ['no-such-fix'], { log: () => {} });
        assert.match(bad.failed, /unknown fix id: no-such-fix/);
        assert.ok(w.calls().slice(before).filter((a) => a[1] === 'add-json').length === 1);
        // a held row cannot be picked into a change
        const held = fix.applyFixes(ctxOf(w, { platform: 'win32' }), ['serena-windows-ts-shim'], { log: () => {} });
        assert.strictEqual(held.applied.length, 0);
    }
    finally { w.clean(); }
});

test('an advice row never reaches a fix: a finding it returns unblocked is blocked by detectAll', () =>
{
    const w = world();
    try
    {
        const entry = fresh('serena', process.platform, process.arch);
        seed(w, 'serena', 'user', { ...entry, env: { SERENA_HOME: entry.env.SERENA_HOME } });
        // a future advice row whose detector forgot `blocked`
        const advice = { ...catalog.fixes.find((f) => f.id === 'serena-telemetry'), advice: true, fix: null };
        const ctx = { ...ctxOf(w), catalog: { ...catalog, fixes: [advice] } };
        const found = fix.detectAll(ctx).found;
        assert.deepStrictEqual(found.map((f) => [f.id, f.blocked]), [['serena-telemetry', 'advice only - nothing here is applied']]);
        assert.deepStrictEqual(fix.questions(fix.detectAll(ctx)), { choose: null, pick: [] });
        const before = w.writes().length;
        const lines = [];
        const res = fix.applyFixes(ctx, ['all'], { log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        assert.strictEqual(res.steps, 0);
        assert.ok(lines.some((l) => l.startsWith('skipped serena-telemetry')), lines.join('\n'));
        assert.deepStrictEqual(w.writes().slice(before), []);
    }
    finally { w.clean(); }
});

test('apply: a blocked finding, and one that needs an answer, are named and skipped - never guessed', () =>
{
    const w = world();
    try
    {
        const old = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.50', '--browser', 'chrome'], env: {} };
        seed(w, 'playwright-chrome', 'user', old);
        const before = w.calls().length;
        const lines = [];
        const res = fix.applyFixes(ctxOf(w), ['playwright-webmcp'], { log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.skipped.length, 1);
        assert.match(lines.join('\n'), /skipped playwright-webmcp on playwright-chrome \(user\): pinned @0\.0\.50 is older than 0\.0\.83/);
        assert.strictEqual(w.calls().slice(before).filter((a) => a[1] === 'add-json').length, 0);
        assert.deepStrictEqual(userEntry(w, 'playwright-chrome'), old);

        const spaced = ctxFor({ platform: 'win32', home: 'C:\\Users\\Jo Doe', registrations: [reg('serena', { command: 'uvx', args: ['--python', '3.13'], env: { SERENA_HOME: 'C:\\Users\\Jo Doe\\.serena' } }, { scope: 'user' })] });
        const out = [];
        const r2 = fix.applyFixes({ ...spaced, env: w.env, inv: { ...spaced.inv, project: w.project } }, ['serena-windows-home'], { log: (...a) => out.push(a.join(' ')) });
        assert.match(out.join('\n'), /needs --input serenaHome=<value>/);
        assert.strictEqual(r2.applied.length, 0);
    }
    finally { w.clean(); }
});

test('apply: a failing add puts the old registration back; if that fails too, the exact restore line is printed; neither prints the restart line', () =>
{
    const w = world();
    try
    {
        const bare = { command: 'uvx', args: ['--python', '3.13', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: {} };
        seed(w, 'serena', 'user', bare);
        // only the NEW entry (it carries SERENA_USAGE_REPORTING) is refused: the old one is re-added
        let lines = [];
        let res = fix.applyFixes(ctxOf(w, { env: { ...w.env, FAKE_CLAUDE_FAIL: 'SERENA_USAGE_REPORTING' } }), ['serena-telemetry'], { tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.ok(res.failed, lines.join('\n'));
        assert.deepStrictEqual(userEntry(w, 'serena'), bare, 'the registration is back exactly as it was');
        assert.ok(!lines.join('\n').includes('Restart Claude Code'));
        // every add is refused: nothing can be put back, and the user is handed the line that does it
        lines = [];
        res = fix.applyFixes(ctxOf(w, { env: { ...w.env, FAKE_CLAUDE_FAIL: 'add-json' } }), ['serena-telemetry'], { tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.ok(res.failed);
        assert.match(lines.join('\n'), /RESTORE BY HAND: claude mcp add-json serena '\{"command":"uvx"/);
        assert.ok(!lines.join('\n').includes('Restart Claude Code'));
    }
    finally { w.clean(); }
});

test('the machine fix runs after the registration edits and is read back; its failure stops the run', () =>
{
    const w = world();
    try
    {
        const plugin = { id: 'typescript-lsp@claude-plugins-official', plugin: 'typescript-lsp', scope: 'project', enabled: true, rowId: 'typescript-lsp', alfredRetired: false };
        let v = '7.0.2';
        const machine = noMachine({ run: (c, a) => { if (a[0] === 'ls') return { status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: v } } }) }; v = '6.0.3'; return { status: 0, stdout: '' }; } });
        const base = ctxOf(w, { machine });
        const ctx = { ...base, inv: { ...base.inv, plugins: [plugin] } };
        const lines = [];
        const res = fix.applyFixes(ctx, ['typescript-lsp-ts7'], { log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        assert.match(lines.join('\n'), /ok +typescript-lsp-ts7: global typescript is now 6\.0\.3/);
    }
    finally { w.clean(); }
});

test('a fix that only writes a data folder\'s .gitignore asks for no restart; the language server fix still does', () =>
{
    const fs = require('node:fs');
    const w = world();
    try
    {
        seed(w, 'playwright-chrome', 'project', { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '.preferred-tools/playwright-chrome'] });
        const lines = [];
        const res = fix.applyFixes(ctxOf(w, { machine: noMachine({ exists: (p) => fs.existsSync(p), run: C.realMachine().run }) }), ['data-folder-ignore'], { log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        assert.match(lines.join('\n'), /fixed +data-folder-ignore/);
        assert.ok(!lines.join('\n').includes('Restart Claude Code'), lines.join('\n'));
        // the language server fix: a restart, as before
        const plugin = { id: 'typescript-lsp@claude-plugins-official', plugin: 'typescript-lsp', scope: 'project', enabled: true, rowId: 'typescript-lsp', alfredRetired: false };
        let v = '7.0.2';
        const machine = noMachine({ run: (c, a) => { if (a[0] === 'ls') return { status: 0, stdout: JSON.stringify({ dependencies: { typescript: { version: v } } }) }; v = '6.0.3'; return { status: 0, stdout: '' }; } });
        const base = ctxOf(w, { machine });
        const ts = [];
        fix.applyFixes({ ...base, inv: { ...base.inv, plugins: [plugin] } }, ['typescript-lsp-ts7'], { log: (...a) => ts.push(a.join(' ')) });
        assert.match(ts.join('\n'), /Restart Claude Code/);
    }
    finally { w.clean(); }
});

// ---- the CLI --------------------------------------------------------------------------------------------------------

test('CLI: --detect and --questions print; --apply applies; bad arguments exit 2', () =>
{
    const w = world();
    try
    {
        const bare = { command: 'uvx', args: ['--python', '3.13', '--from', 'serena-agent@2.1.0', 'serena', 'start-mcp-server'], env: {} };
        seed(w, 'serena', 'user', bare);
        let text = '';
        const out = (s) => { text += `${s}\n`; };
        assert.strictEqual(fix.main(['--detect', '--project', w.project], { env: w.env, out, machine: noMachine() }), 0);
        assert.match(text, /serena-telemetry +serena \(user\)/);
        text = '';
        assert.strictEqual(fix.main(['--questions', '--project', w.project], { env: w.env, out, machine: noMachine() }), 0);
        assert.strictEqual(JSON.parse(text).choose.options[0].label, 'Apply all found (Recommended)');
        text = '';
        assert.strictEqual(fix.main(['--apply', 'serena-telemetry', '--project', w.project, '--tmp', path.join(w.dir, 'tmp')], { env: w.env, out, machine: noMachine() }), 0);
        assert.strictEqual(userEntry(w, 'serena').env.SERENA_USAGE_REPORTING, 'false');
        for (const bad of [[], ['--detect', '--apply', 'x'], ['--bogus'], ['--apply'], ['--detect', '--only'], ['--input', 'novalue', '--detect'], ['--detect', '--project', 'a', '--project', 'b']])
        {
            text = '';
            assert.strictEqual(fix.main(bad, { env: w.env, out, machine: noMachine() }), 2, JSON.stringify(bad));
            assert.match(text, /^fix: /);
        }
        const missing = readJson(account.accountFile(w.env));
        assert.ok(missing.mcpServers.serena, 'the registration is still there after all of it');
    }
    finally { w.clean(); }
});

// ---- the 0.2.0 key rows (D7): key-to-helper, helper-missing, helper-stale, root-ignore, token-sync on stdio -----------

const fsx = require('node:fs');
const cryptox = require('node:crypto');
const { spawnSync: spawnx } = require('node:child_process');
const { writeJson, files } = require('./helpers.js');
const rootsLib = require('../scripts/roots.js');
const SK = 'SENTRY_ACCESS_TOKEN';
const GK = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const SENTRY = (value) => ({ command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { [SK]: value } });
const GITHUB = (value) => ({ command: 'docker', args: ['run', '-i', '--rm', '-e', GK, 'ghcr.io/github/github-mcp-server:v2.1.0', 'stdio'], env: { [GK]: value } });
const HOSTED_GH = (auth) => ({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: auth } });
const HOSTED_SENTRY = (auth) => ({ type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: auth } });
const hexv = (p) => `${p}-${cryptox.randomBytes(10).toString('hex')}`;
const put = (file, text) => { fsx.mkdirSync(path.dirname(file), { recursive: true }); fsx.writeFileSync(file, text); };
const secretsAt = (root, pairs) => put(path.join(root, '.mcps-secrets'), Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
const ptRoot = (w) => path.join(w.project, '.preferred-tools');
const homeRoot = (w) => path.join(w.home, '.preferred-tools');
const localEntry = (w, name) => account.readAccount(w.env, w.project).local[name];
const ctxData = (w, data) => fix.makeCtx({ inv: inventory.buildInventory({ project: w.project, env: w.env, data }), env: w.env, machine: noMachine(), data });
const logged = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')), text: () => lines.join('\n') }; };
const gitInit = (dir) => { fsx.mkdirSync(dir, { recursive: true }); assert.strictEqual(spawnx('git', ['init', '-q', dir]).status, 0); };
const HV = require('../scripts/mcp-headers.js').HELPER_VERSION;
const helperAt = (root, number, extra = '') => put(path.join(root, 'mcp-headers.js'), rootsLib.helperSource().replace(/^\/\/ preferred-tools mcp-headers \d+/, `// preferred-tools mcp-headers ${number}`) + extra);
const shownOf = (d) => `${fix.render(d)}${JSON.stringify(d)}`;

test('key-to-helper: a ${VAR} filled in the chain is moved to the helper under that name', () =>
{
    const w = world();
    try
    {
        const v = hexv('gh');
        seed(w, 'github', 'local', HOSTED_GH('Bearer ${ACME_GH}'));
        secretsAt(ptRoot(w), { ACME_GH: v });
        const d = detect(ctxOf(w));
        const [f] = d.found.filter((x) => x.id === 'key-to-helper');
        assert.deepStrictEqual([f.name, f.scope, f.keyName, Boolean(f.blocked)], ['github', 'local', 'ACME_GH', false]);
        assert.ok(!shownOf(d).includes(v), 'the detection names the key, never its value');
        const l = logged();
        const res = fix.applyFixes(ctxOf(w), ['key-to-helper'], { tmp: path.join(w.dir, 'tmp'), log: l.log });
        assert.strictEqual(res.failed, null, l.text());
        const e = localEntry(w, 'github');
        assert.strictEqual(e.headers, undefined, 'the header is gone');
        assert.strictEqual(e.headersHelper, `node ${path.join(ptRoot(w), 'mcp-headers.js')} ACME_GH Bearer`);
        assert.strictEqual(fsx.readFileSync(path.join(ptRoot(w), 'mcp-headers.js'), 'utf8'), rootsLib.helperSource(), 'R9: the helper is written with it');
        assert.match(l.text(), new RegExp(`root ${ptRoot(w).replace(/[\\.]/g, '\\$&')}`), 'the root is named');
        assert.deepStrictEqual(res.applied.map((x) => x.id), ['key-to-helper']);
        assert.ok(!l.text().includes(v));
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((x) => x.id === 'key-to-helper'), []);
    }
    finally { w.clean(); }
});

test('key-to-helper: a ${VAR} not filled is blocked and names the old file that holds it', () =>
{
    const w = world();
    try
    {
        seed(w, 'github', 'local', HOSTED_GH(`Bearer \${${GK}}`));
        put(path.join(w.project, '.preferred-tools', '.secrets'), `${GK}=${hexv('old')}\n`);
        const [f] = detect(ctxOf(w)).found.filter((x) => x.id === 'key-to-helper');
        const chain0 = path.join(ptRoot(w), '.mcps-secrets');
        assert.strictEqual(f.blocked, `put ${GK}'s value in ${chain0}, then run /preferred-tools:fix; ${GK} is in ${path.join(w.project, '.preferred-tools', '.secrets')}, which preferred-tools no longer reads`);
        const res = fix.applyFixes(ctxOf(w), ['key-to-helper'], { log: () => {} });
        assert.deepStrictEqual(res.skipped.map((x) => x.id), ['key-to-helper']);
        assert.deepStrictEqual(localEntry(w, 'github').headers, { Authorization: `Bearer \${${GK}}` }, 'never moved to a helper that would send no key');
    }
    finally { w.clean(); }
});

test('key-to-helper: a literal equal to a filled value applies with that name; one equal to none is blocked; neither prints the literal', () =>
{
    const w = world();
    try
    {
        const [v1, v2] = [hexv('sentry'), hexv('nobody')];
        seed(w, 'sentry', 'user', HOSTED_SENTRY(`Bearer ${v1}`));
        seed(w, 'github', 'local', HOSTED_GH(`Bearer ${v2}`));
        secretsAt(homeRoot(w), { MY_SENTRY: v1 });
        const d = detect(ctxOf(w));
        const s = d.found.find((x) => x.id === 'key-to-helper' && x.name === 'sentry');
        assert.deepStrictEqual([s.keyName, Boolean(s.blocked)], ['MY_SENTRY', false]);
        const g = d.found.find((x) => x.id === 'key-to-helper' && x.name === 'github');
        assert.match(g.blocked, /^the key in this registration matches no name in .*\.mcps-secrets.*: put the working key there under a name, then run \/preferred-tools:fix$/);
        for (const v of [v1, v2]) assert.ok(!shownOf(d).includes(v), 'no literal in the report');
        const l = logged();
        const res = fix.applyFixes(ctxOf(w), ['key-to-helper'], { tmp: path.join(w.dir, 'tmp'), log: l.log });
        assert.strictEqual(res.failed, null, l.text());
        const e = userEntry(w, 'sentry');
        assert.strictEqual(e.headers, undefined);
        assert.strictEqual(e.headersHelper, `node ${path.join(homeRoot(w), 'mcp-headers.js')} MY_SENTRY Sentry-Bearer`);
        assert.deepStrictEqual(localEntry(w, 'github').headers, { Authorization: `Bearer ${v2}` }, 'blocked: unchanged');
        for (const v of [v1, v2]) assert.ok(!l.text().includes(v), 'nothing printed holds a literal');
        for (const file of files(path.join(w.dir, 'tmp'))) for (const v of [v1, v2]) assert.ok(!fsx.readFileSync(file, 'utf8').includes(v), path.basename(file));
    }
    finally { w.clean(); }
});

test('helper-missing writes the helper; helper-stale rewrites a lower number, names a hand edit, and leaves a higher number with a note', () =>
{
    const w = world();
    try
    {
        const file = path.join(ptRoot(w), 'mcp-headers.js');
        seed(w, 'github', 'local', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${file} ${GK} Bearer` });
        const [m] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-missing');
        assert.deepStrictEqual([m.name, m.kind, Boolean(m.blocked)], [file, 'machine', false]);
        const l = logged();
        assert.strictEqual(fix.applyFixes(ctxOf(w), ['helper-missing'], { log: l.log }).failed, null, l.text());
        assert.strictEqual(fsx.readFileSync(file, 'utf8'), rootsLib.helperSource());
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((x) => /^helper-/.test(x.id)), []);
        assert.doesNotMatch(l.text(), /Restart Claude Code/, 'the helper runs at each connect: no restart');

        helperAt(ptRoot(w), 0);
        const [lower] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.match(lower.found, new RegExp(`helper 0 - this plugin's is ${HV}`));
        fix.applyFixes(ctxOf(w), ['helper-stale'], { log: () => {} });
        assert.strictEqual(fsx.readFileSync(file, 'utf8'), rootsLib.helperSource());

        helperAt(ptRoot(w), HV, '// mine\n');
        const [edited] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.match(edited.found, /changed since preferred-tools wrote it/);
        assert.ok(!edited.blocked, 'a hand edit is rewritten on the confirmed plan');

        helperAt(ptRoot(w), HV + 1);
        const [higher] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.strictEqual(higher.blocked, `mcp-headers.js in ${ptRoot(w)} is newer than this plugin - update preferred-tools`);
        fix.applyFixes(ctxOf(w), ['helper-stale'], { log: () => {} });
        assert.match(fsx.readFileSync(file, 'utf8'), new RegExp(`^// preferred-tools mcp-headers ${HV + 1}`), 'never rewritten');
    }
    finally { w.clean(); }
});

test('helper-stale never rewrites a file with no preferred-tools number line: it is blocked and named', () =>
{
    const w = world();
    try
    {
        const file = path.join(ptRoot(w), 'mcp-headers.js');
        seed(w, 'github', 'local', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${file} ${GK} Bearer` });
        const mine = "#!/usr/bin/env node\nconsole.log('{}');\n";
        put(file, mine);
        const [f] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.strictEqual(f.blocked, `${file} has no preferred-tools number line - it is not this plugin's helper, and fix never overwrites it: rename yours, or delete it and run /preferred-tools:fix`);
        fix.applyFixes(ctxOf(w), ['helper-stale'], { log: () => {} });
        assert.strictEqual(fsx.readFileSync(file, 'utf8'), mine, 'left as it is');
    }
    finally { w.clean(); }
});

test('helper-stale finds nothing for a CRLF copy of the same helper', () =>
{
    const w = world();
    try
    {
        const file = path.join(ptRoot(w), 'mcp-headers.js');
        seed(w, 'github', 'local', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${file} ${GK} Bearer` });
        put(file, rootsLib.helperSource().replace(/\n/g, '\r\n'));
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((x) => /^helper-/.test(x.id)), []);
    }
    finally { w.clean(); }
});

test('root-ignore covers a project or global root inside a git work tree: appends the missing lines to a 0.1.x .gitignore holding *, so mcp-headers.js is no longer ignored, and blocks when another .gitignore re-includes .mcps-secrets', () =>
{
    const w = world();
    try
    {
        gitInit(w.project);
        gitInit(w.home);
        secretsAt(ptRoot(w), { A: '' });
        put(path.join(ptRoot(w), '.gitignore'), '*\n');
        secretsAt(homeRoot(w), { B: '' });
        const found = detect(ctxOf(w)).found.filter((x) => x.id === 'root-ignore');
        assert.deepStrictEqual(found.map((f) => [f.name, f.kind, Boolean(f.blocked)]), [[ptRoot(w), 'machine', false], [homeRoot(w), 'machine', false]]);
        assert.match(found[0].found, /git ignores .*mcp-headers\.js, which a project-scope server needs committed/);
        assert.match(found[1].found, /git would commit .*\.mcps-secrets/);
        const l = logged();
        const res = fix.applyFixes(ctxOf(w), ['root-ignore'], { log: l.log });
        assert.strictEqual(res.failed, null, l.text());
        assert.strictEqual(fsx.readFileSync(path.join(ptRoot(w), '.gitignore'), 'utf8'), '*\n!.gitignore\n!mcp-headers.js\n', 'appended, never rewritten');
        assert.strictEqual(fsx.readFileSync(path.join(homeRoot(w), '.gitignore'), 'utf8'), rootsLib.GITIGNORE);
        assert.strictEqual(rootsLib.gitIgnores(path.join(ptRoot(w), 'mcp-headers.js')), false);
        assert.strictEqual(rootsLib.gitIgnores(path.join(homeRoot(w), '.mcps-secrets')), true);
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((x) => x.id === 'root-ignore'), []);
        assert.doesNotMatch(l.text(), /Restart Claude Code/);

        // a later line re-includes the key file: the plugin's lines are all there, so appending cannot help
        fsx.appendFileSync(path.join(ptRoot(w), '.gitignore'), '!.mcps-secrets\n');
        const [b] = detect(ctxOf(w)).found.filter((x) => x.id === 'root-ignore');
        assert.match(b.blocked, /re-includes \.mcps-secrets/);
    }
    finally { w.clean(); }
});

test('root-ignore blocks a helper gap no appended line can close - a .gitignore above excludes the root - and names the line to remove', () =>
{
    const w = world();
    try
    {
        gitInit(w.project);
        put(path.join(w.project, '.gitignore'), '.preferred-tools/\n');
        put(path.join(ptRoot(w), '.gitignore'), rootsLib.GITIGNORE);
        secretsAt(ptRoot(w), { [GK]: '' });
        helperAt(ptRoot(w), HV);
        seed(w, 'github', 'project', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node .preferred-tools/mcp-headers.js ${GK} Bearer` });
        const [f] = detect(ctxOf(w)).found.filter((x) => x.id === 'root-ignore');
        assert.ok(f, 'found');
        assert.strictEqual(f.blocked, `a .gitignore above excludes ${ptRoot(w)} - remove that line (git check-ignore -v ${ptRoot(w)} names it): git never re-includes a file inside an excluded folder`);
    }
    finally { w.clean(); }
});

test('root-ignore finds nothing for a root outside a git work tree', () =>
{
    const w = world();
    try
    {
        secretsAt(ptRoot(w), { A: '' });
        assert.strictEqual(rootsLib.gitIgnores(path.join(ptRoot(w), '.mcps-secrets')), null, 'the world is outside any work tree');
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((x) => x.id === 'root-ignore'), []);
    }
    finally { w.clean(); }
});

test('root-ignore in a named root holding the user\'s files appends .mcps-secrets and preferred-tools.json, never *', () =>
{
    const w = world();
    try
    {
        gitInit(w.project);
        const named = path.join(w.project, 'tools');
        put(path.join(named, 'notes.md'), 'mine\n');
        secretsAt(named, { A: '' });
        const data = path.join(w.dir, 'data');
        writeJson(path.join(data, 'roots.json'), { version: 1, global: null, projects: { [rootsLib.mapKey(w.project)]: named } });
        const [f] = detect(ctxData(w, data)).found.filter((x) => x.id === 'root-ignore');
        assert.strictEqual(f.name, named);
        const l = logged();
        assert.strictEqual(fix.applyFixes(ctxData(w, data), ['root-ignore'], { log: l.log }).failed, null, l.text());
        assert.strictEqual(fsx.readFileSync(path.join(named, '.gitignore'), 'utf8'), '.mcps-secrets\npreferred-tools.json\n');
        assert.strictEqual(rootsLib.gitIgnores(path.join(named, 'notes.md')), false, 'the user\'s files stay visible to git');
        assert.strictEqual(rootsLib.gitIgnores(path.join(named, '.mcps-secrets')), true);
    }
    finally { w.clean(); }
});

test('token-sync checks stdio routes only, from the stdio chain, by any filled name', () =>
{
    const w = world();
    try
    {
        const [v1, v2, v3] = [hexv('one'), hexv('two'), hexv('three')];
        seed(w, 'sentry', 'local', SENTRY(v1));
        seed(w, 'github', 'local', HOSTED_GH(`Bearer ${hexv('hosted')}`));
        const ts = () => detect(ctxOf(w)).found.filter((x) => x.id === 'token-sync');
        secretsAt(homeRoot(w), { ANY_NAME: v1 });
        assert.deepStrictEqual(ts(), [], 'held by a filled name in the global root, the second file of the local chain');
        put(path.join(w.project, '.preferred-tools', '.secrets'), `${SK}=${v3}\n`);
        secretsAt(homeRoot(w), { ANY_NAME: v2 });
        const [f] = ts();
        assert.deepStrictEqual([f.name, f.scope, Boolean(f.blocked)], ['sentry', 'local', true], 'the default name is filled nowhere in the chain: the old file is not read');
        assert.strictEqual(f.blocked, "pick the key's name with /preferred-tools:configure");
        assert.match(f.found, /matches no name in .*\.mcps-secrets/);
        secretsAt(ptRoot(w), { [SK]: v3 });
        const [g] = ts();
        assert.ok(!g.blocked);
        const l = logged();
        assert.strictEqual(fix.applyFixes(ctxOf(w), ['token-sync'], { tmp: path.join(w.dir, 'tmp'), log: l.log }).failed, null, l.text());
        assert.strictEqual(localEntry(w, 'sentry').env[SK], v3, 'the default name\'s value');
        assert.deepStrictEqual(ts(), []);
        // a ${VAR} left by 0.1.x takes the value of the name it holds
        seed(w, 'sentry-b', 'local', SENTRY('${ANY_NAME}'));
        const [p] = ts();
        assert.match(p.found, /holds \$\{ANY_NAME\} while .*\.mcps-secrets has the key/);
        fix.applyFixes(ctxOf(w), ['token-sync'], { only: 'sentry-b', tmp: path.join(w.dir, 'tmp'), log: l.log });
        assert.strictEqual(localEntry(w, 'sentry-b').env[SK], v2);
        for (const v of [v1, v2, v3]) assert.ok(!`${l.text()}${shownOf(detect(ctxOf(w)))}`.includes(v), 'no value printed');
    }
    finally { w.clean(); }
});

test('token-sync blocks an empty stdio key and never writes the default name\'s value', () =>
{
    const w = world();
    try
    {
        const v = hexv('gh');
        seed(w, 'github', 'local', GITHUB(''));
        secretsAt(ptRoot(w), { ACME_GITHUB_TOKEN: '', [GK]: v });
        const [f] = detect(ctxOf(w)).found.filter((x) => x.id === 'token-sync');
        assert.strictEqual(f.blocked, "pick the key's name with /preferred-tools:configure");
        const before = fsx.readFileSync(account.accountFile(w.env), 'utf8');
        const res = fix.applyFixes(ctxOf(w), ['token-sync'], { log: () => {} });
        assert.deepStrictEqual(res.skipped.map((x) => x.id), ['token-sync']);
        assert.strictEqual(fsx.readFileSync(account.accountFile(w.env), 'utf8'), before, 'the account file unchanged');
        assert.strictEqual(localEntry(w, 'github').env[GK], '');
    }
    finally { w.clean(); }
});

test('fix notes an untrusted declaring folder', () =>
{
    const helperReg = (scope) => reg('github', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: 'node /proj/.preferred-tools/mcp-headers.js X Bearer' }, { scope, route: 'remote' });
    const at = (trusted, scope) => { const ctx = ctxFor({ registrations: [helperReg(scope)] }); ctx.inv.trusted = trusted; return detect(ctx); };
    const d = at(false, 'local');
    assert.deepStrictEqual(d.notes, ['github (local): accept the trust dialog the next time Claude Code starts in /proj - until then the server connects without its key']);
    assert.match(fix.render(d), /note: github \(local\): accept the trust dialog/);
    assert.deepStrictEqual(at(true, 'local').notes, []);
    assert.deepStrictEqual(at(false, 'user').notes, [], 'a global helper needs no folder trust');
    assert.ok(!at(false, 'local').found.some((f) => /trust/.test(f.id)), 'not a fix');
});

test('expandVars: ${NAME} from the environment, ${NAME:-fallback} when unset, null when a bare name is unset', () => {
    const C = require('../scripts/fixes/common.js');
    assert.strictEqual(C.expandVars('${A}\\x', { A: 'C:\\a' }), 'C:\\a\\x');
    assert.strictEqual(C.expandVars('${B:-C:\\b}', {}), 'C:\\b');
    assert.strictEqual(C.expandVars('${B:-C:\\b}', { B: 'D:\\d' }), 'D:\\d');
    assert.strictEqual(C.expandVars('${MISSING}\\x', {}), null);
    assert.strictEqual(C.expandVars('plain', {}), 'plain');
});

test('one ${VAR} expander, Claude Code\'s rule (2.1.322): a variable set to empty is empty, the fallback only when unset - fix and fetch agree', () => {
    const C = require('../scripts/fixes/common.js');
    const fetch = require('../scripts/fetch.js');
    assert.strictEqual(E.expandVars('${B:-C:\\b}', { B: '' }).value, '');
    assert.deepStrictEqual(E.expandVars('${A}/${MISSING}', { A: 'a' }), { value: 'a/${MISSING}', unset: ['MISSING'] });
    assert.strictEqual(C.expandVars('${B:-C:\\b}', { B: '' }), '', 'set to empty: no fallback');
    assert.strictEqual(C.expandVars('${A}', { A: '' }), '', 'set to empty: set');
    assert.strictEqual(C.firstUnset('${A}', { A: '' }), null);
    assert.strictEqual(fetch.expand('${B:-x}', { B: '' }), C.expandVars('${B:-x}', { B: '' }));
    assert.strictEqual(fetch.expand('${B:-x}', {}), 'x');
});

// ---- a registration left on its own (spec D6) --------------------------------------------------------------------------
test('fix: a registration on its own is not checked and is listed once', () =>
{
    const direct = { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4'], env: { npm_config_before: '2026-10-20T23:59:59Z' } };
    const r = reg('context7', direct, { name: 'context7' });
    assert.deepStrictEqual(ids(detect(ctxFor({ platform: 'win32', registrations: [r] })).found), ['windows-npx-cmd']);
    const own = detect(ctxFor({ platform: 'win32', registrations: [{ ...r, choice: 'own' }, { ...r, name: 'c7-managed', choice: 'manage' }] }));
    assert.deepStrictEqual(own.found.map((f) => [f.id, f.name]), [['windows-npx-cmd', 'c7-managed']], 'only the one on its own is left out');
    assert.deepStrictEqual(own.own, [{ name: 'context7', scope: 'local' }]);
    const text = fix.render(own);
    assert.deepStrictEqual(text.split('\n').filter((l) => l.includes('on its own - not checked')), ['context7 (local): on its own - not checked']);
    assert.deepStrictEqual(detect(ctxFor({ platform: 'win32', registrations: [r] })).own, []);
});

// ---- 0.3.0: project scope holds this machine's absolute paths (F7, Optional 3) ----------------------------------------

test('serena-windows-home at project scope: an absolute bad home is fixed in place; a spaced root says pick a space-free folder', () =>
{
    const homes = (ctx) => detect(ctx).found.filter((f) => f.id === 'serena-windows-home');
    const at = (home, extra = {}) => ctxFor({ platform: 'win32', ...extra, registrations: [reg('serena', { command: 'uvx', args: ['--python', '3.13'], env: home === undefined ? {} : { SERENA_HOME: home } }, { scope: 'project' })] });
    let [f] = homes(at('C:/work/shop/.preferred-tools/serena'));
    assert.deepStrictEqual(f.proposal, { SERENA_HOME: 'C:\\work\\shop\\.preferred-tools\\serena' });
    assert.ok(!f.blocked);
    [f] = homes(at(undefined, { home: 'C:\\Users\\Jo Doe' }));
    assert.ok(f.blocked.includes('pick a space-free folder with /preferred-tools:configure, Location'), f.blocked);
    // a ${VAR} value is project-relative-path's to convert
    assert.deepStrictEqual(homes(at('${USERPROFILE}/.serena', { env: { USERPROFILE: 'C:\\Users\\dev' } })), []);
});

test('appium-sdk-env at project scope finds and proposes the SDK homes as at local scope', () =>
{
    const appium = fresh('appium', 'darwin', 'x64', 'project');
    const machine = noMachine({ exists: (p) => ['/Users/dev/Library/Android/sdk', '/opt/jdk-21', '/opt/jdk-21/bin/java'].includes(p), run: (cmd) => (cmd === '/usr/libexec/java_home' ? { status: 0, stdout: '/opt/jdk-21\n' } : { status: 1 }) });
    const [f] = detect(ctxFor({ platform: 'darwin', home: '/Users/dev', machine, registrations: [reg('appium', appium, { name: 'appium-mcp', scope: 'project' })] })).found.filter((x) => x.id === 'appium-sdk-env');
    assert.deepStrictEqual(f.proposal, { ANDROID_HOME: '/Users/dev/Library/Android/sdk', JAVA_HOME: '/opt/jdk-21' });
    assert.ok(!f.blocked);
    // a machine path there is kept, not taken out
    const held = { ...appium, env: { ...appium.env, ANDROID_HOME: '/opt/sdk', JAVA_HOME: '/opt/jdk' } };
    assert.deepStrictEqual(detect(ctxFor({ platform: 'darwin', home: '/Users/dev', env: { ANDROID_HOME: '/opt/sdk', JAVA_HOME: '/opt/jdk' }, machine, registrations: [reg('appium', held, { name: 'appium-mcp', scope: 'project' })] })).found.filter((x) => x.id === 'appium-sdk-env'), []);
});

// ---- 0.3.0: 0.2.0's relative project paths, the .mcp.json order and a parent's helper (F7, F8, F3a) -------------------

const asks = require('../scripts/asks.js');
const existingLib = require('../scripts/existing.js');
const GH = { type: 'http', url: 'https://api.githubcopilot.com/mcp/' };
const C7 = { type: 'http', url: 'https://mcp.context7.com/mcp' };
const ctxIn = (w, dir, machine = noMachine()) => fix.makeCtx({ inv: inventory.buildInventory({ project: dir, env: w.env }), env: w.env, machine });

test('project-relative-path: relative, ${HOME}, ${USERPROFILE}\\.serena and a relative helper are found and fixed as read, a user arg kept', () =>
{
    const pw = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '.alfred/playwright-chrome', '--output-dir', '.alfred/playwright-chrome/output', '--viewport-size', '1280x720'] };
    const memory = { command: 'uvx', args: ['--python', '3.13', '--from', 'mcp-memory-service[sqlite]==12.1.1', 'memory', 'server'], env: { MCP_MEMORY_SQLITE_PATH: '${HOME}/.preferred-tools/memory/memory.db' } };
    const c7 = { ...C7, headersHelper: 'node .preferred-tools/mcp-headers.js CONTEXT7_API_KEY Bearer' };
    const regs = [reg('playwright-chrome', pw, { scope: 'project' }), reg('memory', memory, { scope: 'project' }), reg('context7', c7, { scope: 'project', route: 'remote' })];
    const at = (registrations, over = {}) => ctxFor({ project: '/work/shop', home: '/home/dev', registrations, ...over });
    const ctx = at(regs);
    const found = F.projectRelativePathDetect(ctx);
    assert.deepStrictEqual(found.map((f) => [f.id, f.name, f.scope, Boolean(f.blocked)]), ['playwright-chrome', 'memory', 'context7'].map((n) => ['project-relative-path', n, 'project', false]));
    for (const f of found) assert.match(f.found, /a copy in a child folder is kept out of git by \/preferred-tools:fix run there$/);
    // the same folder, written out: no data to name
    assert.ok(!found.some((f) => /old data stays/.test(f.found)), found.map((f) => f.found).join('\n'));
    const fixed = regs.map((r, i) => F.projectRelativePathFix(r.entry, found[i], ctx));
    assert.deepStrictEqual(fixed[0], { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '/work/shop/.alfred/playwright-chrome', '--output-dir', '/work/shop/.alfred/playwright-chrome/output', '--viewport-size', '1280x720'] });
    assert.deepStrictEqual(fixed[1], { ...memory, env: { MCP_MEMORY_SQLITE_PATH: '/home/dev/.preferred-tools/memory/memory.db' } });
    assert.deepStrictEqual(fixed[2], { ...C7, headersHelper: 'node /work/shop/.preferred-tools/mcp-headers.js CONTEXT7_API_KEY Bearer' });
    // read back: the fixed entries are clean
    assert.deepStrictEqual(F.projectRelativePathDetect(at(regs.map((r, i) => ({ ...r, entry: fixed[i] })))), []);
    // not found: local scope, ~ and another variable
    assert.deepStrictEqual(F.projectRelativePathDetect(at(regs.map((r) => ({ ...r, scope: 'local' })))), []);
    for (const v of ['~/.pw', '${WORK}/pw']) assert.deepStrictEqual(F.projectRelativePathDetect(at([reg('playwright-chrome', { ...pw, args: ['-y', '@playwright/mcp@0.0.83', '--user-data-dir', v] }, { scope: 'project' })])), [], v);
    // an unset variable is blocked: nothing to write it as
    const [b] = F.projectRelativePathDetect(at([reg('memory', { ...memory, env: { MCP_MEMORY_SQLITE_PATH: '${USERPROFILE}/.preferred-tools/memory/memory.db' } }, { scope: 'project' })]));
    assert.match(b.blocked, /USERPROFILE is not set/);

    // serena on Windows: 0.2.0's ${USERPROFILE}\.serena becomes <project root>\serena, a new folder - the old one is named
    const serena = { command: 'uvx', args: ['--python', '3.13', '--from', 'serena-agent@1.0.0', 'serena', 'start-mcp-server'], env: { SERENA_HOME: '${USERPROFILE}\\.serena' } };
    const win = (project, registrations) => ctxFor({ platform: 'win32', project, home: 'C:\\Users\\dev', env: { USERPROFILE: 'C:\\Users\\dev' }, registrations });
    const wctx = win('C:\\work\\shop', [reg('serena', serena, { scope: 'project' })]);
    const [s] = F.projectRelativePathDetect(wctx);
    assert.match(s.found, /the old data stays at C:\\Users\\dev\\\.serena - moving the path moves no data/);
    assert.match(s.found, /about 327MB/);
    assert.deepStrictEqual(F.projectRelativePathFix(serena, s, wctx), { ...serena, env: { SERENA_HOME: 'C:\\work\\shop\\.preferred-tools\\serena' } });
    // a project root with a space: the profile's .serena, written out
    const spaced = win('C:\\my work\\shop', [reg('serena', serena, { scope: 'project' })]);
    assert.deepStrictEqual(F.projectRelativePathFix(serena, F.projectRelativePathDetect(spaced)[0], spaced).env, { SERENA_HOME: 'C:\\Users\\dev\\.serena' });
    // a relative helper on Windows: absolute, in the forward slashes node and cmd both take
    const wc = win('C:\\work\\shop', [reg('context7', c7, { scope: 'project', route: 'remote' })]);
    assert.strictEqual(F.projectRelativePathFix(c7, F.projectRelativePathDetect(wc)[0], wc).headersHelper, 'node C:/work/shop/.preferred-tools/mcp-headers.js CONTEXT7_API_KEY Bearer');
});

test('project-relative-path and mcp-order in a child folder name the parent', () =>
{
    const fs = require('node:fs');
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: {
            'playwright-chrome': { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', '.alfred/playwright-chrome'] },
            github: GH,
        } });
        const child = path.join(w.project, 'C');
        fs.mkdirSync(child);
        const ours = (d) => d.found.filter((f) => ['project-relative-path', 'mcp-order'].includes(f.id));
        const d = detect(ctxIn(w, child));
        assert.deepStrictEqual(ours(d).map((f) => [f.id, f.blocked]), [['project-relative-path', 'run /preferred-tools:fix in ..'], ['mcp-order', 'run /preferred-tools:fix in ..']]);
        const text = fix.render(d);
        assert.match(text, /project-relative-path .* NOT APPLICABLE: run \/preferred-tools:fix in \.\./);
        assert.match(text, /mcp-order .* NOT APPLICABLE: run \/preferred-tools:fix in \.\./);
        // in the parent itself, both apply
        assert.deepStrictEqual(ours(detect(ctxIn(w, w.project))).map((f) => [f.id, Boolean(f.blocked)]), [['project-relative-path', false], ['mcp-order', false]]);
    }
    finally { w.clean(); }
});

test('mcp-order: found when out of order, not found when in order or when a server left on its own sits among the user\'s', () =>
{
    const fs = require('node:fs');
    const w = world();
    try
    {
        const mine = { command: 'my-server' };
        const file = path.join(w.project, '.mcp.json');
        const at = (servers) => { writeJson(file, { mcpServers: servers }); return F.mcpOrderDetect(ctxIn(w, w.project)); };
        const [f] = at({ mine, c7: C7, gh: GH });
        assert.deepStrictEqual([f.id, f.row, f.name, f.scope, Boolean(f.blocked)], ['mcp-order', 'github', '.mcp.json', 'project', false]);
        assert.match(f.found, /mine, c7, gh .*gh, c7, mine/);
        const r = F.mcpOrderFix(f, ctxIn(w, w.project));
        assert.deepStrictEqual([r.ok, r.restart], [true, false], r.detail);
        assert.deepStrictEqual(Object.keys(readJson(file).mcpServers), ['gh', 'c7', 'mine']);
        assert.deepStrictEqual(F.mcpOrderDetect(ctxIn(w, w.project)), [], 'read back: in order');
        // gh left on its own sits with the user's servers: in order where it is
        const record = path.join(w.project, '.preferred-tools', 'preferred-tools.json');
        writeJson(record, { version: 1, servers: [{ name: 'gh', scope: 'project', fingerprint: existingLib.fingerprintOf(GH, catalog), choice: 'own' }] });
        assert.deepStrictEqual(at({ c7: C7, mine, gh: GH }), []);
        fs.rmSync(record);
        assert.strictEqual(at({ c7: C7, mine, gh: GH }).length, 1, 'managed, the same file is out of order');
        fs.rmSync(file);
        assert.deepStrictEqual(F.mcpOrderDetect(ctxIn(w, w.project)), [], 'no .mcp.json');
    }
    finally { w.clean(); }
});

test('helper-child-folder: found from a child for an inherited helper, not found at the root', () =>
{
    const fs = require('node:fs');
    if (asks.PARENT_HELPER_IN_CHILD) { assert.ok(!catalog.fixes.some((f) => f.id === 'helper-child-folder')); return; }
    const w = world();
    try
    {
        const helper = `node ${path.join(w.project, '.preferred-tools', 'mcp-headers.js')} CONTEXT7_API_KEY Bearer`;
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { context7: { ...C7, headersHelper: helper } } });
        const child = path.join(w.project, 'C');
        fs.mkdirSync(child);
        const d = detect(ctxIn(w, child), 'helper-child-folder');
        assert.deepStrictEqual(d.found.map((f) => [f.id, f.name, f.scope, f.kind]), [['helper-child-folder', 'context7', 'inherited', 'registration']]);
        assert.match(d.found[0].found, /connects here without its key/);
        assert.strictEqual(d.found[0].blocked, 'move it to Global with /preferred-tools:configure in .., or start Claude in ..');
        assert.deepStrictEqual(detect(ctxIn(w, w.project), 'helper-child-folder').found, []);
    }
    finally { w.clean(); }
});

test('data-folder-ignore: after the paths are absolute, a 0.2.0 copy in a child is found once and gets its .gitignore; an ignored one is not', () =>
{
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const w = world();
    try
    {
        const root = path.join(w.project, '.alfred', 'playwright-chrome');
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { 'playwright-chrome': { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome', '--user-data-dir', root, '--output-dir', path.join(root, 'output')] } } });
        const child = path.join(w.project, 'C');
        fs.mkdirSync(child);
        const machine = noMachine({ exists: (p) => fs.existsSync(p), run: C.realMachine().run });
        const at = (dir) => F.dataFolderIgnoreDetect(ctxIn(w, dir, machine));
        assert.deepStrictEqual(at(child), [], 'no copy on disk');
        const copy = path.join(child, '.alfred', 'playwright-chrome');
        fs.mkdirSync(path.join(copy, 'output'), { recursive: true });
        const found = at(child);
        assert.deepStrictEqual(found.map((f) => [f.id, f.name, f.scope, f.proposal.path]), [['data-folder-ignore', 'playwright-chrome', 'inherited', copy]]);
        assert.match(found[0].found, /a 0\.2\.0 copy no server uses any more - its data is left, never moved or deleted/);
        // in the declaring folder the absolute root is the one in use, not a copy
        assert.deepStrictEqual(at(w.project), []);
        const r = F.dataFolderIgnoreFix(found[0], ctxIn(w, child, machine));
        assert.strictEqual(r.ok, true, r.detail);
        assert.strictEqual(fs.readFileSync(path.join(copy, '.gitignore'), 'utf8'), '*\n');
        assert.deepStrictEqual(at(child), [], 'read back');
        // git ignores it: nothing
        fs.rmSync(path.join(copy, '.gitignore'));
        spawnSync('git', ['init', '-q'], { cwd: w.project });
        fs.writeFileSync(path.join(w.project, '.gitignore'), '.alfred/\n');
        assert.deepStrictEqual(at(child), []);
    }
    finally { w.clean(); }
});

test('fix prints the reconnect line for each hosted keyed registration it rewrote', () =>
{
    const w = world();
    try
    {
        // key-to-helper on github at local scope, its key filled: the Reconnect line
        seed(w, 'github', 'local', HOSTED_GH('Bearer ${ACME_GH}'));
        secretsAt(ptRoot(w), { ACME_GH: hexv('gh') });
        const l = logged();
        assert.strictEqual(fix.applyFixes(ctxOf(w), ['key-to-helper'], { tmp: path.join(w.dir, 'tmp'), log: l.log }).failed, null, l.text());
        assert.ok(l.text().includes('github: connects with its key at the next session start; in a session already running, /mcp -> github -> Reconnect'), l.text());
        // project-relative-path on context7's 0.2.0 helper at project scope, its key not filled: the fill line
        seed(w, 'context7', 'project', { ...C7, headersHelper: 'node .preferred-tools/mcp-headers.js CONTEXT7_API_KEY Bearer' });
        const m = logged();
        assert.strictEqual(fix.applyFixes(ctxOf(w), ['project-relative-path'], { tmp: path.join(w.dir, 'tmp2'), log: m.log }).failed, null, m.text());
        assert.ok(m.text().includes(`context7: fill CONTEXT7_API_KEY in ${path.join(ptRoot(w), '.mcps-secrets')}, then Reconnect it in /mcp - until then it runs without the key, at lower rate limits`), m.text());
        assert.ok(!/github: connects/.test(m.text()), 'only what this run rewrote');
    }
    finally { w.clean(); }
});

// ---- the bridge (0.4.0): its file and the helper beside it, and its mcp-remote cache folder -------------------------

const BV = require('../scripts/mcp-bridge.js').BRIDGE_VERSION;
const BRIDGE = (root, pin = '0.16.0') => ({ command: 'node', args: [path.join(root, 'mcp-bridge.js'), 'https://mcp.sentry.dev/mcp/{SENTRY_ORG}/{SENTRY_PROJECT?}', SK, 'Sentry-Bearer', `mcp-remote@${pin}`], env: { npm_config_before: '2026-11-11T23:59:59Z' } });
const bridgeAt = (root, number, extra = '') => put(path.join(root, 'mcp-bridge.js'), rootsLib.shippedSource('bridge').replace(/^\/\/ preferred-tools mcp-bridge \d+/, `// preferred-tools mcp-bridge ${number}`) + extra);

test('helper-missing finds both files of a bridge registration and writes both', () =>
{
    const w = world();
    try
    {
        seed(w, 'sentry', 'local', BRIDGE(ptRoot(w)));
        const helper = path.join(ptRoot(w), 'mcp-headers.js');
        const bridge = path.join(ptRoot(w), 'mcp-bridge.js');
        const found = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-missing');
        assert.deepStrictEqual(found.map((x) => x.name).sort(), [bridge, helper].sort());
        assert.ok(found.some((x) => x.found === 'mcp-bridge.js is missing - sentry (local) does not start'), found.map((x) => x.found).join('\n'));
        const l = logged();
        assert.strictEqual(fix.applyFixes(ctxOf(w), ['helper-missing'], { log: l.log }).failed, null, l.text());
        assert.strictEqual(fsx.readFileSync(helper, 'utf8'), rootsLib.helperSource());
        assert.strictEqual(fsx.readFileSync(bridge, 'utf8'), rootsLib.shippedSource('bridge'));
        assert.strictEqual(fsx.readFileSync(path.join(ptRoot(w), 'package.json'), 'utf8'), '{"type":"commonjs"}\n', 'the root says CommonJS');
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((x) => /^helper-/.test(x.id)), []);
    }
    finally { w.clean(); }
});

test('helper-stale finds helper 3 beside a bridge, and a hand-edited bridge, and leaves a newer one blocked', () =>
{
    const w = world();
    try
    {
        seed(w, 'sentry', 'local', BRIDGE(ptRoot(w)));
        const bridge = path.join(ptRoot(w), 'mcp-bridge.js');
        helperAt(ptRoot(w), 3);
        bridgeAt(ptRoot(w), BV);
        const [lower] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.match(lower.found, new RegExp(`^mcp-headers\\.js is helper 3 - this plugin's is ${HV}`));
        fix.applyFixes(ctxOf(w), ['helper-stale'], { log: () => {} });
        assert.strictEqual(fsx.readFileSync(path.join(ptRoot(w), 'mcp-headers.js'), 'utf8'), rootsLib.helperSource());

        bridgeAt(ptRoot(w), BV, '// mine\n');
        const [edited] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.strictEqual(edited.name, bridge);
        assert.match(edited.found, /^mcp-bridge\.js changed since preferred-tools wrote it/);
        fix.applyFixes(ctxOf(w), ['helper-stale'], { log: () => {} });
        assert.strictEqual(fsx.readFileSync(bridge, 'utf8'), rootsLib.shippedSource('bridge'));

        bridgeAt(ptRoot(w), BV + 1);
        const [higher] = detect(ctxOf(w)).found.filter((x) => x.id === 'helper-stale');
        assert.strictEqual(higher.blocked, `mcp-bridge.js in ${ptRoot(w)} is newer than this plugin - update preferred-tools`);
        fix.applyFixes(ctxOf(w), ['helper-stale'], { log: () => {} });
        assert.match(fsx.readFileSync(bridge, 'utf8'), new RegExp(`^// preferred-tools mcp-bridge ${BV + 1}`), 'never rewritten');
    }
    finally { w.clean(); }
});

test("npx-cache-entry finds a bridge registration's mcp-remote folder without package.json", () =>
{
    const w = world();
    try
    {
        const cache = path.join(w.home, '.npm');
        const folder = npxFolder(cache, 'mcp-remote@0.16.0');
        const b = reg('sentry', BRIDGE(path.join(w.project, '.preferred-tools')), { scope: 'local' });
        const found = () => F.npxCacheEntryDetect(ctxFor({ platform: process.platform, project: w.project, registrations: [b], machine: npmAt(cache) }));
        assert.deepStrictEqual(found(), []);
        fsx.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
        const [f] = found();
        assert.deepStrictEqual([f.id, f.name, f.proposal], ['npx-cache-entry', 'sentry', { path: folder, what: 'mcp-remote@0.16.0' }]);
    }
    finally { w.clean(); }
});
