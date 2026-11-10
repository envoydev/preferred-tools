'use strict';
// keys.js - where a token route's key comes from (D7), and how it is written into a registration by scope.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { world } = require('./helpers.js');
const catalogLib = require('../scripts/catalog.js');
const keys = require('../scripts/keys.js');
const { resolveVersion } = require('./probes/alfred-workspace.js');

const catalog = catalogLib.load();
const row = (id) => catalog.byId.get(id);
const val = () => `v-${crypto.randomBytes(8).toString('hex')}`;
const S = 'SENTRY_ACCESS_TOKEN';
const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const dotenv = (pairs) => `${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
const git = (dir, ignore) => { fs.mkdirSync(dir, { recursive: true }); spawnSync('git', ['init', '-q', dir]); if (ignore) put(path.join(dir, '.gitignore'), `${ignore}\n`); };
const opts = (w, alfredEnabled) => ({ env: w.env, alfredEnabled });

// a fixture engine with v3.2.1's exports: the project's store, then the workspace parent's, nearest first
function fixtureEngine(project, parent)
{
    put(path.join(project, '.claude', 'hooks', 'secret-chain.js'), `'use strict';
const fs = require('fs');
const path = require('path');
const SECRET_FILES = ['.secrets', '.sensitive-data'];
const readStore = (f) => { try { return Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\\r?\\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch { return {}; } };
const storesOf = (start) => [[start, '.'], [${JSON.stringify(parent)}, '..']].map(([root, rel]) => ({ file: path.join(root, '.alfred', '.secrets'), root, rel })).filter((s) => fs.existsSync(s.file));
function valuesOf(stores) { const values = {}; const from = {}; for (const s of stores) for (const [k, v] of Object.entries(readStore(s.file))) if (!(k in values)) { values[k] = v; from[k] = s.rel; } return { values, from }; }
const masker = () => (t) => t;
function chainOf(start) { const stores = storesOf(start); return { stores, ...valuesOf(stores), notes: [] }; }
module.exports = { SECRET_FILES, readStore, storesOf, valuesOf, masker, chainOf };
`);
}

test('local scope with alfred-code enabled reads its chain, a workspace parent\'s store included', () => {
    const w = world();
    try
    {
        const ws = path.join(w.dir, 'ws');
        const api = path.join(ws, 'api');
        git(ws, '.alfred/');
        git(api, '.alfred/');
        const [s, g, gp] = [val(), val(), val()];
        put(path.join(api, '.alfred', '.secrets'), dotenv({ [S]: s }));
        put(path.join(ws, '.alfred', '.secrets'), dotenv({ [S]: val(), [G]: gp }));
        put(path.join(api, '.preferred-tools', '.secrets'), dotenv({ [G]: g }));
        fixtureEngine(api, ws);
        const k = keys.keysFor(api, 'local', [S, G], opts(w, true));
        assert.strictEqual(k.error, undefined);
        assert.strictEqual(k.source, 'alfred-code');
        assert.deepStrictEqual(k.found, { [S]: s, [G]: gp }, "the project's own value first, the parent's for a key it lacks - never .preferred-tools");
        assert.deepStrictEqual(k.missing, []);
        assert.strictEqual(k.from[G], path.join(ws, '.alfred', '.secrets'));
    }
    finally { w.clean(); }
});

for (const version of ['2.11.0', '3.2.1'])
    test(`contract: the v${version} secret-chain.js chainOf returns the merged values`, (t) => {
        const src = resolveVersion(version);
        if (src.notRun) return t.skip(`NOT RUN - ${src.notRun}`);
        const w = world();
        try
        {
            const project = path.join(w.dir, 'p');
            git(project, '.alfred/');
            const hooks = path.join(project, '.claude', 'hooks');
            fs.mkdirSync(hooks, { recursive: true });
            for (const f of ['secret-chain.js', 'layout.js'])
            {
                const body = src.tree ? fs.readFileSync(path.join(src.tree, 'stack', 'hooks', f), 'utf8') : spawnSync('git', ['-C', src.git, 'show', `${src.tag}:stack/hooks/${f}`], { encoding: 'utf8' }).stdout;
                assert.ok(body.length > 0, `${f} at v${version}`);
                fs.writeFileSync(path.join(hooks, f), body);
            }
            const [s, g] = [val(), `a%b^c"d-${val()}`];
            put(path.join(project, '.alfred', '.secrets'), `# keys\nexport ${S}=${s}\n${G}='${g}'\n`);
            const k = keys.keysFor(project, 'local', [S, G], { env: { HOME: w.home, USERPROFILE: w.home, PATH: process.env.PATH }, alfredEnabled: true });
            assert.strictEqual(k.error, undefined, k.error);
            assert.deepStrictEqual(k.found, { [S]: s, [G]: g });
        }
        finally { w.clean(); }
    });

test('local scope without alfred-code reads the project file, then the home file', () => {
    const w = world();
    try
    {
        const [s, g] = [val(), val()];
        put(path.join(w.project, '.preferred-tools', '.secrets'), dotenv({ [S]: s }));
        put(path.join(w.home, '.preferred-tools', '.secrets'), dotenv({ [S]: val(), [G]: g }));
        const k = keys.keysFor(w.project, 'local', [S, G, 'CONTEXT7_API_KEY'], opts(w, false));
        assert.strictEqual(k.source, 'preferred-tools');
        assert.deepStrictEqual(k.found, { [S]: s, [G]: g });
        assert.deepStrictEqual(k.missing, ['CONTEXT7_API_KEY']);
        assert.deepStrictEqual(k.files, [path.join(w.project, '.preferred-tools', '.secrets'), path.join(w.home, '.preferred-tools', '.secrets')]);
    }
    finally { w.clean(); }
});

test('user scope reads the home file first, then the alfred-code chain of the project the command runs in', () => {
    const w = world();
    try
    {
        const [s, g] = [val(), val()];
        put(path.join(w.home, '.preferred-tools', '.secrets'), dotenv({ [S]: s }));
        put(path.join(w.project, '.alfred', '.secrets'), dotenv({ [S]: val(), [G]: g }));
        const k = keys.keysFor(w.project, 'user', [S, G], opts(w, true));
        assert.deepStrictEqual(k.found, { [S]: s, [G]: g });
        assert.strictEqual(k.from[S], path.join(w.home, '.preferred-tools', '.secrets'));
        assert.strictEqual(k.from[G], path.join(w.project, '.alfred', '.secrets'));
        const alone = keys.keysFor(w.project, 'user', [G], opts(w, false));
        assert.deepStrictEqual(alone.missing, [G], 'without alfred-code, the home file only');
    }
    finally { w.clean(); }
});

test('project scope reads nothing', () => {
    const w = world();
    try
    {
        put(path.join(w.project, '.preferred-tools', '.secrets'), dotenv({ [S]: val() }));
        put(path.join(w.home, '.preferred-tools', '.secrets'), dotenv({ [S]: val() }));
        assert.deepStrictEqual(keys.keysFor(w.project, 'project', [S], opts(w, false)), { source: 'none', files: [], found: {}, from: {}, missing: [] });
    }
    finally { w.clean(); }
});

test('the dotenv grammar: comments, export, quotes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-keys-'));
    try
    {
        const f = path.join(dir, '.secrets');
        fs.writeFileSync(f, '﻿# a comment\n; another\n\nexport A=1\r\nB = "two words" \nC=\'q\'\nD=x=y\nnot a pair\n9BAD=no\nE=\n');
        assert.deepStrictEqual(keys.readDotenv(f), { A: '1', B: 'two words', C: 'q', D: 'x=y', E: '' });
        fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A=wide\r\n', 'utf16le')]));
        assert.deepStrictEqual(keys.readDotenv(f), { A: 'wide' }, 'a UTF-16 file from a Windows editor');
        assert.strictEqual(keys.readDotenv(path.join(dir, 'none')), null);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a changed alfred-code engine is a named error and the ${VAR} stays', () => {
    const w = world();
    try
    {
        put(path.join(w.project, '.alfred', '.secrets'), dotenv({ [S]: val() }));
        const engine = path.join(w.project, '.claude', 'hooks', 'secret-chain.js');
        for (const body of ["module.exports = { storesOf() {} };\n", "module.exports = { chainOf() { throw new Error('layout moved'); } };\n", 'module.exports = { chainOf: () => ({}) };\n'])
        {
            put(engine, body);
            const k = keys.keysFor(w.project, 'local', [S], opts(w, true));
            assert.match(k.error, /secret-chain\.js/, body);
            assert.deepStrictEqual(k.found, {});
            const entry = { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { [S]: `\${${S}}` } };
            assert.deepStrictEqual(keys.fillKeys(entry, row('sentry'), 'local', 'local', k.found), entry);
        }
    }
    finally { w.clean(); }
});

test('alfred-code enabled with no engine reads .alfred/.secrets, then .alfred/.sensitive-data', () => {
    const w = world();
    try
    {
        const [s, g] = [val(), val()];
        put(path.join(w.project, '.alfred', '.secrets'), dotenv({ [S]: s }));
        put(path.join(w.project, '.alfred', '.sensitive-data'), dotenv({ [S]: val(), [G]: g }));
        const k = keys.keysFor(w.project, 'local', [S, G], opts(w, true));
        assert.strictEqual(k.source, 'alfred-code');
        assert.deepStrictEqual(k.found, { [S]: s, [G]: g });
    }
    finally { w.clean(); }
});

test('with alfred-code enabled, a key only in .preferred-tools/.secrets is missing', () => {
    const w = world();
    try
    {
        put(path.join(w.project, '.alfred', '.secrets'), dotenv({ OTHER: val() }));
        put(path.join(w.project, '.preferred-tools', '.secrets'), dotenv({ [S]: val() }));
        put(path.join(w.home, '.preferred-tools', '.secrets'), dotenv({ [S]: val() }));
        const k = keys.keysFor(w.project, 'local', [S], opts(w, true));
        assert.deepStrictEqual(k.missing, [S]);
        assert.deepStrictEqual(k.files, [path.join(w.project, '.alfred', '.secrets'), path.join(w.project, '.alfred', '.sensitive-data')], 'the report names the file the key must go in');
    }
    finally { w.clean(); }
});

test('a project key file git does not ignore is refused and named, alfred-code\'s store included', () => {
    const w = world();
    try
    {
        git(w.project);
        put(path.join(w.project, '.preferred-tools', '.secrets'), dotenv({ [S]: val() }));
        put(path.join(w.home, '.preferred-tools', '.secrets'), dotenv({ [S]: val() }));
        const k = keys.keysFor(w.project, 'local', [S], opts(w, false));
        assert.match(k.error, /\.preferred-tools[\\/]\.secrets is not git-ignored/);
        assert.deepStrictEqual(k.found, {}, 'nothing read past the refused file');
        put(path.join(w.project, '.preferred-tools', '.gitignore'), '*\n');
        assert.strictEqual(keys.keysFor(w.project, 'local', [S], opts(w, false)).error, undefined, 'ignored: read');

        put(path.join(w.project, '.alfred', '.secrets'), dotenv({ [S]: val() }));
        const a = keys.keysFor(w.project, 'local', [S], opts(w, true));
        assert.match(a.error, /\.alfred[\\/]\.secrets is not git-ignored/);
        assert.deepStrictEqual(a.found, {});
    }
    finally { w.clean(); }
});

test('alfred-code enabled in a project it never set up (no engine, no store) reads .preferred-tools/.secrets', () => {
    const w = world();
    try
    {
        const s = val();
        put(path.join(w.project, '.preferred-tools', '.secrets'), dotenv({ [S]: s }));
        const k = keys.keysFor(w.project, 'local', [S], opts(w, true));
        assert.strictEqual(k.source, 'preferred-tools');
        assert.deepStrictEqual(k.found, { [S]: s });
    }
    finally { w.clean(); }
});

test('fillKeys writes each token field a stdio route defines: the ${VAR} form at project scope, the value at local and user; a hosted route has none', () => {
    const v = `x%y^z"${val()}`;
    // a hosted route's key is read by mcp-headers.js: the entry holds no token field, and an old header is fix's to move
    const hosted = { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer old', 'X-Other': 'keep' } };
    for (const scope of ['project', 'local', 'user']) assert.deepStrictEqual(keys.fillKeys(hosted, row('github'), 'remote', scope, { [G]: v }), hosted, scope);
    const docker = { command: 'docker', args: ['run', '-i', '--rm', '-e', G, 'ghcr.io/github/github-mcp-server:v2.1.0', 'stdio'], env: { [G]: 'old' } };
    assert.deepStrictEqual(keys.fillKeys(docker, row('github'), 'local', 'project', { [G]: v }).env, { [G]: `\${${G}}` }, 'a project registration already there keeps the reference');
    assert.deepStrictEqual(keys.fillKeys(docker, row('github'), 'local', 'local', { [G]: v }).env, { [G]: v });
    assert.deepStrictEqual(keys.fillKeys(docker, row('github'), 'local', 'user', {}), docker, 'a missing key keeps what the entry holds');
    const c7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4', '--api-key', '${CONTEXT7_API_KEY}'] };
    assert.deepStrictEqual(keys.fillKeys(c7, row('context7'), 'local', 'local', { CONTEXT7_API_KEY: v }).args.slice(-2), ['--api-key', v]);
    const noToken = { type: 'http', url: 'https://mcp.context7.com/mcp' };
    assert.deepStrictEqual(keys.fillKeys(noToken, row('context7'), 'remote', 'local', { CONTEXT7_API_KEY: v }), noToken, 'an optional token not asked for is not added');
    const sentry = { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { [S]: 'old', OTHER: '1' } };
    assert.deepStrictEqual(keys.fillKeys(sentry, row('sentry'), 'local', 'local', { [S]: v }).env, { [S]: v, OTHER: '1' });
    assert.strictEqual(sentry.env[S], 'old', 'the entry given is not changed');
    assert.deepStrictEqual(keys.fillKeys(sentry, row('serena'), 'local', 'local', { [S]: v }), sentry, 'a route with no token');
});

// ---- presence: names only, from plain files, for the plan's token line (no engine run: plan.js is pre-approved) -------

function presenceWorld(w)
{
    const ws = path.join(w.dir, 'ws');
    const api = path.join(ws, 'api');
    git(ws, '.alfred/');
    git(api, '.alfred/');
    const v = { v1: val(), v2: val(), v3: val() };
    // the parent's store in UTF-16 with a BOM, the project's with an `export` line
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(dotenv({ ACME_GITHUB_ACCESS_TOKEN: v.v1, CONTEXT7_API_KEY: v.v2 }), 'utf16le')]);
    put(path.join(ws, '.alfred', '.secrets'), utf16);
    put(path.join(api, '.alfred', '.secrets'), `export ${S}=${v.v3}\n`);
    const engine = path.join(api, '.claude', 'hooks', 'secret-chain.js');
    const marker = path.join(w.dir, 'engine-ran');
    put(engine, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nmodule.exports = { chainOf: () => ({ values: {}, stores: [] }) };\n`);
    return { ws, api, v, engine, marker };
}

test('presence: a name in this folder\'s or a parent\'s .alfred/.secrets, a near-miss, no value, no engine run', () => {
    const w = world();
    try
    {
        const { ws, api, v, engine, marker } = presenceWorld(w);
        const p = keys.presence(api, 'local', [{ name: G, word: 'GITHUB' }, { name: 'CONTEXT7_API_KEY', word: 'CONTEXT7' }, { name: S, word: 'SENTRY' }], opts(w, true));
        assert.deepStrictEqual(p.found, { [G]: null, CONTEXT7_API_KEY: path.join(ws, '.alfred', '.secrets'), [S]: path.join(api, '.alfred', '.secrets') });
        assert.deepStrictEqual(p.near[G], [{ name: 'ACME_GITHUB_ACCESS_TOKEN', file: path.join(ws, '.alfred', '.secrets') }]);
        for (const value of Object.values(v)) assert.ok(!JSON.stringify(p).includes(value), 'no value leaves presence');
        assert.ok(!fs.existsSync(marker), 'the engine was not required');
        // no engine (alfred-code before 3.x): the apply reads this folder's stores only, and so does presence
        fs.rmSync(engine);
        assert.strictEqual(keys.presence(api, 'local', [{ name: 'CONTEXT7_API_KEY', word: 'CONTEXT7' }], opts(w, true)).found.CONTEXT7_API_KEY, null);
    }
    finally { w.clean(); }
});

test('presence: a near-miss is a key-shaped name with the row word in any case - not any name that holds the word', () => {
    const w = world();
    try
    {
        const proj = path.join(w.dir, 'p');
        put(path.join(proj, '.preferred-tools', '.secrets'), dotenv({ GITHUB_WEBHOOK_SECRET: val(), GITHUB_CLIENT_ID: val(), github_token: val(), MY_GITHUB_PAT: val(), GITHUB_API_KEY: val() }));
        const near = keys.presence(proj, 'local', [{ name: G, word: 'GITHUB' }], { ...opts(w, false), home: null }).near[G].map((n) => n.name);
        assert.deepStrictEqual(near, ['github_token', 'MY_GITHUB_PAT', 'GITHUB_API_KEY']);
    }
    finally { w.clean(); }
});

test('presence follows the scope: user reads the home file first; project reads the local list; alfred-code off reads preferred-tools\' files', () => {
    const w = world();
    try
    {
        const { api } = presenceWorld(w);
        const homeFile = path.join(w.home, '.preferred-tools', '.secrets');
        put(homeFile, dotenv({ [S]: val() }));
        const wants = [{ name: S, word: 'SENTRY' }];
        assert.strictEqual(keys.presence(api, 'user', wants, opts(w, true)).found[S], homeFile);
        assert.strictEqual(keys.presence(api, 'local', wants, opts(w, true)).found[S], path.join(api, '.alfred', '.secrets'));
        assert.deepStrictEqual(keys.presence(api, 'project', wants, opts(w, true)), keys.presence(api, 'local', wants, opts(w, true)));
        assert.strictEqual(keys.presence(api, 'local', wants, opts(w, false)).found[S], homeFile, 'alfred-code off: .preferred-tools, then the home file');
        assert.strictEqual(keys.presence(api, 'user', wants, { ...opts(w, true), home: null }).found[S], path.join(api, '.alfred', '.secrets'), 'home null: no home file read');
    }
    finally { w.clean(); }
});

// ---- 0.2.0: .mcps-secrets chains (spec D3) ---------------------------------------------------------------------------

const sec = (dir) => path.join(dir, '.mcps-secrets');

test('hosted chain per scope: the root beside the helper, the named global root at local scope only, then the two home files', () => {
    const p = path.join(path.sep, 'w', 'p', '.alfred');
    const k = path.join(path.sep, 'k');
    const h = path.join(path.sep, 'h');
    const homeFiles = [sec(path.join(h, '.preferred-tools')), sec(path.join(h, '.alfred'))];
    assert.deepStrictEqual(keys.hostedChain({ scope: 'project', projectRoot: p, globalRoot: k, globalNamed: true, home: h }), [sec(p), ...homeFiles]);
    assert.deepStrictEqual(keys.hostedChain({ scope: 'local', projectRoot: p, globalRoot: k, globalNamed: true, home: h }), [sec(p), sec(k), ...homeFiles]);
    assert.deepStrictEqual(keys.hostedChain({ scope: 'local', projectRoot: p, globalRoot: k, globalNamed: false, home: h }), [sec(p), ...homeFiles], 'a global root that is not named is not the third argument');
    assert.deepStrictEqual(keys.hostedChain({ scope: 'user', projectRoot: p, globalRoot: path.join(h, '.preferred-tools'), globalNamed: false, home: h }), homeFiles, 'duplicates dropped');
    assert.deepStrictEqual(keys.hostedChain({ scope: 'user', projectRoot: p, globalRoot: k, globalNamed: true, home: h }), [sec(k), ...homeFiles]);
});

test('stdio chain: local reads the project root then the global root; global reads the global root alone', () => {
    const p = path.join(path.sep, 'w', 'p', '.preferred-tools');
    const g = path.join(path.sep, 'h', '.preferred-tools');
    assert.deepStrictEqual(keys.stdioChain({ scope: 'local', projectRoot: p, globalRoot: g }), [sec(p), sec(g)]);
    assert.deepStrictEqual(keys.stdioChain({ scope: 'user', projectRoot: p, globalRoot: g }), [sec(g)]);
    assert.deepStrictEqual(keys.stdioChain({ scope: 'project', projectRoot: p, globalRoot: g }), [], 'a stdio keyed route is not offered at project scope');
});

test('valueIn: the first non-empty value wins, an empty value is missing, and the dotenv grammar is readDotenv\'s', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-keys-'));
    try
    {
        const a = path.join(dir, 'a', '.mcps-secrets');
        const b = path.join(dir, 'b', '.mcps-secrets');
        const v = val();
        put(a, 'A=\n# comment\n');
        put(b, `A=${v}\n`);
        assert.deepStrictEqual(keys.valueIn([a, b], 'A'), { value: v, file: b });
        assert.strictEqual(keys.valueIn([a, path.join(dir, 'none')], 'A'), null, 'empty and missing are both missing');
        const forms = {
            crlf: Buffer.from('X=1\r\nA=crlf\r\n'),
            bom: Buffer.from('﻿A=bom\n'),
            utf16: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A=utf16\n', 'utf16le')]),
            export: Buffer.from('export A=exported\n'),
            quoted: Buffer.from('A="quoted"\n'),
            equals: Buffer.from('A=b=c\n'),
        };
        for (const [name, bytes] of Object.entries(forms))
        {
            const f = path.join(dir, name, '.mcps-secrets');
            put(f, bytes);
            assert.strictEqual(keys.valueIn([f], 'A').value, keys.readDotenv(f).A, name);
        }
        assert.strictEqual(keys.valueIn([path.join(dir, 'equals', '.mcps-secrets')], 'A').value, 'b=c');
        assert.deepStrictEqual(keys.filledNames([a, b]), [{ file: a, names: [] }, { file: b, names: ['A'] }], 'names only');
        assert.ok(!JSON.stringify(keys.filledNames([a, b])).includes(v), 'no value in filledNames');
        assert.ok(keys.NAME_RULE.test('ACME_GITHUB_TOKEN') && !keys.NAME_RULE.test('1BAD') && !keys.NAME_RULE.test('A-B'));
        assert.strictEqual(keys.SECRETS, '.mcps-secrets');
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('oldHolding names the old file and never the value', () => {
    const w = world();
    try
    {
        const v = val();
        const store = path.join(w.project, '.alfred', '.secrets');
        put(store, dotenv({ [G]: v }));
        const found = keys.oldHolding(w.project, w.home, G);
        assert.strictEqual(found, store);
        assert.ok(!JSON.stringify(found).includes(v));
        assert.strictEqual(keys.oldHolding(w.project, w.home, S), null);
        const files = keys.oldFiles(w.project, w.home);
        assert.deepStrictEqual(files.slice(0, 2), [store, path.join(w.project, '.alfred', '.sensitive-data')]);
        assert.ok(files.includes(path.join(w.project, '.preferred-tools', '.secrets')) && files.includes(path.join(w.home, '.preferred-tools', '.secrets')));
    }
    finally { w.clean(); }
});

test('oldHolding finds a key in a parent folder\'s alfred-code store', () => {
    const w = world();
    try
    {
        const child = path.join(w.project, 'api');
        fs.mkdirSync(child, { recursive: true });
        const rootStore = path.join(w.project, '.alfred', '.secrets');
        put(rootStore, dotenv({ [G]: val() }));
        assert.strictEqual(keys.oldHolding(child, w.home, G), rootStore);
    }
    finally { w.clean(); }
});
