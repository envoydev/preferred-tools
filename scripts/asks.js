'use strict';
// EVERY QUESTION THE WALK ASKS, as data. A question is { id, header, question, multiSelect, options: [{ label, description }] }:
// 2 to 4 options, exactly one marked '(Recommended)' and listed first on a single-select; a call carries 1 to 4 questions.
// 'Other' is added by AskUserQuestion itself and never listed here.
const path = require('node:path');
const E = require('./entries.js');
const { installedOf, keyOf, targetOf, fromHere, otherWindowsMcp } = require('./inventory.js');
const { pinOf } = require('./table.js');

const REC = ' (Recommended)';
// The `remote` route is worded 'hosted' in every ask: alfred-code's stop guard reads a bare 'remote' in an ask as git
// state and sends Claude to fetch and re-ask (docs/sources.md, 'alfred-code hooks over the commands').
const ROUTE_WORD = { remote: 'hosted', local: 'local' };
const HEADER = { code: 'Code', docs: 'Docs, forges', browsers: 'Browsers', machine: 'Machine' };
const SCOPE_TEXT = {
    local: 'this project, on this machine only (kept in your account file)',
    project: "this project, for everyone who opens it (the committed .mcp.json - relative paths and ${VAR} only)",
    user: 'every project on this machine',
};

// local for a local route (its paths and Python are this machine's); project for a remote route whose entry holds no secret
const recommendedScope = (row, routeId) => (row.kind === 'plugin' ? row.recommendedScope : routeId === 'remote' ? 'project' : 'local');

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

function pickQuestions(inv, catalog)
{
    const items = [];
    for (const g of catalog.groups)
        for (const row of catalog.tools.filter((r) => r.group === g.id && r.os.includes(inv.os) && offeredForInstall(r, inv)))
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
            const warn = others.length ? `; another windows-mcp already starts here (${others.join(', ')}) - keep one per desktop` : '';
            items.push({ group: g, label: `${row.label}${tags.length ? ` (${tags.join('; ')})` : ''}`, description: `${have.length ? `adds this project's own copy; ${keep} - ${row.summary}` : row.summary}${warn}` });
        }
    return packed(items, { id: 'pick', question: 'which tools do you want to install?', none: 'install nothing' });
}

// Every catalog registration and plugin installed here, one item each (a row at two scopes is two), grouped. An
// inherited server is not here: it is changed by running the command in its own folder.
function installedItems(inv, catalog, describe)
{
    const items = [];
    for (const g of catalog.groups)
        for (const row of catalog.tools.filter((r) => r.group === g.id))
            for (const h of installedOf(inv, row.id).filter((x) => x.scope !== 'inherited'))
                items.push({ group: g, row, h, label: h.kind === 'mcp' ? `${h.name} (${row.label}, ${h.scope})` : `${row.label} (${h.scope})`, description: describe(row, h) });
    return items;
}

// The configure pick: one option per installed registration or plugin. `keys` maps each label to the key the answers
// use (`mcp:<name>~<scope>`, `plugin:<id>~<scope>`).
function changeQuestions(inv, catalog)
{
    const describe = (row, h) =>
    {
        if (h.kind === 'plugin') return `${h.version ? `version ${h.version}` : 'installed'}${h.enabled ? '' : ', disabled'}`;
        const pin = pinOf(row, h.route, h.entry);
        return `${ROUTE_WORD[h.route] || h.route} route${pin ? `, pin ${pin}` : ''}`;
    };
    const items = installedItems(inv, catalog, describe);
    return {
        calls: packed(items, { id: 'change', question: 'which do you want to change?', none: 'change nothing' }),
        keys: Object.fromEntries(items.map((i) => [i.label, keyOf(i.h.kind, i.h.name, i.h.scope)])),
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

const scopesFor = (row, routeId) => (row.kind === 'plugin' ? ['project', 'local', 'user'] : ['local', 'project', 'user'].filter((s) => s !== 'project' || row.routes[routeId].projectScope));

// The one call of up to four questions for a tool: scope, name, location, and one tool-specific extra. `current` is the
// registration configure changes; for an install, `copyOf` lists this row's registrations at other scopes (the copy for
// every project), whose scopes are not offered again - with one scope left, the scope question is left out.
function toolQuestions(row, inv, { route, current = null, ctx = null, catalog, copyOf = [] } = {})
{
    const routeId = route || (current && current.route) || row.recommendedRoute;
    const qs = [];
    const rec = current ? current.scope : recommendedScope(row, routeId);
    const all = scopesFor(row, routeId);
    const free = all.filter((s) => !copyOf.some((c) => c.scope === s));
    const scopes = free.length ? free : all;
    const order = [rec, ...scopes.filter((s) => s !== rec)].filter((s) => scopes.includes(s));
    if (order.length > 1)
        qs.push({
            id: `scope-${row.id}`, header: 'Scope', multiSelect: false,
            question: current ? `${row.label}: which scope? Another one moves '${current.name || row.label}' there; /preferred-tools:install adds a second copy instead.` : `${row.label}: which scope?`,
            options: order.slice(0, 4).map((s, i) => ({ label: `${s}${i === 0 ? REC : ''}`, description: SCOPE_TEXT[s] })),
        });
    if (row.kind === 'plugin') return qs;

    const orig = row.name;
    const proj = ctx ? `${path.basename(ctx.project).replace(/[^A-Za-z0-9_-]+/g, '-')}-${orig}`.slice(0, 64) : `project-${orig}`;
    const shadows = copyOf.find((c) => c.name === orig);
    const nameOpts = current && current.name !== orig
        ? [{ label: `Keep \`${current.name}\`${REC}`, description: 'the name it has now' }, { label: `Use \`${orig}\``, description: 'the original name' }]
        : [{ label: `Keep \`${orig}\`${REC}`, description: shadows ? `the original name; in this project it is used instead of ${shadows.scope === 'inherited' ? `the one inherited from ${fromHere(inv, shadows.from)}` : 'the copy for every project'}` : 'the original name' }, { label: `Use \`${proj}\``, description: 'a per-project name' }];
    qs.push({ id: `name-${row.id}`, header: 'Name', multiSelect: false, question: `${row.label}: registration name?`, options: nameOpts });

    if (row.locations && ctx)
    {
        const d = E.defaultRoot(row, current ? current.name : orig, ctx);
        const other = E.otherSide(row, current ? current.name : orig);
        const show = (r) => (r.kind === 'home' ? `~/${r.rel}` : r.kind === 'project' ? r.rel : r.path);
        const opts = [];
        const winAbs = row.locations.windowsAbsolute && ctx.platform === 'win32';
        if (d.needsInput) opts.push({ label: `Another folder${REC}`, description: d.needsInput });
        else if (!current && copyOf.length && row.locations.defaultSide === 'account' && !winAbs)
        {
            // a project's own copy gets its own data by default (plan.js wantedRoot does the same)
            opts.push({ label: `Use \`${show(E.otherPlace(row, orig, 'project'))}\`${REC}`, description: "the project folder - its own data, starting empty; the copy for every project's data is not seen in this project" });
            opts.push({ label: `Keep \`${show(d.root)}\``, description: 'the default folder - shares the data of the copy for every project' });
        }
        else
        {
            const keep = current && current.rootStr ? current.rootStr : show(d.root);
            opts.push({ label: `Keep \`${keep}\`${REC}`, description: current && current.rootStr ? 'the folder it uses now' : 'the default data folder' });
            if (!current && d.alfred && !winAbs) opts.push({ label: `Use alfred-code's \`${show(d.alfred)}\``, description: "carries over the data alfred-code's server left there - the folder is alfred-code's, so deleting it erases this tool's data" });
            if (winAbs) opts.push({ label: 'Another space-free folder', description: 'type an absolute path without spaces under Other' });
            else opts.push({ label: `Use \`${show(other)}\``, description: other.kind === 'home' ? 'the account folder, shared across projects' : 'the project folder' });
        }
        qs.push({ id: `location-${row.id}`, header: 'Location', multiSelect: false, question: `${row.label}: where does its data live?`, options: opts });
    }
    // what the registration has now goes first, so a configure walk recommends keeping it
    const first = (opts, keepFirst) => (keepFirst ? [opts[1], opts[0]] : opts).map((o, i) => ({ ...o, label: `${o.label}${i === 0 ? REC : ''}` }));
    const sameRoute = current && current.route === routeId;
    if (row.routes[routeId].optionalArgs && row.routes[routeId].optionalArgs.executablePath)
        qs.push({
            id: `browser-${row.id}`, header: 'Browser', multiSelect: false, question: `${row.label}: which browser binary?`,
            options: sameRoute && current.executablePath
                ? first([{ label: `Keep \`${current.executablePath}\``, description: 'the binary it uses now' }, { label: 'Default for this engine', description: 'drops --executable-path' }])
                : first([
                    { label: 'Default for this engine', description: row.id.endsWith('chrome') || row.id.endsWith('msedge') ? 'the branded browser installed on this machine' : "Playwright's own build" },
                    { label: 'A browser binary I name', description: 'type the path under Other; it sets --executable-path' },
                ]),
        });
    else if (row.routes[routeId].auth === 'optional-token')
        qs.push({
            id: `token-${row.id}`, header: 'API key', multiSelect: false, question: `${row.label}: send an API key?`,
            options: first([
                { label: 'No key - low rate limits', description: 'works anonymously' },
                { label: `Use \${${row.routes[routeId].tokenVar}}`, description: 'registers the variable reference; the value is never written' },
            ], Boolean(sameRoute && current.token)),
        });
    else if (row.params)
    {
        const host = current && current.host && current.host !== row.params[0].default ? current.host : null;
        qs.push({
            id: `host-${row.id}`, header: 'Host', multiSelect: false, question: `${row.label}: which ${row.params[0].label}?`,
            options: host
                ? first([{ label: `Keep ${host}`, description: 'the host it uses now' }, { label: row.params[0].default, description: 'the hosted service' }])
                : first([{ label: row.params[0].default, description: 'the hosted service' }, { label: 'A self-managed host', description: 'type the host name under Other' }]),
        });
    }
    return qs;
}

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
        { label: `Change tools${REC}`, description: 'pick installed tools, then route, scope, name and location' },
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

// picks: { rows: [<row id>], routes: { <row id>: route } } for install, { targets: [<key>], routes: { <key>: route } }
// for configure. A target's questions start from what it has now: its route, scope, name and data folder are 'Keep'.
function all(inv, picks, catalog)
{
    const out = {
        static: { ...STATIC, hud: STATIC.hud(0, 0, 0), prereqMissing: STATIC.prereqMissing('<tool>', '<prerequisite>') },
        pick: pickQuestions(inv, catalog), change: changeQuestions(inv, catalog), remove: removeQuestions(inv, catalog), tools: {}, targets: {},
    };
    const ctx = { project: inv.project, platform: inv.os, arch: inv.arch, home: require('./account.js').homeDir(process.env), env: process.env };
    const routes = (picks && picks.routes) || {};
    for (const id of (picks && picks.rows) || [])
    {
        const row = catalog.byId.get(id);
        if (!row) continue;
        // install only adds, so its questions never start from an installed registration
        out.tools[id] = { route: row.kind === 'mcp' ? routeQuestion(row) : null, questions: toolQuestions(row, inv, { route: routes[id], ctx, catalog, copyOf: installedOf(inv, id) }) };
    }
    for (const key of (picks && picks.targets) || [])
    {
        const t = targetOf(inv, key);
        const row = t && t.item.rowId && !t.item.alfredRetired ? catalog.byId.get(t.item.rowId) : null;
        if (!row) { out.targets[key] = { error: `'${key}' is not a catalog tool installed here` }; continue; }
        // required here, not at the top: plan.js requires this file
        const current = t.kind === 'mcp' ? require('./plan.js').currentOf(row, t.item) : { scope: t.item.scope };
        out.targets[key] = {
            row: row.id, kind: t.kind, current: { name: t.item.name || t.item.id, scope: t.item.scope, route: current.route || null },
            route: t.kind === 'mcp' ? routeQuestion(row, current.route) : null,
            questions: toolQuestions(row, inv, { route: routes[key], current, ctx, catalog }),
        };
    }
    return out;
}

module.exports = { REC, recommendedScope, pickQuestions, changeQuestions, routeQuestion, toolQuestions, removeQuestions, packed, STATIC, all, chunk, scopesFor };
