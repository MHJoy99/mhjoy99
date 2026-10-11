#!/usr/bin/env node
// Self-hosted GitHub profile stats -> animated SVG cards.
// Node 20+, zero dependencies. Reads GITHUB_TOKEN (or GH_TOKEN) and USERNAME (default MHJoy99).
// Writes assets/stats/{overview,languages,activity,streak}.svg
// Output is deterministic: the "updated" date only moves when the data actually changes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'stats');
const USERNAME = process.env.GH_STATS_USER || (process.platform === 'win32' ? '' : process.env.USERNAME) || 'MHJoy99';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const API = 'https://api.github.com/graphql';
const DATE_TOKEN = '__UPDATED__';

/* ------------------------------------------------------------------ data */

async function gql(query, variables = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'mhjoy99-profile-stats',
        },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status >= 500 || res.status === 429 || res.status === 403) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.message || ''}`);
      if (json.errors && json.errors.length) {
        throw new Error(json.errors.map((e) => e.message).join('; '));
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`GraphQL request failed: ${lastErr && lastErr.message}`);
}

const Q_MAIN = `
query($login:String!, $after:String) {
  user(login:$login) {
    login name createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount forkCount
        primaryLanguage { name color }
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions totalPullRequestContributions totalIssueContributions
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

function yearQuery(years) {
  const parts = years.map(
    (y) => `y${y.year}: contributionsCollection(from: "${y.from}", to: "${y.to}") {
      totalPullRequestContributions totalIssueContributions totalCommitContributions
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }`,
  );
  return `query($login:String!){ user(login:$login){ ${parts.join('\n')} } }`;
}

async function collect() {
  let after = null;
  let user = null;
  const repos = [];
  do {
    const data = await gql(Q_MAIN, { login: USERNAME, after });
    if (!data.user) throw new Error(`User ${USERNAME} not found`);
    user = user || data.user;
    repos.push(...data.user.repositories.nodes);
    const pi = data.user.repositories.pageInfo;
    after = pi.hasNextPage ? pi.endCursor : null;
  } while (after);

  const now = new Date();
  const createdYear = new Date(user.createdAt).getUTCFullYear();
  const thisYear = now.getUTCFullYear();
  const years = [];
  for (let y = createdYear; y <= thisYear; y++) {
    years.push({
      year: y,
      from: y === createdYear ? user.createdAt : `${y}-01-01T00:00:00Z`,
      to: y === thisYear ? now.toISOString().replace(/\.\d+Z$/, 'Z') : `${y}-12-31T23:59:59Z`,
    });
  }
  const yd = (await gql(yearQuery(years), { login: USERNAME })).user;

  // merge every day we know about
  const dayMap = new Map();
  const addWeeks = (weeks) => {
    for (const w of weeks) for (const d of w.contributionDays) {
      const prev = dayMap.get(d.date);
      if (prev === undefined || d.contributionCount > prev) dayMap.set(d.date, d.contributionCount);
    }
  };
  let allTime = 0, allPRs = 0, allIssues = 0, yearTotal = 0;
  for (const y of years) {
    const c = yd[`y${y.year}`];
    allTime += c.contributionCalendar.totalContributions;
    allPRs += c.totalPullRequestContributions;
    allIssues += c.totalIssueContributions;
    if (y.year === thisYear) yearTotal = c.contributionCalendar.totalContributions;
    addWeeks(c.contributionCalendar.weeks);
  }
  const cal = user.contributionsCollection.contributionCalendar;
  addWeeks(cal.weeks);

  // languages across original repos
  const langs = new Map();
  for (const r of repos) {
    for (const e of r.languages.edges) {
      const cur = langs.get(e.node.name) || { name: e.node.name, color: e.node.color, bytes: 0 };
      cur.bytes += e.size;
      if (!cur.color && e.node.color) cur.color = e.node.color;
      langs.set(e.node.name, cur);
    }
  }

  return {
    login: user.login,
    createdAt: user.createdAt,
    followers: user.followers.totalCount,
    repoCount: repos.length,
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    forks: repos.reduce((s, r) => s + r.forkCount, 0),
    thisYear, yearTotal, allTime, allPRs, allIssues,
    rollingTotal: cal.totalContributions,
    weeks: cal.weeks.map((w) => w.contributionDays),
    days: [...dayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, count]) => ({ date, count })),
    langs: [...langs.values()].sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1)),
  };
}

/* ------------------------------------------------------------ computing */

const DAY = 86400000;
const t = (d) => Date.parse(d + 'T00:00:00Z');

function computeStreaks(days) {
  const limit = Date.now() + DAY * 1.5;
  days = days.filter((d) => t(d.date) <= limit);
  let longest = { len: 0, start: null, end: null };
  let run = null;
  for (const d of days) {
    if (d.count > 0) {
      if (run && t(d.date) - t(run.end) === DAY) { run.len++; run.end = d.date; }
      else run = { len: 1, start: d.date, end: d.date };
      if (run.len > longest.len) longest = { ...run };
    } else run = null;
  }
  let current = { len: 0, start: null, end: null };
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--; // today with 0 must not break the streak
  if (i >= 0 && days[i].count > 0) {
    let start = i;
    while (start > 0 && days[start - 1].count > 0 && t(days[start].date) - t(days[start - 1].date) === DAY) start--;
    current = { len: i - start + 1, start: days[start].date, end: days[i].date };
  }
  return { current, longest };
}

function topLanguages(langs) {
  const total = langs.reduce((s, l) => s + l.bytes, 0) || 1;
  const top = langs.slice(0, 8).map((l) => ({ name: l.name, color: fixColor(l.name, l.color), bytes: l.bytes }));
  const rest = langs.slice(8).reduce((s, l) => s + l.bytes, 0);
  if (rest > 0) top.push({ name: 'Other', color: '#64748b', bytes: rest });
  return { total, items: top.map((l) => ({ ...l, pct: (l.bytes / total) * 100 })) };
}

/* -------------------------------------------------------------- helpers */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d, withYear = true) {
  const [y, m, dd] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${dd}${withYear ? ', ' + y : ''}`;
}
function fmtRange(a, b) {
  if (!a) return '';
  const ya = a.slice(0, 4), yb = b.slice(0, 4);
  if (a === b) return fmtDate(a);
  return ya === yb ? `${fmtDate(a, false)} – ${fmtDate(b)}` : `${fmtDate(a)} – ${fmtDate(b)}`;
}

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function mix(hex, to, f) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}
function fixColor(name, color) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return '#94a3b8';
  if (color.toLowerCase() === '#012456') return '#5391fe'; // PowerShell
  let c = color, f = 0;
  while (lum(c) < 0.16 && f < 1) { f += 0.1; c = mix(color, '#ffffff', f); }
  return c;
}

/* ----------------------------------------------------------- svg shells */

const FONT = "'Segoe UI', -apple-system, system-ui, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'Cascadia Code', 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace";

const BASE_CSS = `
text{font-family:${FONT}}
.mono{font-family:${MONO}}
.ttl{font-size:17px;font-weight:800;fill:#e2e8f0;letter-spacing:.2px}
.sub{font-size:12px;fill:#94a3b8}
.mut{font-size:11px;fill:#64748b}
.lbl{font-size:12px;fill:#94a3b8}
.num{font-weight:800;fill:#e2e8f0;font-variant-numeric:tabular-nums}
.live{animation:pulse 2.4s ease-in-out infinite}
.aur1{animation:drift1 12s ease-in-out infinite alternate}
.aur2{animation:drift2 10s ease-in-out infinite alternate}
.shim{animation:shim 9s linear infinite}
.rise{animation:rise .7s cubic-bezier(.2,.8,.2,1) backwards}
.fr{opacity:0;animation-name:frs;animation-timing-function:linear;animation-fill-mode:none}
.fr.last{opacity:1;animation-name:frl;animation-fill-mode:backwards}
@keyframes frs{0%,100%{opacity:1}}
@keyframes frl{from{opacity:0}to{opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes drift1{from{transform:translate(0,0)}to{transform:translate(60px,16px)}}
@keyframes drift2{from{transform:translate(0,0)}to{transform:translate(-50px,-12px)}}
@keyframes shim{to{stroke-dashoffset:-1000}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion: reduce){
*{animation:none!important}
.fr{display:none}
.shim,.scan{opacity:0}
}`;

function shell({ w, h, title, desc, defs = '', css = '', body, updated }) {
  const cw = w - 12, ch = h - 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#111c3a"/><stop offset=".55" stop-color="#0f172a"/><stop offset="1" stop-color="#0b1020"/></linearGradient>
<linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#38bdf8" stop-opacity="0"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></linearGradient>
<linearGradient id="sig" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#38bdf8"/><stop offset=".55" stop-color="#3b82f6"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>
<radialGradient id="gSky"><stop offset="0" stop-color="#38bdf8" stop-opacity=".22"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
<radialGradient id="gVio"><stop offset="0" stop-color="#7c3aed" stop-opacity=".28"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>
<clipPath id="card"><rect x="6" y="6" width="${cw}" height="${ch}" rx="16"/></clipPath>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.2"/></filter>
<filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>
${defs}
</defs>
<style>${BASE_CSS}${css}</style>
<rect x="6" y="6" width="${cw}" height="${ch}" rx="16" fill="#3b82f6" opacity=".10" filter="url(#soft)"/>
<rect x="6" y="6" width="${cw}" height="${ch}" rx="16" fill="url(#bg)"/>
<g clip-path="url(#card)">
<g class="aur1"><ellipse cx="${w * 0.18}" cy="${h * 0.15}" rx="260" ry="120" fill="url(#gSky)"/></g>
<g class="aur2"><ellipse cx="${w * 0.86}" cy="${h * 0.95}" rx="280" ry="130" fill="url(#gVio)"/></g>
</g>
<rect x="6.5" y="6.5" width="${cw - 1}" height="${ch - 1}" rx="15.5" fill="none" stroke="rgba(148,163,184,.18)"/>
<rect class="shim" x="6.5" y="6.5" width="${cw - 1}" height="${ch - 1}" rx="15.5" fill="none" stroke="url(#edge)" stroke-width="1.6" pathLength="1000" stroke-dasharray="130 870" stroke-linecap="round"/>
${body}
</svg>
`;
}

function header(title, sub, updated, extraRight = '') {
  return `<circle class="live" cx="35" cy="33" r="3.6" fill="#34d399"/>
<circle class="live" cx="35" cy="33" r="7" fill="#34d399" opacity=".18"/>
<text class="ttl" x="50" y="38.5">${esc(title)}</text>
<text class="sub" x="${50 + 0}" y="0" opacity="0"> </text>
<text class="mut mono" x="810" y="38" text-anchor="end">${esc(sub)}${sub ? ' · ' : ''}updated ${updated}${extraRight}</text>`;
}

// count-up text built from stepped frames (pure CSS; final frame is the resting state)
function countUp({ x, y, value, cls, delay = 0.35, dur = 1.5, frames = 18, anchor = 'start', extra = '' }) {
  const steps = [];
  for (let i = 0; i < frames; i++) {
    const tt = i / (frames - 1);
    const e = 1 - Math.pow(1 - tt, 3);
    const v = i === frames - 1 ? value : Math.floor(value * e);
    if (!steps.length || steps[steps.length - 1].v !== v) steps.push({ v, at: delay + (dur * i) / frames });
  }
  const end = delay + dur;
  return steps
    .map((s, i) => {
      const last = i === steps.length - 1;
      const d = last ? (s.at).toFixed(2) : s.at.toFixed(2);
      const len = last ? 0.01 : ((steps[i + 1].at - s.at)).toFixed(2);
      return `<text class="${cls} fr${last ? ' last' : ''}" x="${x}" y="${y}" text-anchor="${anchor}"${extra} style="animation-duration:${len}s;animation-delay:${d}s">${fmt(s.v)}</text>`;
    })
    .join('');
}

/* ------------------------------------------------------------- overview */

const ICONS = {
  star: '<path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z" stroke-linejoin="round"/>',
  repo: '<path d="M6 4.5A1.5 1.5 0 0 1 7.5 3H19v14H7.5A1.5 1.5 0 0 0 6 18.5z"/><path d="M6 18.5A1.5 1.5 0 0 0 7.5 20H19v-3"/><path d="M10 7.5h5"/>',
  users: '<circle cx="12" cy="8.2" r="3.5"/><path d="M5 20c0-3.9 3.1-6 7-6s7 2.100 7 6"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.500"/><path d="M4 10.500h16M8.500 3.500v4M15.500 3.500v4"/><path d="M8 14.500l2.500 2.200L16 12.500"/>',
  inf: '<path d="M12 12c-1.800-2.600-3.200-4-5.200-4a4 4 0 1 0 0 8c2 0 3.400-1.400 5.200-4s3.200-4 5.200-4a4 4 0 1 1 0 8c-2 0-3.400-1.400-5.200-4z" stroke-linejoin="round"/>',
  pr: '<circle cx="6" cy="5.500" r="2.200"/><circle cx="6" cy="18.500" r="2.200"/><circle cx="18" cy="18.500" r="2.200"/><path d="M6 7.700v8.600M18 16.300V10a3 3 0 0 0-3-3h-3.500"/><path d="M13.800 4.800L11.500 7l2.300 2.200"/>',
  flame: '<path d="M12 21c3.700 0 6-2.500 6-5.800 0-2.400-1.300-4-2.600-5.400-.5 1.400-1.200 2-2 2.200.4-2.800-.6-5.600-3.200-8-.2 3-1.700 4.600-3 6.200C5.900 11.700 6 13.500 6 15.200 6 18.500 8.300 21 12 21z" stroke-linejoin="round"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z" stroke-linejoin="round"/><path d="M8 6H5v1.500A3 3 0 0 0 8 10.500M16 6h3v1.500a3 3 0 0 1-3 3"/><path d="M12 13v4M8.500 20h7M9.500 17h5"/>',
  pulse: '<path d="M3 12h4l2.500-6 4 12 2.500-6H21" stroke-linejoin="round"/>',
};
function icon(name, x, y, size, color) {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${r2(s)})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

function overviewSvg(s, updated) {
  const tiles = [
    { icon: 'star', c: '#fbbf24', v: s.stars, label: 'Stars earned' },
    { icon: 'repo', c: '#38bdf8', v: s.repoCount, label: 'Original repos' },
    { icon: 'users', c: '#a78bfa', v: s.followers, label: 'Followers' },
    { icon: 'cal', c: '#34d399', v: s.yearTotal, label: `Contributions in ${s.thisYear}` },
    { icon: 'inf', c: '#3b82f6', v: s.allTime, label: 'All-time contributions' },
    { icon: 'pr', c: '#c4b5fd', v: s.allPRs, label: 'Pull requests' },
  ];
  const W = 252, H = 74, GAP = 12, X0 = 30, Y0 = 56;
  let body = header('GitHub overview', `@${s.login}`, updated);
  tiles.forEach((tl, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = X0 + col * (W + GAP), y = Y0 + row * (H + 10);
    const delay = 0.15 + i * 0.1;
    body += `<g class="rise" style="animation-delay:${delay.toFixed(2)}s">
<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="12" fill="rgba(15,23,42,.62)" stroke="rgba(148,163,184,.16)"/>
<rect x="${x + 0.5}" y="${y + 0.5}" width="${W - 1}" height="26" rx="11.5" fill="url(#tileTop)"/>
<circle cx="${x + 36}" cy="${y + H / 2}" r="20" fill="${tl.c}" opacity=".12"/>
<circle cx="${x + 36}" cy="${y + H / 2}" r="20" fill="none" stroke="${tl.c}" stroke-opacity=".35"/>
${icon(tl.icon, x + 24, y + H / 2 - 12, 24, tl.c)}
${countUp({ x: x + 68, y: y + 40, value: tl.v, cls: 'num big', delay: delay + 0.2 })}
<text class="lbl" x="${x + 68}" y="${y + 60}">${esc(tl.label)}</text>
</g>`;
  });
  return shell({
    w: 840, h: 240,
    title: `GitHub overview for ${s.login}`,
    desc: `${s.stars} stars, ${s.repoCount} original public repositories, ${s.followers} followers, ${s.yearTotal} contributions in ${s.thisYear}, ${s.allTime} contributions all-time and ${s.allPRs} pull requests.`,
    defs: `<linearGradient id="tileTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2e8f0" stop-opacity=".06"/><stop offset="1" stop-color="#e2e8f0" stop-opacity="0"/></linearGradient>`,
    css: `.big{font-size:28px}`,
    body,
  });
}

/* ------------------------------------------------------------ languages */

function languagesSvg(s, updated) {
  const { items } = topLanguages(s.langs);
  const BAR_X = 30, BAR_W = 780, BAR_Y = 60, BAR_H = 14, GAP = 2;
  let body = header('Top languages', `${s.repoCount} original repos`, updated);
  // stacked bar
  const usable = BAR_W - GAP * (items.length - 1);
  let cx = BAR_X;
  let segs = '';
  items.forEach((l, i) => {
    const w = Math.max(3, (l.pct / 100) * usable);
    segs += `<rect class="seg" x="${r2(cx)}" y="${BAR_Y}" width="${r2(w)}" height="${BAR_H}" fill="${l.color}" style="animation-delay:${(0.2 + i * 0.12).toFixed(2)}s"/>`;
    cx += w + GAP;
  });
  body += `<rect x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="7" fill="rgba(148,163,184,.10)"/>
<g clip-path="url(#barclip)">${segs}<rect class="scan sweep" x="${BAR_X - 80}" y="${BAR_Y}" width="80" height="${BAR_H}" fill="url(#sweepG)"/></g>`;
  // legend
  const COLS = 3, CW = 260, ROWH = 46, LX = 30, LY = 100;
  const max = Math.max(...items.map((l) => l.pct), 1);
  items.forEach((l, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = LX + col * CW, y = LY + row * ROWH;
    const barW = CW - 28;
    body += `<g class="rise" style="animation-delay:${(0.3 + i * 0.07).toFixed(2)}s">
<circle cx="${x + 5}" cy="${y + 4}" r="4.5" fill="${l.color}"/>
<text x="${x + 18}" y="${y + 8.500}" font-size="14" font-weight="600" fill="#e2e8f0">${esc(l.name)}</text>
<text class="mono" x="${x + barW}" y="${y + 8.500}" font-size="13" fill="#94a3b8" text-anchor="end">${l.pct.toFixed(1)}%</text>
<rect x="${x}" y="${y + 17}" width="${barW}" height="4" rx="2" fill="rgba(148,163,184,.12)"/>
<rect class="seg" x="${x}" y="${y + 17}" width="${r2(Math.max(3, (l.pct / max) * barW))}" height="4" rx="2" fill="${l.color}" style="animation-delay:${(0.5 + i * 0.1).toFixed(2)}s"/>
</g>`;
  });
  return shell({
    w: 840, h: 240,
    title: `Top languages for ${s.login}`,
    desc: 'Share of bytes by language across original public repositories: ' + items.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ') + '.',
    defs: `<clipPath id="barclip"><rect x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="7"/></clipPath>
<linearGradient id="sweepG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    css: `.seg{transform-box:fill-box;transform-origin:left center;animation:grow 1.1s cubic-bezier(.2,.8,.2,1) backwards}
@keyframes grow{from{transform:scaleX(0)}}
.sweep{animation:sweepx 8s ease-in-out 2s infinite}
@keyframes sweepx{0%{transform:translateX(0)}30%,100%{transform:translateX(${BAR_W + 160}px)}}`,
    body,
  });
}

/* ------------------------------------------------------------- activity */

const RAMP = ['#16213f', '#1e3a8a', '#2563eb', '#38bdf8', '#c4b5fd'];

function levelFor(count, q) {
  if (count <= 0) return 0;
  return count <= q[0] ? 1 : count <= q[1] ? 2 : count <= q[2] ? 3 : 4;
}
function quartiles(counts) {
  const v = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (!v.length) return [1, 2, 3];
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return [at(0.25), at(0.5), at(0.75)];
}

function activitySvg(s, updated) {
  const weeks = s.weeks.slice(-53);
  const PITCH = 14, CELL = 11, GX = 62, GY = 84;
  const gridW = weeks.length * PITCH - (PITCH - CELL);
  const quart = quartiles(weeks.flat().map((d) => d.contributionCount));
  let cells = '';
  const delays = new Set();
  weeks.forEach((wk, ci) => {
    wk.forEach((d) => {
      const row = new Date(d.date + 'T00:00:00Z').getUTCDay();
      const lv = levelFor(d.contributionCount, quart);
      const dn = ci * 3 + row; // diagonal wave index
      delays.add(dn);
      cells += `<rect class="c l${lv} d${dn}" x="${GX + ci * PITCH}" y="${GY + row * PITCH}" width="${CELL}" height="${CELL}" rx="3"/>`;
    });
  });
  const cssDelays = [...delays].sort((a, b) => a - b).map((n) => `.d${n}{animation-delay:${(0.2 + n * 0.0135).toFixed(3)}s}`).join('');
  // month labels
  let months = '';
  let lastM = -1, lastX = -100;
  weeks.forEach((wk, ci) => {
    const m = Number(wk[0].date.slice(5, 7)) - 1;
    if (m !== lastM) {
      const x = GX + ci * PITCH;
      if (x - lastX >= 30 && ci <= weeks.length - 3) {
        months += `<text class="mut" x="${x}" y="${GY - 9}">${MONTHS[m]}</text>`;
        lastX = x;
      }
      lastM = m;
    }
  });
  const dayLabels = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]
    .map(([r, n]) => `<text class="mut" x="${GX - 10}" y="${GY + r * PITCH + 9.500}" text-anchor="end">${n}</text>`)
    .join('');
  // stats
  const all = weeks.flat();
  const active = all.filter((d) => d.contributionCount > 0).length;
  const best = all.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), all[0]);
  const total = all.reduce((a, d) => a + d.contributionCount, 0);
  const gridBottom = GY + 7 * PITCH - (PITCH - CELL);
  const footY = gridBottom + 36;
  const legendX = GX + gridW - (5 * 16 + 70);
  let legend = `<text class="mut" x="${legendX}" y="${footY - 0.5}" text-anchor="end">Less</text>`;
  RAMP.forEach((c, i) => {
    legend += `<rect x="${legendX + 8 + i * 16}" y="${footY - 10}" width="${CELL}" height="${CELL}" rx="3" fill="${c}"/>`;
  });
  legend += `<text class="mut" x="${legendX + 8 + 5 * 16 + 4}" y="${footY - 0.5}">More</text>`;

  let body = header('Contribution activity', 'last 12 months', updated);
  body += `<g class="rise" style="animation-delay:.1s">${months}${dayLabels}</g>
<g clip-path="url(#gridclip)">${cells}</g>
<g class="scan scanline" style="animation-delay:.2s">
<rect x="${GX - 14}" y="${GY - 8}" width="28" height="${7 * PITCH + 10}" fill="url(#scanG)"/>
<rect x="${GX - 0.75}" y="${GY - 8}" width="1.5" height="${7 * PITCH + 10}" fill="#bae6fd" opacity=".95"/>
</g>
<g class="rise" style="animation-delay:.9s">
<text class="num" x="${GX}" y="${footY + 1}" font-size="22">${fmt(total)}</text>
<text class="lbl" x="${GX + fmt(total).length * 12.6 + 8}" y="${footY}">contributions · ${active} active days · best day ${best.contributionCount} (${fmtDate(best.date, false)})</text>
${legend}
</g>`;
  return shell({
    w: 840, h: 260,
    title: `Contribution activity for ${s.login}`,
    desc: `${total} contributions over the last 12 months across ${active} active days; busiest day had ${best.contributionCount} on ${best.date}.`,
    defs: `<clipPath id="gridclip"><rect x="${GX - 2}" y="${GY - 2}" width="${gridW + 4}" height="${7 * PITCH + 2}"/></clipPath>
<linearGradient id="scanG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#38bdf8" stop-opacity="0"/><stop offset="1" stop-color="#38bdf8" stop-opacity=".38"/></linearGradient>`,
    css: `.c{animation:pop .55s cubic-bezier(.2,.9,.3,1.2) backwards;transform-box:fill-box;transform-origin:center}
@keyframes pop{from{opacity:0;transform:scale(.3)}}
.l0{fill:${RAMP[0]}}.l1{fill:${RAMP[1]}}.l2{fill:${RAMP[2]}}.l3{fill:${RAMP[3]}}.l4{fill:${RAMP[4]}}
.l3,.l4{filter:drop-shadow(0 0 2.500px rgba(56,189,248,.45))}
.l4{filter:drop-shadow(0 0 3px rgba(167,139,250,.7))}
${cssDelays}
.scanline{animation:scanx 9s cubic-bezier(.45,.05,.55,.95) infinite}
@keyframes scanx{0%{transform:translateX(0);opacity:0}2%{opacity:1}22%{transform:translateX(${gridW}px);opacity:1}25%,100%{transform:translateX(${gridW}px);opacity:0}}`,
    body,
  });
}

/* --------------------------------------------------------------- streak */

function streakSvg(s, st, updated) {
  const { current, longest } = st;
  const RX = 108, RY = 112, R = 46, CIRC = 2 * Math.PI * R;
  const frac = longest.len > 0 ? Math.min(1, current.len / longest.len) : 0;
  const cx = (n) => n;
  let body = header('Contribution streak', `@${s.login}`, updated);
  // dividers
  body += `<path d="M340 66V164M600 66V164" stroke="rgba(148,163,184,.16)" stroke-width="1"/>`;
  // ring
  body += `<g class="rise" style="animation-delay:.1s">
<circle cx="${RX}" cy="${RY}" r="${R + 14}" fill="none" stroke="rgba(148,163,184,.08)" stroke-dasharray="2 6"/>
<circle cx="${RX}" cy="${RY}" r="${R}" fill="none" stroke="rgba(148,163,184,.14)" stroke-width="9"/>
<g transform="rotate(-90 ${RX} ${RY})">
<circle class="ringglow" cx="${RX}" cy="${RY}" r="${R}" fill="none" stroke="url(#sig)" stroke-width="9" stroke-linecap="round" pathLength="100" stroke-dasharray="${r2(frac * 100)} 100" filter="url(#glow)" opacity=".7"/>
<circle class="ring" cx="${RX}" cy="${RY}" r="${R}" fill="none" stroke="url(#sig)" stroke-width="9" stroke-linecap="round" pathLength="100" stroke-dasharray="${r2(frac * 100)} 100"/>
</g>
<g class="orbit" style="transform-origin:${RX}px ${RY}px"><circle cx="${RX}" cy="${RY - R - 14}" r="2.600" fill="#a78bfa"/></g>
${icon('flame', RX - 8, RY - 36, 16, '#fbbf24')}
${countUp({ x: RX, y: RY + 10, value: current.len, cls: 'num', anchor: 'middle', extra: ' font-size="30"', delay: 0.5, dur: 1.4 })}
<text class="lbl" x="${RX}" y="${RY + 28}" text-anchor="middle" font-size="11">${current.len === 1 ? 'day' : 'days'}</text>
</g>`;
  const curDates = current.len > 0 ? fmtRange(current.start, current.end) : 'No active streak — contribute today';
  body += `<g class="rise" style="animation-delay:.25s">
<text class="mut" x="180" y="${RY - 22}" letter-spacing="1.500" font-size="11" font-weight="700">CURRENT STREAK</text>
<text x="180" y="${RY + 2}" font-size="20" font-weight="800" fill="#e2e8f0">${fmt(current.len)} ${current.len === 1 ? 'day' : 'days'}</text>
<text class="sub" x="180" y="${RY + 22}">${esc(curDates)}</text>
</g>`;
  // longest
  body += `<g class="rise" style="animation-delay:.4s">
${icon('trophy', 372, 58, 20, '#fbbf24')}
<text class="mut" x="400" y="73" letter-spacing="1.500" font-size="11" font-weight="700">LONGEST STREAK</text>
${countUp({ x: 372, y: 128, value: longest.len, cls: 'num', extra: ' font-size="40"', delay: 0.7 })}
<text class="lbl" x="${372 + fmt(longest.len).length * 22 + 8}" y="128" font-size="14">${longest.len === 1 ? 'day' : 'days'}</text>
<text class="sub" x="372" y="154">${esc(longest.len ? fmtRange(longest.start, longest.end) : '—')}</text>
</g>`;
  // total
  const since = s.createdAt.slice(0, 10);
  body += `<g class="rise" style="animation-delay:.55s">
${icon('pulse', 632, 58, 20, '#38bdf8')}
<text class="mut" x="660" y="73" letter-spacing="1.500" font-size="11" font-weight="700">ALL-TIME TOTAL</text>
${countUp({ x: 632, y: 128, value: s.allTime, cls: 'num', extra: ' font-size="40"', delay: 0.9, dur: 1.6 })}
<text class="sub" x="632" y="154">${esc(`since ${fmtDate(since)}`)}</text>
</g>`;
  return shell({
    w: 840, h: 200,
    title: `Contribution streak for ${s.login}`,
    desc: `Current streak ${current.len} days${current.len ? ' (' + fmtRange(current.start, current.end) + ')' : ''}; longest streak ${longest.len} days${longest.len ? ' (' + fmtRange(longest.start, longest.end) + ')' : ''}; ${s.allTime} total contributions.`,
    css: `.ring,.ringglow{animation:ringfill 1.8s cubic-bezier(.3,.7,.2,1) .3s backwards}
@keyframes ringfill{from{stroke-dasharray:0 100}}
.orbit{animation:spin 10s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}`,
    body,
  });
}

/* ---------------------------------------------------------------- output */

function writeIfChanged(name, build) {
  const file = join(OUT_DIR, name);
  const fresh = build(DATE_TOKEN);
  if (existsSync(file)) {
    const old = readFileSync(file, 'utf8');
    const norm = old.replace(/updated \d{4}-\d{2}-\d{2}/g, 'updated ' + DATE_TOKEN);
    if (norm === fresh) return { name, changed: false, bytes: old.length };
  }
  const today = new Date().toISOString().slice(0, 10);
  const out = fresh.split(DATE_TOKEN).join(today);
  return { name, changed: true, bytes: out.length, out, file };
}

async function main() {
  if (!TOKEN) {
    console.error('GITHUB_TOKEN (or GH_TOKEN) is required');
    process.exit(1);
  }
  const s = await collect();
  const streaks = computeStreaks(s.days);
  const langs = topLanguages(s.langs);

  console.log(
    JSON.stringify(
      {
        user: s.login, stars: s.stars, forks: s.forks, originalRepos: s.repoCount, followers: s.followers,
        contributionsThisYear: s.yearTotal, contributionsAllTime: s.allTime, rolling12mo: s.rollingTotal,
        prsAllTime: s.allPRs, issuesAllTime: s.allIssues,
        currentStreak: streaks.current, longestStreak: streaks.longest,
        languages: langs.items.map((l) => `${l.name} ${l.pct.toFixed(1)}%`),
      },
      null, 2,
    ),
  );

  const results = [
    writeIfChanged('overview.svg', (d) => overviewSvg(s, d)),
    writeIfChanged('languages.svg', (d) => languagesSvg(s, d)),
    writeIfChanged('activity.svg', (d) => activitySvg(s, d)),
    writeIfChanged('streak.svg', (d) => streakSvg(s, streaks, d)),
  ];
  // sanity: never publish something GitHub would strip, or an oversized file
  for (const r of results) {
    if (!r.out) continue;
    if (/<script|foreignObject|href="http/i.test(r.out)) throw new Error(`${r.name}: forbidden content`);
    if (r.out.length > 120 * 1024) throw new Error(`${r.name}: too large (${r.out.length})`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const r of results) {
    if (r.changed) writeFileSync(r.file, r.out);
    console.log(`${r.changed ? 'wrote    ' : 'unchanged'} assets/stats/${r.name} (${r.bytes} bytes)`);
  }
}

main().catch((e) => {
  console.error('gen-stats failed:', e && e.message ? e.message : e);
  process.exit(1);
});
