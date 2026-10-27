'use strict';
// BUILDING A REGISTRATION ENTRY - the pure part of the plan. A fresh add builds from the catalog row; a change to an
// installed row edits the entry as read (see plan.js), using the helpers here for the pieces it touches.
// Nothing here reads a machine: the OS, the arch, the home and the project come in through `ctx`.
const fs = require('node:fs');
const path = require('node:path');

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const slashes = (p) => p.replace(/\\/g, '/');

// An x64 node emulated on ARM reports arch x64 and PROCESSOR_ARCHITECTURE AMD64, so the machine-wide
// PROCESSOR_IDENTIFIER ('ARMv8 (64-bit) Family 8 ...') is what still tells the truth there (alfred-code uv-python.js).
function isWindowsArm({ platform, arch, env = {} })
{
    if (platform !== 'win32') return false;
    if (arch === 'arm64') return true;
    if (/^arm64$/i.test(env.PROCESSOR_ARCHITECTURE || '') || /^arm64$/i.test(env.PROCESSOR_ARCHITEW6432 || '')) return true;
    return /^arm/i.test(env.PROCESSOR_IDENTIFIER || '');
}

// The `--python` request: the row's minor, or on Windows ARM64 the x64 build of that minor (every wheel exists there).
function pythonRequest(route, ctx, rules)
{
    if (!isWindowsArm(ctx)) return route.python;
    return rules.windowsArmPython.replace('{minor}', route.python);
}

// ---- location roots -------------------------------------------------------------------------------------------------
// A root is logical until it is written: { kind: 'project', rel } (under the project), { kind: 'home', rel } (under the
// account home) or { kind: 'abs', path }.

function parseRoot(text, ctx)
{
    const t = String(text).trim();
    if (t === '~' || /^~[\\/]/.test(t)) return { kind: 'home', rel: slashes(t.slice(2)) };
    if (/^\$\{(HOME|USERPROFILE)\}[\\/]/.test(t)) return { kind: 'home', rel: slashes(t.replace(/^\$\{[A-Z]+\}[\\/]/, '')) };
    if (path.win32.isAbsolute(t) || path.posix.isAbsolute(t)) return { kind: 'abs', path: t };
    return { kind: 'project', rel: slashes(t.replace(/^\.[\\/]/, '')) };
}

const homeVar = (platform) => (platform === 'win32' ? '${USERPROFILE}' : '${HOME}');

// The string written into the registration at a scope. `project` scope (the committed .mcp.json) gets relative paths and
// ${VAR} only; `local` and `user` get absolute paths, with `~` expanded here, never left for the server.
function formatRoot(root, scope, ctx)
{
    const P = pathFor(ctx.platform);
    if (scope === 'project')
    {
        if (root.kind === 'abs') return { error: `the project scope is a committed file: ${root.path} is absolute. Use a path under the project, or the account folder (written as ${homeVar(ctx.platform)}/...)` };
        if (root.kind === 'home') return { value: `${homeVar(ctx.platform)}/${root.rel}` };
        return { value: root.rel };
    }
    if (root.kind === 'abs') return { value: P.normalize(root.path) };
    if (root.kind === 'home') return { value: P.join(ctx.home, ...root.rel.split('/')) };
    return { value: P.resolve(ctx.project, ...root.rel.split('/')) };
}

// root + sub, in the written form
function withSub(rootStr, sub, scope, ctx)
{
    if (!sub) return rootStr;
    if (scope === 'project') return `${rootStr}/${sub}`;
    return pathFor(ctx.platform).join(rootStr, sub);
}

// serena on Windows: SERENA_HOME absolute, in backslashes and space-free (fix row serena-windows-home).
function serenaWindowsHome(ctx)
{
    const profile = ctx.home || '';
    if (profile && !/\s/.test(profile)) return { root: { kind: 'abs', path: path.win32.join(profile, '.serena') } };
    return { needsInput: `the profile path ${profile || '(unknown)'} has a space, and serena's home must be space-free on Windows: type an absolute folder without spaces (for example C:\\serena-home)` };
}

function validWindowsSerenaHome(rootStr)
{
    return path.win32.isAbsolute(rootStr) && !/\s/.test(rootStr) && !rootStr.includes('/') && /^[A-Za-z]:\\/.test(rootStr);
}

// The default root for a row (before the user's answer), as a logical root: the project folder (memory: the account
// folder), never alfred-code's - the plugin stands alone. alfred-code data already on disk comes back as `alfred`, an
// answer of its own. serena on Windows overrides both.
function defaultRoot(row, name, ctx)
{
    const loc = row.locations;
    if (loc.windowsAbsolute && ctx.platform === 'win32') return serenaWindowsHome(ctx);
    const out = { root: otherPlace(row, name, loc.defaultSide) };
    const old = alfredRoot(row, ctx);
    if (old) out.alfred = old;
    return out;
}

// The row's alfred-code data folder when it is on disk (its old root from original-mcps.json), else null.
function alfredRoot(row, ctx)
{
    if (!row.locations || !row.locations.alfred) return null;
    const exists = ctx.exists || ((p) => fs.existsSync(p));
    const old = parseRoot(row.locations.alfred, ctx);
    const abs = old.kind === 'home' ? pathFor(ctx.platform).join(ctx.home, ...old.rel.split('/')) : pathFor(ctx.platform).resolve(ctx.project, ...old.rel.split('/'));
    return exists(abs) ? old : null;
}

function otherPlace(row, name, side)
{
    return side === 'account' ? { kind: 'home', rel: `.preferred-tools/${name}` } : { kind: 'project', rel: `.preferred-tools/${name}` };
}

// The other place from 'Locations': the account folder for a project default, the project folder for memory.
const otherSide = (row, name) => otherPlace(row, name, row.locations.defaultSide === 'account' ? 'project' : 'account');

// The root an installed entry carries, in written form, from the row's first derived key.
function rootOfEntry(row, entry)
{
    const d = row.locations.derived[0];
    let value;
    if (d.in === 'env') value = (entry.env || {})[d.key];
    else
    {
        const args = entry.args || [];
        const i = args.indexOf(d.key);
        value = i >= 0 ? args[i + 1] : undefined;
    }
    if (typeof value !== 'string') return null;
    if (!d.sub) return value;
    const cut = value.replace(/[\\/]+$/, '');
    const tail = cut.slice(-d.sub.length);
    return tail === d.sub ? cut.slice(0, -d.sub.length).replace(/[\\/]+$/, '') : value;
}

// Write the location root into an entry (fresh build or an edit of an installed one): every derived key.
function applyRoot(entry, row, rootStr, scope, ctx)
{
    const out = { ...entry, env: { ...(entry.env || {}) } };
    if (entry.args) out.args = [...entry.args];
    for (const d of row.locations.derived)
    {
        const value = withSub(rootStr, d.sub, scope, ctx);
        if (d.in === 'env') out.env[d.key] = value;
        else
        {
            const i = out.args.indexOf(d.key);
            if (i >= 0) out.args[i + 1] = value; else out.args.push(d.key, value);
        }
    }
    if (!Object.keys(out.env).length) delete out.env;
    return out;
}

// ---- the entry ------------------------------------------------------------------------------------------------------

function subst(text, values)
{
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
}

// A fresh entry from the catalog. `a` = { rootStr, executablePath, token, params }.
function buildEntry(row, routeId, a, ctx, rules)
{
    const route = row.routes[routeId];
    if (routeId === 'remote')
    {
        const entry = { type: route.type, url: subst(route.url, a.params || {}) };
        const useToken = route.auth === 'token' || (route.auth === 'optional-token' && a.token);
        if (useToken && route.headers) entry.headers = { ...route.headers };
        return entry;
    }

    let entry;
    const extra = [];
    for (const [key, spec] of Object.entries(route.optionalArgs || {}))
    {
        if (key === 'executablePath' && a.executablePath) extra.push(...spec.map((s) => subst(s, { value: a.executablePath })));
        if (key === 'token' && a.token) extra.push(...spec);
    }
    if (route.runtime === 'uvx')
    {
        const p = route.package;
        const args = ['--python', pythonRequest(route, ctx, rules), '--exclude-newer', p.cutoff];
        for (const w of route.with || []) args.push('--with', w);
        args.push('--from', subst(p.fromSpec, { version: p.version }), ...route.run, ...extra);
        entry = { command: 'uvx', args };
        if (Object.keys(route.env || {}).length) entry.env = { ...route.env };
    }
    else if (route.runtime === 'npx')
    {
        const p = route.package;
        const args = ['-y', `${p.name}@${p.version}`, ...route.run, ...extra];
        entry = ctx.platform === 'win32' && rules.windowsNpxCmd ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
        entry.env = { ...(route.env || {}), npm_config_before: p.cutoff };
    }
    else if (route.runtime === 'docker')
    {
        const useBinary = ctx.machine && ctx.machine.docker === false && route.fallback;
        if (useBinary) entry = { command: route.fallback.command, args: [...route.fallback.args] };
        else
        {
            const passEnv = Object.keys(route.env || {}).flatMap((k) => ['-e', k]);
            entry = { command: 'docker', args: ['run', '-i', '--rm', ...passEnv, `${route.image.name}:${route.image.tag}`, ...route.run] };
        }
        if (Object.keys(route.env || {}).length) entry.env = { ...route.env };
    }
    if (row.locations && a.rootStr !== undefined) entry = applyRoot(entry, row, a.rootStr, a.scope, ctx);
    return entry;
}

// ---- names ----------------------------------------------------------------------------------------------------------

// null when the name is usable, else the reason. `taken` = the registrations at the target scope, as inventory reads them.
function nameProblem(name, { catalog, taken = [], self = null })
{
    if (!new RegExp(catalog.rules.nameRe).test(name)) return `'${name}' must match ${catalog.rules.nameRe}`;
    if (catalog.reserved.has(name)) return `'${name}' is a name alfred-code once registered and may retire`;
    const other = taken.find((r) => r.name === name && !(self && r.name === self.name && r.scope === self.scope));
    if (other) return `'${name}' already belongs to another registration at ${other.scope} scope`;
    return null;
}

// The first start of a package route downloads the package, and Claude Code gives a server 30 s to answer: measured on
// 2.1.311, `claude mcp get` reports appium-mcp's first npx install and memory's first uvx one as 'connection timed out
// after 30000ms', and the first session start meets the same limit. So a written registration is followed by a fetch of
// exactly what it launches - same pin, same cut-off, from its env - into the runtime's cache. -> a plan step, or null for a
// launch with nothing to fetch (a hosted URL, a binary) or, given the entry it replaces, one that fetches the same thing.
const UVX_VALUE = new Set(['--python', '-p', '--exclude-newer', '--from', '--with', '--with-requirements', '--with-editable', '--index', '--index-url', '--extra-index-url']);
function fetchStep(name, entry, rowId, old)
{
    const step = fetchOf(name, entry, rowId);
    const was = old ? fetchOf(name, old, rowId) : null;
    if (step && was && JSON.stringify([step.argv, step.env]) === JSON.stringify([was.argv, was.env])) return null;
    return step;
}

function fetchOf(name, entry, rowId)
{
    if (!entry || !entry.command) return null;
    let cmd = entry.command;
    let args = (entry.args || []).slice();
    const viaCmd = /^cmd(\.exe)?$/i.test(cmd) && /^\/c$/i.test(args[0] || '');
    if (viaCmd) { cmd = args[1]; args = args.slice(2); }
    let argv;
    let what;
    if (/^npx(\.cmd)?$/i.test(cmd || ''))
    {
        what = args.find((a) => !a.startsWith('-'));
        if (!what) return null;
        // `-e 0`, not `-e ''`: on Windows the fetch goes through cmd.exe, where an empty argument is dropped
        argv = ['npm', 'exec', '--yes', '--package', what, '--', 'node', '-e', '0'];
    }
    else if (/^uvx(\.exe)?$/i.test(cmd || ''))
    {
        // the options up to the tool's own command, then its --help: uv builds the environment and runs nothing else
        const out = [];
        for (let i = 0; i < args.length; i++)
        {
            if (args[i].startsWith('-')) { out.push(args[i]); if (UVX_VALUE.has(args[i])) out.push(args[++i]); continue; }
            out.push(args[i], '--help');
            break;
        }
        what = out[out.indexOf('--from') + 1] || out[out.length - 2];
        argv = ['uvx', ...out];
    }
    else if (/^docker(\.exe)?$/i.test(cmd || ''))
    {
        what = args.find((a) => /^[a-z0-9.-]+(\/[a-z0-9._-]+)+:[\w.-]+$/.test(a));
        if (!what) return null;
        argv = ['docker', 'pull', what];
    }
    else return null;
    if (viaCmd) argv = [entry.command, '/c', ...argv];
    return { op: 'fetch', name, row: rowId, what, argv, env: entry.env || {}, why: `${rowId || name}: fetch ${what} so the first start answers in time` };
}

module.exports = {
    pathFor, slashes, isWindowsArm, pythonRequest, parseRoot, formatRoot, withSub, homeVar, serenaWindowsHome, validWindowsSerenaHome,
    defaultRoot, alfredRoot, otherSide, otherPlace, rootOfEntry, applyRoot, buildEntry, nameProblem, subst, fetchStep,
};
