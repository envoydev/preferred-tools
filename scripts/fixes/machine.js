'use strict';
// The machine fixes: a problem on this machine, not in a registration. The fix changes the machine (a global npm install,
// a data folder's .gitignore, a broken npx cache folder removed), so it runs only when the user picked it, and is read
// back by running the detector again. A fix that changes nothing a running session uses returns `restart: false`; one
// that leaves a package to download again returns its `fetch` step, which fix.js hands to fetch.js.
const crypto = require('node:crypto');
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
        if (fs.existsSync(file)) return { ok: true, restart: false, detail: `${file} exists - left as it is` };
        fs.mkdirSync(f.proposal.path, { recursive: true });
        fs.writeFileSync(file, '*\n');
        return { ok: true, restart: false, detail: `wrote ${file} holding *` };
    }
    catch (e) { return { ok: false, detail: `could not write ${file}: ${e.message}` }; }
}

// ---- npx-cache-entry ------------------------------------------------------------------------------------------------
// npx installs a package into <npm cache>/_npx/<hash>, named by libnpmexec as sha512 of the package specs (sorted, one per
// line), hex, the first 16 characters (read in npm 11.6.1's lib/index.js). Two first installs of one package at once - a
// session started while fetch.js runs - can leave that folder without its package.json, and from then on every start
// fails with ENOENT: npx never repairs it (measured, docs/sources.md). The fix removes that one folder and hands the
// package to fetch.js, which fills it again the way the registration resolves it.
const NPX_FOLDER = /^[0-9a-f]{16}$/;

// The cache in force, from `npm config ls -l`: npm 10 and 11 refuse `npm config get cache` ('The cache option is
// protected'), and the long list prints each source's value as a JSON string, all but the one in force commented out
// (measured, docs/sources.md). npm prints a UUID-shaped part of a path as ***, so a redacted value is no folder.
// -> the folder, or null when npm cannot say
function cacheInForce(r)
{
    if (!r || r.status !== 0) return null;
    const line = String(r.stdout || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('cache = '));
    let value = null;
    try { value = line ? JSON.parse(line.slice('cache = '.length)) : null; } catch { /* not a JSON string: npm cannot say */ }
    return typeof value === 'string' && value && !value.includes('***') ? value : null;
}

// npm_config_cache in an environment, as npm reads it: the name in any case, an empty value skipped
const cacheVar = (env) => Object.entries(env || {}).find(([k, v]) => k.toLowerCase() === 'npm_config_cache' && v !== '');

// The npm cache a registration's npx uses: its own npm_config_cache, else the environment's (npm's first source, ahead
// of any .npmrc), else npm's, asked once per run.
function npmCacheOf(ctx, reg, memo)
{
    const own = cacheVar(reg.entry.env);
    if (own) return C.expandVars(own[1], ctx.env);
    const inEnv = cacheVar(ctx.env);
    if (inEnv) return inEnv[1];
    if (!memo.has('cache')) memo.set('cache', cacheInForce(ctx.machine.run('npm', ['config', 'ls', '-l'], { cwd: ctx.inv.project })));
    return memo.get('cache');
}

// Every server that starts in this folder, a parent folder's included: the npx cache is the machine's, so fix run in a
// child folder repairs the parent's server too. One rejected here, or a parent's that a nearer server of its name
// shadows, does not start here.
const startsHere = (ctx, r) => !r.own && !r.alfredRetired && r.approval !== 'rejected' && !(r.scope === 'inherited' && r.shadowed)
    && C.fixOf(ctx, 'npx-cache-entry').tool.includes(r.rowId);

function npxCacheEntryDetect(ctx)
{
    const P = ctx.platform === 'win32' ? path.win32 : path.posix;
    const memo = new Map();
    const seen = new Set();
    const out = [];
    for (const reg of ctx.inv.registrations)
    {
        if (!startsHere(ctx, reg) || C.launcher(reg.entry) !== 'npx') continue;
        const step = E.fetchStep(reg.name, reg.entry, reg.rowId);
        if (!step) continue;
        const cache = npmCacheOf(ctx, reg, memo);
        if (!cache) continue;
        const folder = P.join(cache, '_npx', crypto.createHash('sha512').update(step.what).digest('hex').slice(0, 16));
        if (seen.has(folder) || !ctx.machine.exists(folder) || ctx.machine.exists(P.join(folder, 'package.json'))) continue;
        seen.add(folder);
        // the finding carries no env: a key can sit in it, and --detect --json prints findings
        out.push(C.finding('npx-cache-entry', reg, `npx's cache folder for ${step.what}, ${folder}, has no package.json - every start fails with ENOENT until it is removed`, { proposal: { path: folder, what: step.what } }));
    }
    return out;
}

// Remove that folder, never another: it must be a 16-hex folder directly under an _npx folder. -> { ok, detail, fetch }
function npxCacheEntryFix(f, ctx)
{
    const P = ctx.platform === 'win32' ? path.win32 : path.posix;
    const folder = f.proposal.path;
    if (!NPX_FOLDER.test(P.basename(folder)) || P.basename(P.dirname(folder)) !== '_npx') return { ok: false, detail: `${folder} is not an npx cache folder - left as it is` };
    try { fs.rmSync(folder, { recursive: true, force: true }); }
    catch (e) { return { ok: false, detail: `could not remove ${folder}: ${e.message}` }; }
    const reg = ctx.inv.registrations.find((r) => r.name === f.name && r.scope === f.scope && !r.shadowed);
    const step = reg ? E.fetchStep(reg.name, reg.entry, reg.rowId) : null;
    // a parent's server is read from the parent's .mcp.json and started here, as this folder's session starts it
    const where = reg && reg.scope === 'inherited' ? { scope: 'project', from: reg.from } : { scope: reg && reg.scope };
    return { ok: true, detail: `removed ${folder} - npx installs ${f.proposal.what} into it again`, fetch: step ? { ...step, ...where } : null };
}

module.exports = { typescriptLspTs7Detect, typescriptLspTs7Fix, globalTypescript, MIN_NODE, dataFolderIgnoreDetect, dataFolderIgnoreFix, npxCacheEntryDetect, npxCacheEntryFix };
