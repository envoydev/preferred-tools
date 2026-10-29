'use strict';
// THE ACCOUNT DIR - one definition, used by every script. The dir is CLAUDE_CONFIG_DIR, else ~/.claude. The account
// file is the one the CLI was MEASURED writing (Claude Code 2.1.311, docs/sources.md): $CLAUDE_CONFIG_DIR/.claude.json,
// else ~/.claude.json. Its `projects` map is keyed by the project's REAL path on macOS and Linux (macOS /tmp is
// /private/tmp), and by the cwd as typed, in `/`, on Windows (projectEntry).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseJson } = require('./json-file.js');

const homeDir = (env = process.env) => env.HOME || env.USERPROFILE || os.homedir();
const configDir = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeDir(env), '.claude'));
const accountFile = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(homeDir(env), '.claude.json'));

function projectKey(dir)
{
    try { return fs.realpathSync.native(dir); }
    catch { return path.resolve(dir); }
}

// The folder Claude Code keys a session's trust and local servers on: the git repository root when the folder is inside
// one, else the folder itself (https://code.claude.com/docs/en/permissions, 'Project allow rules and workspace trust';
// the local key MEASURED, M4). `git rev-parse` runs only when the folder holds no `.git` of its own; no git, or not a
// repository: the folder.
function localRoot(project)
{
    if (fs.existsSync(path.join(project, '.git')) || !fs.existsSync(project)) return project;
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8', windowsHide: true });
    return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : project;
}

// `~` and `~/x` to the home directory (the script expands it; the server never sees a `~`).
function expandHome(p, env = process.env)
{
    if (p === '~') return homeDir(env);
    if (/^~[\\/]/.test(p)) return path.join(homeDir(env), p.slice(2));
    return p;
}

// A JSON file as a state, never a throw: ok | missing | empty | malformed (| unreadable).
function readState(file)
{
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { return { file, state: err.code === 'ENOENT' ? 'missing' : 'unreadable', doc: null, error: err.code === 'ENOENT' ? null : err.message }; }
    if (!text.trim()) return { file, state: 'empty', doc: null, error: null };
    try
    {
        const doc = parseJson(text);
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { file, state: 'malformed', doc: null, error: 'not a JSON object' };
        return { file, state: 'ok', doc, error: null };
    }
    catch (err) { return { file, state: 'malformed', doc: null, error: err.message }; }
}

// This project's `projects` entry. Claude Code keys it by the folder it started in, MEASURED (docs/sources.md): the
// real path on macOS (the disk's case, whatever was typed) and Linux; on Windows the cwd as typed, `\` written as `/`,
// the typed case kept. So on win32 the key typed as this cwd wins, then the real path's, then either in any case (NTFS
// opens both); elsewhere a key matches exactly - macOS can be a case-sensitive volume.
function projectEntry(projects, project, platform = process.platform)
{
    if (platform !== 'win32') return projects[projectKey(project)] || projects[path.resolve(project)];
    let real = null;
    try { real = fs.realpathSync.native(project); } catch { /* a folder not on disk has no real path */ }
    const want = [path.win32.resolve(project), real].filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    const key = want.find((w) => Object.hasOwn(projects, w))
        ?? Object.keys(projects).find((k) => want.some((w) => w.toLowerCase() === k.toLowerCase()));
    return key === undefined ? undefined : projects[key];
}

// The account file, narrowed to what the inventory needs: user servers, and this project's local servers - keyed on the
// git root when the project is a folder inside a repository, as the CLI keys them from a subfolder (MEASURED,
// docs/sources.md '.mcp.json in parent folders', M4).
function readAccount(env, project, platform = process.platform)
{
    const file = accountFile(env);
    const s = readState(file);
    const doc = s.doc || {};
    const projects = doc.projects && typeof doc.projects === 'object' ? doc.projects : {};
    const mine = projectEntry(projects, localRoot(project), platform) || {};
    return { ...s, user: doc.mcpServers || {}, local: mine.mcpServers || {}, projects };
}

// What the CLI wrote for one server at one scope, read from the file it wrote it to.
function readRegistration(name, scope, project, env)
{
    if (scope === 'project')
    {
        const s = readState(path.join(project, '.mcp.json'));
        return s.doc && s.doc.mcpServers ? s.doc.mcpServers[name] : undefined;
    }
    const a = readAccount(env, project);
    return (scope === 'user' ? a.user : a.local)[name];
}

module.exports = { homeDir, configDir, accountFile, projectKey, localRoot, expandHome, readState, projectEntry, readAccount, readRegistration };
