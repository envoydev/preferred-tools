'use strict';
// Shared pieces of the fix detectors. A detector is `detect(ctx) -> findings[]`; a registration fix is
// `fix(entry, finding, ctx, input) -> entry` (a pure edit of the entry AS READ, so the user's pin, cut-off and added
// args or env survive); a machine fix is `fix(finding, ctx) -> { ok, detail }` and changes the machine.
//
// ctx = { inv, catalog, platform, arch, env, home, rules, machine } - `machine` is the only way a detector looks at the
// machine, so a test replaces it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchTokens, bareName } = require('../inventory.js');

const fixOf = (ctx, id) => ctx.catalog.fixes.find((f) => f.id === id);
const rowOf = (ctx, id) => ctx.catalog.byId.get(id);

// The registrations a fix row covers: matched to one of its tools by what they launch, not the user's own, and not an
// alfred-code leftover.
const registrationsOf = (ctx, fixId) => ctx.inv.registrations.filter((r) => !r.own && !r.alfredRetired && fixOf(ctx, fixId).tool.includes(r.rowId));
const routeOf = (ctx, reg) => rowOf(ctx, reg.rowId).routes[reg.route];

// The executable a registration launches, looking through a `cmd /c` wrapper.
const launcher = (entry) => path.basename(launchTokens(entry).command).replace(/\.(exe|cmd)$/i, '');
const launchArgs = (entry) => launchTokens(entry).args;

const finding = (fixId, reg, what, extra = {}) => ({ id: fixId, row: reg.rowId, name: reg.name, scope: reg.scope, found: what, ...extra });
const clone = (value) => JSON.parse(JSON.stringify(value));

// '0.0.83' vs '0.0.9': numeric, part by part. Anything that is not dotted numbers (a dist-tag) compares as unknown (null).
function compareVersions(a, b)
{
    const parts = (v) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
    const [x, y] = [parts(a), parts(b)];
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.length, y.length); i++)
    {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

// The version a launch pins for a package: '@playwright/mcp@0.0.83' -> '0.0.83', '--from serena-agent@2.1.0' -> '2.1.0',
// 'mcp-memory-service[sqlite]==12.1.1' -> '12.1.1'. null when the launch names the package with no version.
function pinnedVersion(entry, pkg)
{
    for (const a of launchArgs(entry).filter((x) => !x.startsWith('-')))
    {
        if (bareName(a) !== pkg) continue;
        const m = /(?:==|@)([^@=\s]+)$/.exec(a.slice(pkg.length));
        return m ? m[1] : null;
    }
    return null;
}

// ---- the machine ---------------------------------------------------------------------------------------------------

function onPath(name, env, platform)
{
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    const win = platform === 'win32';
    const names = win ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
    for (const dir of String((key && env[key]) || '').split(win ? ';' : ':').filter(Boolean))
        for (const n of names)
        {
            const f = (win ? path.win32 : path.posix).join(dir, n);
            try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
        }
    return null;
}

function realMachine({ env = process.env, platform = process.platform } = {})
{
    return {
        exists: (p) => fs.existsSync(p),
        realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
        which: (name) => onPath(name, env, platform),
        // npm and npx are .cmd shims on Windows; a shell is what runs them
        // `opts.cwd` and `opts.env` (merged over the machine's) are for the audit, which runs in a temp folder
        run: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd, shell: platform === 'win32' && /^(npm|npx)$/.test(cmd) }),
        nodeVersion: process.versions.node,
    };
}

module.exports = { fixOf, rowOf, registrationsOf, routeOf, launcher, launchArgs, finding, clone, compareVersions, pinnedVersion, onPath, realMachine };
