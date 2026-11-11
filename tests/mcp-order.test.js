'use strict';
// mcp-order.js - .mcp.json's servers in the catalog's order (spec F8): the managed servers first, by catalog.order, the
// user's own and the servers left on their own after them. Only the order of mcpServers changes, never a value.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../scripts/catalog.js').load();
const { matchEntry } = require('../scripts/inventory.js');
const O = require('../scripts/mcp-order.js');

// one entry per catalog row, launched as its first route's fingerprint says
function entryOf(rowId)
{
    const row = catalog.byId.get(rowId);
    const f = Object.values(row.routes)[0].fingerprints[0];
    if (f.pkg) return { command: 'npx', args: ['-y', `${f.pkg}@1.0.0`, ...(f.flag ? [f.flag, f.value] : [])] };
    return { type: 'http', url: `https://${f.host || 'gitlab.example.com'}${f.pathPrefix === '/v' ? '/v1/mcp' : f.pathPrefix}` };
}
const nameOf = (rowId) => catalog.byId.get(rowId).name;
const MINE_A = { command: 'my-a' };
const MINE_B = { type: 'http', url: 'https://mine.example.com/mcp' };
const NONE = new Set();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-order-'));

test('sorts the 14 catalog servers given in reverse, the user\'s own after them in their order', () => {
    for (const id of catalog.order) assert.strictEqual((matchEntry(entryOf(id), catalog) || {}).rowId, id, id);
    const servers = { 'mine-a': MINE_A };
    for (const id of [...catalog.order].reverse()) servers[nameOf(id)] = entryOf(id);
    servers['mine-b'] = MINE_B;
    assert.deepStrictEqual(O.sortedNames(servers, catalog, NONE), [...catalog.order.map(nameOf), 'mine-a', 'mine-b']);
});

test('two entries of one row keep their order; a user\'s server named gitlab but launched otherwise sorts with the user\'s own', () => {
    const servers = { 'pw-two': entryOf('playwright-chrome'), gitlab: { command: 'my-gitlab-bridge' }, 'pw-one': entryOf('playwright-chrome'), gh: entryOf('github') };
    assert.deepStrictEqual(O.sortedNames(servers, catalog, NONE), ['gh', 'pw-two', 'pw-one', 'gitlab']);
});

test('a server left on its own sits with the user\'s own, and a file already in order is unchanged', () => {
    const servers = { 'mine-a': MINE_A, gh: entryOf('github'), c7: entryOf('context7') };
    assert.deepStrictEqual(O.sortedNames(servers, catalog, new Set(['gh'])), ['c7', 'mine-a', 'gh']);
    const text = `${JSON.stringify({ mcpServers: { gh: entryOf('github'), c7: entryOf('context7'), 'mine-a': MINE_A } }, null, 2)}\n`;
    assert.deepStrictEqual(O.reorderText(text, catalog, NONE), { text, changed: false });
    // left on its own, among the rest: still in order
    const own = `${JSON.stringify({ mcpServers: { c7: entryOf('context7'), 'mine-a': MINE_A, gh: entryOf('github') } }, null, 2)}\n`;
    assert.deepStrictEqual(O.reorderText(own, catalog, new Set(['gh'])), { text: own, changed: false });
});

test('keeps the indent, CRLF and a missing final newline, and every other top-level key in its place', () => {
    const doc = { before: 1, mcpServers: { 'mine-a': MINE_A, sentry: entryOf('sentry'), gh: entryOf('github') }, after: { x: [1, 2] } };
    const text = JSON.stringify(doc, null, 4).replace(/\n/g, '\r\n');
    const r = O.reorderText(text, catalog, NONE);
    assert.strictEqual(r.changed, true);
    assert.ok(!r.text.endsWith('\n'), 'no final newline added');
    assert.ok(!/[^\r]\n/.test(r.text), 'every line ends CRLF');
    assert.match(r.text, /\r\n {4}"before": 1,/);
    const back = JSON.parse(r.text);
    assert.deepStrictEqual(Object.keys(back), ['before', 'mcpServers', 'after']);
    assert.deepStrictEqual(Object.keys(back.mcpServers), ['gh', 'sentry', 'mine-a']);
    assert.deepStrictEqual(back.mcpServers.sentry, doc.mcpServers.sentry);
    // no indented line at all: 2; a final newline kept
    const flat = `${JSON.stringify({ mcpServers: { 'mine-a': MINE_A, gh: entryOf('github') } })}\n`;
    const f = O.reorderText(flat, catalog, NONE);
    assert.ok(f.text.startsWith('{\n  "mcpServers": {\n    "gh"'), f.text);
    assert.ok(f.text.endsWith('}\n') && !f.text.endsWith('}\n\n'));
});

test('a BOM, a comment or a trailing comma is an error and nothing is written', () => {
    const good = JSON.stringify({ mcpServers: { 'mine-a': MINE_A, gh: entryOf('github') } }, null, 2);
    const bad = [`\uFEFF${good}`, good.replace('{', '{ // mine\n'), good.replace(/}\s*}$/, '},\n}')];
    const dir = tmpDir();
    try
    {
        for (const text of bad)
        {
            assert.ok(O.reorderText(text, catalog, NONE).error, JSON.stringify(text.slice(0, 20)));
            const file = path.join(dir, '.mcp.json');
            fs.writeFileSync(file, text);
            const r = O.orderFile(file, catalog, NONE);
            assert.deepStrictEqual([r.ok, r.changed], [true, false]);
            assert.match(r.detail, /^warning: .* left as it is - \/preferred-tools:fix \(mcp-order\) orders it$/);
            assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'byte-identical');
        }
        assert.deepStrictEqual(fs.readdirSync(dir), ['.mcp.json'], 'no temporary file left');
        // not there: nothing to order
        const none = O.orderFile(path.join(dir, 'none', '.mcp.json'), catalog, NONE);
        assert.deepStrictEqual([none.ok, none.changed], [true, false]);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file changed between the read and the rename is not written; one in order is written through a rename', () => {
    const a = JSON.stringify({ mcpServers: { 'mine-a': MINE_A, gh: entryOf('github') } }, null, 2);
    const b = JSON.stringify({ mcpServers: { 'mine-a': MINE_A, gh: entryOf('github'), c7: entryOf('context7') } }, null, 2);
    const reads = [a, b];
    let wrote = 0;
    let renamed = 0;
    const r = O.orderFile('/nowhere/.mcp.json', catalog, NONE, { read: () => reads.shift(), write: () => { wrote++; }, rename: () => { renamed++; } });
    assert.deepStrictEqual([r.ok, r.changed, wrote, renamed], [true, false, 0, 0]);
    assert.match(r.detail, /^warning: .*changed while it was being ordered.* left as it is - \/preferred-tools:fix \(mcp-order\) orders it$/);
    const dir = tmpDir();
    try
    {
        const file = path.join(dir, '.mcp.json');
        fs.writeFileSync(file, a);
        const ok = O.orderFile(file, catalog, NONE);
        assert.deepStrictEqual([ok.ok, ok.changed], [true, true], ok.detail);
        assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['gh', 'mine-a']);
        assert.deepStrictEqual(fs.readdirSync(dir), ['.mcp.json']);
        // a write that fails: a warning, the file as it was
        fs.writeFileSync(file, a);
        const failed = O.orderFile(file, catalog, NONE, { write: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
        assert.deepStrictEqual([failed.ok, failed.changed], [true, false]);
        assert.match(failed.detail, /^warning: .*ENOSPC.* left as it is - \/preferred-tools:fix \(mcp-order\) orders it$/);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), a);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('withOrderStep appends one step only for a project-scope add, replace or move', () => {
    const add = (scope) => ({ op: 'mcp-add', name: 'gh', scope, entry: entryOf('github') });
    const local = [add('local')];
    assert.strictEqual(O.withOrderStep(local, '/work/shop', []), local);
    for (const step of [add('project'), { op: 'mcp-replace', name: 'gh', scope: 'project', entry: {} }, { op: 'mcp-move', from: { name: 'gh', scope: 'local' }, to: { name: 'gh', scope: 'project' }, entry: {} }])
    {
        const steps = O.withOrderStep([step, { op: 'record-clean', file: 'x' }], '/work/shop', ['mine']);
        assert.strictEqual(steps.length, 3);
        assert.deepStrictEqual(steps[2], { op: 'order-mcp-json', file: '/work/shop/.mcp.json', own: ['mine'], why: '.mcp.json: the catalog servers in your order, your own after them - no value changes' });
    }
    assert.strictEqual(O.withOrderStep([add('project')], 'C:\\work\\shop', [])[1].file, 'C:\\work\\shop\\.mcp.json');
    // a move out of project scope leaves .mcp.json in order
    const out = [{ op: 'mcp-move', from: { name: 'gh', scope: 'project' }, to: { name: 'gh', scope: 'local' }, entry: {} }];
    assert.strictEqual(O.withOrderStep(out, '/work/shop', []), out);
});

test('ownProjectNames: project-scope registrations left on their own, and this run\'s own answers at project scope', () => {
    const inv = { registrations: [
        { name: 'a', scope: 'project', choice: 'own' }, { name: 'b', scope: 'project', choice: 'manage' }, { name: 'c', scope: 'local', choice: 'own' },
    ] };
    assert.deepStrictEqual(O.ownProjectNames(inv, { 'mcp:d~project': 'own', 'mcp:e~local': 'own', 'mcp:a~project': 'own', 'mcp:f~project': 'manage' }), ['a', 'd']);
    assert.deepStrictEqual(O.ownProjectNames({}), []);
});
