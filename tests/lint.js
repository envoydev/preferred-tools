#!/usr/bin/env node
'use strict';
// JSON shape checks that need no test runner: every shipped JSON file parses, the manifest has the one version and the
// id that must never change, and no component path in a command or skill points outside ${CLAUDE_PLUGIN_ROOT}.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

const jsonFiles = ['.claude-plugin/plugin.json', 'catalog/tools.json', 'catalog/fixes.json', 'catalog/reserved-names.json', 'package.json'];
const plugSettings = path.join(root, 'catalog', 'plugin-settings.json');
if (fs.existsSync(plugSettings)) jsonFiles.push('catalog/plugin-settings.json');
const docs = {};
for (const rel of jsonFiles)
{
    try { docs[rel] = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
    catch (err) { problems.push(`${rel}: ${err.message}`); }
}

const manifest = docs['.claude-plugin/plugin.json'] || {};
need(manifest.name === 'preferred-tools', 'plugin.json name must stay preferred-tools (renaming it silences every install)');
need(/^\d+\.\d+\.\d+$/.test(manifest.version || ''), 'plugin.json version must be semver');
need(!('dependencies' in manifest), 'plugin.json must not declare dependencies (claude plugin update installs none)');
need(manifest.version === (docs['package.json'] || {}).version, 'package.json version must equal plugin.json version');

// Script paths in commands and skills: only through the plugin root.
const textFiles = [];
for (const dir of ['commands', 'skills'])
{
    const walk = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (p.endsWith('.md')) textFiles.push(p);
    });
    walk(path.join(root, dir));
}
for (const file of textFiles)
{
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
        if (/\bnode\s+(?!"\$\{CLAUDE_PLUGIN_ROOT\}\/)["']?(\.\/)?scripts\//.test(line))
            problems.push(`${path.relative(root, file)}:${i + 1}: a script call must be node "\${CLAUDE_PLUGIN_ROOT}/scripts/<file>"`);
        if (/(?<!CLAUDE_PLUGIN_ROOT\}\/)catalog\/[a-z-]+\.json/.test(line) && /node|--catalog/.test(line) && !/\$\{CLAUDE_PLUGIN_ROOT\}\/catalog/.test(line))
            problems.push(`${path.relative(root, file)}:${i + 1}: a catalog path must go through \${CLAUDE_PLUGIN_ROOT}`);
    });
}

// allowed-tools is a pre-approval, so it never covers a call that changes an install: the CLI's own prompt is the guard
// beside the command's written ask. A script that writes is listed only with a read-only flag.
// fetch.js downloads and runs a package's own install, so it counts as a write
const WRITES = /scripts\/(?:apply|fetch)\.js|scripts\/(?:fix|update)\.js"\s*(?:\*|--apply|\))|scripts\/hud-statusline\.js"\s*(?:\*|--replace|--statusline-only|\))/;
for (const file of textFiles)
{
    const m = /^allowed-tools:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
    if (m && WRITES.test(m[1])) problems.push(`${path.relative(root, file)}: allowed-tools pre-approves a script that writes (list only --detect, --questions, --check)`);
}

// Ask blocks: 2 to 4 options, one '(Recommended)' and it first, labels equal to asks.STATIC (tests/ask-blocks.js).
const { parseAskBlocks, problemsOf } = require('./ask-blocks.js');
for (const file of textFiles)
    for (const block of parseAskBlocks(fs.readFileSync(file, 'utf8')))
        for (const p of problemsOf(block)) problems.push(`${path.relative(root, file)}: ${p}`);

// Every call of a script that reads the roots map and the records carries the plugin's data folder (spec D2, D6), and a
// read-only flag stays first, so the allowed-tools patterns (`--detect *`, `--questions *`, `--check *`) still match. A
// call is a line of a code block or a backticked one in prose; the allowed-tools line itself is not a call.
const DATA = '--data "${CLAUDE_PLUGIN_DATA}"';
const CALL = /(?:node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/|`)(inventory|plan|apply|fix|update)\.js"?\s+([^`\n]*)/g;
for (const file of textFiles)
{
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^allowed-tools:/.test(line)) return;
        for (const m of line.matchAll(CALL))
        {
            const at = `${path.relative(root, file)}:${i + 1}`;
            if (!m[2].includes(DATA)) problems.push(`${at}: ${m[1]}.js call without ${DATA}`);
            const ro = /--(?:detect|questions|check)\b/.exec(m[2]);
            if (ro && ro.index !== 0) problems.push(`${at}: ${m[1]}.js call - ${ro[0]} must be its first argument`);
        }
    });
}

// No text sends the user to the Other field (spec D8): every question the walk can put (tests/ask-texts.js, Task 4's
// four fixtures), and every line of a command or skill, its ask blocks included - the model repeats what a command says.
const { sendsToOther, walkTexts } = require('./ask-texts.js');
for (const { where, text } of walkTexts()) if (sendsToOther(text)) problems.push(`asks.all (${where}): sends the user to Other: ${text}`);
for (const file of textFiles)
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (sendsToOther(line)) problems.push(`${path.relative(root, file)}:${i + 1}: sends the user to Other - the walk asks a typed value next in one plain line`);
    });

// The header helper is copied into the user's root and compared by digest (write-helper, helper-stale): its bytes are pinned
// per version, its first line carries that version, and it needs nothing but Node.
const HELPER_SHA256 = {
    1: '958abe0bf59ab7ef2551573e3105ab7766036c31fc21d19bb0fcf58675e87719', // 0.2.0
    2: '184d9162cd9d506266eb989704a743fd3608728b0601e8f21a398bbc8b8566de', // prints only when Claude Code runs it
};
{
    const rel = path.join('scripts', 'mcp-headers.js');
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const helper = require(path.join(root, rel));
    const first = /^\/\/ preferred-tools mcp-headers (\d+)\r?$/m.exec(text.split('\n')[0]);
    need(first, `${rel}: the first line must be '// preferred-tools mcp-headers <version>'`);
    if (first)
    {
        const version = Number(first[1]);
        need(version === helper.HELPER_VERSION, `${rel}: the first line says version ${version}, HELPER_VERSION is ${helper.HELPER_VERSION}`);
        const digest = helper.digestOf(text);
        need(digest === HELPER_SHA256[version], `${rel}: SHA-256 ${digest} is not HELPER_SHA256[${version}] in tests/lint.js - a changed helper bumps its version`);
    }
    for (const m of text.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g))
        need(m[2].startsWith('node:'), `${rel}: require('${m[2]}') - the helper runs outside the plugin, so node: modules only`);
}

// Public repo: no absolute local path and no home directory in anything shipped.
const scan = (rel) => {
    const p = path.join(root, rel);
    for (const e of fs.readdirSync(p, { withFileTypes: true }))
    {
        if (['.git', 'node_modules', '.alfred'].includes(e.name) || e.name === '.DS_Store') continue;
        const q = path.join(rel, e.name);
        if (e.isDirectory()) { scan(q); continue; }
        if (!/\.(md|json|js)$/.test(e.name)) continue;
        if (q === path.join('tests', 'lint.js')) continue;
        const body = fs.readFileSync(path.join(root, q), 'utf8');
        const m = body.match(/\/Users\/[a-z]+\/|C:\\Users\\[A-Za-z]+\\(?!<)/);
        if (m && !q.startsWith('tests' + path.sep) && !q.startsWith('docs' + path.sep) && !q.startsWith('.claude' + path.sep)) problems.push(`${q}: absolute local path ${m[0]}`);
    }
};
scan('.');

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`lint: ${jsonFiles.length} JSON files parse; ${textFiles.length} command/skill files checked`);
