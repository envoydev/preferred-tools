'use strict';
// The one place the `claude` CLI is spawned. Scripts READ files; every write to .mcp.json, the account file and the
// plugin records goes through this (invariant: the CLI is the only writer).
const { spawnSync } = require('node:child_process');

// "C:\a b" -> "\"C:\a b\"" for cmd.exe, only used when claude is a .cmd shim on Windows.
const winQuote = (arg) => (/^[A-Za-z0-9_\-./:=@,+]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`);

function run(args, { cwd, env, input, timeout = 120000 } = {})
{
    const opts = { encoding: 'utf8', cwd, env: env || process.env, input, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    let r = spawnSync('claude', args, opts);
    // npm's claude.cmd cannot be spawned directly on Windows (ENOENT or EINVAL): go through cmd.exe with quoted arguments.
    if (process.platform === 'win32' && r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL'))
        r = spawnSync(['claude', ...args].map(winQuote).join(' '), { ...opts, shell: true });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null, signal: r.signal };
}

const available = (opts) => { const r = run(['--version'], opts); return !r.error && r.status === 0 ? r.stdout.trim() : null; };

module.exports = { run, available, winQuote };
