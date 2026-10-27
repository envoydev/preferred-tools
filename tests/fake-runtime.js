#!/usr/bin/env node
'use strict';
// A stand-in for npm, uvx and docker on the fake world's PATH, so a test that applies a plan never downloads anything.
// It records each call as one JSON line in FAKE_RUNTIME_LOG ({ runtime, argv }) and exits 0; FAKE_RUNTIME_FAIL=<runtime>
// makes that runtime exit 1, the way a fetch with no network or no matching release does.
const fs = require('node:fs');
const path = require('node:path');

const runtime = process.argv[2];
const argv = process.argv.slice(3);
if (process.env.FAKE_RUNTIME_LOG) fs.appendFileSync(process.env.FAKE_RUNTIME_LOG, `${JSON.stringify({ runtime, argv })}\n`);
if (process.env.FAKE_RUNTIME_FAIL === runtime) { process.stderr.write(`${path.basename(runtime)}: fake failure\n`); process.exit(1); }
process.exit(0);
