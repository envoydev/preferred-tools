#!/usr/bin/env node
'use strict';
// THE TABLE - the whole catalog for this OS as one numbered table, with what is installed at each scope.
//
//   node table.js <inventory.json>
//
// Printed to the tool result, never written to a file. A cell holds, for each thing installed at that scope,
// `<name> [<route>, <pin>]` for a server or `<version>, enabled|disabled` for a plugin. A registration that matches no
// row is the user's: it is named under the table and nothing in this plugin touches it.
const fs = require('node:fs');
const catalogLib = require('./catalog.js');
const { fromHere } = require('./inventory.js');
const { pinnedVersion, launchArgs } = require('./fixes/common.js');
const { blockingStdio } = require('./json-file.js');

const SCOPES = ['local', 'project', 'user'];

// The pin a registration carries: the package version, the image tag, or null (a hosted URL, a binary).
function pinOf(row, routeId, entry)
{
    const def = (row.routes || {})[routeId];
    if (!def) return null;
    if (def.runtime === 'docker')
    {
        const image = launchArgs(entry).find((a) => a.startsWith(def.image.name));
        return image && image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : null;
    }
    return def.package ? pinnedVersion(entry, def.package.name) : null;
}

const cellOf = (items) => (items.length ? items.join('; ') : '-');

function render(inv, catalog = catalogLib.load())
{
    const rows = catalog.tools.filter((r) => r.os.includes(inv.os));
    const body = rows.map((row, i) =>
    {
        const cells = Object.fromEntries(SCOPES.map((s) => [s, []]));
        if (row.kind === 'mcp')
            for (const r of inv.registrations.filter((x) => x.rowId === row.id && !x.alfredRetired && x.scope !== 'inherited'))
            {
                const pin = pinOf(row, r.route, r.entry);
                cells[r.scope].push(`${r.name} [${r.route}${pin ? `, ${pin}` : ''}]`);
            }
        else
            for (const p of inv.plugins.filter((x) => x.rowId === row.id && !x.alfredRetired))
                if (cells[p.scope]) cells[p.scope].push(`${p.version || '?'}, ${p.enabled ? 'enabled' : 'disabled'}${p.errors && p.errors.length ? ' (ERRORS)' : ''}`);
        const group = catalog.groups.find((g) => g.id === row.group);
        return [String(i + 1), group.label, row.label, row.kind === 'mcp' ? 'mcp' : 'plugin', row.kind === 'mcp' ? Object.keys(row.routes).join('/') : '-', ...SCOPES.map((s) => cellOf(cells[s]))];
    });
    const head = ['#', 'group', 'tool', 'kind', 'routes', ...SCOPES];
    const widths = head.map((h, c) => Math.max(h.length, ...body.map((r) => r[c].length)));
    const line = (cols) => cols.map((v, c) => v.padEnd(widths[c])).join('  ').trimEnd();
    const out = [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)];

    const notes = [];
    const own = inv.registrations.filter((r) => r.own && !r.alfredRetired && r.scope !== 'inherited');
    if (own.length) notes.push(`Your own, not in this catalog and never touched: ${own.map((r) => `${r.name} (${r.scope})`).join(', ')}.`);
    const inherited = inv.registrations.filter((r) => r.scope === 'inherited');
    const usedBy = (s) => (s.scope === 'inherited' ? `the one in ${fromHere(inv, s.from)} wins` : `the ${s.scope} one wins`);
    if (inherited.length) notes.push(`Inherited from a parent folder's .mcp.json - change them there: ${inherited.map((r) => `${r.name} (from ${fromHere(inv, r.from)}, ${r.approval}${r.shadowed ? `, not used here: ${usedBy(r.shadowed)}` : ''})`).join(', ')}.`);
    const retired = inv.registrations.filter((r) => r.alfredRetired && r.scope !== 'inherited');
    if (retired.length) notes.push(`Under names alfred-code once registered, left alone: ${retired.map((r) => `${r.name} (${r.scope})`).join(', ')}.`);
    const other = catalog.tools.filter((r) => !r.os.includes(inv.os));
    if (other.length) notes.push(`Not offered on this OS (${inv.os}): ${other.map((r) => r.label).join(', ')}.`);
    for (const p of inv.plugins.filter((x) => x.errors && x.errors.length && x.rowId)) notes.push(`${p.id} (${p.scope}) reports: ${p.errors.join('; ')}`);
    for (const u of inv.unreadable || [])
        notes.push(`${u.file} is ${u.state}${u.error ? ` (${u.error})` : ''}: ${u.scope === 'inherited' ? "Claude Code skips that parent folder's servers; nothing here writes to it." : `the ${u.scope} scope is unreadable here, and nothing will be written to it.`}`);
    return [...out, ...(notes.length ? ['', ...notes] : [])].join('\n');
}

function main(argv, { out = (s) => process.stdout.write(`${s}\n`) } = {})
{
    if (!argv[0]) { out('usage: table.js <inventory.json>'); return 2; }
    let inv;
    try { inv = JSON.parse(fs.readFileSync(argv[0], 'utf8')); }
    catch (e) { out(`table: cannot read ${argv[0]}: ${e.message}`); return 2; }
    out(render(inv));
    return 0;
}

if (require.main === module) { blockingStdio(); process.exit(main(process.argv.slice(2))); }
module.exports = { render, pinOf, main };
