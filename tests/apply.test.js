'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { world, writeJson, readJson, accountKey, tempOf, files } = require('./helpers.js');
const inventory = require('../scripts/inventory.js');
const { plan } = require('../scripts/plan.js');
const { apply } = require('../scripts/apply.js');
const account = require('../scripts/account.js');
const cli = require('../scripts/claude-cli.js');
const { MARKER } = require('../scripts/kept.js');

// the whole chain, as the walk runs it: inventory -> plan -> apply, against the fake claude on the world's PATH
function walk(w, answers, { fail, planOpts = {} } = {})
{
    const env = { ...w.env };
    if (fail) env.FAKE_CLAUDE_FAIL = fail;
    const inv = inventory.buildInventory({ project: w.project, env });
    const p = plan(inv, answers, { home: w.home, env, ...planOpts });
    const lines = [];
    const report = apply(p, { env, tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
    return { inv, p, report, lines, text: lines.join('\n'), env };
}
const accountDoc = (w) => readJson(account.accountFile(w.env));
const mcpJson = (w) => readJson(path.join(w.project, '.mcp.json'));

test('an apply from a subfolder reads back where the CLI wrote (M4)', () => {
    const w = world();
    try
    {
        spawnSync('git', ['init', '-q', w.project]);
        const sub = path.join(w.project, 'packages', 'app');
        fs.mkdirSync(sub, { recursive: true });
        const env = { ...w.env };
        const inv = inventory.buildInventory({ project: sub, env });
        const p = plan(inv, { picks: { serena: { scope: 'local' }, context7: { route: 'remote', scope: 'project' } } }, { home: w.home, env });
        assert.deepStrictEqual(p.errors, []);
        const lines = [];
        const report = apply(p, { env, tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        assert.strictEqual(report.failed, null, lines.join('\n'));
        assert.deepStrictEqual(Object.keys(accountDoc(w).projects[accountKey(w.project)].mcpServers), ['serena'], 'local scope: keyed on the repo root');
        assert.deepStrictEqual(Object.keys(readJson(path.join(sub, '.mcp.json')).mcpServers), ['context7'], "project scope: the subfolder's own .mcp.json");
        assert.ok(!fs.existsSync(path.join(w.project, '.mcp.json')));
        assert.deepStrictEqual(report.readback.map((r) => r.found), [true, true], 'both read back');
    }
    finally { w.clean(); }
});

test('a fresh install writes through the CLI at each scope, and every add is read back from the file', () => {
    const w = world();
    try
    {
        const r = walk(w, { picks: { serena: { scope: 'local' }, 'playwright-chrome': { scope: 'user' }, context7: { route: 'remote', scope: 'project' } } });
        assert.deepStrictEqual(r.p.errors, []);
        assert.strictEqual(r.report.failed, null, r.text);
        // local: the account file's project entry; user: the top level; project: .mcp.json
        const proj = accountDoc(w).projects[accountKey(w.project)].mcpServers;
        assert.deepStrictEqual(Object.keys(proj), ['serena']);
        assert.deepStrictEqual(Object.keys(accountDoc(w).mcpServers), ['playwright-chrome']);
        assert.deepStrictEqual(mcpJson(w), { mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } });
        // in the project root, absolute at local scope (serena on Windows too, the throwaway path being space-free)
        assert.ok(proj.serena.env.SERENA_HOME.startsWith(w.project), 'an absolute path at local scope');
        // the argv the CLI saw
        const adds = w.calls().filter((a) => a[1] === 'add-json');
        assert.deepStrictEqual(adds.map((a) => [a[2], a[4], a[5]]), [['serena', '-s', 'local'], ['playwright-chrome', '-s', 'user'], ['context7', '-s', 'project']]);
        assert.match(r.text, /Read back:\n\s+ok\s+serena - local scope, local route \(serena\)/);
        // the slow half is handed to fetch.js, never run here: no download and no `claude mcp get` inside the apply
        assert.ok(!w.calls().some((a) => a[0] === 'mcp' && a[1] === 'get'), 'apply asks the CLI for no status');
        assert.deepStrictEqual(w.fetches(), [], 'apply runs no runtime');
        assert.match(r.text, /5\. later  serena: fetch serena-agent@/);
        // each root got its .gitignore first (R13): the project root for serena, the global root for playwright-chrome
        const { GITIGNORE } = require('../scripts/roots.js');
        for (const root of [path.join(w.project, '.preferred-tools'), path.join(w.home, '.preferred-tools')]) assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), GITIGNORE, root);
        assert.match(r.text, /Fetch next, in the background \(a first download can take minutes\): .*fetch\.json/);
        const job = readJson(r.report.fetchFile);
        assert.deepStrictEqual(job.fetch.map((s) => s.name), ['serena', 'playwright-chrome']);
        assert.deepStrictEqual(job.check, ['serena', 'playwright-chrome', 'context7'], 'every server written, the hosted one too');
        assert.match(r.text, /Restart Claude Code/);
        // the data folders got a .gitignore holding *: local scope in the project root, user scope in the global root
        assert.strictEqual(fs.readFileSync(path.join(w.project, '.preferred-tools', 'serena', '.gitignore'), 'utf8'), '*\n');
        assert.strictEqual(fs.readFileSync(path.join(w.home, '.preferred-tools', 'playwright-chrome', '.gitignore'), 'utf8'), '*\n');
        // the project's own .gitignore is never created or edited
        assert.ok(!fs.existsSync(path.join(w.project, '.gitignore')));
    }
    finally { w.clean(); }
});

test('a re-run with the same answers makes no CLI call and says so', () => {
    const w = world();
    try
    {
        const answers = { picks: { serena: {}, context7: { route: 'remote', scope: 'project' } } };
        const first = walk(w, answers);
        assert.strictEqual(first.report.failed, null, first.text);
        const before = w.calls().length;
        const beforeFiles = [fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8'), fs.readFileSync(account.accountFile(w.env), 'utf8')];
        const again = walk(w, answers);
        assert.strictEqual(again.p.noop, true);
        assert.strictEqual(again.report.noop, true);
        assert.match(again.text, /No claude call was made/);
        // the inventory reads (--version, plugin list) are not writes; apply itself spawned nothing
        const after = w.calls().slice(before);
        assert.ok(after.every((a) => a[0] === '--version' || a[0] === 'plugin'), JSON.stringify(after));
        assert.deepStrictEqual(w.writes().filter((a) => a[1] !== 'add-json').length, 0);
        assert.strictEqual(w.writes().length, 2, 'only the first run wrote');
        assert.deepStrictEqual([fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8'), fs.readFileSync(account.accountFile(w.env), 'utf8')], beforeFiles);
    }
    finally { w.clean(); }
});

test('a failure mid-apply stops there, leaves the earlier steps in place and names them', () => {
    const w = world();
    try
    {
        const r = walk(w, { picks: { context7: { route: 'remote', scope: 'project' }, gitlab: { scope: 'project' }, atlassian: { scope: 'project' } } }, { fail: 'add-json gitlab' });
        assert.ok(r.report.failed);
        assert.strictEqual(r.report.failed.op, 'mcp-add');
        assert.deepStrictEqual(Object.keys(mcpJson(w).mcpServers), ['context7'], 'the first add stays, the failed one and the one after it are absent');
        assert.match(r.text, /Stopped at step 2\. Already applied and left in place: 1 \(added 'context7' at project scope\)/);
        assert.match(r.text, /Not run: 3 mcp-add/);
        assert.ok(!w.calls().some((a) => a.includes('atlassian') && a[1] === 'add-json'), 'nothing after the failure ran');
    }
    finally { w.clean(); }
});

test('the fetch file holds only what was written: a failed add hands nothing of it to fetch.js', () => {
    const w = world();
    try
    {
        const r = walk(w, { picks: { serena: { scope: 'local' }, 'playwright-chrome': { scope: 'local' } } }, { fail: 'add-json playwright-chrome' });
        assert.strictEqual(r.report.failed.op, 'mcp-add');
        const job = readJson(r.report.fetchFile);
        assert.deepStrictEqual([job.fetch.map((s) => s.name), job.check], [['serena'], ['serena']]);
        // nothing written at all: no fetch file
        const none = walk(w, { picks: { 'playwright-firefox': { scope: 'local' } } }, { fail: 'add-json playwright-firefox' });
        assert.ok(none.report.failed);
        assert.strictEqual(none.report.fetchFile, null);
        assert.doesNotMatch(none.text, /Fetch next/);
    }
    finally { w.clean(); }
});

test('a same-name rewrite saves the old JSON first and re-adds it when the add fails', () => {
    const w = world();
    try
    {
        // the data in the project root, so the move to the global root (under the home) is the add that fails
        walk(w, { picks: { 'playwright-chrome': { scope: 'user', location: { side: 'project' } } } });
        const old = accountDoc(w).mcpServers['playwright-chrome'];
        // the home as the add-json argument spells it: a Windows path's backslashes are escaped in the JSON
        const r = walk(w, { change: { 'mcp:playwright-chrome~user': { location: { side: 'account' } } } }, { fail: JSON.stringify(w.home).slice(1, -1) });
        // every add-json carrying the new location (under the account home) fails; the old one is under the project and succeeds
        assert.ok(r.report.failed, r.text);
        assert.strictEqual(r.report.failed.op, 'mcp-replace');
        assert.match(r.report.failed.detail, /the old entry was re-added/);
        assert.deepStrictEqual(accountDoc(w).mcpServers['playwright-chrome'], old, 'the server is back as it was');
        const rollback = readJson(path.join(w.dir, 'tmp', 'rollback.json'));
        assert.deepStrictEqual(rollback.entry, old);
        assert.deepStrictEqual([rollback.name, rollback.scope], ['playwright-chrome', 'user']);
    }
    finally { w.clean(); }
});

test('when the re-add also fails the report prints the line that restores it by hand', () => {
    const w = world();
    try
    {
        walk(w, { picks: { appium: { scope: 'user', location: { side: 'project' } } } });
        const old = accountDoc(w).mcpServers['appium-mcp'];
        const r = walk(w, { change: { 'mcp:appium-mcp~user': { location: { side: 'account' } } } }, { fail: 'add-json appium-mcp' });
        assert.match(r.report.failed.detail, /RESTORE BY HAND: claude mcp add-json appium-mcp '/);
        assert.ok(r.report.failed.detail.includes(JSON.stringify(old).slice(0, 40)));
        assert.strictEqual(accountDoc(w).mcpServers['appium-mcp'], undefined);
    }
    finally { w.clean(); }
});

test('a rename adds the new name first, reads it back, then removes the old one; a failed add keeps the old', () => {
    const w = world();
    try
    {
        walk(w, { picks: { serena: { scope: 'user' } } });
        const calls0 = w.calls().length;
        const ok = walk(w, { change: { 'mcp:serena~user': { name: 'shop-serena' } } });
        assert.strictEqual(ok.report.failed, null, ok.text);
        assert.deepStrictEqual(Object.keys(accountDoc(w).mcpServers), ['shop-serena']);
        const order = w.calls().slice(calls0).filter((a) => a[0] === 'mcp').map((a) => `${a[1]} ${a[2]}`);
        assert.deepStrictEqual(order.slice(0, 2), ['add-json shop-serena', 'remove serena']);
        // a failed add leaves 'shop-serena' alone
        const bad = walk(w, { change: { 'mcp:shop-serena~user': { name: 'other-serena' } } }, { fail: 'add-json other-serena' });
        assert.ok(bad.report.failed);
        assert.deepStrictEqual(Object.keys(accountDoc(w).mcpServers), ['shop-serena']);
        assert.ok(!w.calls().some((a) => a[1] === 'remove' && a[2] === 'shop-serena'));
    }
    finally { w.clean(); }
});

test('a scope move re-reads the paths for the new scope and removes the old scope last', () => {
    const w = world();
    try
    {
        walk(w, { picks: { context7: { route: 'remote', scope: 'project' } } });
        const r = walk(w, { change: { 'mcp:context7~project': { scope: 'user' } } });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(mcpJson(w).mcpServers, {});
        assert.deepStrictEqual(Object.keys(accountDoc(w).mcpServers), ['context7']);
    }
    finally { w.clean(); }
});

test('a malformed .mcp.json: the CLI refuses, nothing is written there, and the failure is named', () => {
    const w = world();
    try
    {
        fs.writeFileSync(path.join(w.project, '.mcp.json'), '{ "mcpServers": ');
        const inv = inventory.buildInventory({ project: w.project, env: w.env });
        const p = plan(inv, { picks: { context7: { route: 'remote', scope: 'project' } } }, { home: w.home, env: w.env });
        assert.match(p.errors[0], /project scope is unreadable/);
        assert.strictEqual(p.steps.length, 0);
        assert.strictEqual(fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8'), '{ "mcpServers": ');
        assert.deepStrictEqual(w.writes(), []);
    }
    finally { w.clean(); }
});

test('remove runs one remove per pick at the scope shown and reads the absence back', () => {
    const w = world();
    try
    {
        walk(w, { picks: { serena: { scope: 'user' }, context7: { route: 'remote', scope: 'project' } } });
        const r = walk(w, { remove: [{ kind: 'mcp', name: 'serena', scope: 'user' }] });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(accountDoc(w).mcpServers, {});
        assert.deepStrictEqual(Object.keys(mcpJson(w).mcpServers), ['context7'], 'what was not picked stays');
        // the data folder stays: the report does not delete it (on Windows serena's home is <home>\.serena, serena-windows-home)
        assert.ok(fs.existsSync(path.join(w.home, '.preferred-tools', 'serena')));
    }
    finally { w.clean(); }
});

test('a user\'s own server beside the catalog\'s is never touched by any apply', () => {
    const w = world();
    try
    {
        writeJson(path.join(w.project, '.mcp.json'), { mcpServers: { mine: { command: 'node', args: ['server.js'] } } });
        walk(w, { picks: { context7: { route: 'remote', scope: 'project' } } });
        walk(w, { remove: [{ kind: 'mcp', name: 'context7', scope: 'project' }] });
        assert.deepStrictEqual(mcpJson(w), { mcpServers: { mine: { command: 'node', args: ['server.js'] } } });
        assert.ok(!w.calls().some((a) => a.includes('mine')));
    }
    finally { w.clean(); }
});

test('plugins: marketplace first, then the install at its scope, read back from the list and the settings file', () => {
    const w = world();
    try
    {
        const r = walk(w, { picks: { 'typescript-lsp': {}, 'claude-hud': {} }, hud: 'skip' }, { planOpts: {} });
        // the hud step needs hud-statusline.js (step 8); every step before it must have applied
        const done = r.report.applied.map((a) => a.op);
        assert.deepStrictEqual(done.slice(0, 4), ['plugin-marketplace-add', 'plugin-install', 'plugin-marketplace-add', 'plugin-install']);
        const calls = w.writes().filter((a) => a[0] === 'plugin').map((a) => a.join(' '));
        assert.deepStrictEqual(calls.slice(0, 2), ['plugin marketplace add anthropics/claude-plugins-official', 'plugin install typescript-lsp@claude-plugins-official --scope project']);
        assert.deepStrictEqual(readJson(path.join(w.project, '.claude', 'settings.json')).enabledPlugins, { 'typescript-lsp@claude-plugins-official': true });
        assert.deepStrictEqual(readJson(path.join(w.account, 'settings.json')).enabledPlugins, { 'claude-hud@claude-hud': true });
        // a second run never installs over the installed plugins
        const before = w.calls().filter((a) => a[1] === 'install').length;
        walk(w, { picks: { 'typescript-lsp': {} } });
        assert.strictEqual(w.calls().filter((a) => a[1] === 'install').length, before);
    }
    finally { w.clean(); }
});

test('a disabled plugin is enabled, not installed over; enable over enabled is skipped by the plan', () => {
    const w = world();
    try
    {
        walk(w, { picks: { 'csharp-lsp': {} } });
        // through claude-cli.js, which reaches the shim on Windows too (a bare spawn finds only a .exe or .com)
        cli.run(['plugin', 'disable', 'csharp-lsp@claude-plugins-official', '--scope', 'project'], { cwd: w.project, env: w.env });
        const before = w.calls().length;
        const r = walk(w, { picks: { 'csharp-lsp': {} } });
        assert.strictEqual(r.report.failed, null, r.text);
        const made = w.writes().slice(w.writes().length - 1).map((a) => a.join(' '));
        assert.deepStrictEqual(made, ['plugin enable csharp-lsp@claude-plugins-official --scope project']);
        const again = walk(w, { picks: { 'csharp-lsp': {} } });
        assert.strictEqual(again.report.noop, true);
    }
    finally { w.clean(); }
});

test('a plugin move installs at the new scope first and uninstalls the old copy last', () => {
    const w = world();
    try
    {
        walk(w, { picks: { 'csharp-lsp': { scope: 'user' } } });
        const before = w.calls().length;
        const r = walk(w, { change: { 'plugin:csharp-lsp@claude-plugins-official~user': { scope: 'project' } } });
        assert.strictEqual(r.report.failed, null, r.text);
        const made = w.writes().slice(-2).map((a) => a.slice(0, 3).join(' '));
        assert.deepStrictEqual(made, ['plugin install csharp-lsp@claude-plugins-official', 'plugin uninstall csharp-lsp@claude-plugins-official']);
        const inv = inventory.buildInventory({ project: w.project, env: w.env });
        assert.deepStrictEqual(inv.plugins.map((p) => p.scope), ['project']);
    }
    finally { w.clean(); }
});

test('no token value reaches any file the install wrote', () => {
    const w = world();
    try
    {
        const tokens = { GITHUB_PERSONAL_ACCESS_TOKEN: ['gh', 'p_', 'AAAA0123456789zzzzAAAA0123456789zzzz'].join(''), SENTRY_ACCESS_TOKEN: ['sntr', 'ys_', 'BBBB0123456789yyyyBBBB'].join(''), CONTEXT7_API_KEY: ['ctx7', 'sk-', 'CCCC0123456789xxxxCCCC'].join('') };
        const env = { ...w.env, ...tokens };
        const inv = inventory.buildInventory({ project: w.project, env });
        const answers = { picks: { github: { route: 'remote', scope: 'project' }, sentry: { route: 'local', scope: 'user' }, context7: { route: 'remote', scope: 'user', token: true }, gitlab: { scope: 'project' } } };
        const p = plan(inv, answers, { home: w.home, env });
        const report = apply(p, { env, tmp: path.join(w.dir, 'tmp'), log: () => {} });
        assert.strictEqual(report.failed, null);
        const files = [];
        const walkDir = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walkDir(path.join(d, e.name)) : files.push(path.join(d, e.name))));
        walkDir(w.dir);
        assert.ok(files.length > 3);
        for (const f of files)
        {
            const body = fs.readFileSync(f, 'utf8');
            for (const [name, value] of Object.entries(tokens)) assert.ok(!body.includes(value), `${name} value found in ${path.relative(w.dir, f)}`);
        }
        // a hosted key is read by mcp-headers.js when Claude Code connects: the committed entry names the helper, no key
        assert.deepStrictEqual(mcpJson(w).mcpServers.github, { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${path.join(w.project, '.preferred-tools', 'mcp-headers.js')} GITHUB_PERSONAL_ACCESS_TOKEN Bearer` });
        assert.strictEqual(accountDoc(w).mcpServers.sentry.env.SENTRY_ACCESS_TOKEN, '', 'a key in the shell is never written in: the apply reads .mcps-secrets only');
    }
    finally { w.clean(); }
});

test('the CLI form applies a written plan and exits 1 on a failure', () => {
    const w = world();
    try
    {
        const inv = inventory.buildInventory({ project: w.project, env: w.env });
        const p = plan(inv, { picks: { atlassian: { scope: 'project' } } }, { home: w.home, env: w.env });
        fs.writeFileSync(path.join(w.dir, 'plan.json'), JSON.stringify(p));
        const script = path.join(__dirname, '..', 'scripts', 'apply.js');
        const bad = spawnSync(process.execPath, [script, path.join(w.dir, 'plan.json'), '--tmp', path.join(w.dir, 'tmp')], { encoding: 'utf8', env: { ...w.env, FAKE_CLAUDE_FAIL: 'add-json atlassian' } });
        assert.strictEqual(bad.status, 1);
        assert.match(bad.stdout, /FAILED/);
        const ok = spawnSync(process.execPath, [script, path.join(w.dir, 'plan.json'), '--tmp', path.join(w.dir, 'tmp')], { encoding: 'utf8', env: w.env });
        assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
        assert.strictEqual(mcpJson(w).mcpServers.atlassian.url, 'https://mcp.atlassian.com/v2/mcp');
        const withErrors = { ...p, errors: ['x'] };
        fs.writeFileSync(path.join(w.dir, 'bad.json'), JSON.stringify(withErrors));
        assert.strictEqual(spawnSync(process.execPath, [script, path.join(w.dir, 'bad.json')], { encoding: 'utf8', env: w.env }).status, 1);
    }
    finally { w.clean(); }
});

// ---- live values and the temp folder (no live credential in a file a command line names) -------------------------------

const hex = (n) => crypto.randomBytes(n).toString('hex');
const register = (w, name, entry, scope = 'local') => assert.strictEqual(cli.run(['mcp', 'add-json', name, JSON.stringify(entry), '-s', scope], { cwd: w.project, env: w.env }).status, 0);
// the walk as the commands run it: the inventory as inventory.js writes it (every credential value kept), the plan from
// it, then the apply, which puts the real values back from the registrations it reads
function keptWalk(w, answers, { fail } = {})
{
    const env = { ...w.env };
    if (fail) env.FAKE_CLAUDE_FAIL = fail;
    const inv = inventory.keptOf(inventory.buildInventory({ project: w.project, env }));
    const p = plan(inv, answers, { home: w.home, env });
    const lines = [];
    const report = apply(p, { env, tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
    return { p, report, text: lines.join('\n') };
}

test('a configure move and an in-place replace of an entry with live values write them at the target and no file under <tmp> holds them', () => {
    const w = world();
    try
    {
        const token = `sntryu_${hex(16)}`;
        const key = `sk-live-${hex(16)}`;
        const sentry = { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: token } };
        register(w, 'sentry-live', sentry);
        // appium with a key the user added to its env; a location change rewrites it in place
        walk(w, { picks: { appium: { scope: 'user', location: { side: 'project' } } } });
        const appium = accountDoc(w).mcpServers['appium-mcp'];
        cli.run(['mcp', 'remove', 'appium-mcp', '-s', 'user'], { cwd: w.project, env: w.env });
        register(w, 'appium-mcp', { ...appium, env: { ...appium.env, APPIUM_API_KEY: key } }, 'user');
        const r = keptWalk(w, { change: { 'mcp:sentry-live~local': { name: 'sentry-moved' }, 'mcp:appium-mcp~user': { location: { side: 'account' } } } });
        assert.deepStrictEqual(r.p.errors, []);
        assert.deepStrictEqual(r.p.steps.filter((s) => s.op.startsWith('mcp-')).map((s) => s.op).sort(), ['mcp-move', 'mcp-replace']);
        const planText = JSON.stringify(r.p);
        assert.ok(planText.includes(MARKER) && !planText.includes(token) && !planText.includes(key), 'the plan carries the marker');
        assert.strictEqual(r.report.failed, null, r.text);
        const local = accountDoc(w).projects[accountKey(w.project)].mcpServers;
        assert.deepStrictEqual(local['sentry-moved'], sentry, 'the real value at the target');
        assert.strictEqual(local['sentry-live'], undefined);
        const moved = accountDoc(w).mcpServers['appium-mcp'];
        assert.strictEqual(moved.env.APPIUM_API_KEY, key, 'the in-place rewrite keeps the real key');
        assert.notDeepStrictEqual(moved.env.SCREENSHOTS_DIR, appium.env.SCREENSHOTS_DIR, 'the location changed');
        const tmp = files(path.join(w.dir, 'tmp'));
        assert.ok(tmp.some((f) => f.endsWith('rollback.json')), 'the replace saved its rollback file');
        for (const f of tmp) for (const v of [token, key]) assert.ok(!fs.readFileSync(f, 'utf8').includes(v), `a live value in ${path.basename(f)}`);
        for (const v of [token, key]) assert.ok(!r.text.includes(v), 'nothing printed holds a live value');
    }
    finally { w.clean(); }
});

test('a failed replace prints a restore line with the marker, never the value', () => {
    const w = world();
    try
    {
        const key = `ctx7sk-${hex(8)}-${hex(8)}`;
        register(w, 'context7', { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { 'X-API-Key': key } });
        const r = keptWalk(w, { change: { 'mcp:context7~local': { token: true } } }, { fail: 'add-json context7' });
        assert.strictEqual(r.report.failed.op, 'mcp-replace');
        assert.match(r.report.failed.detail, /RESTORE BY HAND: claude mcp add-json context7 '.*"X-API-Key":"\$\{PREFERRED_TOOLS_KEPT\}".*' -s local/);
        assert.match(r.report.failed.detail, /put the real value back in place of \$\{PREFERRED_TOOLS_KEPT\}/);
        assert.ok(!r.text.includes(key) && !r.report.failed.detail.includes(key));
        for (const f of files(path.join(w.dir, 'tmp'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(key));
    }
    finally { w.clean(); }
});

test('a registration changed since it was read is not written over', () => {
    const w = world();
    try
    {
        register(w, 'context7', { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { 'X-API-Key': `ctx7sk-${hex(8)}-${hex(8)}` } });
        const inv = inventory.keptOf(inventory.buildInventory({ project: w.project, env: w.env }));
        const p = plan(inv, { change: { 'mcp:context7~local': { token: true } } }, { home: w.home, env: w.env });
        // the key is taken out of the registration between the read and the apply
        cli.run(['mcp', 'remove', 'context7', '-s', 'local'], { cwd: w.project, env: w.env });
        register(w, 'context7', { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { 'X-API-Key': '${CONTEXT7_API_KEY}' } });
        const before = w.writes().length;
        const report = apply(p, { env: w.env, tmp: path.join(w.dir, 'tmp'), log: () => {} });
        assert.match(report.failed.detail, /'context7' changed since it was read - run the command again/);
        assert.strictEqual(w.writes().length, before, 'no CLI write');
    }
    finally { w.clean(); }
});

test('apply removes <tmp> when no fetch follows', () => {
    const w = world();
    try
    {
        const t = tempOf(w);
        const script = path.join(__dirname, '..', 'scripts', 'apply.js');
        const run = (picks) =>
        {
            const dir = t.made();
            const p = plan(inventory.buildInventory({ project: w.project, env: w.env }), { picks }, { home: w.home, env: w.env });
            fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(p));
            const r = spawnSync(process.execPath, [script, path.join(dir, 'plan.json'), '--tmp', dir], { encoding: 'utf8', env: t.env });
            assert.strictEqual(r.status, 0, r.stdout + r.stderr);
            return { dir, r };
        };
        const hosted = run({ atlassian: { scope: 'project' } });
        assert.ok(!fs.existsSync(hosted.dir), 'nothing handed on: the folder is gone');
        const fetched = run({ serena: { scope: 'local' } });
        assert.ok(fs.existsSync(path.join(fetched.dir, 'fetch.json')), 'a fetch file handed on keeps the folder for fetch.js');
        assert.match(fetched.r.stdout, /Fetch next/);
    }
    finally { w.clean(); }
});

test('apply never removes a --tmp it did not make', () => {
    const w = world();
    try
    {
        const t = tempOf(w);
        const script = path.join(__dirname, '..', 'scripts', 'apply.js');
        // beside the temp folder, and in it under another name
        for (const [dir, tool] of [[path.join(w.dir, 'mine'), 'atlassian'], [t.made('other-'), 'gitlab']])
        {
            const p = plan(inventory.buildInventory({ project: w.project, env: w.env }), { picks: { [tool]: { scope: 'project' } } }, { home: w.home, env: w.env });
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(p));
            const r = spawnSync(process.execPath, [script, path.join(dir, 'plan.json'), '--tmp', dir], { encoding: 'utf8', env: t.env });
            assert.strictEqual(r.status, 0, r.stdout + r.stderr);
            assert.ok(fs.existsSync(path.join(dir, 'plan.json')), `${path.basename(dir)} is left`);
            assert.match(r.stdout, /left as it is/);
        }
    }
    finally { w.clean(); }
});

test('tmpdir sweeps only its own folders older than 24 hours', () => {
    const w = world();
    try
    {
        const t = tempOf(w);
        const old = t.made();
        const fresh = t.made();
        const other = t.made('other-');
        const day = new Date(Date.now() - 25 * 3600 * 1000);
        for (const d of [old, other]) fs.utimesSync(d, day, day);
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'tmpdir.js')], { encoding: 'utf8', env: t.env });
        assert.strictEqual(r.status, 0, r.stderr);
        const made = r.stdout.trim();
        assert.strictEqual(path.dirname(made), fs.realpathSync(t.root));
        assert.match(path.basename(made), /^preferred-tools-/);
        assert.ok(fs.existsSync(made));
        assert.ok(!fs.existsSync(old), 'its own folder older than 24 hours is swept');
        assert.ok(fs.existsSync(fresh), 'a newer one is left');
        assert.ok(fs.existsSync(other), 'another program\'s folder is left');
    }
    finally { w.clean(); }
});

// ---- key files (D7): the key is written in by the target scope, from the file the scope reads ----------------------

const S = 'SENTRY_ACCESS_TOKEN';
const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';
// alfred-code enabled for every project, as `claude plugin list` and the user settings report it
function alfredOn(w)
{
    writeJson(path.join(w.dir, 'state', 'plugins.json'), { marketplaces: [], installed: [{ id: 'alfred-code@envoydev', version: '3.2.1', scope: 'user', enabled: true, installPath: '/c' }] });
    writeJson(path.join(w.account, 'settings.json'), { enabledPlugins: { 'alfred-code@envoydev': true } });
}
const noValueIn = (w, r, values) =>
{
    for (const f of files(path.join(w.dir, 'tmp'))) for (const v of values) assert.ok(!fs.readFileSync(f, 'utf8').includes(v), `a key value in ${path.basename(f)}`);
    for (const v of values) assert.ok(!r.text.includes(v) && !JSON.stringify(r.p).includes(v), 'no key value printed or in the plan');
};

test('a stdio key at local scope is written in from the key file, a hosted route at project scope gets the helper and no ${VAR}, and no file under <tmp> holds the value', () => {
    const w = world();
    try
    {
        const [s, g] = [`s%^"${hex(12)}`, `g-${hex(12)}`];
        mcps(path.join(w.project, '.preferred-tools'), { [S]: s, [G]: g });
        const r = walk(w, { picks: { sentry: { route: 'local', scope: 'local' }, github: { route: 'remote', scope: 'project' } } });
        assert.deepStrictEqual(r.p.errors, []);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(accountDoc(w).projects[accountKey(w.project)].mcpServers.sentry.env[S], s, 'the value, as the file holds it');
        assert.deepStrictEqual(mcpJson(w).mcpServers.github, { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${path.join(w.project, '.preferred-tools', 'mcp-headers.js')} ${G} Bearer` }, 'the project file names the helper by absolute path');
        assert.ok(r.text.includes(`${S} for 'sentry' (local) from ${path.join(w.project, '.preferred-tools', '.mcps-secrets')}`), r.text);
        noValueIn(w, r, [s, g]);
    }
    finally { w.clean(); }
});

test('a configure move local -> project of a github remote re-adds its helper with an absolute path and no ${VAR}; an old Authorization header is refused there', () => {
    const w = world();
    try
    {
        const helper = (p) => `node ${p} ${G} Bearer`;
        register(w, 'github', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: helper(path.join(w.project, '.preferred-tools', 'mcp-headers.js')) });
        const r = keptWalk(w, { change: { 'mcp:github~local': { scope: 'project' } } });
        assert.deepStrictEqual(r.p.errors, []);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(mcpJson(w).mcpServers.github, { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: helper(path.join(w.project, '.preferred-tools', 'mcp-headers.js')) });
        assert.ok(!fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8').includes('${'));
        assert.strictEqual((accountDoc(w).projects[accountKey(w.project)].mcpServers || {}).github, undefined, 'the local one is gone');
        // a 0.1.x registration holding the key in its header: never carried into the committed file (fix moves it first)
        const g = `g-${hex(12)}`;
        register(w, 'gh-old', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${g}` } });
        const old = keptWalk(w, { change: { 'mcp:gh-old~local': { scope: 'project' } } });
        assert.match(old.p.errors.join(), /'gh-old' holds a credential in headers\.Authorization, which the committed \.mcp\.json must not carry - keep it at local scope, or run \/preferred-tools:fix first: key-to-helper moves the key into mcp-headers\.js/);
        assert.ok(!fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8').includes(g));
        noValueIn(w, old, [g]);
    }
    finally { w.clean(); }
});

test('a configure move to project scope is refused while the entry holds a credential no route field takes - a header of the user\'s own never reaches .mcp.json', () => {
    const w = world();
    try
    {
        const [k, x, u] = [`ctx7sk-${hex(12)}`, `x-${hex(12)}`, `glpat-${hex(12)}`];
        register(w, 'context7', { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: k } });
        register(w, 'ctx-x', { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { 'X-API-Key': x } });
        register(w, 'gitlab', { type: 'http', url: `https://dev:${u}@gitlab.com/api/v4/mcp` });
        const r = keptWalk(w, { change: { 'mcp:context7~local': { scope: 'project' }, 'mcp:ctx-x~local': { scope: 'project' }, 'mcp:gitlab~local': { scope: 'project' } } });
        assert.strictEqual(r.p.errors.length, 3, r.p.errors.join('\n'));
        assert.match(r.p.errors[0], /context7: 'context7' holds a credential in headers\.CONTEXT7_API_KEY, which the committed \.mcp\.json must not carry/);
        assert.match(r.p.errors[1], /context7: 'ctx-x' holds a credential in headers\.X-API-Key/);
        assert.match(r.p.errors[2], /gitlab: 'gitlab' holds a credential in url, which the committed \.mcp\.json must not carry - keep it at local scope, or take it out of url first/);
        assert.ok(!r.p.errors.some((e) => /\$\{VAR\}/.test(e)), 'a key never becomes a ${VAR} in the committed file');
        assert.ok(!fs.existsSync(path.join(w.project, '.mcp.json')) || ![k, x, u].some((v) => fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8').includes(v)));
        const local = accountDoc(w).projects[accountKey(w.project)].mcpServers;
        assert.deepStrictEqual(Object.keys(local).sort(), ['context7', 'ctx-x', 'gitlab'], 'each stays where it is');
        noValueIn(w, r, [k, x, u]);
    }
    finally { w.clean(); }
});

test('a configure move local -> user points the helper into the global root and keeps the name it passes', () => {
    const w = world();
    try
    {
        register(w, 'github', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${path.join(w.project, '.preferred-tools', 'mcp-headers.js')} ACME_GITHUB_TOKEN Bearer` });
        const r = keptWalk(w, { change: { 'mcp:github~local': { scope: 'user' } } });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(accountDoc(w).mcpServers.github, { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${path.join(w.home, '.preferred-tools', 'mcp-headers.js')} ACME_GITHUB_TOKEN Bearer` });
        assert.deepStrictEqual(r.p.keys.map((k) => [k.variable, k.scope, k.files[0]]), [['ACME_GITHUB_TOKEN', 'user', path.join(w.home, '.preferred-tools', '.mcps-secrets')]]);
    }
    finally { w.clean(); }
});

test('a failed add prints a key the apply wrote in as the marker, never the value - raw or JSON-escaped', () => {
    const w = world();
    try
    {
        const s = `s%^"\\${hex(12)}`;
        mcps(path.join(w.project, '.preferred-tools'), { [S]: s });
        const r = walk(w, { picks: { sentry: { route: 'local', scope: 'local' } } }, { fail: 'add-json sentry' });
        assert.strictEqual(r.report.failed.op, 'mcp-add');
        assert.match(r.report.failed.detail, /injected failure/, 'the CLI output is still shown');
        assert.ok(r.report.failed.detail.includes(MARKER), r.report.failed.detail);
        noValueIn(w, r, [s, JSON.stringify(s).slice(1, -1)]);
        assert.ok(!r.report.failed.detail.includes(s) && !r.report.failed.detail.includes(JSON.stringify(s).slice(1, -1)));
    }
    finally { w.clean(); }
});

test('a missing key writes an empty value, never a ${VAR}, and the note names the file to fill', () => {
    const w = world();
    try
    {
        const r = walk(w, { picks: { sentry: { route: 'local', scope: 'local' } } });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(accountDoc(w).projects[accountKey(w.project)].mcpServers.sentry.env[S], '');
        assert.ok(r.text.includes(`fill ${S} in ${path.join(w.project, '.preferred-tools', '.mcps-secrets')}, then run /preferred-tools:configure and keep ${S} as the key's name - it writes the key in`), r.text);
    }
    finally { w.clean(); }
});

test('a configure of a filled global registration reads only the global root\'s key file: a project\'s store never swaps its key', () => {
    const w = world();
    try
    {
        alfredOn(w);
        const [live, other, home] = [`a-${hex(12)}`, `b-${hex(12)}`, `c-${hex(12)}`];
        fs.mkdirSync(path.join(w.project, '.alfred'), { recursive: true });
        fs.writeFileSync(path.join(w.project, '.alfred', ['.', 'secrets'].join('')), `${S}=${other}\n`);
        mcps(path.join(w.project, '.preferred-tools'), { [S]: other });
        register(w, 'sentry', { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { [S]: live } }, 'user');
        const r = keptWalk(w, { change: { 'mcp:sentry~user': { name: 'sentry-2' } } });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(accountDoc(w).mcpServers['sentry-2'].env[S], live, "this project's files never swap the key of a server for every project");
        assert.match(r.text, /SENTRY_ACCESS_TOKEN for 'sentry-2' \(user\) is in none of .* - the key it holds is kept/);
        mcps(path.join(w.home, '.preferred-tools'), { [S]: home });
        const h = keptWalk(w, { change: { 'mcp:sentry-2~user': { name: 'sentry' } } });
        assert.strictEqual(h.report.failed, null, h.text);
        assert.strictEqual(accountDoc(w).mcpServers.sentry.env[S], home, 'the global root\'s file changes it');
        noValueIn(w, h, [live, other, home]);
    }
    finally { w.clean(); }
});

// ---- 0.2.0: the key's name, the stdio chain and the server's settings (spec D9, plan R1 and R7) ----------------------
const mcps = (dir, pairs) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, '.mcps-secrets'), Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join('')); };
const DOCKER = { command: 'docker', args: ['run', '-i', '--rm', '-e', G, 'ghcr.io/github/github-mcp-server:v2.1.0', 'stdio'] };
// the fake CLI's calls.jsonl stands in for the claude process: it records the argv, and a key reaches the account file
// only through add-json's argument (the CLI is the only writer)
const onlyIn = (w, value, allowed) =>
{
    const hits = files(w.dir).filter((f) => path.basename(f) !== 'calls.jsonl' && fs.readFileSync(f, 'utf8').includes(value));
    assert.deepStrictEqual(hits.sort(), allowed.sort(), 'the value is only where it belongs');
};

test('configure recommends the name the registration uses', () => {
    const w = world();
    try
    {
        const live = `live-${hex(12)}`;
        register(w, 'github', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: `node ${path.join(w.project, '.preferred-tools', 'mcp-headers.js')} ACME_GITHUB_TOKEN Bearer` });
        register(w, 'gh-docker', { ...DOCKER, env: { [G]: live } });
        mcps(path.join(w.project, '.preferred-tools'), { [G]: `other-${hex(8)}`, MY_GITHUB_TOKEN: live });
        // the questions read the inventory file the command passes - masked - and the live registration in-process
        const inv = inventory.keptOf(inventory.buildInventory({ project: w.project, env: w.env }));
        assert.ok(!JSON.stringify(inv).includes(live), 'the inventory is masked');
        const q = require('../scripts/asks.js').all(inv, { targets: ['mcp:github~local', 'mcp:gh-docker~local'] }, require('../scripts/catalog.js').load(), { env: w.env, home: w.home });
        assert.strictEqual(q.keyNames['mcp:github~local'].question.options[0].label, 'ACME_GITHUB_TOKEN (Recommended)', 'the helper\'s argument');
        assert.strictEqual(q.keyNames['mcp:gh-docker~local'].question.options[0].label, 'MY_GITHUB_TOKEN (Recommended)', 'the name whose value equals the written-in key');
        assert.ok(!JSON.stringify(q).includes(live));
        assert.strictEqual(q.settings['mcp:gh-docker~local'].question.options[0].label, 'No settings (Recommended)');
        assert.strictEqual(q.settings['mcp:github~local'], undefined, 'a hosted route takes no settings');
    }
    finally { w.clean(); }
});

test('unfilled at install, filled later, configure keeping the name writes the key in', () => {
    const w = world();
    try
    {
        const first = walk(w, { picks: { github: { route: 'local', scope: 'local' } }, keyNames: { github: 'ACME_GITHUB_TOKEN' } });
        assert.strictEqual(first.report.failed, null, first.text);
        const file = path.join(w.project, '.preferred-tools', '.mcps-secrets');
        assert.strictEqual(accountDoc(w).projects[accountKey(w.project)].mcpServers.github.env[G], '');
        assert.ok(first.text.includes(`fill ACME_GITHUB_TOKEN in ${file}, then run /preferred-tools:configure and keep ACME_GITHUB_TOKEN as the key's name - it writes the key in`), first.text);
        const value = `acme-${hex(12)}`;
        mcps(path.dirname(file), { ACME_GITHUB_TOKEN: value });
        const answers = { change: { 'mcp:github~local': {} }, keyNames: { 'mcp:github~local': 'ACME_GITHUB_TOKEN' } };
        const r = keptWalk(w, answers);
        assert.deepStrictEqual(r.p.steps.filter((s) => s.op.startsWith('mcp-')).map((s) => [s.op, s.key]), [['mcp-replace', { name: 'ACME_GITHUB_TOKEN', files: [file, path.join(w.home, '.preferred-tools', '.mcps-secrets')] }]]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(accountDoc(w).projects[accountKey(w.project)].mcpServers.github.env[G], value);
        noValueIn(w, r, [value]);
        const again = keptWalk(w, answers);
        assert.deepStrictEqual(again.p.steps.filter((s) => s.op.startsWith('mcp-')), [], 'the key it holds equals the filled one');
        assert.strictEqual(again.p.unchanged.length, 1);
    }
    finally { w.clean(); }
});

test('the apply writes a stdio key from the stdio chain under the chosen name; not filled gives an empty value and a note, never a ${VAR}', () => {
    const w = world();
    try
    {
        const s = `s-${hex(12)}`;
        const file = path.join(w.project, '.preferred-tools', '.mcps-secrets');
        mcps(path.dirname(file), { ACME_SENTRY_TOKEN: s });
        const r = walk(w, { picks: { sentry: { route: 'local', scope: 'local' } }, keyNames: { sentry: 'ACME_SENTRY_TOKEN' } });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(accountDoc(w).projects[accountKey(w.project)].mcpServers.sentry.env[S], s);
        assert.ok(r.text.includes(`ACME_SENTRY_TOKEN for 'sentry' (local) from ${file}`), r.text);
        noValueIn(w, r, [s]);
        onlyIn(w, s, [file, account.accountFile(w.env)]);
        // not filled: an empty value and the note, at global scope from the global root's file
        const u = walk(w, { picks: { github: { route: 'local', scope: 'user' } } });
        assert.strictEqual(u.report.failed, null, u.text);
        assert.strictEqual(accountDoc(w).mcpServers.github.env[G], '');
        assert.ok(u.text.includes(`fill ${G} in ${path.join(w.home, '.preferred-tools', '.mcps-secrets')}, then run /preferred-tools:configure`), u.text);
        assert.ok(!JSON.stringify(accountDoc(w)).includes(`\${${G}}`) && !JSON.stringify(accountDoc(w)).includes(`\${${S}}`), 'never a ${VAR}');
    }
    finally { w.clean(); }
});

test('a replace or a move keeps the stdio key the registration holds when the chain has none', () => {
    const w = world();
    try
    {
        const old = `fake-old-${hex(12)}`;
        register(w, 'github', { ...DOCKER, env: { [G]: old } });
        const file = path.join(w.project, '.preferred-tools', '.mcps-secrets');
        const r = keptWalk(w, { change: { 'mcp:github~local': {} }, settings: { 'mcp:github~local': { GITHUB_TOOLSETS: 'repos' } } });
        assert.deepStrictEqual(r.p.steps.filter((s) => s.op.startsWith('mcp-')).map((s) => s.op), ['mcp-replace']);
        assert.strictEqual(r.report.failed, null, r.text);
        let e = accountDoc(w).projects[accountKey(w.project)].mcpServers.github;
        assert.deepStrictEqual([e.env[G], e.env.GITHUB_TOOLSETS], [old, 'repos']);
        assert.ok(r.text.includes(`${G} for 'github' (local) is in none of ${file}`) && r.text.includes(`the key it holds is kept; fill ${G} in ${file} to replace it`), r.text);
        const m = keptWalk(w, { change: { 'mcp:github~local': { name: 'gh2' } } });
        assert.strictEqual(m.report.failed, null, m.text);
        e = accountDoc(w).projects[accountKey(w.project)].mcpServers;
        assert.deepStrictEqual([e.gh2.env[G], e.github], [old, undefined]);
        for (const x of [r, m]) noValueIn(w, x, [old]);
        // a ${VAR} is no value: never carried to local or global scope
        register(w, 'gh-var', { ...DOCKER, env: { [G]: `\${${G}}` } }, 'project');
        const v = keptWalk(w, { change: { 'mcp:gh-var~project': { scope: 'user' } } });
        assert.strictEqual(v.report.failed, null, v.text);
        assert.strictEqual(accountDoc(w).mcpServers['gh-var'].env[G], '');
    }
    finally { w.clean(); }
});

// ---- 0.2.0: the apply's file steps (spec D2-D4, D6, D8; plan R8, R13) -------------------------------------------------
const HELPER_SRC = path.join(__dirname, '..', 'scripts', 'mcp-headers.js');
const KEY_HEAD = '# preferred-tools MCP keys - fill in each value; this file is never committed';
function runSteps(w, list, opts = {})
{
    const lines = [];
    const report = apply({ version: 1, project: w.project, steps: list, errors: [] }, { env: w.env, tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')), ...opts });
    return { report, text: lines.join('\n') };
}
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

test('write-helper: absent is written; a lower number is rewritten; the same number is left; a higher number is left with the note', () => {
    const w = world();
    try
    {
        const src = fs.readFileSync(HELPER_SRC, 'utf8');
        const root = path.join(w.project, '.preferred-tools');
        const dest = path.join(root, 'mcp-headers.js');
        const step = { op: 'write-helper', path: root };
        let r = runSteps(w, [step]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), src);
        const HV = require('../scripts/mcp-headers.js').HELPER_VERSION;
        assert.ok(r.text.includes(`wrote ${dest} (helper ${HV})`), r.text);
        fs.writeFileSync(dest, src.replace(/^\/\/ preferred-tools mcp-headers \d+/, '// preferred-tools mcp-headers 0'));
        r = runSteps(w, [step]);
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), src);
        assert.ok(r.text.includes(`rewrote ${dest} (helper 0 -> ${HV})`), r.text);
        r = runSteps(w, [step]);
        assert.ok(r.text.includes(`${dest} is up to date - left as it is`), r.text);
        const edited = `${src}// mine\n`;
        fs.writeFileSync(dest, edited);
        r = runSteps(w, [step]);
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), edited);
        assert.ok(r.text.includes(`${dest} changed since preferred-tools wrote it - left; /preferred-tools:fix rewrites it`), r.text);
        const newer = src.replace(/^\/\/ preferred-tools mcp-headers \d+/, '// preferred-tools mcp-headers 9');
        fs.writeFileSync(dest, newer);
        r = runSteps(w, [step]);
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), newer);
        assert.ok(r.text.includes(`mcp-headers.js in ${root} is newer than this plugin - update preferred-tools`), r.text);
        assert.strictEqual(r.report.failed, null);
    }
    finally { w.clean(); }
});

test('write-helper leaves a CRLF copy of the same helper as it is', () => {
    const w = world();
    try
    {
        const root = path.join(w.project, '.preferred-tools');
        const crlf = fs.readFileSync(HELPER_SRC, 'utf8').replace(/\n/g, '\r\n');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'mcp-headers.js'), crlf);
        const r = runSteps(w, [{ op: 'write-helper', path: root }]);
        assert.strictEqual(fs.readFileSync(path.join(root, 'mcp-headers.js'), 'utf8'), crlf);
        assert.match(r.text, /is up to date - left as it is/);
    }
    finally { w.clean(); }
});

test('ensure-key-name: names appended, existing lines byte-identical, no value written, refused when git would not ignore the file', () => {
    const w = world();
    try
    {
        const root = path.join(w.project, '.preferred-tools');
        const file = path.join(root, '.mcps-secrets');
        let r = runSteps(w, [{ op: 'ensure-key-name', file, names: [G, 'CONTEXT7_API_KEY'] }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), `${KEY_HEAD}\n${G}=\nCONTEXT7_API_KEY=\n`);
        assert.match(r.text, /names only, you fill in each value/);
        // an existing file: each line byte-identical, the missing name appended in the file's own line ending
        const mine = `# mine\r\n${G}=fake-${hex(6)}\r\nexport OTHER="x"`;
        fs.writeFileSync(file, mine);
        r = runSteps(w, [{ op: 'ensure-key-name', file, names: [G, S] }]);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), `${mine}\r\n${S}=\r\n`);
        assert.ok(r.text.includes(`appended ${S}= to ${file} - names only`), r.text);
        r = runSteps(w, [{ op: 'ensure-key-name', file, names: [G] }]);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), `${mine}\r\n${S}=\r\n`, 'nothing missing: left');
        // inside a git work tree that would commit it: refused, nothing written
        assert.strictEqual(git(w.project, 'init', '-q').status, 0);
        const loose = path.join(w.project, 'keys', '.mcps-secrets');
        r = runSteps(w, [{ op: 'ensure-key-name', file: loose, names: [G] }]);
        assert.strictEqual(r.report.failed.op, 'ensure-key-name');
        assert.ok(r.report.failed.detail.includes(`git would commit ${loose} - not written`), r.report.failed.detail);
        assert.ok(!fs.existsSync(loose));
        // the root's .gitignore makes git ignore it
        r = runSteps(w, [{ op: 'root-ignore', path: root }, { op: 'ensure-key-name', file, names: ['NEW_GITHUB_TOKEN'] }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.ok(fs.readFileSync(file, 'utf8').endsWith('NEW_GITHUB_TOKEN=\r\n'));
    }
    finally { w.clean(); }
});

test('ensure-key-name creates the key file readable by its owner only', { skip: process.platform === 'win32' }, () => {
    const w = world();
    try
    {
        const file = path.join(w.project, '.preferred-tools', '.mcps-secrets');
        runSteps(w, [{ op: 'ensure-key-name', file, names: [G] }]);
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        fs.chmodSync(file, 0o640);
        runSteps(w, [{ op: 'ensure-key-name', file, names: [S] }]);
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640, "an existing file's mode is the user's");
    }
    finally { w.clean(); }
});

test('root-ignore: written once, left when present, never under .alfred', () => {
    const w = world();
    try
    {
        const { GITIGNORE } = require('../scripts/roots.js');
        const root = path.join(w.project, '.preferred-tools');
        const file = path.join(root, '.gitignore');
        let r = runSteps(w, [{ op: 'root-ignore', path: root }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), GITIGNORE);
        r = runSteps(w, [{ op: 'root-ignore', path: root }]);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), GITIGNORE);
        assert.ok(r.text.includes(`${file} has every line it needs - left as it is`), r.text);
        // a 0.1.x .gitignore holding *: the lines it lacks appended, none rewritten
        fs.writeFileSync(file, '*\n');
        runSteps(w, [{ op: 'root-ignore', path: root }]);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '*\n!.gitignore\n!mcp-headers.js\n');
        // a folder holding the user's own files: only the key file and the record, never *
        const named = path.join(w.project, 'tools');
        fs.mkdirSync(named, { recursive: true });
        fs.writeFileSync(path.join(named, 'notes.txt'), 'mine');
        runSteps(w, [{ op: 'root-ignore', path: named }]);
        assert.strictEqual(fs.readFileSync(path.join(named, '.gitignore'), 'utf8'), '.mcps-secrets\npreferred-tools.json\n');
        // .alfred is alfred-code's: nothing written
        const alfred = path.join(w.project, '.alfred');
        r = runSteps(w, [{ op: 'root-ignore', path: alfred }]);
        assert.strictEqual(r.report.failed, null);
        assert.ok(!fs.existsSync(path.join(alfred, '.gitignore')));
        assert.match(r.text, /alfred-code's - its own \.gitignore covers it/);
    }
    finally { w.clean(); }
});

test('record-root: the entry written, a second project beside it, the key normalised', () => {
    const w = world();
    try
    {
        const roots = require('../scripts/roots.js');
        const data = path.join(w.dir, 'data');
        const other = path.join(w.dir, 'other');
        fs.mkdirSync(other, { recursive: true });
        const r1 = path.join(w.project, 'keys-root');
        let r = runSteps(w, [{ op: 'record-root', family: 'project', project: `${w.project}${path.sep}.${path.sep}`, root: r1 }], { data });
        assert.strictEqual(r.report.failed, null, r.text);
        const file = path.join(data, 'roots.json');
        assert.deepStrictEqual(readJson(file), { version: 1, global: null, projects: { [roots.mapKey(w.project)]: r1 } });
        runSteps(w, [{ op: 'record-root', family: 'project', project: other, root: path.join(other, '.preferred-tools') }, { op: 'record-root', family: 'global', project: other, root: path.join(w.home, 'keys') }], { data });
        assert.deepStrictEqual(readJson(file), { version: 1, global: path.join(w.home, 'keys'), projects: { [roots.mapKey(w.project)]: r1, [roots.mapKey(other)]: path.join(other, '.preferred-tools') } });
        // without --data (R8): ok, with the note
        r = runSteps(w, [{ op: 'record-root', family: 'project', project: w.project, root: r1 }]);
        assert.strictEqual(r.report.failed, null);
        assert.match(r.text, /no plugin data folder given - the root is found from its files next time/);
    }
    finally { w.clean(); }
});

test('record-clean writes the own entries live still has, in order; a key in keep and in entries takes the entries one', () => {
    const w = world();
    try
    {
        const roots = require('../scripts/roots.js');
        const file = path.join(w.project, '.preferred-tools', 'preferred-tools.json');
        const a = { name: 'a', scope: 'local', fingerprint: { pkg: 'x' }, choice: 'own' };
        const gone = { name: 'gone', scope: 'local', fingerprint: { pkg: 'y' }, choice: 'own' };
        const moved = { name: 'moved', scope: 'local', fingerprint: { pkg: 'old' }, choice: 'own' };
        const plug = { plugin: 'p@m', server: 's', fingerprint: { host: 'h' }, choice: 'add' };
        const conn = { connector: 'Notion', choice: 'own' };
        const b = { name: 'b', scope: 'user', fingerprint: { pkg: 'z' }, choice: 'manage' };
        const live = { servers: { 'mcp:a~local': { pkg: 'x' }, 'mcp:b~user': { pkg: 'z' }, 'mcp:moved~local': { pkg: 'new' }, 'plugin-mcp:p@m/s': { host: 'h' } }, connectors: null };
        let r = runSteps(w, [{ op: 'record-clean', file, entries: [a, gone, moved, 'junk', plug, conn, b], keep: [], live }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(readJson(file), { version: 1, servers: [a, conn] }, 'gone, moved, junk, add and manage dropped; the connector kept with no list');
        // a run that passed the connectors drops one it lacks (R14)
        runSteps(w, [{ op: 'record-clean', file, entries: [a, conn], keep: [], live: { ...live, connectors: ['Linear'] } }]);
        assert.deepStrictEqual(readJson(file).servers.map(roots.recordKey), ['mcp:a~local']);
        // keep is written as it is, before the entries; a key in both takes the entries one
        const x = { name: 'x', scope: 'project', fingerprint: { pkg: 'q' }, choice: 'own' };
        runSteps(w, [{ op: 'record-clean', file, entries: [a], keep: [x, { ...a, fingerprint: { pkg: 'stale' } }], live }]);
        assert.deepStrictEqual(readJson(file).servers, [x, a]);
        assert.deepStrictEqual([roots.recordKey(a), roots.recordKey(plug), roots.recordKey(conn), roots.recordKey({ x: 1 })], ['mcp:a~local', 'plugin-mcp:p@m/s', 'connector:Notion', null]);
    }
    finally { w.clean(); }
});

test('record-clean writes own entries only, deletes an empty record, and never touches a file that is not this plugin\'s record', () => {
    const w = world();
    try
    {
        const file = path.join(w.project, '.preferred-tools', 'preferred-tools.json');
        const manage = { name: 'm', scope: 'local', fingerprint: 'pkg:m', choice: 'manage' };
        const add = { plugin: 'p@m', server: 's', fingerprint: 'url:h', choice: 'add' };
        const own = { name: 'o', scope: 'local', fingerprint: 'pkg:o', choice: 'own' };
        const live = { servers: { 'mcp:m~local': 'pkg:m', 'plugin-mcp:p@m/s': 'url:h', 'mcp:o~local': 'pkg:o' }, connectors: null };
        writeJson(file, { version: 1, servers: [manage, add] });
        let r = runSteps(w, [{ op: 'record-clean', file, entries: [], keep: [], live }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.ok(!fs.existsSync(file), 'a record left with nothing is deleted');
        assert.ok(r.text.includes(`removed ${file} - no server is left on its own`), r.text);
        // not there: nothing to write
        r = runSteps(w, [{ op: 'record-clean', file, entries: [], keep: [], live }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.ok(!fs.existsSync(file));
        // another tool's JSON under this name: byte-identical afterwards
        fs.writeFileSync(file, '{"foo":1}');
        r = runSteps(w, [{ op: 'record-clean', file, entries: [], keep: [], live }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"foo":1}');
        // a newer record: left as it is
        const newer = '{ "version": 2, "servers": [] }\n';
        fs.writeFileSync(file, newer);
        r = runSteps(w, [{ op: 'record-clean', file, entries: [own], keep: [], live }]);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), newer);
        assert.match(r.text, /is version 2, newer than this plugin's 1 - left as it is; update preferred-tools/);
        // an own entry: the file holds exactly it (Review Focus 5)
        fs.rmSync(file);
        r = runSteps(w, [{ op: 'record-clean', file, entries: [own, manage], keep: [], live }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(readJson(file), { version: 1, servers: [own] });
    }
    finally { w.clean(); }
});

test('a failed order step warns and the apply still succeeds, its records written', () => {
    const w = world();
    try
    {
        const file = path.join(w.project, '.preferred-tools', 'preferred-tools.json');
        const own = { name: 'o', scope: 'local', fingerprint: 'pkg:o', choice: 'own' };
        const mcp = path.join(w.project, '.mcp.json');
        fs.writeFileSync(mcp, '{ "mcpServers": { "a": { "command": "a" }, } }');
        const r = runSteps(w, [
            { op: 'record-clean', file, entries: [own], keep: [], live: { servers: { 'mcp:o~local': 'pkg:o' }, connectors: null } },
            { op: 'order-mcp-json', file: mcp, own: [] },
        ]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(readJson(file).servers, [own]);
        assert.match(r.text, /2\. ok +warning: .*\.mcp\.json.* left as it is - \/preferred-tools:fix \(mcp-order\) orders it/);
        assert.strictEqual(fs.readFileSync(mcp, 'utf8'), '{ "mcpServers": { "a": { "command": "a" }, } }');
    }
    finally { w.clean(); }
});

test("record-clean keeps another project's own entry that live does not list (Ruling 10)", () => {
    const w = world();
    try
    {
        const file = path.join(w.home, '.preferred-tools', 'preferred-tools.json');
        const x = { name: 'x', scope: 'project', fingerprint: 'pkg:x', choice: 'own' };
        const y = { name: 'y', scope: 'user', fingerprint: 'pkg:y', choice: 'manage' };
        writeJson(file, { version: 1, servers: [x, y] });
        const r = runSteps(w, [{ op: 'record-clean', file, entries: [], keep: [x], live: { servers: {}, connectors: null } }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.deepStrictEqual(readJson(file), { version: 1, servers: [x] });
    }
    finally { w.clean(); }
});

test('ensure-key-name: a UTF-16 key file is left as it is and the apply goes on', () => {
    const w = world();
    try
    {
        const file = path.join(w.project, '.preferred-tools', '.mcps-secrets');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('OTHER=x\r\n', 'utf16le')]);
        fs.writeFileSync(file, bytes);
        const r = runSteps(w, [{ op: 'ensure-key-name', file, names: [G] }, { op: 'record-root', family: 'project', project: w.project, root: path.dirname(file) }], { data: path.join(w.dir, 'data') });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.match(r.text, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is UTF-16 - add ${G}= to it yourself; nothing written`));
        assert.ok(fs.readFileSync(file).equals(bytes), 'byte-identical');
        assert.ok(fs.existsSync(path.join(w.dir, 'data', 'roots.json')), 'the next step ran');
    }
    finally { w.clean(); }
});

test('record-clean and record-root: a newer version is left as it is, an unreadable file is kept as .bak before the write replaces it, and an unchanged record writes nothing', () => {
    const w = world();
    try
    {
        const file = path.join(w.project, '.preferred-tools', 'preferred-tools.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const b = { name: 'b', scope: 'user', fingerprint: { pkg: 'z' }, choice: 'own' };
        const live = { servers: { 'mcp:b~user': { pkg: 'z' } }, connectors: null };
        // a newer record: never replaced
        const newer = '{ "version": 2, "servers": [], "more": true }\n';
        fs.writeFileSync(file, newer);
        let r = runSteps(w, [{ op: 'record-clean', file, entries: [b], keep: [], live }]);
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), newer);
        assert.match(r.text, /is version 2, newer than this plugin's 1 - left as it is; update preferred-tools/);
        // not JSON: the old bytes kept beside it, then the merge written
        fs.writeFileSync(file, '{oops');
        r = runSteps(w, [{ op: 'record-clean', file, entries: [b], keep: [], live }]);
        assert.strictEqual(fs.readFileSync(`${file}.bak`, 'utf8'), '{oops');
        assert.deepStrictEqual(readJson(file), { version: 1, servers: [b] });
        assert.match(r.text, /the old file kept as .*preferred-tools\.json\.bak/);
        // the same answers again: nothing written
        const before = fs.statSync(file).mtimeMs;
        fs.utimesSync(file, new Date(0), new Date(0));
        r = runSteps(w, [{ op: 'record-clean', file, entries: [b], keep: [], live }]);
        assert.match(r.text, /already holds these servers - left as it is/);
        assert.strictEqual(fs.statSync(file).mtimeMs, 0, `not rewritten (was ${before})`);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');

        // the roots map, the same three ways
        const data = path.join(w.dir, 'data');
        const map = path.join(data, 'roots.json');
        fs.mkdirSync(data, { recursive: true });
        const root = path.join(w.project, '.preferred-tools');
        const newerMap = '{ "version": 2, "global": null, "projects": {} }\n';
        fs.writeFileSync(map, newerMap);
        r = runSteps(w, [{ op: 'record-root', family: 'project', project: w.project, root }], { data });
        assert.strictEqual(fs.readFileSync(map, 'utf8'), newerMap);
        assert.match(r.text, /is version 2, newer than this plugin's 1 - left as it is; update preferred-tools/);
        fs.writeFileSync(map, 'nope');
        runSteps(w, [{ op: 'record-root', family: 'project', project: w.project, root }], { data });
        assert.strictEqual(fs.readFileSync(`${map}.bak`, 'utf8'), 'nope');
        assert.strictEqual(Object.values(readJson(map).projects)[0], root);
        fs.utimesSync(map, new Date(0), new Date(0));
        r = runSteps(w, [{ op: 'record-root', family: 'project', project: w.project, root }], { data });
        assert.match(r.text, /already names the project root .* - left as it is/);
        assert.strictEqual(fs.statSync(map).mtimeMs, 0, 'not rewritten');
    }
    finally { w.clean(); }
});

test('a new root gets root-ignore with GITIGNORE before any other step', () => {
    const w = world();
    try
    {
        const r = walk(w, { picks: { github: { route: 'remote', scope: 'local' } } });
        assert.strictEqual(r.report.failed, null, r.text);
        assert.strictEqual(r.p.steps[0].op, 'root-ignore');
        const root = path.join(w.project, '.preferred-tools');
        assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), require('../scripts/roots.js').GITIGNORE);
        assert.match(r.text, /^1\. ok {5}wrote .*\.gitignore \(\*, !\.gitignore, !mcp-headers\.js\)$/m);
    }
    finally { w.clean(); }
});

test('a re-run after a failed add writes no file again', () => {
    const w = world();
    try
    {
        const inv = inventory.buildInventory({ project: w.project, env: w.env });
        const p = plan(inv, { picks: { github: { route: 'remote', scope: 'local' } } }, { home: w.home, env: w.env });
        assert.deepStrictEqual(p.steps.map((s) => s.op), ['root-ignore', 'write-helper', 'ensure-key-name', 'mcp-add', 'record-root']);
        const data = path.join(w.dir, 'data');
        const root = path.join(w.project, '.preferred-tools');
        const first = apply(p, { env: { ...w.env, FAKE_CLAUDE_FAIL: 'add-json github' }, tmp: path.join(w.dir, 'tmp'), log: () => {}, data });
        assert.strictEqual(first.failed.op, 'mcp-add');
        const snap = () => ['.gitignore', 'mcp-headers.js', '.mcps-secrets'].map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8'), fs.statSync(path.join(root, f)).mtimeMs]);
        const before = snap();
        const lines = [];
        const second = apply(p, { env: w.env, tmp: path.join(w.dir, 'tmp'), log: (...a) => lines.push(a.join(' ')), data });
        assert.strictEqual(second.failed, null, lines.join('\n'));
        assert.deepStrictEqual(snap(), before, 'byte-identical and untouched');
        assert.ok(accountDoc(w).projects[accountKey(w.project)].mcpServers.github.headersHelper.endsWith(`mcp-headers.js ${G} Bearer`));
        assert.deepStrictEqual(readJson(path.join(data, 'roots.json')).projects, { [require('../scripts/roots.js').mapKey(w.project)]: root });
    }
    finally { w.clean(); }
});
