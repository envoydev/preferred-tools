// preferred-tools mcp-headers 4
'use strict';
// The header helper a hosted registration names as `headersHelper` (spec D4): `node <root>/mcp-headers.js <NAME> <SCHEME>
// [<global root>]`. Claude Code runs it before it connects and sends the JSON it prints as request headers, so the key stays
// in a key file and never enters a registration.
//
// It reads <NAME> from `.mcps-secrets` beside it, then from the third argument's folder, then ~/.preferred-tools, then
// ~/.alfred - the first non-empty value wins - and prints {"Authorization":"<SCHEME> <value>"}. With no value it prints {}
// and one stderr line naming <NAME> and the files it read, never a value. It always exits 0 with JSON on stdout.
// For `Basic`, a value holding `:` is `email:api_token` as the user wrote it and is sent base64-encoded; any other value
// is sent as it is. mcp-bridge.js requires this file for its reader; it prints nothing itself.
//
// It prints a header only when Claude Code runs it: Claude Code sets CLAUDE_CODE_MCP_SERVER_NAME for a headersHelper
// (2.1.85+). Run by hand - a terminal, or an agent's shell tool - it reads no key file and prints {} and one stderr
// line, so a key never lands in a terminal or a transcript.
//
// This file is copied into the user's root folder and runs outside the plugin, so it needs nothing but Node: `node:`
// modules only, and its own copy of keys.js's dotenv grammar. Its bytes are pinned by tests/lint.js (HELPER_SHA256); a
// change here bumps HELPER_VERSION and the first line together.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HELPER_VERSION = 4;
const SECRETS = '.mcps-secrets';
const NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEME_RULE = /^[!-~]+$/;

// The same grammar as keys.js readDotenv: `KEY=value`, `export ` allowed before it, one pair of matching quotes around the
// trimmed value dropped; `#` and `;` lines and blank lines are comments. A BOM decides UTF-16 or UTF-8. -> {} | null
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENT = /^\s*(?:[#;]|$)/;
// A value as written: inside matching quotes it stands as it is; unquoted, a note after whitespace and # is dropped -
// `NAME=abc # work` is abc, `NAME=abc#1` is abc#1
const unquote = (raw) =>
{
    const q = /^\s*(["'])(.*?)\1(?:\s+#.*)?\s*$/.exec(raw);
    return q ? q[2] : raw.replace(/\s+#.*$/, '').trim();
};
function readDotenv(file)
{
    let buf;
    try { buf = fs.readFileSync(file); }
    catch { return null; }
    const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8').replace(/^﻿/, '');
    const values = {};
    for (const line of text.split(/\r?\n/))
    {
        if (COMMENT.test(line)) continue;
        const m = LINE.exec(line);
        if (m) values[m[1]] = unquote(m[2]);
    }
    return values;
}

// The files read, in order: beside the helper, the extra root, then the two home roots. Equal to keys.js hostedChain.
function chainOf(dir, extraRoot, home)
{
    const dirs = [dir, extraRoot, path.join(home, '.preferred-tools'), path.join(home, '.alfred')].filter(Boolean);
    return [...new Set(dirs.map((d) => path.join(d, SECRETS)))];
}

// sha256 hex of the text with CRLF turned to LF: one digest for every comparison of helper bytes, so a CRLF copy is the
// same helper.
const digestOf = (text) => crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');

// The first non-empty value of <name> in `files` order, and the file it came from. -> { value, file } | null
function valueIn(name, files)
{
    for (const file of files)
    {
        const value = (readDotenv(file) || {})[name];
        if (value) return { value, file };
    }
    return null;
}

// The Authorization value: `<scheme> <value>`; for Basic, a value holding `:` is email:api_token, sent base64-encoded.
const authValue = (scheme, value) => `${scheme} ${scheme === 'Basic' && value.includes(':') ? Buffer.from(value, 'utf8').toString('base64') : value}`;

function headers(argv, env)
{
    if (!env.CLAUDE_CODE_MCP_SERVER_NAME)
        return { out: {}, note: 'mcp-headers: prints a header only when Claude Code runs it as a headersHelper (CLAUDE_CODE_MCP_SERVER_NAME is unset) - no key file read' };
    const [name, scheme, extraRoot] = argv;
    if (!name || !NAME_RULE.test(name) || !scheme || !SCHEME_RULE.test(scheme))
        return { out: {}, note: 'mcp-headers: usage: node mcp-headers.js <NAME> <SCHEME> [<root>]' };
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const files = chainOf(__dirname, extraRoot ? path.resolve(extraRoot) : null, home);
    const found = valueIn(name, files);
    if (found) return { out: { Authorization: authValue(scheme, found.value) }, note: null };
    return { out: {}, note: `mcp-headers: no value for ${name} in ${files.join(', ')}` };
}

function main()
{
    let result;
    try { result = headers(process.argv.slice(2), process.env); }
    catch { result = { out: {}, note: 'mcp-headers: could not read the key files' }; }
    if (result.note) process.stderr.write(`${result.note.replace(/[\r\n]+/g, ' ')}\n`);
    process.stdout.write(`${JSON.stringify(result.out)}\n`);
}

if (require.main === module) main();

module.exports = { HELPER_VERSION, chainOf, digestOf, readDotenv, valueIn, authValue };
