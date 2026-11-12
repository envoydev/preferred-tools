#!/usr/bin/env node
'use strict';
// THE UPDATE ENGINE - what is installed and behind its release: plugins (catalog or not), the pinned MCP servers, the
// language servers on PATH, the helper and bridge copies, and the new ways to pass data (fix's `upgrade` rows).
//
//   node update.js --check [--json] [--no-refresh] [--project <dir>] [--data <dir>]   read-only (it refreshes the marketplace clones)
//   node update.js --questions [--no-refresh] [--project <dir>] [--data <dir>]        the asks, as data
//   --data: the plugin's data folder, whose roots map finds the records - a server left on its own (spec D6) is skipped
//   node update.js --apply <id,id | all> [--project <dir>] [--tmp <dir>]  changes the install
//
// An offer id is `plugin:<plugin id>~<scope>`, `mcp:<name>~<scope>`, `lsp:typescript`, `helper:<file>` (an
// mcp-headers.js copy older than this plugin's), `bridge:<file>`, or `upgrade:<fix id>:<name>~<scope>` (`:<path>` for a
// file or folder finding); `all` is every offer whose newer version is known. A plugin whose
// marketplace lists no version cannot be compared ahead: it is listed as unchecked, and `claude plugin update` is the
// check, run only on its own id.
//
// An MCP pin moves only to the newest stable release that is 7 or more days old (scripts/registry.js), and the rewrite
// starts from the registration AS READ: the user's args, env and name stay, only the pin and the cut-off beside it move
// (`--exclude-newer` for uvx, `npm_config_before` for npx). A remote route has no pin, a docker image tag is not checked,
// and a registration that matches no catalog row is the user's and never touched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('./catalog.js');
const inventory = require('./inventory.js');
const cli = require('./claude-cli.js');
const registryLib = require('./registry.js');
const E = require('./entries.js');
const fetchLib = require('./fetch.js');
const { apply } = require('./apply.js');
const tmpdir = require('./tmpdir.js');
const { blockingStdio } = require('./json-file.js');
const { realMachine, clone, compareVersions, pinnedVersion } = require('./fixes/common.js');
const { bareName } = inventory;
const asksLib = require('./asks.js');
const mcpOrder = require('./mcp-order.js');

const TS_LSP_INSTALL = ['install', '-g', 'typescript-language-server', 'typescript@6'];

// ---- the pin, edited -------------------------------------------------------------------------------------------------

// The entry with `pkg`'s pin moved to `to` and its cut-off to `cutoff`. Only a cut-off the entry already carries moves: a
// user who removed it keeps it removed. null when the entry pins no version of `pkg`.
function bumpEntry(entry, pkg, to, cutoff)
{
    const from = pinnedVersion(entry, pkg);
    if (!from) return null;
    const e = clone(entry);
    let done = false;
    e.args = (e.args || []).map((a, i, all) =>
    {
        if (!done && !a.startsWith('-') && bareName(a) === pkg && a.endsWith(from)) { done = true; return a.slice(0, a.length - from.length) + to; }
        return a;
    });
    const at = e.args.indexOf('--exclude-newer');
    if (at >= 0 && e.args[at + 1] !== undefined) e.args[at + 1] = cutoff;
    if (e.env && typeof e.env.npm_config_before === 'string') e.env.npm_config_before = cutoff;
    return pinnedVersion(e, pkg) === to ? e : null;
}

// ---- plugins ---------------------------------------------------------------------------------------------------------

// The version a marketplace lists for a plugin, from its clone: the plugin's own plugin.json when the entry points at a
// folder in the clone (that file wins over the entry), else the entry's `version`. null: not listed.
function listedVersion(installLocation, pluginName)
{
    if (!installLocation) return null;
    let file = installLocation;
    try { if (!fs.statSync(file).isFile()) file = path.join(installLocation, '.claude-plugin', 'marketplace.json'); } catch { return null; }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const entry = (doc.plugins || []).find((p) => p.name === pluginName);
    if (!entry) return null;
    const root = path.dirname(path.dirname(file));
    if (typeof entry.source === 'string')
    {
        const dir = path.resolve(root, (doc.metadata && doc.metadata.pluginRoot) || '', entry.source);
        try { const v = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version; if (v) return String(v); } catch { /* the entry's own */ }
    }
    return entry.version ? String(entry.version) : null;
}

function pluginOffers(ctx, out)
{
    const refreshed = new Map();
    for (const p of ctx.inv.plugins)
    {
        if (!refreshed.has(p.marketplace))
        {
            if (!ctx.refresh) refreshed.set(p.marketplace, null);
            else
            {
                const r = ctx.runCli(['plugin', 'marketplace', 'update', p.marketplace], { cwd: ctx.project, env: ctx.env });
                refreshed.set(p.marketplace, !r.error && r.status === 0 ? null : `marketplace ${p.marketplace} did not refresh (${`${r.stderr}${r.stdout}`.trim().split('\n').slice(-1)[0] || 'no output'}) - compared against its last clone`);
            }
            if (refreshed.get(p.marketplace)) out.notes.push(refreshed.get(p.marketplace));
        }
        const market = ctx.inv.marketplaces.find((m) => m.name === p.marketplace);
        const to = listedVersion(market && market.installLocation, p.plugin);
        const base = { kind: 'plugin', id: `plugin:${p.id}~${p.scope}`, plugin: p.id, scope: p.scope, from: p.version || null, group: p.rowId ? 'catalog' : 'other', label: `${p.id} (${p.scope})` };
        if (!market) { out.skipped.push(`${p.id} (${p.scope}): its marketplace '${p.marketplace}' is not registered, so nothing to compare against`); continue; }
        if (to === null) { out.unchecked.push({ ...base, to: null }); continue; }
        const cmp = compareVersions(p.version || '', to);
        const behind = cmp === null ? p.version !== to : cmp === -1;
        if (behind) out.offers.push({ ...base, to });
    }
}

// ---- MCP pins --------------------------------------------------------------------------------------------------------

async function mcpOffers(ctx, out)
{
    const cache = new Map();
    const latest = (registry, name) =>
    {
        const key = `${registry}:${name}`;
        if (!cache.has(key)) cache.set(key, ctx.registry.versionsOf(registry, name));
        return cache.get(key);
    };
    for (const r of ctx.inv.registrations)
    {
        if (r.own || r.alfredRetired) continue;
        if (r.choice === 'own') { out.skipped.push(`${r.name} (${r.scope}): on its own - not checked`); continue; }
        if (r.scope === 'inherited') { out.skipped.push(`${r.name} (inherited): inherited from ${inventory.fromHere(ctx.inv, r.from)} - update it there`); continue; }
        const row = ctx.catalog.byId.get(r.rowId);
        const def = row.routes[r.route];
        const at = `${r.name} (${r.scope})`;
        if (r.route === 'remote') { out.skipped.push(`${at}: a hosted URL has no pin`); continue; }
        if (def.runtime === 'docker') { out.skipped.push(`${at}: the Docker image tag is not checked - change it with /preferred-tools:configure`); continue; }
        if (!def.package) continue;
        const pkg = def.package;
        const from = pinnedVersion(r.entry, pkg.name);
        if (!from) { out.skipped.push(`${at}: ${pkg.name} is launched with no version, so it follows the registry already`); continue; }
        let versions;
        try { versions = await latest(pkg.registry, pkg.name); }
        catch (e) { out.errors.push(`${at}: ${pkg.registry} lookup for ${pkg.name} failed - ${e.message}`); continue; }
        const pick = registryLib.choose(versions, { registry: pkg.registry, now: ctx.now, current: from });
        if (pick.held.length) out.held.push(`${at}: ${registryLib.heldLine(pkg.name, pick.held)}`);
        if (!pick.offer) continue;
        const entry = bumpEntry(r.entry, pkg.name, pick.offer.version, registryLib.cutoffOf(ctx.now));
        if (!entry) { out.errors.push(`${at}: could not move the pin of ${pkg.name} in the registration as it is written - change it with /preferred-tools:configure`); continue; }
        out.offers.push({ kind: 'mcp', id: `mcp:${r.name}~${r.scope}`, name: r.name, scope: r.scope, row: r.rowId, route: r.route, package: pkg.name, from, to: pick.offer.version, ageDays: pick.offer.ageDays, cutoff: registryLib.cutoffOf(ctx.now), old: r.entry, entry, group: 'mcp', label: `${r.name} (${r.scope})` });
    }
}

// ---- language servers ------------------------------------------------------------------------------------------------

async function lspOffers(ctx, out)
{
    const m = ctx.machine;
    const version = (bin) =>
    {
        if (!m.which(bin)) return null;
        const r = m.run(bin, ['--version']);
        return r && r.status === 0 ? (/\d+(\.\d+)+/.exec(String(r.stdout || r.stderr)) || [null])[0] : undefined;
    };
    const ts = version('typescript-language-server');
    if (ts)
    {
        let pick = null;
        try { pick = registryLib.choose(await ctx.registry.versionsOf('npm', 'typescript-language-server'), { registry: 'npm', now: ctx.now, current: ts }); }
        catch (e) { out.errors.push(`typescript-language-server: npm lookup failed - ${e.message}`); }
        out.lsp.push(`typescript-language-server ${ts}${pick && pick.offer ? ` (${pick.offer.version} is out)` : ''}`);
        if (pick && pick.offer) out.offers.push({ kind: 'lsp', id: 'lsp:typescript', from: ts, to: pick.offer.version, group: 'lsp', label: 'typescript-language-server (global npm)', command: `npm ${TS_LSP_INSTALL.join(' ')}` });
    }
    else if (ts === undefined) out.lsp.push('typescript-language-server is on PATH but did not report a version');
    const cs = version('csharp-ls');
    if (cs) out.lsp.push(`csharp-ls ${cs} (latest not checked - a dotnet tool copy updates with: dotnet tool update --global csharp-ls)`);
    else if (cs === undefined) out.lsp.push('csharp-ls is on PATH but did not report a version');
}

// ---- key helpers (spec D7, R10) ---------------------------------------------------------------------------------------

// Each mcp-headers.js a managed registration names, or a root in use holds, with a lower number than this plugin's is
// offered; a hand edit or a newer copy is left to /preferred-tools:fix, with a note.
function helperOffers(ctx, out)
{
    const roots = require('./roots.js');
    const { HELPER_VERSION } = require('./mcp-headers.js');
    const { BRIDGE_VERSION } = require('./mcp-bridge.js');
    const P = E.pathFor(ctx.inv.os);
    const rctx = { project: ctx.project, home: require('./account.js').homeDir(ctx.env), platform: ctx.inv.os, catalog: ctx.catalog };
    const dirs = new Set(['project', 'global'].map((f) => ctx.inv.roots && ctx.inv.roots[f] && ctx.inv.roots[f].path).filter(Boolean));
    const bridgeDirs = new Set();
    for (const r of ctx.inv.registrations || [])
    {
        if (!r.rowId || r.own || r.alfredRetired || r.choice === 'own' || r.scope === 'inherited') continue;
        const named = roots.helperPathOf(r.entry && r.entry.headersHelper);
        if (named) dirs.add(P.dirname(roots.absOf(named, rctx)));
        // a bridge's folder holds its bridge and the helper it requires (0.4.0)
        const bridge = E.bridgeParts(r.entry);
        if (bridge) bridgeDirs.add(P.dirname(roots.absOf(bridge.path, rctx)));
    }
    for (const root of bridgeDirs) dirs.add(root);
    const offer = (kind, root, version) =>
    {
        const name = roots.FILES[kind];
        const file = P.join(root, name);
        const { state, number } = roots.shippedState(kind, file);
        if (state === 'lower') out.offers.push({ kind, id: `${kind}:${file}`, file, root, from: String(number), to: String(version), group: 'helper', label: `${name} in ${root}` });
        else if (state === 'higher') out.notes.push(`${name} in ${root} is newer than this plugin - update preferred-tools`);
        else if (state === 'edited') out.notes.push(`${name} in ${root} changed since preferred-tools wrote it - left; /preferred-tools:fix (helper-stale) rewrites it`);
    };
    for (const root of dirs) offer('helper', root, HELPER_VERSION);
    for (const root of bridgeDirs) offer('bridge', root, BRIDGE_VERSION);
}

// ---- new ways to pass data (the user's ruling, 2026-11-12) ---------------------------------------------------------------

// The fix rows marked `upgrade` carry what an older preferred-tools wrote to the way this version passes data: a key in
// an Authorization header read through mcp-headers.js from .mcps-secrets once the user has put it there (key-to-helper),
// absolute project paths (project-relative-path), the root's .gitignore (root-ignore), the .mcp.json order (mcp-order).
// Only those detectors run. A finding that cannot apply alone - blocked, or needing a folder - is a note naming
// /preferred-tools:fix, counted in `waiting`.
const upgradeCatalog = (catalog) => ({ ...catalog, fixes: catalog.fixes.filter((f) => f.upgrade) });
const upgradeLabel = (f) => (f.kind === 'machine' ? f.name : `${f.name} (${f.scope})`);

function upgradeOffers(ctx, out)
{
    const fixLib = require('./fix.js');
    const catalog = upgradeCatalog(ctx.catalog);
    if (!catalog.fixes.length) return;
    const fctx = fixLib.makeCtx({ inv: ctx.inv, catalog, env: ctx.env, machine: ctx.machine, data: ctx.data });
    for (const f of fixLib.detectAll(fctx).found)
    {
        const label = upgradeLabel(f);
        if (f.blocked || f.input)
        {
            const why = f.blocked || `needs a folder from you (${f.input.prompt})`;
            out.notes.push(`${label}: ${f.found} - not applied here: ${why}${/\/preferred-tools:fix/.test(why) ? '' : '; then run /preferred-tools:fix'}`);
            out.waiting += 1;
            continue;
        }
        const machine = f.kind === 'machine';
        out.offers.push({ kind: 'upgrade', id: `upgrade:${f.id}:${machine ? f.name : `${f.name}~${f.scope}`}`, fix: f.id, name: f.name, scope: machine ? null : f.scope, found: f.found, group: 'upgrade', label });
    }
}

// ---- check -----------------------------------------------------------------------------------------------------------

function makeCtx({ inv, project, catalog = catalogLib.load(), env = process.env, machine, runCli = cli.run, registry, now = Date.now(), refresh = true, data = null })
{
    return {
        inv, project, catalog, env, runCli, now, refresh, data,
        machine: machine || realMachine({ env, platform: inv.os }),
        registry: registry || { versionsOf: (reg, name) => registryLib.versionsOf(reg, name, { env }) },
    };
}

// -> { offers, unchecked, skipped, held, errors, lsp, notes }
async function check(ctx)
{
    const out = { offers: [], unchecked: [], skipped: [], held: [], errors: [], lsp: [], notes: [], waiting: 0 };
    pluginOffers(ctx, out);
    await mcpOffers(ctx, out);
    await lspOffers(ctx, out);
    helperOffers(ctx, out);
    upgradeOffers(ctx, out);
    return out;
}

const behind = (out) => out.offers.length + out.unchecked.length > 0;

function render(out)
{
    const lines = [];
    const table = (title, items) =>
    {
        if (!items.length) return;
        lines.push(title);
        const w = Math.max(...items.map((i) => i.label.length));
        for (const i of items) lines.push(`  ${i.label.padEnd(w)}  ${i.from || '?'} -> ${i.to || '(not listed)'}${i.ageDays !== undefined ? `  (${i.ageDays} days old)` : ''}`);
    };
    table('Catalog plugins:', out.offers.filter((o) => o.kind === 'plugin' && o.group === 'catalog'));
    table('Other plugins:', out.offers.filter((o) => o.kind === 'plugin' && o.group === 'other'));
    table('MCP servers (pin -> newest release at least 7 days old):', out.offers.filter((o) => o.kind === 'mcp'));
    table('Language servers:', out.offers.filter((o) => o.kind === 'lsp'));
    table('Key helpers:', out.offers.filter((o) => o.kind === 'helper' || o.kind === 'bridge'));
    const ups = out.offers.filter((o) => o.kind === 'upgrade');
    if (ups.length)
    {
        lines.push('New ways to pass data:');
        const w = Math.max(...ups.map((u) => u.label.length));
        for (const u of ups) lines.push(`  ${u.label.padEnd(w)}  ${u.fix}: ${u.found}`);
    }
    if (out.unchecked.length)
    {
        lines.push('Plugins whose marketplace lists no version (`claude plugin update` is the check; each is offered on its own):');
        for (const u of out.unchecked) lines.push(`  ${u.label}  ${u.from || '?'}`);
    }
    for (const [title, list] of [['Held back', out.held], ['Skipped', out.skipped], ['Language servers on PATH', out.lsp], ['Could not check', out.errors], ['Notes', out.notes]])
        if (list.length) lines.push(`${title}:`, ...list.map((l) => `  ${l}`));
    // a note that waits on the user is never 'everything current' (a key to fill, a key file git would commit)
    if (!behind(out) && out.waiting) lines.push('', `preferred-tools: nothing to update - ${out.waiting} wait${out.waiting === 1 ? 's' : ''} on you first (the notes above)`);
    else if (!behind(out) && !out.errors.length) lines.push('', 'preferred-tools: everything current');
    else if (!behind(out)) lines.push('', 'preferred-tools: nothing behind among what could be checked');
    return lines.join('\n').replace(/^\n/, '');
}

// ---- asks ------------------------------------------------------------------------------------------------------------

// The asks as data: the offer (single-select), then the pick lists for 'Pick which' - multi-selects of at most four options,
// one group per kind, at most four questions a call.
function questions(out)
{
    const items = [...out.offers, ...out.unchecked];
    if (!items.length) return { offer: null, pick: [] };
    const groups = [['catalog', 'Catalog plugins'], ['other', 'Other plugins'], ['mcp', 'MCP servers'], ['lsp', 'Language servers'], ['helper', 'Key helpers'], ['upgrade', 'New ways to pass data', 'Data passing']];
    const qs = [];
    for (const [g, title, header] of groups)
    {
        const list = items.filter((o) => o.group === g);
        asksLib.chunk(list, 4).forEach((part) => qs.push({
            id: `update-${g}`, header: header || title.slice(0, 12), multiSelect: true, question: `${title}: which do you want to update?`,
            // AskUserQuestion takes 2 to 4 options: a group of one gets 'None of these' beside it
            options: [...part.map((o) => ({ label: o.kind === 'upgrade' ? `${o.label}: ${o.fix}` : `${o.label}: ${o.from || '?'} -> ${o.to || 'latest'}`, description: o.id })), ...(part.length === 1 ? [{ label: 'None of these', description: 'none' }] : [])],
        }));
    }
    const offer = { ...asksLib.STATIC.updateOffer };
    if (!out.offers.length) offer.options = offer.options.filter((o) => o.label !== `All of them${asksLib.REC}`).map((o, i) => (i === 0 ? { ...o, label: `${o.label}${asksLib.REC}` } : o));
    return { offer, pick: asksLib.chunk(qs, 4) };
}

// ---- apply -----------------------------------------------------------------------------------------------------------

function updateLsp(ctx, offer, log)
{
    const r = ctx.machine.run('npm', TS_LSP_INSTALL);
    if (!r || r.status !== 0) { log(`FAILED ${offer.label}: npm ${TS_LSP_INSTALL.join(' ')} failed - ${String((r && (r.stderr || r.stdout)) || 'no output').trim().split('\n').slice(-1)[0]}`); return false; }
    const now = (/\d+(\.\d+)+/.exec(String((ctx.machine.run('typescript-language-server', ['--version']) || {}).stdout)) || [null])[0];
    log(`${now === offer.to ? 'ok    ' : 'CHECK '} ${offer.label}: ${offer.from} -> ${now || '?'} (read back from --version)`);
    return now === offer.to;
}

function updatePlugin(ctx, offer, log)
{
    const r = ctx.runCli(['plugin', 'update', offer.plugin, '--scope', offer.scope], { cwd: ctx.project, env: ctx.env });
    if (r.error || r.status !== 0) { log(`FAILED ${offer.label}: claude plugin update failed - ${`${r.stderr}${r.stdout}`.trim().split('\n').slice(-1)[0]}`); return false; }
    const after = inventory.buildInventory({ project: ctx.project, env: ctx.env, run: ctx.runCli }).plugins.find((p) => p.id === offer.plugin && p.scope === offer.scope);
    const v = after ? after.version : null;
    if (offer.to === null) log(`ok     ${offer.label}: ${offer.from || '?'} -> ${v || '?'}${v === offer.from ? ' (already the latest)' : ''}`);
    else log(`${v === offer.to ? 'ok    ' : 'CHECK '} ${offer.label}: ${offer.from || '?'} -> ${v || '?'} (read back from the plugin list)`);
    if (offer.plugin.startsWith('claude-hud@') && v !== offer.from) hudAfterUpdate(ctx, offer, log);
    return offer.to === null || v === offer.to;
}

// After claude-hud moves: --check again, and name any catalog key the new version's config no longer mentions. Never remove one.
function hudAfterUpdate(ctx, offer, log)
{
    const script = path.join(__dirname, 'hud-statusline.js');
    const catalogFile = path.join(__dirname, '..', 'catalog', 'plugin-settings.json');
    const r = require('node:child_process').spawnSync(process.execPath, [script, '--check', '--catalog', catalogFile, '--project', ctx.project], { encoding: 'utf8', env: ctx.env, cwd: ctx.project });
    log(`claude-hud --check: ${(r.stdout || r.stderr || '').trim().split('\n').slice(-1)[0] || 'no output'}`);
    const list = JSON.parse(ctx.runCli(['plugin', 'list', '--json'], { cwd: ctx.project, env: ctx.env }).stdout || '[]');
    const row = list.find((p) => p.id === offer.plugin && p.scope === offer.scope);
    const file = row && row.installPath ? path.join(row.installPath, 'dist', 'config.js') : null;
    if (!file || !fs.existsSync(file)) { log('claude-hud: dist/config.js was not found in the new version - check the recommended keys with /preferred-tools:configure hud'); return; }
    const text = fs.readFileSync(file, 'utf8');
    const settings = JSON.parse(fs.readFileSync(catalogFile, 'utf8')).plugins['claude-hud'];
    const keys = (settings.targets || []).filter((t) => /config\.json$/.test(t.file)).flatMap((t) => require('./plugin-settings.js').leaves(t.settings).map(([k]) => k));
    const gone = keys.filter((k) => !new RegExp(`\\b${k.split('.').pop()}\\b`).test(text));
    log(gone.length
        ? `claude-hud: ${gone.length} recommended key(s) not found in the new dist/config.js: ${gone.join(', ')} - none was removed from your config; report it in the catalog`
        : `claude-hud: every recommended key is still in the new dist/config.js`);
}

function updateMcp(ctx, offer, tmp, log)
{
    // a new way to pass data rewrote it earlier in this run: the pin moves on the registration as it is now - a change
    // starts from what is installed
    if (ctx.touched && ctx.touched.has(`${offer.name}~${offer.scope}`))
    {
        const now = inventory.buildInventory({ project: ctx.project, env: ctx.env, run: ctx.runCli, data: ctx.data, catalog: ctx.catalog }).registrations.find((r) => r.name === offer.name && r.scope === offer.scope);
        const entry = now ? bumpEntry(now.entry, offer.package, offer.to, offer.cutoff) : null;
        if (!entry) { log(`CHECK  ${offer.label}: rewritten earlier in this run and no longer pins ${offer.package} - left`); return false; }
        offer = { ...offer, old: now.entry, entry };
    }
    // the new pin is not in the cache yet: fetch it right after the rewrite (entries.js fetchStep)
    const fetch = E.fetchStep(offer.name, offer.entry, offer.row, offer.old);
    const plan = { project: ctx.project, alfredCodeEnabled: Boolean(ctx.inv && ctx.inv.alfredCodeEnabled), steps: mcpOrder.withOrderStep([{ op: 'mcp-replace', name: offer.name, scope: offer.scope, old: offer.old, entry: offer.entry, row: offer.row, route: offer.route, why: `${offer.package} ${offer.from} -> ${offer.to}` }, ...(fetch ? [fetch] : [])], ctx.project, mcpOrder.ownProjectNames(ctx.inv || {})), expect: [{ kind: 'mcp', name: offer.name, scope: offer.scope, route: offer.route }] };
    const report = apply(plan, { env: ctx.env, tmp, runCli: ctx.runCli, fetchFile: false, log: (...a) => log(a.join(' ')) });
    if (report.fetch && report.fetch.fetch.length) ctx.fetches.push(report.fetch);
    if (report.failed) return false;
    const got = inventory.buildInventory({ project: ctx.project, env: ctx.env, run: ctx.runCli }).registrations.find((r) => r.name === offer.name && r.scope === offer.scope);
    const pin = got ? pinnedVersion(got.entry, offer.package) : null;
    log(`${pin === offer.to ? 'ok    ' : 'CHECK '} ${offer.label}: ${offer.package} ${offer.from} -> ${pin || '?'} (read back from the file the CLI wrote), cut-off ${offer.cutoff}`);
    return pin === offer.to;
}

// A helper or bridge copy rewritten with this plugin's, if it is still the lower one the check offered; read back. The
// root's package.json says CommonJS when it has none (apply.js ensureCommonjs).
function updateHelper(offer, log)
{
    const roots = require('./roots.js');
    const kind = offer.kind === 'bridge' ? 'bridge' : 'helper';
    const before = roots.shippedState(kind, offer.file);
    if (before.state !== 'lower') { log(`CHECK  ${offer.label}: now ${before.state} - left as it is`); return false; }
    fs.writeFileSync(offer.file, roots.shippedSource(kind));
    const pkg = require('./apply.js').ensureCommonjs(path.dirname(offer.file));
    if (pkg.note) log(`note   ${pkg.note}`);
    const ok = roots.shippedState(kind, offer.file).state === 'same';
    log(`${ok ? 'ok    ' : 'CHECK '} ${offer.label}: ${kind} ${offer.from} -> ${offer.to} (read back)`);
    return ok;
}

// A new way to pass data, applied with fix's own code to the registration as it is now, and read back by its detector.
// It runs before the pins: its health check then reads a launch already in the cache, and a pin moved after it starts
// from what it wrote. One an earlier step already did (a rewrite puts .mcp.json in order) is done. Its launches join
// this run's fetch file.
function updateUpgrade(ctx, offer, dir, log)
{
    const fixLib = require('./fix.js');
    const inv = inventory.buildInventory({ project: ctx.project, env: ctx.env, run: ctx.runCli, data: ctx.data, catalog: ctx.catalog });
    const fctx = fixLib.makeCtx({ inv, catalog: upgradeCatalog(ctx.catalog), env: ctx.env, machine: ctx.machine, data: ctx.data });
    const r = fixLib.applyFixes(fctx, [offer.fix], { only: offer.name, name: offer.name, scope: offer.scope || undefined, tmp: dir, log, runCli: ctx.runCli, fetchFile: false });
    if (r.fetch && r.fetch.fetch.length) ctx.fetches.push(r.fetch);
    for (const f of r.applied.filter((x) => x.kind === 'registration')) { ctx.restart = true; ctx.touched.add(`${f.name}~${f.scope}`); }
    const ok = !r.failed && !r.remaining.length && (r.applied.length > 0 || r.gone);
    log(`${ok ? 'ok    ' : 'CHECK '} ${offer.label}: ${offer.fix} (${r.gone ? 'already done by an earlier step in this run' : 'read back by its detector'})`);
    return ok;
}

// -> { applied: [id], failed: [id], unknown: [id], fetchFile }
function applyUpdates(ctx, ids, out, { tmp, log = console.log } = {})
{
    const res = { applied: [], failed: [], unknown: [], fetchFile: null, dir: null };
    const known = [...out.offers, ...out.unchecked];
    const picked = ids.includes('all') ? [...out.offers, ...ids.filter((i) => i !== 'all').map((i) => known.find((o) => o.id === i)).filter(Boolean)] : ids.map((i) => known.find((o) => o.id === i) || i);
    // the new ways to pass data first - a registration's, then a file's or folder's - and the pins after them (updateUpgrade)
    const rank = (c) => (typeof c === 'string' || c.kind !== 'upgrade' ? 2 : c.scope ? 0 : 1);
    const chosen = [0, 1, 2].flatMap((n) => picked.filter((c) => rank(c) === n));
    const dir = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'preferred-tools-'));
    res.dir = dir;
    ctx.fetches = [];
    ctx.restart = false;
    ctx.touched = new Set();
    for (const c of chosen)
    {
        if (typeof c === 'string') { res.unknown.push(c); log(`NOT OFFERED ${c}: nothing is behind under that id`); continue; }
        const ok = c.kind === 'plugin' ? updatePlugin(ctx, c, log) : c.kind === 'lsp' ? updateLsp(ctx, c, log) : c.kind === 'helper' || c.kind === 'bridge' ? updateHelper(c, log) : c.kind === 'upgrade' ? updateUpgrade(ctx, c, dir, log) : updateMcp(ctx, c, dir, log);
        (ok ? res.applied : res.failed).push(c.id);
    }
    // every rewritten server in one fetch file, for fetch.js in the background (apply.js says why); a server rewritten
    // twice in this run is fetched once at its scope, as it was written last
    const last = new Map();
    for (const s of ctx.fetches.flatMap((f) => f.fetch)) { last.delete(`${s.name}~${s.scope}`); last.set(`${s.name}~${s.scope}`, s); }
    const job = fetchLib.job(ctx.project, [...last.values()], [...new Set(ctx.fetches.flatMap((f) => f.check))]);
    if (job.fetch.length)
    {
        res.fetchFile = fetchLib.writeJob(path.join(dir, 'fetch.json'), job);
        log('', ...fetchLib.nextLines(res.fetchFile, job));
    }
    // a helper runs at each connect: rewriting one needs no restart; a new way to pass data needs one when it rewrote a
    // registration (a .gitignore or the .mcp.json order changes nothing a session started)
    if (res.applied.some((id) => !id.startsWith('helper:') && !id.startsWith('upgrade:')) || ctx.restart) log('', `Restart Claude Code (or run /reload-plugins for plugins) so the updated servers and plugins load${res.fetchFile ? ' - after the fetch reports' : ''}.`);
    return res;
}

// ---- CLI -------------------------------------------------------------------------------------------------------------

function parseArgs(argv)
{
    const args = {};
    for (let i = 0; i < argv.length; i++)
    {
        const a = argv[i];
        if (['--check', '--questions', '--json', '--no-refresh'].includes(a)) { args[a.slice(2)] = true; continue; }
        if (!['--apply', '--project', '--tmp', '--data'].includes(a)) throw new Error(`unknown argument '${a}'`);
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
        i++;
        if (Object.hasOwn(args, a.slice(2))) throw new Error(`${a} is given twice`);
        args[a.slice(2)] = v;
    }
    if (['check', 'questions', 'apply'].filter((m) => args[m]).length !== 1) throw new Error('give exactly one of --check, --questions or --apply');
    return args;
}

async function main(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), machine, registry, now, runCli } = {})
{
    let args;
    try { args = parseArgs(argv); }
    catch (e) { out(`update: ${e.message}\nusage: node scripts/update.js --check | --questions | --apply <id,id|all> [--no-refresh] [--project <dir>] [--tmp <dir>] [--data <dir>]`); return 2; }
    const project = path.resolve(args.project || process.cwd());
    const inv = inventory.buildInventory({ project, env, run: runCli || cli.run, data: args.data || null });
    if (!inv.cli.ok) { out('preferred-tools: the claude CLI is not on PATH - install Claude Code, then run this again.'); return 3; }
    const ctx = makeCtx({ inv, project, env, machine, registry, now, runCli: runCli || cli.run, refresh: !args['no-refresh'], data: args.data || null });
    const found = await check(ctx);
    if (args.apply)
    {
        const log = (...a) => out(a.join('\n'));
        const res = applyUpdates(ctx, args.apply.split(',').filter(Boolean), found, { tmp: args.tmp, log });
        // the last script on <tmp> removes it, unless fetch.js takes it on; apply() per server never does
        if (!res.fetchFile) tmpdir.release(res.dir, log);
        return res.failed.length || res.unknown.length ? 1 : 0;
    }
    if (args.questions) out(JSON.stringify(questions(found), null, 2));
    else if (args.json) out(JSON.stringify(found, null, 2));
    else out(render(found));
    return 0;
}

if (require.main === module) { blockingStdio(); main(process.argv.slice(2)).then((code) => process.exit(code)); }
module.exports = { bumpEntry, listedVersion, makeCtx, check, render, questions, applyUpdates, parseArgs, main, behind };
