'use strict';
// The 0.3.0 field fixes end to end: the REAL claude CLI in throwaway homes and accounts (tests/harness.js), a stub HTTP
// MCP server on 127.0.0.1 (tests/fake-mcp-http.js) standing in for a hosted server, every result read back from the
// files the CLI wrote.
//
//   X7  a refused key: what `claude mcp get` prints for a 401 and a 403 from a hosted server whose key is filled
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../../scripts/claude-cli.js');
const roots = require('../../scripts/roots.js');
const { REFUSED } = require('../../scripts/apply.js');
const fake = require('../fake-mcp-http.js');
const { Harness } = require('../harness.js');

const skipAll = cli.available() ? false : 'NOT RUN: no claude CLI on PATH';
const T = { skip: skipAll, timeout: 900000 };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-x-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const G = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const KEY = `mx-${crypto.randomBytes(12).toString('hex')}`;
const ok = (r) => { assert.deepStrictEqual(r.plan.errors, [], r.rendered); assert.strictEqual(r.report.failed, null, `${r.rendered}\n${r.text}`); };

test('X7 - a refused key: claude mcp get on a hosted server that answers 401 or 403 with its key filled', T, async () =>
{
    for (const status of [401, 403])
    {
        const h = new Harness({ root: path.join(base, `x7-${status}`) });
        const s = await fake.stub({ expected: `Bearer ${KEY}`, status });
        const catalog = fake.stubCatalog(s.port);
        try
        {
            const dir = h.project('p');
            fake.trust(h, dir);
            ok(h.run(dir, { picks: { github: { route: 'remote', scope: 'local', token: true } } }, { catalog }));
            fake.fill(path.join(dir, '.preferred-tools', roots.FILES.secrets), G, KEY);
            // the first get in a fresh world was once seen to print no Issue line (docs/sources.md): one more get, then the words
            let out = '';
            for (let i = 0; i < 2 && !/^\s*Issue:/m.test(out); i++) out = (await fake.claude(dir, ['mcp', 'get', 'github'], h.env)).out;
            const line = (re) => (out.split('\n').find((l) => re.test(l)) || '').trim();
            console.log(`X7 ${status}: ${line(/Status:/)} | ${line(/Issue:/).slice(0, 120)}`);
            assert.ok(s.seen.some((x) => x.auth === 'expected'), 'the key reached the server');
            assert.strictEqual(line(/Status:/), 'Status: ✘ Failed to connect');
            assert.match(line(/Issue:/), REFUSED);
            assert.ok(!out.includes(KEY), 'the CLI prints no key');
        }
        finally { await s.close(); }
    }
});
