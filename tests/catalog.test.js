'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load, fingerprintKey, CATALOG_DIR } = require('../scripts/catalog.js');

const cat = load();
const ROOT = path.join(__dirname, '..');

const MCP_ROW = ['id', 'kind', 'group', 'label', 'summary', 'name', 'os', 'recommendedRoute', 'routes', 'dangerous'];
const PLUGIN_ROW = ['id', 'kind', 'group', 'label', 'summary', 'plugin', 'marketplace', 'os', 'recommendedScope', 'prereqs'];
const OSES = ['darwin', 'linux', 'win32'];
const GROUPS = ['code', 'docs', 'browsers', 'machine'];
const PLACEHOLDER = /\{(root|name|host|value|version|minor)\}/g;

test('the catalog has the 17 rows of the brief, each id once', () => {
    const ids = cat.tools.map((r) => r.id);
    assert.strictEqual(ids.length, 17);
    assert.strictEqual(new Set(ids).size, 17);
    assert.deepStrictEqual([...ids].sort(), ['appium', 'atlassian', 'claude-hud', 'context7', 'csharp-lsp', 'github', 'gitlab', 'macos-control',
        'memory', 'playwright-chrome', 'playwright-firefox', 'playwright-msedge', 'playwright-webkit', 'sentry', 'serena', 'typescript-lsp', 'windows-control']);
});

test('every row has the fields its kind needs', () => {
    for (const row of cat.tools)
    {
        const need = row.kind === 'mcp' ? MCP_ROW : row.kind === 'plugin' ? PLUGIN_ROW : null;
        assert.ok(need, `${row.id}: kind ${row.kind}`);
        for (const key of need) assert.ok(key in row, `${row.id} lacks ${key}`);
        assert.ok(GROUPS.includes(row.group), `${row.id}: group ${row.group}`);
        assert.ok(row.os.length && row.os.every((o) => OSES.includes(o)), `${row.id}: os`);
    }
});

test('the four groups are the brief\'s and hold the rows the brief lists', () => {
    assert.deepStrictEqual(cat.groups.map((g) => g.id), GROUPS);
    const of = (g) => cat.tools.filter((r) => r.group === g).map((r) => r.id).sort();
    assert.deepStrictEqual(of('code'), ['csharp-lsp', 'memory', 'serena', 'typescript-lsp']);
    assert.deepStrictEqual(of('docs'), ['atlassian', 'context7', 'github', 'gitlab']);
    assert.deepStrictEqual(of('browsers'), ['playwright-chrome', 'playwright-firefox', 'playwright-msedge', 'playwright-webkit']);
    assert.deepStrictEqual(of('machine'), ['appium', 'claude-hud', 'macos-control', 'sentry', 'windows-control']);
});

test('every MCP route carries what its transport needs', () => {
    for (const row of cat.tools.filter((r) => r.kind === 'mcp'))
    {
        assert.ok(row.routes[row.recommendedRoute], `${row.id}: recommended route exists`);
        assert.match(row.name, new RegExp(cat.rules.nameRe), `${row.id}: default name`);
        for (const [routeId, route] of Object.entries(row.routes))
        {
            const at = `${row.id}/${routeId}`;
            assert.ok(['local', 'remote'].includes(routeId), at);
            assert.strictEqual(typeof route.projectScope, 'boolean', `${at}: projectScope`);
            assert.ok(Array.isArray(route.fingerprints) && route.fingerprints.length, `${at}: fingerprints`);
            assert.ok(Array.isArray(route.prereqs), `${at}: prereqs`);
            if (routeId === 'remote')
            {
                assert.strictEqual(route.type, 'http', at);
                assert.match(route.url, /^https:\/\//, at);
                assert.ok(['oauth', 'token', 'optional-token'].includes(route.auth), `${at}: auth`);
                // a remote entry holds no secret, so project scope is allowed
                assert.strictEqual(route.projectScope, true, `${at}: remote routes may sit in the committed file`);
            }
            else
            {
                assert.ok(['uvx', 'npx', 'docker'].includes(route.runtime), `${at}: runtime`);
                assert.strictEqual(route.projectScope, false, `${at}: no local route is project-scoped before step 12 measures it`);
                assert.ok(Array.isArray(route.run), `${at}: run`);
                if (route.runtime === 'uvx')
                {
                    assert.match(route.python, /^3\.\d+$/, at);
                    assert.ok(route.package.fromSpec.includes('{version}'), at);
                }
                if (route.runtime === 'docker') assert.ok(route.image.name && route.image.tag, at);
                else
                {
                    const p = route.package;
                    assert.ok(p.name && /^\d+\.\d+\.\d+$/.test(p.version) && /^\d{4}-\d\d-\d\dT23:59:59Z$/.test(p.cutoff), `${at}: pin and cut-off`);
                    assert.ok(['pypi', 'npm'].includes(p.registry), at);
                }
            }
        }
    }
});

test('every fingerprint is unique across the catalog', () => {
    const seen = new Map();
    for (const row of cat.tools)
    {
        const prints = row.kind === 'plugin' ? [`plugin:${row.plugin}@${row.marketplace.name}`]
            : Object.values(row.routes).flatMap((r) => r.fingerprints.map(fingerprintKey));
        for (const key of prints)
        {
            assert.ok(!seen.has(key), `${key} is claimed by ${seen.get(key)} and ${row.id}`);
            seen.set(key, row.id);
        }
    }
    // the four Playwright engines share a package and differ by --browser
    assert.strictEqual([...seen.keys()].filter((k) => k.startsWith('pkg:@playwright/mcp')).length, 4);
});

test('every location root derives its paths from one root, in the row\'s locations map', () => {
    for (const row of cat.tools.filter((r) => r.locations))
    {
        const loc = row.locations;
        assert.ok(['project', 'account'].includes(loc.defaultSide), row.id);
        assert.ok(loc.alfred, `${row.id}: the alfred-code root it reads from original-mcps.json`);
        assert.ok(loc.derived.length >= 1 && loc.derived[0].sub !== undefined, row.id);
        for (const d of loc.derived) assert.ok(['arg', 'env'].includes(d.in) && d.key, row.id);
    }
    const loc = (id) => cat.byId.get(id).locations.derived.map((d) => `${d.in}:${d.key}:${d.sub}`);
    assert.deepStrictEqual(loc('serena'), ['env:SERENA_HOME:']);
    assert.deepStrictEqual(loc('memory'), ['env:MCP_MEMORY_SQLITE_PATH:memory.db']);
    assert.deepStrictEqual(loc('playwright-chrome'), ['arg:--user-data-dir:', 'arg:--output-dir:output']);
    assert.deepStrictEqual(loc('appium'), ['env:SCREENSHOTS_DIR:screenshots', 'env:PAGE_SOURCES_DIR:page-sources']);
    assert.strictEqual(cat.byId.get('memory').locations.defaultSide, 'account');
    // the old roots are the ones original-mcps.json holds, not a pattern
    assert.strictEqual(cat.byId.get('serena').locations.alfred, '.alfred/serena/home');
    assert.strictEqual(cat.byId.get('playwright-webkit').locations.alfred, '.alfred/webkit-control');
    assert.strictEqual(cat.byId.get('appium').locations.alfred, '.alfred/mobile-control');
    assert.strictEqual(cat.byId.get('memory').locations.alfred, '~/.alfred-memory');
});

test('each Playwright engine is its own row with --browser and --no-webmcp', () => {
    for (const engine of ['chrome', 'msedge', 'firefox', 'webkit'])
    {
        const route = cat.byId.get(`playwright-${engine}`).routes.local;
        assert.deepStrictEqual(route.run, ['--browser', engine, '--no-webmcp']);
        assert.deepStrictEqual(route.optionalArgs.executablePath, ['--executable-path', '{value}']);
    }
});

test('only placeholders the builder knows appear, and no file holds a secret', () => {
    const text = fs.readFileSync(path.join(CATALOG_DIR, 'tools.json'), 'utf8');
    for (const m of text.matchAll(/(?<!\$)\{[a-zA-Z]+\}/g)) assert.ok(/^\{(root|name|host|value|version|minor)\}$/.test(m[0]), `placeholder ${m[0]}`);
    // every ${VAR} is a bare reference
    for (const m of text.matchAll(/\$\{([^}]*)\}/g)) assert.match(m[1], /^[A-Z][A-Z0-9_]*$/, `\${${m[1]}}`);
    // known token shapes
    for (const file of fs.readdirSync(CATALOG_DIR))
    {
        const body = fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8');
        assert.doesNotMatch(body, /(ghp_|github_pat_|glpat-|sntrys_|sk-ant-|xox[bp]-)[A-Za-z0-9_]{8,}/, file);
    }
    assert.ok(PLACEHOLDER);
});

test('os-restricted rows are the desktop servers', () => {
    assert.deepStrictEqual(cat.byId.get('macos-control').os, ['darwin']);
    assert.deepStrictEqual(cat.byId.get('windows-control').os, ['win32']);
    assert.strictEqual(cat.tools.filter((r) => r.os.length < 3).length, 2);
});

test('code-running tools are named per row', () => {
    const danger = (id) => cat.byId.get(id).dangerous.map((d) => d.tool);
    assert.deepStrictEqual(danger('playwright-chrome'), ['browser_run_code_unsafe']);
    assert.deepStrictEqual(danger('windows-control'), ['App']);
    assert.deepStrictEqual(danger('macos-control'), ['Shell']);
});

test('plugin rows name their marketplace and the settings row the brief ports', () => {
    assert.deepStrictEqual(cat.byId.get('claude-hud').marketplace, { name: 'claude-hud', source: 'jarrodwatts/claude-hud' });
    assert.strictEqual(cat.byId.get('claude-hud').recommendedScope, 'user');
    assert.strictEqual(cat.byId.get('claude-hud').settingsRow, 'claude-hud');
    for (const id of ['typescript-lsp', 'csharp-lsp'])
    {
        assert.deepStrictEqual(cat.byId.get(id).marketplace, { name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official' });
        assert.strictEqual(cat.byId.get(id).recommendedScope, 'project');
    }
});

test('no catalog default name is in the reserved set, and the shipped set is the alfred-code one', (t) => {
    assert.ok(cat.reserved.size >= 17);
    for (const row of cat.tools.filter((r) => r.kind === 'mcp'))
        assert.ok(!cat.reserved.has(row.name), `${row.name} is reserved`);
    assert.ok(cat.reserved.has('browser') && cat.reserved.has('alfred-navigation') && cat.reserved.has('chrome-control'));
    // original names alfred-code exempts stay out
    for (const n of ['serena', 'memory', 'context7', 'appium-mcp', 'windows-desktop', 'macos-desktop', 'playwright-chrome']) assert.ok(!cat.reserved.has(n), n);
    // the 2.0.0 retires stay out (their retire fires only on an update from before 2.0.0)
    for (const n of ['sentry', 'context7-local', 'angular-cli', 'chrome-devtools']) assert.ok(!cat.reserved.has(n), n);
    const alfred = path.join(ROOT, '..', 'alfred-code');
    if (!fs.existsSync(path.join(alfred, 'meta', 'retired-plugins.json'))) return t.skip('no alfred-code checkout beside this repo');
    const { reservedFrom } = require('../scripts/refresh-reserved.js');
    assert.deepStrictEqual([...cat.reserved].sort(), reservedFrom(alfred));
});

test('every fix row has the fields the brief names and points at an existing row and a distinct id', () => {
    const FIX = ['id', 'tool', 'os', 'symptom', 'detect', 'fix', 'verifiedOn', 'source'];
    assert.strictEqual(new Set(cat.fixes.map((f) => f.id)).size, cat.fixes.length);
    assert.deepStrictEqual(cat.fixes.map((f) => f.id), ['serena-windows-home', 'serena-windows-ts-shim', 'uvx-python', 'windows-arm-python',
        'windows-npx-cmd', 'playwright-webmcp', 'appium-sdk-env', 'serena-telemetry', 'typescript-lsp-ts7']);
    for (const f of cat.fixes)
    {
        for (const k of FIX) assert.ok(f[k] !== undefined && f[k] !== '', `${f.id} lacks ${k}`);
        for (const t of f.tool) assert.ok(cat.byId.has(t), `${f.id}: unknown row ${t}`);
        assert.ok(f.os.every((o) => OSES.includes(o)), f.id);
    }
});
