'use strict';
// Step 10 check: a fresh install for every catalog row and route, from an answers file, through the REAL claude CLI in
// the throwaway world (tests/harness.js), then read back from the files the CLI wrote - never from an exit code.
//
//   npm run matrix        (about five minutes: each case is real CLI calls; plugin cases need the network)
//
// A case whose OS the row is not offered on, and a plugin case with no network, is reported as skipped with the reason
// ('NOT RUN'), never as passed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../../scripts/claude-cli.js');
const account = require('../../scripts/account.js');
const catalog = require('../../scripts/catalog.js').load();
const { Harness } = require('../harness.js');
const spec = require('./fresh-answers.json');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-fresh-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const h = new Harness({ root });
// fake token values, built at run time; every case runs with them in the environment, and the last test searches every
// config file for them
const FAKE = {
    GITHUB_PERSONAL_ACCESS_TOKEN: ['fake', 'github', 'value', 'a1b2c3d4e5f6'].join('-'),
    SENTRY_ACCESS_TOKEN: ['fake', 'sentry', 'value', 'a1b2c3d4e5f6'].join('-'),
    CONTEXT7_API_KEY: ['fake', 'context7', 'value', 'a1b2c3d4e5f6'].join('-'),
};
Object.assign(h.env, FAKE);

const NETWORK = /could not resolve|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|clone|fetch|timed out|ECONNREFUSED/i;

for (const c of spec.cases)
{
    test(`fresh: ${c.name}`, { skip: skipAll, timeout: 300000 }, (t) =>
    {
        if (!c.os.includes(process.platform)) return t.skip(`NOT RUN: ${c.row} is offered on ${c.os.join(', ')}, this is ${process.platform}`);
        const project = h.project(c.name.replace(/[^A-Za-z0-9]+/g, '-'));
        const answers = { ...c.answers, machine: spec.machine };
        const r = h.run(project, answers);
        assert.deepStrictEqual(r.plan.errors, [], r.rendered);
        if (r.report.failed && c.network && NETWORK.test(r.report.failed.detail)) return t.skip(`NOT RUN: no network for ${c.name} (${r.report.failed.detail.slice(0, 120)})`);
        assert.strictEqual(r.report.failed, null, r.text);

        const inv = h.inventory(project);
        if (c.expect.kind === 'mcp')
        {
            const step = r.plan.steps.find((s) => s.op === 'mcp-add');
            const got = inv.registrations.find((x) => x.rowId === c.row && x.scope === c.expect.scope && x.route === c.expect.route);
            assert.ok(got, `${c.row}: no ${c.expect.route}-route registration at ${c.expect.scope} scope read back\n${r.text}`);
            assert.strictEqual(got.name, step.name);
            assert.deepStrictEqual(got.entry, step.entry, 'what the CLI stored is what the plan built');
            // read from the file that scope lives in, not from the inventory alone
            const stored = c.expect.scope === 'project'
                ? JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers
                : (c.expect.scope === 'user' ? account.readAccount(h.env, project).user : account.readAccount(h.env, project).local);
            assert.deepStrictEqual(stored[step.name], step.entry);
            if (c.expect.files)
            {
                // the data folder: in the project, or on Windows for a row whose home must be absolute
                // (serena-windows-home), the default the plan offers there, <home>\.serena
                const absolute = process.platform === 'win32' && catalog.byId.get(c.row).locations.windowsAbsolute;
                assert.strictEqual(fs.readFileSync(path.join(absolute ? path.join(h.home, '.serena') : path.join(project, c.expect.files), '.gitignore'), 'utf8'), '*\n', 'the data folder keeps itself out of git');
            }
            if (c.expect.scope === 'project') assert.ok(!/(?:^|[^$])\/(?:Users|home)\//.test(JSON.stringify(stored)), 'the committed file holds no absolute local path');
        }
        else
        {
            const p = inv.plugins.find((x) => x.rowId === c.row && x.scope === c.expect.scope);
            assert.ok(p, `${c.row}: not read back at ${c.expect.scope} scope\n${r.text}`);
            assert.strictEqual(p.enabled, true);
            assert.deepStrictEqual(p.errors, [], 'the plugin list reports no load error');
            if (c.expect.hudAfter) hudAfterInstall(project, r, c);
        }
    });
}

// claude-hud was planned with hud: 'defer'; the walk then asks and runs hud-statusline.js itself
function hudAfterInstall(project, r, c)
{
    assert.strictEqual(r.plan.hudAfter, true);
    assert.ok(!r.plan.steps.some((s) => s.op === 'hud'));
    const script = path.join(__dirname, '..', '..', 'scripts', 'hud-statusline.js');
    const catalog = path.join(__dirname, '..', '..', 'catalog', 'plugin-settings.json');
    const run = (...flags) => spawnSync(process.execPath, [script, ...flags, '--catalog', catalog, '--project', '.'], { cwd: project, env: h.env, encoding: 'utf8' });
    const check = run('--check');
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /^hud-check: statusLine=absent missing=13 differs=0 match=0$/m, 'a fresh account counts the refresh interval');
    // the walk's 'Skip': the statusLine alone
    const skip = run(`--${c.expect.hudAfter === 'skip' ? 'statusline-only' : 'replace'}`);
    assert.strictEqual(skip.status, 0, skip.stdout + skip.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(h.account, 'settings.json'), 'utf8'));
    assert.strictEqual(settings.statusLine.type, 'command');
    assert.match(settings.statusLine.command, /claude-hud/);
    assert.ok(!('refreshInterval' in settings.statusLine), 'Skip writes no catalog key');
    assert.ok(!fs.existsSync(path.join(h.account, 'plugins', 'claude-hud', 'config.json')), 'and no claude-hud config.json');
    const again = run('--check');
    assert.match(again.stdout, /^hud-check: statusLine=current missing=13 differs=0 match=0$/m, 'the statusLine is current; the 13 keys are still the walk\'s to offer');
}

test('no config file holds a token value, and the real account is untouched', { skip: skipAll }, () =>
{
    const files = [path.join(h.account, '.claude.json'), path.join(h.account, 'settings.json')];
    for (const f of h.files()) if (/(^|[\\/])\.mcp\.json$|[\\/]\.claude[\\/]settings(\.local)?\.json$/.test(f)) files.push(f);
    let scanned = 0;
    for (const f of files)
    {
        if (!fs.existsSync(f)) continue;
        scanned++;
        const text = fs.readFileSync(f, 'utf8');
        for (const [name, value] of Object.entries(FAKE)) assert.ok(!text.includes(value), `${name}'s value is in ${f}`);
    }
    assert.ok(scanned >= 3, `${scanned} files scanned`);
    const real = h.realUntouched();
    assert.ok(real.ok, `the real account changed: ${real.changed.join(', ')}`);
});
