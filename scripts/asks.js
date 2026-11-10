'use strict';
// EVERY QUESTION THE WALK ASKS, as data. A question is { id, header, question, multiSelect, options: [{ label, description }] }:
// 2 to 4 options, exactly one marked '(Recommended)' and listed first on a single-select; a call carries 1 to 4 questions.
// 'Other' is added by AskUserQuestion itself and never listed here.
const fs = require('node:fs');
const path = require('node:path');
const E = require('./entries.js');
const { installedOf, keyOf, targetOf, fromHere, otherWindowsMcp } = require('./inventory.js');
const { pinOf } = require('./table.js');
const keys = require('./keys.js');
const roots = require('./roots.js');

const REC = ' (Recommended)';
// The `remote` route is worded 'hosted' in every ask: alfred-code's stop guard reads a bare 'remote' in an ask as git
// state and sends Claude to fetch and re-ask (docs/sources.md, 'alfred-code hooks over the commands').
const ROUTE_WORD = { remote: 'hosted', local: 'local' };
const HEADER = { code: 'Code', docs: 'Docs, forges', browsers: 'Browsers', machine: 'Machine', own: 'On their own', roots: 'Root folders' };
const SCOPE_TEXT = {
    local: 'this project, only you (~/.claude.json, under this project)',
    project: "this project, for everyone who opens it (the committed .mcp.json - relative paths and ${VAR} only)",
    user: "every project on this machine (Claude Code's user scope, in ~/.claude.json)",
};
// Only words change (spec D1): the value stays user, project or local in picks, answers, the plan and on the CLI.
const SCOPE_LABEL = { user: 'Global', project: 'Project', local: 'Local' };
const scopeOfLabel = (label) => Object.keys(SCOPE_LABEL).find((s) => SCOPE_LABEL[s] === String(label).replace(/ \(Recommended\)$/, '')) || null;
// project scope for a route that runs on this machine: what the committed file then carries
const PROJECT_LOCAL_TEXT = "the committed .mcp.json - every session in this folder or below it; data folders follow the folder Claude starts in, a subfolder included; it holds this machine's launch (cmd /c on Windows, the x64 Python on Windows ARM64)";
const scopeText = (s, row, routeId) => (s === 'project' && row.kind === 'mcp' && routeId === 'local' ? PROJECT_LOCAL_TEXT : SCOPE_TEXT[s]);
// every scope question lists the recommended scope first, then the others in this order (the user's ruling, 2026-11-10)
const SCOPE_ORDER = ['user', 'project', 'local'];

// Where a route's key is, by name only (spec D3, D9): { variable, kind, scope, files, found } - or null for a route that
// takes no key. `variable` is the catalog's default name; `kind` 'helper' for a hosted route (mcp-headers.js reads the
// hosted chain when Claude Code connects), 'stdio' for a local one (the apply reads the stdio chain); `files` that chain
// at `scope`; `names` each name D9 offers that a file there fills, with the first such file ({ name, file }), in chain
// order; `found` the default name's entry when it is filled, else the first other, else null. `old` the same for the
// files 0.1.x read (names only). `ctx.keyHome`, when the ctx has one, decides whether files outside the project are
// read (null: none); else they are.
function keyStateOf(row, routeId, ctx, alfredEnabled, scope = 'user')
{
    const route = row.routes && row.routes[routeId];
    if (!route || !ctx) return null;
    const variable = route.helper ? route.helper.var : route.tokenVar;
    if (!variable) return null;
    const kind = route.helper ? 'helper' : 'stdio';
    const projectRoot = E.rootOf('project', ctx);
    const globalRoot = E.rootOf('global', ctx);
    const files = kind === 'helper'
        ? keys.hostedChain({ scope, projectRoot, globalRoot, globalNamed: Boolean(ctx.roots && ctx.roots.globalNamed), home: ctx.home })
        : keys.stdioChain({ scope, projectRoot, globalRoot });
    const readHome = Object.hasOwn(ctx, 'keyHome') ? Boolean(ctx.keyHome) : true;
    const inProject = (f) => { const rel = path.relative(ctx.project, f); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };
    const word = row.id.toUpperCase().replace(/-/g, '_');
    const offered = (list) =>
    {
        const out = [];
        for (const { file, names } of keys.filledNames(readHome ? list : list.filter(inProject)))
            for (const name of names) if (keys.offeredName(name, variable, word) && !out.some((n) => n.name === name)) out.push({ name, file });
        return out;
    };
    const names = offered(files);
    const found = names.find((n) => n.name === variable) || names[0] || null;
    const old = offered(keys.oldFiles(ctx.project, ctx.home)).filter((n) => !names.some((c) => c.name === n.name));
    return { variable, kind, scope, files, names, found, old };
}

// D9: which name holds a tool's key in .mcps-secrets. Options: the catalog's name, up to two other names found holding
// the row id (in the chain, then in a file 0.1.x read), and 'A name you choose', asked next. Recommended: `current` (the
// name the registration uses, for configure), else a name filled in the chain - the default first when both are -
// else the default. -> { question, answers: { <label as shown>: NAME | 'named' } } | null for a route with no key here.
function keyNameQuestion(row, routeId, scope, ctx, { current = null } = {})
{
    const ks = keyStateOf(row, routeId, ctx, null, scope);
    if (!ks || (ks.kind === 'stdio' && scope === 'project')) return null;
    const desc = new Map();
    for (const n of ks.names) desc.set(n.name, `filled in ${n.file}`);
    for (const n of ks.old) desc.set(n.name, `in ${n.file} - move it to .mcps-secrets under this name`);
    if (!desc.has(ks.variable)) desc.set(ks.variable, `the catalog's name - add it to ${ks.files[0]}`);
    const rec = current || (ks.found ? ks.found.name : ks.variable);
    if (!desc.has(rec)) desc.set(rec, 'the name it uses now');
    const others = [...ks.names, ...ks.old].map((n) => n.name).filter((n) => n !== ks.variable && n !== rec).slice(0, 2);
    const order = [rec, ...[ks.variable, ...others].filter((n) => n !== rec)].slice(0, 3);
    const opts = [...order.map((n, i) => ({ label: `${n}${i === 0 ? REC : ''}`, description: desc.get(n), value: n })), { label: 'A name you choose', description: 'a name of yours, asked next - its value goes in .mcps-secrets, never in the chat', value: 'named' }];
    return {
        question: { id: `keyname-${row.id}`, header: 'Key name', multiSelect: false, question: `Which name holds ${row.label}'s key in .mcps-secrets?`, options: opts.map(({ label, description }) => ({ label, description })) },
        answers: Object.fromEntries(opts.map((o) => [o.label, o.value])),
    };
}

// D9: a stdio route's settings - 'Keep these settings' listing NAME=value, or 'No settings' for an empty env, then
// 'Change or add a setting', after which the walk asks for NAME=value pairs. `entry`: the registration as read
// (configure), else the catalog's env. -> { question, answers: { <label>: 'keep' | 'change' } } | null for a hosted route.
function settingsQuestion(row, routeId, { entry = null } = {})
{
    if (routeId === 'remote' || !row.routes[routeId]) return null;
    const pairs = E.settingsOf(row, routeId, entry);
    const keep = pairs.length ? { label: `Keep these settings${REC}`, description: pairs.map(([k, v]) => `${k}=${v}`).join(', ') } : { label: `No settings${REC}`, description: "the server's own defaults" };
    const change = { label: 'Change or add a setting', description: 'NAME=value pairs, asked next - a key goes in .mcps-secrets, never here' };
    return {
        question: { id: `settings-${row.id}`, header: 'Settings', multiSelect: false, question: `${row.label}'s settings`, options: [keep, change] },
        answers: { [keep.label]: 'keep', [change.label]: 'change' },
    };
}

// The live registration, read in this process when the env names an account (R1: the inventory file is masked); a
// caller that passes no env reads none.
const liveReader = (project, env) => (env && (env.CLAUDE_CONFIG_DIR || env.HOME || env.USERPROFILE) ? (name, scope) => require('./account.js').readRegistration(name, scope, project, env) : () => undefined);

// The key a stdio registration holds, from its first token field: a value, or null for none (empty, ${VAR} only).
function heldKey(entry, route)
{
    const f = keys.tokenFields(entry, route)[0];
    const v = f ? f.at.reduce((o, k) => (o == null ? undefined : o[k]), entry) : undefined;
    return typeof v === 'string' && v !== '' && !keys.PLACEHOLDER.test(v) ? v : null;
}

// local for a local route (its paths and Python are this machine's); for a hosted route, global when it will use a key
// (spec D5, O7: a global helper has an absolute path, needs no folder trust and serves every session, a workspace child
// included) - a required key, or an optional one whose name is filled in the global chain - else project. The scope is
// asked before the key, so `keyState` is read at global scope.
function recommendedScope(row, routeId, keyState = null)
{
    if (row.kind === 'plugin') return row.recommendedScope;
    if (routeId !== 'remote') return 'local';
    const route = row.routes[routeId];
    if (!route || !route.helper) return 'project';
    return route.auth === 'token' || Boolean(keyState && keyState.found) ? 'user' : 'project';
}
// an optional key is sent by default when a name D9 offers is filled in the chain the chosen scope reads
const keyToSend = (keyState) => Boolean(keyState && keyState.found);

function chunk(list, n)
{
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
}

// Multi-select questions over items in catalog-group order ({ group, label, description }): a question per group, at
// most four options, a bigger group split evenly (5 is 3 + 2, never 4 + 1). AskUserQuestion takes 2 to 4 options, so a
// question left with one joins a neighbour that has room, else takes one from it, and a single item in all gets
// `none` beside it. -> calls of at most four questions.
function packed(items, { id, question, none })
{
    const qs = [];
    for (const g of [...new Set(items.map((i) => i.group))])
    {
        const mine = items.filter((i) => i.group === g);
        const k = Math.ceil(mine.length / 4);
        for (let n = 0, at = 0; n < k; n++)
        {
            const size = Math.floor(mine.length / k) + (n < mine.length % k ? 1 : 0);
            qs.push(mine.slice(at, at + size));
            at += size;
        }
    }
    for (let i = 0; i < qs.length; i++)
    {
        if (qs[i].length !== 1) continue;
        const prev = qs[i - 1];
        const next = qs[i + 1];
        if (prev && prev.length < 4) { prev.push(...qs.splice(i, 1)[0]); i--; }
        else if (next && next.length < 4) { next.unshift(...qs.splice(i, 1)[0]); i--; }
        else if (prev) qs[i].unshift(prev.pop());
        else if (next) qs[i].push(next.shift());
    }
    const out = qs.map((part, n) =>
    {
        const one = part.every((p) => p.group === part[0].group) ? part[0].group : null;
        const options = part.map((p) => ({ label: p.label, description: p.description }));
        if (options.length === 1) options.push({ label: 'None of these', description: none });
        return {
            id: `${id}-${n}`, header: one ? HEADER[one.id] : 'Tools', multiSelect: true,
            question: one ? `${one.label}: ${question}` : `${question[0].toUpperCase()}${question.slice(1)}`, options,
        };
    });
    return chunk(out, 4);
}

// The install pick: the rows for this OS not installed in this project. A row installed only for every project (user
// scope, below its recommended scope) or inherited from a parent folder's .mcp.json is offered too: picking it adds this
// project's own copy beside that one. A row installed here, or at its recommended scope, is configure's.
const offeredForInstall = (row, inv) =>
{
    const at = installedOf(inv, row.id).map((h) => h.scope);
    return !at.includes('local') && !at.includes('project') && !at.includes(recommendedScope(row, row.recommendedRoute));
};

// `existing`: the answers about servers already set up so far (spec D6). A row whose server was left on its own -
// answered now or recorded - is not offered; one answered 'add' is, with the two servers named.
function pickQuestions(inv, catalog, existing = {})
{
    const X = require('./existing.js');
    const rule = X.offerRule(inv, catalog, existing);
    const items = [];
    for (const g of catalog.groups)
        for (const row of catalog.tools.filter((r) => r.group === g.id && r.os.includes(inv.os) && offeredForInstall(r, inv) && !rule.own.has(r.id)))
        {
            const have = installedOf(inv, row.id);
            const inherited = have.filter((h) => h.scope === 'inherited');
            const user = have.filter((h) => h.scope === 'user');
            const tags = inherited.map((h) => `inherited from ${fromHere(inv, h.from)} as ${h.name}, ${h.approval}`);
            if (user.length) tags.push(row.kind === 'mcp' ? `installed for every project as ${user.map((h) => h.name).join(', ')}` : 'installed for every project');
            const stays = [...(user.length ? ['the one for every project'] : []), ...inherited.map((h) => `the one inherited from ${fromHere(inv, h.from)}`)];
            const keep = `${stays.join(' and ')} ${stays.length > 1 ? 'stay' : 'stays'}${user.length ? '' : stays.length > 1 ? ' in their folders' : ' in its folder'}`;
            // windows-mcp 0.8.8 keeps one per desktop healthy; a copy under the row's own name replaces that one here
            const others = row.id === 'windows-control' ? otherWindowsMcp(inv, row.name) : [];
            const warn = `${others.length ? `; another windows-mcp already starts here (${others.join(', ')}) - keep one per desktop` : ''}${rule.add.has(row.id) ? `; ${X.twoServers(row.label, rule.add.get(row.id))}` : ''}`;
            items.push({ group: g, label: `${row.label}${tags.length ? ` (${tags.join('; ')})` : ''}`, description: `${have.length ? `adds this project's own copy; ${keep} - ${row.summary}` : row.summary}${warn}` });
        }
    return packed(items, { id: 'pick', question: 'which tools do you want to install?', none: 'install nothing' });
}

const leftAlone = (inv, h) => h.kind === 'mcp' && inv.registrations.some((r) => r.name === h.name && r.scope === h.scope && r.choice === 'own');

// Every catalog registration and plugin installed here, one item each (a row at two scopes is two), grouped. An
// inherited server is not here: it is changed by running the command in its own folder, and one left on its own is in
// its own group (changeQuestions).
function installedItems(inv, catalog, describe)
{
    const items = [];
    for (const g of catalog.groups)
        for (const row of catalog.tools.filter((r) => r.group === g.id))
            for (const h of installedOf(inv, row.id).filter((x) => x.scope !== 'inherited' && !leftAlone(inv, x)))
                items.push({ group: g, row, h, label: h.kind === 'mcp' ? `${h.name} (${row.label}, ${h.scope})` : `${row.label} (${h.scope})`, description: describe(row, h) });
    return items;
}

// The root each family uses now (spec D2): the inventory's, else found from the registrations and the standard folders.
function rootInUse(inv, family, ctx = {})
{
    if (inv.roots && Object.hasOwn(inv.roots, family)) return inv.roots[family] || null;
    return roots.inUse(inv, family, { project: inv.project, platform: inv.os, home: ctx.home || require('./account.js').homeDir(process.env), exists: ctx.exists, catalog: ctx.catalog });
}

const ROOT_LABEL = { project: 'Project root folder', global: 'Global root folder' };
const ROOT_MOVES = { project: "this project's keys, key helper and tool data", global: 'the keys, key helper and tool data for every project' };

// The configure pick: one option per installed registration or plugin, then the servers left on their own, then one per
// root folder in use (spec D7, R3). `keys` maps each label to the key the answers use (`mcp:<name>~<scope>`,
// `plugin:<id>~<scope>`, `root:<family>`).
function changeQuestions(inv, catalog, ctx = {})
{
    const describe = (row, h) =>
    {
        if (h.kind === 'plugin') return `${h.version ? `version ${h.version}` : 'installed'}${h.enabled ? '' : ', disabled'}`;
        const pin = pinOf(row, h.route, h.entry);
        return `${ROUTE_WORD[h.route] || h.route} route${pin ? `, pin ${pin}` : ''}`;
    };
    const items = installedItems(inv, catalog, describe);
    // the servers left on their own (spec D6, R3): a group of their own, whose pick keeps them so or hands them over
    const X = require('./existing.js');
    const group = { id: 'own', label: 'On their own' };
    for (const it of X.ownItems(inv, catalog))
    {
        const label = it.kind === 'mcp' ? `${it.name} (${it.label}, ${it.scope}) - on its own` : it.kind === 'plugin' ? `${it.server} (${it.label}, from ${X.ownerOf(it)}) - on its own` : `${it.connector} (${it.label}, claude.ai) - on its own`;
        const description = it.kind === 'mcp' ? 'left on its own at install - pick it to keep it so or let preferred-tools manage it' : `left with ${X.ownerOf(it)} - pick it to keep it so or let install offer preferred-tools' own beside it`;
        items.push({ group, label, description, h: { kind: 'own', key: it.key } });
    }
    const rootGroup = { id: 'roots', label: 'Root folders' };
    for (const family of ['project', 'global'])
    {
        const used = rootInUse(inv, family, { ...ctx, catalog });
        if (used) items.push({ group: rootGroup, label: ROOT_LABEL[family], description: `${used.path} - pick it to move ${ROOT_MOVES[family]} to another folder`, h: { kind: 'root', key: `root:${family}` } });
    }
    return {
        calls: packed(items, { id: 'change', question: 'which do you want to change?', none: 'change nothing' }),
        keys: Object.fromEntries(items.map((i) => [i.label, i.h.key || keyOf(i.h.kind, i.h.name, i.h.scope)])),
    };
}

// `current`: the route the registration has now, recommended first so 'Keep' is the default.
function routeQuestion(row, current = null)
{
    const ids = Object.keys(row.routes);
    if (ids.length < 2) return null;
    const first = current || row.recommendedRoute;
    const order = [first, ...ids.filter((i) => i !== first)];
    const text = { remote: 'run by the vendor - no local runtime needed', local: 'runs on this machine' };
    return {
        id: `route-${row.id}`, header: 'Route', multiSelect: false, question: `${row.label}: hosted or local?`,
        options: order.map((r, i) => ({ label: `${ROUTE_WORD[r][0].toUpperCase()}${ROUTE_WORD[r].slice(1)}${i === 0 ? REC : ''}`, description: text[r] })),
    };
}

// Every scope for every row (the user's ruling, 2026-11-10: 'It must give options as user/project/local'). The one left
// out: project for serena on Windows when this machine's profile path has a space - its home must be absolute and
// space-free, and the committed file can only name it as ${USERPROFILE}\.serena.
function scopesFor(row, routeId, ctx = null)
{
    if (row.kind === 'plugin') return ['project', 'local', 'user'];
    const serenaWin = row.locations && row.locations.windowsAbsolute && ctx && ctx.platform === 'win32';
    // a stdio route that needs a key holds it written in, which the committed .mcp.json never carries (spec D5)
    const route = row.routes && row.routes[routeId];
    const stdioKey = routeId !== 'remote' && route && route.auth === 'token';
    return ['local', 'project', 'user'].filter((s) => s !== 'project' || (!stdioKey && !(serenaWin && E.serenaWindowsHome(ctx).needsInput)));
}

// The scopes offered, the recommended one first. `current` is the registration configure changes; for an install,
// `copyOf` lists this row's registrations at other scopes (the copy for every project), whose scopes are not offered again.
function scopeOrder(row, inv, { route, current = null, copyOf = [], ctx = null } = {})
{
    const routeId = route || (current && current.route) || row.recommendedRoute;
    const all = scopesFor(row, routeId, ctx);
    const stranded = strandedScope(row, routeId, current, ctx);
    const rec = current && !stranded ? current.scope : recommendedScope(row, routeId, keyStateOf(row, routeId, ctx, inv.alfredCodeEnabled, 'user'));
    const free = all.filter((s) => !copyOf.some((c) => c.scope === s));
    const scopes = free.length ? free : all;
    const order = [rec, ...SCOPE_ORDER.filter((s) => s !== rec)].filter((s) => scopes.includes(s));
    return stranded ? [...order, stranded] : order;
}

// The scope a registration has that is no longer offered for its route (0.1.x put a stdio keyed route at project scope,
// its key a ${VAR} from the shell): configure lists it last, as the scope it has now, and recommends another.
const strandedScope = (row, routeId, current, ctx) => (current && current.scope && !scopesFor(row, routeId, ctx).includes(current.scope) ? current.scope : null);
const STRANDED_TEXT = 'the scope it has now - it reads its key from the environment Claude Code starts with; a keyed local route is not offered here any more, as the committed .mcp.json carries no key';

// The scope question, or null when one scope is left.
function scopeQuestion(row, inv, { route, current = null, copyOf = [], ctx = null } = {})
{
    const routeId = route || (current && current.route) || row.recommendedRoute;
    const order = scopeOrder(row, inv, { route: routeId, current, copyOf, ctx });
    if (order.length < 2) return null;
    return {
        id: `scope-${row.id}`, header: 'Scope', multiSelect: false,
        question: current ? `${row.label}: which scope? Another one moves '${current.name || row.label}' there; /preferred-tools:install adds a second copy instead.` : `${row.label}: which scope?`,
        options: order.slice(0, 4).map((s, i) => ({ label: `${SCOPE_LABEL[s]}${i === 0 ? REC : ''}`, description: s === strandedScope(row, routeId, current, ctx) ? STRANDED_TEXT : scopeText(s, row, routeId) })),
    };
}

// a per-project registration name: the project folder's name before the tool's
const perProjectName = (row, ctx) => (ctx ? `${path.basename(ctx.project).replace(/[^A-Za-z0-9_-]+/g, '-')}-${row.name}`.slice(0, 64) : `project-${row.name}`);

// The registration name a `names` answer stands for: 'keep' (or none) - the name it has now, else the original;
// 'prefixed' - the per-project name; else the name itself.
function nameFor(row, name, current, ctx)
{
    if (!name || name === 'keep') return current ? current.name : row.name;
    return name === 'prefixed' ? perProjectName(row, ctx) : name;
}

function nameQuestion(row, inv, { current = null, copyOf = [], ctx = null } = {})
{
    const orig = row.name;
    const shadows = copyOf.find((c) => c.name === orig);
    const options = current && current.name !== orig
        ? [{ label: `Keep \`${current.name}\`${REC}`, description: 'the name it has now' }, { label: `Use \`${orig}\``, description: 'the original name' }]
        : [{ label: `Keep \`${orig}\`${REC}`, description: shadows ? `the original name; in this project it is used instead of ${shadows.scope === 'inherited' ? `the one inherited from ${fromHere(inv, shadows.from)}` : 'the copy for every project'}` : 'the original name' }, { label: `Use \`${perProjectName(row, ctx)}\``, description: 'a per-project name' }];
    return { id: `name-${row.id}`, header: 'Name', multiSelect: false, question: `${row.label}: registration name?`, options };
}

// ---- the location question (spec D2) --------------------------------------------------------------------------------
// A tool's data folder is <root>/<name> in the root of its scope's family, so most picks ask nothing. A question is left
// only where a tool needs one: memory (the global root's one memory, or this project's own), serena on Windows when the
// root's path has a space, a tool with alfred-code 2.x data on disk, and configure ('The folder it uses now' first). A
// label names the place in words, fixed text, so the walk never reads a path out of it; the description gives the exact
// folder on this machine and what follows from it.
const SIDE_LABEL = {
    project: "The project root's folder",
    account: "The global root's folder",
    'alfred-data': '.alfred in this project',
    alfred: 'Carry over alfred-code 2.x data',
    keep: 'The folder it uses now',
};
const SIDE_TAIL = {
    project: "this project's own",
    account: 'one folder for every project on this machine',
    'alfred-data': 'kept out of git by alfred-code; deleting .alfred erases this data',
    alfred: "carries over the data alfred-code 2.x left there; the folder is alfred-code's, so deleting it erases this tool's data",
};
const MEMORY_TAIL = { project: "this project's own memory", account: 'one memory for every project on this machine' };
// serena's home holds its language servers (docs/build-prompt.md, the serena-windows-home row): a home per project
// downloads them once per project
const SERENA_PER_PROJECT = 'its language servers (about 327MB) download once per project';

// The folder a root lands in, as the description says it: absolute at local and user scope; at project scope the written
// form and what it is from here.
function placeText(root, scope, ctx, backslash = false)
{
    const abs = E.formatRoot(root, 'local', ctx).value;
    if (scope !== 'project') return abs;
    const written = E.formatRoot(root, 'project', ctx, { backslash }).value;
    if (root.kind === 'home') return `\`${written}\` - on this machine ${abs}`;
    return `\`${written}\` - from ${ctx.project}: ${abs}; from a child or a subfolder: its own`;
}

// The location question for a row with a data folder, at a known scope and registration name (the folder is named
// after it). `ctx.roots` holds the roots answered so far (roots.resolve); none - the recommended ones. -> { question (or
// null when one place is left), answers: { <label as shown>: <location entry> }, only: the one location left when no
// question is asked }.
function locationQuestion(row, inv, { scope, name = null, current = null, copyOf = [], ctx })
{
    if (!ctx.roots) ctx = { ...ctx, roots: roots.resolve(inv, null, ctx).roots };
    const loc = row.locations;
    const folder = name || (current ? current.name : row.name);
    const serenaWin = Boolean(loc.windowsAbsolute && ctx.platform === 'win32');
    // the committed file names serena's Windows home only as ${USERPROFILE}\.serena (plan.js wantedRoot)
    if (serenaWin && scope === 'project') return { question: null, answers: {}, only: { side: 'default' } };
    // project scope writes a folder under the project relative, so only for a row proven to follow its start folder; a
    // folder outside the project and the home folder it cannot name at all
    const writable = (root) => scope !== 'project' || root.kind === 'home' || (root.kind === 'project' && loc.relative === true);
    const winValid = (root) => !serenaWin || E.validWindowsSerenaHome(E.formatRoot(root, 'local', ctx).value);
    const copy = !current && copyOf.length > 0;
    const natural = E.recommendedSide(row, scope, ctx, { copy });

    const places = [];
    const own = scope === 'user' ? null : { side: 'project', root: E.otherPlace(row, folder, 'project', ctx) };
    const shared = { side: 'account', root: E.otherPlace(row, folder, 'account', ctx) };
    // global scope: the global root; memory, or a pick whose recommended place is the global root: both roots
    if (scope === 'user') places.push(shared);
    else
    {
        places.push(own);
        if (loc.defaultSide === 'account' || natural === 'account') places.push(shared);
    }
    const usable = places.filter((p) => writable(p.root) && winValid(p.root));
    if (serenaWin && usable.length < places.length)
    {
        // a root with a space: the profile's .serena when it is space-free, else a space-free folder, or one typed next
        const profile = E.serenaWindowsHome(ctx);
        if (!profile.needsInput) usable.push({ side: 'default', root: profile.root, label: "Your profile's .serena", description: `${profile.root.path} - the root's path has a space, which serena's home cannot hold; one folder for every project on this machine` });
        else
        {
            const free = E.serenaSpaceFree(ctx);
            usable.push({ side: 'default', root: free, label: 'A space-free folder', answer: { side: 'path', path: free.path }, description: `${free.path} - the root's path and your profile path ${ctx.home} have a space, which serena's home cannot hold; one folder for every project on this machine` });
        }
    }
    const old = !current && !serenaWin ? E.alfredRoot(row, ctx) : null;
    if (old && writable(old)) usable.push({ side: 'alfred', root: old });

    // configure: the folder it uses now, when it can stay at this scope; a place that is the same folder is not repeated
    let keep = null;
    if (current && current.rootStr)
    {
        const root = E.logicalRoot(current.rootStr, ctx);
        if (current.scope === scope || writable(root)) keep = { side: 'keep', root };
    }
    const at = (p) => E.formatRoot(p.root, scope, ctx, { backslash: serenaWin }).value;
    const listed = keep ? [keep, ...usable.filter((p) => at(p) !== at(keep))] : usable;
    if (serenaWin && listed.some((p) => p.side === 'default')) listed.push({ side: 'path', label: 'Another space-free folder', description: 'an absolute folder without spaces, asked next' });

    const rec = keep ? 'keep' : natural;
    const first = listed.find((p) => p.side === rec) || listed[0];
    const order = [first, ...listed.filter((p) => p !== first)].filter(Boolean).slice(0, 4);
    const describe = (p) =>
    {
        if (p.description) return p.description;
        const text = placeText(p.root, scope, ctx, serenaWin);
        if (p.side === 'keep') return text;
        const base = row.id === 'memory' && MEMORY_TAIL[p.side] ? MEMORY_TAIL[p.side] : SIDE_TAIL[p.side];
        const tail = row.id === 'serena' && p.side === 'project' ? `${base}; ${SERENA_PER_PROJECT}` : base;
        return `${text} - ${tail}`;
    };
    const options = order.map((p, i) => ({ label: `${p.label || SIDE_LABEL[p.side]}${i === 0 ? REC : ''}`, description: describe(p) }));
    const answers = Object.fromEntries(order.map((p, i) => [options[i].label, p]).filter(([, p]) => p.side !== 'path').map(([l, p]) => [l, p.answer || { side: p.side }]));
    // one place left: nothing to ask
    if (order.length < 2 && first && first.side !== 'path') return { question: null, answers: {}, only: first.answer || { side: first.side } };
    if (!order.length) return { question: null, answers: {}, only: null };
    return { question: { id: `location-${row.id}`, header: 'Location', multiSelect: false, question: `${row.label}: where does its data live?`, options }, answers, only: null };
}

// The questions for one tool. A row with a data folder asks scope and name `first`, in a call of their own, because its
// folder is named after the registration and depends on the scope; then `questions` holds the location (built for
// `scope` and `name`, else the recommended scope and the name it has now or the original) and one tool-specific extra,
// and `answers` maps each location label to its entry; `only` is the location when one place is left and none is
// asked. Any other row has `first` null and asks scope, name and its extra in one call, as before.
function toolAsk(row, inv, { route, scope = null, name = null, current = null, ctx = null, catalog, copyOf = [] } = {})
{
    const routeId = route || (current && current.route) || row.recommendedRoute;
    const scopeQ = scopeQuestion(row, inv, { route: routeId, current, copyOf, ctx });
    if (row.kind === 'plugin') return { first: null, questions: scopeQ ? [scopeQ] : [], answers: {}, only: null };
    const nameQ = nameQuestion(row, inv, { current, copyOf, ctx });
    const located = Boolean(row.locations && ctx);
    const qs = located ? [] : [scopeQ, nameQ].filter(Boolean);
    let answers = {};
    // one place left: no location question, and the walk writes this as the location (a move must not fall back to
    // 'keep' where the folder it uses now cannot stay)
    let only = null;
    // the scope the questions are built for: the one asked first, else the recommended one
    const at = ctx ? scope || scopeOrder(row, inv, { route: routeId, current, copyOf, ctx })[0] || (current && current.scope) : scope;
    if (located)
    {
        const l = locationQuestion(row, inv, { scope: at, name: nameFor(row, name, current, ctx), current, copyOf, ctx });
        if (l.question) qs.push(l.question);
        else only = l.only;
        answers = l.answers;
    }
    // what the registration has now goes first, so a configure walk recommends keeping it
    const first = (opts, keepFirst) => (keepFirst ? [opts[1], opts[0]] : opts).map((o, i) => ({ ...o, label: `${o.label}${i === 0 ? REC : ''}` }));
    const sameRoute = current && current.route === routeId;
    if (row.routes[routeId].optionalArgs && row.routes[routeId].optionalArgs.executablePath)
    {
        // the committed .mcp.json carries no machine path: at project scope a binary is a ${VAR} path, and one the
        // registration has now is not kept (plan.js leaves it out)
        const committed = at === 'project';
        const has = Boolean(sameRoute && current.executablePath);
        const named = { label: 'A browser binary I name', description: committed ? 'a ${VAR} path - the committed .mcp.json takes no machine path; asked next' : 'sets --executable-path to the binary you name, asked next' };
        const engine = { label: 'Default for this engine', description: has ? 'drops --executable-path' : row.id.endsWith('chrome') || row.id.endsWith('msedge') ? 'the branded browser installed on this machine' : "Playwright's own build" };
        qs.push({
            id: `browser-${row.id}`, header: 'Browser', multiSelect: false, question: `${row.label}: which browser binary?`,
            options: has && !(committed && E.machinePath(current.executablePath))
                ? first([{ label: `Keep \`${current.executablePath}\``, description: 'the binary it uses now' }, engine])
                : first([engine, named]),
        });
    }
    // an optional key (spec D5): asked at every scope but for a stdio route at project scope, which runs keyless
    else if (row.routes[routeId].auth === 'optional-token' && !(routeId !== 'remote' && at === 'project'))
    {
        const route = row.routes[routeId];
        const ks = keyStateOf(row, routeId, ctx, inv.alfredCodeEnabled, at || 'user');
        const file = ks && ks.files[0];
        const useKey = route.helper
            ? { label: 'Use a key from .mcps-secrets', description: `mcp-headers.js reads it each time Claude Code connects${file ? `, from ${file} first` : ''} - never written into the registration` }
            : { label: 'Use a key from .mcps-secrets', description: `the apply writes it into the registration from ${file || '.mcps-secrets'}, never printed` };
        const noKey = route.noKey === 'oauth'
            ? { label: 'Sign in with OAuth', description: 'run /mcp once in a session to log in' }
            : { label: 'No key - lower rate limits', description: 'works anonymously' };
        qs.push({
            id: `token-${row.id}`, header: 'API key', multiSelect: false, question: `${row.label}: send an API key?`,
            options: first([noKey, useKey], current ? Boolean(sameRoute && current.token) : keyToSend(ks)),
        });
    }
    else if (row.params)
    {
        const host = current && current.host && current.host !== row.params[0].default ? current.host : null;
        qs.push({
            id: `host-${row.id}`, header: 'Host', multiSelect: false, question: `${row.label}: which ${row.params[0].label}?`,
            options: host
                ? first([{ label: `Keep ${host}`, description: 'the host it uses now' }, { label: row.params[0].default, description: 'the hosted service' }])
                : first([{ label: row.params[0].default, description: 'the hosted service' }, { label: 'A self-managed host', description: 'your own GitLab host name, asked next' }]),
        });
    }
    return { first: located ? [scopeQ, nameQ].filter(Boolean) : null, questions: qs, answers, only };
}

// The questions toolAsk gives after `first`: for a row without a data folder, its whole call.
const toolQuestions = (row, inv, opts = {}) => toolAsk(row, inv, opts).questions;

// Remove: one option per registration or plugin (a row at two scopes is two options), grouped; the description is the
// exact command, which the walk reads the target from.
function removeQuestions(inv, catalog)
{
    const items = installedItems(inv, catalog, (row, h) => (h.kind === 'mcp' ? `claude mcp remove ${h.name} -s ${h.scope}` : `claude plugin uninstall ${h.name} --scope ${h.scope}`));
    return packed(items, { id: 'remove', question: 'which do you want to remove?', none: 'remove nothing' });
}

// The fixed asks of the commands, here so a test holds them to the limits.
const STATIC = {
    menu: { id: 'menu', header: 'Action', multiSelect: false, question: 'What do you want to change?', options: [
        { label: `Change tools${REC}`, description: 'pick installed tools, servers on their own or a root folder, then what to change' },
        { label: 'Remove tools', description: 'choose the registrations and plugins to remove' },
        { label: 'claude-hud settings', description: 'the status line and its recommended settings - only shown when claude-hud is installed' },
        { label: 'Done', description: 'nothing changes' } ] },
    settings: { id: 'settings', header: 'Settings', multiSelect: false, question: 'How do you want to set the tools up?', options: [
        { label: `Use the recommended settings for all${REC}`, description: 'route, scope, name and location as recommended' },
        { label: 'Set each tool', description: 'ask route, scope, name and location per tool' } ] },
    apply: { id: 'apply', header: 'Apply', multiSelect: false, question: 'Apply this plan?', options: [
        { label: `Apply${REC}`, description: 'runs the calls above in order, stops at the first failure' },
        { label: 'Change something', description: 'go back to the answers' },
        { label: 'Cancel', description: 'nothing is applied' } ] },
    removeFirst: { id: 'remove-first', header: 'Remove', multiSelect: false, question: 'Remove what?', options: [
        { label: `Pick which${REC}`, description: 'choose the registrations and plugins to remove' },
        { label: 'Cancel', description: 'nothing is removed' } ] },
    fixOffer: { id: 'fix-offer', header: 'Fix', multiSelect: false, question: 'Apply the fixes found?', options: [
        { label: `Apply all found${REC}`, description: 'apply every fix listed that can be applied' },
        { label: 'Pick which', description: 'choose among them' },
        { label: 'Skip', description: 'nothing changes' } ] },
    updateOffer: { id: 'update-offer', header: 'Update', multiSelect: false, question: 'Update what is behind?', options: [
        { label: `All of them${REC}`, description: 'update everything offered' },
        { label: 'Pick which', description: 'choose among them' },
        { label: 'Skip', description: 'nothing changes' } ] },
    prereqMissing: (tool, need) => ({ id: `prereq-${tool}`, header: 'Missing', multiSelect: false, question: `${tool} needs ${need}, which is missing. What now?`, options: [
        { label: `Skip this tool${REC}`, description: 'leave it out of the plan' },
        { label: 'Install it now', description: 'run the install line shown, or install it yourself and re-check' },
        { label: 'Register anyway', description: 'register it; it will not start until the prerequisite is there' } ] }),
    hud: (n, m, k) => ({ id: 'hud', header: 'claude-hud', multiSelect: false, question: `Apply the recommended claude-hud settings? ${n} missing, ${m} differing, ${k} matching.`, options: [
        { label: `Apply recommended${REC}`, description: 'adds only the missing keys; every value already chosen is kept' },
        { label: 'Apply and replace differing', description: 'adds the missing keys and overwrites the differing ones' },
        { label: 'Skip', description: 'nothing changes' } ] }),
};

// ---- the root questions (spec D2) ----------------------------------------------------------------------------------
// One question per scope family a pick or a recorded answer needs, never per tool. 'A folder you name' is asked next, in
// one plain line.
const ROOT_HEADER = { project: 'Project root', global: 'Global root' };
const ROOT_TEXT = {
    project: "Which folder holds this project's keys, key helper and tool data (project and local scope)?",
    global: 'Which folder holds the keys, key helper and tool data for every project (global scope)?',
};

// A pick needs a root when it has a data folder or a key: the key file and the helper live in the root.
function needsRoot(row, routeId)
{
    if (row.kind !== 'mcp') return false;
    const route = row.routes && row.routes[routeId];
    return Boolean(row.locations) || Boolean(route && (route.tokenVar || route.helper));
}

// The families the questions input needs a root for: each pick at its answered (else recommended) scope, and each answer
// in `existing`, recorded in the project root (a registration at project or local scope, a plugin's server) or the global
// root (a user registration, a connector).
function rootFamilies(inv, picks, catalog, ctx)
{
    const out = new Set();
    const routes = (picks && picks.routes) || {};
    const scopes = (picks && picks.scopes) || {};
    for (const id of (picks && picks.rows) || [])
    {
        const row = catalog.byId.get(id);
        if (!row) continue;
        const routeId = routes[id] || row.recommendedRoute;
        if (!needsRoot(row, routeId)) continue;
        const scope = scopes[id] || scopeOrder(row, inv, { route: routeId, ctx, copyOf: installedOf(inv, id) })[0];
        out.add(roots.familyOf(scope));
    }
    for (const key of Object.keys((picks && picks.existing) || {}))
    {
        const m = /^mcp:.+~(local|project|user)$/.exec(key);
        if (m) out.add(roots.familyOf(m[1]));
        else if (key.startsWith('plugin-mcp:')) out.add('project');
        else if (key.startsWith('connector:')) out.add('global');
    }
    return ['project', 'global'].filter((f) => out.has(f));
}

// -> { question, answers: { <label as shown>: { family, id, root } } }
function rootQuestion(inv, family, ctx)
{
    const opts = roots.options(inv, family, ctx).map((o, i) => ({ ...o, label: `${o.label}${i === 0 ? REC : ''}` }));
    return {
        question: { id: `root-${family}`, header: ROOT_HEADER[family], multiSelect: false, question: ROOT_TEXT[family], options: opts.map((o) => ({ label: o.label, description: o.description })) },
        answers: Object.fromEntries(opts.map((o) => [o.label, { family, id: o.id, root: o.root }])),
    };
}

function rootsBlock(inv, picks, catalog, ctx)
{
    const out = { questions: [], answers: {} };
    for (const family of rootFamilies(inv, picks, catalog, ctx))
    {
        const r = rootQuestion(inv, family, { ...ctx, catalog });
        out.questions.push(r.question);
        out.answers[r.question.id] = r.answers;
    }
    return out;
}

// picks: { rows: [<row id>], routes: { <row id>: route } } for install, { targets: [<key>], routes: { <key>: route } }
// for configure; both may carry `scopes` ({ <row id or key>: scope }) and `names` ({ <row id or key>: 'keep' | <name> }),
// the answers to `first`, which place the data folder. A target's questions start from what it has now: its route,
// scope, name and data folder are 'Keep'. `env` and `home`: what the key state reads (the shell's variables, the home
// key file). plan.js --questions passes the real ones; a caller that passes none reads neither, so a test never depends
// on the shell that runs it.
function all(inv, picks, catalog, { env = {}, home = null, connectors = null } = {})
{
    const out = {
        static: { ...STATIC, hud: STATIC.hud(0, 0, 0), prereqMissing: STATIC.prereqMissing('<tool>', '<prerequisite>') },
        pick: pickQuestions(inv, catalog, picks && picks.existing), change: null, remove: removeQuestions(inv, catalog), tools: {}, targets: {},
    };
    // `exists` reads the disk: alfred-code's .alfred/.gitignore and its 2.x data decide which folders are offered
    const ctx = { project: inv.project, platform: inv.os, arch: inv.arch, home: home || require('./account.js').homeDir(process.env), env, keyHome: home, exists: (p) => fs.existsSync(p) };
    // the roots answered so far (the walk asks them before a tool's folder), else the recommended ones
    ctx.roots = roots.resolve(inv, picks && picks.roots, { ...ctx, catalog }).roots;
    out.change = changeQuestions(inv, catalog, ctx);
    const routes = (picks && picks.routes) || {};
    const scopes = (picks && picks.scopes) || {};
    const names = (picks && picks.names) || {};
    for (const id of (picks && picks.rows) || [])
    {
        const row = catalog.byId.get(id);
        if (!row) continue;
        // install only adds, so its questions never start from an installed registration
        out.tools[id] = { route: row.kind === 'mcp' ? routeQuestion(row) : null, ...toolAsk(row, inv, { route: routes[id], scope: scopes[id], name: names[id], ctx, catalog, copyOf: installedOf(inv, id) }) };
    }
    const own = new Map(require('./existing.js').ownItems(inv, catalog).map((it) => [it.key, it]));
    for (const key of (picks && picks.targets) || [])
    {
        // a root folder: D2's question, the root in use recommended (spec D7)
        const rm = /^root:(project|global)$/.exec(key);
        if (rm)
        {
            const used = rootInUse(inv, rm[1], { ...ctx, catalog });
            out.targets[key] = used ? { kind: 'root', family: rm[1], current: { path: used.path }, root: rootQuestion(inv, rm[1], { ...ctx, catalog }) } : { error: `no ${rm[1]} root is in use here` };
            continue;
        }
        // a server left on its own: one question, keep it so or hand it over (spec D6)
        if (own.has(key))
        {
            const it = own.get(key);
            out.targets[key] = { row: it.rowId, kind: 'own', current: { name: it.name || it.server || it.connector, scope: it.scope || null, route: null }, own: require('./existing.js').ownQuestion(it) };
            continue;
        }
        const t = targetOf(inv, key);
        const row = t && t.item.rowId && !t.item.alfredRetired ? catalog.byId.get(t.item.rowId) : null;
        if (!row) { out.targets[key] = { error: `'${key}' is not a catalog tool installed here` }; continue; }
        // required here, not at the top: plan.js requires this file
        const current = t.kind === 'mcp' ? E.currentOf(row, t.item) : { scope: t.item.scope };
        out.targets[key] = {
            row: row.id, kind: t.kind, current: { name: t.item.name || t.item.id, scope: t.item.scope, route: current.route || null },
            route: t.kind === 'mcp' ? routeQuestion(row, current.route) : null,
            ...toolAsk(row, inv, { route: routes[key], scope: scopes[key], name: names[key], current, ctx, catalog }),
        };
    }
    out.roots = rootsBlock(inv, picks, catalog, ctx);
    // D9, asked after the tool's questions: the key's name for each route that can use one, the settings of each stdio one
    out.keyNames = {};
    out.settings = {};
    const live = liveReader(inv.project, env);
    for (const id of (picks && picks.rows) || [])
    {
        const row = catalog.byId.get(id);
        if (!row || row.kind !== 'mcp') continue;
        const routeId = routes[id] || row.recommendedRoute;
        if (!row.routes[routeId]) continue;
        const scope = scopes[id] || scopeOrder(row, inv, { route: routeId, ctx, copyOf: installedOf(inv, id) })[0];
        const k = keyNameQuestion(row, routeId, scope, ctx);
        if (k) out.keyNames[id] = k;
        const st = settingsQuestion(row, routeId);
        if (st) out.settings[id] = st;
    }
    for (const key of (picks && picks.targets) || [])
    {
        if (own.has(key)) continue;
        const t = targetOf(inv, key);
        const row = t && t.kind === 'mcp' && t.item.rowId && !t.item.alfredRetired ? catalog.byId.get(t.item.rowId) : null;
        if (!row) continue;
        const current = E.currentOf(row, t.item);
        const routeId = routes[key] || current.route;
        const route = row.routes[routeId];
        if (!route) continue;
        const scope = scopes[key] || current.scope;
        const same = routeId === current.route;
        // the name it uses: the helper's argument; for a stdio key, the name whose value equals the key it holds
        let name = same && route.helper ? current.keyName : null;
        if (same && !route.helper && route.tokenVar)
        {
            const held = heldKey(live(t.item.name, t.item.scope) || {}, route);
            const ks = keyStateOf(row, routeId, ctx, null, scope);
            name = held && ks ? keys.nameOfValue([...ks.files, ...keys.oldFiles(ctx.project, ctx.home)], held) : null;
        }
        const k = keyNameQuestion(row, routeId, scope, ctx, { current: name });
        if (k) out.keyNames[key] = k;
        const st = settingsQuestion(row, routeId, { entry: same ? t.item.entry : null });
        if (st) out.settings[key] = st;
    }
    return out;
}

module.exports = { keyNameQuestion, settingsQuestion, liveReader, heldKey, SCOPE_LABEL, scopeOfLabel, needsRoot, rootFamilies, rootQuestion, REC, recommendedScope, keyStateOf, keyToSend, pickQuestions, changeQuestions, routeQuestion, toolQuestions, toolAsk, scopeQuestion, nameQuestion, locationQuestion, removeQuestions, packed, STATIC, all, chunk, scopesFor };
