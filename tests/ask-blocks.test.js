'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseAskBlocks, problemsOf } = require('./ask-blocks.js');

const block = (body, id = 'menu') => parseAskBlocks(`\`\`\`ask${id ? ` ${id}` : ''}\n${body}\n\`\`\``)[0];
const GOOD = "What do you want to change?\n- 'Change tools (Recommended)' - a\n- 'Remove tools' - b\n- 'claude-hud settings' - c\n- 'Done' - d";

test('a sound block parses and has no problems; a block may omit an option the walk omits, never reorder one', () =>
{
    const b = block(GOOD);
    assert.strictEqual(b.options.length, 4);
    assert.strictEqual(b.question, 'What do you want to change?');
    assert.deepStrictEqual(problemsOf(b), []);
    assert.deepStrictEqual(problemsOf(block("What do you want to change?\n- 'Change tools (Recommended)' - a\n- 'Remove tools' - b\n- 'Done' - d")), [], 'claude-hud settings left out when claude-hud is not installed');
    assert.match(problemsOf(block("What do you want to change?\n- 'Change tools (Recommended)' - a\n- 'Done' - d\n- 'Remove tools' - b")).join(), /do not match asks\.STATIC\.menu/);
});

test('every way a block can break the limits is named', () =>
{
    const bad = (body, id) => problemsOf(block(body, id)).join(' | ');
    assert.match(bad("Q?\n- 'Only (Recommended)' - a"), /1 options \(2 to 4 allowed\)/);
    assert.match(bad("Q?\n- 'A (Recommended)' - a\n- 'B' - b\n- 'C' - c\n- 'D' - d\n- 'E' - e", null), /5 options/);
    assert.match(bad("Q?\n- 'A' - a\n- 'B' - b", null), /0 options marked \(Recommended\)/);
    assert.match(bad("Q?\n- 'A (Recommended)' - a\n- 'B (Recommended)' - b", null), /2 options marked \(Recommended\)/);
    assert.match(bad("Q?\n- 'A' - a\n- 'B (Recommended)' - b", null), /must be listed first/);
    assert.match(bad("- 'A (Recommended)' - a\n- 'B' - b", null), /no question/);
    assert.match(bad("Q?\n- A (Recommended) - a\n- 'B' - b", null), /not written as/);
    assert.match(bad(GOOD, 'no-such-ask'), /not a key of asks\.STATIC/);
    assert.match(bad(GOOD, null), /no id after/);
    assert.match(problemsOf(parseAskBlocks('```ask menu\nQ?\n- \'A (Recommended)\' - a')[0]).join(), /never closed/);
});

test('the commands hold every ask block to the limits', () =>
{
    const root = path.join(__dirname, '..');
    let seen = 0;
    const walk = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
    {
        const p = path.join(d, e.name);
        if (e.isDirectory()) return walk(p);
        if (!p.endsWith('.md')) return;
        for (const b of parseAskBlocks(fs.readFileSync(p, 'utf8')))
        {
            seen++;
            assert.deepStrictEqual(problemsOf(b), [], p);
        }
    });
    walk(path.join(root, 'commands'));
    walk(path.join(root, 'skills'));
    assert.ok(seen >= 9, `${seen} ask blocks found; install.md has three, configure.md five, update.md one`);
});

test('the walks write what the step sets (`next.set`, the one location left) and make no call for an empty one', () => {
    const root = path.join(__dirname, '..');
    for (const file of ['install.md', 'configure.md'])
    {
        const text = fs.readFileSync(path.join(root, 'commands', file), 'utf8').replace(/\s+/g, ' ');
        assert.ok(text.includes('`next.set`'), `${file} names next.set`);
        assert.match(text, /When `next\.call` is empty, make no call/, `${file} skips an empty call`);
    }
});

test("install maps both API key answers: 'No key' is written, since 'Use a key from .mcps-secrets' is the default when a key is found", () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'commands', 'install.md'), 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| API key'));
    // the labels toolAsk prints (scripts/asks.js), each mapped
    for (const label of ['Use a key from .mcps-secrets', 'No key - lower rate limits', 'Sign in with OAuth']) assert.ok(row && row.includes(`'${label}'`), `${label}: ${row}`);
    assert.ok(row.includes('"token": true') && row.includes('"token": false'), row);
});

test('install has no step for servers already set up', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'commands', 'install.md'), 'utf8');
    assert.deepStrictEqual(text.split('\n').filter((l) => /^## /.test(l) && /already set up/.test(l)), []);
    assert.ok(!text.includes('existing.calls'));
});

test('asks.js never requires plan.js: the shared readers (currentOf, logicalRoot) live in entries.js, so there is no require cycle', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../scripts/asks.js'), 'utf8');
    assert.doesNotMatch(src, /require\('\.\/plan\.js'\)/);
    const E = require('../scripts/entries.js');
    assert.strictEqual(typeof E.currentOf, 'function');
    assert.deepStrictEqual(E.logicalRoot('/work/shop/.preferred-tools/serena', { platform: 'darwin', project: '/work/shop', home: '/Users/me' }), { kind: 'project', rel: '.preferred-tools/serena' });
    assert.deepStrictEqual(E.logicalRoot('/Users/me/.preferred-tools/serena', { platform: 'darwin', project: '/work/shop', home: '/Users/me' }), { kind: 'home', rel: '.preferred-tools/serena' });
});
