#!/usr/bin/env node
'use strict';
// A FAKE `claude` for the tests. It records every call's argv (FAKE_CLAUDE_LOG, JSON lines) and emulates what the real
// CLI was MEASURED doing (Claude Code 2.1.311, docs/sources.md): `mcp add-json` / `remove` write .mcp.json or the
// account file; `plugin install` over an installed plugin is a no-op at the same scope, flips a disabled row on, and adds
// a second row at another scope; enable over enabled exits 1. It is a test double - the scripts under test never write.
//
//   FAKE_CLAUDE_STATE    folder holding plugins.json (the fake's plugin and marketplace records)
//   FAKE_CLAUDE_FAIL     comma-separated substrings; a call whose argv contains one fails with exit 1
//   FAKE_CLAUDE_VERSIONS JSON {"<plugin id>": "<version a fresh install or update lands on>"}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const cwd = process.cwd();
const state = process.env.FAKE_CLAUDE_STATE || path.join(os.tmpdir(), 'fake-claude-state');
fs.mkdirSync(state, { recursive: true });
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd })}\n`);

const say = (s) => process.stdout.write(`${s}\n`);
const die = (s, code = 1) => { process.stderr.write(`${s}\n`); process.exit(code); };
const home = () => process.env.HOME || os.homedir();
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const accountFile = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home(), '.claude.json'));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return d; throw e; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

const failList = (process.env.FAKE_CLAUDE_FAIL || '').split(',').filter(Boolean);
if (failList.some((f) => argv.join(' ').includes(f))) die(`fake claude: injected failure for ${argv.join(' ')}`);

function scopeOf(args)
{
    const i = args.findIndex((a) => a === '-s' || a === '--scope');
    return i >= 0 ? args[i + 1] : undefined;
}
const positional = (args) => args.filter((a, i) => !a.startsWith('-') && !(i > 0 && (args[i - 1] === '-s' || args[i - 1] === '--scope')));

function serversRef(scope)
{
    if (scope === 'project')
    {
        const f = path.join(cwd, '.mcp.json');
        let doc;
        try { doc = readJson(f, { mcpServers: {} }); } catch { die(`Failed to parse ${f}`); }
        doc.mcpServers = doc.mcpServers || {};
        return { doc, servers: doc.mcpServers, save: () => writeJson(f, doc) };
    }
    const f = accountFile();
    let doc;
    try { doc = readJson(f, {}); } catch { die(`Failed to parse ${f}`); }
    if (scope === 'user')
    {
        doc.mcpServers = doc.mcpServers || {};
        return { doc, servers: doc.mcpServers, save: () => writeJson(f, doc) };
    }
    doc.projects = doc.projects || {};
    const key = real(cwd);
    doc.projects[key] = doc.projects[key] || { allowedTools: [], mcpServers: {} };
    doc.projects[key].mcpServers = doc.projects[key].mcpServers || {};
    return { doc, servers: doc.projects[key].mcpServers, save: () => writeJson(f, doc) };
}

const plugState = () => readJson(path.join(state, 'plugins.json'), { installed: [], marketplaces: [] });
const savePlug = (s) => writeJson(path.join(state, 'plugins.json'), s);
const settingsFile = (scope) => (scope === 'user' ? path.join(configDir(), 'settings.json') : path.join(cwd, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json'));
function setEnabled(scope, id, value)
{
    const f = settingsFile(scope);
    const doc = readJson(f, {});
    doc.enabledPlugins = { ...(doc.enabledPlugins || {}), [id]: value };
    writeJson(f, doc);
}
const versionFor = (id) => JSON.parse(process.env.FAKE_CLAUDE_VERSIONS || '{}')[id] || '1.0.0';
const enabledAt = (scope, id) => { const d = readJson(settingsFile(scope), {}); return d.enabledPlugins ? d.enabledPlugins[id] : undefined; };

const [a, b, c] = argv;
if (a === '--version') { say('2.1.311 (Claude Code)'); process.exit(0); }

if (a === 'mcp')
{
    const rest = argv.slice(2);
    if (b === 'add-json')
    {
        const [name, json] = positional(rest);
        const scope = scopeOf(rest) || 'local';
        let entry;
        try { entry = JSON.parse(json); } catch { die('Invalid JSON'); }
        const ref = serversRef(scope);
        if (ref.servers[name]) die(`MCP server ${name} already exists in ${scope} config`);
        ref.servers[name] = entry;
        ref.save();
        say(`Added ${entry.type && entry.type !== 'stdio' ? entry.type : 'stdio'} MCP server ${name} to ${scope} config`);
        process.exit(0);
    }
    if (b === 'remove')
    {
        const [name] = positional(rest);
        const scope = scopeOf(rest);
        const scopes = scope ? [scope] : ['local', 'project', 'user'];
        const hits = scopes.filter((s) => serversRef(s).servers[name]);
        if (!hits.length) die(`No MCP server found with name: ${name}`);
        if (hits.length > 1) die(`MCP server ${name} exists in multiple scopes: ${hits.join(', ')}. Use -s to specify.`);
        const ref = serversRef(hits[0]);
        delete ref.servers[name];
        ref.save();
        say(`Removed MCP server ${name} from ${hits[0]} config`);
        process.exit(0);
    }
    if (b === 'get')
    {
        const [name] = positional(rest);
        for (const s of ['local', 'project', 'user'])
        {
            const e = serversRef(s).servers[name];
            if (e) { say(`${name}:\n  Scope: ${s}\n  Status: ✓ Connected\n  Type: ${e.type || 'stdio'}`); process.exit(0); }
        }
        die(`No MCP server found with name: ${name}`);
    }
    die(`fake claude: unhandled mcp call ${argv.join(' ')}`, 2);
}

if (a === 'plugin' || a === 'plugins')
{
    const s = plugState();
    if (b === 'list')
    {
        say(JSON.stringify(s.installed.map((r) => ({ ...r })), null, 2));
        process.exit(0);
    }
    if (b === 'marketplace')
    {
        const rest = argv.slice(3);
        if (c === 'list') { say(JSON.stringify(s.marketplaces)); process.exit(0); }
        if (c === 'add')
        {
            const [src] = positional(rest);
            const name = (process.env.FAKE_CLAUDE_MARKET_NAMES ? JSON.parse(process.env.FAKE_CLAUDE_MARKET_NAMES)[src] : null) || src.split('/').pop();
            if (!s.marketplaces.some((m) => m.name === name)) s.marketplaces.push({ name, repo: src, installLocation: path.join(state, 'marketplaces', name) });
            savePlug(s);
            say(`✔ Successfully added marketplace: ${name} (declared in user settings)`);
            process.exit(0);
        }
        if (c === 'update') { say(`✔ Successfully updated marketplace: ${positional(rest)[0]}`); process.exit(0); }
        die(`fake claude: unhandled marketplace call ${argv.join(' ')}`, 2);
    }
    const rest = argv.slice(2);
    const [spec] = positional(rest);
    const scope = scopeOf(rest) || (b === 'install' ? 'user' : undefined);
    const at = (sc) => s.installed.findIndex((r) => r.id === spec && r.scope === sc && (sc === 'user' || r.projectPath === real(cwd)));
    if (b === 'install' || b === 'i')
    {
        const market = spec.split('@')[1];
        if (!market || !s.marketplaces.some((m) => m.name === market)) die(`Marketplace "${market}" not found`);
        const i = at(scope);
        if (i >= 0)
        {
            if (enabledAt(scope, spec) === false) { setEnabled(scope, spec, true); s.installed[i].enabled = true; savePlug(s); say(`✔ Successfully installed plugin: ${spec} (scope: ${scope})`); }
            else say(`✔ Plugin "${spec}" is already installed (scope: ${scope})`);
            process.exit(0);
        }
        const row = { id: spec, version: versionFor(spec), scope, enabled: true, installPath: path.join(state, 'cache', spec) };
        if (scope !== 'user') row.projectPath = real(cwd);
        s.installed.push(row);
        setEnabled(scope, spec, true);
        savePlug(s);
        say(`✔ Successfully installed plugin: ${spec} (scope: ${scope})`);
        process.exit(0);
    }
    if (b === 'uninstall' || b === 'remove' || b === 'rm')
    {
        const i = at(scope);
        if (i < 0) die(`Plugin "${spec}" is not installed at ${scope} scope`);
        s.installed.splice(i, 1);
        const f = settingsFile(scope);
        const doc = readJson(f, {});
        if (doc.enabledPlugins) delete doc.enabledPlugins[spec];
        writeJson(f, doc);
        savePlug(s);
        say(`✔ Successfully uninstalled plugin: ${spec.split('@')[0]} (scope: ${scope})`);
        process.exit(0);
    }
    if (b === 'update')
    {
        const sc = scope || ['local', 'project', 'user'].find((x) => at(x) >= 0);
        const i = sc ? at(sc) : -1;
        if (i < 0) die(`Plugin "${spec}" is not installed`);
        const next = versionFor(spec);
        if (s.installed[i].version === next) { say(`${spec} is already at the latest version (${next}).`); process.exit(0); }
        s.installed[i].version = next;
        savePlug(s);
        say(`✔ Plugin "${spec}" updated to version ${next} (scope: ${sc})`);
        process.exit(0);
    }
    if (b === 'enable' || b === 'disable')
    {
        const sc = scope || ['local', 'project', 'user'].find((x) => at(x) >= 0);
        const i = sc ? at(sc) : -1;
        if (i < 0) die(`Plugin "${spec}" is not installed`);
        const want = b === 'enable';
        if (enabledAt(sc, spec) === want) die(`Plugin "${spec}" is already ${want ? 'enabled' : 'disabled'} at ${sc} scope`);
        setEnabled(sc, spec, want);
        s.installed[i].enabled = want;
        savePlug(s);
        say(`✔ Successfully ${b}d plugin: ${spec} (scope: ${sc})`);
        process.exit(0);
    }
}
die(`fake claude: unhandled call ${argv.join(' ')}`, 2);
