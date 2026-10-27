#!/usr/bin/env node
'use strict';
// THE FIX ENGINE - known problems and their recorded fixes (catalog/fixes.json, detectors in scripts/fixes/).
//
//   node fix.js --detect [--only <fix id | tool | registration name>] [--json] [--project <dir>]
//   node fix.js --questions [--project <dir>]            the asks, as data (the same --only narrows it)
//   node fix.js --apply <id,id | all> [--only <x>] [--input key=value] [--project <dir>] [--tmp <dir>]
//
// A detector looks at the inventory and the machine and returns findings; a row that finds nothing is not shown. A
// registration fix edits the entry AS READ and is written through apply.js (remove, then add-json, with a rollback), one
// replace per registration however many fixes it takes. A machine fix runs its command. Every fix is read back by running
// its detector again, and the restart line comes last. A finding with `blocked` is shown and never applied; a row with
// `hold` in the catalog is listed as held and never detected.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('./catalog.js');
const inventory = require('./inventory.js');
const account = require('./account.js');
const { apply } = require('./apply.js');
const cli = require('./claude-cli.js');
const { blockingStdio } = require('./json-file.js');
const F = require('./fixes/index.js');
const { realMachine, clone } = require('./fixes/common.js');
const { deepEqual } = require('./plan.js');

function makeCtx({ inv, catalog = catalogLib.load(), env = process.env, machine, platform, arch })
{
    const p = platform || inv.os;
    return { inv, catalog, platform: p, arch: arch || inv.arch, env, home: account.homeDir(env), rules: catalog.rules, machine: machine || realMachine({ env, platform: p }) };
}

const matches = (f, only) => !only || [f.id, f.row, f.name].includes(only);

// -> { found: [finding + { kind, symptom }], held: [{ id, why }], unknown: [] }
function detectAll(ctx, { only } = {})
{
    const out = { found: [], held: [] };
    for (const fix of ctx.catalog.fixes)
    {
        if (fix.hold) { out.held.push({ id: fix.id, why: fix.hold }); continue; }
        if (!fix.os.includes(ctx.platform)) continue;
        const detect = F[fix.detect];
        if (typeof detect !== 'function') throw new Error(`fix row ${fix.id}: no function ${fix.detect} in scripts/fixes/`);
        for (const f of detect(ctx)) if (matches(f, only)) out.found.push({ ...f, kind: fix.kind, symptom: fix.symptom, documented: fix.documented !== false });
    }
    return out;
}

const where = (f) => (f.kind === 'machine' ? f.name : `${f.name} (${f.scope})`);

function render(detected)
{
    const lines = [];
    const { found, held } = detected;
    if (!found.length) lines.push('No known problem found.');
    else
    {
        lines.push(`Known problems found (${found.length}):`, '');
        const w = (k) => Math.max(...found.map((f) => k(f).length));
        const idW = w((f) => f.id);
        const toolW = w(where);
        for (const f of found)
        {
            const tail = f.blocked ? ` - NOT APPLICABLE: ${f.blocked}` : f.input ? ` - needs a folder from you: ${f.input.prompt}` : '';
            lines.push(`  ${f.id.padEnd(idW)}  ${where(f).padEnd(toolW)}  ${f.found}${tail}`);
            if (f.note) lines.push(`  ${' '.repeat(idW)}  ${' '.repeat(toolW)}  note: ${f.note}`);
        }
    }
    for (const h of held) lines.push('', `Held, not checked: ${h.id} - ${h.why}`);
    return lines.join('\n');
}

// The asks as data: the three-way choice, then, for 'Pick which', one multi-select per four fixes (grouped shape).
function questions(detected)
{
    const applicable = detected.found.filter((f) => !f.blocked);
    const ids = [...new Set(applicable.map((f) => f.id))];
    const pick = [];
    for (let i = 0; i < ids.length; i += 4)
        pick.push({
            id: 'fix-pick', header: 'Fixes', multiSelect: true, question: 'Which fixes do you want to apply?',
            options: ids.slice(i, i + 4).map((id) => ({ label: id, description: applicable.filter((f) => f.id === id).map((f) => `${where(f)}: ${f.found}`).join('; ').slice(0, 300) })),
        });
    const choose = {
        id: 'fix-choice', header: 'Fixes', multiSelect: false, question: `${ids.length} known problem${ids.length === 1 ? '' : 's'} found. Apply?`,
        options: [
            { label: 'Apply all found (Recommended)', description: 'every fix above that can be applied; each is read back' },
            ...(ids.length > 1 ? [{ label: 'Pick which', description: 'choose the fixes one group at a time' }] : []),
            { label: 'Skip', description: 'nothing changes' },
        ],
    };
    const calls = [];
    for (let i = 0; i < pick.length; i += 4) calls.push(pick.slice(i, i + 4));
    return { choose, pick: calls };
}

// ---- apply ----------------------------------------------------------------------------------------------------------

function applyFixes(ctx, ids, { only, input = {}, tmp, log = console.log, runCli = cli.run } = {})
{
    const res = { applied: [], skipped: [], failed: null, remaining: [], steps: 0 };
    const known = new Set(ctx.catalog.fixes.map((f) => f.id));
    const unknown = ids.filter((id) => id !== 'all' && !known.has(id));
    if (unknown.length) { res.failed = `unknown fix id${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`; log(res.failed); return res; }
    const detected = detectAll(ctx, { only });
    const picked = detected.found.filter((f) => ids.includes('all') || ids.includes(f.id));
    if (!picked.length) { log('Nothing to apply: no picked problem is found any more.'); return res; }

    for (const f of picked.filter((x) => x.blocked || (x.input && !input[x.input.id])))
    {
        res.skipped.push(f);
        log(`skipped ${f.id} on ${where(f)}: ${f.blocked || `needs --input ${f.input.id}=<value> (${f.input.prompt})`}`);
    }
    const todo = picked.filter((x) => !res.skipped.includes(x));

    // registration fixes: one replace per registration, the fixes composed in the catalog's order
    const steps = [];
    const order = ctx.catalog.fixes.map((x) => x.id);
    const groups = new Map();
    for (const f of todo.filter((x) => x.kind === 'registration')) groups.set(`${f.scope}\u0000${f.name}`, [...(groups.get(`${f.scope}\u0000${f.name}`) || []), f]);
    for (const list of groups.values())
    {
        const reg = ctx.inv.registrations.find((r) => r.name === list[0].name && r.scope === list[0].scope);
        let entry = clone(reg.entry);
        try
        {
            for (const f of list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)))
                entry = F[ctx.catalog.fixes.find((x) => x.id === f.id).fix](entry, f, ctx, input);
        }
        catch (e) { res.failed = `${list[0].name}: ${e.message}`; log(`FAILED ${res.failed}`); return res; }
        if (deepEqual(entry, reg.entry)) continue;
        steps.push({ op: 'mcp-replace', name: reg.name, scope: reg.scope, entry, old: reg.entry, row: reg.rowId, why: `${list.map((x) => x.id).join(' + ')}: rewrite '${reg.name}' from the registration as read` });
    }
    res.steps = steps.length;
    if (steps.length)
    {
        const plan = { version: 1, project: ctx.inv.project, os: ctx.platform, steps, notes: [], errors: [], expect: steps.map((s) => ({ kind: 'mcp', name: s.name, scope: s.scope, route: ctx.inv.registrations.find((r) => r.name === s.name && r.scope === s.scope).route })) };
        const report = apply(plan, { env: ctx.env, tmp: tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'preferred-tools-fix-')), runCli, log });
        if (report.failed) { res.failed = report.failed.detail; return res; }
    }

    // machine fixes
    for (const f of todo.filter((x) => x.kind === 'machine'))
    {
        const r = F[ctx.catalog.fixes.find((x) => x.id === f.id).fix](f, ctx);
        log(`${r.ok ? 'ok    ' : 'FAILED'} ${f.id}: ${r.detail}`);
        if (!r.ok) { res.failed = r.detail; return res; }
    }

    // read back: the same detectors, run again on what is installed now
    const after = detectAll({ ...ctx, inv: inventory.buildInventory({ project: ctx.inv.project, env: ctx.env }) }, { only });
    for (const f of todo)
    {
        const left = after.found.some((a) => a.id === f.id && a.name === f.name && a.scope === f.scope);
        (left ? res.remaining : res.applied).push(f);
        log(`${left ? 'STILL FOUND' : 'fixed      '} ${f.id} on ${where(f)}`);
    }
    if (res.applied.length) log('', 'Restart Claude Code so the repaired registrations and the language server start fresh.');
    return res;
}

// ---- CLI ------------------------------------------------------------------------------------------------------------

function parseArgs(argv)
{
    const args = { input: {} };
    const value = (i, flag) =>
    {
        const v = argv[i + 1];
        if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag} needs a value`);
        return v;
    };
    for (let i = 0; i < argv.length; i++)
    {
        const a = argv[i];
        if (['--detect', '--questions', '--json'].includes(a)) { args[a.slice(2)] = true; continue; }
        if (!['--apply', '--only', '--input', '--project', '--tmp'].includes(a)) throw new Error(`unknown argument '${a}'`);
        const v = value(i, a);
        i++;
        if (a === '--input')
        {
            const eq = v.indexOf('=');
            if (eq < 1) throw new Error('--input needs key=value');
            args.input[v.slice(0, eq)] = v.slice(eq + 1);
        }
        else
        {
            if (Object.hasOwn(args, a.slice(2))) throw new Error(`${a} is given twice`);
            args[a.slice(2)] = v;
        }
    }
    const modes = ['detect', 'questions', 'apply'].filter((m) => args[m]);
    if (modes.length !== 1) throw new Error('give exactly one of --detect, --questions or --apply');
    return args;
}

function main(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), machine } = {})
{
    let args;
    try { args = parseArgs(argv); }
    catch (e) { out(`fix: ${e.message}\nusage: node scripts/fix.js --detect | --questions | --apply <id,id|all> [--only <x>] [--input key=value] [--project <dir>]`); return 2; }
    const project = path.resolve(args.project || process.cwd());
    const inv = inventory.buildInventory({ project, env });
    if (!inv.cli.ok) { out('preferred-tools: the claude CLI is not on PATH - install Claude Code, then run this again.'); return 3; }
    const ctx = makeCtx({ inv, env, machine });
    if (args.apply) return applyFixes(ctx, args.apply.split(',').filter(Boolean), { only: args.only, input: args.input, tmp: args.tmp, log: (...a) => out(a.join(' ')) }).failed ? 1 : 0;
    const detected = detectAll(ctx, { only: args.only });
    if (args.questions) out(JSON.stringify(questions(detected), null, 2));
    else out(args.json ? JSON.stringify(detected, null, 2) : render(detected));
    return 0;
}

if (require.main === module) { blockingStdio(); process.exit(main(process.argv.slice(2))); }
module.exports = { makeCtx, detectAll, applyFixes, render, questions, parseArgs, main };
