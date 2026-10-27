'use strict';
// Step 12: the temp-project matrix beyond a fresh install. Every case runs the REAL claude CLI in a throwaway home and
// account (tests/harness.js) and reads the result back from the files the CLI wrote - never from an exit code alone.
//
//   npm run matrix
//
// A plugin case with no network is reported as skipped with the reason ('NOT RUN'). Windows behaviour is exercised by
// simulating the platform in the detectors and the plan (the CLI rewrite itself is the real one); it is proved on a real
// Windows machine only in the user's own live check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../../scripts/claude-cli.js');
const account = require('../../scripts/account.js');
const catalogLib = require('../../scripts/catalog.js');
const E = require('../../scripts/entries.js');
const fix = require('../../scripts/fix.js');
const update = require('../../scripts/update.js');
const psLib = require('../../scripts/plugin-settings.js');
const { pinnedVersion } = require('../../scripts/fixes/common.js');
const { Harness } = require('../harness.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-scn-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const h = new Harness({ root });
const catalog = catalogLib.load();
const NETWORK = /could not resolve|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|clone|fetch|timed out|ECONNREFUSED/i;

const regs = (project) => h.inventory(project).registrations;
const reg = (project, name, scope) => regs(project).find((r) => r.name === name && (!scope || r.scope === scope));
const mcpJsonPath = (project) => path.join(project, '.mcp.json');
const accountText = () => (fs.existsSync(account.accountFile(h.env)) ? fs.readFileSync(account.accountFile(h.env), 'utf8') : '');
const add = (project, name, entry, scope = 'user') =>
{
    const r = h.claude(project, ['mcp', 'add-json', name, JSON.stringify(entry), '-s', scope]);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
};
const T = { skip: skipAll, timeout: 300000 };

// ---- re-run, rename, update ----------------------------------------------------------------------------------------

test('a re-run with the same answers changes nothing: no claude call, both files byte-identical', T, () =>
{
    const p = h.project('rerun');
    const answers = { picks: { serena: { scope: 'local' }, context7: { route: 'remote', scope: 'project' } } };
    const first = h.run(p, answers);
    assert.strictEqual(first.report.failed, null, first.text);
    const before = [accountText(), fs.readFileSync(mcpJsonPath(p), 'utf8')];
    const second = h.run(p, answers);
    assert.deepStrictEqual(second.plan.errors, []);
    assert.strictEqual(second.report.noop, true, second.text);
    assert.deepStrictEqual(second.plan.unchanged.length, 2);
    assert.deepStrictEqual([accountText(), fs.readFileSync(mcpJsonPath(p), 'utf8')], before);
});

test('a custom name, then a rename: the new name is added first, read back, the old one removed; the pin and a user-added arg survive', T, () =>
{
    const p = h.project('rename');
    assert.strictEqual(h.run(p, { picks: { serena: { scope: 'local', name: 'code-nav' } } }).report.failed, null);
    const first = reg(p, 'code-nav', 'local');
    assert.strictEqual(first.rowId, 'serena', 'matched by what it launches, not by the name');

    // past the catalog pin by an update, plus an arg of the user's
    const mine = { ...first.entry, args: [...first.entry.args, '--my-flag'] };
    h.claude(p, ['mcp', 'remove', 'code-nav', '-s', 'local']);
    add(p, 'code-nav', mine, 'local');
    const newer = bumped(mine, 'serena-agent', '9.9.9');
    h.claude(p, ['mcp', 'remove', 'code-nav', '-s', 'local']);
    add(p, 'code-nav', newer, 'local');

    const moved = h.run(p, { change: { 'mcp:code-nav~local': { name: 'nav2' } } });
    assert.deepStrictEqual(moved.plan.errors, []);
    assert.strictEqual(moved.report.failed, null, moved.text);
    assert.ok(moved.plan.steps.some((s) => s.op === 'mcp-move'));
    assert.strictEqual(reg(p, 'code-nav'), undefined, 'the old name is gone');
    const now = reg(p, 'nav2', 'local');
    assert.strictEqual(pinnedVersion(now.entry, 'serena-agent'), '9.9.9', 'an updated pin is never downgraded to the catalog pin');
    assert.ok(now.entry.args.includes('--my-flag'), 'the user\'s arg is kept');
    const g = h.claude(p, ['mcp', 'get', 'nav2']);
    assert.strictEqual(g.status, 0, g.stdout + g.stderr);
});

test('configure: one of two registrations of a row is renamed by its key; the other stays byte-identical', T, () =>
{
    const p = h.project('configure');
    assert.strictEqual(h.run(p, { picks: { memory: { scope: 'local', name: 'cfg-memory' } } }).report.failed, null);
    const local = reg(p, 'cfg-memory', 'local');
    add(p, 'cfg-memory-user', { ...local.entry }, 'user');
    const keep = JSON.stringify(reg(p, 'cfg-memory', 'local').entry);

    const r = h.run(p, { change: { 'mcp:cfg-memory-user~user': { row: 'memory', name: 'cfg-memory-2' } } });
    assert.deepStrictEqual(r.plan.errors, []);
    assert.strictEqual(r.report.failed, null, r.text);
    assert.deepStrictEqual(r.plan.steps.map((s) => s.op), ['mcp-move']);
    assert.strictEqual(reg(p, 'cfg-memory-user', 'user'), undefined, 'the old name is gone');
    assert.deepStrictEqual(reg(p, 'cfg-memory-2', 'user').entry, local.entry, 'built from the entry as read');
    assert.strictEqual(JSON.stringify(reg(p, 'cfg-memory', 'local').entry), keep, 'the registration not picked is left as it is');
    assert.strictEqual(h.run(p, { change: { 'mcp:cfg-memory-2~user': { row: 'memory' } } }).report.noop, true, 'every answer kept: no claude call');
    h.claude(p, ['mcp', 'remove', 'cfg-memory-2', '-s', 'user']);
});

test('install beside a copy for every project: this project gets its own registration and data; the user-scope one stays byte-identical', T, () =>
{
    const p = h.project('own-copy');
    assert.strictEqual(h.run(p, { picks: { memory: { scope: 'user', name: 'copy-mem' } } }).report.failed, null);
    const before = JSON.stringify(reg(p, 'copy-mem', 'user').entry);

    const r = h.run(p, { picks: { memory: { name: 'copy-mem' } } });
    assert.deepStrictEqual(r.plan.errors, []);
    assert.strictEqual(r.report.failed, null, r.text);
    assert.ok(!r.plan.steps.some((s) => /remove|move|replace/.test(s.op)), 'nothing is removed or moved');
    const mine = reg(p, 'copy-mem', 'local');
    assert.ok(mine, 'this project\'s copy, at local scope');
    assert.strictEqual(path.resolve(mine.entry.env.MCP_MEMORY_SQLITE_PATH), path.join(p, '.preferred-tools', 'copy-mem', 'memory.db'), 'its own data');
    assert.strictEqual(JSON.stringify(reg(p, 'copy-mem', 'user').entry), before, 'the copy for every project is untouched');
    for (const scope of ['local', 'user']) h.claude(p, ['mcp', 'remove', 'copy-mem', '-s', scope]);
});

function bumped(entry, pkg, version)
{
    const from = pinnedVersion(entry, pkg);
    return { ...entry, args: entry.args.map((a) => (a.endsWith(`@${from}`) || a.endsWith(`==${from}`) ? a.slice(0, a.length - from.length) + version : a)) };
}

test('an update with a stale pin: the registry\'s newer, old-enough release is written under the same name and scope, and read back', T, async () =>
{
    const p = h.project('stale-pin');
    const answers = { picks: { serena: { scope: 'user' } } };
    assert.strictEqual(h.run(p, answers).report.failed, null);
    const cur = reg(p, 'serena', 'user');
    const stale = bumped(cur.entry, 'serena-agent', '1.0.0');
    h.claude(p, ['mcp', 'remove', 'serena', '-s', 'user']);
    add(p, 'serena', stale, 'user');
    const DAY = 86400000;
    const now = Date.parse('2026-10-27T12:00:00Z');
    const registry = { versionsOf: async () => [{ version: '1.0.0', time: now - 90 * DAY }, { version: '1.5.0', time: now - 30 * DAY }, { version: '1.6.0', time: now - 2 * DAY }] };
    const lines = [];
    const code = await update.main(['--apply', 'mcp:serena~user', '--no-refresh', '--project', p], { env: h.env, out: (s) => lines.push(s), registry, now, machine: { which: () => null, run: () => ({ status: 1 }), nodeVersion: process.versions.node } });
    assert.strictEqual(code, 0, lines.join('\n'));
    const got = reg(p, 'serena', 'user');
    assert.strictEqual(pinnedVersion(got.entry, 'serena-agent'), '1.5.0', 'the 2-day-old 1.6.0 is held back');
    assert.strictEqual(got.entry.args[got.entry.args.indexOf('--exclude-newer') + 1], '2026-10-27T23:59:59Z');
    assert.deepStrictEqual(got.entry.env, cur.entry.env);
});

// ---- names, scopes, files ------------------------------------------------------------------------------------------

test('four Playwright engines in one project: four entries under their own names, four distinct --user-data-dir values', T, () =>
{
    const p = h.project('four-engines');
    const names = ['playwright-chrome', 'playwright-msedge', 'playwright-firefox', 'playwright-webkit'];
    const r = h.run(p, { picks: Object.fromEntries(names.map((n) => [n, { scope: 'local' }])) });
    assert.deepStrictEqual(r.plan.errors, []);
    assert.strictEqual(r.report.failed, null, r.text);
    const dirs = names.map((n) =>
    {
        const e = reg(p, n, 'local').entry;
        return e.args[e.args.indexOf('--user-data-dir') + 1];
    });
    assert.strictEqual(new Set(dirs).size, 4, dirs.join(' | '));
    assert.strictEqual(regs(p).filter((x) => x.rowId && x.rowId.startsWith('playwright-')).length, 4);
});

test('a user\'s own server under a catalog name is asked about, never overwritten', T, () =>
{
    const p = h.project('own-name');
    const own = { command: 'node', args: ['my-server.js'] };
    add(p, 'serena', own, 'local');
    const r = h.run(p, { picks: { serena: { scope: 'local' } } });
    assert.match(r.plan.errors.join('\n'), /serena: 'serena' already belongs to another registration at local scope/);
    assert.strictEqual(r.report.skipped, true, 'nothing was applied');
    assert.deepStrictEqual(reg(p, 'serena', 'local').entry, own);
    assert.strictEqual(reg(p, 'serena', 'local').own, true);
    // the walk asks for another name; that works beside it
    const ok = h.run(p, { picks: { serena: { scope: 'local', name: 'serena-code' } } });
    assert.strictEqual(ok.report.failed, null, ok.text);
    assert.deepStrictEqual(reg(p, 'serena', 'local').entry, own);
});

test('.mcp.json missing, empty, {} and malformed: the first three install at project scope, the malformed one is named and left byte-identical', T, () =>
{
    const answers = { picks: { context7: { route: 'remote', scope: 'project' } } };
    for (const [label, content] of [['missing', null], ['empty', ''], ['whitespace', '  \n'], ['braces', '{}']])
    {
        const p = h.project(`mcpjson-${label}`);
        if (content !== null) fs.writeFileSync(mcpJsonPath(p), content);
        const r = h.run(p, answers);
        assert.strictEqual(r.report.failed, null, `${label}: ${r.text}`);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(mcpJsonPath(p), 'utf8')).mcpServers.context7, { type: 'http', url: 'https://mcp.context7.com/mcp' }, label);
    }
    const p = h.project('mcpjson-malformed');
    fs.writeFileSync(mcpJsonPath(p), '{ "mcpServers": ');
    const r = h.run(p, answers);
    assert.match(r.plan.errors.join('\n'), /project scope is unreadable/);
    assert.strictEqual(fs.readFileSync(mcpJsonPath(p), 'utf8'), '{ "mcpServers": ', 'left byte-identical');
    const local = h.run(p, { picks: { memory: { scope: 'user' } } });
    assert.strictEqual(local.report.failed, null, 'another scope still works');
});

test('each scope the row allows: local, project and user, read back from the file that scope lives in', T, () =>
{
    for (const scope of ['local', 'project', 'user'])
    {
        const p = h.project(`scope-${scope}`);
        const r = h.run(p, { picks: { context7: { route: 'remote', scope } } });
        assert.strictEqual(r.report.failed, null, r.text);
        const got = reg(p, 'context7', scope);
        assert.ok(got, scope);
        const stored = scope === 'project' ? JSON.parse(fs.readFileSync(mcpJsonPath(p), 'utf8')).mcpServers : (scope === 'user' ? account.readAccount(h.env, p).user : account.readAccount(h.env, p).local);
        assert.deepStrictEqual(stored.context7, got.entry);
    }
});

test('a remove: the registration is gone from its file, the data folder stays, and the other registration is untouched', T, () =>
{
    const p = h.project('remove');
    // an earlier case may leave a serena at user scope in this shared account: the install adds beside it, never moves it
    const global = reg(p, 'serena', 'user');
    assert.strictEqual(h.run(p, { picks: { serena: { scope: 'local' }, context7: { route: 'remote', scope: 'project' } } }).report.failed, null);
    const data = path.join(p, '.preferred-tools', 'serena');
    assert.ok(fs.existsSync(data));
    const r = h.run(p, { picks: {}, remove: [{ kind: 'mcp', name: 'serena', scope: 'local' }] });
    assert.deepStrictEqual(r.plan.errors, []);
    assert.strictEqual(r.report.failed, null, r.text);
    assert.strictEqual(reg(p, 'serena', 'local'), undefined);
    if (global) assert.deepStrictEqual(reg(p, 'serena', 'user').entry, global.entry, 'the user-scope serena is untouched by the add and the remove');
    assert.ok(fs.existsSync(data), 'data folders stay where they are');
    assert.ok(reg(p, 'context7', 'project'));
    const own = h.run(p, { picks: {}, remove: [{ kind: 'mcp', name: 'my-own', scope: 'user' }] });
    assert.ok(own.plan.errors.length, 'a name that is not in the inventory is an error, not a guess');
});

// ---- the fixes, on seeded entries, through the real CLI ------------------------------------------------------------

// the entry as the catalog builds it for a platform, then broken by `breakIt`
function freshEntry(rowId, platform, arch = 'x64', scope = 'user')
{
    const r = catalog.byId.get(rowId);
    const win = platform === 'win32';
    const rootStr = r.locations ? (win ? 'C:\\Users\\dev\\.pt\\x' : '/Users/dev/.pt/x') : undefined;
    const ctx = { platform, arch, env: {}, home: win ? 'C:\\Users\\dev' : '/Users/dev', project: win ? 'C:\\proj' : '/proj' };
    return E.buildEntry(r, 'local', { rootStr, scope, token: false }, ctx, catalog.rules);
}
const withoutArgs = (entry, from, count) => { const a = entry.args.slice(); a.splice(a.indexOf(from), count); return { ...entry, args: a }; };

const FIXES = [
    { id: 'serena-telemetry', row: 'serena', platform: 'darwin', seed: () => { const e = freshEntry('serena', 'darwin'); const env = { ...e.env }; delete env.SERENA_USAGE_REPORTING; return { ...e, env }; } },
    { id: 'uvx-python', row: 'memory', platform: 'darwin', seed: () => withoutArgs(freshEntry('memory', 'darwin'), '--python', 2) },
    { id: 'windows-arm-python', row: 'memory', platform: 'win32', arch: 'arm64', seed: () => { const e = freshEntry('memory', 'win32'); e.args[e.args.indexOf('--python') + 1] = '3.13'; return e; } },
    { id: 'windows-npx-cmd', row: 'context7', platform: 'win32', seed: () => ({ command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4'], env: { npm_config_before: '2026-10-20T23:59:59Z' } }) },
    { id: 'serena-windows-home', row: 'serena', platform: 'win32', seed: () => { const e = freshEntry('serena', 'win32'); return { ...e, env: { ...e.env, SERENA_HOME: 'C:/Users/dev/.serena' } }; } },
    { id: 'playwright-webmcp', row: 'playwright-chrome', platform: 'darwin', seed: () => withoutArgs(freshEntry('playwright-chrome', 'darwin'), '--no-webmcp', 1) },
    { id: 'appium-sdk-env', row: 'appium', platform: 'darwin', seed: () => freshEntry('appium', 'darwin'), env: { ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk' }, machine: { exists: (p) => ['/sdk', '/jdk'].includes(p) } },
];

for (const f of FIXES)
{
    test(`fix ${f.id}: detected on a seeded entry, rewritten by the real CLI from the entry as read, found no more afterwards`, T, () =>
    {
        const p = h.project(`fix-${f.id}`);
        const seeded = f.seed();
        const name = `fix-${f.id}`; // a custom name: identity is the launch, and another case's registration in the shared account cannot match `--only`
        add(p, name, seeded, 'local');
        const mk = () => fix.makeCtx({
            inv: h.inventory(p), catalog, env: { ...h.env, ...(f.env || {}) }, platform: f.platform, arch: f.arch || 'x64',
            machine: { exists: () => false, realpath: () => null, which: () => null, run: () => ({ status: 1, stdout: '', stderr: '' }), nodeVersion: process.versions.node, ...(f.machine || {}) },
        });
        const found = fix.detectAll(mk(), { only: name }).found.filter((x) => x.id === f.id);
        assert.strictEqual(found.length, 1, `${f.id} not found on ${JSON.stringify(seeded)}`);
        assert.ok(!found[0].blocked, found[0].blocked);
        const lines = [];
        const res = fix.applyFixes(mk(), [f.id], { only: name, tmp: path.join(root, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.ok(!res.failed, lines.join('\n'));
        const after = reg(p, name, 'local');
        assert.notDeepStrictEqual(after.entry, seeded, 'the entry changed');
        assert.strictEqual(after.rowId, catalog.byId.get(f.row).id, 'still matched by what it launches');
        assert.deepStrictEqual(fix.detectAll(mk(), { only: name }).found.filter((x) => x.id === f.id), [], 'read back: the detector finds nothing now');
        // the real file holds what the CLI wrote
        assert.deepStrictEqual(account.readAccount(h.env, p).local[name], after.entry);
    });
}

// ---- claude-hud (needs the network for the plugin install) ---------------------------------------------------------

test('claude-hud: recommended keeps the user\'s value; \'Apply and replace differing\' overwrites it and writes a settings.json backup', T, (t) =>
{
    const p = h.project('hud');
    const r = h.run(p, { picks: { 'claude-hud': { scope: 'user' } }, hud: 'defer' });
    if (r.report.failed && NETWORK.test(r.report.failed.detail)) return t.skip(`NOT RUN: no network (${r.report.failed.detail.slice(0, 100)})`);
    assert.strictEqual(r.report.failed, null, r.text);
    const script = path.join(__dirname, '..', '..', 'scripts', 'hud-statusline.js');
    const cat = path.join(__dirname, '..', '..', 'catalog', 'plugin-settings.json');
    const hud = (...flags) => spawnSync(process.execPath, [script, ...flags, '--catalog', cat, '--project', '.'], { cwd: p, env: h.env, encoding: 'utf8' });
    const configFile = path.join(h.account, 'plugins', 'claude-hud', 'config.json');
    const settingsFile = path.join(h.account, 'settings.json');
    const readCfg = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

    // the user's own value, different from the catalog's 'compact'
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify({ lineLayout: 'expanded' }, null, 2)}\n`);
    const rec = hud();
    assert.strictEqual(rec.status, 0, rec.stdout + rec.stderr);
    assert.strictEqual(readCfg().lineLayout, 'expanded', 'recommended keeps a value the user chose');
    assert.strictEqual(readCfg().showSeparators, false, 'and adds the missing keys');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.strictEqual(settings.statusLine.type, 'command');
    assert.strictEqual(settings.statusLine.refreshInterval, 5);

    // now the user's refresh interval differs, and 'replace' overwrites both
    settings.statusLine.refreshInterval = 30;
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    const check = hud('--check');
    assert.match(check.stdout, /^hud-check: statusLine=current missing=0 differs=2 match=\d+$/m, check.stdout);
    const rep = hud('--replace');
    assert.strictEqual(rep.status, 0, rep.stdout + rep.stderr);
    assert.strictEqual(readCfg().lineLayout, 'compact');
    assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine.refreshInterval, 5);
    // one copy per run before its first write: the earlier run's, and this run's holding the user's interval of 30
    const baks = fs.readdirSync(h.account).filter((n) => /^settings\.json\.bak\./.test(n));
    assert.ok(baks.some((n) => (JSON.parse(fs.readFileSync(path.join(h.account, n), 'utf8')).statusLine || {}).refreshInterval === 30), `no backup holds the user's file as it was: ${baks.join(', ')}\n${rep.stdout}`);
    assert.ok(psLib.leaves, 'plugin-settings is the same module the install walk uses');

    // the plugin runs: the statusLine command as written, fed a session's JSON on stdin as Claude Code feeds it. On
    // Windows the shell Claude Code runs it in is not verified here, so that half is the Windows VM's.
    if (process.platform === 'win32') return t.diagnostic('NOT RUN: running the statusLine on Windows is the Windows VM\'s check');
    const line = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine.command;
    const input = JSON.stringify({ session_id: 'matrix', transcript_path: '', cwd: p, model: { id: 'claude-opus-5-5', display_name: 'Opus' }, workspace: { current_dir: p, project_dir: p }, version: '' });
    const shown = spawnSync(line, { shell: true, cwd: p, env: h.env, input, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(shown.status, 0, `${line}\n${shown.stdout}${shown.stderr}`);
    assert.ok(shown.stdout.trim(), `claude-hud printed nothing for the status line: ${shown.stderr}`);
    t.diagnostic(`claude-hud status line on ${process.platform}: ${shown.stdout.trim().split('\n')[0].slice(0, 120)}`);
});

// ---- the real account ----------------------------------------------------------------------------------------------

test('the real account is untouched by the whole matrix', { skip: skipAll }, () =>
{
    const real = h.realUntouched();
    assert.ok(real.ok, `the real account changed: ${real.changed.join(', ')}`);
});
