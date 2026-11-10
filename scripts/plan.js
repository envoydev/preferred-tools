#!/usr/bin/env node
'use strict';
// THE PLAN - answers in, an ordered list of operations out. Nothing here changes anything.
//
//   node plan.js <inventory.json> <answers.json> [--out <plan.json>]     the plan, printed, and written for apply.js
//   node plan.js --questions <inventory.json> [<picks.json>]              every ask the walk makes, as data
//   either takes --data <plugin data dir> after its files: the roots map (spec D2)
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
const keys = require('./keys.js');
const kept = require('./kept.js');
const roots = require('./roots.js');
const { installedOf, keyOf, targetOf, fromHere, otherWindowsMcp } = require('./inventory.js');
const { blockingStdio } = require('./json-file.js');

const SCOPES = ['local', 'project', 'user'];
// the SDK homes appium-sdk-env writes into a local or user registration (scripts/fixes/registration.js)
const APPIUM_SDK_ENV = ['ANDROID_HOME', 'JAVA_HOME'];
const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v)
{
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
}

function makeCtx(inv, opts = {})
{
    const ctx = {
        platform: inv.os, arch: inv.arch, project: inv.project, env: opts.env || process.env,
        home: opts.home || account.homeDir(opts.env || process.env), exists: opts.exists, isDir: opts.isDir, machine: opts.machine || {},
    };
    // alfred-code set up in this project (its .alfred/.gitignore): its folder is recommended for the data (D3)
    ctx.alfredHere = E.alfredData(ctx, inv.alfredCodeEnabled);
    return ctx;
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

// `copy`: an install beside a registration of the same row at another scope (see E.recommendedSide).
function wantedRoot(row, pick, cur, name, scope, ctx, copy = false)
{
    const loc = pick.location || { side: cur ? 'keep' : E.recommendedSideFor(row, name, scope, ctx, { alfredHere: ctx.alfredHere, copy }) };
    const serenaWin = row.locations.windowsAbsolute && ctx.platform === 'win32';
    // serena on Windows at project scope: the committed file names the profile's .serena as ${USERPROFILE}\.serena, the
    // one absolute, space-free folder it can name without a machine path
    if (serenaWin && scope === 'project')
    {
        const d = E.serenaWindowsHome(ctx);
        if (d.needsInput) return { error: `at project scope serena on Windows takes only \${USERPROFILE}\\.serena, and ${d.needsInput}` };
        const profileHome = E.formatRoot({ kind: 'home', rel: '.serena' }, 'local', ctx).value;
        const keeps = loc.side === 'keep' && cur && cur.rootStr && [profileHome.toLowerCase(), '${userprofile}\\.serena'].includes(cur.rootStr.toLowerCase());
        if (!['default', 'account'].includes(loc.side) && !keeps) return { error: 'at project scope serena on Windows takes only ${USERPROFILE}\\.serena - pick the account folder' };
        return { root: { kind: 'home', rel: '.serena' }, existing: false, backslash: true };
    }
    let root;
    let existing = false;
    if (loc.side === 'keep' && cur && cur.rootStr) root = E.logicalRoot(cur.rootStr, ctx);
    else if (loc.side === 'project') root = E.otherPlace(row, name, 'project');
    // serena's account folder on Windows is the profile's .serena (the default branch below)
    else if (loc.side === 'account' && !serenaWin) root = E.otherPlace(row, name, 'account');
    else if (loc.side === 'path') root = E.parseRoot(loc.path, ctx);
    else if (loc.side === 'alfred-data')
    {
        if (!ctx.alfredHere) return { error: 'alfred-code is not set up here (no .alfred/.gitignore) - pick another folder' };
        const problem = E.alfredNameProblem(name, ctx);
        if (problem) return { error: problem };
        root = { kind: 'project', rel: `.alfred/${name}` };
    }
    else if (loc.side === 'alfred')
    {
        // only on the user's pick: the folder is alfred-code's, so deleting it erases this tool's data
        root = E.alfredRoot(row, ctx);
        if (!root) return { error: "no alfred-code data folder for it on disk" };
        existing = true;
    }
    else
    {
        const d = E.defaultRoot(row, name, ctx);
        // serena on Windows with a spaced profile: the space-free folder the question recommends in its place
        if (d.needsInput && !serenaWin) return { error: d.needsInput };
        root = d.needsInput ? E.serenaSpaceFree(ctx) : d.root;
        existing = Boolean(d.existing);
    }
    if (row.locations.windowsAbsolute && ctx.platform === 'win32')
    {
        const resolved = E.formatRoot(root, 'local', ctx);
        const text = resolved.value && resolved.value.replace(/\//g, '\\');
        if (!text || !E.validWindowsSerenaHome(text))
            return { error: `serena's home on Windows must be absolute, in backslashes and space-free (fix row serena-windows-home); '${text || loc.path}' is not` };
        return { root: { kind: 'abs', path: text }, existing };
    }
    // project scope writes a relative folder, which lands wherever Claude starts: only for a row proven to follow it (a
    // pick with no location is never here - its recommended side there is the account folder)
    if (scope === 'project' && root.kind === 'project' && row.locations.relative !== true)
        return { error: 'project scope writes a folder relative to where Claude starts, which this tool is not proven to follow (locations.relative) - pick the account folder' };
    return { root, existing };
}

function planMcp(row, pick, inv, ctx, catalog, out)
{
    if (!row.os.includes(ctx.platform)) return out.errors.push(`${row.id}: not offered on ${ctx.platform}`);
    // configure names its target; an install pick only adds, whatever else of this row is installed
    const here = inv.registrations.filter((r) => r.rowId === row.id && !r.alfredRetired);
    const target = pick.target ? here.find((r) => r.name === pick.target.name && r.scope === pick.target.scope) : null;
    const cur = target ? E.currentOf(row, target) : null;

    const routeId = pick.route || (cur ? cur.route : row.recommendedRoute);
    const route = row.routes[routeId];
    if (!route) return out.errors.push(`${row.id}: no ${routeId} route (routes: ${Object.keys(row.routes).join(', ')})`);
    // a fresh pick's defaults follow where its key is (names only, never a value): the scope that can read it, and the key sent
    const keyState = cur ? null : asks.keyStateOf(row, routeId, ctx, inv.alfredCodeEnabled);
    const scope = pick.scope || (cur ? cur.scope : asks.recommendedScope(row, routeId, keyState));
    if (!SCOPES.includes(scope)) return out.errors.push(`${row.id}: unknown scope '${scope}'`);
    const bad = inv.unreadable.find((u) => (u.scope === scope) || (scope !== 'project' && ['local', 'user'].includes(u.scope) && ['local', 'user'].includes(scope)));
    if (bad) return out.errors.push(`${row.id}: the ${scope} scope is unreadable (${bad.file} is ${bad.state}); nothing is written there`);

    const name = resolveName(pick, row, cur, ctx);
    // an install pick already there under this name and scope - a re-run, or a tool installed since: never changed here
    const same = !pick.target && here.find((r) => r.name === name && r.scope === scope);
    for (const r of here)
    {
        if (r === target || r === same || ctx.changing.has(keyOf('mcp', r.name, r.scope))) continue;
        if (r.scope !== 'inherited') out.notes.push(`${row.id}: also installed as '${r.name}' at ${r.scope} scope - left as it is`);
        else if (r.name !== name) out.notes.push(`${row.id}: also inherited as '${r.name}' from ${fromHere(inv, r.from)} (${r.approval}) - change it there`);
    }
    if (same)
    {
        out.expect.push({ kind: 'mcp', row: row.id, name, scope, route: same.route });
        return out.unchanged.push(`${row.id}: '${name}' is already installed at ${scope} scope - a change to it is /preferred-tools:configure`);
    }
    const taken = inv.registrations.filter((r) => r.scope === scope);
    const problem = E.nameProblem(name, { catalog, taken, self: cur ? { name: cur.name, scope: cur.scope } : null });
    if (problem) return out.errors.push(`${row.id}: ${problem}`);
    // windows-mcp 0.8.8 makes one missed overlay confirmation permanent; another session cannot be seen, so it is named
    if (row.id === 'windows-control' && !target)
    {
        const others = otherWindowsMcp(inv, name);
        out.notes.push(`windows-control: keep one windows-mcp per Windows desktop - another Claude Code session with it open${others.length ? `, or ${others.join(', ')},` : ''} can leave its tools unavailable until a new session starts it again`);
    }
    for (const r of inv.registrations)
    {
        if (r.name !== name || r.scope === scope) continue;
        // a parent's copy ranks as project scope, below this project's local and project ones, above user (M2, M3)
        if (r.scope === 'inherited')
        {
            if (r.shadowed && r.shadowed.scope === 'inherited') continue;
            const from = fromHere(inv, r.from);
            out.notes.push(`${row.id}: '${name}' is also inherited from ${from} (${r.approval}); Claude Code uses ${scope === 'user' ? `the inherited one from ${from} in this project - a .mcp.json server ranks above user scope` : `this project's ${scope} copy`}`);
        }
        else out.notes.push(`${row.id}: '${name}' also exists at ${r.scope} scope; Claude Code reads local, then project, then user, so the nearer one wins`);
    }

    // the answers that edit an entry
    const params = { host: row.params ? (pick.params && pick.params.host) || (cur && cur.host) || row.params[0].default : undefined, ...(pick.params || {}) };
    const wantToken = pick.token === undefined ? (cur ? Boolean(cur.token) : route.auth === 'optional-token' && asks.keyToSend(keyState, scope)) : Boolean(pick.token);
    if (pick.token === undefined && !cur && route.auth === 'optional-token' && scope === 'project' && keyState && keyState.file && !keyState.set)
        out.notes.push(`${row.id}: no API key sent - ${route.tokenVar} is not set in this shell and project scope reads only the environment Claude Code starts with; the key in ${keyState.file} reaches it at local or user scope`);
    let wantExec = pick.executablePath === undefined ? (cur ? cur.executablePath : undefined) : (pick.executablePath || undefined);
    // the committed .mcp.json carries no machine path: a binary named there is refused, one a move carries is left out
    if (scope === 'project' && E.machinePath(wantExec))
    {
        if (pick.executablePath !== undefined) return out.errors.push(`${row.id}: --executable-path ${wantExec} is a machine path, which the committed .mcp.json must not carry - use the engine's default, a \${VAR} path, or local scope`);
        out.notes.push(`${row.id}: --executable-path ${wantExec} is left out - a machine path the committed .mcp.json must not carry; the engine's default browser runs`);
        wantExec = undefined;
    }
    let rootStr;
    let ensure = null;
    if (row.locations)
    {
        const w = wantedRoot(row, pick, cur, name, scope, ctx, !cur && here.length > 0);
        if (w.error) return out.errors.push(`${row.id}: ${w.error}`);
        const f = E.formatRoot(w.root, scope, ctx, { backslash: w.backslash });
        if (f.error) return out.errors.push(`${row.id}: ${f.error}`);
        rootStr = f.value;
        if (!w.existing) ensure = E.formatRoot(w.root, 'local', ctx).value;
        // a relative folder in the committed file lands wherever Claude starts; the plan creates and ignores only this one
        if (scope === 'project' && w.root.kind === 'project')
        {
            out.notes.push(`${row.id}: a session started in another folder - a child or a subfolder - creates ${rootStr} there; run /preferred-tools:fix once in each such folder where alfred-code's .alfred/.gitignore does not cover it`);
            // the ensure step's .gitignore holds * and so ignores itself: only alfred-code's .alfred/.gitignore is committed
            const rel = w.root.rel.replace(/\\/g, '/');
            if (!(rel.startsWith('.alfred/') && ctx.alfredHere))
            {
                const line = rel.startsWith('.preferred-tools/') ? '.preferred-tools/' : `${rel}/`;
                out.notes.push(`${row.id}: another clone of this project creates ${rootStr} unignored - its .gitignore holds * and is never committed: add ${line} to the project's .gitignore, or run /preferred-tools:fix there`);
            }
        }
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

    // .mcp.json is committed: a move into it never carries a credential the route's own token field does not take - a
    // header of the user's own, a userinfo URL (D7); the token field itself becomes ${VAR} at apply (keys.js)
    if (scope === 'project' && cur && cur.scope !== 'project')
    {
        const own = new Set(keys.tokenFields(entry, route).map((f) => f.at.join('.')));
        const held = kept.credentialPaths(entry, row).filter((p) => !own.has(p));
        if (held.length) return out.errors.push(`${row.id}: '${cur.name}' holds a credential in ${held.join(', ')}, which the committed .mcp.json must not carry - keep it at ${cur.scope} scope, or put a \${VAR} there first`);
        // nor a machine path: appium's SDK homes (appium-sdk-env writes them in at local and user scope) are read from
        // the environment Claude Code starts with there; any other is the user's to replace
        const env = { ...(entry.env || {}) };
        const dropped = (row.id === 'appium' ? APPIUM_SDK_ENV : []).filter((k) => E.machinePath(env[k]));
        for (const k of dropped) delete env[k];
        const machine = Object.keys(env).filter((k) => E.machinePath(env[k]));
        if (machine.length) return out.errors.push(`${row.id}: '${cur.name}' holds a machine path in ${machine.map((k) => `env.${k}`).join(', ')}, which the committed .mcp.json must not carry - keep it at ${cur.scope} scope, or put a \${VAR} there first`);
        if (dropped.length)
        {
            entry.env = env;
            const many = dropped.length > 1;
            out.notes.push(`${row.id}: ${dropped.join(' and ')} ${many ? 'are' : 'is'} left out - machine paths the committed .mcp.json must not carry; there the server reads ${many ? 'them' : 'it'} from the environment Claude Code starts with (/preferred-tools:fix appium-sdk-env checks it)`);
        }
    }

    // the key: at project scope the ${VAR} stays for each session's environment; at local and user scope apply.js writes
    // it in from the key file the scope reads (keys.js), and a plan naming the project's own file first makes it ignored
    if (route.tokenVar)
    {
        const needsVar = route.auth === 'token' || (route.auth === 'optional-token' && wantToken);
        const files = needsVar ? keys.filesFor(ctx.project, scope, { env: { ...ctx.env, HOME: ctx.home, USERPROFILE: ctx.home }, alfredEnabled: inv.alfredCodeEnabled }) : [];
        if (needsVar)
        {
            const word = row.id.toUpperCase().replace(/-/g, '_');
            const seen = keys.presence(ctx.project, scope, [{ name: route.tokenVar, word }], { env: { ...ctx.env, HOME: ctx.home, USERPROFILE: ctx.home }, alfredEnabled: inv.alfredCodeEnabled, home: ctx.home });
            // the line names the files the key was looked for in - with alfred-code's engine, its chain up the parent folders
            out.tokens.push({ row: row.id, name, variable: route.tokenVar, scope, set: Boolean(ctx.env[route.tokenVar]), files: seen.files, found: seen.found[route.tokenVar], near: seen.near[route.tokenVar] });
        }
        const ignore = path.join(ctx.project, '.preferred-tools');
        if (files.includes(keys.projectFile(ctx.project)) && !(ctx.exists || fs.existsSync)(path.join(ignore, '.gitignore')) && !out.steps.some((s) => s.op === 'ensure-ignore'))
            out.steps.unshift({ op: 'ensure-ignore', path: ignore, why: 'key file: .preferred-tools/.gitignore holding *, so the .secrets beside it is never committed' });
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
        out.steps.push({ op: 'mcp-add', name, scope, entry, row: row.id, route: routeId, why: `${row.id}: add (${routeId}) at ${scope} scope` });
        if (fetch) out.steps.push(fetch);
        return undefined;
    }
    const moved = cur.name !== name || cur.scope !== scope;
    const edited = !deepEqual(entry, cur.entry);
    if (!moved && !edited && !fresh) return out.unchanged.push(`${row.id}: '${name}' at ${scope} scope already as answered`);
    if (row.locations && cur.rootStr && rootStr !== cur.rootStr && E.formatRoot(E.logicalRoot(cur.rootStr, ctx), 'local', ctx).value !== ensure)
        out.notes.push(`${row.id}: the old data stays at ${cur.rootStr}; moving a location moves no data`);
    if (ensure && (!cur.rootStr || rootStr !== cur.rootStr)) out.steps.push({ op: 'ensure-dir', path: ensure, why: `${row.id}: new data folder` });
    if (moved)
        out.steps.push({ op: 'mcp-move', from: { name: cur.name, scope: cur.scope }, to: { name, scope }, entry, old: cur.entry, row: row.id, route: routeId, why: `${row.id}: ${cur.name !== name ? `rename '${cur.name}' to '${name}'` : ''}${cur.name !== name && cur.scope !== scope ? ' and ' : ''}${cur.scope !== scope ? `move from ${cur.scope} to ${scope} scope` : ''} - add first, read back, then remove the old one` });
    else
        out.steps.push({ op: 'mcp-replace', name, scope, entry, old: cur.entry, row: row.id, route: routeId, why: `${row.id}: rewrite '${name}' from the registration as read` });
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
    if (row.alsoManagedByAlfred && inv.alfredCodeEnabled) out.notes.push(`${row.id}: alfred-code installs it too - its update may add it back after a Remove`);
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

// ---- the root folders (spec D2) -------------------------------------------------------------------------------------
// answers.roots: { project: { id, path? }, global: { id, path? } } - an option id from the root question, `path` the
// folder typed for 'named'. No answer: the family's recommended root (D2's first option). -> { project, global,
// globalNamed } as absolute paths; a bad answer is a plan error with its reason.
function resolveRoots(inv, answers, ctx, errors)
{
    const out = {};
    for (const family of ['project', 'global'])
    {
        const a = (answers && answers[family]) || null;
        const opts = roots.options(inv, family, ctx);
        if (!a || !a.id) { out[family] = opts[0].root; continue; }
        if (a.id === 'named')
        {
            const r = roots.resolveNamed(family, a.path, ctx);
            if (r.error) errors.push(`roots: ${r.error}`);
            out[family] = r.root || null;
            continue;
        }
        const o = opts.find((x) => x.id === a.id && x.root);
        if (!o) { errors.push(`roots: '${a.id}' is not a ${family} root offered here (${opts.filter((x) => x.root).map((x) => x.id).join(', ')}, or named with a path)`); out[family] = null; continue; }
        out[family] = o.root;
    }
    out.globalNamed = Boolean(out.global) && !roots.standard('global', ctx).some((x) => x.root === out.global);
    return out;
}

// ---- the plan -------------------------------------------------------------------------------------------------------

function plan(inv, answers, opts = {})
{
    const catalog = opts.catalog || catalogLib.load();
    // answers.machine: what prereq.js found (docker: false picks github's binary fallback); an explicit option wins
    const ctx = { ...makeCtx(inv, { ...opts, machine: opts.machine || answers.machine }), changing: new Set(Object.keys(answers.change || {})) };
    const out = { version: 1, project: inv.project, os: inv.os, alfredCodeEnabled: Boolean(inv.alfredCodeEnabled), steps: [], notes: [], errors: [], unchanged: [], tokens: [], oauth: [], dangerous: [], expect: [], hud: null };
    ctx.roots = resolveRoots(inv, answers.roots, { ...ctx, catalog }, out.errors);
    out.roots = ctx.roots;

    for (const [rowId, pick] of Object.entries(answers.picks || {}))
    {
        const row = catalog.byId.get(rowId);
        if (!row) { out.errors.push(`unknown tool '${rowId}'`); continue; }
        if (row.kind === 'mcp') planMcp(row, pick || {}, inv, ctx, catalog, out);
        else planPlugin(row, pick || {}, inv, ctx, catalog, out);
    }
    for (const [key, pick] of Object.entries(answers.change || {})) planChange(key, pick || {}, inv, ctx, catalog, out);
    for (const r of answers.remove || []) planRemove(r, inv, catalog, out);
    if (out.hud && answers.hud) out.hud = answers.hud;
    // 'defer': a claude-hud that is not installed yet cannot be checked, so its settings ask follows the install
    if (out.hud === 'defer') { out.hud = null; out.hudAfter = true; out.notes.push('claude-hud: its statusLine and recommended settings are asked after the install'); }
    if (out.hud) out.steps.push({ op: 'hud', mode: out.hud, why: `claude-hud: ${out.hud === 'skip' ? 'statusLine only' : out.hud === 'replace' ? 'statusLine plus recommended settings, replacing differing keys' : 'statusLine plus recommended settings, add-only'}` });
    out.noop = out.steps.length === 0 && out.errors.length === 0;
    return out;
}

function planRemove(r, inv, catalog, out)
{
    if (r.kind === 'plugin')
    {
        const p = inv.plugins.find((x) => x.id === r.id && x.scope === r.scope);
        if (!p) return out.errors.push(`remove: ${r.id} is not installed at ${r.scope} scope`);
        if (!p.rowId) return out.errors.push(`remove: ${r.id} is not a catalog plugin - left alone`);
        if (p.alfredRetired) return out.errors.push(`remove: ${r.id} belongs to alfred-code - left alone`);
        out.steps.push({ op: 'plugin-uninstall', id: r.id, scope: r.scope, row: p.rowId, why: `remove ${r.id} at ${r.scope} scope` });
        if (inv.alfredCodeEnabled && catalog.byId.get(p.rowId).alsoManagedByAlfred) out.notes.push(`${p.rowId}: alfred-code installs it too - its next update may add it back`);
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

// The plan's line for one key: where the registration reads it, where its name is (never a value), and - at project
// scope, which reads only the environment Claude Code starts with - what serves the children of a workspace.
function tokenLine(t)
{
    const parts = [];
    if (t.scope === 'project')
    {
        parts.push(`Token: ${t.name} reads \${${t.variable}} from the environment Claude Code starts with - ${t.set ? 'set in this shell.' : 'NOT set in this shell.'}`);
        if (t.set) parts.push('A Claude Code started from the dock or an IDE may not have it - the account settings.json "env" reaches every start.');
        else
        {
            parts.push(t.found ? `Its name is in ${t.found}, which project scope does not read.` : `It is in none of the key files local scope would read either${(t.files || []).length ? `: ${t.files.join(', ')}` : ''}.`);
            parts.push(`Choose local scope, which writes the key in from a key file but serves only this folder (a child that is its own project does not see it - install it there too); or user scope, which serves every project; or set ${t.variable} in the account settings.json "env" and keep one project-scope entry for the whole workspace.`);
        }
    }
    else
    {
        parts.push(`Token: ${t.name} (${t.scope} scope) - the apply writes ${t.variable} into the registration from ${(t.files || []).join(', then ')}; a key in none of them stays \${${t.variable}}. The key is never printed.`);
        parts.push(t.found ? `Found in ${t.found}.` : 'In none of them.');
    }
    if (!t.found && !t.set) for (const n of t.near || []) parts.push(`${n.file} holds ${n.name}, not ${t.variable}: add the key under ${t.variable}.`);
    return parts.join(' ');
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
        else if (s.op === 'ensure-dir' || s.op === 'ensure-ignore') lines.push(`   writes ${s.path}/.gitignore  (contents: *)`);
        else if (s.op === 'fetch') lines.push(`   ${s.argv.map(shq).join(' ')}`, '   (after the apply, in the background: fills the cache only; if it fails the registration stays and the first start tries again)');
        else if (s.op === 'hud') lines.push(`   node scripts/hud-statusline.js ${s.mode === 'replace' ? '--replace' : s.mode === 'skip' ? '--statusline-only' : ''}`.trimEnd());
    });
    if (p.tokens.length) lines.push('', ...p.tokens.map(tokenLine));
    if (p.oauth.length) lines.push('', `OAuth: run /mcp once in a session to log in to ${p.oauth.map((o) => o.name).join(', ')}.`);
    if (p.dangerous.length) lines.push('', ...p.dangerous.map((d) => `Code-running tool on '${d.name}': ${d.tools.map((t) => `${t.tool} (${t.why})`).join('; ')}. This plugin adds no guard.`));
    if (p.notes.length) lines.push('', ...p.notes.map((n) => `Note: ${n}`));
    if (p.unchanged.length) lines.push('', ...p.unchanged.map((n) => `Unchanged: ${n}`));
    return globalWords(lines.join('\n'));
}

// The prose says Global for user scope (spec D1): 'global (user scope)' the first time, 'global scope' after. The commands
// keep the value (`-s user`, `--scope user`).
function globalWords(text)
{
    let first = true;
    return text.replace(/\buser scope\b/g, () => { if (!first) return 'global scope'; first = false; return 'global (user scope)'; });
}

// The arguments, by flag: `--questions` first or not at all, then at most two files, and the flags anywhere after them.
// An unknown flag, or a flag without its value, is an error - never read as a file.
const VALUE_FLAGS = { '--data': 'data', '--connectors': 'connectors', '--out': 'out' };
function parseArgs(argv)
{
    const out = { questions: argv[0] === '--questions', files: [], data: null, connectors: null, out: null, error: null };
    for (let i = out.questions ? 1 : 0; i < argv.length; i++)
    {
        const a = argv[i];
        if (Object.hasOwn(VALUE_FLAGS, a))
        {
            if (i + 1 >= argv.length) return { ...out, error: `${a} needs a value` };
            out[VALUE_FLAGS[a]] = argv[++i];
        }
        else if (a.startsWith('--')) return { ...out, error: `unknown flag '${a}'` };
        else out.files.push(a);
    }
    if (out.files.length > 2) return { ...out, error: `one inventory file and one ${out.questions ? 'picks' : 'answers'} file, not ${out.files.length} files` };
    return out;
}

const USAGE = 'usage: plan.js <inventory.json> <answers.json> [--out plan.json] [--data <dir>]\n       plan.js --questions <inventory.json> [<picks.json>] [--data <dir>] [--connectors <Name>,<Name>]';

function main(argv)
{
    blockingStdio();
    const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    const args = parseArgs(argv);
    if (args.error) { console.error(`plan.js: ${args.error}\n${USAGE}`); return 2; }
    const [invFile, second] = args.files;
    if (!invFile || (!args.questions && !second)) { console.error(USAGE); return 2; }
    const inv = read(invFile);
    // the roots map is read fresh from the plugin's data folder when one is given
    if (args.data !== null) inv.roots = { ...(inv.roots || {}), map: roots.readMap(args.data) };
    if (args.questions)
    {
        const picks = second ? read(second) : null;
        console.log(JSON.stringify(asks.all(inv, picks, catalogLib.load(), { env: process.env, home: account.homeDir(process.env), connectors: args.connectors }), null, 2));
        return 0;
    }
    const p = plan(inv, read(second), {});
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(p, null, 2));
    console.log(render(p));
    return p.errors.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { plan, render, argvOf, makeCtx, deepEqual, projectName, main, parseArgs, resolveRoots, globalWords };
