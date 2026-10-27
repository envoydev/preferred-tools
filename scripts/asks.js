'use strict';
// EVERY QUESTION THE WALK ASKS, as data. A question is { id, header, question, multiSelect, options: [{ label, description }] }:
// 2 to 4 options, exactly one marked '(Recommended)' and listed first on a single-select; a call carries 1 to 4 questions.
// 'Other' is added by AskUserQuestion itself and never listed here.
const path = require('node:path');
const E = require('./entries.js');
const { installedOf } = require('./inventory.js');

const REC = ' (Recommended)';
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

const labelOf = (row, inv) =>
{
    const have = installedOf(inv, row.id);
    if (!have.length) return row.label;
    const tags = have.map((h) => (h.kind === 'mcp' ? `${h.name}, ${h.scope}` : `${h.scope}`));
    return `${row.label} (installed as ${tags.join('; ')})`;
};

// The add-or-change pick: one multi-select per group, at most four options each, four questions a call, a second call
// past sixteen items.
function pickQuestions(inv, catalog)
{
    const qs = [];
    for (const g of catalog.groups)
    {
        const rows = catalog.tools.filter((r) => r.group === g.id && r.os.includes(inv.os));
        for (const part of chunk(rows, 4))
            qs.push({
                id: `pick-${g.id}`, header: HEADER[g.id], multiSelect: true,
                question: `${g.label}: which tools do you want to add or change?`,
                options: part.map((r) => ({ label: labelOf(r, inv), description: r.summary })),
            });
    }
    return chunk(qs, 4);
}

function routeQuestion(row)
{
    const ids = Object.keys(row.routes);
    if (ids.length < 2) return null;
    const first = row.recommendedRoute;
    const order = [first, ...ids.filter((i) => i !== first)];
    const text = { remote: 'hosted by the vendor - no local runtime needed', local: 'runs on this machine' };
    return {
        id: `route-${row.id}`, header: 'Route', multiSelect: false, question: `${row.label}: remote or local?`,
        options: order.map((r, i) => ({ label: `${r === 'remote' ? 'Remote' : 'Local'}${i === 0 ? REC : ''}`, description: text[r] })),
    };
}

const scopesFor = (row, routeId) => (row.kind === 'plugin' ? ['project', 'local', 'user'] : ['local', 'project', 'user'].filter((s) => s !== 'project' || row.routes[routeId].projectScope));

// The one call of up to four questions for a tool: scope, name, location, and one tool-specific extra.
function toolQuestions(row, inv, { route, current = null, ctx = null, catalog } = {})
{
    const routeId = route || (current && current.route) || row.recommendedRoute;
    const qs = [];
    const rec = current ? current.scope : recommendedScope(row, routeId);
    const scopes = scopesFor(row, routeId);
    const order = [rec, ...scopes.filter((s) => s !== rec)].filter((s) => scopes.includes(s));
    qs.push({
        id: `scope-${row.id}`, header: 'Scope', multiSelect: false, question: `${row.label}: which scope?`,
        options: order.slice(0, 4).map((s, i) => ({ label: `${s}${i === 0 ? REC : ''}`, description: SCOPE_TEXT[s] })),
    });
    if (row.kind === 'plugin') return qs.concat(row.settingsRow ? [] : []);

    const orig = row.name;
    const proj = ctx ? `${path.basename(ctx.project).replace(/[^A-Za-z0-9_-]+/g, '-')}-${orig}`.slice(0, 64) : `project-${orig}`;
    const nameOpts = current && current.name !== orig
        ? [{ label: `Keep \`${current.name}\`${REC}`, description: 'the name it has now' }, { label: `Use \`${orig}\``, description: 'the original name' }]
        : [{ label: `Keep \`${orig}\`${REC}`, description: 'the original name' }, { label: `Use \`${proj}\``, description: 'a per-project name' }];
    qs.push({ id: `name-${row.id}`, header: 'Name', multiSelect: false, question: `${row.label}: registration name?`, options: nameOpts });

    if (row.locations && ctx)
    {
        const d = E.defaultRoot(row, current ? current.name : orig, ctx);
        const other = E.otherSide(row, current ? current.name : orig);
        const show = (r) => (r.kind === 'home' ? `~/${r.rel}` : r.kind === 'project' ? r.rel : r.path);
        const opts = [];
        if (d.needsInput) opts.push({ label: `Another folder${REC}`, description: d.needsInput });
        else
        {
            const keep = current && current.rootStr ? current.rootStr : show(d.root);
            opts.push({ label: `Keep \`${keep}\`${REC}`, description: d.existing ? 'your existing alfred-code data' : 'the default data folder' });
            if (row.locations.windowsAbsolute && ctx.platform === 'win32') opts.push({ label: 'Another space-free folder', description: 'type an absolute path without spaces under Other' });
            else opts.push({ label: `Use \`${show(other)}\``, description: other.kind === 'home' ? 'the account folder, shared across projects' : 'the project folder' });
        }
        qs.push({ id: `location-${row.id}`, header: 'Location', multiSelect: false, question: `${row.label}: where does its data live?`, options: opts });
    }
    if (row.routes[routeId].optionalArgs && row.routes[routeId].optionalArgs.executablePath)
        qs.push({
            id: `browser-${row.id}`, header: 'Browser', multiSelect: false, question: `${row.label}: which browser binary?`,
            options: [
                { label: `Default for this engine${REC}`, description: row.id.endsWith('chrome') || row.id.endsWith('msedge') ? 'the branded browser installed on this machine' : "Playwright's own build" },
                { label: 'A browser binary I name', description: 'type the path under Other; it sets --executable-path' },
            ],
        });
    else if (row.routes[routeId].auth === 'optional-token')
        qs.push({
            id: `token-${row.id}`, header: 'API key', multiSelect: false, question: `${row.label}: send an API key?`,
            options: [
                { label: `No key - low rate limits${REC}`, description: 'works anonymously' },
                { label: `Use \${${row.routes[routeId].tokenVar}}`, description: 'registers the variable reference; the value is never written' },
            ],
        });
    else if (row.params)
        qs.push({
            id: `host-${row.id}`, header: 'Host', multiSelect: false, question: `${row.label}: which ${row.params[0].label}?`,
            options: [
                { label: `${row.params[0].default}${REC}`, description: 'the hosted service' },
                { label: 'A self-managed host', description: 'type the host name under Other' },
            ],
        });
    return qs;
}

// Remove: one option per registration or plugin (a row at two scopes is two options), grouped, four a question.
function removeQuestions(inv, catalog)
{
    const items = [];
    for (const g of catalog.groups)
        for (const row of catalog.tools.filter((r) => r.group === g.id))
            for (const h of installedOf(inv, row.id))
                items.push({ group: g, label: h.kind === 'mcp' ? `${h.name} (${row.label}, ${h.scope})` : `${row.label} (${h.scope})`, description: h.kind === 'mcp' ? `claude mcp remove ${h.name} -s ${h.scope}` : `claude plugin uninstall ${h.name} --scope ${h.scope}` });
    const qs = chunk(items, 4).map((part, i) => ({
        id: `remove-${i}`, header: 'Remove', multiSelect: true, question: 'Which of these do you want to remove?',
        options: part.map((p) => ({ label: p.label, description: p.description })),
    }));
    return chunk(qs, 4);
}

// The fixed asks of the commands, here so a test holds them to the limits.
const STATIC = {
    menu: { id: 'menu', header: 'Action', multiSelect: false, question: 'What do you want to do?', options: [
        { label: `Add or change tools${REC}`, description: 'pick tools, then route, scope, name and location' },
        { label: 'Remove tools', description: 'only shown when something is installed' },
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
        { label: `All of them${REC}`, description: 'apply every fix listed' },
        { label: 'Pick which', description: 'choose among them' },
        { label: 'Skip', description: 'nothing changes' } ] },
    updateOffer: { id: 'update-offer', header: 'Update', multiSelect: false, question: 'Update what is behind?', options: [
        { label: `All of them${REC}`, description: 'update everything offered' },
        { label: 'Pick which', description: 'choose among them' },
        { label: 'Skip', description: 'nothing changes' } ] },
    hud: (n, m, k) => ({ id: 'hud', header: 'claude-hud', multiSelect: false, question: `Apply the recommended claude-hud settings? ${n} missing, ${m} differing, ${k} matching.`, options: [
        { label: `Apply recommended${REC}`, description: 'adds only the missing keys; every value already chosen is kept' },
        { label: 'Apply and replace differing', description: 'adds the missing keys and overwrites the differing ones' },
        { label: 'Skip', description: 'nothing changes' } ] }),
};

function all(inv, picks, catalog)
{
    const out = { static: { ...STATIC, hud: STATIC.hud(0, 0, 0) }, pick: pickQuestions(inv, catalog), remove: removeQuestions(inv, catalog), tools: {} };
    for (const id of (picks && picks.rows) || [])
    {
        const row = catalog.byId.get(id);
        if (!row) continue;
        const have = installedOf(inv, id)[0];
        const ctx = { project: inv.project, platform: inv.os, arch: inv.arch, home: require('./account.js').homeDir(process.env), env: process.env };
        out.tools[id] = { route: row.kind === 'mcp' ? routeQuestion(row) : null, questions: toolQuestions(row, inv, { current: have && have.kind === 'mcp' ? { ...have, rootStr: null } : null, ctx, catalog }) };
    }
    return out;
}

module.exports = { REC, recommendedScope, pickQuestions, routeQuestion, toolQuestions, removeQuestions, STATIC, all, chunk, scopesFor };
