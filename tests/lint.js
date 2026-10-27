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
