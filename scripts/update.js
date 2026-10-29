#!/usr/bin/env node
'use strict';
// THE UPDATE ENGINE - what is installed and behind its release: plugins (catalog or not), the pinned MCP servers, the
// language servers on PATH.
//
//   node update.js --check [--json] [--no-refresh] [--project <dir>]     read-only (it refreshes the marketplace clones)
//   node update.js --questions [--no-refresh] [--project <dir>]          the asks, as data
//   node update.js --apply <id,id | all> [--project <dir>] [--tmp <dir>]  changes the install
//
// An offer id is `plugin:<plugin id>~<scope>`, `mcp:<name>~<scope>` or `lsp:typescript`; `all` is every offer whose newer
// version is known. A plugin whose marketplace lists no version cannot be compared ahead: it is listed as unchecked, and
// `claude plugin update` is the check, run only on its own id.
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

// ---- check -----------------------------------------------------------------------------------------------------------

function makeCtx({ inv, project, catalog = catalogLib.load(), env = process.env, machine, runCli = cli.run, registry, now = Date.now(), refresh = true })
{
    return {
        inv, project, catalog, env, runCli, now, refresh,
        machine: machine || realMachine({ env, platform: inv.os }),
        registry: registry || { versionsOf: (reg, name) => registryLib.versionsOf(reg, name, { env }) },
    };
}

// -> { offers, unchecked, skipped, held, errors, lsp, notes }
async function check(ctx)
{
    const out = { offers: [], unchecked: [], skipped: [], held: [], errors: [], lsp: [], notes: [] };
    pluginOffers(ctx, out);
    await mcpOffers(ctx, out);
    await lspOffers(ctx, out);
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
    if (out.unchecked.length)
    {
        lines.push('Plugins whose marketplace lists no version (`claude plugin update` is the check; each is offered on its own):');
        for (const u of out.unchecked) lines.push(`  ${u.label}  ${u.from || '?'}`);
    }
    for (const [title, list] of [['Held back', out.held], ['Skipped', out.skipped], ['Language servers on PATH', out.lsp], ['Could not check', out.errors], ['Notes', out.notes]])
        if (list.length) lines.push(`${title}:`, ...list.map((l) => `  ${l}`));
    if (!behind(out) && !out.errors.length) lines.push('', 'preferred-tools: everything current');
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
    const groups = [['catalog', 'Catalog plugins'], ['other', 'Other plugins'], ['mcp', 'MCP servers'], ['lsp', 'Language servers']];
    const qs = [];
    for (const [g, title] of groups)
    {
        const list = items.filter((o) => o.group === g);
        asksLib.chunk(list, 4).forEach((part) => qs.push({
            id: `update-${g}`, header: title.slice(0, 12), multiSelect: true, question: `${title}: which do you want to update?`,
            options: part.map((o) => ({ label: `${o.label}: ${o.from || '?'} -> ${o.to || 'latest'}`, description: o.id })),
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
    // the new pin is not in the cache yet: fetch it right after the rewrite (entries.js fetchStep)
    const fetch = E.fetchStep(offer.name, offer.entry, offer.row, offer.old);
    const plan = { project: ctx.project, steps: [{ op: 'mcp-replace', name: offer.name, scope: offer.scope, old: offer.old, entry: offer.entry, why: `${offer.package} ${offer.from} -> ${offer.to}` }, ...(fetch ? [fetch] : [])], expect: [{ kind: 'mcp', name: offer.name, scope: offer.scope, route: offer.route }] };
    const report = apply(plan, { env: ctx.env, tmp, runCli: ctx.runCli, fetchFile: false, log: (...a) => log(a.join(' ')) });
    if (report.fetch && report.fetch.fetch.length) ctx.fetches.push(report.fetch);
    if (report.failed) return false;
    const got = inventory.buildInventory({ project: ctx.project, env: ctx.env, run: ctx.runCli }).registrations.find((r) => r.name === offer.name && r.scope === offer.scope);
    const pin = got ? pinnedVersion(got.entry, offer.package) : null;
    log(`${pin === offer.to ? 'ok    ' : 'CHECK '} ${offer.label}: ${offer.package} ${offer.from} -> ${pin || '?'} (read back from the file the CLI wrote), cut-off ${offer.cutoff}`);
    return pin === offer.to;
}

// -> { applied: [id], failed: [id], unknown: [id], fetchFile }
function applyUpdates(ctx, ids, out, { tmp, log = console.log } = {})
{
    const res = { applied: [], failed: [], unknown: [], fetchFile: null, dir: null };
    const known = [...out.offers, ...out.unchecked];
    const chosen = ids.includes('all') ? [...out.offers, ...ids.filter((i) => i !== 'all').map((i) => known.find((o) => o.id === i)).filter(Boolean)] : ids.map((i) => known.find((o) => o.id === i) || i);
    const dir = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'preferred-tools-'));
    res.dir = dir;
    ctx.fetches = [];
    for (const c of chosen)
    {
        if (typeof c === 'string') { res.unknown.push(c); log(`NOT OFFERED ${c}: nothing is behind under that id`); continue; }
        const ok = c.kind === 'plugin' ? updatePlugin(ctx, c, log) : c.kind === 'lsp' ? updateLsp(ctx, c, log) : updateMcp(ctx, c, dir, log);
        (ok ? res.applied : res.failed).push(c.id);
    }
    // every rewritten server in one fetch file, for fetch.js in the background (apply.js says why)
    const job = fetchLib.job(ctx.project, ctx.fetches.flatMap((f) => f.fetch), ctx.fetches.flatMap((f) => f.check));
    if (job.fetch.length)
    {
        res.fetchFile = fetchLib.writeJob(path.join(dir, 'fetch.json'), job);
        log('', ...fetchLib.nextLines(res.fetchFile, job));
    }
    if (res.applied.length) log('', `Restart Claude Code (or run /reload-plugins for plugins) so the updated servers and plugins load${res.fetchFile ? ' - after the fetch reports' : ''}.`);
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
        if (!['--apply', '--project', '--tmp'].includes(a)) throw new Error(`unknown argument '${a}'`);
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
    catch (e) { out(`update: ${e.message}\nusage: node scripts/update.js --check | --questions | --apply <id,id|all> [--no-refresh] [--project <dir>] [--tmp <dir>]`); return 2; }
    const project = path.resolve(args.project || process.cwd());
    const inv = inventory.buildInventory({ project, env, run: runCli || cli.run });
    if (!inv.cli.ok) { out('preferred-tools: the claude CLI is not on PATH - install Claude Code, then run this again.'); return 3; }
    const ctx = makeCtx({ inv, project, env, machine, registry, now, runCli: runCli || cli.run, refresh: !args['no-refresh'] });
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
