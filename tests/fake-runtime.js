#!/usr/bin/env node
'use strict';
// A stand-in for npm, uvx and docker on the fake world's PATH, so a test that applies a plan never downloads anything.
// It records each call as one JSON line in FAKE_RUNTIME_LOG ({ runtime, argv, pid }, and authSha256 - the SHA-256 hex of
// PT_BRIDGE_AUTH, never its value - when the bridge set it) and exits 0; FAKE_RUNTIME_FAIL=<runtime> makes that runtime
// exit 1, the way a fetch with no network or no matching release does. FAKE_RUNTIME_WAIT=1 makes it wait until its stdin
// ends, the way mcp-remote serves until Claude Code closes the pipe, then exit 0.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const runtime = process.argv[2];
const argv = process.argv.slice(3);
const auth = process.env.PT_BRIDGE_AUTH;
const line = { runtime, argv, pid: process.pid, ...(auth ? { authSha256: crypto.createHash('sha256').update(auth).digest('hex') } : {}) };
if (process.env.FAKE_RUNTIME_LOG) fs.appendFileSync(process.env.FAKE_RUNTIME_LOG, `${JSON.stringify(line)}\n`);
if (process.env.FAKE_RUNTIME_FAIL === runtime) { process.stderr.write(`${path.basename(runtime)}: fake failure\n`); process.exit(1); }
if (process.env.FAKE_RUNTIME_WAIT === '1')
{
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
}
else process.exit(0);
