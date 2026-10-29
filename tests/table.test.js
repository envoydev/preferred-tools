'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('../scripts/catalog.js');
const E = require('../scripts/entries.js');
const table = require('../scripts/table.js');

const catalog = catalogLib.load();

function entryOf(rowId, platform = 'darwin')
{
    const row = catalog.byId.get(rowId);
    const ctx = { platform, arch: 'x64', env: {}, home: '/home/dev', project: '/proj' };
    return E.buildEntry(row, 'local', { rootStr: row.locations ? '/home/dev/.pt/x' : undefined, scope: 'local' }, ctx, catalog.rules);
}
const reg = (rowId, name, scope, entry, route = 'local') => ({ name, scope, entry, rowId, route, own: false, alfredRetired: false });
const inv = (over = {}) => ({ version: 1, project: '/proj', os: 'darwin', arch: 'x64', registrations: [], plugins: [], unreadable: [], ...over });

test('one numbered table of every row for this OS: nothing installed shows a dash in each scope', () =>
{
    const text = table.render(inv(), catalog);
    const lines = text.split('\n');
    assert.match(lines[0], /^#\s+group\s+tool\s+kind\s+routes\s+local\s+project\s+user$/);
    const rows = lines.slice(2).filter((l) => /^\d+ /.test(l));
    const offered = catalog.tools.filter((r) => r.os.includes('darwin'));
    assert.strictEqual(rows.length, offered.length, 'windows-control is not offered on macOS');
    assert.deepStrictEqual(rows.map((l) => parseInt(l, 10)), offered.map((_, i) => i + 1), 'numbered from 1, in catalog order');
    assert.match(text, /Not offered on this OS \(darwin\): windows-control\./);
    assert.ok(!/windows-control +mcp/.test(text));
    assert.match(rows.find((l) => /serena/.test(l)), /serena\s+mcp\s+local\s+-\s+-\s+-$/);
    assert.match(rows.find((l) => /\bcontext7\b/.test(l)), /context7\s+mcp\s+remote\/local/);
    assert.match(rows.find((l) => /claude-hud/.test(l)), /claude-hud\s+plugin\s+-\s+-\s+-\s+-$/);
    const win = table.render(inv({ os: 'win32' }), catalog);
    assert.ok(/windows-control\s+mcp/.test(win));
    assert.match(win, /Not offered on this OS \(win32\): macos-control\./);
});

test('what is installed shows by scope as name [route, pin], a custom name included; the pin is the installed one', () =>
{
    const old = entryOf('serena');
    old.args = old.args.map((a) => (a === 'serena-agent@2.1.0' ? 'serena-agent@2.0.0' : a));
    const text = table.render(inv({
        registrations: [
            reg('serena', 'proj-serena', 'local', old),
            reg('serena', 'serena', 'user', entryOf('serena')),
            reg('memory', 'memory', 'user', entryOf('memory')),
            reg('context7', 'context7', 'project', { type: 'http', url: 'https://mcp.context7.com/mcp' }, 'remote'),
            reg('github', 'github', 'local', { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v2.0.2', 'stdio'] }),
            reg('playwright-chrome', 'playwright-chrome', 'local', entryOf('playwright-chrome')),
        ],
        plugins: [{ id: 'claude-hud@claude-hud', plugin: 'claude-hud', scope: 'user', version: '0.13.1', enabled: true, errors: [], rowId: 'claude-hud', alfredRetired: false }],
    }), catalog);
    const row = (re) => text.split('\n').find((l) => re.test(l));
    assert.match(row(/\bserena\s+mcp/), /proj-serena \[local, 2\.0\.0\]\s+-\s+serena \[local, 2\.1\.0\]$/, 'one row, two scopes, two pins');
    assert.match(row(/\bmemory\s+mcp/), /memory \[local, 12\.1\.1\]$/);
    assert.match(row(/\bcontext7\s+mcp/), /-\s+context7 \[remote\]\s+-$/);
    assert.match(row(/\bgithub\s+mcp/), /github \[local, v2\.0\.2\]/);
    assert.match(row(/playwright-chrome\s+mcp/), /playwright-chrome \[local, 0\.0\.83\]/);
    assert.match(row(/claude-hud\s+plugin/), /0\.13\.1, enabled$/);
});

test('four Playwright engines are four rows, each with its own registration', () =>
{
    const regs = ['chrome', 'msedge', 'firefox', 'webkit'].map((e) => reg(`playwright-${e}`, `playwright-${e}`, 'local', entryOf(`playwright-${e}`)));
    const text = table.render(inv({ registrations: regs }), catalog);
    for (const e of ['chrome', 'msedge', 'firefox', 'webkit']) assert.match(text, new RegExp(`playwright-${e}\\s+mcp\\s+local\\s+playwright-${e} \\[local, 0\\.0\\.83\\]`));
});

test('the user\'s own servers, alfred-code leftovers, plugin errors and unreadable files are named under the table', () =>
{
    const text = table.render(inv({
        registrations: [
            { name: 'my-own-server', scope: 'user', entry: { command: 'node' }, rowId: null, route: null, own: true, alfredRetired: false },
            { name: 'alfred-navigation', scope: 'user', entry: { command: 'uvx' }, rowId: null, route: null, own: true, alfredRetired: true },
        ],
        plugins: [{ id: 'csharp-lsp@claude-plugins-official', plugin: 'csharp-lsp', scope: 'project', version: '1.0.0', enabled: false, errors: ['cannot load'], rowId: 'csharp-lsp', alfredRetired: false }],
        unreadable: [{ scope: 'project', file: '/proj/.mcp.json', state: 'malformed', error: 'not valid JSON' }],
    }), catalog);
    assert.match(text, /Your own, not in this catalog and never touched: my-own-server \(user\)\./);
    assert.match(text, /Under names alfred-code once registered, left alone: alfred-navigation \(user\)\./);
    assert.match(text, /csharp-lsp@claude-plugins-official \(project\) reports: cannot load/);
    assert.match(text, /\/proj\/\.mcp\.json is malformed \(not valid JSON\): the project scope is unreadable here, and nothing will be written to it\./);
    assert.match(text, /csharp-lsp\s+plugin\s+-\s+-\s+1\.0\.0, disabled \(ERRORS\)/);
});

test('main reads the inventory file; a missing file exits 2', () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-table-'));
    try
    {
        const file = path.join(dir, 'inv.json');
        fs.writeFileSync(file, JSON.stringify(inv()));
        let text = '';
        const out = (s) => { text += `${s}\n`; };
        assert.strictEqual(table.main([file], { out }), 0);
        assert.match(text, /^#\s+group/);
        text = '';
        assert.strictEqual(table.main([path.join(dir, 'none.json')], { out }), 2);
        assert.strictEqual(table.main([], { out }), 2);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inherited servers are noted by folder and approval, never in a scope column; an unreadable parent file is named', () =>
{
    const c7 = { ...reg('context7', 'context7', 'inherited', { type: 'http', url: 'https://mcp.context7.com/mcp' }, 'remote'), from: '/', approval: 'pending', shadowed: null };
    const mine = { name: 'tool', scope: 'inherited', entry: { command: 'node', args: ['x'] }, rowId: null, route: null, own: true, alfredRetired: false, from: '/', approval: 'approved', shadowed: { scope: 'local', from: null } };
    const out = table.render(inv({ registrations: [c7, mine], unreadable: [{ scope: 'inherited', file: '/x/.mcp.json', state: 'malformed', error: 'bad' }] }), catalog);
    const c7Line = out.split('\n').find((l) => / context7 /.test(l));
    assert.doesNotMatch(c7Line, /context7 \[remote/, 'no scope cell holds it');
    assert.match(out, /Inherited from a parent folder's \.mcp\.json - change them there: context7 \(from \.\., pending\), tool \(from \.\., approved, not used here: the local one wins\)\./);
    assert.doesNotMatch(out, /Your own, not in this catalog/, 'an inherited own server is in the inherited note only');
    assert.match(out, /\/x\/\.mcp\.json is malformed \(bad\): Claude Code skips that parent folder's servers; nothing here writes to it\./);
});
