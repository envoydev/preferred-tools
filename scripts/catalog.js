'use strict';
// The catalog, loaded and indexed. Everything else reads rows through here, so the shape lives in one place.
const fs = require('node:fs');
const path = require('node:path');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, name), 'utf8'));

function load(dir = CATALOG_DIR)
{
    const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const tools = read('tools.json');
    const reserved = new Set(read('reserved-names.json').names);
    const byId = new Map(tools.tools.map((row) => [row.id, row]));
    return { ...tools, reserved, byId, fixes: read('fixes.json').fixes };
}

// One string per fingerprint, equal for two rows exactly when they would match the same registration.
function fingerprintKey(f)
{
    if (f.pkg) return `pkg:${f.pkg}${f.flag ? `+${f.flag}=${f.value}` : ''}`;
    if (f.command) return `cmd:${f.command}`;
    return `url:${f.host || '*'}${f.pathPrefix || ''}`;
}

const routesOf = (row) => (row.kind === 'mcp' ? Object.keys(row.routes) : []);
const supportedOn = (row, platform) => row.os.includes(platform);

module.exports = { CATALOG_DIR, readJson, load, fingerprintKey, routesOf, supportedOn };
