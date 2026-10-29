#!/usr/bin/env node
'use strict';
// THE .mcp.json WALK - which project files Claude Code loads from a folder, its parents and its subfolders, which one
// wins a name clash, where a subfolder session writes, and what approves a project server. The real CLI in a throwaway
// home and account, logged out, no model.
//
//   node tests/probes/mcp-tree.js [--claude <path>] [--only M1,M2] [--scratch <dir>] [--keep]
//
// THE TREE, built fresh per variant under S/<variant> (HOME = home, CLAUDE_CONFIG_DIR = account):
//   .mcp.json               p-above            above HOME
//   home/.mcp.json          p-home             HOME itself
//   home/ws/.mcp.json       p-ws, dup (tag ws)    variant A: ws is a git repo; variant B: it is not
//   home/ws/api/.mcp.json   p-api, dup (tag api)  a git repo in both
//   home/ws/api/src/        no .mcp.json
//   home/ws/web/            no .mcp.json, a git repo (and web/sub, a plain folder)
//   home/ws/notes/          a plain folder: inside ws's repo in A, in no repo in B
//   link -> home/ws/api     a symlink (Windows: a junction)
// Every server is tests/fake-mcp-server.js with `--log ${PT_PROBE_LOG} --tag <tag>`, and every CLI call sets its own
// PT_PROBE_LOG, so a `claude mcp list` health check never mixes with a session's starts.
//
// LOGGED OUT, ALWAYS. Each call gets only the variables a CLI run needs (no credential, nothing from a Claude Code
// session this probe may run inside), and `claude auth status` must report `loggedIn: false` before a `claude -p` runs:
// the docs say `-p` loads project servers without asking, and its stdio servers start before the login stop. Only the
// first batch does: Claude Code connects stdio servers MCP_SERVER_CONNECTION_BATCH_SIZE at a time (default 3), and the
// login stop ends the run after the first batch, so every call sets it to 20 (more than the tree holds).
//
// One line per measurement: RESULT M<n> ... | NOT RUN - <reason>, then the FACT lines docs/sources.md records. Exit 0
// when the control passed and every measurement asked for ran. Paths print as <S>; in RESULT lines, relative to home.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../../scripts/claude-cli.js');

const FAKE = path.resolve(__dirname, '..', 'fake-mcp-server.js');
const WIN = process.platform === 'win32';
const ALL = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
const FOLDERS = ['ws', 'ws/api', 'ws/api/src', 'ws/web'];
// Only what a CLI run needs; HOME, USERPROFILE, the AppData pair and CLAUDE_CONFIG_DIR are set into the world.
const KEEP = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR', 'PROGRAMFILES', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM']);
const DUP_TAGS = new Set(['ws', 'api', 'local']);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const writeJson = (file, doc) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const entry = (tag) => ({ command: process.execPath, args: [FAKE, 'answer', '--log', '${PT_PROBE_LOG}', '--tag', tag] });
const servers = (map) => ({ mcpServers: Object.fromEntries(Object.entries(map).map(([name, tag]) => [name, entry(tag)])) });
const nameOf = (tag) => (DUP_TAGS.has(tag) ? 'dup' : tag);
const list = (items) => `[${[...items].join(', ')}]`;

function world(S, name, claudeDir)
{
    const root = path.join(S, name);
    const home = path.join(root, 'home');
    const ws = path.join(home, 'ws');
    const d = {
        name, root, home, ws,
        account: path.join(root, 'account'),
        logs: path.join(root, 'logs'),
        api: path.join(ws, 'api'),
        src: path.join(ws, 'api', 'src'),
        web: path.join(ws, 'web'),
        webSub: path.join(ws, 'web', 'sub'),
        notes: path.join(ws, 'notes'),
        link: path.join(root, 'link'),
    };
    for (const dir of [d.account, d.logs, d.src, d.webSub, d.notes, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(root, '.mcp.json'), servers({ 'p-above': 'p-above' }));
    writeJson(path.join(home, '.mcp.json'), servers({ 'p-home': 'p-home' }));
    writeJson(path.join(ws, '.mcp.json'), servers({ 'p-ws': 'p-ws', dup: 'ws' }));
    writeJson(path.join(d.api, '.mcp.json'), servers({ 'p-api': 'p-api', dup: 'api' }));
    for (const repo of name === 'A' ? [ws, d.api, d.web] : [d.api, d.web]) spawnSync('git', ['init', '-q', repo]);
    fs.symlinkSync(d.api, d.link, WIN ? 'junction' : 'dir');
    d.env = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.has(k.toUpperCase())));
    const pathKey = Object.keys(d.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    if (claudeDir) d.env[pathKey] = `${claudeDir}${path.delimiter}${d.env[pathKey] || ''}`;
    Object.assign(d.env, {
        HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        CLAUDE_CONFIG_DIR: d.account, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        MCP_SERVER_CONNECTION_BATCH_SIZE: '20',
    });
    d.seq = 0;
    return d;
}

// One CLI call with its own start log. -> { status, out, started: [{ tag, cwd }] }
function call(d, cwd, args, timeout = 90000)
{
    const log = path.join(d.logs, `${String(++d.seq).padStart(3, '0')}.log`);
    const r = cli.run(args, { cwd, env: { ...d.env, PT_PROBE_LOG: log }, timeout });
    sleep(300);
    let started = [];
    try { started = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { /* nothing started */ }
    return { status: r.status, out: `${r.stdout}${r.stderr}${r.error ? r.error.message : ''}`, started };
}

const at = (d, rel) => path.join(d.home, ...rel.split('/'));
// a path relative to home, `/`-separated (a Windows account key is already `/`-separated)
const rel = (d, p) => path.relative(d.home, path.resolve(String(p))).split(path.sep).join('/') || '.';
const tagsOf = (r) => [...new Set(r.started.map((s) => s.tag))].sort();
const cwdsOf = (d, r) => [...new Set(r.started.map((s) => rel(d, s.cwd)))].sort();

// `claude mcp list` -> { name: connected | pending | rejected | failed | <text> }
const word = (s) => (/Connected/.test(s) ? 'connected' : /Pending/.test(s) ? 'pending' : /Rejected/.test(s) ? 'rejected' : /Failed/i.test(s) ? 'failed' : s.trim());
function listed(out)
{
    const map = {};
    for (const line of out.split(/\r?\n/))
    {
        const m = /^([\w.-]+): .* - (.+)$/.exec(line.trim());
        if (m) map[m[1]] = word(m[2]);
    }
    return map;
}
// a server `claude mcp list` leaves out (it does so for a rejected one): its status as `claude mcp get` gives it
function statusOf(d, cwd, name)
{
    const fromList = listed(call(d, cwd, ['mcp', 'list']).out)[name];
    if (fromList) return fromList;
    const m = /Status: (.+)/.exec(call(d, cwd, ['mcp', 'get', name]).out);
    return m ? `${word(m[1])} (left out of mcp list; mcp get)` : 'not listed';
}
const showList = (map) => list(Object.keys(map).sort().map((n) => `${n} ${map[n]}`));

// the account file's `projects` keys whose local servers hold `name`
const localKeys = (d, name) => Object.entries((readJson(path.join(d.account, '.claude.json')) || {}).projects || {})
    .filter(([, v]) => v && v.mcpServers && Object.hasOwn(v.mcpServers, name)).map(([k]) => rel(d, k));
// which .mcp.json files under home hold `name`
const projectFiles = (d, name, folders) => folders.filter((f) => Object.hasOwn((readJson(path.join(at(d, f), '.mcp.json')) || {}).mcpServers || {}, name));
// the trust key Claude Code reads for a folder: the real path; on Windows the cwd as typed, `\` written as `/`
const trustKey = (dir) => (WIN ? dir.replace(/\\/g, '/') : fs.realpathSync.native(dir));

// merges `fields` into the throwaway account file's entry for a folder; a field set to undefined is dropped
function setEntry(d, dir, fields)
{
    const file = path.join(d.account, '.claude.json');
    const doc = readJson(file) || {};
    doc.projects = doc.projects || {};
    const key = trustKey(dir);
    doc.projects[key] = JSON.parse(JSON.stringify({ ...(doc.projects[key] || {}), ...fields }));
    writeJson(file, doc);
}

function measure(only, S, claudeDir, print)
{
    const res = {};
    const A = world(S, 'A', claudeDir);
    const B = only.includes('M1') || only.includes('M4') ? world(S, 'B', claudeDir) : null;
    for (const d of [A, B].filter(Boolean))
    {
        const auth = call(d, d.home, ['auth', 'status']);
        if (!/"loggedIn":\s*false/.test(auth.out)) return { notRun: `the throwaway account ${d.name} is not reported logged out (claude auth status exit ${auth.status})` };
    }
    const ctl = call(A, A.api, ['-p', 'hi']);
    print(`RESULT control: claude -p from ws/api exit ${ctl.status}, started ${list(tagsOf(ctl))}`);
    if (!tagsOf(ctl).includes('p-api')) return { notRun: 'control failed' };

    if (only.includes('M1'))
    {
        res.m1 = {};
        for (const d of [A, B]) for (const f of FOLDERS)
        {
            const l = listed(call(d, at(d, f), ['mcp', 'list']).out);
            const s = call(d, at(d, f), ['-p', 'hi']);
            res.m1[`${d.name} ${f}`] = { list: l, started: tagsOf(s) };
            print(`RESULT M1 ${d.name} ${f}: list ${showList(l)} started ${list(tagsOf(s))} cwd ${list(cwdsOf(d, s))}`);
            const startedNames = new Set(tagsOf(s).map(nameOf));
            const onlyListed = Object.keys(l).filter((n) => !startedNames.has(n));
            const onlyStarted = [...startedNames].filter((n) => !Object.hasOwn(l, n));
            if (onlyListed.length || onlyStarted.length) print(`RESULT M1 ${d.name} ${f} mismatch: listed only ${list(onlyListed)}, started only ${list(onlyStarted)}`);
        }
    }

    if (only.includes('M2'))
    {
        const inApi = tagsOf(call(A, A.api, ['-p', 'hi'])).filter((t) => DUP_TAGS.has(t));
        const inSrc = tagsOf(call(A, A.src, ['-p', 'hi'])).filter((t) => DUP_TAGS.has(t));
        const get = call(A, A.api, ['mcp', 'get', 'dup']).out;
        const tag = (/--tag (\S+)/.exec(get) || [])[1] || 'none';
        const scope = ((/Scope: (.+)/.exec(get) || [])[1] || 'none').trim();
        res.m2 = { inApi, inSrc, tag };
        print(`RESULT M2: dup started in ws/api ${list(inApi)}, in ws/api/src ${list(inSrc)}; claude mcp get dup in ws/api: tag ${tag}, scope '${scope}'`);
    }

    if (only.includes('M3'))
    {
        const add = call(A, A.web, ['mcp', 'add-json', 'dup', JSON.stringify(entry('local')), '-s', 'local']);
        const s = call(A, A.web, ['-p', 'hi']);
        const l = listed(call(A, A.web, ['mcp', 'list']).out);
        call(A, A.web, ['mcp', 'remove', 'dup', '-s', 'local']);
        res.m3 = { started: tagsOf(s).filter((t) => DUP_TAGS.has(t)), inherited: Object.hasOwn(res.m1 ? res.m1['A ws/web'].list : {}, 'dup') };
        print(`RESULT M3: add-json -s local dup in ws/web exit ${add.status}; dup started there ${list(res.m3.started)}; list ${showList(l)}`);
    }

    if (only.includes('M4'))
    {
        // from a subfolder: where -s project and -s local write, and whether the folder and its repo root read the
        // local entry back; from ws/notes, inside ws's repo in A and in no repo in B
        const files = ['ws', 'ws/notes', 'ws/api', 'ws/api/src', 'ws/web', 'ws/web/sub'];
        res.m4 = {};
        for (const [d, from, root] of [[A, 'ws/api/src', 'ws/api'], [A, 'ws/web/sub', 'ws/web'], [A, 'ws/notes', 'ws'], [B, 'ws/notes', 'ws']])
        {
            const cwd = at(d, from);
            const tag = `m4-${d.name}-${from.replace(/\W/g, '')}`;
            call(d, cwd, ['mcp', 'add-json', tag, JSON.stringify(entry(tag)), '-s', 'project']);
            call(d, cwd, ['mcp', 'add-json', `${tag}l`, JSON.stringify(entry(`${tag}l`)), '-s', 'local']);
            const r = {
                project: projectFiles(d, tag, files), local: localKeys(d, `${tag}l`),
                readHere: listed(call(d, cwd, ['mcp', 'list']).out)[`${tag}l`] || 'not listed',
                readAtRoot: listed(call(d, at(d, root), ['mcp', 'list']).out)[`${tag}l`] || 'not listed',
            };
            res.m4[`${d.name} ${from}`] = r;
            print(`RESULT M4 ${d.name} from ${from}: -s project wrote ${list(r.project.map((f) => `${f}/.mcp.json`))}; -s local keyed ${list(r.local)}, listed from ${from} ${r.readHere}, from ${root} ${r.readAtRoot}`);
            call(d, cwd, ['mcp', 'remove', tag, '-s', 'project']);
            call(d, cwd, ['mcp', 'remove', `${tag}l`, '-s', 'local']);
        }
    }

    if (only.includes('M5'))
    {
        const l = listed(call(A, A.link, ['mcp', 'list']).out);
        const s = call(A, A.link, ['-p', 'hi']);
        call(A, A.link, ['mcp', 'add-json', 'm5l', JSON.stringify(entry('m5l')), '-s', 'local']);
        res.m5 = { local: localKeys(A, 'm5l') };
        call(A, A.link, ['mcp', 'remove', 'm5l', '-s', 'local']);
        print(`RESULT M5 from link: list ${showList(l)} started ${list(tagsOf(s))} cwd ${list(cwdsOf(A, s))}; -s local keyed ${list(res.m5.local)}`);
    }

    if (only.includes('M6'))
    {
        const file = path.join(A.ws, '.mcp.json');
        const kept = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, '{ not json');
        const lr = call(A, A.api, ['mcp', 'list']);
        const s = call(A, A.api, ['-p', 'hi']);
        fs.writeFileSync(file, kept);
        const says = lr.out.split(/\r?\n/).find((x) => /error|invalid|pars|json/i.test(x)) || 'nothing about it';
        print(`RESULT M6 ws/.mcp.json malformed, from ws/api: mcp list exit ${lr.status}, list ${showList(listed(lr.out))}, says '${says.trim()}'; started ${list(tagsOf(s))}`);
    }

    if (only.includes('M7'))
    {
        // the parent's server as a subfolder sees it; with no walk, the folder's own server in its own folder
        const walks = !res.m1 || Object.hasOwn(res.m1['A ws/web'].list, 'p-ws');
        const [dir, server, parent] = walks ? [A.web, 'p-ws', A.ws] : [A.api, 'p-api', A.ws];
        const childLocal = path.join(dir, '.claude', 'settings.local.json');
        const parentLocal = path.join(parent, '.claude', 'settings.local.json');
        const user = path.join(A.account, 'settings.json');
        const states = [
            ['nothing set', () => {}],
            [`enabledMcpjsonServers in the account file's ${rel(A, dir)} entry`, () => setEntry(A, dir, { enabledMcpjsonServers: [server] })],
            [`disabledMcpjsonServers in the account file's ${rel(A, dir)} entry`, () => setEntry(A, dir, { disabledMcpjsonServers: [server] })],
            [`enabledMcpjsonServers in ${rel(A, dir)}/.claude/settings.local.json`, () => writeJson(childLocal, { enabledMcpjsonServers: [server] })],
            [`enabledMcpjsonServers in ${rel(A, parent)}/.claude/settings.local.json`, () => writeJson(parentLocal, { enabledMcpjsonServers: [server] })],
            [`disabledMcpjsonServers in ${rel(A, dir)}/.claude/settings.local.json`, () => writeJson(childLocal, { disabledMcpjsonServers: [server] })],
            ['enableAllProjectMcpServers in the user settings.json', () => writeJson(user, { enableAllProjectMcpServers: true })],
        ];
        res.m7 = [];
        for (const [label, set] of states)
        {
            for (const f of [childLocal, parentLocal, user]) fs.rmSync(f, { force: true });
            setEntry(A, dir, { enabledMcpjsonServers: undefined, disabledMcpjsonServers: undefined });
            set();
            for (const trusted of [true, false])
            {
                setEntry(A, dir, { hasTrustDialogAccepted: trusted });
                const status = statusOf(A, dir, server);
                res.m7.push(`${label}, ${trusted ? 'trusted' : 'untrusted'}: ${status}`);
                print(`RESULT M7 ${server} in ${rel(A, dir)}, ${label}, ${trusted ? 'trusted' : 'untrusted'}: ${status}`);
            }
        }
        for (const f of [childLocal, parentLocal, user]) fs.rmSync(f, { force: true });
    }
    return { res };
}

// The fact block Task 5 encodes. A value outside the named set is printed as `other (...)`: the plan's stop.
function facts(res)
{
    const out = [];
    if (res.m1)
    {
        const a = res.m1['A ws/api'].started;
        const b = res.m1['B ws/api'].started;
        const walk = a.includes('p-above') ? 'filesystem-root'
            : a.includes('p-home') ? 'home'
            : a.includes('p-ws') && !b.includes('p-ws') ? 'git-root-of-parent'
            : !a.includes('p-ws') && !b.includes('p-ws') ? 'none'
            : `other (A started ${list(a)}, B ${list(b)})`;
        out.push(`walk: ${walk}`);
    }
    if (res.m2) out.push(`nearest-wins: ${res.m2.inApi.length === 1 && res.m2.inApi[0] === 'api' ? 'yes' : res.m2.inApi.includes('ws') ? 'no' : `other (${list(res.m2.inApi)})`}`);
    if (res.m3) out.push(`local-over-inherited: ${res.m3.started.length === 1 && res.m3.started[0] === 'local' ? 'yes' : res.m3.started.includes('ws') ? 'no' : `other (${list(res.m3.started)})`}${res.m3.inherited ? '' : ' (dup not inherited in ws/web)'}`);
    if (res.m5) out.push(`symlink: ${res.m5.local.join() === 'ws/api' ? 'real' : res.m5.local.join() === '../link' ? 'logical' : `other (${list(res.m5.local)})`}`);
    if (res.m4)
    {
        const src = res.m4['A ws/api/src'];
        const sub = res.m4['A ws/web/sub'];
        const p = src.project.join();
        const w = sub.project.join();
        out.push(`subfolder-project-file: ${p === 'ws/api/src' ? 'cwd' : p === 'ws/api' && w === 'ws/web' ? 'git-root' : p === 'ws/api' && w === 'ws' ? 'nearest' : `other (src -> ${p}, web/sub -> ${w})`}`);
        const l = src.local.join();
        out.push(`subfolder-local-key: ${l === 'ws/api/src' ? 'cwd' : l === 'ws/api' ? 'git-root' : `other (${list(src.local)})`}`);
        const plain = res.m4['B ws/notes'].local.join();
        out.push(`subfolder-local-key, no repo: ${plain === 'ws/notes' ? 'cwd' : `other (${list(res.m4['B ws/notes'].local)})`}`);
    }
    if (res.m7) for (const line of res.m7) out.push(`approval: ${line}`);
    return out;
}

function main(argv)
{
    const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
    const only = val('--only') ? val('--only').split(',').map((s) => s.trim().toUpperCase()) : ALL;
    const claudeDir = val('--claude') ? path.dirname(path.resolve(val('--claude'))) : null;
    // a --scratch folder that is not there yet is made before its real path is read
    const wanted = val('--scratch') ? path.resolve(val('--scratch')) : os.tmpdir();
    fs.mkdirSync(wanted, { recursive: true });
    const base = fs.realpathSync.native(wanted);
    const S = fs.mkdtempSync(path.join(base, 'preferred-tools-mcp-tree-'));
    const clean = (text) => String(text).split(S).join('<S>').split(S.replace(/\\/g, '/')).join('<S>');
    const print = (line) => console.log(clean(line));
    let code = 1;
    try
    {
        if (spawnSync('git', ['-C', S, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0)
        {
            print('NOT RUN - the scratch folder is inside a git repository, so every folder would have a git root above it');
            return 1;
        }
        const r = measure(only, S, claudeDir, print);
        if (r.notRun)
        {
            for (const m of only) print(`NOT RUN - ${m}: ${r.notRun}`);
            return 1;
        }
        for (const line of facts(r.res)) print(`FACT ${line}`);
        print(`claude ${(cli.run(['--version'], {}).stdout || '').trim()}, ${process.platform} ${process.arch}`);
        code = 0;
        return code;
    }
    finally
    {
        if (argv.includes('--keep')) print(`kept: ${S}`);
        else fs.rmSync(S, { recursive: true, force: true });
    }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { listed, facts, world, call };
