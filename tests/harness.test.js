'use strict';
// Step 7 check: the harness runs the REAL claude CLI in a throwaway world and leaves the real account byte-identical.
// Skipped (not failed) when no claude CLI is on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../scripts/claude-cli.js');
const { Harness, isolationCheck } = require('./harness.js');

const skip = cli.available() ? false : 'no claude CLI on PATH';
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pt-harness-'));

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
