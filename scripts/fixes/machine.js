'use strict';
// The machine fixes: a problem in what is installed on this machine, not in a registration. The fix changes the machine
// (a global npm install), so it runs only when the user picked it, and is read back by running the detector again.
const C = require('./common.js');

const MIN_NODE = '22.22.2'; // typescript-language-server 6.x (docs/sources.md 'LSP plugins')

// The global `typescript` version, or null when npm or the package is absent. A project's own node_modules/typescript is
// not looked at: the language server the plugin starts is the global one.
function globalTypescript(machine)
{
    const r = machine.run('npm', ['ls', '-g', 'typescript', '--json', '--depth=0']);
    if (!r || !r.stdout) return null;
    try { return JSON.parse(r.stdout).dependencies?.typescript?.version || null; }
    catch { return null; }
}

function typescriptLspTs7Detect(ctx)
{
    const lsp = ctx.inv.plugins.filter((p) => p.rowId === 'typescript-lsp' && !p.alfredRetired && p.enabled !== false);
    if (!lsp.length) return [];
    const version = globalTypescript(ctx.machine);
    if (!version || parseInt(version, 10) < 7) return [];
    const p = lsp[0];
    return [{
        id: 'typescript-lsp-ts7', row: 'typescript-lsp', name: p.id, scope: p.scope,
        found: `the global typescript is ${version}; TypeScript 7 ships no tsserver.js, so the language server returns no diagnostics`,
        proposal: { command: 'npm install -g typescript-language-server typescript@6' },
        ...(C.compareVersions(ctx.machine.nodeVersion, MIN_NODE) === -1 ? { blocked: `typescript-language-server needs Node ${MIN_NODE} or newer; this is ${ctx.machine.nodeVersion}` } : {}),
    }];
}

function typescriptLspTs7Fix(f, ctx)
{
    const r = ctx.machine.run('npm', ['install', '-g', 'typescript-language-server', 'typescript@6']);
    if (!r || r.status !== 0) return { ok: false, detail: `npm install -g typescript-language-server typescript@6 failed: ${String((r && (r.stderr || r.stdout)) || 'no output').trim().split('\n').slice(-2).join(' | ')}` };
    const v = globalTypescript(ctx.machine);
    return v && parseInt(v, 10) < 7 ? { ok: true, detail: `global typescript is now ${v}` } : { ok: false, detail: `the global typescript still reads ${v || 'absent'} after the install` };
}

module.exports = { typescriptLspTs7Detect, typescriptLspTs7Fix, globalTypescript, MIN_NODE };
