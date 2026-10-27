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
    assert.ok(seen >= 10, `${seen} ask blocks found; install.md has four, configure.md five, update.md one`);
});
