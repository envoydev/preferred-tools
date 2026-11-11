'use strict';
// The 0.2.0 key rows (spec D7): a hosted key moved out of a registration into the header helper, the helper on disk kept
// present and current, and a root's .gitignore that keeps its key file out of git. token-sync (stdio keys) is in
// registration.js.
//
// A key is compared in this process only: a finding names a key and a file, never a value.
const fs = require('node:fs');
const path = require('node:path');
const E = require('../entries.js');
const keys = require('../keys.js');
const roots = require('../roots.js');
const { HELPER_VERSION } = require('../mcp-headers.js');
const { BRIDGE_VERSION } = require('../mcp-bridge.js');
const C = require('./common.js');

// What roots.js needs to place a root, from a fix ctx.
const rootCtx = (ctx) => ({ project: ctx.inv.project, home: ctx.home, platform: ctx.platform, catalog: ctx.catalog });
// The roots a fix writes into (R9): each family's root in use, else D2's recommended one.
const rootsOf = (ctx) => roots.resolve(ctx.inv, null, rootCtx(ctx)).roots;

// ---- key-to-helper --------------------------------------------------------------------------------------------------
// A managed hosted registration whose Authorization header holds a ${VAR} or a key (0.1.x wrote both). The helper reads
// the key by name from the hosted chain, so the name must be filled there first: a registration is never moved to a
// helper that would send no key.
const ONE_VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function authOf(entry)
{
    const headers = (entry && entry.headers) || {};
    const header = Object.keys(headers).find((h) => h.toLowerCase() === 'authorization');
    return header && typeof headers[header] === 'string' ? { header, value: headers[header] } : null;
}

function keyToHelperDetect(ctx)
{
    const out = [];
    for (const reg of C.registrationsOf(ctx, 'key-to-helper'))
    {
        const route = C.routeOf(ctx, reg);
        const auth = authOf(reg.entry);
        if (reg.route !== 'remote' || !route || !route.helper || !auth || reg.entry.headersHelper) continue;
        const r = rootsOf(ctx);
        const chain = keys.hostedChain({ scope: reg.scope, projectRoot: r.project, globalRoot: r.global, globalNamed: r.globalNamed, home: ctx.home });
        const extra = { route: reg.route, roots: r };
        // the scheme word goes: the helper sends the route's own
        const token = auth.value.trim().replace(/^[A-Za-z][\w-]*\s+/, '');
        const one = ONE_VAR.exec(token);
        if (one)
        {
            const name = one[1];
            const at = keys.valueIn(chain, name);
            if (at) { out.push(C.finding('key-to-helper', reg, `the Authorization header holds \${${name}} - the key moves to mcp-headers.js, which reads ${name} from ${at.file}`, { ...extra, keyName: name })); continue; }
            const old = keys.oldHolding(ctx.inv.project, ctx.home, name);
            out.push(C.finding('key-to-helper', reg, `the Authorization header holds \${${name}}`, { ...extra, blocked: `put ${name}'s value in ${chain[0]}, then run /preferred-tools:fix${old ? `; ${name} is in ${old}, which preferred-tools no longer reads` : ''}` }));
            continue;
        }
        if (token.includes('${')) { out.push(C.finding('key-to-helper', reg, 'the Authorization header mixes ${VAR} and text', { ...extra, blocked: 'make it one ${VAR} or the key by hand, then run /preferred-tools:fix' })); continue; }
        const name = keys.nameOfValue(chain, token);
        out.push(name
            ? C.finding('key-to-helper', reg, `the Authorization header holds a key - it moves to mcp-headers.js, which reads it as ${name}`, { ...extra, keyName: name })
            : C.finding('key-to-helper', reg, 'the Authorization header holds a key', { ...extra, blocked: `the key in this registration matches no name in ${chain.join(', ')}: put the working key there under a name, then run /preferred-tools:fix` }));
    }
    return out;
}

// The entry as read, with `headersHelper` and without the header. fix.js writes the root's file steps before it (R9).
function keyToHelperFix(entry, f, ctx)
{
    const out = C.clone(entry);
    const auth = authOf(out);
    if (auth) delete out.headers[auth.header];
    if (out.headers && !Object.keys(out.headers).length) delete out.headers;
    const route = C.rowOf(ctx, f.row).routes[f.route];
    out.headersHelper = E.helperFor(route, f.scope, { project: ctx.inv.project, platform: ctx.platform, home: ctx.home, roots: f.roots }, f.keyName);
    return out;
}

// ---- helper-missing, helper-stale -----------------------------------------------------------------------------------
// The files this plugin copied that the managed registrations name, each once: [{ file, root, kind, reg }]. A
// `headersHelper` names its helper; a bridge registration (0.4.0) its mcp-bridge.js and the mcp-headers.js beside it,
// which the bridge requires. A project-scope path is relative to the project, the folder whose .mcp.json declares it.
const SHIPPED = { helper: { word: 'helper', version: HELPER_VERSION }, bridge: { word: 'bridge', version: BRIDGE_VERSION } };
function shippedFiles(ctx, fixId)
{
    const P = E.pathFor(ctx.platform);
    const seen = new Map();
    const add = (file, kind, reg) => { if (!seen.has(file)) seen.set(file, { file, root: P.dirname(file), kind, reg }); };
    for (const reg of C.registrationsOf(ctx, fixId))
    {
        const named = roots.helperPathOf(reg.entry && reg.entry.headersHelper);
        if (named) add(roots.absOf(named, rootCtx(ctx)), 'helper', reg);
        const bridge = E.bridgeParts(reg.entry);
        if (!bridge) continue;
        const file = roots.absOf(bridge.path, rootCtx(ctx));
        add(file, 'bridge', reg);
        add(P.join(P.dirname(file), roots.FILES.helper), 'helper', reg);
    }
    return [...seen.values()];
}

// `bridged`: found through a bridge registration, which did not start without the file - so its fix needs a new start,
// where a hosted server's helper runs at each connect (review)
const helperFinding = (fixId, h, what, extra = {}) => ({ ...C.finding(fixId, h.reg, what, extra), name: h.file, path: h.file, shipped: h.kind, bridged: Boolean(E.bridgeParts(h.reg.entry)) });
const nameOf = (h) => roots.FILES[h.kind];
// the file this finding writes: 'helper' or 'bridge' (a finding from before 0.4.0 carries none: a helper)
const kindOf = (f) => (f.shipped === 'bridge' ? 'bridge' : 'helper');
// a fix that writes a file says CommonJS beside it (apply.js ensureCommonjs, 0.4.0 Ruling 12)
const withCommonjs = (root, r) =>
{
    const pkg = require('../apply.js').ensureCommonjs(root);
    return { ...r, detail: [r.detail, pkg.wrote ? `wrote ${path.join(root, 'package.json')} (type commonjs)` : null, pkg.note].filter(Boolean).join('; ') };
};

function helperMissingDetect(ctx)
{
    return shippedFiles(ctx, 'helper-missing').filter((h) => !fs.existsSync(h.file))
        .map((h) => helperFinding('helper-missing', h, `${nameOf(h)} is missing - ${h.reg.name} (${h.reg.scope}) ${E.bridgeParts(h.reg.entry) ? 'does not start' : 'connects without its key'}`));
}

function helperMissingFix(f)
{
    const kind = kindOf(f);
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, roots.shippedSource(kind));
    return withCommonjs(path.dirname(f.path), { ok: roots.shippedState(kind, f.path).state === 'same', detail: `wrote ${f.path} (${SHIPPED[kind].word} ${SHIPPED[kind].version})`, restart: Boolean(f.bridged) });
}

function helperStaleDetect(ctx)
{
    const out = [];
    for (const h of shippedFiles(ctx, 'helper-stale').filter((x) => fs.existsSync(x.file)))
    {
        const { state, number } = roots.shippedState(h.kind, h.file);
        const name = nameOf(h);
        const { word, version } = SHIPPED[h.kind];
        if (state === 'lower') out.push(helperFinding('helper-stale', h, `${name} is ${word} ${number} - this plugin's is ${version}`, { from: number }));
        else if (state === 'edited' && number === null) out.push(helperFinding('helper-stale', h, `${name} has no preferred-tools number line`, { blocked: `${h.file} has no preferred-tools number line - it is not this plugin's ${word}, and fix never overwrites it: rename yours, or delete it and run /preferred-tools:fix` }));
        else if (state === 'edited') out.push(helperFinding('helper-stale', h, `${name} changed since preferred-tools wrote it - the fix puts this plugin's copy back`));
        else if (state === 'higher') out.push(helperFinding('helper-stale', h, `${name} is ${word} ${number} - newer than this plugin's ${version}`, { blocked: `${name} in ${h.root} is newer than this plugin - update preferred-tools` }));
    }
    return out;
}

function helperStaleFix(f)
{
    const kind = kindOf(f);
    const { word, version } = SHIPPED[kind];
    if (roots.shippedState(kind, f.path).state === 'higher') return { ok: false, detail: `${f.path} is newer than this plugin - left; update preferred-tools`, restart: false };
    fs.writeFileSync(f.path, roots.shippedSource(kind));
    return withCommonjs(path.dirname(f.path), { ok: roots.shippedState(kind, f.path).state === 'same', detail: `rewrote ${f.path} (${word} ${f.from === undefined ? 'edited' : f.from} -> ${version})`, restart: Boolean(f.bridged) });
}

// ---- root-ignore ----------------------------------------------------------------------------------------------------
// A root in use inside a git work tree where git would commit its key file, or - a project root other than .alfred -
// would ignore the helper a project-scope server needs committed (R13). The fix appends what rootIgnore writes; a gap no
// appended line can close is blocked and named.
function rootIgnoreDetect(ctx)
{
    const { rootIgnoreLines } = require('../apply.js');
    const out = [];
    for (const family of ['project', 'global'])
    {
        const used = ctx.inv.roots && ctx.inv.roots[family];
        const root = used && used.path;
        if (!root || out.some((f) => f.name === root) || !fs.existsSync(root)) continue;
        const gap = roots.ignoreGap(root, family);
        if (!gap) continue;
        const secrets = path.join(root, roots.FILES.secrets);
        const helper = path.join(root, roots.FILES.helper);
        const secretsGap = roots.gitIgnores(secrets) === false;
        const helperGap = family === 'project' && path.basename(root) !== '.alfred' && roots.gitIgnores(helper) === true;
        const found = [secretsGap && `git would commit ${secrets}`, helperGap && `git ignores ${helper}, which a project-scope server needs committed`].filter(Boolean).join('; ');
        const base = { id: 'root-ignore', row: null, name: root, scope: family, found, path: root, family };
        if (path.basename(root) === '.alfred') { out.push({ ...base, blocked: `${root} is alfred-code's - add ${roots.FILES.secrets} to its .gitignore yourself` }); continue; }
        if (gap.excluded) { out.push({ ...base, blocked: `a .gitignore above excludes ${root} - remove that line (git check-ignore -v ${root} names it): git never re-includes a file inside an excluded folder` }); continue; }
        const lines = rootIgnoreLines(root);
        const fixes = { secrets: secretsGap && lines.lack.includes(lines.mine ? '*' : roots.FILES.secrets), helper: helperGap && lines.mine && lines.lack.includes(`!${roots.FILES.helper}`) };
        const left = [
            secretsGap && !fixes.secrets && `every line preferred-tools writes is in ${lines.file}, yet git would still commit ${secrets}: a later line re-includes ${roots.FILES.secrets}, or git tracks it already (git rm --cached -- ${secrets})`,
            helperGap && !fixes.helper && `git ignores ${helper} through lines of your own - add !${roots.FILES.helper} at the end of ${lines.file}`,
        ].filter(Boolean).join('; ');
        if (!fixes.secrets && !fixes.helper) out.push({ ...base, blocked: left });
        else out.push({ ...base, fixes, ...(left ? { note: left } : {}) });
    }
    return out;
}

function rootIgnoreFix(f)
{
    const r = require('../apply.js').rootIgnore(f.path);
    const still = [
        f.fixes.secrets && roots.gitIgnores(path.join(f.path, roots.FILES.secrets)) === false && `git would still commit ${path.join(f.path, roots.FILES.secrets)}`,
        f.fixes.helper && roots.gitIgnores(path.join(f.path, roots.FILES.helper)) === true && `git still ignores ${path.join(f.path, roots.FILES.helper)}`,
    ].filter(Boolean);
    return { ok: !still.length, detail: still.length ? `${r.detail}; ${still.join('; ')}` : r.detail, restart: false };
}

module.exports = { keyToHelperDetect, keyToHelperFix, helperMissingDetect, helperMissingFix, helperStaleDetect, helperStaleFix, rootIgnoreDetect, rootIgnoreFix };
