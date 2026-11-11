'use strict';
// MCP ORDER (spec F8) - .mcp.json's servers in the catalog's order: the servers this plugin manages first, by their row's
// place in catalog.order (two of one row keep their order), then the user's own and the servers left on their own, in
// their current order. Only the order of mcpServers' keys changes, never a value, and every other top-level key, the
// indent, the line endings and the final newline stay as they were.
//
// The one write to .mcp.json that is not the claude CLI's (the user's ruling, 2026-11-11). It never fails an apply: a file
// that is not plain JSON, a check that does not hold or a failed write leaves the file as it was, with a warning.
const fs = require('node:fs');
const path = require('node:path');
const { matchEntry } = require('./inventory.js');

const LEFT = 'left as it is - /preferred-tools:fix (mcp-order) orders it';
const WHY = '.mcp.json: the catalog servers in your order, your own after them - no value changes';

// The server names in their new order. `own`: the names left on their own, which sit with the user's own servers.
function sortedNames(servers, catalog, own = new Set())
{
    const names = Object.keys(servers || {});
    const rank = new Map(names.map((name) =>
    {
        const m = own.has(name) ? null : matchEntry(servers[name], catalog);
        return [name, m ? catalog.order.indexOf(m.rowId) : -1];
    }));
    // Array.prototype.sort is stable: two of one row keep their order
    const managed = names.filter((n) => rank.get(n) >= 0).sort((a, b) => rank.get(a) - rank.get(b));
    return [...managed, ...names.filter((n) => rank.get(n) < 0)];
}

// a value with its object keys sorted, as text: two objects equal once key order is ignored give the same text
function canon(v)
{
    const sorted = (x) =>
    {
        if (Array.isArray(x)) return x.map(sorted);
        if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sorted(x[k])]));
        return x;
    };
    return JSON.stringify(sorted(v));
}

// -> { text, changed } | { error }
function reorderText(text, catalog, own = new Set())
{
    let doc;
    // the parser's message quotes the text, which may hold a value: never repeated
    try { doc = JSON.parse(text); }
    catch { return { error: 'is not plain JSON (a BOM, a comment or a trailing comma, say)' }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'is not a JSON object' };
    const servers = doc.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { text, changed: false };
    const names = Object.keys(servers);
    const order = sortedNames(servers, catalog, own);
    if (order.every((n, i) => n === names[i])) return { text, changed: false };
    // Object.fromEntries defines each key as its own property, '__proto__' included
    const next = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, k === 'mcpServers' ? Object.fromEntries(order.map((n) => [n, servers[n]])) : v]));
    if (Object.keys(next.mcpServers).some((n, i) => n !== order[i])) return { error: 'has a server name JSON cannot place (an integer name)' };
    const indented = /\n([ \t]+)\S/.exec(text);
    const crlf = text.includes('\r\n');
    let out = JSON.stringify(next, null, indented ? indented[1] : 2);
    if (crlf) out = out.replace(/\n/g, '\r\n');
    if (/\n$/.test(text)) out += crlf ? '\r\n' : '\n';
    let back;
    try { back = JSON.parse(out); }
    catch { return { error: 'would not parse once ordered' }; }
    const sameNames = Object.keys(back.mcpServers).length === names.length && names.every((n) => Object.hasOwn(back.mcpServers, n));
    if (!sameNames || canon(back) !== canon(doc)) return { error: 'would not hold the same servers once ordered' };
    return { text: out, changed: true };
}

// -> { ok: true, changed, detail }; never throws
function orderFile(file, catalog, own = new Set(), { read = fs.readFileSync, write = fs.writeFileSync, rename = fs.renameSync } = {})
{
    const warn = (why) => ({ ok: true, changed: false, detail: `warning: ${file} ${why}; ${LEFT}` });
    let text;
    try { text = read(file, 'utf8'); }
    catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { ok: true, changed: false, detail: `${file}: not there - nothing to order` } : warn(`cannot be read (${e.code || e.message})`); }
    const r = reorderText(text, catalog, own);
    if (r.error) return warn(r.error);
    if (!r.changed) return { ok: true, changed: false, detail: `${file}: the servers are already in order` };
    // a .mcp.json that is a link: the file it points at is replaced, the link stays
    let target = file;
    try { target = fs.realpathSync(file); } catch { /* not on this disk (a test's stub): the path as given */ }
    const tmp = `${target}.${process.pid}.tmp`;
    try
    {
        let now = null;
        try { now = read(file, 'utf8'); } catch { /* gone since: not the text read */ }
        if (now !== text) return warn('changed while it was being ordered');
        write(tmp, r.text);
        rename(tmp, target);
    }
    catch (e)
    {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
        return warn(`could not be written (${e.code || e.message})`);
    }
    return { ok: true, changed: true, detail: `ordered ${file}: the catalog servers first, your own after them - no value changed` };
}

// The project-scope servers left on their own: recorded so, or answered so in this run.
function ownProjectNames(inv, existing = {})
{
    const names = (inv.registrations || []).filter((r) => r.scope === 'project' && r.choice === 'own').map((r) => r.name);
    for (const [key, choice] of Object.entries(existing || {}))
    {
        const m = /^mcp:(.+)~project$/.exec(key);
        if (m && choice === 'own') names.push(m[1]);
    }
    return [...new Set(names)];
}

// The steps with the order step last, when one of them writes a project-scope registration.
function withOrderStep(steps, project, own = [])
{
    const writes = steps.some((s) => (['mcp-add', 'mcp-replace'].includes(s.op) && s.scope === 'project') || (s.op === 'mcp-move' && s.to && s.to.scope === 'project'));
    if (!writes) return steps;
    const P = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(project) ? path.win32 : path.posix;
    return [...steps, { op: 'order-mcp-json', file: P.join(project, '.mcp.json'), own, why: WHY }];
}

module.exports = { sortedNames, reorderText, orderFile, ownProjectNames, withOrderStep };
