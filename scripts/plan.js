#!/usr/bin/env node
'use strict';
// THE PLAN - answers in, an ordered list of operations out. Nothing here changes anything.
//
//   node plan.js <inventory.json> <answers.json> [--out <plan.json>]     the plan, printed, and written for apply.js
//   node plan.js --questions <inventory.json> [<picks.json>]              every ask the walk makes, as data
//
// A fresh add builds its entry from catalog/tools.json. A rename, a move, a route or location change (configure) starts
// from the registration as read - its pin, its cut-off, the args and env the user added - and changes only what the
// answer names, so an updated pin is never downgraded. The same answers twice plan nothing.
//
// Answers: { picks: { <row id>: { route, scope, name, location, executablePath, token, params } },
//            change: { <key>: { row, <the same answers as a pick> } },
//            remove: [{ kind: 'mcp', name, scope } | { kind: 'plugin', id, scope }], hud: 'recommended' | 'replace' | 'skip' | 'defer',
//            machine: { docker } (from prereq.js --json) }
//   name: 'keep' | 'prefixed' | any literal name       location: { side: 'keep' | 'default' | 'project' | 'account' | 'path', path }
//   picks come from install and only ADD: a pick already there under its name and scope is left unchanged, and a
//   registration of the row at another scope or name is left as it is, so a project gets its own copy beside one
//   installed for every project. change comes from configure, keyed `mcp:<name>~<scope>` or `plugin:<id>~<scope>`: it
//   renames, moves or rewrites that ONE registration, and another of the same row is left. Its `row` is for prereq.js.
const fs = require('node:fs');
const path = require('node:path');
const catalogLib = require('./catalog.js');
const E = require('./entries.js');
const asks = require('./asks.js');
const account = require('./account.js');
const { installedOf, keyOf, targetOf } = require('./inventory.js');
const { blockingStdio } = require('./json-file.js');

const SCOPES = ['local', 'project', 'user'];
const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v)
{
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
}
const flagValue = (args, flag) => { const i = (args || []).indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

function makeCtx(inv, opts = {})
{
    return {
        platform: inv.os, arch: inv.arch, project: inv.project, env: opts.env || process.env,
        home: opts.home || account.homeDir(opts.env || process.env), exists: opts.exists, machine: opts.machine || {},
    };
}

// ---- one MCP pick ---------------------------------------------------------------------------------------------------

function projectName(ctx)
{
    return path.basename(ctx.project).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function resolveName(pick, row, cur, ctx)
{
    const n = pick.name === undefined ? 'keep' : pick.name;
    if (n === 'keep') return cur ? cur.name : row.name;
    if (n === 'prefixed') return `${projectName(ctx)}-${row.name}`.slice(0, 64);
    return n;
}

// The installed registration's own answers, read back from the entry.
function currentOf(row, reg)
{
    const e = reg.entry;
    return {
        name: reg.name, scope: reg.scope, route: reg.route, entry: e,
        rootStr: row.locations ? E.rootOfEntry(row, e) : null,
        executablePath: flagValue(e.args, '--executable-path'),
        token: Boolean((e.headers && e.headers.Authorization) || (e.args || []).includes('--api-key')),
        host: e.url ? new URL(e.url).hostname : null,
    };
}

function logicalFromWritten(str, scope, ctx)
{
    const root = E.parseRoot(str, ctx);
    if (root.kind !== 'abs') return root;
    const P = E.pathFor(ctx.platform);
    const rel = P.relative(ctx.project, root.path);
    if (rel && !rel.startsWith('..') && !P.isAbsolute(rel)) return { kind: 'project', rel: E.slashes(rel) };
    const homeRel = P.relative(ctx.home, root.path);
    if (homeRel && !homeRel.startsWith('..') && !P.isAbsolute(homeRel)) return { kind: 'home', rel: E.slashes(homeRel) };
    return root;
}

// `copy`: an install beside a registration of the same row at another scope. A row whose data defaults to the account
// folder then defaults to the project folder, so this project's copy has its own data, not the account-wide one's.
function wantedRoot(row, pick, cur, name, scope, ctx, copy = false)
{
    const loc = pick.location || { side: cur ? 'keep' : copy && row.locations.defaultSide === 'account' ? 'project' : 'default' };
    let root;
    let existing = false;
    if (loc.side === 'keep' && cur && cur.rootStr) root = logicalFromWritten(cur.rootStr, cur.scope, ctx);
    else if (loc.side === 'project') root = E.otherPlace(row, name, 'project');
    else if (loc.side === 'account') root = E.otherPlace(row, name, 'account');
    else if (loc.side === 'path') root = E.parseRoot(loc.path, ctx);
    else
    {
        const d = E.defaultRoot(row, name, ctx);
        if (d.needsInput) return { error: d.needsInput };
        root = d.root;
        existing = Boolean(d.existing);
    }
    if (row.locations.windowsAbsolute && ctx.platform === 'win32')
    {
        const resolved = E.formatRoot(root, 'local', ctx);
        const text = resolved.value && resolved.value.replace(/\//g, '\\');
        if (!text || !E.validWindowsSerenaHome(text))
            return { error: `serena's home on Windows must be absolute, in backslashes and space-free (fix row serena-windows-home); '${text || loc.path}' is not` };
        if (scope === 'project') return { error: 'serena on Windows cannot be registered at project scope: its home must be absolute' };
        return { root: { kind: 'abs', path: text }, existing };
    }
    return { root, existing };
}

function planMcp(row, pick, inv, ctx, catalog, out)
{
    if (!row.os.includes(ctx.platform)) return out.errors.push(`${row.id}: not offered on ${ctx.platform}`);
    // configure names its target; an install pick only adds, whatever else of this row is installed
    const here = inv.registrations.filter((r) => r.rowId === row.id && !r.alfredRetired);
    const target = pick.target ? here.find((r) => r.name === pick.target.name && r.scope === pick.target.scope) : null;
    const cur = target ? currentOf(row, target) : null;

    const routeId = pick.route || (cur ? cur.route : row.recommendedRoute);
    const route = row.routes[routeId];
    if (!route) return out.errors.push(`${row.id}: no ${routeId} route (routes: ${Object.keys(row.routes).join(', ')})`);
    const scope = pick.scope || (cur ? cur.scope : asks.recommendedScope(row, routeId));
    if (!SCOPES.includes(scope)) return out.errors.push(`${row.id}: unknown scope '${scope}'`);
    if (scope === 'project' && !route.projectScope)
        return out.errors.push(`${row.id}: the ${routeId} route cannot be registered at project scope (it needs ${routeId === 'local' ? "this machine's paths and runtime" : 'a secret'} that must not sit in the committed .mcp.json)`);
    const bad = inv.unreadable.find((u) => (u.scope === scope) || (scope !== 'project' && ['local', 'user'].includes(u.scope) && ['local', 'user'].includes(scope)));
    if (bad) return out.errors.push(`${row.id}: the ${scope} scope is unreadable (${bad.file} is ${bad.state}); nothing is written there`);

    const name = resolveName(pick, row, cur, ctx);
    // an install pick already there under this name and scope - a re-run, or a tool installed since: never changed here
    const same = !pick.target && here.find((r) => r.name === name && r.scope === scope);
    for (const r of here)
        if (r !== target && r !== same && !ctx.changing.has(keyOf('mcp', r.name, r.scope))) out.notes.push(`${row.id}: also installed as '${r.name}' at ${r.scope} scope - left as it is`);
    if (same)
    {
        out.expect.push({ kind: 'mcp', row: row.id, name, scope, route: same.route });
        return out.unchanged.push(`${row.id}: '${name}' is already installed at ${scope} scope - a change to it is /preferred-tools:configure`);
    }
    const taken = inv.registrations.filter((r) => r.scope === scope);
    const problem = E.nameProblem(name, { catalog, taken, self: cur ? { name: cur.name, scope: cur.scope } : null });
    if (problem) return out.errors.push(`${row.id}: ${problem}`);
    for (const r of inv.registrations)
        if (r.name === name && r.scope !== scope) out.notes.push(`${row.id}: '${name}' also exists at ${r.scope} scope; Claude Code reads local, then project, then user, so the nearer one wins`);

    // the answers that edit an entry
    const params = { host: row.params ? (pick.params && pick.params.host) || (cur && cur.host) || row.params[0].default : undefined, ...(pick.params || {}) };
    const wantToken = pick.token === undefined ? Boolean(cur && cur.token) : Boolean(pick.token);
    const wantExec = pick.executablePath === undefined ? (cur ? cur.executablePath : undefined) : (pick.executablePath || undefined);
    let rootStr;
    let ensure = null;
    if (row.locations)
    {
        const w = wantedRoot(row, pick, cur, name, scope, ctx, !cur && here.length > 0);
        if (w.error) return out.errors.push(`${row.id}: ${w.error}`);
        const f = E.formatRoot(w.root, scope, ctx);
        if (f.error) return out.errors.push(`${row.id}: ${f.error}`);
        rootStr = f.value;
        if (!w.existing) ensure = E.formatRoot(w.root, 'local', ctx).value;
    }

    let entry;
    let fresh = !cur || cur.route !== routeId;
    if (fresh)
        entry = E.buildEntry(row, routeId, { rootStr, scope, executablePath: wantExec, token: wantToken, params }, ctx, catalog.rules);
    else
    {
        entry = JSON.parse(JSON.stringify(cur.entry));
        if (row.locations && rootStr !== cur.rootStr) entry = E.applyRoot(entry, row, rootStr, scope, ctx);
        if (route.optionalArgs && route.optionalArgs.executablePath && wantExec !== cur.executablePath)
        {
            const args = (entry.args || []).slice();
            const i = args.indexOf('--executable-path');
            if (i >= 0) args.splice(i, 2);
            if (wantExec) args.push('--executable-path', wantExec);
            entry.args = args;
        }
        if (route.auth === 'optional-token' && wantToken !== cur.token)
        {
            if (routeId === 'remote') { if (wantToken) entry.headers = { ...route.headers }; else delete entry.headers; }
            else
            {
                const args = (entry.args || []).slice();
                const i = args.indexOf('--api-key');
                if (i >= 0) args.splice(i, 2);
                if (wantToken) args.push(...route.optionalArgs.token);
                entry.args = args;
            }
        }
        if (row.params && cur.host && params.host !== cur.host) entry.url = E.subst(route.url, params);
    }

    if (route.tokenVar)
    {
        const needsVar = route.auth === 'token' || (route.auth === 'optional-token' && wantToken);
        if (needsVar) out.tokens.push({ row: row.id, name, variable: route.tokenVar, set: Boolean(ctx.env[route.tokenVar]) });
    }
    if (route.auth === 'oauth') out.oauth.push({ row: row.id, name, scope });
    if (row.dangerous && row.dangerous.length) out.dangerous.push({ row: row.id, name, tools: row.dangerous });
    out.expect.push({ kind: 'mcp', row: row.id, name, scope, route: routeId });

    // a launch the cache may not hold yet is fetched once it is written (entries.js fetchStep says why); a change that
    // keeps the package, such as a location or a name, fetches nothing
    const fetch = E.fetchStep(name, entry, row.id, cur && cur.entry);
    if (!cur)
    {
        if (ensure) out.steps.push({ op: 'ensure-dir', path: ensure, why: `${row.id}: data folder, with a .gitignore holding * so the project's own .gitignore is never edited` });
        out.steps.push({ op: 'mcp-add', name, scope, entry, row: row.id, why: `${row.id}: add (${routeId})` });
        if (fetch) out.steps.push(fetch);
        return undefined;
    }
    const moved = cur.name !== name || cur.scope !== scope;
    const edited = !deepEqual(entry, cur.entry);
    if (!moved && !edited && !fresh) return out.unchanged.push(`${row.id}: '${name}' at ${scope} scope already as answered`);
    if (row.locations && cur.rootStr && rootStr !== cur.rootStr && E.formatRoot(logicalFromWritten(cur.rootStr, cur.scope, ctx), 'local', ctx).value !== ensure)
        out.notes.push(`${row.id}: the old data stays at ${cur.rootStr}; moving a location moves no data`);
    if (ensure && (!cur.rootStr || rootStr !== cur.rootStr)) out.steps.push({ op: 'ensure-dir', path: ensure, why: `${row.id}: new data folder` });
    if (moved)
        out.steps.push({ op: 'mcp-move', from: { name: cur.name, scope: cur.scope }, to: { name, scope }, entry, old: cur.entry, row: row.id, why: `${row.id}: ${cur.name !== name ? `rename '${cur.name}' to '${name}'` : ''}${cur.name !== name && cur.scope !== scope ? ' and ' : ''}${cur.scope !== scope ? `move from ${cur.scope} to ${scope} scope` : ''} - add first, read back, then remove the old one` });
    else
        out.steps.push({ op: 'mcp-replace', name, scope, entry, old: cur.entry, row: row.id, why: `${row.id}: rewrite '${name}' from the registration as read` });
    if (fetch) out.steps.push(fetch);
    return undefined;
}

// ---- one plugin pick ------------------------------------------------------------------------------------------------

function planPlugin(row, pick, inv, ctx, catalog, out)
{
    if (!row.os.includes(ctx.platform)) return out.errors.push(`${row.id}: not offered on ${ctx.platform}`);
    const id = `${row.plugin}@${row.marketplace.name}`;
    const have = inv.plugins.filter((p) => p.rowId === row.id && !p.alfredRetired);
    const scope = pick.scope || (pick.target ? pick.target.scope : row.recommendedScope);
    // a configure change at another scope is a move: the copy it was picked at goes once the new one reads back. An
    // install pick only adds: a copy at another scope stays.
    const moveFrom = pick.target && scope !== pick.target.scope ? [pick.target.scope] : [];
    if (!SCOPES.includes(scope)) return out.errors.push(`${row.id}: unknown scope '${scope}'`);
    for (const p of have)
        if (p.scope !== scope && !moveFrom.includes(p.scope) && !ctx.changing.has(keyOf('plugin', p.id, p.scope))) out.notes.push(`${row.id}: also installed at ${p.scope} scope - left as it is`);
    if (row.alsoManagedByAlfred && inv.alfredCodeEnabled) out.notes.push(`${row.id}: also managed by alfred-code - a Remove holds only once alfred-code's hand-off has shipped`);
    out.expect.push({ kind: 'plugin', row: row.id, id, scope });

    const known = inv.marketplaces.some((m) => m.name === row.marketplace.name);
    const atScope = have.find((p) => p.scope === scope);
    const marketStep = !known ? { op: 'plugin-marketplace-add', source: row.marketplace.source, name: row.marketplace.name, why: `${row.id}: register the ${row.marketplace.name} marketplace` } : null;
    if (!atScope)
    {
        if (marketStep && !out.steps.some((s) => s.op === marketStep.op && s.source === marketStep.source)) out.steps.push(marketStep);
        out.steps.push({ op: 'plugin-install', id, scope, row: row.id, why: `${row.id}: install at ${scope} scope` });
        for (const from of moveFrom) if (have.some((p) => p.scope === from))
            out.steps.push({ op: 'plugin-uninstall', id, scope: from, row: row.id, why: `${row.id}: remove the ${from}-scope copy after the new one reads back` });
    }
    else if (!atScope.enabled)
        out.steps.push({ op: 'plugin-enable', id, scope, row: row.id, why: `${row.id}: installed but disabled at ${scope} scope - enable it (never install over an installed plugin)` });
    else out.unchanged.push(`${row.id}: ${id} already installed and enabled at ${scope} scope`);
    if (row.settingsRow) out.hud = pick.hudAnswer || 'recommended';
    return undefined;
}

// ---- one configure change: an installed registration or plugin, by its key ------------------------------------------

function planChange(key, pick, inv, ctx, catalog, out)
{
    const t = targetOf(inv, key);
    if (!t) return out.errors.push(`change: nothing is installed as '${key}' (a key is mcp:<name>~<scope> or plugin:<id>~<scope>)`);
    if (!t.item.rowId) return out.errors.push(`change: '${t.item.name || t.item.id}' is your own (it matches no catalog row) - left alone`);
    if (t.item.alfredRetired) return out.errors.push(`change: '${t.item.name || t.item.id}' is alfred-code's (retired) - left alone`);
    const row = catalog.byId.get(t.item.rowId);
    const { row: _row, ...answers } = pick;
    if (t.kind === 'mcp') return planMcp(row, { ...answers, target: { name: t.item.name, scope: t.item.scope } }, inv, ctx, catalog, out);
    return planPlugin(row, { ...answers, target: { scope: t.item.scope } }, inv, ctx, catalog, out);
}

// ---- the plan -------------------------------------------------------------------------------------------------------

function plan(inv, answers, opts = {})
{
    const catalog = opts.catalog || catalogLib.load();
    // answers.machine: what prereq.js found (docker: false picks github's binary fallback); an explicit option wins
    const ctx = { ...makeCtx(inv, { ...opts, machine: opts.machine || answers.machine }), changing: new Set(Object.keys(answers.change || {})) };
    const out = { version: 1, project: inv.project, os: inv.os, steps: [], notes: [], errors: [], unchanged: [], tokens: [], oauth: [], dangerous: [], expect: [], hud: null };

    for (const [rowId, pick] of Object.entries(answers.picks || {}))
    {
        const row = catalog.byId.get(rowId);
        if (!row) { out.errors.push(`unknown tool '${rowId}'`); continue; }
        if (row.kind === 'mcp') planMcp(row, pick || {}, inv, ctx, catalog, out);
        else planPlugin(row, pick || {}, inv, ctx, catalog, out);
    }
    for (const [key, pick] of Object.entries(answers.change || {})) planChange(key, pick || {}, inv, ctx, catalog, out);
    for (const r of answers.remove || []) planRemove(r, inv, out);
    if (out.hud && answers.hud) out.hud = answers.hud;
    // 'defer': a claude-hud that is not installed yet cannot be checked, so its settings ask follows the install
    if (out.hud === 'defer') { out.hud = null; out.hudAfter = true; out.notes.push('claude-hud: its statusLine and recommended settings are asked after the install'); }
    if (out.hud) out.steps.push({ op: 'hud', mode: out.hud, why: `claude-hud: ${out.hud === 'skip' ? 'statusLine only' : out.hud === 'replace' ? 'statusLine plus recommended settings, replacing differing keys' : 'statusLine plus recommended settings, add-only'}` });
    out.noop = out.steps.length === 0 && out.errors.length === 0;
    return out;
}

function planRemove(r, inv, out)
{
    if (r.kind === 'plugin')
    {
        const p = inv.plugins.find((x) => x.id === r.id && x.scope === r.scope);
        if (!p) return out.errors.push(`remove: ${r.id} is not installed at ${r.scope} scope`);
        if (!p.rowId) return out.errors.push(`remove: ${r.id} is not a catalog plugin - left alone`);
        if (p.alfredRetired) return out.errors.push(`remove: ${r.id} belongs to alfred-code - left alone`);
        out.steps.push({ op: 'plugin-uninstall', id: r.id, scope: r.scope, row: p.rowId, why: `remove ${r.id} at ${r.scope} scope` });
        if (inv.alfredCodeEnabled) out.notes.push(`${p.rowId}: alfred-code is enabled and still installs it on its next update - the Remove holds only once alfred-code's hand-off has shipped`);
        return undefined;
    }
    const reg = inv.registrations.find((x) => x.name === r.name && x.scope === r.scope);
    if (!reg) return out.errors.push(`remove: no registration '${r.name}' at ${r.scope} scope`);
    if (reg.own) return out.errors.push(`remove: '${r.name}' is your own server (it matches no catalog row) - left alone`);
    if (reg.alfredRetired) return out.errors.push(`remove: '${r.name}' is alfred-code's (retired) - left alone`);
    out.steps.push({ op: 'mcp-remove', name: r.name, scope: r.scope, old: reg.entry, row: reg.rowId, why: `remove '${r.name}' (${reg.rowId}) at ${r.scope} scope` });
    return undefined;
}

// ---- printing -------------------------------------------------------------------------------------------------------

const shq = (s) => (/^[A-Za-z0-9_\-./:=@,+]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

function argvOf(step)
{
    switch (step.op)
    {
        case 'mcp-add': return ['mcp', 'add-json', step.name, JSON.stringify(step.entry), '-s', step.scope];
        case 'mcp-remove': return ['mcp', 'remove', step.name, '-s', step.scope];
        case 'plugin-marketplace-add': return ['plugin', 'marketplace', 'add', step.source];
        case 'plugin-install': return ['plugin', 'install', step.id, '--scope', step.scope];
        case 'plugin-enable': return ['plugin', 'enable', step.id, '--scope', step.scope];
        case 'plugin-uninstall': return ['plugin', 'uninstall', step.id, '--scope', step.scope];
        default: return null;
    }
}

function render(p)
{
    const lines = [];
    if (p.errors.length) lines.push('Cannot plan:', ...p.errors.map((e) => `  ! ${e}`), '');
    if (!p.steps.length && !p.errors.length) lines.push('Nothing to do: every answer already matches what is installed - no claude call, no file written.');
    p.steps.forEach((s, i) =>
    {
        lines.push(`${i + 1}. ${s.why || s.op}`);
        const argv = argvOf(s);
        if (argv) lines.push(`   claude ${argv.map(shq).join(' ')}`);
        else if (s.op === 'mcp-move') lines.push(`   claude mcp add-json ${shq(s.to.name)} ${shq(JSON.stringify(s.entry))} -s ${s.to.scope}`, '   (read back)', `   claude mcp remove ${shq(s.from.name)} -s ${s.from.scope}`);
        else if (s.op === 'mcp-replace') lines.push(`   claude mcp remove ${shq(s.name)} -s ${s.scope}`, `   claude mcp add-json ${shq(s.name)} ${shq(JSON.stringify(s.entry))} -s ${s.scope}`, `   (the old entry is saved to rollback.json and re-added if the add fails)`);
        else if (s.op === 'ensure-dir') lines.push(`   writes ${s.path}/.gitignore  (contents: *)`);
        else if (s.op === 'fetch') lines.push(`   ${s.argv.map(shq).join(' ')}`, '   (after the apply, in the background: fills the cache only; if it fails the registration stays and the first start tries again)');
        else if (s.op === 'hud') lines.push(`   node scripts/hud-statusline.js ${s.mode === 'replace' ? '--replace' : s.mode === 'skip' ? '--statusline-only' : ''}`.trimEnd());
    });
    if (p.tokens.length) lines.push('', ...p.tokens.map((t) => `Token: ${t.name} reads \${${t.variable}} - ${t.set ? 'set in this shell' : 'NOT set here'}; set it in your shell or in the account settings.json "env". Nothing is written for it.`));
    if (p.oauth.length) lines.push('', `OAuth: run /mcp once in a session to log in to ${p.oauth.map((o) => o.name).join(', ')}.`);
    if (p.dangerous.length) lines.push('', ...p.dangerous.map((d) => `Code-running tool on '${d.name}': ${d.tools.map((t) => `${t.tool} (${t.why})`).join('; ')}. This plugin adds no guard.`));
    if (p.notes.length) lines.push('', ...p.notes.map((n) => `Note: ${n}`));
    if (p.unchanged.length) lines.push('', ...p.unchanged.map((n) => `Unchanged: ${n}`));
    return lines.join('\n');
}

function main(argv)
{
    blockingStdio();
    const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    if (argv[0] === '--questions')
    {
        const inv = read(argv[1]);
        const picks = argv[2] ? read(argv[2]) : null;
        console.log(JSON.stringify(asks.all(inv, picks, catalogLib.load()), null, 2));
        return 0;
    }
    const [invFile, ansFile] = argv;
    if (!invFile || !ansFile) { console.error('usage: plan.js <inventory.json> <answers.json> [--out plan.json]'); return 2; }
    const p = plan(read(invFile), read(ansFile), {});
    const at = argv.indexOf('--out');
    if (at >= 0) fs.writeFileSync(argv[at + 1], JSON.stringify(p, null, 2));
    console.log(render(p));
    return p.errors.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { plan, render, argvOf, currentOf, makeCtx, deepEqual, projectName };
