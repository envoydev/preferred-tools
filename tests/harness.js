#!/usr/bin/env node
'use strict';
// THE TEMP-PROJECT HARNESS - runs the plugin's scripts against the REAL `claude` CLI in a throwaway world, with no model
// in the loop. The walk's asks are stood in for by an answers object fed to plan.js and apply.js, so every matrix case is
// a script run.
//
//   node tests/harness.js --root <scratch dir>
//
// ISOLATION. Every child gets HOME (and USERPROFILE) and CLAUDE_CONFIG_DIR inside the root, so the CLI reads and writes
// there. Before anything runs, `isolationCheck` proves it: a probe registration at user scope must land in the throwaway
// account file and leave the real account files byte-identical (hashed here, never printed). If the CLI wrote to the
// real account, user-scope cases are not run.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inventory = require('../scripts/inventory.js');
const { plan, render } = require('../scripts/plan.js');
const { apply } = require('../scripts/apply.js');
const account = require('../scripts/account.js');
const cli = require('../scripts/claude-cli.js');

// the REAL home, taken from the OS (not from HOME, which the harness overrides for its children)
const REAL_HOME = os.userInfo().homedir;
const REAL_FILES = [
    path.join(REAL_HOME, '.claude.json'),
    path.join(REAL_HOME, '.claude', 'settings.json'),
    path.join(REAL_HOME, '.claude', 'plugins', 'installed_plugins.json'),
];
// claude-hud keeps runtime caches in its folder (daily-cost.json, speed-cache/, transcript-cursors/) that a live session's
// statusline rewrites every few seconds, so the folder as a whole can never be byte-identical. Only the two files the
// plugin's settings step could touch are watched.
const HUD_DIR = path.join(REAL_HOME, '.claude', 'plugins', 'claude-hud');
REAL_FILES.push(path.join(HUD_DIR, 'config.json'), path.join(HUD_DIR, 'previous-statusline.txt'));
const REAL_TREES = [];

function hashTree(p)
{
    const h = crypto.createHash('sha256');
    const walk = (d) =>
    {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { h.update(`missing:${d}`); return; }
        for (const e of entries)
        {
            const f = path.join(d, e.name);
            if (e.isDirectory()) { h.update(`d:${e.name}`); walk(f); }
            else { try { h.update(`f:${e.name}:`); h.update(fs.readFileSync(f)); } catch { h.update(`unreadable:${e.name}`); } }
        }
    };
    walk(p);
    return h.digest('hex');
}

function hashFile(f)
{
    try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'missing'; }
}

const snapshot = () => Object.fromEntries([...REAL_FILES.map((f) => [f, hashFile(f)]), ...REAL_TREES.map((t) => [t, hashTree(t)])]);

class Harness
{
    constructor({ root })
    {
        fs.mkdirSync(root, { recursive: true });
        this.root = fs.realpathSync(root);
        this.home = path.join(this.root, 'home');
        this.account = path.join(this.root, 'account');
        this.projects = path.join(this.root, 'projects');
        for (const d of [this.home, this.account, this.projects]) fs.mkdirSync(d, { recursive: true });
        this.env = { ...process.env, HOME: this.home, USERPROFILE: this.home, CLAUDE_CONFIG_DIR: this.account };
        for (const k of Object.keys(this.env)) if (k.startsWith('FAKE_CLAUDE')) delete this.env[k];
        this.before = snapshot();
    }

    // a throwaway project (git init, as a real project would be)
    project(name)
    {
        const dir = path.join(this.projects, name);
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(path.join(dir, '.git'))) spawnSync('git', ['init', '-q', dir]);
        return fs.realpathSync(dir);
    }

    claude(project, args) { return cli.run(args, { cwd: project, env: this.env }); }

    inventory(project) { return inventory.buildInventory({ project, env: this.env }); }

    // inventory -> plan -> apply, in-process, against the real CLI in the throwaway world
    run(project, answers, { planOpts = {}, tmp } = {})
    {
        const inv = this.inventory(project);
        const p = plan(inv, answers, { home: this.home, env: this.env, ...planOpts });
        const lines = [];
        const report = p.errors.length
            ? { applied: [], failed: null, notRun: [], readback: [], noop: false, skipped: true }
            : apply(p, { env: this.env, tmp: tmp || path.join(this.root, 'tmp'), log: (...a) => lines.push(a.join(' ')) });
        return { inv, plan: p, report, text: lines.join('\n'), rendered: render(p) };
    }

    realUntouched()
    {
        const now = snapshot();
        const changed = Object.keys(now).filter((k) => now[k] !== this.before[k]);
        return { ok: changed.length === 0, changed };
    }

    // every file under the root (for token scans)
    files()
    {
        const out = [];
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name))));
        walk(this.root);
        return out;
    }
}

// Proves the isolation before any case runs. Returns { ok, lines }.
function isolationCheck(h)
{
    const lines = [];
    const project = h.project('isolation');
    const a = h.claude(project, ['mcp', 'add-json', 'isolation-probe', JSON.stringify({ command: 'echo', args: ['probe'] }), '-s', 'user']);
    const file = account.accountFile(h.env);
    const wrote = fs.existsSync(file) && /isolation-probe/.test(fs.readFileSync(file, 'utf8'));
    lines.push(`claude mcp add-json exit ${a.status}; the throwaway account file ${wrote ? 'holds the probe' : 'does NOT hold the probe'}`);
    const real = h.realUntouched();
    lines.push(real.ok ? 'real account files and claude-hud config: byte-identical' : `REAL ACCOUNT CHANGED: ${real.changed.join(', ')}`);
    h.claude(project, ['mcp', 'remove', 'isolation-probe', '-s', 'user']);
    // the no-op case: nothing picked, so nothing applies
    const r = h.run(project, { picks: {} });
    lines.push(`no-op case: ${r.report.noop ? 'no claude call made' : 'UNEXPECTED CALLS'}`);
    const real2 = h.realUntouched();
    lines.push(real2.ok ? 'after the no-op case: real account still byte-identical' : `REAL ACCOUNT CHANGED: ${real2.changed.join(', ')}`);
    return { ok: a.status === 0 && wrote && real.ok && r.report.noop && real2.ok, lines };
}

function main(argv)
{
    const at = argv.indexOf('--root');
    const root = at >= 0 ? argv[at + 1] : path.join(os.tmpdir(), `preferred-tools-harness-${Date.now()}`);
    const h = new Harness({ root });
    const r = isolationCheck(h);
    console.log(r.lines.join('\n'));
    console.log(r.ok ? 'harness: PASS - the CLI writes in the throwaway account only' : 'harness: FAIL - user-scope cases must not run');
    return r.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { Harness, isolationCheck, snapshot, hashTree, REAL_HOME };
