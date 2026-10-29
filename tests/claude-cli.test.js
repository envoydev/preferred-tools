'use strict';
// claude-cli.js: the cmd.exe route npm's claude.cmd takes on Windows. Every argument must reach the CLI as written - a
// JSON quote, %VAR%, carets, & and |, backslashes before a quote or the end, an empty argument.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../scripts/claude-cli.js');

test('argvQuote: the Windows argv rules - backslashes before a quote doubled plus one, before the end doubled, others kept', () =>
{
    assert.strictEqual(cli.argvQuote('plain'), '"plain"');
    assert.strictEqual(cli.argvQuote(''), '""');
    assert.strictEqual(cli.argvQuote('q"q'), '"q\\"q"');
    assert.strictEqual(cli.argvQuote('a\\"b'), '"a\\\\\\"b"');
    assert.strictEqual(cli.argvQuote('C:\\dir\\'), '"C:\\dir\\\\"');
    assert.strictEqual(cli.argvQuote('C:\\a b\\c'), '"C:\\a b\\c"');
});

test('cmdArg: the argv quoting, then each cmd.exe metacharacter caret-escaped twice (cmd /c, then the .cmd file\'s %* line)', () =>
{
    assert.strictEqual(cli.cmdArg('a&b'), '^^^"a^^^&b^^^"');
    assert.strictEqual(cli.cmdArg('%PATH%'), '^^^"^^^%PATH^^^%^^^"');
    assert.strictEqual(cli.cmdArg('q"q'), '^^^"q\\^^^"q^^^"');
});

const NASTY = [JSON.stringify({ env: { K: 's%^"abc' } }), '%PATH%', 'x&y|z<>', 'caret^^', 'C:\\dir\\', 'a\\\\"b', '', 'a b', 'ünï'];

test('Windows: every argument reaches a .cmd shim through cmd.exe as written', { skip: process.platform !== 'win32' && 'NOT RUN: the cmd.exe route is Windows-only' }, () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-cli-'));
    try
    {
        fs.writeFileSync(path.join(dir, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
        // npm's shim shape: the node binary, the script beside the shim, %*
        fs.writeFileSync(path.join(dir, 'claude.cmd'), `@"${process.execPath}" "%~dp0\\echo.js" %*\r\n`);
        // only the shim's folder and System32: a real claude.exe further down PATH would be spawned directly instead
        const env = { ...process.env, PATH: [dir, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';') };
        const r = cli.run(NASTY, { env });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(JSON.parse(r.stdout), NASTY);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
