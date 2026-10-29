#!/usr/bin/env node
'use strict';
// APPLY - runs a plan's operations in order through the `claude` CLI, reads each back, and stops at the first failure.
//
//   node apply.js <plan.json> [--tmp <dir>]
//
// The CLI is the only writer of .mcp.json and the account file; this file only reads them back. Everything applied
// before a failure stays in place and is named. An empty plan makes no call at all and says so.
//
// A rewrite that could lose a server (same-name replace) saves the old JSON to <tmp>/rollback.json first and re-adds it
// when the add fails; a rename or a scope move adds the new registration FIRST, reads it back, and only then removes the
// old one, so a failed add leaves the old one running.
//
// A plan's fetch steps are not run here. They go to <tmp>/fetch.json with the names of the servers written, for fetch.js:
// a first download takes minutes, and a command cut off by its time limit must never leave half a plan applied.
//
// A plan read from the commands' files carries each credential value as kept.js's marker (inventory.js writes it so).
// Before a replace or a move, the real values are taken back in this process from the registration as it is now, and a
// registration that changed since it was read stops the step. No file under <tmp> and no printed line holds a live value:
// rollback.json is kept, and a restore line shows the marker in place of the key.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('./claude-cli.js');
const account = require('./account.js');
const inventory = require('./inventory.js');
const fetchLib = require('./fetch.js');
const { argvOf, deepEqual } = require('./plan.js');
const { blockingStdio } = require('./json-file.js');
const kept = require('./kept.js');
const keys = require('./keys.js');
const catalogLib = require('./catalog.js');
const tmpdir = require('./tmpdir.js');

const SCRIPTS = __dirname;
const quote = (s) => (/^[A-Za-z0-9_\-./:=@,+]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const restoreLine = (name, scope, entry) => `claude mcp add-json ${quote(name)} ${quote(JSON.stringify(entry))} -s ${scope}`;
// the line that puts a registration back by hand, its credential values as the marker
function restoreBy(ctx, step, name, scope, entry)
{
    const k = kept.keep(entry, rowOf(ctx, step));
    return `${restoreLine(name, scope, k)}${kept.holdsKept(k) ? ` - put the real value back in place of ${kept.MARKER}` : ''}`;
}
const rowOf = (ctx, step) => (step.row ? ctx.catalog.byId.get(step.row) || null : null);

const readRegistration = account.readRegistration;

function makeRunner({ project, env, runCli })
{
    return (argv) =>
    {
        const r = runCli(argv, { cwd: project, env });
        return { ok: !r.error && r.status === 0, out: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-3).join(' | '), r };
    };
}

function addAndVerify(call, ctx, name, scope, entry)
{
    const a = call(['mcp', 'add-json', name, JSON.stringify(entry), '-s', scope]);
    if (!a.ok) return { ok: false, detail: `claude mcp add-json ${name} -s ${scope} failed: ${a.out}` };
    const got = readRegistration(name, scope, ctx.project, ctx.env);
    if (!got || !deepEqual(got, entry)) return { ok: false, detail: `'${name}' at ${scope} scope did not read back as written` };
    return { ok: true, detail: `added '${name}' at ${scope} scope` };
}

function removeAndVerify(call, ctx, name, scope)
{
    const r = call(['mcp', 'remove', name, '-s', scope]);
    if (!r.ok) return { ok: false, detail: `claude mcp remove ${name} -s ${scope} failed: ${r.out}` };
    if (readRegistration(name, scope, ctx.project, ctx.env)) return { ok: false, detail: `'${name}' is still at ${scope} scope after the remove` };
    return { ok: true, detail: `removed '${name}' from ${scope} scope` };
}

// A replace or a move read from a kept plan gets its real values back from the registration it was read from: the old
// name and scope for a move, its own for a replace. -> { step } | { error }
function restoreStep(step, ctx)
{
    if (!['mcp-add', 'mcp-replace', 'mcp-move'].includes(step.op) || !(kept.holdsKept(step.entry) || kept.holdsKept(step.old))) return { step };
    if (step.op === 'mcp-add') return { error: `'${step.name}' holds a kept value and no registration to take it from - run the command again` };
    const from = step.op === 'mcp-move' ? step.from : { name: step.name, scope: step.scope };
    const changed = { error: `'${from.name}' changed since it was read - run the command again` };
    const source = readRegistration(from.name, from.scope, ctx.project, ctx.env);
    const row = rowOf(ctx, step);
    if (!source || (step.old && !deepEqual(kept.keep(source, row), step.old))) return changed;
    const entry = kept.restore(step.entry, source, row);
    return entry.error ? changed : { step: { ...step, entry: entry.entry, old: step.old ? source : step.old } };
}

// The key of a token route, set just before the add by the TARGET scope (keys.js): the ${VAR} form into .mcp.json, the
// key file's value into a local or user registration. -> { step, note } - the note names the key and the file, never a
// value.
function fillStep(step, ctx)
{
    if (!['mcp-add', 'mcp-replace', 'mcp-move'].includes(step.op)) return { step, note: null };
    const m = step.row && step.route ? null : inventory.matchEntry(step.entry, ctx.catalog);
    const row = rowOf(ctx, step) || (m && ctx.catalog.byId.get(m.rowId)) || null;
    if (!row || row.kind !== 'mcp') return { step, note: null };
    const routeId = step.route || (m && m.route);
    const to = step.op === 'mcp-move' ? step.to : { name: step.name, scope: step.scope };
    const fromUser = (step.op === 'mcp-move' ? step.from.scope : step.scope) === 'user';
    const r = keys.keysInto(step.entry, row, routeId, to.scope, { project: ctx.project, env: ctx.env, alfredEnabled: ctx.alfredEnabled, name: to.name, before: to.scope === 'user' && fromUser ? step.old : null });
    return { step: { ...step, entry: r.entry }, note: r.note };
}

function pluginState(ctx, id, scope)
{
    const inv = inventory.buildInventory({ project: ctx.project, env: ctx.env });
    return inv.plugins.find((p) => p.id === id && p.scope === scope);
}

// One operation. { ok, detail, extra[] }
function runStep(step, ctx)
{
    const call = ctx.call;
    switch (step.op)
    {
        case 'ensure-dir': {
            const existed = fs.existsSync(step.path);
            fs.mkdirSync(step.path, { recursive: true });
            if (!existed) fs.writeFileSync(path.join(step.path, '.gitignore'), '*\n');
            return { ok: true, detail: existed ? `${step.path} exists - left as it is` : `created ${step.path} with a .gitignore holding *` };
        }
        case 'ensure-ignore': {
            const file = path.join(step.path, '.gitignore');
            if (fs.existsSync(file)) return { ok: true, detail: `${file} exists - left as it is` };
            fs.mkdirSync(step.path, { recursive: true });
            fs.writeFileSync(file, '*\n');
            return { ok: true, detail: `wrote ${file} holding *` };
        }
        case 'mcp-add': return addAndVerify(call, ctx, step.name, step.scope, step.entry);
        case 'mcp-remove': return removeAndVerify(call, ctx, step.name, step.scope);
        case 'mcp-replace': {
            const file = path.join(ctx.tmp, 'rollback.json');
            fs.mkdirSync(ctx.tmp, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ name: step.name, scope: step.scope, entry: kept.keep(step.old, rowOf(ctx, step)), project: ctx.project }, null, 2));
            const rm = removeAndVerify(call, ctx, step.name, step.scope);
            if (!rm.ok) return { ok: false, detail: `${rm.detail} - the old entry is untouched or restored by hand: ${restoreBy(ctx, step, step.name, step.scope, step.old)}` };
            const add = addAndVerify(call, ctx, step.name, step.scope, step.entry);
            if (add.ok) return { ok: true, detail: `rewrote '${step.name}' at ${step.scope} scope (old entry saved in ${file})` };
            const back = addAndVerify(call, ctx, step.name, step.scope, step.old);
            return { ok: false, detail: `${add.detail}; ${back.ok ? 'the old entry was re-added' : `RESTORE BY HAND: ${restoreBy(ctx, step, step.name, step.scope, step.old)}`}` };
        }
        case 'mcp-move': {
            const add = addAndVerify(call, ctx, step.to.name, step.to.scope, step.entry);
            if (!add.ok) return { ok: false, detail: `${add.detail}; the old '${step.from.name}' at ${step.from.scope} scope is untouched` };
            const rm = removeAndVerify(call, ctx, step.from.name, step.from.scope);
            if (!rm.ok) return { ok: false, detail: `${rm.detail}; the new one is in place, the old one is still there - remove it by hand: claude mcp remove ${step.from.name} -s ${step.from.scope}` };
            return { ok: true, detail: `moved '${step.from.name}' (${step.from.scope}) to '${step.to.name}' (${step.to.scope}): added, read back, old removed` };
        }
        case 'plugin-marketplace-add': {
            const r = call(argvOf(step));
            if (!r.ok) return { ok: false, detail: `claude plugin marketplace add ${step.source} failed: ${r.out}` };
            const list = ctx.runCli(['plugin', 'marketplace', 'list', '--json'], { cwd: ctx.project, env: ctx.env });
            let names = [];
            try { names = JSON.parse(list.stdout || '[]').map((m) => m.name); } catch { /* read-back failed below */ }
            return names.includes(step.name) ? { ok: true, detail: `marketplace ${step.name} registered` } : { ok: false, detail: `marketplace ${step.name} not in the list after the add` };
        }
        case 'plugin-install': case 'plugin-enable': {
            const r = call(argvOf(step));
            if (!r.ok) return { ok: false, detail: `claude ${argvOf(step).join(' ')} failed: ${r.out}` };
            const p = pluginState(ctx, step.id, step.scope);
            return p && p.enabled ? { ok: true, detail: `${step.id} installed and enabled at ${step.scope} scope (read from the plugin list and the settings file)` } : { ok: false, detail: `${step.id} is not enabled at ${step.scope} scope after the call${p && p.errors.length ? ` (errors: ${p.errors.join('; ')})` : ''}` };
        }
        case 'plugin-uninstall': {
            const r = call(argvOf(step));
            if (!r.ok) return { ok: false, detail: `claude ${argvOf(step).join(' ')} failed: ${r.out}` };
            return pluginState(ctx, step.id, step.scope) ? { ok: false, detail: `${step.id} is still installed at ${step.scope} scope` } : { ok: true, detail: `${step.id} uninstalled from ${step.scope} scope` };
        }
        case 'hud': {
            const flags = step.mode === 'replace' ? ['--replace'] : step.mode === 'skip' ? ['--statusline-only'] : [];
            const args = [path.join(SCRIPTS, 'hud-statusline.js'), ...flags, '--catalog', path.join(SCRIPTS, '..', 'catalog', 'plugin-settings.json'), '--config-dir', account.configDir(ctx.env), '--project', ctx.project];
            const r = require('node:child_process').spawnSync(process.execPath, args, { encoding: 'utf8', env: ctx.env, cwd: ctx.project });
            return r.status === 0 ? { ok: true, detail: `claude-hud settings (${step.mode}): ${(r.stdout || '').trim().split('\n').slice(-1)[0]}` } : { ok: false, detail: `hud-statusline.js failed: ${(r.stderr || r.stdout || '').trim()}` };
        }
        default: return { ok: false, detail: `unknown operation ${step.op}` };
    }
}

// apply.js does the fast half - the CLI writes and their read-back, seconds - so the command that runs it is never cut off
// halfway. The slow half - the fetch steps and the `claude mcp get` status, minutes on a first install - goes to
// <tmp>/fetch.json (or `fetchFile`; false writes none, for a caller that collects several applies) for fetch.js, which
// the command runs in the background.
function apply(plan, { env = process.env, tmp, runCli = cli.run, log = console.log, fetchFile } = {})
{
    const project = plan.project;
    const report = { applied: [], failed: null, notRun: [], readback: [], keys: [], noop: false, toFetch: [], fetch: null, fetchFile: null, tmp: tmp || null };
    if (!plan.steps.length)
    {
        report.noop = true;
        log('Nothing to apply: every answer already matches what is installed. No claude call was made.');
        return report;
    }
    const ctx = { project, env, tmp: tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'preferred-tools-')), runCli, catalog: catalogLib.load(), alfredEnabled: Boolean(plan.alfredCodeEnabled) };
    ctx.call = makeRunner(ctx);
    report.tmp = ctx.tmp;
    for (let i = 0; i < plan.steps.length; i++)
    {
        const step = plan.steps[i];
        if (step.op === 'fetch') { report.toFetch.push(step); log(`${i + 1}. later  ${step.why} (fetch.js, after the read-back)`); continue; }
        const ready = restoreStep(step, ctx);
        const filled = ready.error ? null : fillStep(ready.step, ctx);
        const r = ready.error ? { ok: false, detail: ready.error } : runStep(filled.step, ctx);
        log(`${i + 1}. ${r.ok ? 'ok    ' : 'FAILED'} ${r.detail}`);
        if (filled && filled.note) { report.keys.push(filled.note); log(`   key: ${filled.note}`); }
        if (r.ok) { report.applied.push({ i: i + 1, op: step.op, detail: r.detail }); continue; }
        report.failed = { i: i + 1, op: step.op, detail: r.detail };
        report.notRun = plan.steps.slice(i + 1).map((s, k) => ({ i: i + 2 + k, op: s.op, why: s.why }));
        break;
    }
    if (report.failed)
    {
        log('', `Stopped at step ${report.failed.i}. Already applied and left in place: ${report.applied.length ? report.applied.map((a) => `${a.i} (${a.detail})`).join('; ') : 'nothing'}.`);
        if (report.notRun.length) log(`Not run: ${report.notRun.map((n) => `${n.i} ${n.op}`).join(', ')}.`);
    }
    // read it back: each picked tool as the files and the CLI now report it
    const inv = inventory.buildInventory({ project, env });
    for (const e of plan.expect || [])
    {
        if (e.kind === 'mcp')
        {
            const got = inv.registrations.find((r) => r.name === e.name && r.scope === e.scope);
            report.readback.push({ kind: 'mcp', name: e.name, scope: e.scope, expectedRoute: e.route, found: Boolean(got), route: got ? got.route : null, row: got ? got.rowId : null });
        }
        else
        {
            const got = inv.plugins.find((p) => p.id === e.id && p.scope === e.scope);
            report.readback.push({ kind: 'plugin', id: e.id, scope: e.scope, found: Boolean(got), enabled: got ? got.enabled : null, version: got ? got.version : null });
        }
    }
    log('', 'Read back:');
    for (const r of report.readback)
        log(r.kind === 'mcp' ? `  ${r.found ? 'ok ' : 'MISSING'} ${r.name} - ${r.scope} scope, ${r.route || '?'} route${r.row ? ` (${r.row})` : ''}` : `  ${r.found && r.enabled ? 'ok ' : 'MISSING'} ${r.id} - ${r.scope} scope${r.version ? `, ${r.version}` : ''}`);
    // what was written and read back: with a package to fetch, fetch.js fetches it and then asks the CLI for the status;
    // with none (a hosted URL, a rename, a move), the status is asked here
    const done = new Set(report.applied.map((a) => a.i));
    const written = plan.steps.filter((s, i) => done.has(i + 1) && ['mcp-add', 'mcp-replace', 'mcp-move'].includes(s.op)).map((s) => s.to || { name: s.name, scope: s.scope });
    const fresh = written.map((w) => w.name);
    const scopeOf = new Map(written.map((w) => [w.name, w.scope]));
    report.fetch = fetchLib.job(project, report.toFetch.filter((s) => scopeOf.has(s.name)).map((s) => ({ ...s, scope: scopeOf.get(s.name) })), fresh);
    if (!report.fetch.fetch.length) fetchLib.status(fresh, { cwd: project, env, runCli, log });
    else if (fetchFile !== false)
    {
        report.fetchFile = fetchLib.writeJob(fetchFile || path.join(ctx.tmp, 'fetch.json'), report.fetch);
        log('', ...fetchLib.nextLines(report.fetchFile, report.fetch));
    }
    if (!report.failed) log('', `Restart Claude Code (or run /reload-plugins for plugins) so the new registrations load${report.fetchFile ? ' - after the fetch reports, so a session start does not download the same package beside it' : ''}; a project-scope server also needs the trust prompt on the next session start.`);
    return report;
}

function main(argv)
{
    blockingStdio();
    const file = argv[0];
    if (!file) { console.error('usage: apply.js <plan.json> [--tmp <dir>]'); return 2; }
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (plan.errors && plan.errors.length) { console.error(`apply: the plan has errors - nothing applied:\n${plan.errors.map((e) => `  ! ${e}`).join('\n')}`); return 1; }
    const at = argv.indexOf('--tmp');
    const log = (...a) => console.log(a.join('\n'));
    const report = apply(plan, { tmp: at >= 0 ? argv[at + 1] : undefined, log });
    // the last script on <tmp> removes it: this one, unless fetch.js takes it on
    if (!report.fetchFile) tmpdir.release(report.tmp, log);
    return report.failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { apply, runStep, restoreStep, fillStep, readRegistration, restoreLine };
