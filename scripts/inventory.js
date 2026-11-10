#!/usr/bin/env node
'use strict';
// THE INVENTORY - what is installed, read-only, no server started.
//
//   node inventory.js --project <dir> --json <out> [--data <plugin data dir>]   (--data: the roots map, spec D2)
//
// Reads the project's .mcp.json, the account file (user servers, and this project's local servers), the .mcp.json of
// every folder above (inherited: listed, never changed from here) and `claude plugin list --json`, and matches each
// registration to a catalog row by what it LAUNCHES - the package in its
// args, or the URL host and path - never by its name. So a tool under a custom name is still recognised, and a
// registration that matches no row is the user's: it is listed as `own` and nothing in this plugin touches it.
const fs = require('node:fs');
const path = require('node:path');
const catalogLib = require('./catalog.js');
const account = require('./account.js');
const cli = require('./claude-cli.js');
const kept = require('./kept.js');
const roots = require('./roots.js');
const { readState } = account;
const { blockingStdio } = require('./json-file.js');

// ---- matching a registration to a row -------------------------------------------------------------------------------

// `cmd /c npx ...` and `cmd.exe /d /s /c npx ...` are the Windows spelling of `npx ...`: look through the wrapper.
function launchTokens(entry)
{
    const command = String(entry.command || '');
    let args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    if (/^cmd(\.exe)?$/i.test(path.basename(command)))
    {
        const at = args.findIndex((a) => /^\/c$/i.test(a));
        if (at >= 0) return { command: args[at + 1] || '', args: args.slice(at + 2) };
    }
    return { command, args };
}

// 'serena-agent@2.1.0', 'mcp-memory-service[sqlite]==12.1.1', '@playwright/mcp@0.0.83', 'ghcr.io/x/y:v2' -> the bare name.
function bareName(token)
{
    const lead = token.startsWith('@') ? '@' : '';
    const body = lead ? token.slice(1) : token;
    const cut = body.search(/[@=\[<>~!:]/);
    return lead + (cut >= 0 ? body.slice(0, cut) : body);
}

const flagValue = (args, flag) =>
{
    for (let i = 0; i < args.length; i++)
    {
        if (args[i] === flag) return args[i + 1];
        if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return undefined;
};

function matchesFingerprint(entry, f)
{
    if (entry.url || entry.type === 'http' || entry.type === 'sse')
    {
        if (f.pkg || f.command) return false;
        let u;
        try { u = new URL(String(entry.url)); } catch { return false; }
        if (f.host && u.hostname.toLowerCase() !== f.host) return false;
        return u.pathname.startsWith(f.pathPrefix || '/');
    }
    const { command, args } = launchTokens(entry);
    if (f.command) return path.basename(command).replace(/\.(exe|cmd)$/i, '') === f.command;
    if (!f.pkg) return false;
    // the first argument that names the package; a flag value like --from <spec> is such an argument
    const named = args.filter((a) => !a.startsWith('-')).some((a) => bareName(a) === f.pkg);
    if (!named) return false;
    return f.flag ? flagValue(args, f.flag) === f.value : true;
}

// The catalog row and route a registration's launch belongs to, or null (the user's own).
function matchEntry(entry, catalog)
{
    if (!entry || typeof entry !== 'object') return null;
    for (const row of catalog.tools)
    {
        if (row.kind !== 'mcp') continue;
        for (const [route, def] of Object.entries(row.routes))
            if (def.fingerprints.some((f) => matchesFingerprint(entry, f))) return { rowId: row.id, route };
    }
    return null;
}

// ---- reading the scopes ---------------------------------------------------------------------------------------------

const settingsOf = (scope, project, env) => path.join(
    scope === 'user' ? account.configDir(env) : path.join(project, '.claude'),
    scope === 'local' ? 'settings.local.json' : 'settings.json');

// ---- inherited: the .mcp.json files of the folders above ------------------------------------------------------------
// Claude Code reads the .mcp.json of the folder it starts in and of every folder above it up to the filesystem root,
// from the real path: the nearest file wins a name, a local registration beats them all, and a malformed file loses
// only its own servers (MEASURED, docs/sources.md '.mcp.json in parent folders', M1-M6).

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// -> [{ dir, file }], nearest first, the project's own file left out
function ancestorMcpFiles(project)
{
    const out = [];
    for (let dir = realOf(project), up = path.dirname(dir); up !== dir; dir = up, up = path.dirname(dir))
    {
        const file = path.join(up, '.mcp.json');
        if (fs.existsSync(file)) out.push({ dir: up, file });
    }
    return out;
}

// The settings files a session started in `proj` reads, nearest first: the trust root's settings.local.json (the git
// root, else the folder), this folder's settings.local.json, then its settings.json - a parent folder's settings.json
// never counts (MEASURED: M7 for approvals, P4 and P5 for enabledPlugins). -> [file]
function hereSettings(proj)
{
    const root = account.localRoot(proj);
    return [...new Set([path.join(root, '.claude', 'settings.local.json'), path.join(proj, '.claude', 'settings.local.json'), path.join(proj, '.claude', 'settings.json')])];
}

// What decides a parent's server here: the user settings, this folder's settings files, and its account entry and
// trust, all keyed on the trust root (the git root, else the folder).
function approvalContext(proj, env, acct, platform)
{
    const root = account.localRoot(proj);
    const entry = account.projectEntry(acct.projects || {}, root, platform) || {};
    return { user: readState(settingsOf('user', proj, env)).doc, folder: hereSettings(proj).map((f) => readState(f).doc), entry, trusted: entry.hasTrustDialogAccepted === true };
}

const names = (doc, key, name) => Boolean(doc) && Array.isArray(doc[key]) && doc[key].includes(name);
const approves = (doc, name) => Boolean(doc) && (doc.enableAllProjectMcpServers === true || names(doc, 'enabledMcpjsonServers', name));

// approved | pending | rejected, as `claude mcp list` says it here (MEASURED, M7; the MCP docs' 'Project server approvals
// and workspace trust'): a disabledMcpjsonServers entry anywhere rejects; the user settings approve in any folder; this
// folder's settings and account entry approve only once it is trusted; a parent folder's settings never count.
function approvalOf(name, a)
{
    if ([a.user, ...a.folder, a.entry].some((d) => names(d, 'disabledMcpjsonServers', name))) return 'rejected';
    if (approves(a.user, name) || (a.trusted && [...a.folder, a.entry].some((d) => approves(d, name)))) return 'approved';
    return 'pending';
}

function pluginRows(listJson, project, env, catalog, alfredCheck)
{
    const rows = [];
    const here = [...hereSettings(project), settingsOf('user', project, env)].map((f) => readState(f).doc);
    const flagIn = (doc, id) => (doc && doc.enabledPlugins ? doc.enabledPlugins[id] : undefined);
    for (const r of Array.isArray(listJson) ? listJson : [])
    {
        const [name, marketplace = ''] = String(r.id).split('@');
        const scoped = r.scope === 'project' || r.scope === 'local';
        if (scoped && r.projectPath && account.projectKey(r.projectPath) !== account.projectKey(project)) continue; // another project's
        let enabled = r.enabled;
        let enabledFrom = 'list';
        if (['user', 'project', 'local'].includes(r.scope))
        {
            const flag = flagIn(readState(settingsOf(r.scope, project, env)).doc, r.id);
            if (typeof flag === 'boolean') { enabled = flag; enabledFrom = 'settings'; }
        }
        // Two readings, kept apart: `enabled` is the install scope's own, which configure and update act on (an `enable`
        // over an enabled scope exits 1, S28); `enabledHere` is whether it loads in this project - the first boolean in
        // this project's settings files, then the user settings, whatever the install scope, else `enabled` (MEASURED,
        // P1-P6). Only the windows-mcp count reads it.
        const flagHere = here.map((doc) => flagIn(doc, r.id)).find((v) => typeof v === 'boolean');
        const enabledHere = typeof flagHere === 'boolean' ? flagHere : enabled;
        const row = catalog.tools.find((t) => t.kind === 'plugin' && t.plugin === name && t.marketplace.name === marketplace);
        rows.push({
            id: r.id, plugin: name, marketplace, scope: r.scope, version: r.version, enabled, enabledFrom, enabledHere,
            errors: r.errors || [], rowId: row ? row.id : null, alfredRetired: catalog.reserved.has(name),
        });
    }
    return rows;
}

function buildInventory({ project, env = process.env, platform = process.platform, arch = process.arch, catalog = catalogLib.load(), run = cli.run, data = null })
{
    const proj = path.resolve(project);
    const out = {
        version: 1, project: proj, os: platform, arch, cli: null, unreadable: [], registrations: [], plugins: [], pluginServers: [], marketplaces: [], alfredCodeEnabled: false,
        sources: {},
    };

    const mcp = readState(path.join(proj, '.mcp.json'));
    const acct = account.readAccount(env, proj, platform);
    out.sources = { project: { file: mcp.file, state: mcp.state }, account: { file: acct.file, state: acct.state }, local: { file: acct.file, state: acct.state }, user: { file: acct.file, state: acct.state } };
    for (const [scope, s] of [['project', mcp], ['local', acct], ['user', acct]])
        if (s.state === 'malformed' || s.state === 'unreadable') out.unreadable.push({ scope, file: s.file, state: s.state, error: s.error });

    const approval = approvalContext(proj, env, acct, platform);
    const scopes = [['project', (mcp.doc && mcp.doc.mcpServers) || {}], ['local', acct.local], ['user', acct.user]];
    for (const [scope, servers] of scopes)
    {
        if (!servers || typeof servers !== 'object') continue;
        for (const [name, entry] of Object.entries(servers))
        {
            const m = matchEntry(entry, catalog);
            out.registrations.push({
                name, scope, entry,
                rowId: m ? m.rowId : null, route: m ? m.route : null,
                own: !m,
                // alfred-code 2.10.0 or older: the stack's servers sit under reserved names; offer nothing over them
                alfredRetired: catalog.reserved.has(name),
                // this folder's own .mcp.json server waits for approval by a parent's rules (MEASURED, M8)
                ...(scope === 'project' ? { approval: approvalOf(name, approval) } : {}),
            });
        }
    }

    // the parents' servers, nearest first; `shadowed` names what Claude Code uses in their place
    const wins = new Map(Object.keys(acct.local || {}).map((n) => [n, { scope: 'local', from: null }]));
    for (const n of Object.keys((mcp.doc && mcp.doc.mcpServers) || {})) if (!wins.has(n)) wins.set(n, { scope: 'project', from: proj });
    out.sources.inherited = [];
    for (const { dir, file } of ancestorMcpFiles(proj))
    {
        const s = readState(file);
        out.sources.inherited.push({ file, state: s.state });
        if (s.state === 'malformed' || s.state === 'unreadable') { out.unreadable.push({ scope: 'inherited', file, state: s.state, error: s.error }); continue; }
        const servers = s.doc && s.doc.mcpServers && typeof s.doc.mcpServers === 'object' ? s.doc.mcpServers : {};
        for (const [name, entry] of Object.entries(servers))
        {
            const m = matchEntry(entry, catalog);
            out.registrations.push({
                name, scope: 'inherited', from: dir, file, entry, rowId: m ? m.rowId : null, route: m ? m.route : null, own: !m,
                alfredRetired: catalog.reserved.has(name), shadowed: wins.get(name) || null, approval: approvalOf(name, approval),
            });
        }
        for (const n of Object.keys(servers)) if (!wins.has(n)) wins.set(n, { scope: 'inherited', from: dir });
    }

    // trust, and the root folders (spec D2): the roots map in the plugin's data folder, and the root each family uses now
    out.trusted = approval.trusted;
    const rootCtx = { project: proj, home: account.homeDir(env), platform, catalog };
    out.roots = { map: roots.readMap(data) };
    out.roots.project = roots.inUse(out, 'project', rootCtx);
    out.roots.global = roots.inUse(out, 'global', rootCtx);
    // the answers about servers already set up (spec D6): each family's record, and each registration's choice - null when
    // never answered or when its launch changed since
    const existing = require('./existing.js');
    out.records = { project: recordOf(out, 'project', rootCtx), global: recordOf(out, 'global', rootCtx) };
    const fp = (entry) => existing.fingerprintOf(entry, catalog);
    for (const r of out.registrations)
    {
        const rec = r.scope === 'inherited' || !r.rowId ? null : out.records[roots.familyOf(r.scope)];
        r.choice = choiceIn(rec, (e) => e.name === r.name && e.scope === r.scope, fp(r.entry), ['own', 'manage']);
    }

    const version = cli.available({ env, cwd: proj });
    out.cli = version ? { ok: true, version } : { ok: false, version: null };
    if (!version) return out;

    const list = run(['plugin', 'list', '--json'], { cwd: proj, env });
    let listJson = [];
    try { listJson = JSON.parse(list.stdout || '[]'); } catch { out.unreadable.push({ scope: 'plugins', file: 'claude plugin list --json', state: 'malformed', error: 'not JSON' }); }
    out.plugins = pluginRows(listJson, proj, env, catalog);
    out.alfredCodeEnabled = out.plugins.some((p) => p.plugin === 'alfred-code' && p.enabled);
    // each MCP server a plugin that loads here provides, read from its install folder and matched as a registration is
    const installPath = new Map((Array.isArray(listJson) ? listJson : []).map((r) => [`${r.id}~${r.scope}`, r.installPath]));
    for (const p of out.plugins.filter((x) => x.enabledHere))
        for (const s of existing.pluginServers(installPath.get(`${p.id}~${p.scope}`)))
        {
            const m = matchEntry(s.entry, catalog);
            const choice = m ? choiceIn(out.records.project, (e) => e.plugin === p.id && e.server === s.server, fp(s.entry), ['own', 'add']) : null;
            out.pluginServers.push({ plugin: p.id, server: s.server, entry: s.entry, rowId: m ? m.rowId : null, route: m ? m.route : null, choice });
        }

    const mk = run(['plugin', 'marketplace', 'list', '--json'], { cwd: proj, env });
    try { out.marketplaces = JSON.parse(mk.stdout || '[]').map((m) => ({ name: m.name, source: m.repo || m.url || m.path || '', installLocation: m.installLocation || '' })); }
    catch { out.marketplaces = []; }
    return out;
}

// The family's record: the first the commands' order finds (roots.recordFiles). -> { file, servers, note? } | null
function recordOf(inv, family, ctx)
{
    for (const file of roots.recordFiles(inv, family, ctx))
    {
        const r = roots.readRecord(file);
        if (r) return { file, servers: r.servers, ...(r.note ? { note: r.note } : {}) };
    }
    return null;
}

// A recorded choice that still holds: the entry found, its fingerprint the launch's now, its choice one of `allowed`.
function choiceIn(record, match, fingerprint, allowed)
{
    const e = record ? record.servers.find(match) : null;
    return e && e.fingerprint === fingerprint && allowed.includes(e.choice) ? e.choice : null;
}

// The inventory as a file or a print holds it: every credential value as kept.js's marker, so no command line names a
// file with a live one (alfred-code's guard refuses it) and nothing printed puts one in the chat. apply.js takes the
// real values back from the registrations themselves.
function keptOf(inv, catalog = catalogLib.load())
{
    const keep = (x) => ({ ...x, entry: kept.keep(x.entry, x.rowId ? catalog.byId.get(x.rowId) : null) });
    return { ...inv, registrations: inv.registrations.map(keep), ...(inv.pluginServers ? { pluginServers: inv.pluginServers.map(keep) } : {}) };
}

// A parent folder as the project names it: '..', '../..', from the real folder, as the walk found it.
const fromHere = (inv, dir) => path.relative(realOf(inv.project), dir).split(path.sep).join('/') || '.';

// What a row looks like installed: every registration or plugin that belongs to it, with its scope.
function installedOf(inv, rowId)
{
    return [
        ...inv.registrations.filter((r) => r.rowId === rowId && !r.alfredRetired).map((r) => (r.scope === 'inherited'
            ? { kind: 'mcp', name: r.name, scope: r.scope, from: r.from, route: r.route, entry: r.entry, approval: r.approval }
            : { kind: 'mcp', name: r.name, scope: r.scope, route: r.route, entry: r.entry })),
        ...inv.plugins.filter((p) => p.rowId === rowId && !p.alfredRetired).map((p) => ({ kind: 'plugin', name: p.id, scope: p.scope, version: p.version, enabled: p.enabled })),
    ];
}

// The windows-mcp servers Claude Code starts in this project - windows-mcp 0.8.8 keeps one per desktop healthy
// (docs/sources.md 'windows-mcp 0.8.8 - the sticky overlay failure'). One per name, the nearest: local, project (once
// approved - M8; a hand-built inventory carries no approval), a parent's .mcp.json (approved and not shadowed - M7),
// then user (M2, M3). Counted: the windows-control row's registrations, alfred-code's under its reserved name (its
// launcher hides the package), and alfred-code's plugins that load here - on for this project (P1-P6), and an id its
// marketplace dropped says so only in `errors` (plugin-cli-evidence S13, S25).
// -> [{ name, scope, kind, owner: 'catalog' | 'alfred-code', from }]
const WINDOWS_MCP_PLUGINS = ['windows-control', 'windows-desktop'];
const NEAREST = { local: 0, project: 1, inherited: 2, user: 3 };
function windowsMcpServers(inv)
{
    const starts = inv.registrations.filter((r) => (r.scope === 'inherited' ? r.approval === 'approved' && !r.shadowed : r.scope !== 'project' || !r.approval || r.approval === 'approved'));
    const wins = new Map();
    for (const r of starts.slice().sort((a, b) => NEAREST[a.scope] - NEAREST[b.scope])) if (!wins.has(r.name)) wins.set(r.name, r);
    // one plugin id is one server, however many scopes hold an install row for it (S28): the nearest row names it
    const loads = (inv.plugins || []).filter((p) => (p.enabledHere ?? p.enabled) && !(p.errors || []).length && p.marketplace === 'envoydev' && WINDOWS_MCP_PLUGINS.includes(p.plugin));
    const nearest = new Map();
    for (const p of loads.slice().sort((a, b) => NEAREST[a.scope] - NEAREST[b.scope])) if (!nearest.has(p.id)) nearest.set(p.id, p);
    return [
        ...[...wins.values()].filter((r) => r.rowId === 'windows-control' || (r.alfredRetired && r.name === 'windows-control'))
            .map((r) => ({ name: r.name, scope: r.scope, kind: 'mcp', owner: r.alfredRetired ? 'alfred-code' : 'catalog', from: r.from || null })),
        ...loads.filter((p) => nearest.get(p.id) === p).map((p) => ({ name: p.id, scope: p.scope, kind: 'plugin', owner: 'alfred-code', from: null })),
    ];
}

// The windows-mcp servers here that a new registration under `name` does not replace - one of the same name is the same
// server, whichever scope wins - as 'name (scope)'.
const otherWindowsMcp = (inv, name) => windowsMcpServers(inv).filter((s) => s.kind === 'plugin' || s.name !== name).map((s) => `${s.name} (${s.scope})`);

// One installed thing, by the key configure asks with: `mcp:<name>~<scope>` or `plugin:<plugin id>~<scope>` (the same
// shape as update.js's offer ids). -> { kind, item } or null when nothing is installed under that key.
const keyOf = (kind, name, scope) => `${kind}:${name}~${scope}`;
function targetOf(inv, key)
{
    const m = /^(mcp|plugin):(.+)~(local|project|user)$/.exec(key || '');
    if (!m) return null;
    const item = m[1] === 'mcp'
        ? inv.registrations.find((r) => r.name === m[2] && r.scope === m[3])
        : inv.plugins.find((p) => p.id === m[2] && p.scope === m[3]);
    return item ? { kind: m[1], item } : null;
}

function main(argv)
{
    blockingStdio();
    const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
    const project = val('--project') || process.cwd();
    const outFile = val('--json');
    const inv = buildInventory({ project, data: val('--data') || null });
    if (!inv.cli.ok)
    {
        console.error('preferred-tools: the claude CLI is not on PATH - install Claude Code, then run this again.');
        return 3;
    }
    const text = JSON.stringify(keptOf(inv), null, 2);
    if (outFile) fs.writeFileSync(outFile, text);
    else console.log(text);
    for (const u of inv.unreadable)
        console.error(`preferred-tools: ${u.file} is ${u.state}${u.error ? ` (${u.error})` : ''} - ${u.scope === 'inherited' ? "Claude Code skips that parent folder's servers too; nothing here writes to it." : `the ${u.scope} scope is treated as unreadable and nothing will be written there.`}`);
    const own = inv.registrations.filter((r) => r.own).length;
    console.log(`inventory: ${inv.registrations.length} registrations (${inv.registrations.length - own} match a catalog row, ${own} are your own), ${inv.plugins.length} plugins${outFile ? ` -> ${outFile}` : ''}`);
    return 0;
}

// exported before main runs: existing.js, required while main runs, reads matchesFingerprint from here
module.exports = { launchTokens, bareName, matchEntry, matchesFingerprint, ancestorMcpFiles, buildInventory, keptOf, fromHere, installedOf, windowsMcpServers, otherWindowsMcp, keyOf, targetOf, pluginRows };
if (require.main === module) process.exit(main(process.argv.slice(2)));
