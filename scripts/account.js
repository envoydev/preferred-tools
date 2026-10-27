'use strict';
// THE ACCOUNT DIR - one definition, used by every script. The dir is CLAUDE_CONFIG_DIR, else ~/.claude. The account
// file is the one the CLI was MEASURED writing (Claude Code 2.1.311, docs/sources.md): $CLAUDE_CONFIG_DIR/.claude.json,
// else ~/.claude.json. Its `projects` map is keyed by the project's REAL path (macOS /tmp is /private/tmp).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJson } = require('./json-file.js');

const homeDir = (env = process.env) => env.HOME || env.USERPROFILE || os.homedir();
const configDir = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeDir(env), '.claude'));
const accountFile = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(homeDir(env), '.claude.json'));

function projectKey(dir)
{
    try { return fs.realpathSync.native(dir); }
    catch { return path.resolve(dir); }
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

// The account file, narrowed to what the inventory needs: user servers, and this project's local servers.
function readAccount(env, project)
{
    const file = accountFile(env);
    const s = readState(file);
    const doc = s.doc || {};
    const key = projectKey(project);
    const projects = doc.projects && typeof doc.projects === 'object' ? doc.projects : {};
    const mine = projects[key] || projects[path.resolve(project)] || {};
    return { ...s, user: doc.mcpServers || {}, local: mine.mcpServers || {}, projectKey: key };
}

module.exports = { homeDir, configDir, accountFile, projectKey, expandHome, readState, readAccount };
