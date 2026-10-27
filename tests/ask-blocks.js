'use strict';
// The fenced `ask` blocks in commands and skills, held to the AskUserQuestion limits and to scripts/asks.js STATIC.
//
//   ```ask <id>
//   The question?
//   - 'Label (Recommended)' - what it does
//   - 'Label' - what it does
//   ```
//
// <id> is a key of asks.STATIC, and the block's labels must equal that ask's labels in order, so the command's text and
// the data the tests hold to the limits cannot drift apart. 2 to 4 options, exactly one '(Recommended)', and it is first.
const asks = require('../scripts/asks.js');

const OPTION = /^- '(.+)' - (.+)$/;

function parseAskBlocks(text)
{
    const blocks = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++)
    {
        const open = /^```ask(?:\s+(\S+))?\s*$/.exec(lines[i]);
        if (!open) continue;
        const block = { id: open[1] || null, line: i + 1, question: '', options: [], bad: [] };
        let j = i + 1;
        for (; j < lines.length && !/^```\s*$/.test(lines[j]); j++)
        {
            const l = lines[j];
            if (!l.trim()) continue;
            const m = OPTION.exec(l);
            if (m) block.options.push({ label: m[1], description: m[2] });
            else if (l.startsWith('-')) block.bad.push(l);
            else block.question += (block.question ? ' ' : '') + l.trim();
        }
        block.closed = j < lines.length;
        blocks.push(block);
        i = j;
    }
    return blocks;
}

const staticAsk = (id) =>
{
    const q = asks.STATIC[id];
    if (!q) return null;
    return typeof q === 'function' ? q('<n>', '<m>', '<k>') : q;
}

// -> problems as strings, empty when the block is sound
function problemsOf(block)
{
    const out = [];
    const at = `ask block at line ${block.line}${block.id ? ` (${block.id})` : ''}`;
    if (!block.closed) out.push(`${at}: never closed`);
    if (!block.id) out.push(`${at}: no id after \`\`\`ask - name a key of asks.STATIC`);
    if (!block.question) out.push(`${at}: no question`);
    for (const b of block.bad) out.push(`${at}: an option line not written as - 'Label' - description: ${b}`);
    const n = block.options.length;
    if (n < 2 || n > 4) out.push(`${at}: ${n} options (2 to 4 allowed)`);
    const rec = block.options.filter((o) => /\(Recommended\)$/.test(o.label));
    if (rec.length !== 1) out.push(`${at}: ${rec.length} options marked (Recommended) (exactly 1)`);
    else if (block.options[0] !== rec[0]) out.push(`${at}: the (Recommended) option must be listed first`);
    const st = block.id && staticAsk(block.id);
    if (block.id && !st) out.push(`${at}: '${block.id}' is not a key of asks.STATIC`);
    if (st)
    {
        const want = st.options.map((o) => o.label);
        const got = block.options.map((o) => o.label);
        // a block may leave an option out where the walk omits it (Remove tools when nothing is installed), never reorder or rename
        if (!got.every((g) => want.includes(g)) || JSON.stringify(got) !== JSON.stringify(want.filter((w) => got.includes(w))))
            out.push(`${at}: labels ${JSON.stringify(got)} do not match asks.STATIC.${block.id} ${JSON.stringify(want)}`);
    }
    return out;
}

module.exports = { parseAskBlocks, problemsOf, staticAsk };
