'use strict';
// The registration fixes: each finds a known problem in an installed registration and edits that entry AS READ (its pin,
// its cut-off and the args or env the user added stay). The edit is applied by `claude mcp remove` + `add-json` through
// apply.js's mcp-replace, with a rollback; this file never writes.
//
// A finding the machine cannot act on carries `blocked` (the reason), is shown, and is never applied.
const path = require('node:path');
const E = require('../entries.js');
const keys = require('../keys.js');
const roots = require('../roots.js');
const C = require('./common.js');
const { windowsMcpServers, fromHere } = require('../inventory.js');

const eachReg = (ctx, id, fn) => C.registrationsOf(ctx, id).map((reg) => fn(reg, C.routeOf(ctx, reg))).filter(Boolean);

// ---- serena-windows-home --------------------------------------------------------------------------------------------
// SERENA_HOME absolute, in backslashes and space-free. A value that is only wrong in its slashes keeps its folder (so the
// ~327MB of language servers serena already fetched are found again); a value with a space needs another folder.
function windowsHomeOf(value, ctx)
{
    const expanded = value.replace(/\$\{(?:HOME|USERPROFILE)\}/g, ctx.home);
    return path.win32.resolve(ctx.inv.project, expanded).replace(/\\+$/, '');
}

function serenaWindowsHomeDetect(ctx)
{
    if (ctx.platform !== 'win32') return [];
    return eachReg(ctx, 'serena-windows-home', (reg) =>
    {
        const value = (reg.entry.env || {}).SERENA_HOME;
        // none set (a registration made by hand): serena's default home is <profile>\.serena, cut at a space in the
        // profile path like any other; the space-free folder install offers takes its place
        if (value === undefined) return unsetSerenaHome(reg, ctx);
        if (typeof value !== 'string' || E.validWindowsSerenaHome(value)) return null;
        // a ${VAR} form in this folder's .mcp.json is 0.2.0's: project-relative-path writes it out absolute
        if (reg.scope === 'project' && value.includes('${')) return null;
        const faults = [!path.win32.isAbsolute(value) && 'not absolute', value.includes('/') && 'forward slashes', /\s/.test(value) && 'a space'].filter(Boolean);
        const what = `SERENA_HOME is '${value}' (${faults.join(', ')})`;
        const same = windowsHomeOf(value, ctx);
        if (E.validWindowsSerenaHome(same)) return C.finding('serena-windows-home', reg, what, { proposal: { SERENA_HOME: same }, note: `same folder, written absolute with backslashes: ${same}` });
        const fresh = E.serenaWindowsHome({ home: ctx.home });
        if (fresh.root) return C.finding('serena-windows-home', reg, what, { proposal: { SERENA_HOME: fresh.root.path }, note: `a new home, ${fresh.root.path} - serena's data in '${value}' is not moved and its language servers download again (~327MB)` });
        if (reg.scope === 'project') return C.finding('serena-windows-home', reg, what, { blocked: SPACED_PROJECT });
        return C.finding('serena-windows-home', reg, what, { input: { id: 'serenaHome', prompt: fresh.needsInput } });
    });
}

// serena's home in this folder's .mcp.json when no space-free folder is in reach (F7)
const SPACED_PROJECT = "serena's home on Windows must be space-free - pick a space-free folder with /preferred-tools:configure, Location";

function unsetSerenaHome(reg, ctx)
{
    const profile = ctx.home || '';
    if (!/\s/.test(profile)) return null;
    const what = `no SERENA_HOME: serena's default home, ${path.win32.join(profile, '.serena')}, has a space`;
    if (reg.scope === 'project') return C.finding('serena-windows-home', reg, what, { blocked: SPACED_PROJECT });
    const free = E.serenaSpaceFree(ctx).path;
    return C.finding('serena-windows-home', reg, what, { proposal: { SERENA_HOME: free }, note: `a new home, ${free} - serena's data in ${path.win32.join(profile, '.serena')} is not moved and its language servers download again (~327MB)` });
}

function serenaWindowsHomeFix(entry, f, ctx, input = {})
{
    const home = (f.proposal && f.proposal.SERENA_HOME) || input.serenaHome;
    if (!home || !E.validWindowsSerenaHome(home)) throw new Error(`serena's home must be an absolute Windows folder in backslashes with no space; '${home || ''}' is not (pass --input serenaHome=<folder>)`);
    return { ...entry, env: { ...(entry.env || {}), SERENA_HOME: home } };
}

// ---- uvx-python / windows-arm-python --------------------------------------------------------------------------------
const pythonAt = (args) => args.findIndex((a) => a === '--python' || a === '-p' || a.startsWith('--python='));

function uvxPythonDetect(ctx)
{
    return eachReg(ctx, 'uvx-python', (reg) =>
    {
        if (C.launcher(reg.entry) !== 'uvx' || pythonAt(C.launchArgs(reg.entry)) >= 0) return null;
        const want = E.pythonRequest(C.routeOf(ctx, reg), ctx, ctx.rules);
        return C.finding('uvx-python', reg, `no --python: uvx picks the newest CPython, which has no wheel for some dependencies`, { proposal: { python: want } });
    });
}

function uvxPythonFix(entry, f, ctx)
{
    return { ...entry, args: ['--python', f.proposal.python, ...entry.args] };
}

function windowsArmPythonDetect(ctx)
{
    if (!E.isWindowsArm(ctx)) return [];
    return eachReg(ctx, 'windows-arm-python', (reg) =>
    {
        if (C.launcher(reg.entry) !== 'uvx') return null;
        const args = C.launchArgs(reg.entry);
        const at = args.indexOf('--python');
        const minor = at >= 0 ? args[at + 1] : null;
        if (!minor || !/^\d+\.\d+$/.test(minor)) return null; // none (uvx-python's), or a build the user chose
        return C.finding('windows-arm-python', reg, `--python ${minor} on Windows ARM64: several dependencies ship no ARM64 wheel`, { proposal: { python: ctx.rules.windowsArmPython.replace('{minor}', minor), from: minor } });
    });
}

function windowsArmPythonFix(entry, f)
{
    const args = [...entry.args];
    args[args.indexOf('--python') + 1] = f.proposal.python;
    return { ...entry, args };
}

// ---- windows-npx-cmd ------------------------------------------------------------------------------------------------
function windowsNpxCmdDetect(ctx)
{
    if (ctx.platform !== 'win32') return [];
    return eachReg(ctx, 'windows-npx-cmd', (reg) =>
    {
        if (path.basename(String(reg.entry.command || '')).replace(/\.(exe|cmd)$/i, '') !== 'npx') return null;
        return C.finding('windows-npx-cmd', reg, 'npx is launched directly on native Windows', { note: 'a precaution: Claude Code no longer documents the cmd /c wrapper and this build has not proved it on a Windows machine' });
    });
}

function windowsNpxCmdFix(entry)
{
    return { ...entry, command: 'cmd', args: ['/c', 'npx', ...(entry.args || [])] };
}

// ---- playwright-webmcp ----------------------------------------------------------------------------------------------
// The release whose README documents --no-webmcp (catalog/fixes.json verifiedOn): a fixed floor, never the catalog's pin,
// which moves on every refresh and would block a registration that already has the flag.
const NO_WEBMCP_SINCE = '0.0.83';
function playwrightWebmcpDetect(ctx)
{
    return eachReg(ctx, 'playwright-webmcp', (reg) =>
    {
        if (C.launchArgs(reg.entry).includes('--no-webmcp')) return null;
        const pin = C.pinnedVersion(reg.entry, '@playwright/mcp');
        const documented = NO_WEBMCP_SINCE;
        const older = pin && C.compareVersions(pin, documented) === -1;
        return C.finding('playwright-webmcp', reg, 'page-registered WebMCP tools are not switched off (no --no-webmcp)',
            older ? { blocked: `pinned @${pin} is older than ${documented}, the version whose README documents --no-webmcp - update it first (/preferred-tools:update), then fix` } : {});
    });
}

function playwrightWebmcpFix(entry)
{
    const args = [...entry.args];
    const at = args.indexOf('--browser');
    args.splice(at >= 0 ? at + 2 : args.length, 0, '--no-webmcp');
    return { ...entry, args };
}

// ---- appium-sdk-env -------------------------------------------------------------------------------------------------
const SDK_ENV = ['ANDROID_HOME', 'JAVA_HOME'];
function androidSdk(ctx)
{
    const { env, machine: m } = ctx;
    for (const v of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) if (v && m.exists(v)) return v;
    const P = E.pathFor(ctx.platform);
    const defaults = ctx.platform === 'darwin' ? [P.join(ctx.home, 'Library', 'Android', 'sdk')]
        : ctx.platform === 'win32' ? [P.join(env.LOCALAPPDATA || P.join(ctx.home, 'AppData', 'Local'), 'Android', 'Sdk')]
            : [P.join(ctx.home, 'Android', 'Sdk'), P.join(ctx.home, 'Android', 'sdk')];
    return defaults.find((d) => m.exists(d)) || null;
}

function javaHome(ctx)
{
    const { env, machine: m } = ctx;
    if (env.JAVA_HOME && m.exists(env.JAVA_HOME)) return env.JAVA_HOME;
    if (ctx.platform === 'darwin')
    {
        const r = m.run('/usr/libexec/java_home', []);
        if (r && r.status === 0 && String(r.stdout).trim()) return String(r.stdout).trim();
    }
    const java = m.which('java');
    const real = java && m.realpath(java);
    if (!real) return null;
    const P = E.pathFor(ctx.platform);
    const home = P.dirname(P.dirname(real));
    return m.exists(P.join(home, 'bin', ctx.platform === 'win32' ? 'java.exe' : 'java')) ? home : null;
}

function appiumSdkEnvDetect(ctx)
{
    return eachReg(ctx, 'appium-sdk-env', (reg) =>
    {
        const env = reg.entry.env || {};
        // every scope holds this machine's SDK homes since 0.3.0, this folder's .mcp.json included
        const missing = SDK_ENV.filter((k) => !env[k]);
        if (!missing.length) return null;
        const what = `${missing.join(' and ')} not set in the registration`;
        const lookup = { ANDROID_HOME: missing.includes('ANDROID_HOME') ? androidSdk(ctx) : null, JAVA_HOME: missing.includes('JAVA_HOME') ? javaHome(ctx) : null };
        const proposal = Object.fromEntries(Object.entries(lookup).filter(([, v]) => v));
        const notFound = missing.filter((k) => !proposal[k]);
        if (!Object.keys(proposal).length) return C.finding('appium-sdk-env', reg, what, { blocked: `${notFound.join(' and ')} not found on this machine - install the Android SDK / a JDK first` });
        return C.finding('appium-sdk-env', reg, what, { proposal, note: notFound.length ? `${notFound.join(' and ')} not found on this machine and left unset` : undefined });
    });
}

function appiumSdkEnvFix(entry, f)
{
    return { ...entry, env: { ...(entry.env || {}), ...f.proposal } };
}

// ---- serena-telemetry -----------------------------------------------------------------------------------------------
// Only an ABSENT variable is a finding: a user who set it to something else chose that.
function serenaTelemetryDetect(ctx)
{
    return eachReg(ctx, 'serena-telemetry', (reg) =>
        (reg.entry.env || {}).SERENA_USAGE_REPORTING === undefined ? C.finding('serena-telemetry', reg, 'SERENA_USAGE_REPORTING is not set - serena sends a usage ping at every start') : null);
}

function serenaTelemetryFix(entry)
{
    return { ...entry, env: { ...(entry.env || {}), SERENA_USAGE_REPORTING: 'false' } };
}

// ---- token-sync -----------------------------------------------------------------------------------------------------
// A local or user registration of a stdio token route whose key no filled name in its stdio chain holds (spec D3, D7):
// the key changed in the key file since, or the registration still holds the ${VAR} 0.1.x left. Compared in this process;
// a finding names the files, never a value. The fix writes the value of the name a ${VAR} holds, else of the catalog's
// default name. A stdio registration stores its key and not the key's name, so an empty one is never guessed at (R7): the
// default name may hold another account's key.
const PICK_NAME = "pick the key's name with /preferred-tools:configure";
const ONE_VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// The key inside a token field: the field's text less the route template's text around ${VAR}.
function keyIn(value, template, v)
{
    const [pre, post = ''] = template.split(`\${${v}}`);
    const s = String(value);
    return s.length >= pre.length + post.length && s.startsWith(pre) && s.endsWith(post) ? s.slice(pre.length, s.length - post.length) : s;
}

function stdioChainOf(ctx, scope)
{
    const r = roots.resolve(ctx.inv, null, { project: ctx.inv.project, home: ctx.home, platform: ctx.platform, catalog: ctx.catalog }).roots;
    return keys.stdioChain({ scope, projectRoot: r.project, globalRoot: r.global });
}

function tokenSyncDetect(ctx)
{
    return eachReg(ctx, 'token-sync', (reg, route) =>
    {
        if (reg.route === 'remote' || !['local', 'user'].includes(reg.scope)) return null;
        const fields = keys.tokenFields(reg.entry, route);
        if (!fields.length) return null;
        const v = route.tokenVar;
        const key = keyIn(fields[0].at.reduce((o, k) => o[k], reg.entry), fields[0].template, v);
        const chain = stdioChainOf(ctx, reg.scope);
        const extra = { route: reg.route, chain };
        if (key === '') return C.finding('token-sync', reg, `the registration's ${v} is empty`, { ...extra, blocked: PICK_NAME });
        const one = ONE_VAR.exec(key);
        if (one)
        {
            const at = keys.valueIn(chain, one[1]);
            return at ? C.finding('token-sync', reg, `the registration holds \${${one[1]}} while ${at.file} has the key`, { ...extra, keyName: one[1] }) : null;
        }
        if (keys.nameOfValue(chain, key)) return null;
        const what = `the key in the registration matches no name in ${chain.join(', ')}`;
        return C.finding('token-sync', reg, what, keys.valueIn(chain, v) ? { ...extra, keyName: v } : { ...extra, blocked: PICK_NAME });
    });
}

function tokenSyncFix(entry, f, ctx)
{
    const at = keys.valueIn(f.chain, f.keyName);
    if (!at) throw new Error(`${f.keyName} is filled in none of ${f.chain.join(', ')} any more - nothing written`);
    const row = C.rowOf(ctx, f.row);
    return keys.fillKeys(entry, row, f.route, f.scope, { [row.routes[f.route].tokenVar]: at.value });
}

// ---- windows-mcp-one-per-desktop ------------------------------------------------------------------------------------
// Advice only (`fix: null`): windows-mcp 0.8.8 makes one missed overlay confirmation permanent for its process, and a
// second server on the same desktop is the likely cause. The finding is always blocked: each server is dropped by its
// owner's own command, and preferred-tools changes none of them.
function windowsMcpDrop(s, ctx)
{
    if (s.kind === 'plugin') return `claude plugin disable ${s.name} --scope ${s.scope}`;
    const how = s.owner === 'catalog' ? '/preferred-tools:configure (Remove)' : `claude mcp remove ${s.name} -s ${s.scope === 'inherited' ? 'project' : s.scope}`;
    return s.scope === 'inherited' ? `${how}, run in ${fromHere(ctx.inv, s.from)}` : how;
}

function windowsMcpOneDetect(ctx)
{
    const servers = windowsMcpServers(ctx.inv);
    if (servers.length < 2) return [];
    const at = servers.find((s) => s.owner === 'catalog') || servers[0];
    const list = servers.map((s) => `${s.name} (${s.scope})`).join(', ');
    const drop = servers.map((s) => `${s.name} (${s.scope}): ${windowsMcpDrop(s, ctx)}`).join('; ');
    // `row` set by hand: a server is not a registration row, and --only narrows by it
    return [C.finding('windows-mcp-one-per-desktop', { ...at, rowId: 'windows-control' }, `${servers.length} windows-mcp servers start in this project: ${list}`,
        { blocked: `keep one per Windows desktop - ${drop}; a stuck one recovers only in a new Claude Code session` })];
}

module.exports = {
    windowsMcpOneDetect,
    serenaWindowsHomeDetect, serenaWindowsHomeFix, uvxPythonDetect, uvxPythonFix, windowsArmPythonDetect, windowsArmPythonFix,
    windowsNpxCmdDetect, windowsNpxCmdFix, playwrightWebmcpDetect, playwrightWebmcpFix, appiumSdkEnvDetect, appiumSdkEnvFix,
    serenaTelemetryDetect, serenaTelemetryFix, tokenSyncDetect, tokenSyncFix, androidSdk, javaHome,
};
