'use strict';
// Registry lookups for pins: which release of a package may be offered. One rule for the update skill and for
// `npm run refresh-pins`: the newest STABLE release that is at least `days` old (the age gate) and newer than the pin.
// A newer release that is too young is reported as held back, never offered.
//
// A registry is read with `fetch`. The two base URLs can be overridden for a test or a mirror:
//   PREFERRED_TOOLS_NPM_URL   default https://registry.npmjs.org
//   PREFERRED_TOOLS_PYPI_URL  default https://pypi.org/pypi
const { compareVersions } = require('./fixes/common.js');

const DAY = 86400000;
const AGE_DAYS = 7;
const STABLE = { npm: /^\d+\.\d+\.\d+$/, pypi: /^\d+(\.\d+)*$/ }; // no -rc / -beta / a1 / b2 / .dev / .post

const npmBase = (env) => (env.PREFERRED_TOOLS_NPM_URL || 'https://registry.npmjs.org').replace(/\/$/, '');
const pypiBase = (env) => (env.PREFERRED_TOOLS_PYPI_URL || 'https://pypi.org/pypi').replace(/\/$/, '');

async function getJson(url, fetchFn)
{
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    return res.json();
}

// -> [{ version, time (ms) }]; a deprecated (npm) or fully yanked (PyPI) release is left out.
async function versionsOf(registry, name, { env = process.env, fetchFn = fetch } = {})
{
    if (registry === 'npm')
    {
        const doc = await getJson(`${npmBase(env)}/${name.replace('/', '%2F')}`, fetchFn);
        return Object.keys(doc.versions || {})
            .filter((v) => !(doc.versions[v] || {}).deprecated && doc.time && doc.time[v])
            .map((v) => ({ version: v, time: Date.parse(doc.time[v]) }));
    }
    if (registry === 'pypi')
    {
        const doc = await getJson(`${pypiBase(env)}/${name}/json`, fetchFn);
        const out = [];
        for (const [v, files] of Object.entries(doc.releases || {}))
        {
            const live = (files || []).filter((f) => !f.yanked);
            if (!live.length) continue;
            out.push({ version: v, time: Math.min(...live.map((f) => Date.parse(f.upload_time_iso_8601 || f.upload_time))) });
        }
        return out;
    }
    throw new Error(`unknown registry '${registry}'`);
}

// -> { offer: { version, ageDays } | null, held: [{ version, ageDays }] (newer than `current`, too young, newest first) }
// `current` null means no pin to compare: every stable release counts as newer.
function choose(versions, { registry, now = Date.now(), days = AGE_DAYS, current = null })
{
    const stable = versions.filter((v) => STABLE[registry].test(v.version) && Number.isFinite(v.time));
    const newer = stable.filter((v) => current === null || compareVersions(v.version, current) === 1);
    newer.sort((a, b) => compareVersions(b.version, a.version));
    const age = (v) => Math.floor((now - v.time) / DAY);
    const ok = newer.find((v) => now - v.time >= days * DAY);
    return {
        offer: ok ? { version: ok.version, ageDays: age(ok) } : null,
        held: newer.filter((v) => now - v.time < days * DAY && (!ok || compareVersions(v.version, ok.version) === 1)).map((v) => ({ version: v.version, ageDays: age(v) })),
    };
}

// The bump day's cut-off, in the catalog's spelling: the end of that UTC day.
const cutoffOf = (now = Date.now()) => `${new Date(now).toISOString().slice(0, 10)}T23:59:59Z`;

// One line for a package's held-back releases: the newest, and how many more are under the gate.
const heldLine = (pkgName, held, days = AGE_DAYS) => (held.length
    ? `${pkgName} ${held[0].version} is ${held[0].ageDays} day(s) old - held back until it is ${days}${held.length > 1 ? ` (${held.length - 1} more newer than the pin are younger than ${days} days)` : ''}`
    : null);

module.exports = { heldLine, DAY, AGE_DAYS, STABLE, versionsOf, choose, cutoffOf };
