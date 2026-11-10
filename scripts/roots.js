'use strict';
// ROOT FOLDERS (spec D2) - one root per scope family: the project root serves project and local scope, the global root
// serves global (user) scope. A root holds each tool's data folder `<root>/<name>`, the key file, the header helper, the
// record of the user's answers and, unless it is `.alfred`, a `.gitignore`. The roots map in the plugin's data folder
// finds a named root again when no registration points into it.
//
// Nothing here writes: the apply's file steps do. A ctx stands in for the machine - { project, home, platform, exists,
// catalog } - so the options and the root in use are tested without a disk.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const account = require('./account.js');
const E = require('./entries.js');
const helper = require('./mcp-headers.js');

const FILES = { secrets: '.mcps-secrets', helper: 'mcp-headers.js', record: 'preferred-tools.json', map: 'roots.json' };
const GITIGNORE = '*\n!.gitignore\n!mcp-headers.js\n';
const MAP_VERSION = 1;
const RECORD_VERSION = 1;

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const familyOf = (scope) => (scope === 'user' ? 'global' : 'project');
const SCOPES_OF = { project: ['project', 'local'], global: ['user'] };
const existsOf = (ctx) => ctx.exists || ((p) => fs.existsSync(p));
let loaded = null;
const catalogOf = (ctx) => ctx.catalog || (loaded = loaded || require('./catalog.js').load());

// ---- the roots map --------------------------------------------------------------------------------------------------

const emptyMap = () => ({ version: MAP_VERSION, global: null, projects: {} });

// The map in the plugin's data folder. Missing: empty. Malformed or another version: empty with a note. Never throws.
function readMap(dataDir)
{
    if (!dataDir) return emptyMap();
    const file = path.join(dataDir, FILES.map);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { return err.code === 'ENOENT' ? emptyMap() : { ...emptyMap(), note: `${file} cannot be read (${err.code}) - read as empty` }; }
    let doc;
    try { doc = JSON.parse(text); }
    catch { return { ...emptyMap(), note: `${file} is not JSON - read as empty` }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ...emptyMap(), note: `${file} is not a roots map - read as empty` };
    if (doc.version !== MAP_VERSION) return { ...emptyMap(), note: `${file} is version ${JSON.stringify(doc.version)}, not ${MAP_VERSION} - read as empty` };
    const projects = {};
    if (doc.projects && typeof doc.projects === 'object' && !Array.isArray(doc.projects))
        for (const [k, v] of Object.entries(doc.projects)) if (typeof v === 'string' && v) projects[k] = v;
    return { version: MAP_VERSION, global: typeof doc.global === 'string' && doc.global ? doc.global : null, projects };
}

// The map's key for a project: its trust root (the git root, else the folder), as the account file keys it.
const mapKey = (project) => account.projectKey(account.localRoot(project));

// A new map with the family's root set; the input is left as it was.
function withRoot(map, family, project, root)
{
    const base = map && map.version === MAP_VERSION ? map : emptyMap();
    if (family === 'global') return { version: MAP_VERSION, global: root, projects: { ...base.projects } };
    return { version: MAP_VERSION, global: base.global, projects: { ...base.projects, [mapKey(project)]: root } };
}

// ---- the root in use ------------------------------------------------------------------------------------------------

// The family's standard folders, in option order before alfred-code's set-up decides: [{ id, root }]
function standard(family, ctx)
{
    const P = pathFor(ctx.platform);
    if (family === 'global') return [{ id: 'preferred-tools', root: P.join(ctx.home, '.preferred-tools') }, { id: 'home-alfred', root: P.join(ctx.home, '.alfred') }];
    return [{ id: 'alfred', root: P.join(ctx.project, '.alfred') }, { id: 'preferred-tools', root: P.join(ctx.project, '.preferred-tools') }];
}

// A written path as an absolute one: `~`, `${HOME}` / `${USERPROFILE}`, absolute, else relative to the project.
function absOf(text, ctx)
{
    const P = pathFor(ctx.platform);
    const t = String(text).trim().replace(/^\.[\\/]/, '');
    const home = /^(?:~|\$\{(?:HOME|USERPROFILE)\})(?=[\\/]|$)/.exec(t);
    if (home) return P.join(ctx.home, t.slice(home[0].length));
    if (path.win32.isAbsolute(t) && /^([A-Za-z]:|\\\\)/.test(t)) return P.normalize(t);
    if (path.posix.isAbsolute(t)) return P.normalize(t);
    return P.join(ctx.project, t);
}

// The helper file a `headersHelper` command names, or null.
function helperPathOf(command)
{
    if (typeof command !== 'string') return null;
    const m = /"([^"]*mcp-headers\.js)"|'([^']*mcp-headers\.js)'|(\S*mcp-headers\.js)\b/.exec(command);
    return m ? m[1] || m[2] || m[3] : null;
}

const managed = (r, family) => r.rowId && !r.alfredRetired && r.choice !== 'own' && SCOPES_OF[family].includes(r.scope);

// The roots the family's managed registrations point into, helpers first, then data folders: [{ path }]. A data folder
// counts only when its parent is a standard folder or holds one of the root's files - a tool's default folder in the home
// (~/.serena) is not a root.
function registrationRoots(inv, family, ctx)
{
    const P = pathFor(ctx.platform);
    const exists = existsOf(ctx);
    const regs = (inv.registrations || []).filter((r) => managed(r, family));
    const out = [];
    for (const r of regs)
    {
        const file = helperPathOf(r.entry && r.entry.headersHelper);
        if (file) out.push(P.dirname(absOf(file, ctx)));
    }
    const known = standard(family, ctx).map((s) => s.root);
    const catalog = catalogOf(ctx);
    for (const r of regs)
    {
        const row = catalog.byId.get(r.rowId);
        if (!row || !row.locations || !r.entry) continue;
        let rootStr;
        try { rootStr = E.rootOfEntry(row, r.entry); }
        catch { rootStr = null; }
        if (!rootStr || rootStr.includes('${') && !/^\$\{(?:HOME|USERPROFILE)\}/.test(rootStr)) continue;
        const parent = P.dirname(absOf(rootStr, ctx));
        if (known.includes(parent) || Object.values(FILES).some((f) => f !== FILES.map && exists(P.join(parent, f)))) out.push(parent);
    }
    return [...new Set(out)];
}

// The root already in use for a family (D2's order): the roots map's, else the folder a managed registration's helper or
// data folder sits in, else the standard folder that holds the key file. -> { path, from } | null
function inUse(inv, family, ctx)
{
    const exists = existsOf(ctx);
    const map = (inv.roots && inv.roots.map) || emptyMap();
    const mapped = family === 'global' ? map.global : (Object.keys(map.projects || {}).length ? map.projects[mapKey(ctx.project)] : null);
    if (mapped && exists(mapped)) return { path: mapped, from: 'map' };
    const [reg] = registrationRoots(inv, family, ctx);
    if (reg) return { path: reg, from: 'registration' };
    const P = pathFor(ctx.platform);
    const held = standard(family, ctx).find((s) => exists(P.join(s.root, FILES.secrets)));
    return held ? { path: held.root, from: 'secrets' } : null;
}

// ---- the options ----------------------------------------------------------------------------------------------------

const NAMED_GLOBAL_TAIL = "a project-scope helper does not read keys here - keep a key a committed server uses in the project's root";

// The root question's options, the recommended first (D2's table): [{ id, label, description, root }]. Labels name the
// place in words; descriptions give the exact folder on this machine. 'A folder you name' has no root: it is asked next.
function options(inv, family, ctx)
{
    const exists = existsOf(ctx);
    const [alfred, preferred] = standard('project', ctx);
    const [homePt, homeAlfred] = standard('global', ctx);
    const list = family === 'global'
        ? [
            { ...homePt, label: '~/.preferred-tools', description: `${homePt.root} - one folder for every project on this machine` },
            ...(exists(homeAlfred.root) ? [{ ...homeAlfred, label: '~/.alfred', description: `${homeAlfred.root} - alfred-code's folder in your home, shared with it` }] : []),
            { id: 'named', root: null, label: 'A folder you name', description: `a folder of yours, asked next - ${NAMED_GLOBAL_TAIL}` },
        ]
        : [
            ...(E.alfredData(ctx, inv.alfredCodeEnabled) ? [{ ...alfred, label: '.alfred in this project', description: `${alfred.root} - kept out of git by alfred-code` }] : []),
            { ...preferred, label: '.preferred-tools in this project', description: `${preferred.root} - its own .gitignore keeps the keys, the record and the data out of git` },
            { id: 'named', root: null, label: 'A folder you name', description: 'a folder of yours inside this project, asked next' },
        ];
    const used = inUse(inv, family, ctx);
    if (!used) return list;
    const at = list.findIndex((o) => o.root === used.path);
    if (at >= 0) return [list[at], ...list.filter((_, i) => i !== at)];
    const where = family === 'global' ? 'the keys and data for every project' : "this project's keys and data";
    const tail = family === 'global' && !standard('global', ctx).some((s) => s.root === used.path) ? ` - ${NAMED_GLOBAL_TAIL}` : '';
    return [{ id: 'in-use', root: used.path, label: 'The folder in use', description: `${used.path} - where ${where} are now${tail}` }, ...list].slice(0, 4);
}

// A folder the user named for a root. Project: inside the project - relative, no `..`, not `.git` or `.claude`. Global:
// absolute or under `~`, `~` expanded. -> { root } | { error }
function resolveNamed(family, text, ctx)
{
    const P = pathFor(ctx.platform);
    const t = String(text == null ? '' : text).trim();
    if (!t) return { error: `the ${family} root needs a folder name` };
    if (family === 'global')
    {
        if (t === '~' || /^~[\\/]/.test(t)) return { root: P.join(ctx.home, t.slice(1)).replace(/[\\/]+$/, '') || P.sep };
        if (P.isAbsolute(t)) return { root: P.normalize(t).replace(/(.)[\\/]+$/, '$1') };
        return { error: `the global root '${t}' must be an absolute folder or one under ~` };
    }
    if (t.startsWith('~') || path.posix.isAbsolute(t) || path.win32.isAbsolute(t))
        return { error: `the project root '${t}' must lie inside the project - name a folder relative to it, not an absolute path` };
    const parts = t.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (parts.includes('..')) return { error: `the project root '${t}' must lie inside the project - no '..'` };
    if (!parts.length) return { error: `the project root '${t}' must lie inside the project, not be the project itself` };
    if (['.git', '.claude'].includes(parts[0].toLowerCase())) return { error: `the project root '${t}' cannot be under ${parts[0]} - .git and .claude are not roots` };
    return { root: P.join(ctx.project, ...parts) };
}

// A root as a registration writes it: relative to the project with `/` at project scope, absolute otherwise.
function rootStrFor(root, scope, ctx)
{
    if (scope !== 'project') return root;
    const P = pathFor(ctx.platform);
    return P.relative(ctx.project, root).split(P.sep).join('/') || '.';
}

// The roots a run uses. `answers`: { project: { id, path? }, global: { id, path? } } - an option id from the root
// question, `path` the folder typed for 'named'. No answer: the family's recommended root (D2's first option). ->
// { roots: { project, global, globalNamed }, errors: [reason] }, the roots absolute.
function resolve(inv, answers, ctx)
{
    const out = {};
    const errors = [];
    for (const family of ['project', 'global'])
    {
        const a = (answers && answers[family]) || null;
        const opts = options(inv, family, ctx);
        if (!a || !a.id) { out[family] = opts[0].root; continue; }
        if (a.id === 'named')
        {
            const r = resolveNamed(family, a.path, ctx);
            if (r.error) errors.push(`roots: ${r.error}`);
            out[family] = r.root || null;
            continue;
        }
        const o = opts.find((x) => x.id === a.id && x.root);
        if (!o) { errors.push(`roots: '${a.id}' is not a ${family} root offered here (${opts.filter((x) => x.root).map((x) => x.id).join(', ')}, or named with a path)`); out[family] = null; continue; }
        out[family] = o.root;
    }
    out.globalNamed = Boolean(out.global) && !standard('global', ctx).some((x) => x.root === out.global);
    return { roots: out, errors };
}

// ---- the record -----------------------------------------------------------------------------------------------------

// Where the commands look for the record (D6): the mapped root, the two standard folders, then every root a managed
// registration points into.
function recordFiles(inv, family, ctx)
{
    const P = pathFor(ctx.platform);
    const map = (inv.roots && inv.roots.map) || emptyMap();
    const mapped = family === 'global' ? map.global : (Object.keys(map.projects || {}).length ? map.projects[mapKey(ctx.project)] : null);
    const order = family === 'global' ? standard('global', ctx) : [...standard('project', ctx)].reverse();
    const dirs = [mapped, ...order.map((s) => s.root), ...registrationRoots(inv, family, ctx)].filter(Boolean);
    return [...new Set(dirs)].map((d) => P.join(d, FILES.record));
}

// The record file. Missing: null. Malformed or another version: empty with a note. Never throws.
function readRecord(file)
{
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? null : { version: RECORD_VERSION, servers: [], note: `${file} cannot be read (${err.code}) - read as empty` }; }
    let doc;
    try { doc = JSON.parse(text); }
    catch { return { version: RECORD_VERSION, servers: [], note: `${file} is not JSON - read as empty` }; }
    if (!doc || typeof doc !== 'object' || doc.version !== RECORD_VERSION || !Array.isArray(doc.servers))
        return { version: RECORD_VERSION, servers: [], note: `${file} is version ${JSON.stringify(doc && doc.version)} or has no servers list - read as empty` };
    return { version: RECORD_VERSION, servers: doc.servers.filter((s) => s && typeof s === 'object') };
}

// The record's key for one entry (R6): `mcp:<name>~<scope>`, `plugin-mcp:<plugin>/<server>`, `connector:<Name>`; null
// for an entry of none of those shapes.
function recordKey(e)
{
    if (!e || typeof e !== 'object') return null;
    if (typeof e.name === 'string' && typeof e.scope === 'string') return `mcp:${e.name}~${e.scope}`;
    if (typeof e.plugin === 'string' && typeof e.server === 'string') return `plugin-mcp:${e.plugin}/${e.server}`;
    if (typeof e.connector === 'string') return `connector:${e.connector}`;
    return null;
}

const sameFingerprint = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v)
{
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
}

// The record with this run's entries merged in (D6). An entry replaces the one with its key, in place; a new key is
// appended. Then an entry is dropped when its server is gone: a server's key missing from `live.servers`, or there with
// another fingerprint (null: present, not compared); a connector only when `live.connectors` is a list that lacks it -
// a run that did not pass the connectors keeps every one (R14). An entry of no known shape is dropped.
// live: { servers: { <key>: fingerprint | null }, connectors: string[] | null }
function mergeRecord(record, entries, live)
{
    const out = [];
    const at = new Map();
    for (const e of [...((record && record.servers) || []), ...(entries || [])])
    {
        const key = recordKey(e);
        if (!key) continue;
        if (at.has(key)) out[at.get(key)] = e;
        else { at.set(key, out.length); out.push(e); }
    }
    const servers = (live && live.servers) || {};
    const connectors = live && Array.isArray(live.connectors) ? live.connectors : null;
    const kept = out.filter((e) =>
    {
        if (typeof e.connector === 'string') return !connectors || connectors.includes(e.connector);
        const key = recordKey(e);
        if (!Object.hasOwn(servers, key)) return false;
        return servers[key] === null || sameFingerprint(servers[key], e.fingerprint);
    });
    return { version: RECORD_VERSION, servers: kept };
}

// ---- git and the helper on disk -------------------------------------------------------------------------------------

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Would git ignore this path? Run from its nearest folder on disk, so a file not written yet is asked about too. -> true,
// false, or null outside a git work tree or with git absent.
function gitIgnores(file)
{
    let dir = path.dirname(file);
    while (!isDir(dir))
    {
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
    const r = spawnSync('git', ['-C', dir, 'check-ignore', '-q', '--', path.relative(dir, file)], { windowsHide: true });
    if (r.error) return null;
    return r.status === 0 ? true : r.status === 1 ? false : null;
}

// R13's check for a root that exists: git would commit its key file, or - a project root other than .alfred - would
// ignore the helper a project-scope server needs committed. -> null | { reason }; null outside a work tree or with no git.
function ignoreGap(root, family)
{
    const secrets = path.join(root, FILES.secrets);
    const s = gitIgnores(secrets);
    if (s === false) return { reason: `git would commit ${secrets}` };
    if (s === null) return null;
    const file = path.join(root, FILES.helper);
    if (family === 'project' && path.basename(root) !== '.alfred' && gitIgnores(file) === true)
        return { reason: `git ignores ${file}, which a project-scope server needs committed` };
    return null;
}

const HELPER_LINE = /^\/\/ preferred-tools mcp-headers (\d+)\s*$/;
let helperText = null;
const helperSource = () => (helperText = helperText || fs.readFileSync(path.join(__dirname, FILES.helper), 'utf8'));

// The helper at `file` against this plugin's (D4): 'absent', 'lower' (rewrite it), 'same', 'edited' (the same number with
// other bytes, or no number line - a hand edit, left), 'higher' (a newer plugin wrote it - left). A CRLF copy of the same
// text is the same helper (digestOf). -> { state, number }
function helperState(file, exists = (p) => fs.existsSync(p))
{
    if (!exists(file)) return { state: 'absent', number: null };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { return { state: 'absent', number: null }; }
    const m = HELPER_LINE.exec(text.split('\n')[0]);
    if (!m) return { state: 'edited', number: null };
    const number = Number(m[1]);
    if (number < helper.HELPER_VERSION) return { state: 'lower', number };
    if (number > helper.HELPER_VERSION) return { state: 'higher', number };
    return { state: helper.digestOf(text) === helper.digestOf(helperSource()) ? 'same' : 'edited', number };
}

module.exports = {
    FILES, GITIGNORE, familyOf, readMap, mapKey, withRoot, inUse, options, resolveNamed, resolve, rootStrFor, recordFiles, readRecord,
    helperPathOf, registrationRoots, standard, recordKey, mergeRecord, gitIgnores, ignoreGap, helperState, helperSource,
};
