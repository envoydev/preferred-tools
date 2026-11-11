'use strict';
// Every question the walk can put, for the 'no text sends the user to Other' rule (spec D8): tests/lint.js checks the
// texts, tests/plan.test.js and tests/roots.test.js use the same pattern. One home for the pattern and the fixtures.
const catalogLib = require('../scripts/catalog.js');
const asks = require('../scripts/asks.js');
const existing = require('../scripts/existing.js');
const { plan } = require('../scripts/plan.js');

// alfred-code 3.9.2 stack/hooks/guard-stop-contract.js: an ask that sends the user to the Other field. 'under Other',
// which today's three typed values used, is not matched by it and is checked beside it.
const OTHER_RE = /\b(?:in|into|via|through|using) (?:the )?['‘’]?Other\b|\btype (?:it|them|\w+) (?:in|into)\b[^.]{0,20}\bOther\b/;
const sendsToOther = (text) => OTHER_RE.test(String(text)) || /under Other/.test(String(text));

const MAC = { os: 'darwin', arch: 'arm64', project: '/work/shop' };
const WIN = { os: 'win32', arch: 'x64', project: 'C:\\my work\\shop' };
// Task 4's four fixtures: macOS and a spaced Windows project and profile, each without and with alfred-code
const FIXTURES = [[MAC, '/Users/me', false], [MAC, '/Users/me', true], [WIN, 'C:\\Users\\Jo Doe', false], [WIN, 'C:\\Users\\Jo Doe', true]];
const CONNECTORS = ['Context7', 'GitHub', 'Sentry', 'Atlassian_Rovo', 'GitLab'];

const inv = (base, extra = {}) => ({ version: 1, ...base, cli: { ok: true }, unreadable: [], registrations: [], plugins: [], marketplaces: [], alfredCodeEnabled: false, sources: {}, ...extra });
const callsOf = (x) => (Array.isArray(x) ? x : (x && x.calls) || []).flat();
const qOf = (x) => (x && x.question ? [x.question] : []);

// -> [{ where, question }] over the four fixtures: the static asks, the picks, configure's groups and removes, every tool's
// and every target's questions, the roots, the key names, the settings, the servers already set up and those on their own.
function walkQuestions()
{
    const catalog = catalogLib.load();
    const out = [];
    for (const [base, home, alfred] of FIXTURES)
    {
        const where = `${base.os}${alfred ? ' with alfred-code' : ''}`;
        const rows = catalog.tools.filter((r) => r.kind === 'mcp' && !(r.platforms && !r.platforms.includes(base.os)));
        // every MCP row installed once, so each gets a configure target
        const regs = rows.map((r) =>
        {
            const p = plan(inv(base), { picks: { [r.id]: {} } }, { home, env: {}, exists: () => false, machine: { docker: true } });
            const s = p.steps.find((x) => x.op === 'mcp-add');
            return s && { name: s.name, scope: s.scope, entry: s.entry, rowId: r.id, route: s.route, own: false, alfredRetired: false };
        }).filter(Boolean);
        const pluginServers = [{ plugin: 'other-plugin@market', server: 'context7', rowId: 'context7', entry: { type: 'http', url: 'https://mcp.context7.com/mcp' } }];
        const i = inv(base, { alfredCodeEnabled: alfred, registrations: regs, pluginServers });
        const q = asks.all(i, { rows: catalog.tools.map((r) => r.id), targets: regs.map((r) => `mcp:${r.name}~${r.scope}`) }, catalog, { env: {}, home });
        const items = existing.items(i, CONNECTORS, catalog, { home, exists: () => false });
        const list = [
            ...Object.values(q.static).filter((x) => x.options), ...callsOf(q.pick), ...callsOf(q.change), ...callsOf(q.remove), ...q.roots.questions,
            ...Object.values(q.tools).flatMap((t) => [...(t.first || []), ...(t.questions || []), ...(t.route ? [t.route] : [])]),
            ...Object.values(q.targets).flatMap((t) => [...(t.first || []), ...(t.questions || []), ...(t.route ? [t.route] : [])]),
            ...Object.values(q.keyNames).flatMap(qOf), ...Object.values(q.settings).flatMap(qOf),
            ...items.flatMap((it) => qOf(existing.ownQuestion(it))),
        ];
        for (const question of list) out.push({ where, question });
    }
    return out;
}

// -> [{ where, text }]: each question's text, header, and each option's label and description
const walkTexts = () => walkQuestions().flatMap(({ where, question: x }) =>
    [x.question, x.header, ...x.options.flatMap((o) => [o.label, o.description])].filter(Boolean).map((text) => ({ where, text })));

module.exports = { OTHER_RE, sendsToOther, walkQuestions, walkTexts };
