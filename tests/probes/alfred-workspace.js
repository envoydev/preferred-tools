'use strict';
// alfred-code projects in a throwaway world, for the hook replay (tests/probes/alfred-hooks.js) and the workspace matrix.
//
// ONE ACCOUNT PER VERSION. Every alfred-code release names its marketplace `envoydev`, so two versions in one account
// collide and the first version's hooks would answer for both: each version gets its own tests/harness.js world under
// S/<version> (HOME, USERPROFILE and CLAUDE_CONFIG_DIR inside it).
//
// THE SOURCE. `--alfred <dir>`, else PREFERRED_TOOLS_ALFRED, else ../alfred-code beside this repo. A version resolves to
// that folder when it is a git checkout holding the tag v<version> (exported with `git archive`), else to its
// `alfred-code-<version>` subfolder whose marketplace lists alfred-code at that version (copied). Neither: NOT RUN.
//
// THE BUILD. The real CLI adds the exported marketplace and installs alfred-code at user scope, so `claude plugin list`
// and preferred-tools' inventory see it enabled and the hooks run from the cache folder the CLI made. alfred-code's own
// installer then sets up each project the way its workspace matrix does (docs/workspace-layering-matrix/ws-matrix-r3.js
// `sandbox()`): with a stub `claude` (the installer would otherwise install plugins over the network) and uvx, npx, npm
// and curl stubbed to fail.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Harness } = require('../harness.js');
const cli = require('../../scripts/claude-cli.js');

const REPO = path.resolve(__dirname, '..', '..');
const ROOT_SEL = 'skill javascript\nrule alfred-security\nrule alfred-navigation\n';
const CHILD_SEL = `${ROOT_SEL}skill npm\n`;
// The installer's view of the plugin list: alfred-code enabled for every project, as the real install below makes it.
const STUB_PLUGINS = JSON.stringify([{ id: 'alfred-code@envoydev', enabled: true, scope: 'user' }]);

const tail = (text, n = 600) => String(text || '').trim().slice(-n);

function sourceDir(alfredDir, env = process.env)
{
    return path.resolve(alfredDir || env.PREFERRED_TOOLS_ALFRED || path.join(REPO, '..', 'alfred-code'));
}

function marketplaceVersion(dir)
{
    try
    {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
        const entry = (doc.plugins || []).find((p) => p.name === 'alfred-code');
        return entry ? entry.version : null;
    }
    catch { return null; }
}

// -> { git, tag } | { tree } | { notRun }
function resolveVersion(version, { alfredDir, env } = {})
{
    const dir = sourceDir(alfredDir, env);
    const tag = `v${version}`;
    const isGit = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;
    if (isGit && spawnSync('git', ['-C', dir, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], { encoding: 'utf8' }).status === 0) return { git: dir, tag };
    const sub = path.join(dir, `alfred-code-${version}`);
    if (marketplaceVersion(sub) === version) return { tree: sub };
    return { notRun: `no alfred-code ${version} (neither tag ${tag} in a git checkout nor ${path.basename(sub)} under ${dir})` };
}

function exportTo(src, dest)
{
    fs.mkdirSync(dest, { recursive: true });
    if (src.tree) { fs.cpSync(src.tree, dest, { recursive: true }); return null; }
    const tar = `${dest}.tar`;
    const a = spawnSync('git', ['-C', src.git, 'archive', '--format=tar', '-o', tar, src.tag], { encoding: 'utf8' });
    if (a.status !== 0) return `git archive ${src.tag} failed: ${tail(a.stderr)}`;
    const x = spawnSync('tar', ['-xf', tar, '-C', dest], { encoding: 'utf8' });
    fs.rmSync(tar, { force: true });
    return x.status === 0 ? null : `tar failed: ${tail(x.stderr)}`;
}

// uvx, npx, npm and curl fail, and `claude` answers `plugin list` with STUB_PLUGINS and succeeds at anything else.
function stubBin(dir, platform)
{
    fs.mkdirSync(dir, { recursive: true });
    const win = platform === 'win32';
    for (const t of ['uvx', 'npx', 'npm', 'curl'])
    {
        if (win) fs.writeFileSync(path.join(dir, `${t}.cmd`), '@echo off\r\nexit /b 1\r\n');
        else fs.writeFileSync(path.join(dir, t), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    if (win) fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nif "%1 %2"=="plugin list" (type "%CLAUDE_STUB_PLUGINS%" & exit /b 0)\r\nexit /b 0\r\n');
    else fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nif [ "$1" = "plugin" ] && [ "$2" = "list" ]; then cat "$CLAUDE_STUB_PLUGINS"; exit 0; fi\nexit 0\n', { mode: 0o755 });
}

// The environment alfred-code's installer runs in: the version's isolated world, the stubs first on PATH, and none of
// the variables a developer's shell might carry that would point it elsewhere (as ws-matrix-r3.js scrubs them).
function installerEnv(base, alfred, bin, root)
{
    const env = { ...base, PATH: `${bin}${path.delimiter}${base.PATH || base.Path || ''}`, CLAUDE_STUB_PLUGINS: path.join(root, 'stub-plugins.json'), ALFRED_CODE_MEMORY_WARM: '0' };
    for (const k of Object.keys(env)) if (/^(SENTRY_|CONTEXT7_|UV_EXCLUDE|ANDROID_|JAVA_HOME|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_PROJECT_DIR_NAME)/.test(k)) delete env[k];
    try { require(path.join(alfred, 'scripts', 'seed-sandbox.js')).scrubStackEnv(env); } catch { /* an older release has no scrub */ }
    return env;
}

function gitDir(dir)
{
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) spawnSync('git', ['init', '-q', dir]);
    return fs.realpathSync(dir);
}

// buildAlfred(S, { alfredDir, version, claude, platform, workspace }) -> { solo, root?, child?, workspaceNotRun?, ... } | { notRun }
// `claude` names the CLI the harness world runs (default: the one on PATH); `workspace` also builds a root and a child.
function buildAlfred(S, { alfredDir, version, claude, platform = process.platform, workspace = false } = {})
{
    const src = resolveVersion(version, { alfredDir });
    if (src.notRun) return { notRun: src.notRun };
    const root = path.join(S, version);
    const h = new Harness({ root });
    if (claude) h.env.PATH = `${path.dirname(path.resolve(claude))}${path.delimiter}${h.env.PATH || ''}`;
    if (!cli.available({ env: h.env })) return { notRun: 'no claude CLI on PATH' };
    const alfred = path.join(root, 'alfred');
    const exported = exportTo(src, alfred);
    if (exported) return { notRun: `${version}: ${exported}` };

    const real = (args) => cli.run(args, { cwd: h.home, env: h.env });
    const add = real(['plugin', 'marketplace', 'add', alfred]);
    if (add.status !== 0) return { notRun: `${version}: claude plugin marketplace add failed: ${tail(add.stderr || add.stdout)}` };
    const listed = () => { try { return JSON.parse(real(['plugin', 'list', '--json']).stdout || '[]'); } catch { return []; } };
    let row = listed().find((p) => p.id === 'alfred-code@envoydev' && p.enabled);
    if (!row)
    {
        const inst = real(['plugin', 'install', 'alfred-code@envoydev', '-s', 'user']);
        row = listed().find((p) => p.id === 'alfred-code@envoydev' && p.enabled);
        if (!row) return { notRun: `${version}: alfred-code not listed enabled after install: ${tail(inst.stderr || inst.stdout)}` };
    }
    if (row.version !== version) return { notRun: `${version}: plugin list reports alfred-code ${row.version}, not ${version}` };

    const bin = path.join(root, 'stub-bin');
    stubBin(bin, platform);
    fs.writeFileSync(path.join(root, 'stub-plugins.json'), STUB_PLUGINS);
    const ienv = installerEnv(h.env, alfred, bin, root);
    const node = (cwd, argv) =>
    {
        const r = spawnSync(process.execPath, argv, { cwd, env: ienv, encoding: 'utf8', timeout: 600000 });
        return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    };
    const selection = (text) => { const f = path.join(root, `sel-${crypto.randomBytes(4).toString('hex')}.txt`); fs.writeFileSync(f, text); return f; };
    const installer = path.join(alfred, 'scripts', 'install', 'alfred-code.js');
    const install = (dir, sel, extra = []) => node(dir, [installer, 'install', '--source', alfred, '--selection', selection(sel), ...extra]);
    const refused = (what, r) => ({ notRun: `${version} installer differs (${what}, exit ${r.code}): ${tail(r.out)}` });

    const out = { version, world: root, home: h.home, account: h.account, env: h.env, harness: h, alfred, pluginRoot: row.installPath, folders: {} };
    const solo = gitDir(path.join(h.home, 'solo'));
    const s = install(solo, ROOT_SEL);
    if (s.code !== 0) return refused('solo install', s);
    out.solo = out.folders.solo = solo;
    if (!workspace) return out;
    // a workspace that cannot be built is said, and the plain project is replayed all the same
    const built = buildWorkspace({ version, root, home: h.home, alfred, ienv, node, install, installer });
    if (built.notRun) out.workspaceNotRun = built.notRun;
    else Object.assign(out, { root: built.root, child: built.child }, { folders: { ...out.folders, root: built.root, child: built.child } });
    return out;
}

// A root and its child. v3.0.0 on: the root and the child each answer the role ask (`workspace.js role`); v2.11.0, which
// has no `role` verb, stamps the root by its install alone and joins the child with `register` - its own matrix's
// initChild (v2.11.0 docs/workspace-layering-matrix/ws-matrix.js:48-57).
function buildWorkspace({ version, root, home, alfred, ienv, node, install, installer })
{
    const refused = (what, r) => ({ notRun: `${version} installer differs (${what}, exit ${r.code}): ${tail(r.out)}` });
    const workspaceJs = path.join(alfred, 'scripts', 'workspace.js');
    const hasRole = !/unknown verb 'role'/.test(node(root, [workspaceJs, 'role']).out);
    const ws = gitDir(path.join(home, 'ws'));
    const r = install(ws, ROOT_SEL);
    if (r.code !== 0) return refused('root install', r);
    if (hasRole)
    {
        const role = node(ws, [workspaceJs, 'role', '--root', '.', '--answer', 'root']);
        if (role.code !== 0) return refused('workspace role root', role);
    }
    // the child: the parent's plan, the join, then the install that follows the parent
    const child = gitDir(path.join(ws, 'api'));
    const plan = path.join(root, `parent-${crypto.randomBytes(4).toString('hex')}.json`);
    const scope = node(ws, [path.join(alfred, 'scripts', 'install', 'stamp.js'), 'scope', '.']).out.trim();
    const up = node(ws, [installer, 'update', '--source', alfred, '--scope', scope, '--installed-only', '--print-plan', '--plan-out', plan]);
    if (up.code !== 0) return refused('parent plan', up);
    const join = hasRole ? node(child, [workspaceJs, 'role', '--root', '.', '--answer', 'child']) : node(child, [workspaceJs, 'register', '--root', '.']);
    if (join.code !== 0) return refused(hasRole ? 'workspace role child' : 'workspace register', join);
    const c = install(child, CHILD_SEL, ['--parent-plan', plan, '--instructions-file', 'agents', '--instructions-at', 'claude']);
    if (c.code !== 0) return refused('child install', c);
    // the child names its parent: alfred-code's own chain reader says which members it links
    try
    {
        const layout = require(path.join(alfred, 'stack', 'hooks', 'layout.js'));
        const roots = layout.workspaceChain(child, { env: ienv }).members.map((m) => fs.realpathSync(m.root));
        if (!roots.includes(ws)) return { notRun: `${version}: the child's workspace chain does not name its parent (${roots.join(', ') || 'no member'})` };
    }
    catch (e) { return { notRun: `${version}: alfred-code's layout.js could not read the child's chain: ${e.message}` }; }
    return { root: ws, child };
}

module.exports = { buildAlfred, resolveVersion, sourceDir, ROOT_SEL, CHILD_SEL };
