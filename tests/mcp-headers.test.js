'use strict';
// mcp-headers.js - the header helper a hosted registration names as `headersHelper` (spec D4). Each test copies it into
// a throwaway root and runs it with its working folder elsewhere and HOME / USERPROFILE pointing into the throwaway world.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const keys = require('../scripts/keys.js');

const SOURCE = path.join(__dirname, '..', 'scripts', 'mcp-headers.js');
const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sec = (dir) => path.join(dir, '.mcps-secrets');

function world()
{
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-helper-')));
    const root = path.join(dir, 'project', '.preferred-tools');
    const home = path.join(dir, 'home');
    const elsewhere = path.join(dir, 'elsewhere');
    for (const d of [root, home, elsewhere]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(SOURCE, path.join(root, 'mcp-headers.js'));
    const run = (...argv) =>
    {
        const r = spawnSync(process.execPath, [path.join(root, 'mcp-headers.js'), ...argv], { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: JSON.parse(r.stdout) };
    };
    return { dir, root, home, run, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the helper prints the Authorization header from the .mcps-secrets beside it', () => {
    const w = world();
    try
    {
        put(sec(w.root), `# keys\n${G}=fake-1\n`);
        const r = w.run(G, 'Bearer');
        assert.strictEqual(r.status, 0);
        assert.deepStrictEqual(r.json, { Authorization: 'Bearer fake-1' });
        assert.deepStrictEqual(w.run(G, 'Sentry-Bearer').json, { Authorization: 'Sentry-Bearer fake-1' });
    }
    finally { w.clean(); }
});

test('the third argument\'s folder is read after the one beside it, the home files after both', () => {
    const w = world();
    try
    {
        const named = path.join(w.dir, 'keys');
        put(sec(named), `${G}=fake-named\n`);
        put(sec(path.join(w.home, '.preferred-tools')), `${G}=fake-home\n`);
        put(sec(path.join(w.home, '.alfred')), `${G}=fake-alfred\n`);
        put(sec(w.root), `${G}=\n`);
        assert.deepStrictEqual(w.run(G, 'Bearer', named).json, { Authorization: 'Bearer fake-named' }, 'an empty value beside it is missing');
        assert.deepStrictEqual(w.run(G, 'Bearer').json, { Authorization: 'Bearer fake-home' }, 'without the third argument: the home file');
        fs.rmSync(sec(path.join(w.home, '.preferred-tools')));
        assert.deepStrictEqual(w.run(G, 'Bearer').json, { Authorization: 'Bearer fake-alfred' }, 'then ~/.alfred');
        put(sec(w.root), `${G}=fake-beside\n`);
        assert.deepStrictEqual(w.run(G, 'Bearer', named).json, { Authorization: 'Bearer fake-beside' }, 'the file beside it first');
    }
    finally { w.clean(); }
});

test('no value: {} on stdout and one stderr line naming the variable and the files, never a value', () => {
    const w = world();
    try
    {
        put(sec(w.root), 'OTHER_TOKEN=fake-other\n');
        const r = w.run(G, 'Bearer');
        assert.strictEqual(r.status, 0);
        assert.deepStrictEqual(r.json, {});
        const lines = r.stderr.trim().split('\n');
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].includes(G) && lines[0].includes(sec(w.root)), lines[0]);
        assert.ok(!r.stderr.includes('fake-other') && !r.stdout.includes('fake-other'));
    }
    finally { w.clean(); }
});

test('stdout always parses as JSON', () => {
    const w = world();
    try
    {
        assert.deepStrictEqual(w.run().json, {}, 'no arguments');
        assert.deepStrictEqual(w.run(G).json, {}, 'no scheme');
        fs.mkdirSync(sec(w.root));
        assert.deepStrictEqual(w.run(G, 'Bearer').json, {}, 'a directory where the file should be');
        fs.rmdirSync(sec(w.root));
        if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0)
        {
            put(sec(w.root), `${G}=fake-1\n`);
            fs.chmodSync(sec(w.root), 0o000);
            const r = w.run(G, 'Bearer');
            assert.strictEqual(r.status, 0);
            assert.deepStrictEqual(r.json, {}, 'an unreadable key file');
            fs.chmodSync(sec(w.root), 0o600);
        }
    }
    finally { w.clean(); }
});

test('its chain equals keys.hostedChain for project, local and global scope', () => {
    const helper = require('../scripts/mcp-headers.js');
    const h = path.join(path.sep, 'h');
    const p = path.join(path.sep, 'w', 'p', '.alfred');
    const k = path.join(path.sep, 'k');
    const g = path.join(h, '.preferred-tools');
    assert.deepStrictEqual(helper.chainOf(p, null, h), keys.hostedChain({ scope: 'project', projectRoot: p, globalRoot: k, globalNamed: true, home: h }));
    assert.deepStrictEqual(helper.chainOf(p, k, h), keys.hostedChain({ scope: 'local', projectRoot: p, globalRoot: k, globalNamed: true, home: h }));
    assert.deepStrictEqual(helper.chainOf(g, null, h), keys.hostedChain({ scope: 'user', projectRoot: p, globalRoot: g, globalNamed: false, home: h }));
    assert.strictEqual(typeof helper.HELPER_VERSION, 'number');
});

test('it reads the grammar readDotenv reads', () => {
    const w = world();
    try
    {
        const forms = {
            crlf: Buffer.from(`X=1\r\n${G}=crlf\r\n`),
            bom: Buffer.from(`﻿${G}=bom\n`),
            utf16: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${G}=utf16\n`, 'utf16le')]),
            export: Buffer.from(`export ${G}=exported\n`),
            quoted: Buffer.from(`${G}="quoted"\n`),
            equals: Buffer.from(`${G}=b=c\n`),
        };
        for (const [name, bytes] of Object.entries(forms))
        {
            put(sec(w.root), bytes);
            assert.deepStrictEqual(w.run(G, 'Bearer').json, { Authorization: `Bearer ${keys.readDotenv(sec(w.root))[G]}` }, name);
        }
    }
    finally { w.clean(); }
});

test('digestOf reads a CRLF copy as the same helper', () => {
    const helper = require('../scripts/mcp-headers.js');
    const text = fs.readFileSync(SOURCE, 'utf8');
    assert.strictEqual(helper.digestOf(text.replace(/\n/g, '\r\n')), helper.digestOf(text));
    assert.strictEqual(helper.digestOf(Buffer.from(text)), helper.digestOf(text));
    assert.notStrictEqual(helper.digestOf(`${text} `), helper.digestOf(text));
});
