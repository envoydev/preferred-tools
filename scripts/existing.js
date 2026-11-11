'use strict';
// SERVERS ALREADY SET UP (spec D6, F4) - a registration that matches a catalog row, an MCP server an enabled plugin
// provides, and a claude.ai connector this session has loaded. A matching registration is managed by configure, update
// and fix with no record; one the user leaves on its own in configure is saved in the root's preferred-tools.json by the
// apply's record-clean step, the only entries that file holds. Nothing here writes, and no server is started to find one.
const fs = require('node:fs');
const path = require('node:path');
const account = require('./account.js');
const roots = require('./roots.js');
const { parseJson } = require('./json-file.js');
const { fingerprintKey } = require('./catalog.js');
// inventory.js requires this file lazily, inside buildInventory
const { matchesFingerprint } = require('./inventory.js');

// the rows with a hosted route: the only ones a connector can be
const HOSTED_ROWS = ['context7', 'github', 'gitlab', 'atlassian', 'sentry'];
const CHOICES = { mcp: ['own', 'manage'], plugin: ['own', 'add'], connector: ['own', 'add'] };
const REC = ' (Recommended)';

// `--connectors <Name>,<Name>`: the names, trimmed, each once.
const parseConnectors = (arg) => [...new Set(String(arg == null ? '' : arg).split(',').map((s) => s.trim()).filter(Boolean))];

// A connector's row: its name lower-cased with all but letters and digits removed starts with the row id, so a suffixed
// name ('Atlassian_Rovo') still matches. -> row id | null
function matchConnector(name)
{
    const n = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
    return n ? HOSTED_ROWS.find((id) => n.startsWith(id)) || null : null;
}

const readJsonFile = (file) => { try { return parseJson(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isEntry = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && (typeof v.command === 'string' || typeof v.url === 'string');
// a servers file: `{ mcpServers: { ... } }`, or the map itself at the top
function serversIn(doc)
{
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
    const map = doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? doc.mcpServers : doc;
    return Object.entries(map).filter(([, v]) => isEntry(v)).map(([server, entry]) => ({ server, entry }));
}

// The MCP servers a plugin provides, read from its install folder: its .mcp.json, then the manifest's mcpServers - inline,
// or a `./` path (or several) to a file inside the plugin. A file that cannot be read gives nothing. -> [{ server, entry }]
function pluginServers(installPath)
{
    if (!installPath || typeof installPath !== 'string') return [];
    const out = serversIn(readJsonFile(path.join(installPath, '.mcp.json')));
    const manifest = readJsonFile(path.join(installPath, '.claude-plugin', 'plugin.json'));
    const decl = manifest && manifest.mcpServers;
    if (decl && typeof decl === 'object' && !Array.isArray(decl)) out.push(...serversIn({ mcpServers: decl }));
    for (const p of typeof decl === 'string' ? [decl] : Array.isArray(decl) ? decl.filter((x) => typeof x === 'string') : [])
    {
        const rel = path.relative(installPath, path.resolve(installPath, p));
        if (!p.startsWith('./') || !rel || rel.startsWith('..') || path.isAbsolute(rel) || rel === '.mcp.json') continue;
        out.push(...serversIn(readJsonFile(path.join(installPath, rel))));
    }
    const seen = new Set();
    return out.filter((s) => !seen.has(s.server) && seen.add(s.server));
}

// The key of the catalog fingerprint a launch matches, in matchEntry's order. -> string | null
function fingerprintOf(entry, catalog)
{
    if (!entry || typeof entry !== 'object') return null;
    for (const row of catalog.tools)
    {
        if (row.kind !== 'mcp') continue;
        for (const def of Object.values(row.routes))
        {
            const f = def.fingerprints.find((x) => matchesFingerprint(entry, x));
            if (f) return fingerprintKey(f);
        }
    }
    return null;
}

const labelOf = (catalog, rowId) => (catalog.byId.get(rowId) || { label: rowId }).label;
const regItem = (r, catalog) => ({
    key: `mcp:${r.name}~${r.scope}`, kind: 'mcp', rowId: r.rowId, label: labelOf(catalog, r.rowId), family: roots.familyOf(r.scope),
    fingerprint: fingerprintOf(r.entry, catalog), choice: r.choice || null, name: r.name, scope: r.scope,
});
const pluginItem = (s, catalog) => ({
    key: `plugin-mcp:${s.plugin}/${s.server}`, kind: 'plugin', rowId: s.rowId, label: labelOf(catalog, s.rowId), family: 'project',
    fingerprint: fingerprintOf(s.entry, catalog), choice: s.choice || null, plugin: s.plugin, server: s.server,
});
function connectorItem(name, inv, catalog)
{
    const rowId = matchConnector(name);
    if (!rowId) return null;
    const recorded = ((inv.records && inv.records.global && inv.records.global.servers) || []).find((e) => e.connector === name);
    return { key: `connector:${name}`, kind: 'connector', rowId, label: labelOf(catalog, rowId), family: 'global', fingerprint: null, choice: (recorded && recorded.choice) || null, connector: name };
}
const asked = (r) => r.rowId && !r.alfredRetired && ['project', 'local', 'user'].includes(r.scope);

// D6's three kinds, each with its recorded choice (null: never answered, or its launch changed since). A registration whose
// helper or data folder points into a root of this plugin is 0.2.0's own - managed, never asked - and is left out.
// -> [{ key, kind, rowId, label, family, fingerprint, choice, ... }]
function items(inv, connectors, catalog, { home = account.homeDir(process.env), exists } = {})
{
    const ctx = { project: inv.project, home, platform: inv.os, catalog, ...(exists ? { exists } : {}) };
    return [
        ...(inv.registrations || []).filter((r) => asked(r) && !roots.pointsIntoRoot(r, inv, ctx)).map((r) => regItem(r, catalog)),
        ...(inv.pluginServers || []).filter((s) => s.rowId).map((s) => pluginItem(s, catalog)),
        ...(connectors || []).map((n) => connectorItem(n, inv, catalog)).filter(Boolean),
    ];
}

// The item an answer's key names, whatever its choice, or null when no such server is here.
function itemOf(inv, key, catalog)
{
    let m = /^mcp:(.+)~(project|local|user)$/.exec(key);
    if (m)
    {
        const r = (inv.registrations || []).find((x) => x.name === m[1] && x.scope === m[2] && asked(x));
        return r ? regItem(r, catalog) : null;
    }
    m = /^plugin-mcp:([^/]+)\/(.+)$/.exec(key);
    if (m)
    {
        const s = (inv.pluginServers || []).find((x) => x.plugin === m[1] && x.server === m[2] && x.rowId);
        return s ? pluginItem(s, catalog) : null;
    }
    m = /^connector:(.+)$/.exec(key);
    return m ? connectorItem(m[1], inv, catalog) : null;
}

// Who else provides a plugin's server or a connector, as the questions and notes name it.
const ownerOf = (item) => (item.kind === 'plugin' ? item.plugin.split('@')[0] : 'claude.ai');
const scopeWord = (scope) => (scope === 'user' ? 'global' : scope);

// The record's entry for an answer (D6): names, scopes, fingerprints and choices only.
function recordEntry(item, choice)
{
    if (item.kind === 'mcp') return { name: item.name, scope: item.scope, fingerprint: item.fingerprint, choice };
    if (item.kind === 'plugin') return { plugin: item.plugin, server: item.server, fingerprint: item.fingerprint, choice };
    return { connector: item.connector, choice };
}

// What is here now, for the record-clean step to drop what is gone (roots.mergeRecord). `connectors`: the list this run
// passed, or null - a run without one keeps every connector entry (R14).
function liveOf(inv, catalog, connectors = null)
{
    const servers = {};
    for (const r of (inv.registrations || []).filter(asked)) servers[`mcp:${r.name}~${r.scope}`] = fingerprintOf(r.entry, catalog);
    for (const s of (inv.pluginServers || []).filter((x) => x.rowId)) servers[`plugin-mcp:${s.plugin}/${s.server}`] = fingerprintOf(s.entry, catalog);
    return { servers, connectors: Array.isArray(connectors) ? connectors : null };
}

// The rows install does not offer, and the rows it offers beside another server, from the recorded choices and this
// run's answers (an answer wins over the record). -> { own: Set<row id>, add: Map<row id, owner> }
function offerRule(inv, catalog, answers = {})
{
    const byKey = new Map();
    for (const r of (inv.registrations || []).filter((x) => asked(x) && x.choice)) byKey.set(`mcp:${r.name}~${r.scope}`, r.choice);
    for (const s of (inv.pluginServers || []).filter((x) => x.rowId && x.choice)) byKey.set(`plugin-mcp:${s.plugin}/${s.server}`, s.choice);
    for (const e of (inv.records && inv.records.global && inv.records.global.servers) || []) if (typeof e.connector === 'string' && e.choice) byKey.set(`connector:${e.connector}`, e.choice);
    for (const [key, choice] of Object.entries(answers || {})) byKey.set(key, choice);
    const own = new Set();
    const add = new Map();
    for (const [key, choice] of byKey)
    {
        const item = itemOf(inv, key, catalog);
        if (!item) continue;
        if (choice === 'own') own.add(item.rowId);
        else if (choice === 'add' && item.kind !== 'mcp') add.set(item.rowId, ownerOf(item));
    }
    return { own, add };
}

// The servers left on their own, as configure lists them (spec D6): a registration, a plugin's server or a connector
// whose recorded choice is 'own'.
function ownItems(inv, catalog)
{
    return [
        ...(inv.registrations || []).filter((r) => asked(r) && r.choice === 'own').map((r) => regItem(r, catalog)),
        ...(inv.pluginServers || []).filter((s) => s.rowId && s.choice === 'own').map((s) => pluginItem(s, catalog)),
        ...((inv.records && inv.records.global && inv.records.global.servers) || []).filter((e) => typeof e.connector === 'string' && e.choice === 'own')
            .map((e) => connectorItem(e.connector, inv, catalog)).filter(Boolean),
    ];
}

// configure's question for one of them: keep it so, or hand it over - a registration to preferred-tools, a plugin's
// server or a connector to install's offer beside it. The answer is a record-clean step only.
function ownQuestion(item)
{
    const reg = item.kind === 'mcp';
    const opts = reg
        ? [{ label: 'Keep it on its own', choice: 'own', description: 'nothing in this plugin changes it' }, { label: 'Let preferred-tools manage it', choice: 'manage', description: 'configure, update and fix look after it from now on' }]
        : [{ label: `Keep it with ${ownerOf(item)}`, choice: 'own', description: `install does not offer ${item.label} here` }, { label: "Let install offer preferred-tools' own as well", choice: 'add', description: `${item.label} is offered again - ${twoServers(item.label, ownerOf(item))}` }];
    const labeled = opts.map((o, i) => ({ ...o, label: `${o.label}${i === 0 ? REC : ''}` }));
    const what = reg ? `${item.name} (${scopeWord(item.scope)}) is on its own` : item.kind === 'plugin' ? `${item.label} is left with the ${ownerOf(item)} plugin` : `${item.label} is left with claude.ai (${item.connector})`;
    return {
        question: { id: `own-${item.key}`, header: 'On its own', multiSelect: false, question: `${what}. Who looks after it?`, options: labeled.map(({ label, description }) => ({ label, description })) },
        answers: Object.fromEntries(labeled.map((o) => [o.label, { key: item.key, choice: o.choice }])),
    };
}

const twoServers = (label, owner) => `two servers of ${label} then run - ${owner}'s and this one`;

module.exports = {
    HOSTED_ROWS, CHOICES, parseConnectors, matchConnector, pluginServers, fingerprintOf, items, itemOf, recordEntry,
    liveOf, offerRule, ownerOf, twoServers, ownItems, ownQuestion,
};
