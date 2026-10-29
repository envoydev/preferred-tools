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
        // under the project, or on Windows serena's own absolute home, <home>\.serena (serena-windows-home)
        assert.ok(proj.serena.env.SERENA_HOME.startsWith(process.platform === 'win32' ? path.win32.join(w.home, '.serena') : w.project), 'an absolute path at local scope');
        // the argv the CLI saw
        const adds = w.calls().filter((a) => a[1] === 'add-json');
        assert.deepStrictEqual(adds.map((a) => [a[2], a[4], a[5]]), [['serena', '-s', 'local'], ['playwright-chrome', '-s', 'user'], ['context7', '-s', 'project']]);
        assert.match(r.text, /Read back:\n\s+ok\s+serena - local scope, local route \(serena\)/);
        // the slow half is handed to fetch.js, never run here: no download and no `claude mcp get` inside the apply
        assert.ok(!w.calls().some((a) => a[0] === 'mcp' && a[1] === 'get'), 'apply asks the CLI for no status');
        assert.deepStrictEqual(w.fetches(), [], 'apply runs no runtime');
        assert.match(r.text, /3\. later  serena: fetch serena-agent@/);
        assert.match(r.text, /Fetch next, in the background \(a first download can take minutes\): .*fetch\.json/);
        const job = readJson(r.report.fetchFile);
        assert.deepStrictEqual(job.fetch.map((s) => s.name), ['serena', 'playwright-chrome']);
        assert.deepStrictEqual(job.check, ['serena', 'playwright-chrome', 'context7'], 'every server written, the hosted one too');
        assert.match(r.text, /Restart Claude Code/);
        // the data folders got a .gitignore holding * (serena's on Windows is <home>\.serena, serena-windows-home)
        const serenaData = process.platform === 'win32' ? path.win32.join(w.home, '.serena') : path.join(w.project, '.preferred-tools', 'serena');
        assert.strictEqual(fs.readFileSync(path.join(serenaData, '.gitignore'), 'utf8'), '*\n');
        assert.strictEqual(fs.readFileSync(path.join(w.project, '.preferred-tools', 'playwright-chrome', '.gitignore'), 'utf8'), '*\n');
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
        walk(w, { picks: { 'playwright-chrome': { scope: 'user' } } });
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
        walk(w, { picks: { appium: { scope: 'user' } } });
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
        assert.ok(fs.existsSync(process.platform === 'win32' ? path.win32.join(w.home, '.serena') : path.join(w.project, '.preferred-tools', 'serena')));
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
        assert.match(fs.readFileSync(path.join(w.project, '.mcp.json'), 'utf8'), /Bearer \$\{GITHUB_PERSONAL_ACCESS_TOKEN\}/);
        assert.match(JSON.stringify(accountDoc(w)), /\$\{SENTRY_ACCESS_TOKEN\}/);
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
        walk(w, { picks: { appium: { scope: 'user' } } });
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
