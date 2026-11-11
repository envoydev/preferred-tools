#!/usr/bin/env node
'use strict';
// THE HEADER HELPER - where does Claude Code run an MCP server's `headersHelper`, and what reaches the server? A stub
// HTTP MCP server on 127.0.0.1 (in this process) records, per request, the path, the JSON-RPC method and whether the
// `Authorization` header equals the expected value - never the value. The real `claude` CLI registers servers whose
// helper reads `.mcps-secrets` beside itself, under a throwaway HOME and CLAUDE_CONFIG_DIR; `claude mcp get` connects.
//
//   node tests/probes/headers-helper.js [--helper <file>] [--keep] [--scratch <dir>]
//
// The helper registered is a wrapper that logs the folder it runs in and the server name, then prints the header: by
// its own reading of `.mcps-secrets`, or, with --helper, by running that file (copied beside it as real-headers.js)
// with the same arguments and folder. Cases, each checked against the list measured 2026-11-10 (Claude Code 2.1.322):
//   stored-project|local|user   `claude mcp add-json` stores headersHelper unchanged
//   header-project|local|user   the header reaches the server on initialize
//   cwd-project|local           the helper runs in the folder whose .mcp.json (or local entry) declares the server
//   cwd-user                    the helper runs in the configuration folder
//   missing-helper              a helper path that does not exist: the server connects without the header
//   untrusted                   a folder whose trust is not accepted: the helper does not run, no header
//   child-root-trusted          a session in a child folder of the declaring folder: the helper does not run, no header
//   child-root-absolute         the same with the helper named by absolute path (M1, measured 2026-11-11): no run, no header
//   child-both-trusted          the same with the child trusted too
//   child-root-git              the same with the declaring folder a git repository
// One line per case: RESULT <case> <pass|fail> <what was seen>. Exit 1 when a case differs from the measured list.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fake = require('../fake-mcp-http.js');

const FAKE = ['probe', 'fake', 'value', '123'].join('-');
const EXPECTED = `Bearer ${FAKE}`;

function args(argv)
{
    const out = { helper: null, keep: false, scratch: null };
    for (let i = 0; i < argv.length; i++)
    {
        if (argv[i] === '--helper') out.helper = path.resolve(argv[++i]);
        else if (argv[i] === '--keep') out.keep = true;
        else if (argv[i] === '--scratch') out.scratch = argv[++i];
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return out;
}

// The wrapper every registration names: logs { server, cwd }, then prints the header JSON.
const WRAPPER = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
fs.appendFileSync(path.join(__dirname, 'helper-runs.log'), JSON.stringify({ server: process.env.CLAUDE_CODE_MCP_SERVER_NAME || null, cwd: process.cwd() }) + '\\n');
const real = path.join(__dirname, 'real-headers.js');
if (fs.existsSync(real))
{
    const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '{}');
}
else
{
    const [name, scheme] = process.argv.slice(2);
    let v = '';
    try
    {
        for (const l of fs.readFileSync(path.join(__dirname, '.mcps-secrets'), 'utf8').split(/\\r?\\n/))
        {
            const m = /^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)$/.exec(l);
            if (m && m[1] === name) v = m[2].trim();
        }
    }
    catch { /* no file */ }
    process.stdout.write(JSON.stringify(v ? { Authorization: scheme + ' ' + v } : {}));
}
`;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

async function main()
{
    const a = args(process.argv.slice(2));
    if (a.scratch) fs.mkdirSync(a.scratch, { recursive: true });
    const base = fs.realpathSync(a.scratch || os.tmpdir());
    const P = fs.mkdtempSync(path.join(base, 'pt-headers-helper-'));
    const home = path.join(P, 'home');
    const account = path.join(P, 'account');
    const proj = path.join(P, 'proj');
    const child = path.join(proj, 'child');
    const proj2 = path.join(P, 'proj2');
    for (const d of [home, account, child, proj2]) fs.mkdirSync(d, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: account };
    // nothing below may reach the real account
    if (![env.HOME, env.CLAUDE_CONFIG_DIR].every((d) => d.startsWith(P + path.sep))) throw new Error('HOME and CLAUDE_CONFIG_DIR must lie under the scratch folder');
    for (const d of [proj, proj2])
    {
        const root = path.join(d, '.preferred-tools');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'mcp-headers.js'), WRAPPER);
        if (a.helper) fs.copyFileSync(a.helper, path.join(root, 'real-headers.js'));
        fs.writeFileSync(path.join(root, '.mcps-secrets'), `# probe\nPROBE_VALUE=${FAKE}\n`);
    }
    const acctFile = path.join(account, '.claude.json');
    writeJson(acctFile, { projects: { [proj]: { hasTrustDialogAccepted: true } } });
    writeJson(path.join(account, 'settings.json'), { enableAllProjectMcpServers: true });
    const setTrust = (dir, on) => { const doc = readJson(acctFile); doc.projects = doc.projects || {}; doc.projects[dir] = { ...(doc.projects[dir] || {}), hasTrustDialogAccepted: on }; writeJson(acctFile, doc); };

    const { server, port, seen } = await fake.stub({ expected: EXPECTED });
    const url = (p) => `http://127.0.0.1:${port}/${p}`;
    const abs = path.join(proj, '.preferred-tools', 'mcp-headers.js');
    const quoted = abs.includes(' ') ? `"${abs}"` : abs;
    const regs = [
        { cwd: proj, name: 'hh-project', scope: 'project', entry: { type: 'http', url: url('p'), headersHelper: 'node .preferred-tools/mcp-headers.js PROBE_VALUE Bearer' } },
        { cwd: proj, name: 'hh-local', scope: 'local', entry: { type: 'http', url: url('l'), headersHelper: `node ${quoted} PROBE_VALUE Bearer` } },
        { cwd: proj, name: 'hh-user', scope: 'user', entry: { type: 'http', url: url('u'), headersHelper: `node ${quoted} PROBE_VALUE Bearer` } },
        { cwd: proj, name: 'hh-missing', scope: 'local', entry: { type: 'http', url: url('m'), headersHelper: 'node /nonexistent-probe-dir/mcp-headers.js PROBE_VALUE Bearer' } },
        { cwd: proj, name: 'hh-project-abs', scope: 'project', entry: { type: 'http', url: url('a'), headersHelper: `node ${quoted} PROBE_VALUE Bearer` } },
        { cwd: proj2, name: 'hh-untrusted', scope: 'project', entry: { type: 'http', url: url('n'), headersHelper: 'node .preferred-tools/mcp-headers.js PROBE_VALUE Bearer' } },
    ];
    const results = [];
    const report = (id, pass, detail) => { results.push(pass); console.log(`RESULT ${id} ${pass ? 'pass' : 'fail'} ${detail}`); };
    try
    {
        for (const r of regs)
        {
            const res = await fake.claude(r.cwd, ['mcp', 'add-json', r.name, JSON.stringify(r.entry), '-s', r.scope], env);
            if (res.status !== 0) console.log(`add ${r.name} -s ${r.scope}: exit ${res.status} - ${res.out.split('\n')[0]}`);
        }
        // stored: read back what the CLI wrote
        const doc = readJson(acctFile);
        const local = ((doc.projects || {})[proj] || {}).mcpServers || {};
        const mcpFile = path.join(proj, '.mcp.json');
        const shared = fs.existsSync(mcpFile) ? readJson(mcpFile).mcpServers || {} : {};
        const stored = { project: shared['hh-project'], local: local['hh-local'], user: (doc.mcpServers || {})['hh-user'] };
        for (const s of ['project', 'local', 'user'])
        {
            const want = regs.find((r) => r.name === `hh-${s}`).entry.headersHelper;
            const got = stored[s] && stored[s].headersHelper;
            report(`stored-${s}`, got === want, got === undefined ? 'not stored' : got === want ? 'headersHelper unchanged' : 'headersHelper changed');
        }
        const runsFile = (d) => path.join(d, '.preferred-tools', 'helper-runs.log');
        const runs = (d) => (fs.existsSync(runsFile(d)) ? fs.readFileSync(runsFile(d), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
        // one `claude mcp get`: what the stub saw on initialize, and which helper runs it logged
        const get = async (cwd, name, dir) =>
        {
            const s0 = seen.length;
            const h0 = runs(dir).length;
            const res = await fake.claude(cwd, ['mcp', 'get', name], env);
            const init = seen.slice(s0).find((x) => x.rpc === 'initialize');
            const status = (res.out.split('\n').find((l) => /Status:/.test(l)) || '').trim();
            return { auth: init ? init.auth : 'no request', status, runs: runs(dir).slice(h0).filter((x) => x.server === name) };
        };
        const real = (p) => fs.realpathSync(p);
        for (const s of ['project', 'local', 'user'])
        {
            const g = await get(proj, `hh-${s}`, proj);
            report(`header-${s}`, g.auth === 'expected', `initialize auth: ${g.auth}`);
            const want = s === 'user' ? real(account) : real(proj);
            const ran = g.runs.map((x) => real(x.cwd));
            report(`cwd-${s}`, ran.length > 0 && ran.every((d) => d === want), ran.length ? `ran in ${path.relative(P, ran[0]) || '.'}` : 'helper did not run');
        }
        const missing = await get(proj, 'hh-missing', proj);
        report('missing-helper', missing.auth === 'none', `initialize auth: ${missing.auth}; ${missing.status || 'no status line'}`);
        const untrusted = await get(proj2, 'hh-untrusted', proj2);
        report('untrusted', untrusted.auth === 'none' && untrusted.runs.length === 0, `initialize auth: ${untrusted.auth}; helper runs: ${untrusted.runs.length}`);
        const childCase = async (id) =>
        {
            const g = await get(child, 'hh-project', proj);
            report(id, g.auth !== 'expected' && g.runs.length === 0, `initialize auth: ${g.auth}; helper runs: ${g.runs.length}`);
        };
        await childCase('child-root-trusted');
        // M1: the same session, the project registration naming its helper by absolute path
        const ga = await get(child, 'hh-project-abs', proj);
        report('child-root-absolute', ga.auth !== 'expected' && ga.runs.length === 0, `initialize auth: ${ga.auth}; helper runs: ${ga.runs.length}`);
        setTrust(child, true);
        await childCase('child-both-trusted');
        setTrust(child, false);
        spawnSync('git', ['init', '-q'], { cwd: proj });
        await childCase('child-root-git');
    }
    finally
    {
        server.close();
        if (!a.keep) fs.rmSync(P, { recursive: true, force: true });
        else console.log(`kept: ${P}`);
    }
    return results.every(Boolean) ? 0 : 1;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error(`headers-helper probe: ${e.message}`); process.exit(2); });
