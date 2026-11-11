// preferred-tools mcp-bridge 1
'use strict';
// The bridge a hosted route of runtime 'bridge' registers (0.4.0): `node <root>/mcp-bridge.js <url template> <KEY_NAME>
// <SCHEME> <package@version> [<global root>]`. A hosted server whose URL holds a per-project value - Sentry's
// organization slug - has no header for it, and headersHelper changes headers only; so at each start this file fills
// the template's `{NAME}` segments from .mcps-secrets and runs the pinned mcp-remote through npx against the filled URL.
// Changing a value and restarting the server is enough. The registration holds variable names only.
//
// It is copied into the root folder beside mcp-headers.js and runs outside the plugin, so it requires only node: modules
// and ./mcp-headers.js, whose reader it shares (helper 4 or newer): the same .mcps-secrets chain, the first non-empty
// value wins. A key reaches mcp-remote only as PT_BRIDGE_AUTH in its environment; the command line holds
// `Authorization:${PT_BRIDGE_AUTH}`, which mcp-remote expands itself (docs/sources.md, 'mcp-remote 0.16.0'). The bridge
// prints nothing but its own one error line, which names variables and files, never a value - so it needs no
// CLAUDE_CODE_MCP_SERVER_NAME guard.
//
// A URL value must be a plain name (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`), so no value can change the path, reach cmd.exe as a
// metacharacter or read as a flag; a template name that is the key's name or reads as a credential is refused before
// any file is read, so a key never goes in a URL. A missing key exits 1 before npx starts: mcp-remote never sends a
// request with no Authorization header, the one that would open its OAuth sign-in in a browser.
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE_VERSION = 1;
const NEEDS_HELPER = 4;
// a copy of keys.js credentialName's test (tests/lint.js checks the two are equal)
const CREDENTIAL = /TOKEN|SECRET|PASSWORD|KEY|AUTH/i;
const NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEME_RULE = /^[!-~]+$/;
const PACKAGE_RULE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ARG_RULE = /^[A-Za-z0-9_./:@+,=${}-]+$/;
const PLACEHOLDER = /^\{([^{}?]*)(\?)?\}$/;
const USAGE = 'usage: node mcp-bridge.js <url template> <KEY_NAME> <SCHEME> <package@version> [<root>]';
const PLAIN = 'is not a plain name (letters, digits, _ . -)';

// The template's origin and path segments. -> { origin, segments } | null (not http(s), a brace in the origin, a query or
// a fragment)
function partsOf(template)
{
    if (typeof template !== 'string') return null;
    const m = /^(https?:\/\/[^/{}?#]+)((?:\/[^/]*)*)$/.exec(template);
    if (!m) return null;
    const segments = m[2] ? m[2].split('/').slice(1) : [];
    if (segments.some((s) => !PLACEHOLDER.test(s) && /[{}?#]/.test(s))) return null;
    return { origin: m[1], segments };
}

// The template's variables, in order. `{NAME}` is a required whole segment; `{NAME?}` is optional and only the last.
// -> [{ name, optional }] | null (a usage error)
function templateNames(template)
{
    const parts = partsOf(template);
    if (!parts) return null;
    const names = [];
    for (const [i, s] of parts.segments.entries())
    {
        const m = PLACEHOLDER.exec(s);
        if (!m) continue;
        if (!NAME_RULE.test(m[1])) return null;
        if (m[2] && i !== parts.segments.length - 1) return null;
        if (names.some((n) => n.name === m[1])) return null;
        names.push({ name: m[1], optional: Boolean(m[2]) });
    }
    return names;
}

// The URL with each variable filled; an empty optional segment and its `/` are left out. `values` is
// { NAME: string | undefined }. -> { url } | { error } (naming the variable, never the value)
function fillTemplate(template, values)
{
    const parts = partsOf(template);
    if (!parts || !templateNames(template)) return { error: USAGE };
    const out = [];
    for (const s of parts.segments)
    {
        const m = PLACEHOLDER.exec(s);
        if (!m) { out.push(s); continue; }
        const v = values[m[1]];
        if (v === undefined || v === '')
        {
            if (m[2]) continue;
            return { error: `no value for ${m[1]}` };
        }
        if (!SLUG.test(v)) return { error: `${m[1]} ${PLAIN}` };
        out.push(v);
    }
    return { url: parts.origin + out.map((s) => `/${s}`).join('') };
}

// https, or http on the two hosts mcp-remote takes it for (127.0.0.1, localhost)
function originAllowed(origin)
{
    let u;
    try { u = new URL(origin); }
    catch { return false; }
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
}

// What to start, read from argv and the .mcps-secrets chain; nothing is started here.
// argv: [template, KEY_NAME, SCHEME, '<package>@<version>', globalRoot?]
// -> { error } | { url, keyName, keyFile, names, auth, command, args, childEnv }
function launch(argv, env, { dir, platform, helper } = {})
{
    const [template, keyName, scheme, pkg, globalRoot] = argv;
    if (!template || !keyName || !NAME_RULE.test(keyName) || !scheme || !SCHEME_RULE.test(scheme) || !pkg || !PACKAGE_RULE.test(pkg)) return { error: USAGE };
    const names = templateNames(template);
    if (!names) return { error: USAGE };
    if (!originAllowed(partsOf(template).origin)) return { error: 'the URL template is not https - mcp-remote takes http only on 127.0.0.1 or localhost' };
    // before any file is read: a key never goes in a URL
    const keyLike = names.find((n) => n.name === keyName || CREDENTIAL.test(n.name));
    if (keyLike) return { error: `${keyLike.name} in the URL template names a key - a key never goes in a URL` };
    const h = helper || require('./mcp-headers.js');
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const files = h.chainOf(dir, globalRoot ? path.resolve(globalRoot) : null, home);
    const key = h.valueIn(keyName, files);
    if (!key) return { error: `no value for ${keyName} in ${files.join(', ')}` };
    const values = {};
    for (const n of names)
    {
        const v = h.valueIn(n.name, files);
        if (!v)
        {
            if (n.optional) continue;
            return { error: `no value for ${n.name} in ${files.join(', ')}` };
        }
        if (!SLUG.test(v.value)) return { error: `${n.name} in ${v.file} ${PLAIN}` };
        values[n.name] = v.value;
    }
    const filled = fillTemplate(template, values);
    if (filled.error) return { error: filled.error };
    const tail = ['-y', pkg, filled.url, '--header', 'Authorization:${PT_BRIDGE_AUTH}', '--transport', 'http-only'];
    if (tail.some((a) => !ARG_RULE.test(a))) return { error: USAGE };
    const win = platform === 'win32';
    return {
        url: filled.url,
        keyName,
        keyFile: key.file,
        names,
        auth: h.authValue(scheme, key.value),
        command: win ? (env.ComSpec || 'cmd.exe') : 'npx',
        args: win ? ['/d', '/c', 'npx', ...tail] : tail,
        childEnv: { ...env, PT_BRIDGE_AUTH: h.authValue(scheme, key.value) },
    };
}

const fail = (text) => { process.stderr.write(`mcp-bridge: ${String(text).replace(/[\r\n]+/g, ' ')}\n`); process.exit(1); };

function main()
{
    let helper = null;
    try { helper = require('./mcp-headers.js'); }
    catch { helper = null; }
    const number = helper && Number.isInteger(helper.HELPER_VERSION) ? helper.HELPER_VERSION : 'missing';
    if (!helper || !(helper.HELPER_VERSION >= NEEDS_HELPER) || typeof helper.valueIn !== 'function' || typeof helper.authValue !== 'function')
        fail(`mcp-headers.js beside it is helper ${number} - the bridge needs ${NEEDS_HELPER}; run /preferred-tools:fix`);
    let r;
    try { r = launch(process.argv.slice(2), process.env, { dir: __dirname, platform: process.platform, helper }); }
    catch { r = { error: 'could not read the key files' }; }
    if (r.error) fail(r.error);
    const child = spawn(r.command, r.args, { stdio: 'inherit', windowsHide: true, env: r.childEnv });
    child.on('error', (e) => fail(`could not start npx - ${e.message}`));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : (code === null ? 1 : code)));
}

if (require.main === module) main();

module.exports = { BRIDGE_VERSION, NEEDS_HELPER, CREDENTIAL, templateNames, fillTemplate, launch };
