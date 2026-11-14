#!/usr/bin/env node
// Renders docs/assets/reviewbench.svg: this reviewer's offline ReviewBench scores beside the
// configurations the public leaderboard lists, in two of the leaderboard's severity views.
// Usage: node scripts/render-reviewbench-chart.mjs [results file]
import { readFileSync, writeFileSync } from 'node:fs';

const results = new URL('../evals/reviewbench/results/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, results), 'utf8'));
const board = read('leaderboard-2026-11-13.json');
const ours = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : read('full-run.json');

const names = {
  ohmybug: 'OhMyBug',
  'intent-review-agent': 'intent-review-agent',
  'copilot-code-review-high': 'Copilot code review, Max',
  'laude-revengine-prime-anthropic-claude-opus-5-5': 'Laude RevEngine, Opus 5.5',
  'copilot-code-review-medium': 'Copilot code review, Balanced',
  'codex-gpt-5-6-sol-max': 'Codex, GPT-5.6 Sol Max',
  'codex-gpt-5-6-sol-ultra': 'Codex, GPT-5.6 Sol Ultra',
  'klaussy-claude-opus-5-5-1': 'Klaussy, Opus 5.5',
  qodo: 'Qodo',
  'block-review-sol-opus-off': 'block/review',
  'heydeer-deep-detailed': 'HeyDeer',
  'codex-gpt-5-6-sol-xhigh': 'Codex, GPT-5.6 Sol xHigh',
  'copilot-code-review-low': 'Copilot code review, Lite',
  'devin-ai': 'Devin',
  'diffox-ultra': 'diffox ultra',
  'deepseek-harness-reviewer-deepseek-flash-high-2400': 'DeepSeek Harness Reviewer',
  'opswiki-opswiki-hybrid-review-v2-deepseek-v4-flash': 'opswiki',
  'klaussy-claude-sonnet-5-5-1': 'Klaussy, Sonnet 5.5 (1)',
  cursor: 'Cursor',
  'klaussy-claude-sonnet-5-5-default': 'Klaussy, Sonnet 5.5',
  diffox: 'diffox',
  cubic: 'Cubic',
  greptile: 'Greptile',
};

// This reviewer's two configurations: [key in the results file, name on the chart].
const own = [
  ['default', 'PR Review, one pass'],
  ['thorough', 'PR Review, two passes'],
];
const score = (id, view) => ours.configurations[id].all[view].f1;
const rows = (view) =>
  [
    ...board.listed.map((entry) => {
      if (!names[entry.id]) throw new Error(`No display name for ${entry.id}`);
      return { name: names[entry.id], f1: entry[view].f1, own: false };
    }),
    ...own.map(([id, name]) => ({ name, f1: score(id, view), own: true })),
  ].sort((a, b) => b.f1 - a.f1);
// Place of one configuration among the listed ones: 1 is the highest F1.
const place = (id, view) =>
  1 + board.listed.filter((entry) => entry[view].f1 > score(id, view)).length;

const panels = [
  { view: 'all', title: 'All severities' },
  { view: 'high', title: 'High severity only (the leaderboard’s default view)' },
];
const count = board.listed.length + own.length;

const W = 880;
const rowH = 18;
const top = 62;
const H = top + count * rowH + 74;
const gutter = 24;
const panelW = (W - 3 * gutter) / 2;
const labelW = 178;
const valueW = 44;
const barW = panelW - labelW - valueW;
const scale = 0.9;
const f = (n) => n.toFixed(1);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const ink = '#22382f';
const muted = '#6b7a72';
const grid = '#e3e2db';
const tool = '#a7b2ac';
const accent = '#2f6b4f';

const out = [];
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`,
  '<title id="title">ReviewBench grounded F1, scored offline, beside the public leaderboard</title>',
  `<desc id="desc">With two passes PR Review scores ${pct(score('thorough', 'all'))} grounded F1 on all severities and ${pct(score('thorough', 'high'))} on high severity, scored offline on all ${ours.pull_requests} pull requests. Placed among the ${board.listed.length} configurations the leaderboard lists, that is number ${place('thorough', 'all')} and number ${place('thorough', 'high')} of ${board.listed.length + 1}. With one pass it scores ${pct(score('default', 'all'))} and ${pct(score('default', 'high'))}.</desc>`,
  `<rect width="${W}" height="${H}" fill="#fbfaf7"/>`,
  `<g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif" font-size="11.5" fill="${muted}">`,
);

panels.forEach((panel, index) => {
  const px = gutter + index * (panelW + gutter);
  const bx = px + labelW;
  const bottom = top + count * rowH;
  out.push(
    `<text x="${f(px)}" y="30" font-size="13" font-weight="600" fill="${ink}">${panel.title}</text>`,
    `<text x="${f(px)}" y="47" font-size="11">Grounded F1, sorted from highest</text>`,
  );
  for (const tick of [0, 0.2, 0.4, 0.6, 0.8]) {
    const tx = bx + (tick / scale) * barW;
    out.push(
      `<line x1="${f(tx)}" x2="${f(tx)}" y1="${top - 4}" y2="${bottom}" stroke="${grid}"/>`,
      `<text x="${f(tx)}" y="${bottom + 14}" text-anchor="middle" font-size="10.5">${Math.round(tick * 100)}%</text>`,
    );
  }
  rows(panel.view).forEach((row, position) => {
    const y = top + position * rowH;
    const width = (row.f1 / scale) * barW;
    const weight = row.own ? ` font-weight="600" fill="${accent}"` : '';
    out.push(
      `<text x="${f(bx - 8)}" y="${y + 12.5}" text-anchor="end"${weight}>${row.name}</text>`,
      `<rect x="${f(bx)}" y="${y + 3}" width="${f(width)}" height="${rowH - 6}" rx="2" fill="${row.own ? accent : tool}"><title>${row.name}: ${pct(row.f1)}</title></rect>`,
      `<text x="${f(bx + width + 6)}" y="${y + 12.5}"${weight}>${pct(row.f1)}</text>`,
    );
  });
});

const ly = H - 34;
out.push(
  `<rect x="${gutter}" y="${ly - 9}" width="11" height="11" rx="2" fill="${tool}"/>`,
  `<text x="${gutter + 18}" y="${ly}">Official runs listed on review-bench.ai, ${board.listed.length} configurations, retrieved November 13, 2026</text>`,
  `<rect x="${gutter}" y="${ly + 9}" width="11" height="11" rx="2" fill="${accent}"/>`,
  `<text x="${gutter + 18}" y="${ly + 18}" fill="${accent}">PR Review, scored offline on the same ${ours.pull_requests} pull requests with the benchmark’s matcher and scorer, one round</text>`,
);

out.push('</g>', '</svg>', '');
writeFileSync(new URL('../docs/assets/reviewbench.svg', import.meta.url), out.join('\n'));
console.log(
  `Wrote docs/assets/reviewbench.svg: two passes are number ${place('thorough', 'all')} on all severities and number ${place('thorough', 'high')} on high severity of ${board.listed.length + 1}`,
);
