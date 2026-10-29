#!/usr/bin/env node
'use strict';
// A stdio MCP server for fetch.js's first start: `answer` replies to initialize and keeps running, as a real server does;
// `exit` exits 3 before answering, as a server with a bad launch does. With `--log <file> --tag <tag>` it appends
// {"tag", "cwd"} to the file as one JSON line when it starts, so a probe can tell which registrations a session started,
// and exits when its stdin closes, so a session that ends leaves none running.
const fs = require('node:fs');
const mode = process.argv[2] || 'answer';
const opt = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
if (opt('--log'))
{
    fs.appendFileSync(opt('--log'), `${JSON.stringify({ tag: opt('--tag'), cwd: process.cwd() })}\n`);
    process.stdin.on('end', () => process.exit(0));
}
if (mode === 'exit') { process.stderr.write('fake server: cannot start\n'); process.exit(3); }
let buf = '';
process.stdin.on('data', (d) =>
{
    const lines = `${buf}${d}`.split('\n');
    buf = lines.pop();
    for (const line of lines)
    {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '1' } } })}\n`);
    }
});
setInterval(() => {}, 60000);
