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
const existing = require('./existing.js');
const { installedOf, keyOf, targetOf, fromHere, otherWindowsMcp } = require('./inventory.js');
const { blockingStdio } = require('./json-file.js');

const SCOPES = ['local', 'project', 'user'];
// the SDK homes appium-sdk-env writes into a local or user registration (scripts/fixes/registration.js)
const { APPIUM_SDK_ENV } = E;
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
    // a live registration, read in this process for a key comparison (R1) - only from an account the caller's env names
    ctx.readLive = opts.readLive || asks.liveReader(inv.project, opts.env);
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

// `copy`: an install beside a registration of the same row at another scope (see E.recommendedSide). A data folder is
// `<root>/<name>` in the root of the scope's family (spec D2): side 'project' - the project root, 'account' - the global
// root; 'default' is the recommended side (serena on Windows: its profile's .serena, or a space-free folder).
function wantedRoot(row, pick, cur, name, scope, ctx, copy = false)
{
    const serenaWin = row.locations.windowsAbsolute && ctx.platform === 'win32';
    let loc = pick.location || { side: cur ? 'keep' : E.recommendedSide(row, scope, ctx, { copy }) };
    if (loc.side === 'default' && !serenaWin) loc = { side: E.recommendedSide(row, scope, ctx, { copy }) };
    // an .alfred project root holds alfred-code's own entries: a registration of this family is never given a name
    // that is one (a registration already under that name keeps it)
    const P = E.pathFor(ctx.platform);
    if (scope !== 'user' && !(cur && cur.name === name) && ctx.roots && ctx.roots.project === P.join(ctx.project, '.alfred'))
    {
        const problem = E.alfredNameProblem(name, ctx);
        if (problem) return { error: problem };
    }
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
    else if (loc.side === 'project') root = E.otherPlace(row, name, 'project', ctx);
    else if (loc.side === 'account') root = E.otherPlace(row, name, 'account', ctx);
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
    // a fresh pick's scope follows where its key is (names only, never a value): read at global scope, as the scope
    // question is asked before the key (spec D5, D8)
    const scope = pick.scope || (cur ? cur.scope : asks.recommendedScope(row, routeId, asks.keyStateOf(row, routeId, ctx, inv.alfredCodeEnabled, 'user')));
    if (!SCOPES.includes(scope)) return out.errors.push(`${row.id}: unknown scope '${scope}'`);
    // a stdio route that needs a key holds it written in, which the committed .mcp.json never carries (spec D5); a
    // registration already there is configure's to keep
    if (scope === 'project' && routeId !== 'remote' && route.auth === 'token' && !(cur && cur.scope === 'project'))
        return out.errors.push(`${row.id}: its local route needs a key written into the registration, so it is not offered at project scope - the committed .mcp.json carries no key; pick local or global scope, or the hosted route`);
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
    // an optional key: sent when picked, else when a name D9 offers is filled in the chain the scope reads; a stdio route
    // at project scope runs keyless (spec D5)
    const keyless = scope === 'project' && routeId !== 'remote' && route.auth === 'optional-token';
    if (keyless && pick.token) return out.errors.push(`${row.id}: its local route runs keyless at project scope - the committed .mcp.json carries no key; pick local or global scope for a key, or the hosted route`);
    let wantToken = pick.token === undefined ? (cur ? Boolean(cur.token) : route.auth === 'optional-token' && asks.keyToSend(asks.keyStateOf(row, routeId, ctx, inv.alfredCodeEnabled, scope))) : Boolean(pick.token);
    if (keyless && wantToken)
    {
        out.notes.push(`${row.id}: --api-key is left out - its local route runs keyless at project scope`);
        wantToken = false;
    }
    // the key's name (spec D9): answered, else the name the registration uses - the helper's argument, or for a stdio key
    // the name whose value equals the key it holds, read from the live registration in this process (R1) - else the
    // catalog's
    const keyVar = route.helper ? route.helper.var : route.tokenVar;
    if (pick.keyName !== undefined && !keys.NAME_RULE.test(String(pick.keyName))) return out.errors.push(`${row.id}: '${pick.keyName}' is not a key name - a name matches ${keys.NAME_RULE.source}`);
    const usesKey = Boolean(keyVar) && (route.auth === 'token' || (route.auth === 'optional-token' && wantToken));
    const ks = usesKey ? asks.keyStateOf(row, routeId, ctx, inv.alfredCodeEnabled, scope) : null;
    const sameRoute = Boolean(cur) && cur.route === routeId;
    const liveKey = sameRoute && ks && ks.kind === 'stdio' ? asks.heldKey(ctx.readLive(cur.name, cur.scope) || {}, route) : null;
    const keyName = pick.keyName || (sameRoute && route.helper ? cur.keyName : null) || (liveKey ? keys.nameOfValue([...ks.files, ...keys.oldFiles(ctx.project, ctx.home)], liveKey) : null) || keyVar;
    // the server's settings (spec D9): pairs merged into a stdio route's env - never a key, and no machine path in the
    // committed file
    if (pick.settings)
    {
        if (routeId === 'remote') return out.errors.push(`${row.id}: a hosted route takes no settings - its options are its route and host`);
        for (const [k, v] of Object.entries(pick.settings))
        {
            if (!keys.NAME_RULE.test(k)) return out.errors.push(`${row.id}: '${k}' is not a setting name - a name matches ${keys.NAME_RULE.source}`);
            if (keys.credentialName(k)) return out.errors.push(`${row.id}: ${k} looks like a key - keep a key in .mcps-secrets and pick it as the key's name`);
            if (scope === 'project' && E.machinePath(String(v))) return out.errors.push(`${row.id}: ${k} - the committed .mcp.json takes no machine path - use \${VAR}`);
        }
    }
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
    let dataAbs = null;
    if (row.locations)
    {
        const w = wantedRoot(row, pick, cur, name, scope, ctx, !cur && here.length > 0);
        if (w.error) return out.errors.push(`${row.id}: ${w.error}`);
        const f = E.formatRoot(w.root, scope, ctx, { backslash: w.backslash });
        if (f.error) return out.errors.push(`${row.id}: ${f.error}`);
        rootStr = f.value;
        dataAbs = E.formatRoot(w.root, 'local', ctx).value;
        if (!w.existing) ensure = dataAbs;
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
        entry = E.buildEntry(row, routeId, { rootStr, scope, executablePath: wantExec, token: wantToken, keyName, params }, ctx, catalog.rules);
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
        if (routeId === 'remote' && route.helper)
        {
            // the helper follows the scope and its root, under the name it passes now; an Authorization header of the
            // 0.1.x kind is fix's to move (key-to-helper, spec D7), never dropped here while a key is wanted
            const header = Boolean(entry.headers && entry.headers.Authorization);
            if (!wantToken)
            {
                delete entry.headersHelper;
                if (header) { delete entry.headers.Authorization; if (!Object.keys(entry.headers).length) delete entry.headers; }
            }
            else if (header) out.notes.push(`${row.id}: '${cur.name}' sends its key from an Authorization header - /preferred-tools:fix moves it into .mcps-secrets, read by mcp-headers.js (key-to-helper)`);
            else entry.headersHelper = E.helperFor(route, scope, ctx, keyName);
        }
        else if (route.auth === 'optional-token' && wantToken !== cur.token)
        {
            const args = (entry.args || []).slice();
            const i = args.indexOf('--api-key');
            if (i >= 0) args.splice(i, 2);
            if (wantToken) args.push(...route.optionalArgs.token);
            entry.args = args;
        }
        if (row.params && cur.host && params.host !== cur.host) entry.url = E.subst(route.url, params);
    }

    if (pick.settings) entry = E.mergeSettings(entry, route, pick.settings);

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

    // the key (spec D3-D5): a hosted route's helper reads the hosted chain each time Claude Code connects, a stdio route's
    // key is written in by the apply from the stdio chain. The line names the files, never a value; a name found only in
    // a file 0.1.x read names that file.
    const keyed = ks && !(entry.headers && entry.headers.Authorization) ? ks : null;
    let keyFile = null;
    if (keyed && !(keyed.kind === 'stdio' && scope === 'project'))
    {
        const filled = keys.filledNames(keyed.files).some((f) => f.names.includes(keyName));
        out.keys.push({ row: row.id, name, scope, variable: keyName, kind: keyed.kind, files: keyed.files, filled, old: filled ? null : keys.oldHolding(ctx.project, ctx.home, keyName) });
        // a name filled nowhere in the chain is written, empty, into the chain's first file (D3)
        if (!filled) keyFile = keyed.files[0];
    }
    // a stdio key at local or global scope: the apply writes it in from the stdio chain under the key's name (R7); configure
    // rewrites a registration whose key differs from the chosen name's filled value, even when nothing else changed
    const stepKey = keyed && keyed.kind === 'stdio' && scope !== 'project' ? { name: keyName, files: keyed.files } : null;
    const chosen = stepKey && cur ? keys.valueIn(stepKey.files, keyName) : null;
    const staleKey = Boolean(chosen) && chosen.value !== liveKey;
    const withKey = stepKey ? { key: stepKey } : {};
    // the helper's own conditions (spec D4): the folder's trust at project and local scope, the declaring folder only at
    // project scope, node on the PATH - each said once
    if (keyed && keyed.kind === 'helper')
    {
        const once = (text) => { if (!out.notes.includes(text)) out.notes.push(text); };
        if (scope !== 'user' && inv.trusted === false) once(`accept the trust dialog the next time Claude Code starts in ${ctx.project} - until then the server connects without its key`);
        if (scope === 'project') out.notes.push(`${row.id}: a session started in a subfolder or a child project does not get this key - install it there too, or at global scope`);
        once('node must be on the PATH Claude Code starts with - mcp-headers.js runs under it, as this plugin\'s commands do');
    }
    if (route.auth === 'oauth' || (route.noKey === 'oauth' && !wantToken)) out.oauth.push({ row: row.id, name, scope });
    if (row.dangerous && row.dangerous.length) out.dangerous.push({ row: row.id, name, tools: row.dangerous });
    out.expect.push({ kind: 'mcp', row: row.id, name, scope, route: routeId });

    // a launch the cache may not hold yet is fetched once it is written (entries.js fetchStep says why); a change that
    // keeps the package, such as a location or a name, fetches nothing
    const fetch = E.fetchStep(name, entry, row.id, cur && cur.entry);
    const uses = { helper: Boolean(entry.headersHelper), keyFile, keyName, data: dataAbs };
    if (!cur)
    {
        useRoots(ctx, scope, uses);
        if (ensure) out.steps.push({ op: 'ensure-dir', path: ensure, why: `${row.id}: data folder, with a .gitignore holding * so the project's own .gitignore is never edited` });
        out.steps.push({ op: 'mcp-add', name, scope, entry, row: row.id, route: routeId, ...withKey, why: `${row.id}: add (${routeId}) at ${scope} scope` });
        if (fetch) out.steps.push(fetch);
        return undefined;
    }
    const moved = cur.name !== name || cur.scope !== scope;
    const edited = !deepEqual(entry, cur.entry);
    if (!moved && !edited && !fresh && !staleKey) return out.unchanged.push(`${row.id}: '${name}' at ${scope} scope already as answered`);
    useRoots(ctx, scope, uses);
    if (row.locations && cur.rootStr && rootStr !== cur.rootStr && E.formatRoot(E.logicalRoot(cur.rootStr, ctx), 'local', ctx).value !== ensure)
        out.notes.push(`${row.id}: the old data stays at ${cur.rootStr}; moving a location moves no data`);
    if (ensure && (!cur.rootStr || rootStr !== cur.rootStr)) out.steps.push({ op: 'ensure-dir', path: ensure, why: `${row.id}: new data folder` });
    if (moved)
        out.steps.push({ op: 'mcp-move', from: { name: cur.name, scope: cur.scope }, to: { name, scope }, entry, old: cur.entry, row: row.id, route: routeId, ...withKey, why: `${row.id}: ${cur.name !== name ? `rename '${cur.name}' to '${name}'` : ''}${cur.name !== name && cur.scope !== scope ? ' and ' : ''}${cur.scope !== scope ? `move from ${cur.scope} to ${scope} scope` : ''} - add first, read back, then remove the old one` });
    else
        out.steps.push({ op: 'mcp-replace', name, scope, entry, old: cur.entry, row: row.id, route: routeId, ...withKey, why: `${row.id}: rewrite '${name}' from the registration as read${staleKey && !edited && !fresh ? ` - writes in the key ${keyName} holds in ${chosen.file}` : ''}` });
    if (fetch) out.steps.push(fetch);
    return undefined;
}

// The roots a registration step writes into (spec D2-D4): its helper's - the scope's family root - its key file's and its
// data folder's. Only a step that is planned uses a root, so a plan with no change writes no file.
function useRoots(ctx, scope, { helper, keyFile, keyName, data })
{
    const P = E.pathFor(ctx.platform);
    const r = ctx.roots || {};
    const inside = (root, p) => { if (!root || !p) return false; const rel = P.relative(root, p); return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel)); };
    const familyOf = (p) => ['project', 'global'].find((f) => inside(r[f], p)) || null;
    const family = roots.familyOf(scope);
    if (helper && r[family]) ctx.uses.push({ family, root: r[family], helper: true });
    const kf = familyOf(keyFile);
    if (kf) ctx.uses.push({ family: kf, root: r[kf], key: { file: keyFile, name: keyName } });
    const df = familyOf(data);
    if (df) ctx.uses.push({ family: df, root: r[df] });
}

// The file steps of the roots the plan writes into, in D8's order - each root's .gitignore, the helpers, the key names -
// and the records that go last. A root this apply creates gets its .gitignore (R13), never one named .alfred; a root that
// exists is asked of git, and with a gap gets no key file and a note naming the fix.
function fileSteps(inv, ctx, out)
{
    const P = E.pathFor(ctx.platform);
    const exists = ctx.exists || ((p) => fs.existsSync(p));
    const byRoot = new Map();
    for (const family of ['project', 'global'])
        for (const u of ctx.uses.filter((x) => x.family === family))
        {
            const r = byRoot.get(u.root) || { family, root: u.root, helper: false, keys: new Map() };
            byRoot.set(u.root, r);
            if (u.helper) r.helper = true;
            if (u.key) r.keys.set(u.key.file, [...new Set([...(r.keys.get(u.key.file) || []), u.key.name])]);
        }
    const ignore = [];
    const helpers = [];
    const names = [];
    const records = [];
    const map = (inv.roots && inv.roots.map) || null;
    for (const r of byRoot.values())
    {
        const existed = exists(r.root);
        if (!existed && P.basename(r.root) !== '.alfred')
            ignore.push({ op: 'root-ignore', path: r.root, why: `the new root ${r.root}: its .gitignore keeps the key file, the record and the data out of git` });
        const gap = existed ? roots.ignoreGap(r.root, r.family) : null;
        if (gap) out.notes.push(`${r.root}: ${gap.reason} - no key file is written there; /preferred-tools:fix (root-ignore) covers it`);
        if (r.helper)
        {
            const { state } = roots.helperState(P.join(r.root, roots.FILES.helper), exists);
            if (state === 'absent' || state === 'lower')
                helpers.push({ op: 'write-helper', path: r.root, why: `${r.root}: mcp-headers.js, which reads a hosted key from .mcps-secrets each time Claude Code connects` });
            else if (state === 'higher') out.notes.push(`mcp-headers.js in ${r.root} is newer than this plugin - update preferred-tools`);
            else if (state === 'edited') out.notes.push(`mcp-headers.js in ${r.root} changed since preferred-tools wrote it - left as it is; /preferred-tools:fix (helper-stale) rewrites it`);
        }
        if (!gap)
            for (const [file, want] of r.keys)
            {
                const have = new Set(exists(file) ? keys.namesIn(file) : []);
                const lack = want.filter((n) => !have.has(n));
                if (lack.length) names.push({ op: 'ensure-key-name', file, names: lack, why: `${file}: the key's name - names only, you fill in each value` });
            }
        const mapped = !map ? null : r.family === 'global' ? map.global : (Object.keys(map.projects || {}).length ? map.projects[roots.mapKey(ctx.project)] : null);
        if (mapped !== r.root)
            records.push({ op: 'record-root', family: r.family, project: ctx.project, root: r.root, why: `the ${r.family} root ${r.root}: written to the roots map, so the commands find it again` });
    }
    // each family's answers, merged into its record in the root this run uses; a record found in another root comes along
    const choices = [];
    for (const family of ['project', 'global'])
    {
        const list = (ctx.recordEntries && ctx.recordEntries[family]) || [];
        const carry = Boolean(ctx.carryRecord && ctx.carryRecord.has(family));
        if ((!list.length && !carry) || !ctx.roots || !ctx.roots[family]) continue;
        const file = P.join(ctx.roots[family], roots.FILES.record);
        const found = inv.records && inv.records[family];
        const carried = found && found.file && found.file !== file ? found.servers : [];
        if (!list.length && !carried.length) continue;
        choices.push({ op: 'record-choice', file, entries: [...carried, ...list], live: ctx.recordLive, why: `${file}: your answers about the servers already set up - names, scopes, fingerprints and choices only` });
    }
    return { before: [...ignore, ...helpers, ...names], after: [...choices, ...records] };
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

// ---- the plan -------------------------------------------------------------------------------------------------------

function plan(inv, answers, opts = {})
{
    const catalog = opts.catalog || catalogLib.load();
    // answers.machine: what prereq.js found (docker: false picks github's binary fallback); an explicit option wins
    const ctx = { ...makeCtx(inv, { ...opts, machine: opts.machine || answers.machine }), changing: new Set(Object.keys(answers.change || {})), uses: [] };
    const out = { version: 1, project: inv.project, os: inv.os, alfredCodeEnabled: Boolean(inv.alfredCodeEnabled), steps: [], notes: [], errors: [], unchanged: [], keys: [], oauth: [], dangerous: [], expect: [], hud: null };
    // the root folders (spec D2): every data folder, key file and helper of a family sits in its root
    const resolved = roots.resolve(inv, answers.roots, { ...ctx, catalog });
    out.errors.push(...resolved.errors);
    ctx.roots = resolved.roots;
    out.roots = ctx.roots;

    // the key's name and the settings (spec D9, R4): top-level maps keyed by row id (install) or target key (configure)
    const keyNames = answers.keyNames || {};
    const settings = answers.settings || {};
    for (const [rowId, pick] of Object.entries(answers.picks || {}))
    {
        const row = catalog.byId.get(rowId);
        if (!row) { out.errors.push(`unknown tool '${rowId}'`); continue; }
        if (row.kind === 'mcp') planMcp(row, { ...(pick || {}), keyName: keyNames[rowId], settings: settings[rowId] }, inv, ctx, catalog, out);
        else planPlugin(row, pick || {}, inv, ctx, catalog, out);
    }
    for (const [key, pick] of Object.entries(answers.change || {})) planChange(key, { ...(pick || {}), keyName: keyNames[key], settings: settings[key] }, inv, ctx, catalog, out);
    for (const r of answers.remove || []) planRemove(r, inv, catalog, out);
    planExisting(answers, inv, ctx, catalog, out, opts.connectors === undefined ? null : opts.connectors);
    planRootChange(answers, inv, ctx, catalog, out);
    if (out.hud && answers.hud) out.hud = answers.hud;
    // 'defer': a claude-hud that is not installed yet cannot be checked, so its settings ask follows the install
    if (out.hud === 'defer') { out.hud = null; out.hudAfter = true; out.notes.push('claude-hud: its statusLine and recommended settings are asked after the install'); }
    if (out.hud) out.steps.push({ op: 'hud', mode: out.hud, why: `claude-hud: ${out.hud === 'skip' ? 'statusLine only' : out.hud === 'replace' ? 'statusLine plus recommended settings, replacing differing keys' : 'statusLine plus recommended settings, add-only'}` });
    // the file steps first, the records last (D8): a failed add leaves files a re-run finds in place
    const files = fileSteps(inv, ctx, out);
    out.steps = [...files.before, ...out.steps, ...files.after];
    out.noop = out.steps.length === 0 && out.errors.length === 0;
    return out;
}

// configure's 'Change the root' (spec D7, R3): each managed registration of the family is re-added as read, its data
// folder - when it sits in the old root - and its helper in the new root; the new root gets its .gitignore, the helper,
// the names in use (names only) and the record, and the roots map points at it. No data and no key value moves.
function planRootChange(answers, inv, ctx, catalog, out)
{
    const P = E.pathFor(ctx.platform);
    for (const family of answers.rootChange || [])
    {
        if (!['project', 'global'].includes(family)) { out.errors.push(`rootChange: '${family}' is not a root family - project or global`); continue; }
        const next = ctx.roots && ctx.roots[family];
        if (!next) continue; // the roots answer's error is already in the plan
        const used = inv.roots && Object.hasOwn(inv.roots, family) ? inv.roots[family] : roots.inUse(inv, family, { ...ctx, catalog });
        if (!used) { out.unchanged.push(`rootChange: no ${family} root is in use here - nothing to move`); continue; }
        if (used.path === next) { out.unchanged.push(`rootChange: the ${family} root is already ${next}`); continue; }
        const inOld = (p) => { const rel = P.relative(used.path, p); return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel)); };
        const scopes = family === 'global' ? ['user'] : ['project', 'local'];
        const secretsOld = P.join(used.path, roots.FILES.secrets);
        const secretsNew = P.join(next, roots.FILES.secrets);
        let keyed = false;
        ctx.uses.push({ family, root: next });
        ctx.carryRecord = ctx.carryRecord || new Set();
        ctx.carryRecord.add(family);
        for (const r of inv.registrations.filter((x) => x.rowId && !x.own && !x.alfredRetired && x.choice !== 'own' && scopes.includes(x.scope)))
        {
            const row = catalog.byId.get(r.rowId);
            // a target changed in this run is planned there, into the new root as well
            if (!row || row.kind !== 'mcp' || ctx.changing.has(keyOf('mcp', r.name, r.scope))) continue;
            const cur = E.currentOf(row, r);
            const dataAbs = row.locations && cur.rootStr ? E.formatRoot(E.logicalRoot(cur.rootStr, ctx), 'local', ctx).value : null;
            const moves = Boolean(dataAbs) && inOld(dataAbs);
            planMcp(row, { target: { name: r.name, scope: r.scope }, ...(moves ? { location: { side: family === 'global' ? 'account' : 'project' } } : {}) }, inv, ctx, catalog, out);
            // the name its key goes under: the helper's argument, else the name holding the key it holds, else the catalog's
            const route = row.routes[cur.route];
            let name = route && route.helper ? cur.keyName : null;
            if (route && !route.helper && route.tokenVar && keys.tokenFields(r.entry, route).length)
            {
                const held = asks.heldKey(ctx.readLive(r.name, r.scope) || r.entry, route);
                name = held ? keys.nameOfValue([secretsOld, ...keys.oldFiles(ctx.project, ctx.home)], held) || route.tokenVar : null;
            }
            if (!name) continue;
            ctx.uses.push({ family, root: next, key: { file: secretsNew, name } });
            keyed = true;
        }
        if (keyed) out.notes.push(`copy the values from ${secretsOld} to ${secretsNew} yourself - until then those servers connect without their keys`);
    }
}

// The answers about servers already set up (spec D6): each goes to its family's record, the project root's for a project
// or local registration and a plugin's server, the global root's for a user registration and a connector. A row answered
// 'add' and picked runs beside the other server: the plan says so.
function planExisting(answers, inv, ctx, catalog, out, connectors)
{
    ctx.recordEntries = { project: [], global: [] };
    for (const [key, choice] of Object.entries(answers.existing || {}))
    {
        const item = existing.itemOf(inv, key, catalog);
        if (!item) { out.errors.push(`existing: '${key}' is not a server found here`); continue; }
        const allowed = existing.CHOICES[item.kind];
        if (!allowed.includes(choice)) { out.errors.push(`existing: '${choice}' is not an answer for ${key} - ${allowed.join(' or ')}`); continue; }
        ctx.recordEntries[item.family].push(existing.recordEntry(item, choice));
        if (ctx.roots && ctx.roots[item.family]) ctx.uses.push({ family: item.family, root: ctx.roots[item.family] });
        if (choice === 'add' && Object.hasOwn(answers.picks || {}, item.rowId)) out.notes.push(`${item.rowId}: ${existing.twoServers(item.label, existing.ownerOf(item))}`);
    }
    ctx.recordLive = existing.liveOf(inv, catalog, connectors);
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

// The plan's line for one key: who reads it, from which files, and whether its name is filled there - never a value.
function keyLine(k)
{
    const reader = k.kind === 'helper' ? 'mcp-headers.js reads it each time Claude Code connects' : 'the apply writes it into the registration';
    const parts = [`Key: ${k.name} (${k.scope} scope) - ${k.variable}; ${reader}, from ${k.files.join(', then ')}. The key is never printed.`];
    if (k.filled) parts.push('Filled.');
    else if (k.old) parts.push(`${k.variable} is in ${k.old}, which preferred-tools no longer reads: move it to ${k.files[0]}`);
    else parts.push(`Not filled yet: add ${k.variable}=<your key> to ${k.files[0]}${k.kind === 'helper' ? ' - until then the server connects without its key' : ' before the apply, or after it run /preferred-tools:configure and keep the name - it writes the key in'}.`);
    return parts.join(' ');
}

function render(p)
{
    const lines = [];
    const P = E.pathFor(p.os);
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
        else if (s.op === 'root-ignore') lines.push(`   writes ${P.join(s.path, '.gitignore')}  (${roots.GITIGNORE.trim().split('\n').join(', ')} - or the lines it lacks, appended)`);
        else if (s.op === 'write-helper') lines.push(`   writes ${P.join(s.path, roots.FILES.helper)}  (this plugin's header helper)`);
        else if (s.op === 'ensure-key-name') lines.push(`   writes ${s.file}  (names only: ${s.names.join(', ')} - you fill in each value)`);
        else if (s.op === 'record-choice') lines.push(`   writes ${s.file}  (names, scopes, fingerprints and choices only)`);
        else if (s.op === 'record-root') lines.push(`   writes ${roots.FILES.map} in the plugin's data folder  (the ${s.family} root: ${s.root})`);
        else if (s.op === 'fetch') lines.push(`   ${s.argv.map(shq).join(' ')}`, '   (after the apply, in the background: fills the cache only; if it fails the registration stays and the first start tries again)');
        else if (s.op === 'hud') lines.push(`   node scripts/hud-statusline.js ${s.mode === 'replace' ? '--replace' : s.mode === 'skip' ? '--statusline-only' : ''}`.trimEnd());
    });
    if (p.keys.length) lines.push('', ...p.keys.map(keyLine));
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

// D6's questions: the servers already set up, each with fix's registration detectors run read-only on the registrations
// as they are, read unmasked in this process (R1) and never written. fix.js requires this file, so it is required here.
function existingBlock(inv, args, catalog)
{
    const fix = require('./fix.js');
    const live = require('./inventory.js').buildInventory({ project: inv.project, env: process.env, data: args.data, catalog });
    const registrationFixes = { ...catalog, fixes: catalog.fixes.filter((f) => f.kind === 'registration') };
    const found = fix.detectAll(fix.makeCtx({ inv: live, catalog: registrationFixes, env: process.env })).found;
    return existing.questions(existing.items(live, existing.parseConnectors(args.connectors), catalog, { home: account.homeDir(process.env) }), found);
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
        const catalog = catalogLib.load();
        const q = asks.all(inv, picks, catalog, { env: process.env, home: account.homeDir(process.env), connectors: args.connectors });
        // the walk's first call carries --connectors (R12): only it reads the live registrations and runs the detectors
        if (args.connectors !== null) q.existing = existingBlock(inv, args, catalog);
        console.log(JSON.stringify(q, null, 2));
        return 0;
    }
    const p = plan(inv, read(second), { env: process.env, connectors: args.connectors !== null ? existing.parseConnectors(args.connectors) : null });
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(p, null, 2));
    console.log(render(p));
    return p.errors.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { plan, render, argvOf, makeCtx, deepEqual, projectName, main, parseArgs, globalWords, useRoots, fileSteps };
