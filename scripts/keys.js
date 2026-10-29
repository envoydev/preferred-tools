'use strict';
// KEYS - where a token route's key comes from, and how it goes into a registration (D7; the user's ruling, 2026-10-29:
// 'preffered tools must consider alfreds keys files when alfred present, if not then preffered tools files', delivered
// as 'Write it in at install').
//
// A key is read here, in the process that writes the registration, and goes nowhere else: never printed, never in a file
// a command line names, never asked for. The user fills the key files by hand, in the dotenv grammar alfred-code's store
// uses; nothing here writes one.
//
//   local scope, alfred-code present   its store chain, through the engine its install copied into the project
//                                      (.claude/hooks/secret-chain.js chainOf); no engine: .alfred/.secrets, then
//                                      .alfred/.sensitive-data. Never .preferred-tools, so a key lives in one place.
//   local scope, no alfred-code        <project>/.preferred-tools/.secrets, then ~/.preferred-tools/.secrets
//   user scope                         ~/.preferred-tools/.secrets, then (alfred-code present) the local chain above
//   project scope                      nothing: the committed .mcp.json keeps ${VAR}
//
// alfred-code is present for keys when it is enabled for the project AND the project holds its engine or a store file,
// so a project it never set up reads preferred-tools' files. A project key file git does not ignore is refused and named.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const account = require('./account.js');

const KEY_FILE = path.join('.preferred-tools', '.secrets');
const homeFile = (env) => path.join(account.homeDir(env), KEY_FILE);
const projectFile = (project) => path.join(project, KEY_FILE);
const engineOf = (project) => path.join(project, '.claude', 'hooks', 'secret-chain.js');
const alfredStores = (project) => ['.secrets', '.sensitive-data'].map((n) => path.join(project, '.alfred', n));
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

// alfred-code's dotenv grammar (v3.2.1 stack/hooks/layout.js readDotenv): `KEY=value`, `export ` allowed before it, one
// pair of matching quotes around the trimmed value dropped; `#` and `;` lines and blank lines are comments, any other line
// is skipped. A BOM decides UTF-16 or UTF-8. -> { KEY: value } | null when the file cannot be read
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const COMMENT = /^\s*(?:[#;]|$)/;
const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
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

const alfredPresent = (project, alfredEnabled) => Boolean(alfredEnabled) && [engineOf(project), ...alfredStores(project)].some(isFile);

// A project key file inside a git work tree that git does not ignore: committed, or one `git add` from it. -> the refusal
// or null (ignored, outside a work tree, or no git)
function notIgnored(file)
{
    if (!isFile(file)) return null;
    const r = spawnSync('git', ['check-ignore', '-q', path.basename(file)], { cwd: path.dirname(file), windowsHide: true });
    return r.status === 1 ? `${file} is not git-ignored - a key file must never be committed; add it to .gitignore` : null;
}

// One source of keys, in order: { files, read() -> { values, from } | { error } }. `files` is what a report names.
function fileSource(file, inProject)
{
    return {
        files: [file],
        read: () =>
        {
            const refused = inProject ? notIgnored(file) : null;
            if (refused) return { error: refused };
            const values = readDotenv(file) || {};
            return { values, from: Object.fromEntries(Object.keys(values).map((k) => [k, file])) };
        },
    };
}

// alfred-code's chain, through its own engine, required in this process: never named on a command line (its guard
// denies one that names it) and never re-implemented here, so its ignore lines, worktrees and kill switch hold.
function engineSource(project, env)
{
    const engine = engineOf(project);
    return {
        files: [alfredStores(project)[0]],
        read: () =>
        {
            const named = path.relative(project, engine).split(path.sep).join('/');
            let chain;
            try
            {
                const dir = path.dirname(engine) + path.sep;
                for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
                const mod = require(engine);
                if (typeof mod.chainOf !== 'function') return { error: `alfred-code's ${named} has no chainOf - nothing read from it` };
                chain = mod.chainOf(project, { env });
            }
            catch (e) { return { error: `alfred-code's ${named} failed (${e.message}) - nothing read from it` }; }
            if (!chain || !chain.values || typeof chain.values !== 'object') return { error: `alfred-code's ${named} chainOf gave no values - nothing read from it` };
            const stores = Array.isArray(chain.stores) ? chain.stores : [];
            for (const s of stores)
            {
                const refused = s && s.file ? notIgnored(s.file) : null;
                if (refused) return { error: refused };
            }
            const fileOf = (k) => { const s = stores.find((x) => chain.from && x.rel === chain.from[k]); return s ? s.file : engine; };
            return { values: chain.values, from: Object.fromEntries(Object.keys(chain.values).map((k) => [k, fileOf(k)])) };
        },
    };
}

function sourcesOf(project, scope, { env = process.env, alfredEnabled = false } = {})
{
    if (scope === 'project') return { source: 'none', list: [] };
    const alfred = alfredPresent(project, alfredEnabled);
    const chain = isFile(engineOf(project)) ? [engineSource(project, env)] : alfredStores(project).map((f) => fileSource(f, true));
    if (scope === 'local') return alfred ? { source: 'alfred-code', list: chain } : { source: 'preferred-tools', list: [fileSource(projectFile(project), true), fileSource(homeFile(env), false)] };
    return { source: 'preferred-tools', list: [fileSource(homeFile(env), false), ...(alfred ? chain : [])] };
}

// The files a scope's key comes from, in order, read from nothing: what the plan names.
function filesFor(project, scope, opts)
{
    return sourcesOf(project, scope, opts).list.flatMap((s) => s.files);
}

// keysFor(project, scope, names, { env, alfredEnabled }) -> { source, files, found: { NAME: value }, from: { NAME: file },
// missing, error? }. The nearest source's value of a key wins. A source that fails or is refused ends the read: what came
// before it is kept, nothing after it is read. In-process only - the result is never printed.
function keysFor(project, scope, names, opts = {})
{
    const { source, list } = sourcesOf(project, scope, opts);
    const out = { source, files: list.flatMap((s) => s.files), found: {}, from: {}, missing: [] };
    for (const s of list)
    {
        const r = s.read();
        if (r.error) { out.error = r.error; break; }
        for (const n of names) if (!Object.hasOwn(out.found, n) && typeof r.values[n] === 'string' && r.values[n] !== '') { out.found[n] = r.values[n]; out.from[n] = r.from[n]; }
    }
    out.missing = scope === 'project' ? [] : names.filter((n) => !Object.hasOwn(out.found, n));
    return out;
}

// The token fields a catalog route defines and an entry holds: [{ at: ['env', K] | ['headers', H] | ['args', i], template }]
function tokenFields(entry, route)
{
    if (!route || !route.tokenVar || !entry) return [];
    const ref = `\${${route.tokenVar}}`;
    const out = [];
    for (const key of ['env', 'headers'])
        for (const [k, template] of Object.entries(route[key] || {}))
            if (typeof template === 'string' && template.includes(ref) && entry[key] && Object.hasOwn(entry[key], k)) out.push({ at: [key, k], template });
    const opt = route.optionalArgs && route.optionalArgs.token;
    const i = opt && Array.isArray(entry.args) ? entry.args.indexOf(opt[0]) : -1;
    if (i >= 0 && i + 1 < entry.args.length) out.push({ at: ['args', i + 1], template: opt[1] });
    return out;
}

const valueAt = (entry, at) => at.reduce((o, k) => (o == null ? undefined : o[k]), entry);
const PLACEHOLDER = /^\s*(?:[A-Za-z][\w-]*\s+)?(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})+\s*$/;

// fillKeys(entry, row, routeId, scope, found) -> a copy with each token field set by the target scope: at project scope
// the route's ${VAR} form, whatever the entry held; at local and user scope the found value in the route's form, or, when
// the key is missing, what the entry holds.
function fillKeys(entry, row, routeId, scope, found = {})
{
    const route = row && row.routes ? row.routes[routeId] : null;
    const fields = tokenFields(entry, route);
    if (!fields.length) return entry;
    const value = found[route.tokenVar];
    if (scope !== 'project' && typeof value !== 'string') return entry;
    const out = JSON.parse(JSON.stringify(entry));
    for (const f of fields)
    {
        const parent = valueAt(out, f.at.slice(0, -1));
        parent[f.at[f.at.length - 1]] = scope === 'project' ? f.template : f.template.split(`\${${route.tokenVar}}`).join(value);
    }
    return out;
}

// What apply and fix write for one registration: { entry, note } - `note` names the key and the file, never a value.
// `before` is the registration being rewritten when it is at user scope: one that already holds a live key is changed
// only from the home file, so a run from another project never swaps that project's key into every project's server.
function keysInto(entry, row, routeId, scope, { project, env = process.env, alfredEnabled = false, name, before = null } = {})
{
    const route = row && row.routes ? row.routes[routeId] : null;
    const fields = tokenFields(entry, route);
    if (!fields.length) return { entry, note: null };
    const v = route.tokenVar;
    if (scope === 'project') return { entry: fillKeys(entry, row, routeId, scope), note: null };
    const k = keysFor(project, scope, [v], { env, alfredEnabled });
    const where = `'${name}' (${scope})`;
    if (k.error) return { entry, note: `${v} for ${where}: ${k.error}; the registration keeps what it holds` };
    if (!Object.hasOwn(k.found, v))
    {
        const holds = fields.every((f) => PLACEHOLDER.test(String(valueAt(entry, f.at))));
        return { entry, note: `${v} for ${where} is in none of ${k.files.join(', ')} - ${holds ? `it stays \${${v}}` : 'the registration keeps its own value'}; put it in ${k.files[0]} and run /preferred-tools:fix` };
    }
    const filled = fillKeys(entry, row, routeId, scope, k.found);
    const beforeFields = tokenFields(before, route);
    const live = beforeFields.some((f) => !PLACEHOLDER.test(String(valueAt(before, f.at))));
    if (live && k.from[v] !== homeFile(env))
    {
        const differs = beforeFields.some((f) => valueAt(before, f.at) !== valueAt(fillKeys(before, row, routeId, scope, k.found), f.at));
        return { entry, note: differs ? `${v} in ${k.from[v]} differs from the key ${where} holds - kept, not written: a server for every project takes a new key only from ${homeFile(env)}` : null };
    }
    return { entry: filled, note: `${v} for ${where} from ${k.from[v]}` };
}

module.exports = { readDotenv, alfredPresent, filesFor, keysFor, tokenFields, fillKeys, keysInto, homeFile, projectFile, PLACEHOLDER };
