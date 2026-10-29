#!/usr/bin/env node
'use strict';
// THE HOOK REPLAY - does alfred-code break preferred-tools' commands? Every step the four commands take is put through
// the hooks alfred-code registers, at each released version, in a plain alfred-code project and (from 2.11.0, the first
// release with workspaces) in a workspace root and its child. No model, no login.
//
//   node tests/probes/alfred-hooks.js --scratch <dir outside the temp folder> [--alfred <dir>] [--version 3.2.1[,2.9.0]]
//       [--claude <path>] [--only install,fix] [--keep]
//
// One line per (version, folder, step, hook): PASS | CONTEXT <hook> <text> | FINDING <hook> <decision> <message> |
// NOT RUN - <reason>. Context that tells Claude to re-ask, ask for a rotation or read before acting is a FINDING. Exit 0
// when nothing was a FINDING. Paths print as <S> (the scratch folder); seeded values never print.
//
// A COMMAND IS ONE SESSION. Its events go out in the order Claude Code fires them, under one session_id and one
// transcript the replay appends to: SessionStart (startup), UserPromptSubmit, UserPromptExpansion, then each tool step
// to PreToolUse, a real run, and PostToolUse with the real output, then Stop. The payload fields are the ones a
// logged-out `claude -p "/preferred-tools:install"` sent to logging hooks (Claude Code 2.1.312, 2026-10-29). A step a
// PreToolUse hook blocks still runs, so the steps after it are judged on real input; its FINDING says where a real
// session would have stopped.
//
// THE SCRATCH FOLDER sits outside the temp folder: alfred-code's cross-project write guard allows the temp folder only
// while it does not hold the project, so projects built inside it would see the Write of <tmp>/picks.json blocked.
//
// THE STEPS COME FROM commands/*.md. Every `node "${CLAUDE_PLUGIN_ROOT}/scripts/..."` line a command names is parsed
// from its text; a line the replay does not take is reported NOT RUN with its reason, so a new step cannot slip past.
// The files the steps name are built for real, from a folder seeded with every catalog server for this OS plus
// registrations that hold live-shaped values.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const cli = require('../../scripts/claude-cli.js');
const catalogLib = require('../../scripts/catalog.js');
const { buildAlfred } = require('./alfred-workspace.js');

const REPO = path.resolve(__dirname, '..', '..');
const VERSIONS = ['2.9.0', '2.11.0', '3.0.0', '3.2.1'];
const WORKSPACE_FROM = '2.11.0';
const COMMANDS = ['install', 'configure', 'fix', 'update'];
const NODE_LINE = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z-]+\.js)"([^`\n]*)/g;

const newer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };

// ---- the commands' own lines ----------------------------------------------------------------------------------------

function commandLines(name)
{
    const text = fs.readFileSync(path.join(REPO, 'commands', `${name}.md`), 'utf8');
    const body = text.replace(/^---[\s\S]*?\n---\n/, '');
    const lines = [];
    for (const m of body.matchAll(NODE_LINE)) lines.push({ script: m[1], rest: m[2].trim(), text: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/${m[1]}" ${m[2].trim()}`.trim() });
    return { body, lines };
}

// ---- the hooks a version registers ------------------------------------------------------------------------------------

function hooksOf(alfred)
{
    const doc = JSON.parse(fs.readFileSync(path.join(alfred, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const entry = doc.plugins.find((p) => p.name === 'alfred-code');
    const out = [];
    for (const [event, groups] of Object.entries(entry.hooks || {}))
        for (const g of groups) for (const h of g.hooks || []) if (h.type === 'command') out.push({ event, matcher: g.matcher, if: h.if, command: h.command, timeout: h.timeout });
    return out;
}

const hookName = (h) => { const m = /([\w.-]+\.js)"?\s*[^/\\]*$/.exec(h.command); return m ? m[1] : h.command.slice(0, 40); };

// The hooks docs' matcher rules: '*', '' or none matches all; else a regex tested on the tool name (tool events), the
// source (SessionStart) or the command name (UserPromptExpansion). `if: "Tool(pattern)"` narrows a tool event further.
function matches(h, payload)
{
    const on = { PreToolUse: payload.tool_name, PostToolUse: payload.tool_name, SessionStart: payload.source, UserPromptExpansion: payload.command_name }[h.event];
    if (h.matcher && h.matcher !== '*' && on !== undefined && !new RegExp(h.matcher).test(on)) return false;
    if (h.if)
    {
        const m = /^(\w+)\((.*)\)$/.exec(h.if);
        if (!m || m[1] !== payload.tool_name) return false;
        const glob = new RegExp(`^${m[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');
        if (!glob.test(String((payload.tool_input || {}).command || ''))) return false;
    }
    return true;
}

// -> { verdict: 'PASS' | 'CONTEXT' | 'FINDING', detail }
// Context that changes the step instead of informing it (Task 1's triage, 2026-10-29): a re-ask, a rotation ask, a read
// Claude is told to make before it acts. Everything else alfred-code adds - its docs, preferences, forge and history
// notes, the answer budget - only informs, and stays CONTEXT.
const ACTS = /\bre-ask\b|\bask whether\b|\bbefore acting\b|\bBefore this turn closes\b|\bend the turn with\b/i;
const contextOf = (detail) => ({ verdict: ACTS.test(detail) ? 'FINDING' : 'CONTEXT', detail });

function judge(event, r)
{
    const err = (r.stderr || '').trim();
    if (r.error) return { verdict: 'FINDING', detail: `error ${r.error.code || r.error.message}` };
    if (r.status === 2) return { verdict: 'FINDING', detail: `block (exit 2) ${err}` };
    if (r.status !== 0) return { verdict: 'FINDING', detail: `error (exit ${r.status}) ${err}` };
    const text = (r.stdout || '').trim();
    let o = null;
    if (text.startsWith('{')) try { o = JSON.parse(text); } catch { /* plain text */ }
    if (o)
    {
        const hso = o.hookSpecificOutput || {};
        if (o.continue === false) return { verdict: 'FINDING', detail: `stop ${o.stopReason || ''}` };
        if (o.decision === 'block') return { verdict: 'FINDING', detail: `block ${o.reason || ''}` };
        if (hso.permissionDecision === 'deny' || hso.permissionDecision === 'ask') return { verdict: 'FINDING', detail: `${hso.permissionDecision} ${hso.permissionDecisionReason || ''}` };
        if (hso.updatedInput) return { verdict: 'FINDING', detail: `updatedInput ${JSON.stringify(hso.updatedInput)}` };
        if (hso.updatedToolOutput || hso.updatedMCPToolOutput) return { verdict: 'FINDING', detail: `updatedToolOutput ${JSON.stringify(hso.updatedToolOutput || hso.updatedMCPToolOutput)}` };
        const ctx = [hso.additionalContext, o.systemMessage].filter(Boolean).join(' | ');
        return ctx ? contextOf(ctx) : { verdict: 'PASS', detail: '' };
    }
    // plain stdout is added to the context on these three events only
    if (text && ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion'].includes(event)) return contextOf(text);
    return { verdict: 'PASS', detail: '' };
}

// ---- one session ------------------------------------------------------------------------------------------------------

class Session
{
    constructor(ctx, folder, command)
    {
        Object.assign(this, { ctx, folder, command });
        this.id = crypto.randomUUID();
        this.promptId = crypto.randomUUID();
        this.transcript = path.join(ctx.b.world, 'transcripts', `${ctx.folderName}-${command}.jsonl`);
        fs.mkdirSync(path.dirname(this.transcript), { recursive: true });
        fs.writeFileSync(this.transcript, '');
        this.step = 0;
        this.used = new Set();
        this.skipped = [];
        this.lines = commandLines(command);
        this.prompt = `/preferred-tools:${command}`;
    }

    log(entry) { fs.appendFileSync(this.transcript, `${JSON.stringify({ uuid: crypto.randomUUID(), sessionId: this.id, cwd: this.folder, timestamp: new Date().toISOString(), ...entry })}\n`); }

    fire(event, extra)
    {
        const payload = { session_id: this.id, transcript_path: this.transcript, cwd: this.folder, hook_event_name: event, ...extra };
        const where = `${this.command}#${this.step}${extra.tool_name ? ` ${extra.tool_name}` : ''}`;
        for (const h of this.ctx.hooks.filter((x) => x.event === event && matches(x, payload)))
        {
            const command = h.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, this.ctx.b.pluginRoot);
            const r = spawnSync(command, {
                shell: true, cwd: this.folder, input: JSON.stringify(payload), encoding: 'utf8', timeout: (h.timeout || 60) * 1000,
                env: { ...this.ctx.b.env, CLAUDE_PLUGIN_ROOT: this.ctx.b.pluginRoot, CLAUDE_PROJECT_DIR: this.folder, CLAUDE_PLUGIN_DATA: path.join(this.ctx.b.account, 'plugins', 'data', 'alfred-code-envoydev') },
            });
            const v = judge(event, r);
            this.ctx.emit(v.verdict, `${where} ${event} ${hookName(h)}`, v.detail);
        }
    }

    start()
    {
        this.fire('SessionStart', { source: 'startup' });
        this.log({ type: 'user', message: { role: 'user', content: `<command-message>preferred-tools:${this.command}</command-message>\n<command-name>${this.prompt}</command-name>` } });
        const common = { prompt_id: this.promptId, permission_mode: 'default' };
        this.fire('UserPromptSubmit', { ...common, prompt: this.prompt });
        this.fire('UserPromptExpansion', { ...common, expansion_type: 'slash_command', command_name: `preferred-tools:${this.command}`, command_args: '', command_source: 'plugin', prompt: this.prompt });
        this.log({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: this.lines.body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, REPO) }] } });
    }

    // a tool step: PreToolUse, the real run, PostToolUse
    tool(name, input, run)
    {
        this.step++;
        const id = `toolu_${crypto.randomBytes(12).toString('hex')}`;
        this.log({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
        this.fire('PreToolUse', { permission_mode: 'default', tool_name: name, tool_input: input, tool_use_id: id });
        const response = run();
        this.log({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: typeof response.text === 'string' ? response.text : JSON.stringify(response) }] }, toolUseResult: response });
        this.fire('PostToolUse', { permission_mode: 'default', tool_name: name, tool_input: input, tool_response: response, tool_use_id: id });
        return response;
    }

    // a command line from the command's own text, by its script and the start of its arguments
    bash(script, startsWith, fill = {})
    {
        const line = this.lines.lines.find((l) => l.script === script && l.rest.startsWith(startsWith));
        if (!line) throw new Error(`${this.command}.md has no line for ${script} ${startsWith}`);
        this.used.add(line.text);
        let command = line.text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, REPO.replace(/\\/g, '/'))
            .replace(/\s*\[--only "\$ARGUMENTS"\]/, '').replace(/\s*\[--input key=value\]/, '');
        for (const [k, v] of Object.entries(fill)) command = command.split(k).join(v);
        if (fill.extra) command += ` ${fill.extra}`;
        const out = this.tool('Bash', { command, description: `preferred-tools ${script}` }, () =>
        {
            const r = spawnSync(command, { shell: true, cwd: this.folder, env: this.ctx.b.env, encoding: 'utf8', timeout: 600000 });
            return { stdout: r.stdout || '', stderr: r.stderr || '', interrupted: false, isImage: false, status: r.status };
        });
        return out;
    }

    write(file, content)
    {
        return this.tool('Write', { file_path: file, content }, () => { fs.writeFileSync(file, content); return { type: 'create', filePath: file, content }; });
    }

    // an AskUserQuestion as printed, answered with `pick(question) -> label`
    ask(questions, pick = (q) => q.options[0].label)
    {
        const qs = questions.map((q) => ({ question: q.question, header: q.header, multiSelect: Boolean(q.multiSelect), options: q.options.map((o) => ({ label: o.label, description: o.description })) }));
        const answers = Object.fromEntries(qs.map((q) => [q.question, pick(q)]));
        this.tool('AskUserQuestion', { questions: qs }, () => ({ questions: qs, answers }));
        return answers;
    }

    skip(script, startsWith, why)
    {
        const line = this.lines.lines.find((l) => l.script === script && l.rest.startsWith(startsWith));
        if (line) { this.used.add(line.text); this.skipped.push(`${line.text} (${why})`); }
    }

    end()
    {
        this.log({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
        this.fire('Stop', { stop_hook_active: false });
        for (const s of this.skipped) this.ctx.emit('NOT RUN', `${this.command}`, `not replayed: ${s}`);
        for (const l of this.lines.lines) if (!this.used.has(l.text)) this.ctx.emit('NOT RUN', `${this.command}`, `not replayed (no step takes it): ${l.text}`);
    }
}

const json = (out) => { try { return JSON.parse(out.stdout); } catch { return null; } };
const fetchFileOf = (out) => { const m = /Fetch next[^:]*:\s*(\S+)/.exec(out.stdout || ''); return m ? m[1] : null; };

// ---- the four commands, as their text walks them ------------------------------------------------------------------------

function common(s)
{
    const tmp = s.bash('tmpdir.js', '').stdout.trim();
    const t = (f) => `${tmp}/${f}`.replace(/\\/g, '/');
    s.bash('inventory.js', '--json', { '<tmp>': tmp });
    s.bash('table.js', '<tmp>/inventory.json', { '<tmp>': tmp });
    const q = json(s.bash('plan.js', '--questions', { '<tmp>': tmp }));
    return { tmp, t, q };
}

function prereqAndApply(s, tmp, t, answers, q)
{
    s.write(t('answers.json'), JSON.stringify(answers, null, 2));
    s.bash('prereq.js', '<tmp>/answers.json --audit', { '<tmp>': tmp });
    const pre = json(s.bash('prereq.js', '<tmp>/answers.json --json', { '<tmp>': tmp }));
    s.write(t('answers.json'), JSON.stringify({ ...answers, machine: (pre && pre.machine) || {} }, null, 2));
    s.bash('plan.js', '<tmp>/inventory.json <tmp>/answers.json --out', { '<tmp>': tmp });
    if (q.static.apply) s.ask([q.static.apply]);
    const applied = s.bash('apply.js', '<tmp>/plan.json --tmp', { '<tmp>': tmp });
    const file = fetchFileOf(applied);
    if (file) s.bash('fetch.js', '"<file>"', { '<file>': file });
    else s.skip('fetch.js', '"<file>"', 'apply handed no fetch file on');
    s.skip('hud-statusline.js', '--check', 'claude-hud is not picked');
}

function install(s, ctx)
{
    const { tmp, t, q } = common(s);
    // the pick: the one tool the seed left out
    const want = ctx.leftOut;
    for (const call of q.pick || []) s.ask(call, (qq) => (qq.options.find((o) => o.label === want) || qq.options[qq.options.length - 1]).label);
    if (q.static.settings) s.ask([q.static.settings], (qq) => (qq.options.find((o) => /^Set each/.test(o.label)) || qq.options[0]).label);
    s.write(t('picks.json'), JSON.stringify({ rows: [want], routes: {} }, null, 2));
    const per = json(s.bash('plan.js', '--questions', { '<tmp>': tmp, extra: t('picks.json') }));
    const tool = per && per.tools && per.tools[want];
    if (tool && tool.questions) s.ask(tool.questions);
    prereqAndApply(s, tmp, t, { picks: { [want]: {} } }, q);
}

function configure(s, ctx)
{
    const { tmp, t, q } = common(s);
    if (q.static.menu) s.ask([q.static.menu]);
    const key = Object.values(q.change.keys).find((k) => k === `mcp:${ctx.liveName}~local`) || `mcp:${ctx.liveName}~local`;
    const label = Object.keys(q.change.keys).find((l) => q.change.keys[l] === key);
    for (const call of q.change.calls || []) s.ask(call, (qq) => (qq.options.find((o) => o.label === label) || qq.options[0]).label);
    s.write(t('picks.json'), JSON.stringify({ targets: [key], routes: {} }, null, 2));
    const per = json(s.bash('plan.js', '--questions', { '<tmp>': tmp, extra: t('picks.json') }));
    const target = per && per.targets && per.targets[key];
    if (target && target.questions) s.ask(target.questions, (qq) => (/name/i.test(qq.header || qq.question) ? ctx.newName : qq.options[0].label));
    prereqAndApply(s, tmp, t, { change: { [key]: { row: 'sentry', name: ctx.newName } } }, q);
    s.skip('apply.js', '<tmp>/remove-plan.json', 'the remove path is not taken');
}

function fix(s)
{
    const found = s.bash('fix.js', '--detect');
    if (/No known problem found/.test(found.stdout))
    {
        s.skip('fix.js', '--questions', 'nothing found');
        s.skip('fix.js', '--apply', 'nothing found');
        s.skip('fetch.js', '"<file>"', 'nothing found');
        return;
    }
    const q = json(s.bash('fix.js', '--questions'));
    if (q && q.choose) s.ask([q.choose]);
    const applied = s.bash('fix.js', '--apply', { '<id,id | all>': 'all' });
    const file = fetchFileOf(applied);
    if (file) s.bash('fetch.js', '"<file>"', { '<file>': file });
    else s.skip('fetch.js', '"<file>"', 'fix handed no fetch file on');
}

function update(s)
{
    const check = s.bash('update.js', '--check');
    if (/everything current/.test(check.stdout))
    {
        for (const [script, start] of [['update.js', '--questions'], ['update.js', '--apply'], ['fetch.js', '"<file>"']]) s.skip(script, start, 'everything current');
        return;
    }
    const q = json(s.bash('update.js', '--questions --no-refresh'));
    if (q && q.offer) s.ask([q.offer]);
    const applied = s.bash('update.js', '--apply', { '<id,id | all>': 'all' });
    const file = fetchFileOf(applied);
    if (file) s.bash('fetch.js', '"<file>"', { '<file>': file });
    else s.skip('fetch.js', '"<file>"', 'update handed no fetch file on');
}

// ---- the seed -------------------------------------------------------------------------------------------------------------

// Every catalog server offered on this OS but one (install's pick), with its recommended settings and token routes
// as ${VAR}; then registrations holding live-shaped values, which no command may copy into a file it names.
function seed(b, folder, secrets)
{
    const catalog = catalogLib.load();
    const rows = catalog.tools.filter((r) => r.kind === 'mcp' && r.os.includes(process.platform));
    const leftOut = rows.find((r) => r.id === 'atlassian') ? 'atlassian' : rows[rows.length - 1].id;
    const picks = Object.fromEntries(rows.filter((r) => r.id !== leftOut).map((r) => [r.id, {}]));
    const r = b.harness.run(folder, { picks, machine: { docker: true } });
    const problems = [...r.plan.errors, ...(r.report.failed ? [r.report.failed.detail] : [])];
    const hex = (n) => crypto.randomBytes(n).toString('hex');
    const v = { sentry: `sntryu_${hex(16)}`, ctx7: `ctx7sk-${hex(12)}`, api: `sk-live-${hex(16)}`, db: hex(8), camel: hex(8), pg: `pw${hex(8)}`, url: `p${hex(8)}` };
    secrets.push(...Object.values(v));
    const live = {
        'sentry-live': { command: 'npx', args: ['-y', '@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: v.sentry } },
        'context7-key': { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { 'X-API-Key': v.ctx7 } },
        'own-db': { command: 'node', args: ['server.js', `postgresql://app:${v.pg}@localhost/db`], env: { API_KEY: v.api, DB_PASS: v.db, userPass: v.camel } },
        'own-http': { type: 'http', url: `https://u:${v.url}@mcp.example.test/mcp` },
    };
    for (const [name, entry] of Object.entries(live))
    {
        const a = cli.run(['mcp', 'add-json', name, JSON.stringify(entry), '-s', 'local'], { cwd: folder, env: b.env });
        if (a.status !== 0) problems.push(`add ${name}: ${(a.stderr || a.stdout).trim().slice(0, 200)}`);
    }
    return { leftOut, liveName: 'sentry-live', newName: 'sentry-moved', problems };
}

// ---- main -------------------------------------------------------------------------------------------------------------

function main(argv)
{
    const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
    const versions = val('--version') ? val('--version').split(',') : VERSIONS;
    const only = val('--only') ? val('--only').split(',') : COMMANDS;
    // alfred-code's cross-project write guard allows the temp folder only when it does not hold the project, so a
    // project built inside the temp folder would see every Write to <tmp> blocked - a block no real project meets.
    const tmpReal = fs.realpathSync(os.tmpdir());
    const scratch = fs.realpathSync(val('--scratch') || os.tmpdir());
    if (scratch === tmpReal || scratch.startsWith(tmpReal + path.sep))
    {
        console.error(`alfred-hooks: --scratch must be outside the temp folder (${tmpReal}): alfred-code's cross-project guard drops its temp allowance for a project inside it.`);
        return 2;
    }
    const S = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'pt-alfred-hooks-')));
    const secrets = [];
    let findings = 0;
    const clean = (text) =>
    {
        let out = String(text).split(S).join('<S>').split(S.replace(/\\/g, '/')).join('<S>').split(REPO).join('<repo>').split(tmpReal).join('<tmp>');
        for (const s of secrets) out = out.split(s).join('<seed>');
        return out.replace(/\s+/g, ' ').trim();
    };
    const emit = (version, folder) => (verdict, where, detail) =>
    {
        if (verdict === 'FINDING') findings++;
        console.log(clean(`${verdict} ${version} ${folder} ${where}${detail ? ` - ${detail}` : ''}`).slice(0, verdict === 'PASS' ? 300 : 1500));
    };
    try
    {
        for (const version of versions)
        {
            const b = buildAlfred(S, { alfredDir: val('--alfred'), version, claude: val('--claude'), workspace: newer(version, WORKSPACE_FROM) });
            if (b.notRun) { console.log(clean(`NOT RUN - ${version}: ${b.notRun}`)); continue; }
            if (b.workspaceNotRun) console.log(clean(`NOT RUN - ${version} root and child: ${b.workspaceNotRun}`));
            const hooks = hooksOf(b.alfred);
            for (const [folderName, folder] of Object.entries(b.folders))
            {
                const ctx = { b, hooks, folderName, emit: emit(version, folderName) };
                const sd = seed(b, folder, secrets);
                for (const p of sd.problems) ctx.emit('NOT RUN', 'seed', p);
                Object.assign(ctx, sd);
                for (const command of only)
                {
                    const s = new Session(ctx, folder, command);
                    try { s.start(); ({ install, configure, fix, update })[command](s, ctx); }
                    catch (e) { ctx.emit('NOT RUN', command, `the replay stopped: ${e.message}`); }
                    s.end();
                }
            }
        }
    }
    finally
    {
        if (argv.includes('--keep')) console.log(`kept: ${S}`);
        else fs.rmSync(S, { recursive: true, force: true });
    }
    console.log(`alfred-hooks: ${findings} FINDING line(s)`);
    return findings ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { hooksOf, matches, judge, commandLines };
