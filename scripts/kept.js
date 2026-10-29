'use strict';
// KEPT - no live credential in a file a command line names.
//
// alfred-code's secret guard (v3.2.1 stack/hooks/guard-secret-value.js) refuses a script run that names a JSON file
// holding a live credential, and its Stop guard asks for a rotation once one shows in a tool result. So the files the
// commands hand from one script to the next - inventory, plan, rollback - carry each credential value as MARKER, and
// apply.js puts the real one back in its own process from the registration it was read from.
//
// Masked whole: every `headers` value; a value under a key the guard's file-key test names (its credKey, :154-156), or
// below one; an arg after a flag that test names (`--api-key <v>`, `--token=<v>`). Masked as that part only, anywhere
// else: a known token shape, a PEM private key, a connection string's `Password=` and a URL's userinfo password. Never
// masked: a value of nothing but ${NAME} / ${NAME:-default} placeholders after at most one scheme word (`Bearer
// ${CONTEXT7_API_KEY}`), and a catalog row's location keys, which configure reads.
const MARKER = '${PREFERRED_TOOLS_KEPT}';

// the guard's tests (v3.2.1 :63-67, :143-156), copied so this file masks at least what it blocks
const SECRET_KEY_RE = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|DSN|CREDENTIAL|AUTH)$/i;
const FILE_KEY_EXTRA = /(?:^|[._-])pass(?:phrase)?$|(?:^|[._-])(?:client|private)[-_]?key[-_]?data$|^requirepass$/i;
const CAMEL_PASS = /[a-z0-9](?:Pass(?:phrase)?|PWD|Pwd)$/;
const credKey = (k) => SECRET_KEY_RE.test(k) || FILE_KEY_EXTRA.test(k) || CAMEL_PASS.test(k);
const SHAPE = /\b(?:sntryu_[0-9a-f]{16,}|ctx7sk-[0-9a-f-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g;
const PAIR = /((?:^|[;,])\s*(?:password|pwd)\s*=\s*)([^;,]*)/gi;
const USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^@\s/]+)(?=@)/gi;
const PLACEHOLDERS = /^\s*(?:[A-Za-z][\w-]*\s+)?(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})+\s*$/;

const live = (s) => typeof s === 'string' && s.trim() !== '' && !PLACEHOLDERS.test(s);
const maskParts = (s) => s.replace(PEM, MARKER).replace(SHAPE, MARKER)
    .replace(PAIR, (all, head, value) => (live(value) ? head + MARKER : all))
    .replace(USERINFO, (all, head, value) => (live(value) ? head + MARKER : all));
const keepString = (s, whole) => (!live(s) ? s : whole ? MARKER : maskParts(s));
// `--api-key` -> 'api-key'; a bare value or a lone dash -> null
const flagName = (a) => (typeof a === 'string' && /^--?[A-Za-z]/.test(a) ? a.replace(/^--?/, '').split('=')[0] : null);

function locationKeys(row)
{
    const derived = (row && row.locations && row.locations.derived) || [];
    return { env: new Set(derived.filter((d) => d.in === 'env').map((d) => d.key)), arg: new Set(derived.filter((d) => d.in === 'arg').map((d) => d.key)) };
}

// an argument list: a value after a credential flag is masked whole, one after a location flag never
function keepArgs(args, whole, locArgs = new Set())
{
    return args.map((a, i) =>
    {
        if (typeof a !== 'string') return keepNode(a, '', whole);
        const prev = i > 0 ? args[i - 1] : null;
        if (locArgs.has(prev)) return a;
        const eq = a.indexOf('=');
        if (flagName(a) && eq > 0)
        {
            const flag = a.slice(0, eq);
            if (locArgs.has(flag)) return a;
            const value = a.slice(eq + 1);
            return `${flag}=${keepString(value, whole || credKey(flagName(flag)))}`;
        }
        if (flagName(a)) return a;
        return keepString(a, whole || Boolean(flagName(prev) && !prev.includes('=') && credKey(flagName(prev))));
    });
}

function keepNode(node, key, whole)
{
    if (typeof node === 'string') return keepString(node, whole || credKey(key));
    if (Array.isArray(node)) return keepArgs(node, whole || credKey(key));
    if (!node || typeof node !== 'object') return node;
    const below = whole || credKey(key);
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, keepNode(v, k, below)]));
}

// keep(entry, row) -> a copy with every credential value as MARKER. `row` is the catalog row the registration matched,
// for its location keys; null for the user's own.
function keep(entry, row)
{
    if (!entry || typeof entry !== 'object') return entry;
    const loc = locationKeys(row);
    const out = {};
    for (const [k, v] of Object.entries(entry))
    {
        if (k === 'args' && Array.isArray(v)) out.args = keepArgs(v, false, loc.arg);
        else if (k === 'headers' && v && typeof v === 'object' && !Array.isArray(v)) out.headers = Object.fromEntries(Object.entries(v).map(([h, x]) => [h, keepNode(x, h, true)]));
        else if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) out.env = Object.fromEntries(Object.entries(v).map(([e, x]) => [e, loc.env.has(e) ? x : keepNode(x, e, false)]));
        else out[k] = keepNode(v, k, false);
    }
    return out;
}

const at = (node, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), node);

// restore(entry, source, row) -> { entry } | { error }. Each string holding MARKER takes the string at the same place in
// `source` (the registration as it is now) whose kept text equals it; an arg takes the first unused source arg whose
// kept text equals it, in order, so an arg a splice moved still finds its value.
function restore(entry, source, row)
{
    const kept = keep(source || {}, row);
    const sourceArgs = Array.isArray(source && source.args) ? source.args : [];
    const used = new Set();
    let error = null;
    const walk = (node, path) =>
    {
        if (typeof node === 'string')
        {
            if (!node.includes(MARKER)) return node;
            if (path.length === 2 && path[0] === 'args')
            {
                const j = (kept.args || []).findIndex((x, i) => !used.has(i) && x === node);
                if (j < 0) { error = error || `args[${path[1]}] holds a kept value the registration no longer has`; return node; }
                used.add(j);
                return sourceArgs[j];
            }
            if (at(kept, path) !== node) { error = error || `${path.join('.')} holds a kept value the registration no longer has`; return node; }
            return at(source, path);
        }
        if (Array.isArray(node)) return node.map((x, i) => walk(x, [...path, i]));
        if (!node || typeof node !== 'object') return node;
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, [...path, k])]));
    };
    const out = walk(entry, []);
    return error ? { error } : { entry: out };
}

const holdsKept = (node) => JSON.stringify(node === undefined ? null : node).includes(MARKER);

// credentialPaths(entry, row) -> the dotted path of every credential value the entry holds, live or already MARKER
// ('headers.X-API-Key', 'args.3', 'url'), for the check that a committed file never gets one.
function credentialPaths(entry, row)
{
    const masked = keep(entry, row);
    const out = [];
    const walk = (node, kept, path) =>
    {
        if (typeof node === 'string') { if (node !== kept || node.includes(MARKER)) out.push(path.join('.')); return; }
        if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], kept == null ? undefined : kept[k], [...path, k]);
    };
    walk(entry, masked, []);
    return out;
}

module.exports = { MARKER, keep, restore, holdsKept, credKey, credentialPaths };
