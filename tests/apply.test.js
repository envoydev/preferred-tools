'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { world, writeJson, readJson } = require('./helpers.js');
const inventory = require('../scripts/inventory.js');
const { plan } = require('../scripts/plan.js');
const { apply } = require('../scripts/apply.js');
const account = require('../scripts/account.js');

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
        const proj = accountDoc(w).projects[account.projectKey(w.project)].mcpServers;
        assert.deepStrictEqual(Object.keys(proj), ['serena']);
        assert.deepStrictEqual(Object.keys(accountDoc(w).mcpServers), ['playwright-chrome']);
        assert.deepStrictEqual(mcpJson(w), { mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } });
        assert.ok(proj.serena.env.SERENA_HOME.startsWith(w.project), 'an absolute path at local scope');
        // the argv the CLI saw
        const adds = w.calls().filter((a) => a[1] === 'add-json');
        assert.deepStrictEqual(adds.map((a) => [a[2], a[4], a[5]]), [['serena', '-s', 'local'], ['playwright-chrome', '-s', 'user'], ['context7', '-s', 'project']]);
        assert.match(r.text, /Read back:\n\s+ok\s+serena - local scope, local route \(serena\)/);
        assert.match(r.text, /claude mcp get serena/);
        assert.match(r.text, /Restart Claude Code/);
        // the data folders got a .gitignore holding *
        assert.strictEqual(fs.readFileSync(path.join(w.project, '.preferred-tools', 'serena', '.gitignore'), 'utf8'), '*\n');
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

test('a same-name rewrite saves the old JSON first and re-adds it when the add fails', () => {
    const w = world();
    try
    {
        walk(w, { picks: { 'playwright-chrome': { scope: 'user' } } });
        const old = accountDoc(w).mcpServers['playwright-chrome'];
        const r = walk(w, { picks: { 'playwright-chrome': { scope: 'user', location: { side: 'account' } } } }, { fail: w.home });
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
        const r = walk(w, { picks: { appium: { scope: 'user', location: { side: 'account' } } } }, { fail: 'add-json appium-mcp' });
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
        const ok = walk(w, { picks: { serena: { scope: 'user', name: 'shop-serena' } } });
        assert.strictEqual(ok.report.failed, null, ok.text);
        assert.deepStrictEqual(Object.keys(accountDoc(w).mcpServers), ['shop-serena']);
        const order = w.calls().slice(calls0).filter((a) => a[0] === 'mcp').map((a) => `${a[1]} ${a[2]}`);
        assert.deepStrictEqual(order.slice(0, 2), ['add-json shop-serena', 'remove serena']);
        // a failed add leaves 'shop-serena' alone
        const bad = walk(w, { picks: { serena: { scope: 'user', name: 'other-serena' } } }, { fail: 'add-json other-serena' });
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
        const r = walk(w, { picks: { context7: { route: 'remote', scope: 'user' } } });
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
        // the data folder stays: the report does not delete it
        assert.ok(fs.existsSync(path.join(w.project, '.preferred-tools', 'serena')));
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
        spawnSync('claude', ['plugin', 'disable', 'csharp-lsp@claude-plugins-official', '--scope', 'project'], { cwd: w.project, env: w.env });
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
        const r = walk(w, { picks: { 'csharp-lsp': { scope: 'project', moveFrom: ['user'] } } });
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
