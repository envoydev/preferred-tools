'use strict';
// 0.4.0's bridge end to end: the REAL claude CLI in a throwaway home and account (tests/harness.js), the real mcp-remote
// from npm in the throwaway npm cache, and a stub HTTP MCP server on 127.0.0.1 (tests/fake-mcp-http.js) standing in for
// Sentry. Every result is read back from what the CLI wrote and what the stub saw.
//
//   B1  sentry's bridge at project scope with the default names: fetched, filled by hand, then `claude mcp get` connects
//       through mcp-bridge.js and mcp-remote to /mcp/<org>/<project> with the key; a changed SENTRY_ORG reaches the next
//       start, and a child folder's start reaches it too. The key is in no file the CLI wrote and in none of its output.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../../scripts/claude-cli.js');
const fake = require('../fake-mcp-http.js');
const { Harness } = require('../harness.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const NETWORK = /could not resolve|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network/i;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-b-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// a test-only value, written by this case into the throwaway root and never printed
const KEY = 'pt-test-token';

test('B1 - the bridge starts for real, follows a changed slug after a restart, and serves a child folder', { skip: skipAll, timeout: 900000 }, async (t) =>
{
    const s = await fake.stub({ expected: `Sentry-Bearer ${KEY}` });
    try
    {
        const catalog = fake.stubBridgeCatalog(s.port);
        const h = new Harness({ root: path.join(base, 'b1') });
        // every project server approved, and the project and its child trusted: a parent folder's settings approve
        // nothing in a child (docs/sources.md, '.mcp.json in parent folders')
        fs.writeFileSync(path.join(h.account, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
        const dir = h.project('p');
        const child = path.join(dir, 'app');
        fs.mkdirSync(child);
        fake.trust(h, dir);
        fake.trust(h, child);

        const r = h.run(dir, { picks: { sentry: { route: 'bridge', scope: 'project' } } }, { catalog });
        assert.deepStrictEqual(r.plan.errors, [], r.rendered);
        assert.strictEqual(r.report.failed, null, `${r.rendered}\n${r.text}`);
        const root = path.join(dir, '.preferred-tools');
        const e = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.sentry;
        assert.deepStrictEqual(e.args.slice(0, 4), [path.join(root, 'mcp-bridge.js'), `http://127.0.0.1:${s.port}/mcp/{SENTRY_ORG}/{SENTRY_PROJECT?}`, 'SENTRY_ACCESS_TOKEN', 'Sentry-Bearer']);
        assert.ok(fs.existsSync(path.join(root, 'mcp-bridge.js')) && fs.existsSync(path.join(root, 'mcp-headers.js')), 'both files in the root');
        assert.strictEqual(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{"type":"commonjs"}\n');

        // fetch.js as the command runs it: mcp-remote into the throwaway npm cache, the bridge never started
        assert.ok(r.report.fetchFile, `apply wrote no fetch file:\n${r.text}`);
        const f = await h.fetch(r.report.fetchFile);
        if (f.warnings.some((w) => NETWORK.test(w))) return t.skip(`NOT RUN: no network (${f.warnings[0].slice(0, 160)})`);
        assert.deepStrictEqual(f.warnings, [], f.text);
        assert.deepStrictEqual(f.skipped, ["'sentry' not started: a bridge has no first-run work beyond its package"]);

        const secrets = path.join(root, '.mcps-secrets');
        fake.fill(secrets, 'SENTRY_ACCESS_TOKEN', KEY);
        fake.fill(secrets, 'SENTRY_ORG', 'acme');
        fake.fill(secrets, 'SENTRY_PROJECT', 'web');

        // what one `claude mcp get sentry` in `cwd` reached: the path and auth of each initialize, its Status line
        const get = async (cwd) =>
        {
            const s0 = s.seen.length;
            const res = await fake.claude(cwd, ['mcp', 'get', 'sentry'], h.env, 180000);
            const inits = s.seen.slice(s0).filter((x) => x.rpc === 'initialize');
            return { out: res.out, status: (res.out.split('\n').find((l) => /Status:/.test(l)) || '').trim(), paths: inits.map((x) => x.path), auths: inits.map((x) => x.auth) };
        };
        const first = await get(dir);
        t.diagnostic(`project: ${first.status}; initialize ${JSON.stringify(first.paths)} ${JSON.stringify(first.auths)}`);
        assert.match(first.status, /Connected/, first.out);
        assert.ok(first.paths.includes('/mcp/acme/web'), JSON.stringify(first.paths));
        assert.ok(first.auths.length && first.auths.every((a) => a === 'expected'), JSON.stringify(first.auths));

        fake.fill(secrets, 'SENTRY_ORG', 'beta');
        const second = await get(dir);
        assert.match(second.status, /Connected/, second.out);
        assert.ok(second.paths.includes('/mcp/beta/web') && !second.paths.includes('/mcp/acme/web'), JSON.stringify(second.paths));

        const inChild = await get(child);
        t.diagnostic(`child: ${inChild.status}; initialize ${JSON.stringify(inChild.paths)}`);
        assert.match(inChild.status, /Connected/, inChild.out);
        assert.ok(inChild.paths.includes('/mcp/beta/web'), JSON.stringify(inChild.paths));

        // the key: in .mcps-secrets only
        for (const out of [first.out, second.out, inChild.out]) assert.ok(!out.includes(KEY), 'the CLI printed the key');
        const holders = h.files().filter((file) => file !== secrets && fs.statSync(file).size < 5e6 && fs.readFileSync(file, 'utf8').includes(KEY));
        assert.deepStrictEqual(holders.filter((file) => !file.includes(`${path.sep}.npm${path.sep}`)), [], 'the key is in no other file of the world');
        assert.ok(h.realUntouched().ok, 'the real account is untouched');
    }
    finally { await s.close(); }
});
