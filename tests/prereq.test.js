'use strict';
// prereq.js: read-only checks of the machine, a missing one named with its install line or its vendor page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('../scripts/catalog.js');
const prereq = require('../scripts/prereq.js');

const catalog = catalogLib.load();

function machine({ files = [], bins = {}, out = {}, real = {}, node = '24.1.0' } = {})
{
    const calls = [];
    return {
        calls,
        exists: (p) => files.includes(p),
        which: (n) => bins[n] || null,
        realpath: (p) => real[p] || p,
        nodeVersion: node,
        run: (cmd, args) => { calls.push([cmd, ...args].join(' ')); const r = out[[cmd, ...args].join(' ')] || out[cmd]; return r ? { status: 0, ...r } : { status: 1, stdout: '', stderr: '' }; },
    };
}
const ctx = (m, over = {}) => ({ platform: 'darwin', env: {}, home: '/Users/dev', machine: m, ...over });
const one = (id, c) => prereq.CHECKS[id](c);

test('every prerequisite id the catalog uses has a check', () =>
{
    const ids = new Set();
    for (const r of catalog.tools)
        for (const list of r.kind === 'plugin' ? [r.prereqs || []] : Object.values(r.routes).map((x) => x.prereqs || [])) list.forEach((i) => ids.add(i));
    for (const id of ids) assert.strictEqual(typeof prereq.CHECKS[id], 'function', id);
    assert.deepStrictEqual([...ids].sort(), Object.keys(prereq.CHECKS).sort(), 'and no check is left without a user');
});

test('uvx and npx: found on the PATH, or the vendor page is named', () =>
{
    assert.deepStrictEqual(one('uvx', ctx(machine({ bins: { uvx: '/bin/uvx' }, out: { 'uvx --version': { stdout: 'uv 0.9.2\n' } } }))), { ok: true, found: 'uvx 0.9.2' });
    const no = one('uvx', ctx(machine()));
    assert.strictEqual(no.ok, false);
    assert.strictEqual(no.install.url, 'https://docs.astral.sh/uv/getting-started/installation/');
    assert.ok(!no.install.command, 'no command is printed that the vendor docs did not give');
    assert.strictEqual(one('npx', ctx(machine({ bins: { npx: '/usr/bin/npx' } }))).ok, true);
    assert.strictEqual(one('npx', ctx(machine())).install.url, 'https://nodejs.org/en/download');
});

test('node-lsp: Node 22.22.2 or newer', () =>
{
    assert.strictEqual(one('node-lsp', ctx(machine({ node: '22.22.2' }))).ok, true);
    assert.strictEqual(one('node-lsp', ctx(machine({ node: '24.0.0' }))).ok, true);
    const old = one('node-lsp', ctx(machine({ node: '22.22.1' })));
    assert.strictEqual(old.ok, false);
    assert.match(old.install.note, /22\.22\.2/);
    assert.strictEqual(one('node-lsp', ctx(machine({ node: '20.11.0' }))).ok, false);
});

test('ts-lsp: the server and TypeScript 6; TypeScript 7 or no server gets the recorded npm line', () =>
{
    const ls = (v) => ({ 'npm ls -g typescript --json --depth=0': { stdout: JSON.stringify({ dependencies: { typescript: { version: v } } }) } });
    const bins = { 'typescript-language-server': '/usr/local/bin/typescript-language-server' };
    assert.deepStrictEqual(one('ts-lsp', ctx(machine({ bins, out: ls('6.0.3') }))), { ok: true, found: 'typescript-language-server, typescript 6.0.3' });
    for (const m of [machine({ bins, out: ls('7.0.2') }), machine({ out: ls('6.0.3') }), machine({ bins })])
    {
        const r = one('ts-lsp', ctx(m));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.install.command, 'npm install -g typescript-language-server typescript@6');
    }
});

test('csharp-ls: needs a .NET SDK 6+ first, then csharp-ls (brew on macOS, dotnet tool elsewhere)', () =>
{
    const dotnet = (v) => ({ 'dotnet --version': { stdout: `${v}\n` } });
    const bins = { dotnet: '/usr/local/bin/dotnet', 'csharp-ls': '/x/csharp-ls' };
    assert.strictEqual(one('csharp-ls', ctx(machine({ bins, out: dotnet('10.0.100') }))).ok, true);
    const noSdk = one('csharp-ls', ctx(machine()));
    assert.strictEqual(noSdk.found, 'no .NET SDK');
    assert.strictEqual(noSdk.install.url, 'https://dotnet.microsoft.com/download');
    const old = one('csharp-ls', ctx(machine({ bins: { dotnet: '/d' }, out: dotnet('5.0.408') })));
    assert.match(old.found, /\.NET SDK 5\.0\.408/);
    const mac = one('csharp-ls', ctx(machine({ bins: { dotnet: '/d' }, out: dotnet('9.0.100') })));
    assert.strictEqual(mac.install.command, 'brew install csharp-ls');
    assert.strictEqual(one('csharp-ls', ctx(machine({ bins: { dotnet: '/d' }, out: dotnet('9.0.100') }), { platform: 'linux' })).install.command, 'dotnet tool install --global csharp-ls');
});

test('browser-chrome and browser-msedge: where each OS installs them', () =>
{
    assert.strictEqual(one('browser-chrome', ctx(machine({ files: ['/Applications/Google Chrome.app'] }))).ok, true);
    assert.strictEqual(one('browser-msedge', ctx(machine({ files: ['/Applications/Microsoft Edge.app'] }))).ok, true);
    assert.strictEqual(one('browser-chrome', ctx(machine({ files: ['/Applications/Microsoft Edge.app'] }))).ok, false);
    assert.strictEqual(one('browser-chrome', ctx(machine({ bins: { 'google-chrome-stable': '/usr/bin/google-chrome-stable' } }), { platform: 'linux' })).ok, true);
    assert.strictEqual(one('browser-chrome', ctx(machine(), { platform: 'linux' })).ok, false);
    const win = (files) => ctx(machine({ files }), { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, home: 'C:\\Users\\dev' });
    assert.strictEqual(one('browser-chrome', win(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'])).ok, true);
    assert.strictEqual(one('browser-msedge', win(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'])).ok, true);
    assert.strictEqual(one('browser-msedge', win([])).ok, false);
    assert.match(one('browser-chrome', ctx(machine())).install.note, /name a browser binary/);
});

test('docker-or-github-binary: docker, else the binary, else the page - and the plan is told which', () =>
{
    assert.deepStrictEqual(one('docker-or-github-binary', ctx(machine({ bins: { docker: '/usr/bin/docker' } }))).machine, { docker: true });
    const bin = one('docker-or-github-binary', ctx(machine({ bins: { 'github-mcp-server': '/usr/bin/github-mcp-server' } })));
    assert.strictEqual(bin.ok, true);
    assert.deepStrictEqual(bin.machine, { docker: false }, 'no docker: the binary fallback');
    const none = one('docker-or-github-binary', ctx(machine()));
    assert.strictEqual(none.ok, false);
    assert.match(none.install.note, /github-mcp-server\/releases/);
});

test('android-sdk and jdk: looked up as the appium fix looks them up', () =>
{
    const m = machine({ files: ['/Users/dev/Library/Android/sdk', '/opt/jdk', '/opt/jdk/bin/java'], out: { '/usr/libexec/java_home': { stdout: '/opt/jdk\n' } } });
    assert.deepStrictEqual(one('android-sdk', ctx(m)), { ok: true, found: '/Users/dev/Library/Android/sdk' });
    assert.deepStrictEqual(one('jdk', ctx(m)), { ok: true, found: '/opt/jdk' });
    assert.strictEqual(one('android-sdk', ctx(machine())).install.url, 'https://developer.android.com/studio');
    assert.strictEqual(one('jdk', ctx(machine())).ok, false);
});

test('check: each pick on its own route; a remote route needs nothing; the machine facts come back for the plan', () =>
{
    const m = machine({ bins: { npx: '/usr/bin/npx' } });
    const res = prereq.check([{ row: 'context7', route: 'remote' }, { row: 'context7', route: 'local' }, { row: 'github', route: 'local' }, { row: 'claude-hud', route: null }], ctx(m), catalog);
    assert.deepStrictEqual(res.tools.map((t) => [t.row, t.route, t.needs.map((n) => `${n.id}:${n.ok}`)]), [
        ['context7', 'remote', []], ['context7', 'local', ['npx:true']], ['github', 'local', ['docker-or-github-binary:false']], ['claude-hud', null, []],
    ]);
    assert.strictEqual(res.missing, 1);
    assert.deepStrictEqual(res.machine, { docker: true });
    const text = prereq.render(res);
    assert.match(text, /^context7 \(remote\): nothing to check$/m);
    assert.match(text, /^github \(local\): docker-or-github-binary - MISSING$/m);
    assert.match(text, /prereq: 1 missing$/);
});

test('main: an answers file, --rows, --json; a bad argument exits 2 and checks nothing', () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-prereq-'));
    try
    {
        const file = path.join(dir, 'answers.json');
        fs.writeFileSync(file, JSON.stringify({ picks: { serena: {}, context7: { route: 'remote' } } }));
        const m = machine({ bins: { uvx: '/bin/uvx' } });
        let text = '';
        const out = (s) => { text += `${s}\n`; };
        assert.strictEqual(prereq.main([file], { env: {}, machine: m, platform: 'darwin', out }), 0);
        assert.match(text, /serena \(local\): uvx - ok/);
        text = '';
        prereq.main(['--rows', 'serena,context7', '--json'], { env: {}, machine: m, platform: 'darwin', out });
        const json = JSON.parse(text);
        assert.deepStrictEqual(json.tools.map((t) => [t.row, t.route]), [['serena', 'local'], ['context7', 'remote']]);
        // configure: only a change to another route is checked
        fs.writeFileSync(file, JSON.stringify({ change: { 'mcp:c7~project': { row: 'context7', route: 'local' }, 'mcp:serena~user': { row: 'serena', name: 'nav' } } }));
        text = '';
        prereq.main([file, '--json'], { env: {}, machine: m, platform: 'darwin', out });
        assert.deepStrictEqual(JSON.parse(text).tools.map((t) => [t.row, t.route]), [['context7', 'local']]);
        for (const bad of [[], ['--rows', 'no-such-tool'], [path.join(dir, 'missing.json')]])
        {
            text = '';
            assert.strictEqual(prereq.main(bad, { env: {}, machine: m, platform: 'darwin', out }), 2, JSON.stringify(bad));
        }
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: the package is audited in a temp folder with --ignore-scripts and the row\'s cut-off; counts come from npm\'s JSON even when npm exits non-zero; a failure says it did not run', () =>
{
    const seen = [];
    const mk = ({ lock = 0, audit = 1, json } = {}) => ({
        ...machine(),
        run: (cmd, args, opts = {}) =>
        {
            seen.push({ line: [cmd, ...args].join(' '), cwd: opts.cwd, before: (opts.env || {}).npm_config_before, pkg: opts.cwd && fs.existsSync(path.join(opts.cwd, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(opts.cwd, 'package.json'), 'utf8')) : null });
            if (args[0] === 'install') return { status: lock, stdout: '', stderr: lock ? 'ENOTFOUND registry.npmjs.org' : '' };
            return { status: audit, stdout: json === undefined ? JSON.stringify({ metadata: { vulnerabilities: { low: 2, moderate: 0, high: 17, critical: 3, total: 22 } } }) : json, stderr: '' };
        },
    });
    const pick = [{ row: 'appium', route: 'local' }];
    const res = prereq.check(pick, ctx(mk()), catalog, { withAudit: true });
    assert.deepStrictEqual(res.tools[0].audit, { package: 'appium-mcp@1.97.1', ok: true, counts: { critical: 3, high: 17, moderate: 0, low: 2, total: 22 } });
    const install = seen.find((s) => /^npm install/.test(s.line));
    assert.match(install.line, /--package-lock-only --ignore-scripts/);
    assert.strictEqual(install.before, '2026-10-20T23:59:59Z', 'resolved at the row\'s cut-off, as npx will');
    assert.deepStrictEqual(install.pkg.dependencies, { 'appium-mcp': '1.97.1' });
    assert.ok(!fs.existsSync(install.cwd), 'the temp folder is removed');
    assert.match(prereq.render(res), /^appium: audit - appium-mcp@1\.97\.1 has 22 known vulnerabilities in its dependency tree \(3 critical, 17 high, 0 moderate, 2 low\)$/m);
    // not asked for: not run, no npm call
    seen.length = 0;
    assert.strictEqual(prereq.check(pick, ctx(mk()), catalog).tools[0].audit, undefined);
    assert.strictEqual(seen.filter((x) => /^npm /.test(x.line)).length, 0, 'no npm call without --audit');
    // offline, or output that is not npm's JSON: 'not run', never 'clean'
    const offline = prereq.check(pick, ctx(mk({ lock: 1 })), catalog, { withAudit: true }).tools[0].audit;
    assert.strictEqual(offline.ok, false);
    assert.match(offline.note, /audit not run: npm install --package-lock-only failed: ENOTFOUND/);
    assert.match(prereq.check(pick, ctx(mk({ json: 'oops' })), catalog, { withAudit: true }).tools[0].audit.note, /audit not run: npm audit gave no result/);
    // a row that is not marked for audit is not audited
    assert.strictEqual(prereq.check([{ row: 'sentry', route: 'local' }], ctx(mk()), catalog, { withAudit: true }).tools[0].audit, undefined);
});
