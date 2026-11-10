'use strict';
// The machine fixes: a problem in what is installed on this machine, not in a registration. The fix changes the machine
// (a global npm install), so it runs only when the user picked it, and is read back by running the detector again.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./common.js');
const E = require('../entries.js');

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

// ---- data-folder-ignore ---------------------------------------------------------------------------------------------
// A project-scope registration writes its data folder relative, so it lands in whichever folder Claude starts in: a
// child or a subfolder gets its own copy, which nothing there keeps out of git. This row reads every registration that
// starts here - this folder's own project-scope ones and those inherited from a parent's .mcp.json (the other rows
// leave those to fix run in the parent) - and finds each relative data folder whose contents git does not ignore. In a
// git work tree git decides (`git check-ignore` on a file inside the folder, as keys.js tests a key file); where git
// cannot answer, the folder's own .gitignore, or alfred-code's .alfred/.gitignore under .alfred/, counts as covering.
const PROBE = 'preferred-tools-probe';
function ignoredByGit(ctx, rel)
{
    const r = ctx.machine.run('git', ['check-ignore', '-q', `${rel}/${PROBE}`], { cwd: ctx.inv.project });
    return r && (r.status === 0 || r.status === 1) ? r.status === 0 : null;
}

function dataFolderIgnoreDetect(ctx)
{
    const P = ctx.platform === 'win32' ? path.win32 : path.posix;
    const tools = C.fixOf(ctx, 'data-folder-ignore').tool;
    const seen = new Set();
    const out = [];
    for (const r of ctx.inv.registrations)
    {
        if (r.own || r.alfredRetired || !tools.includes(r.rowId)) continue;
        // starts here: a project-scope one not rejected, or a parent's not rejected and not shadowed by a nearer one
        if (r.scope === 'inherited' ? r.approval === 'rejected' || r.shadowed : r.scope !== 'project' || r.approval === 'rejected') continue;
        const row = C.rowOf(ctx, r.rowId);
        const root = row.locations ? E.rootOfEntry(row, r.entry) : null;
        if (!root || root.includes('${') || root.startsWith('~') || path.posix.isAbsolute(root) || path.win32.isAbsolute(root)) continue;
        const rel = root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        const folder = P.resolve(ctx.inv.project, ...rel.split('/'));
        if (seen.has(folder)) continue;
        seen.add(folder);
        const own = P.join(folder, '.gitignore');
        const git = ignoredByGit(ctx, rel);
        if (git === true) continue;
        if (git === null && ctx.machine.exists(own)) continue;
        if (git === null && /^\.alfred\//.test(rel) && ctx.machine.exists(P.join(ctx.inv.project, '.alfred', '.gitignore'))) continue;
        // a .gitignore of the user's that leaves the data out is theirs to change: the fix never writes over it
        if (git === false && ctx.machine.exists(own))
        {
            out.push({
                id: 'data-folder-ignore', row: r.rowId, name: r.name, scope: r.scope,
                found: `${rel} - its data folder when Claude starts here - is not git-ignored`,
                blocked: `${rel}/.gitignore is there but does not ignore the folder's data - add * to it, or ignore ${rel}/ in the project's .gitignore`,
            });
            continue;
        }
        out.push({
            id: 'data-folder-ignore', row: r.rowId, name: r.name, scope: r.scope,
            found: `${rel} - its data folder when Claude starts here - is not git-ignored: ${folder} gets no .gitignore of its own${/^\.alfred\//.test(rel) ? ' and no .alfred/.gitignore covers it' : ''}`,
            proposal: { path: folder },
        });
    }
    return out;
}

// Create the folder with a .gitignore holding `*`, as the plan's ensure-dir step does; a .gitignore already there is left.
function dataFolderIgnoreFix(f, ctx)
{
    const file = path.join(f.proposal.path, '.gitignore');
    try
    {
        if (fs.existsSync(file)) return { ok: true, detail: `${file} exists - left as it is` };
        fs.mkdirSync(f.proposal.path, { recursive: true });
        fs.writeFileSync(file, '*\n');
        return { ok: true, detail: `wrote ${file} holding *` };
    }
    catch (e) { return { ok: false, detail: `could not write ${file}: ${e.message}` }; }
}

module.exports = { typescriptLspTs7Detect, typescriptLspTs7Fix, globalTypescript, MIN_NODE, dataFolderIgnoreDetect, dataFolderIgnoreFix };
