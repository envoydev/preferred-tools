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
        assert.strictEqual(typeof F[f.fix], 'function', `${f.id}: no ${f.fix}`);
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
    // the project scope cannot hold an absolute path
    [f] = homes(mk('${USERPROFILE}/.serena', {}, { scope: 'project' }));
    assert.match(f.blocked, /committed file/);
    // not Windows, or no SERENA_HOME at all: nothing
    assert.deepStrictEqual(detect(ctxFor({ platform: 'darwin', registrations: [reg('serena', { command: 'uvx', args: [], env: { SERENA_HOME: 'C:/x' } })] })).found.filter((x) => x.id === 'serena-windows-home'), []);
    assert.deepStrictEqual(detect(ctxFor({ platform: 'win32', registrations: [reg('serena', { command: 'uvx', args: ['--python', '3.13'], env: { SERENA_USAGE_REPORTING: 'false' } })] })).found, []);
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
    // a committed file takes no absolute path
    assert.match(detect(ctxFor({ machine, registrations: [reg('appium', appium, { name: 'appium-mcp', scope: 'project' })] })).found[0].blocked, /committed file/);
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

// ---- narrowing and rendering ----------------------------------------------------------------------------------------

test('fix detectors never return an inherited registration', () =>
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

// ---- token-sync (D7): a registration behind its key file --------------------------------------------------------------

const fsx = require('node:fs');
const cryptox = require('node:crypto');
const { writeJson, files } = require('./helpers.js');
const SK = 'SENTRY_ACCESS_TOKEN';
const SENTRY = (value) => ({ command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { [SK]: value } });
const hexv = (p) => `${p}-${cryptox.randomBytes(10).toString('hex')}`;
const keyFileIn = (dir, value) =>
{
    fsx.mkdirSync(path.join(dir, '.preferred-tools'), { recursive: true });
    fsx.writeFileSync(path.join(dir, '.preferred-tools', '.secrets'), `${SK}=${value}\n`);
    fsx.writeFileSync(path.join(dir, '.preferred-tools', '.gitignore'), '*\n');
};
const localEntry = (w, name) => account.readAccount(w.env, w.project).local[name];

test('token-sync finds a registration behind its key file, rewrites it, and prints no value', () =>
{
    const w = world();
    try
    {
        const [v1, v2] = [hexv('one'), hexv('two')];
        seed(w, 'sentry', 'local', SENTRY(`\${${SK}}`));
        keyFileIn(w.project, v1);
        const found = detect(ctxOf(w)).found.filter((f) => f.id === 'token-sync');
        assert.deepStrictEqual(found.map((f) => [f.name, f.scope, Boolean(f.blocked)]), [['sentry', 'local', false]]);
        assert.match(found[0].found, new RegExp(`holds \\$\\{${SK}\\} while .*\\.preferred-tools.\\.secrets has the key`));
        const shown = `${fix.render(detect(ctxOf(w)))}${JSON.stringify(detect(ctxOf(w)))}`;
        assert.ok(!shown.includes(v1), 'the detection names the key and the file, never the value');
        const lines = [];
        const res = fix.applyFixes(ctxOf(w), ['token-sync'], { tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(res.failed, null, lines.join('\n'));
        assert.strictEqual(localEntry(w, 'sentry').env[SK], v1);
        assert.deepStrictEqual(res.applied.map((f) => f.id), ['token-sync']);
        keyFileIn(w.project, v2);
        assert.match(detect(ctxOf(w)).found.find((f) => f.id === 'token-sync').found, /differs from the registration's/);
        const lines2 = [];
        fix.applyFixes(ctxOf(w), ['token-sync'], { tmp: path.join(w.dir, 'tmp'), log: (...a) => lines2.push(a.join(' ')) });
        assert.strictEqual(localEntry(w, 'sentry').env[SK], v2);
        assert.deepStrictEqual(detect(ctxOf(w)).found.filter((f) => f.id === 'token-sync'), [], 'in sync: nothing found');
        for (const v of [v1, v2]) assert.ok(!`${lines.join('\n')}${lines2.join('\n')}`.includes(v), 'nothing printed holds the value');
        for (const f of files(path.join(w.dir, 'tmp'))) for (const v of [v1, v2]) assert.ok(!fsx.readFileSync(f, 'utf8').includes(v), path.basename(f));
    }
    finally { w.clean(); }
});

test('token-sync rewrites a live user registration only from the home file - a differing project chain is reported, not written', () =>
{
    const w = world();
    try
    {
        writeJson(path.join(w.dir, 'state', 'plugins.json'), { marketplaces: [], installed: [{ id: 'alfred-code@envoydev', version: '3.2.1', scope: 'user', enabled: true, installPath: '/c' }] });
        writeJson(path.join(w.account, 'settings.json'), { enabledPlugins: { 'alfred-code@envoydev': true } });
        const [live, chain, home] = [hexv('live'), hexv('chain'), hexv('home')];
        fsx.mkdirSync(path.join(w.project, '.alfred'), { recursive: true });
        fsx.writeFileSync(path.join(w.project, '.alfred', '.secrets'), `${SK}=${chain}\n`);
        seed(w, 'sentry', 'user', SENTRY(live));
        const f = detect(ctxOf(w)).found.find((x) => x.id === 'token-sync');
        assert.match(f.blocked, /a server for every project takes a new key only from .*\.preferred-tools.\.secrets/);
        const lines = [];
        const res = fix.applyFixes(ctxOf(w), ['token-sync'], { log: (...a) => lines.push(a.join(' ')) });
        assert.deepStrictEqual(res.skipped.map((x) => x.id), ['token-sync']);
        assert.strictEqual(userEntry(w, 'sentry').env[SK], live, 'reported, not written');
        // a user registration still holding ${VAR} takes this project's key
        seed(w, 'sentry-b', 'user', SENTRY(`\${${SK}}`));
        fix.applyFixes(ctxOf(w), ['token-sync'], { only: 'sentry-b', tmp: path.join(w.dir, 'tmp'), log: () => {} });
        assert.strictEqual(userEntry(w, 'sentry-b').env[SK], chain);
        // the home file changes a live one
        keyFileIn(w.home, home);
        assert.ok(!detect(ctxOf(w)).found.find((x) => x.id === 'token-sync' && x.name === 'sentry').blocked);
        fix.applyFixes(ctxOf(w), ['token-sync'], { only: 'sentry', tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(userEntry(w, 'sentry').env[SK], home);
        for (const v of [live, chain, home]) assert.ok(!lines.join('\n').includes(v));
    }
    finally { w.clean(); }
});
