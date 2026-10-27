'use strict';
// The one JSON reader for every file this plugin parses that a person may have edited (.mcp.json, settings.json, the
// account's .claude.json). An editor on Windows saves UTF-8 with a BOM, and a bare JSON.parse on it throws - which a
// `catch { return {} }` reader turns into 'the file is empty'. One leading BOM is stripped; anything else wrong with the
// text - a BOM plus garbage included - still throws, so it still counts as unreadable.
// Ported from alfred-code scripts/install/json-file.js; blockingStdio is alfred-code stack/hooks/hook-prelude.js's.
const fs = require('node:fs');

const stripBom = (text) => (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

// JSON.parse of text that may start with a BOM; throws on anything unparseable.
const parseJson = (text) => JSON.parse(stripBom(text));

// The file's parsed value, or `{}` when it is absent or unreadable.
const readJson = (file) => { try { return parseJson(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

// A pipe closed early must not truncate the last lines of a script's output: make stdout and stderr blocking.
function blockingStdio(streams = [process.stdout, process.stderr])
{
    for (const s of streams)
    {
        try { if (s && s._handle && typeof s._handle.setBlocking === 'function') s._handle.setBlocking(true); }
        catch { /* a stream that cannot block keeps Node's default */ }
    }
}

module.exports = { stripBom, parseJson, readJson, blockingStdio };
