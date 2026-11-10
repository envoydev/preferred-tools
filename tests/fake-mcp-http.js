'use strict';
// A stub HTTP MCP server on 127.0.0.1, in the calling process: it answers initialize and tools/list, and records per
// request the path, the JSON-RPC method and whether the `Authorization` header equals the expected value - never the
// value itself. Used by tests/probes/headers-helper.js and the matrix's key cases (keys.test.js, workspace.test.js W4).
const fs = require('node:fs');
const http = require('node:http');
const { execFile } = require('node:child_process');
const account = require('../scripts/account.js');
const catalogLib = require('../scripts/catalog.js');

// -> Promise<{ server, port, seen: [{ path, rpc, auth: 'none' | 'expected' | 'other' }], close }>. `expected`: the whole
// header value a request must carry to count as 'expected'.
function stub({ expected })
{
    const seen = [];
    const server = http.createServer((req, res) =>
    {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () =>
        {
            let m = {};
            try { m = JSON.parse(body); }
            catch { /* not JSON */ }
            const a = req.headers.authorization;
            seen.push({ path: req.url, rpc: m.method || null, auth: a === undefined ? 'none' : a === expected ? 'expected' : 'other' });
            if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
            if (m.method && m.id === undefined) { res.writeHead(202); return res.end(); }
            let result = {};
            if (m.method === 'initialize') result = { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0.0.1' } };
            if (m.method === 'tools/list') result = { tools: [] };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) })));
}

// `claude` without blocking this process, so the stub can answer while it runs -> Promise<{ status, out }>
function claude(cwd, argv, env, timeout = 90000)
{
    return new Promise((resolve) =>
    {
        execFile('claude', argv, { cwd, env, encoding: 'utf8', timeout }, (err, stdout, stderr) =>
            resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout || ''}${stderr || ''}` }));
    });
}

// What the stub saw on the last initialize of one `claude mcp get <name>` in `cwd` - the connection the server keeps:
// 'expected', 'other', 'none' or 'no request'. The first get in a fresh world was seen to connect twice, first without
// the helper's header and then with it, the second followed by tools/list (2.1.322, 2026-11-10); `inits` lists each.
async function authOnGet(s, cwd, name, env)
{
    const s0 = s.seen.length;
    const res = await claude(cwd, ['mcp', 'get', name], env);
    const inits = s.seen.slice(s0).filter((x) => x.rpc === 'initialize').map((x) => x.auth);
    return { auth: inits.length ? inits[inits.length - 1] : 'no request', inits, status: (res.out.split('\n').find((l) => /Status:/.test(l)) || '').trim(), exit: res.status };
}

// The catalog with github's hosted route pointed at a stub: its URL and the fingerprint the inventory matches it by
function stubCatalog(port)
{
    const c = catalogLib.load();
    const raw = JSON.parse(JSON.stringify({ ...c, reserved: [...c.reserved], byId: undefined }));
    const remote = raw.tools.find((r) => r.id === 'github').routes.remote;
    remote.url = `http://127.0.0.1:${port}/mcp/`;
    remote.fingerprints = [{ host: '127.0.0.1', pathPrefix: '/mcp' }];
    return { ...raw, reserved: new Set(raw.reserved), byId: new Map(raw.tools.map((r) => [r.id, r])) };
}

// A folder's trust, as the trust dialog writes it in the account file of a harness world (tests/harness.js)
function trust(h, dir, on = true)
{
    const file = account.accountFile(h.env);
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    doc.projects = doc.projects || {};
    doc.projects[dir] = { ...(doc.projects[dir] || {}), hasTrustDialogAccepted: on };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

// The user fills a name the apply wrote (`NAME=`), or adds it
function fill(file, name, value)
{
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const re = new RegExp(`^${name}=.*$`, 'm');
    fs.writeFileSync(file, re.test(text) ? text.replace(re, () => `${name}=${value}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${name}=${value}\n`);
}

module.exports = { stub, claude, authOnGet, stubCatalog, trust, fill };
