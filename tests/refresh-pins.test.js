'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const refreshPins = require('../scripts/refresh-pins.js');
const catalogLib = require('../scripts/catalog.js');

const DAY = 86400000;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const FILE = path.join(catalogLib.CATALOG_DIR, 'tools.json');

const packages = (tools) => tools.tools.flatMap((r) => Object.entries(r.routes || {}).filter(([, v]) => v.package).map(([id, v]) => ({ row: r.id, route: id, ...v.package })));
const bump = (v) => v.replace(/\d+$/, (n) => String(Number(n) + 1));

// every package: its pin (60 days old) and a newer release of the given age; `over` replaces one package's list
function fakeRegistry(tools, { age = 20, over = {} } = {})
{
    const table = {};
    for (const p of packages(tools)) table[`${p.registry}:${p.name}`] = [{ version: p.version, time: NOW - 60 * DAY }, { version: bump(p.version), time: NOW - age * DAY }];
    Object.assign(table, over);
    return { versionsOf: async (reg, name) => { if (!table[`${reg}:${name}`]) throw new Error(`no such package ${name}`); return table[`${reg}:${name}`]; } };
}

const copy = () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-refresh-'));
    const file = path.join(dir, 'tools.json');
    fs.copyFileSync(FILE, file);
    return { dir, file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('the catalog file is what serialize writes, so a refresh changes only the pins and cut-offs', () =>
{
    const text = fs.readFileSync(FILE, 'utf8');
    assert.ok(text === refreshPins.serialize(JSON.parse(text)), 'catalog/tools.json is JSON.stringify(.., null, 2) plus a newline');
});

test('every package route moves to the newer release that is old enough, and its cut-off to today', async () =>
{
    const tools = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const r = await refreshPins.refresh(tools, { registry: fakeRegistry(tools), now: NOW });
    const rows = packages(tools);
    assert.strictEqual(r.changes.length, rows.length);
    assert.deepStrictEqual(r.errors, []);
    for (const p of packages(r.next))
    {
        const was = rows.find((x) => x.row === p.row && x.route === p.route);
        assert.strictEqual(p.version, bump(was.version));
        assert.strictEqual(p.cutoff, '2026-10-27T23:59:59Z');
    }
    // four Playwright rows share one package: all four move
    assert.strictEqual(r.changes.filter((c) => c.package === '@playwright/mcp').length, 4);
    // nothing else changed: the input is untouched, and with the pins put back the two documents are equal
    const back = JSON.parse(JSON.stringify(r.next));
    for (const row of back.tools) for (const v of Object.values(row.routes || {})) if (v.package) { const was = rows.find((x) => x.row === row.id && x.name === v.package.name); v.package.version = was.version; v.package.cutoff = was.cutoff; }
    assert.deepStrictEqual(back, tools);
    // a docker image tag and the global rules are not touched
    assert.strictEqual(r.next.tools.find((x) => x.id === 'github').routes.local.image.tag, tools.tools.find((x) => x.id === 'github').routes.local.image.tag);
    assert.strictEqual(r.next.rules.cutoff, tools.rules.cutoff);
});

test('a too-new release is held back, a pin already current stays with its cut-off, and a registry failure is an error', async () =>
{
    const tools = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const young = await refreshPins.refresh(tools, { registry: fakeRegistry(tools, { age: 3 }), now: NOW });
    assert.deepStrictEqual(young.changes, []);
    assert.ok(young.held.length === packages(tools).length && young.held.every((h) => /3 day\(s\) old - held back until it is 7/.test(h)));
    assert.deepStrictEqual(young.next, tools, 'nothing moved, so nothing is written');

    const serena = packages(tools).find((p) => p.name === 'serena-agent');
    const table = fakeRegistry(tools);
    const r = await refreshPins.refresh(tools, {
        now: NOW,
        registry: { versionsOf: async (g, n) => { if (n === 'appium-mcp') throw new Error('HTTP 503'); if (n === 'serena-agent') return [{ version: serena.version, time: NOW - 60 * DAY }]; return table.versionsOf(g, n); } },
    });
    assert.ok(!r.changes.some((c) => c.package === 'serena-agent'));
    assert.deepStrictEqual(r.next.tools.find((x) => x.id === 'serena').routes.local.package, tools.tools.find((x) => x.id === 'serena').routes.local.package, 'its cut-off stays');
    assert.match(r.errors.join('\n'), /appium\/local: npm lookup for appium-mcp failed - HTTP 503/);
});

test('main: a dry run writes nothing, --write writes the moved catalog, and a failure exits 1', async () =>
{
    const tools = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const c = copy();
    try
    {
        const lines = [];
        const run = (argv, registry = fakeRegistry(tools)) => refreshPins.main(argv, { file: c.file, out: (s) => lines.push(s), registry, now: NOW });
        assert.strictEqual(await run([]), 0);
        assert.strictEqual(fs.readFileSync(c.file, 'utf8'), fs.readFileSync(FILE, 'utf8'), 'a dry run writes nothing');
        assert.match(lines.join('\n'), /Would move:[\s\S]*Run again with --write/);
        assert.strictEqual(await run(['--write']), 0);
        const moved = JSON.parse(fs.readFileSync(c.file, 'utf8'));
        assert.strictEqual(moved.tools.find((x) => x.id === 'serena').routes.local.package.version, bump(tools.tools.find((x) => x.id === 'serena').routes.local.package.version));
        assert.strictEqual(fs.readFileSync(c.file, 'utf8'), refreshPins.serialize(moved));
        assert.match(lines.join('\n'), /Next: a moved pin is a release/);
        // a registry that is down is an error, not 'nothing to move'
        lines.length = 0;
        assert.strictEqual(await run([], { versionsOf: async () => { throw new Error('offline'); } }), 1);
        assert.match(lines.join('\n'), /Could not check:/);
        assert.strictEqual(await run(['--bogus']), 2);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), tools, 'the repo catalog itself was never touched');
    }
    finally { c.done(); }
});
