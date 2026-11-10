'use strict';
// BUILDING A REGISTRATION ENTRY - the pure part of the plan. A fresh add builds from the catalog row; a change to an
// installed row edits the entry as read (see plan.js), using the helpers here for the pieces it touches.
// Nothing here reads a machine: the OS, the arch, the home and the project come in through `ctx`.
const fs = require('node:fs');
const path = require('node:path');
const keys = require('./keys.js');

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

// The installed registration's own answers, read back from the entry.
function currentOf(row, reg)
{
    const e = reg.entry;
    const flag = (f) => { const i = (e.args || []).indexOf(f); return i >= 0 ? e.args[i + 1] : undefined; };
    return {
        name: reg.name, scope: reg.scope, route: reg.route, entry: e,
        rootStr: row.locations ? rootOfEntry(row, e) : null,
        executablePath: flag('--executable-path'),
        token: Boolean(e.headersHelper || (e.headers && e.headers.Authorization) || (e.args || []).includes('--api-key')),
        keyName: helperNameOf(e.headersHelper),
        host: e.url ? new URL(e.url).hostname : null,
    };
}

// A written root read back as a logical one: an absolute path under the project or the account home becomes that side
// again, so a move to project scope can write it relative.
function logicalRoot(text, ctx)
{
    const root = parseRoot(text, ctx);
    if (root.kind !== 'abs') return root;
    const P = pathFor(ctx.platform);
    const rel = P.relative(ctx.project, root.path);
    if (rel && !rel.startsWith('..') && !P.isAbsolute(rel)) return { kind: 'project', rel: slashes(rel) };
    const homeRel = P.relative(ctx.home, root.path);
    if (homeRel && !homeRel.startsWith('..') && !P.isAbsolute(homeRel)) return { kind: 'home', rel: slashes(homeRel) };
    return root;
}

const homeVar = (platform) => (platform === 'win32' ? '${USERPROFILE}' : '${HOME}');

// ${NAME} and ${NAME:-fallback} in an MCP entry, as Claude Code expands them (2.1.322, read from its own expander): a
// variable that is set gives its value, an empty one included; the fallback is used only when it is unset; an unset
// ${NAME} with no fallback stays as written and is named. -> { value, unset: [NAME] }
function expandVars(text, env)
{
    const unset = [];
    const value = String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name, fallback) =>
    {
        if (typeof env[name] === 'string') return env[name];
        if (fallback !== undefined) return fallback;
        unset.push(name);
        return m;
    });
    return { value, unset };
}

// The string written into the registration at a scope. `project` scope (the committed .mcp.json) gets relative paths and
// ${VAR} only; `local` and `user` get absolute paths, with `~` expanded here, never left for the server. `backslash`:
// serena's home on Windows, whose SERENA_HOME must be in backslashes even as ${USERPROFILE}\.serena.
function formatRoot(root, scope, ctx, { backslash = false } = {})
{
    const P = pathFor(ctx.platform);
    if (scope === 'project')
    {
        if (root.kind === 'abs') return { error: `the project scope is a committed file: ${root.path} is absolute. Use a path under the project, or the account folder (written as ${homeVar(ctx.platform)}/...)` };
        if (root.kind === 'home') return { value: backslash ? `${homeVar(ctx.platform)}\\${root.rel.replace(/\//g, '\\')}` : `${homeVar(ctx.platform)}/${root.rel}` };
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

// A profile path with a space leaves serena no home under it: the space-free folder offered and taken by default in its
// place, on the system drive.
function serenaSpaceFree(ctx)
{
    const drive = (ctx.env && ctx.env.SystemDrive) || '';
    return { kind: 'abs', path: `${/^[A-Za-z]:$/.test(drive) ? drive : 'C:'}\\serena-home` };
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
    const out = { root: otherPlace(row, name, loc.defaultSide, ctx) };
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

// ---- alfred-code's folder -------------------------------------------------------------------------------------------
// alfred-code's own entries under .alfred, never a data folder (3.9.2 stack/hooks/layout.js: the docs root, state and
// statistics, the workspace link file, and flow, a 2.x folder its migration still reads).
const ALFRED_ENTRIES = ['docs', 'state', 'statistics', 'workspace', 'flow'];

// alfred-code is set up in this project: enabled for it AND <project>/.alfred/.gitignore is there, the file that keeps
// its data out of git.
// A value that names this machine: an absolute path (POSIX, a drive, UNC) or ~, with no ${VAR} in it. The committed
// .mcp.json carries none (project scope gets relative paths and ${VAR} only).
function machinePath(value)
{
    if (typeof value !== 'string' || value.includes('${')) return false;
    return /^(\/|~|\\\\)/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function alfredData(ctx, enabled)
{
    if (!enabled) return false;
    const exists = ctx.exists || ((p) => fs.existsSync(p));
    return Boolean(exists(pathFor(ctx.platform).join(ctx.project, '.alfred', '.gitignore')));
}

// Why .alfred/<name> cannot hold this tool's data, or null.
function alfredNameProblem(name, ctx)
{
    // macOS and Windows file systems ignore case: '.alfred/Docs' is alfred-code's docs folder there
    if (ALFRED_ENTRIES.includes(String(name).toLowerCase())) return `'${name}' is one of alfred-code's own entries under .alfred (${ALFRED_ENTRIES.join(', ')}) - pick another name or folder`;
    const at = pathFor(ctx.platform).join(ctx.project, '.alfred', name);
    const exists = ctx.exists || ((p) => fs.existsSync(p));
    if (!exists(at)) return null;
    // a path that cannot be read is not reported as a file
    const isDir = ctx.isDir || ((p) => { try { return fs.statSync(p).isDirectory(); } catch { return true; } });
    return isDir(at) ? null : `.alfred/${name} exists and is not a folder - pick another name or folder`;
}

// The root of a scope family (spec D2): ctx.roots when the plan or the questions resolved them, else the recommended
// ones without alfred-code - <project>/.preferred-tools and <home>/.preferred-tools.
function rootOf(family, ctx)
{
    const P = pathFor(ctx.platform);
    const set = ctx.roots && ctx.roots[family];
    if (set) return set;
    return family === 'global' ? P.join(ctx.home, '.preferred-tools') : P.join(ctx.project, '.preferred-tools');
}

// The location side recommended for a row at a scope (spec D2): the data folder sits in the root of the scope's family -
// 'project' (the project root) at project and local scope, 'account' (the global root) at global scope. memory keeps one
// memory for every project: the global root's - at project scope only where the committed file can name it, under the
// home folder - and a copy beside a registration at another scope gets the project root's. serena on Windows needs an
// absolute, space-free home: a root with a space gives 'default' (the profile's .serena, else a space-free folder), and
// project scope always does (${USERPROFILE}\.serena).
function recommendedSide(row, scope, ctx, { copy = false } = {})
{
    const loc = row.locations;
    if (loc.windowsAbsolute && ctx.platform === 'win32')
    {
        if (scope === 'project') return 'default';
        const side = scope === 'user' ? 'account' : 'project';
        return validWindowsSerenaHome(rootOf(side === 'account' ? 'global' : 'project', ctx)) ? side : 'default';
    }
    if (scope === 'user') return 'account';
    if (scope === 'project' && loc.relative !== true) return 'account';
    if (loc.defaultSide === 'account')
    {
        if (copy) return 'project';
        if (scope === 'project' && logicalRoot(rootOf('global', ctx), ctx).kind === 'abs') return 'project';
        return 'account';
    }
    return 'project';
}

// A tool's folder in a root, as a logical root: 'account' - the global root's, else the project root's (spec D2).
function otherPlace(row, name, side, ctx = null)
{
    if (ctx && ctx.platform && (ctx.roots || ctx.project)) return logicalRoot(pathFor(ctx.platform).join(rootOf(side === 'account' ? 'global' : 'project', ctx), name), ctx);
    return side === 'account' ? { kind: 'home', rel: `.preferred-tools/${name}` } : { kind: 'project', rel: `.preferred-tools/${name}` };
}

// The other place from 'Locations': the account folder for a project default, the project folder for memory.
const otherSide = (row, name, ctx = null) => otherPlace(row, name, row.locations.defaultSide === 'account' ? 'project' : 'account', ctx);

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

// ---- the server's settings (spec D9) ---------------------------------------------------------------------------------

// appium's SDK homes: resolved on this machine (appium-sdk-env), never a setting
const APPIUM_SDK_ENV = ['ANDROID_HOME', 'JAVA_HOME'];

// The settings a stdio route's env holds, as [[NAME, value]]: the registration's env when there is one, else the
// catalog's; the values install resolves (a data folder, an SDK home, the npm cut-off) and the key are not settings.
function settingsOf(row, routeId, entry = null)
{
    const route = row.routes[routeId];
    const derived = new Set(((row.locations && row.locations.derived) || []).filter((d) => d.in === 'env').map((d) => d.key));
    const env = (entry ? entry.env : route.env) || {};
    return Object.entries(env).filter(([k]) => k !== route.tokenVar && !derived.has(k) && !APPIUM_SDK_ENV.includes(k) && k !== 'npm_config_before' && !keys.credentialName(k));
}

// `pairs` merged into the entry's env; a Docker route also passes each new name into the container (`-e NAME` before
// the image).
function mergeSettings(entry, route, pairs)
{
    const out = JSON.parse(JSON.stringify(entry));
    out.env = { ...(out.env || {}), ...pairs };
    if (out.command === 'docker' && Array.isArray(out.args) && route.image)
    {
        const at = out.args.findIndex((a) => typeof a === 'string' && a.startsWith(`${route.image.name}:`));
        const passed = new Set(out.args.filter((a, i) => out.args[i - 1] === '-e'));
        const add = Object.keys(pairs).filter((k) => !passed.has(k)).flatMap((k) => ['-e', k]);
        if (at >= 0 && add.length) out.args.splice(at, 0, ...add);
    }
    return out;
}

// ---- the header helper (spec D4) ------------------------------------------------------------------------------------

// One path in a `headersHelper` command, written so the shell that runs it passes it to node whole (Review Focus 1).
// `style`: 'posix' - single quotes, a quote inside as '\\'' ; 'win32' - forward slashes, which node takes and cmd,
// PowerShell and Git Bash all pass as they are, in double quotes when needed; 'portable' - the committed file's relative
// path, read by any OS's shell, in double quotes when needed. Letters, digits and _ . / : @ + , = - need no quotes.
const PLAIN_ARG = /^[A-Za-z0-9_./:@+,=-]+$/;
function shellArg(text, style)
{
    const t = style === 'win32' ? text.replace(/\\/g, '/') : text;
    if (PLAIN_ARG.test(t)) return t;
    return style === 'posix' ? `'${t.replace(/'/g, "'\\''")}'` : `"${t}"`;
}

// The registration's `headersHelper`: `node <path> <NAME> <SCHEME> [<global root>]`, each path quoted for `style` (see
// shellArg). The command line names the helper and a variable name, never the key file or a value.
function helperCommand({ helperPath, name, scheme, globalRoot = null, style = 'portable' })
{
    return ['node', shellArg(helperPath, style), name, scheme, ...(globalRoot ? [shellArg(globalRoot, style)] : [])].join(' ');
}

// A `headersHelper` command split as its shell reads it: quoted text kept as it is, '\\'' joined into one argument, and a
// backslash outside quotes kept unless a quote follows it (a Windows path written by hand). -> [string]
function helperArgv(command)
{
    const out = [];
    let cur = null;
    const text = String(command);
    for (let i = 0; i < text.length; i++)
    {
        const c = text[i];
        if (c === "'" || c === '"')
        {
            const end = text.indexOf(c, i + 1);
            const stop = end < 0 ? text.length : end;
            cur = (cur || '') + text.slice(i + 1, stop);
            i = stop;
        }
        else if (c === '\\' && (text[i + 1] === "'" || text[i + 1] === '"')) { cur = (cur || '') + text[i + 1]; i++; }
        else if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; }
        else cur = (cur || '') + c;
    }
    if (cur !== null) out.push(cur);
    return out;
}

// The helper file a `headersHelper` command names, and the arguments after it -> { path, args } | null
function helperParts(command)
{
    if (typeof command !== 'string') return null;
    const argv = helperArgv(command);
    const at = argv.findIndex((a) => /mcp-headers\.js$/.test(a));
    return at < 0 ? null : { path: argv[at], args: argv.slice(at + 1) };
}

// Where a registration at `scope` finds the helper: relative to the project at project scope (it runs in the folder whose
// .mcp.json declares it), else absolute - in the root of the scope's family.
function helperPathFor(scope, ctx)
{
    const P = pathFor(ctx.platform);
    const root = rootOf(scope === 'user' ? 'global' : 'project', ctx);
    if (scope !== 'project') return P.join(root, 'mcp-headers.js');
    const rel = P.relative(ctx.project, root).split(P.sep).join('/');
    return `${rel ? `${rel}/` : ''}mcp-headers.js`;
}

// The helper's third argument: the global root, at local scope only and only when it is a named folder - the helper reads
// ~/.preferred-tools and ~/.alfred itself.
const helperGlobalRoot = (scope, ctx) => (scope === 'local' && ctx.roots && ctx.roots.globalNamed ? ctx.roots.global : null);

// The key name a `headersHelper` passes, or null: the helper's arguments as this plugin writes them, `<NAME> <SCHEME>`.
function helperNameOf(command)
{
    const h = helperParts(command);
    return h && h.args.length >= 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(h.args[0]) && /^[A-Za-z][\w-]*$/.test(h.args[1]) ? h.args[0] : null;
}

// The helper command a hosted keyed route gets at `scope`: the key's name (`keyName`, else the catalog's default) and
// the route's scheme.
const helperFor = (route, scope, ctx, keyName = null) => helperCommand({ helperPath: helperPathFor(scope, ctx), name: keyName || route.helper.var, scheme: route.helper.scheme, globalRoot: helperGlobalRoot(scope, ctx), style: scope === 'project' ? 'portable' : ctx.platform === 'win32' ? 'win32' : 'posix' });

// A fresh entry from the catalog. `a` = { rootStr, scope, executablePath, token, keyName, params }. A hosted route that
// sends a key gets `headersHelper` and no `headers`: the key stays in .mcps-secrets (spec D4).
function buildEntry(row, routeId, a, ctx, rules)
{
    const route = row.routes[routeId];
    if (routeId === 'remote')
    {
        const entry = { type: route.type, url: subst(route.url, a.params || {}) };
        const useKey = route.helper && (route.auth === 'token' || (route.auth === 'optional-token' && a.token));
        if (useKey) entry.headersHelper = helperFor(route, a.scope, ctx, a.keyName);
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
    pathFor, slashes, isWindowsArm, pythonRequest, parseRoot, logicalRoot, currentOf, formatRoot, withSub, homeVar, serenaWindowsHome, serenaSpaceFree, validWindowsSerenaHome,
    defaultRoot, alfredRoot, otherSide, otherPlace, rootOfEntry, applyRoot, buildEntry, nameProblem, subst, fetchStep,
    ALFRED_ENTRIES, alfredData, alfredNameProblem, recommendedSide, rootOf, machinePath, expandVars,
    helperCommand, helperPathFor, helperGlobalRoot, helperNameOf, helperFor, helperArgv, helperParts, shellArg, APPIUM_SDK_ENV, settingsOf, mergeSettings,
};
