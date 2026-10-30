'use strict';
// Step 7 check: the harness runs the REAL claude CLI in a throwaway world and leaves the real account byte-identical.
// Skipped (not failed) when no claude CLI is on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../scripts/claude-cli.js');
const account = require('../scripts/account.js');
const E = require('../scripts/entries.js');
const { Harness, isolationCheck } = require('./harness.js');

const skip = cli.available() ? false : 'no claude CLI on PATH';
const roots = [];
const root = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-harness-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

test('isolation: the CLI writes in the throwaway account and the real one is byte-identical', { skip }, () =>
{
    const h = new Harness({ root: root() });
    const r = isolationCheck(h);
    assert.ok(r.ok, r.lines.join('\n'));
});

test('the real CLI treats an empty or {} .mcp.json as fresh and refuses a malformed one untouched', { skip }, () =>
{
    const h = new Harness({ root: root() });
    for (const [name, content, ok] of [['empty', '', true], ['blank', '  \n', true], ['obj', '{}', true], ['bad', '{ nope', false]])
    {
        const p = h.project(`mcp-${name}`);
        const file = path.join(p, '.mcp.json');
        fs.writeFileSync(file, content);
        const r = h.claude(p, ['mcp', 'add-json', 'probe', JSON.stringify({ command: 'echo', args: ['x'] }), '-s', 'project']);
        assert.equal(r.status === 0, ok, `${name}: exit ${r.status}`);
        if (ok) assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.probe, name);
        else assert.equal(fs.readFileSync(file, 'utf8'), content, 'a malformed file is left as it was');
    }
    assert.ok(h.realUntouched().ok);
});

test('the fix engine against the REAL CLI: detect, apply as one replace, read back, a second run finds nothing, the real account untouched', { skip }, () =>
{
    const fix = require('../scripts/fix.js');
    const h = new Harness({ root: root() });
    const project = h.project('fix-real');
    const theirs = { command: 'uvx', args: ['--from', 'serena-agent@2.0.0', 'serena', 'start-mcp-server', '--verbose'], env: { SERENA_HOME: path.join(h.home, 'serena-home') } };
    const own = { command: 'node', args: ['mine.js'] };
    for (const [name, entry] of [['serena', theirs], ['my-own-server', own]])
        assert.strictEqual(h.claude(project, ['mcp', 'add-json', name, JSON.stringify(entry), '-s', 'user']).status, 0);
    const machine = { exists: () => false, realpath: () => null, which: () => null, run: () => ({ status: 1 }), nodeVersion: process.versions.node };
    const ctx = () => fix.makeCtx({ inv: h.inventory(project), env: h.env, machine });
    const found = fix.detectAll(ctx()).found;
    assert.deepStrictEqual(found.map((f) => f.id).sort(), ['serena-telemetry', 'uvx-python']);
    const lines = [];
    const res = fix.applyFixes(ctx(), ['all'], { tmp: path.join(h.root, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
    assert.strictEqual(res.failed, null, lines.join('\n'));
    const now = account.readAccount(h.env, project).user;
    // the row's minor, as this machine takes it: on Windows ARM64 the x64 build (windows-arm-python)
    const c = ctx();
    assert.deepStrictEqual(now.serena.args.slice(0, 2), ['--python', E.pythonRequest({ python: '3.13' }, c, c.rules)]);
    assert.ok(now.serena.args.includes('serena-agent@2.0.0') && now.serena.args.includes('--verbose'), 'the user\'s pin and arg survive the real CLI round trip');
    assert.strictEqual(now.serena.env.SERENA_USAGE_REPORTING, 'false');
    assert.deepStrictEqual(now['my-own-server'], own);
    assert.deepStrictEqual(fix.detectAll(ctx()).found, []);
    assert.ok(h.realUntouched().ok);
});
