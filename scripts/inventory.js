#!/usr/bin/env node
'use strict';
// THE INVENTORY - what is installed, read-only, no server started.
//
//   node inventory.js --project <dir> --json <out>
//
// Reads the project's .mcp.json, the account file (user servers, and this project's local servers) and
// `claude plugin list --json`, and matches each registration to a catalog row by what it LAUNCHES - the package in its
// args, or the URL host and path - never by its name. So a tool under a custom name is still recognised, and a
// registration that matches no row is the user's: it is listed as `own` and nothing in this plugin touches it.
const fs = require('node:fs');
const path = require('node:path');
const catalogLib = require('./catalog.js');
const account = require('./account.js');
const cli = require('./claude-cli.js');
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

function pluginRows(listJson, project, env, catalog, alfredCheck)
{
    const rows = [];
    for (const r of Array.isArray(listJson) ? listJson : [])
    {
        const [name, marketplace = ''] = String(r.id).split('@');
        const scoped = r.scope === 'project' || r.scope === 'local';
        if (scoped && r.projectPath && account.projectKey(r.projectPath) !== account.projectKey(project)) continue; // another project's
        let enabled = r.enabled;
        let enabledFrom = 'list';
        if (['user', 'project', 'local'].includes(r.scope))
        {
            const s = readState(settingsOf(r.scope, project, env));
            const flag = s.doc && s.doc.enabledPlugins ? s.doc.enabledPlugins[r.id] : undefined;
            if (typeof flag === 'boolean') { enabled = flag; enabledFrom = 'settings'; }
        }
        const row = catalog.tools.find((t) => t.kind === 'plugin' && t.plugin === name && t.marketplace.name === marketplace);
        rows.push({
            id: r.id, plugin: name, marketplace, scope: r.scope, version: r.version, enabled, enabledFrom,
            errors: r.errors || [], rowId: row ? row.id : null, alfredRetired: catalog.reserved.has(name),
        });
    }
    return rows;
}

function buildInventory({ project, env = process.env, platform = process.platform, arch = process.arch, catalog = catalogLib.load(), run = cli.run })
{
    const proj = path.resolve(project);
    const out = {
        version: 1, project: proj, os: platform, arch, cli: null, unreadable: [], registrations: [], plugins: [], marketplaces: [], alfredCodeEnabled: false,
        sources: {},
    };

    const mcp = readState(path.join(proj, '.mcp.json'));
    const acct = account.readAccount(env, proj);
    out.sources = { project: { file: mcp.file, state: mcp.state }, account: { file: acct.file, state: acct.state }, local: { file: acct.file, state: acct.state }, user: { file: acct.file, state: acct.state } };
    for (const [scope, s] of [['project', mcp], ['local', acct], ['user', acct]])
        if (s.state === 'malformed' || s.state === 'unreadable') out.unreadable.push({ scope, file: s.file, state: s.state, error: s.error });

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
            });
        }
    }

    const version = cli.available({ env, cwd: proj });
    out.cli = version ? { ok: true, version } : { ok: false, version: null };
    if (!version) return out;

    const list = run(['plugin', 'list', '--json'], { cwd: proj, env });
    let listJson = [];
    try { listJson = JSON.parse(list.stdout || '[]'); } catch { out.unreadable.push({ scope: 'plugins', file: 'claude plugin list --json', state: 'malformed', error: 'not JSON' }); }
    out.plugins = pluginRows(listJson, proj, env, catalog);
    out.alfredCodeEnabled = out.plugins.some((p) => p.plugin === 'alfred-code' && p.enabled);

    const mk = run(['plugin', 'marketplace', 'list', '--json'], { cwd: proj, env });
    try { out.marketplaces = JSON.parse(mk.stdout || '[]').map((m) => ({ name: m.name, source: m.repo || m.url || m.path || '', installLocation: m.installLocation || '' })); }
    catch { out.marketplaces = []; }
    return out;
}

// What a row looks like installed: every registration or plugin that belongs to it, with its scope.
function installedOf(inv, rowId)
{
    return [
        ...inv.registrations.filter((r) => r.rowId === rowId && !r.alfredRetired).map((r) => ({ kind: 'mcp', name: r.name, scope: r.scope, route: r.route, entry: r.entry })),
        ...inv.plugins.filter((p) => p.rowId === rowId && !p.alfredRetired).map((p) => ({ kind: 'plugin', name: p.id, scope: p.scope, version: p.version, enabled: p.enabled })),
    ];
}

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
    const inv = buildInventory({ project });
    if (!inv.cli.ok)
    {
        console.error('preferred-tools: the claude CLI is not on PATH - install Claude Code, then run this again.');
        return 3;
    }
    const text = JSON.stringify(inv, null, 2);
    if (outFile) fs.writeFileSync(outFile, text);
    else console.log(text);
    for (const u of inv.unreadable) console.error(`preferred-tools: ${u.file} is ${u.state}${u.error ? ` (${u.error})` : ''} - the ${u.scope} scope is treated as unreadable and nothing will be written there.`);
    const own = inv.registrations.filter((r) => r.own).length;
    console.log(`inventory: ${inv.registrations.length} registrations (${inv.registrations.length - own} match a catalog row, ${own} are your own), ${inv.plugins.length} plugins${outFile ? ` -> ${outFile}` : ''}`);
    return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { launchTokens, bareName, matchEntry, matchesFingerprint, buildInventory, installedOf, keyOf, targetOf, pluginRows };
