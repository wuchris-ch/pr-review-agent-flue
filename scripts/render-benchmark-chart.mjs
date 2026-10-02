#!/usr/bin/env node
// Renders docs/assets/benchmark.svg from the committed Martian score reports.
// Usage: node scripts/render-benchmark-chart.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const results = new URL('../evals/martian/results/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, results), 'utf8'));

const subset = 'heldout/core';
const excluded = new Set(read('judge-agreement.json').excluded_tools);
const published = read('published-tools-report.json').scores[subset];
const ours = read('heldout-final-report.json').scores[subset];

const names = {
  'qodo-extended-v2': 'Qodo (extended)',
  augment: 'Augment',
  'qodo-v2': 'Qodo',
  bugbot: 'Cursor Bugbot',
  gitlab: 'GitLab Duo',
  'gemini-v2': 'Gemini',
  devin: 'Devin',
  'copilot-v2': 'GitHub Copilot (v2)',
  'greptile-v4-1': 'Greptile v4.1',
  macroscope: 'Macroscope',
  copilot: 'GitHub Copilot',
  claude: 'Claude',
  coderabbit: 'CodeRabbit',
  baz: 'Baz',
  'codeant-v2': 'CodeAnt',
  kg: 'KG',
  graphite: 'Graphite',
};

// Label placement for the tools that are named on the chart: [dx, dy, anchor].
const labels = {
  'qodo-extended-v2': [10, 17, 'start'],
  augment: [10, 14, 'start'],
  bugbot: [-10, -8, 'end'],
  devin: [-10, -6, 'end'],
  'copilot-v2': [-10, -9, 'end'],
  coderabbit: [10, 14, 'start'],
  kg: [10, 4, 'start'],
  graphite: [10, 4, 'start'],
};

const tools = Object.entries(published)
  .filter(([id]) => !excluded.has(id))
  .map(([id, s]) => {
    if (!names[id]) throw new Error(`No display name for ${id}`);
    return { id, name: names[id], p: s.precision, r: s.recall };
  });
if (tools.length !== 17) throw new Error(`Expected 17 comparable tools, found ${tools.length}`);

const final = ours['pr-review-agent (final)'];
const baseline = ours['pr-review-agent (baseline)'];

const W = 880;
const H = 540;
const m = { top: 28, right: 28, bottom: 64, left: 72 };
const pw = W - m.left - m.right;
const ph = H - m.top - m.bottom;
const xMax = 0.75;
const yMax = 0.85;
const x = (r) => m.left + (r / xMax) * pw;
const y = (p) => m.top + ph - (p / yMax) * ph;
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const f = (n) => n.toFixed(1);

const ink = '#22382f';
const muted = '#6b7a72';
const grid = '#e3e2db';
const tool = '#a7b2ac';
const accent = '#2f6b4f';

const out = [];
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`,
  '<title id="title">Precision and recall on 30 held-out PRs</title>',
  `<desc id="desc">This reviewer at ${pct(final.precision)} precision and ${pct(final.recall)} recall, up from ${pct(baseline.recall)} recall at baseline, compared with 17 commercial reviewers scored by the same judge.</desc>`,
  `<rect width="${W}" height="${H}" fill="#fbfaf7"/>`,
  `<g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif" font-size="12" fill="${muted}">`,
);

for (let t = 0; t <= 0.8001; t += 0.2) {
  out.push(
    `<line x1="${m.left}" x2="${W - m.right}" y1="${f(y(t))}" y2="${f(y(t))}" stroke="${grid}"/>`,
  );
  out.push(
    `<text x="${m.left - 10}" y="${f(y(t) + 4)}" text-anchor="end">${Math.round(t * 100)}%</text>`,
  );
}
for (let t = 0; t <= 0.7001; t += 0.1) {
  out.push(
    `<line x1="${f(x(t))}" x2="${f(x(t))}" y1="${m.top}" y2="${H - m.bottom}" stroke="${grid}"/>`,
  );
  out.push(
    `<text x="${f(x(t))}" y="${H - m.bottom + 20}" text-anchor="middle">${Math.round(t * 100)}%</text>`,
  );
}

// Curves of equal F1: precision = F * r / (2r - F).
for (const F of [0.2, 0.3, 0.4, 0.5, 0.6]) {
  const pts = [];
  for (let r = F / 2 + 0.002; r <= xMax; r += 0.004) {
    const p = (F * r) / (2 * r - F);
    if (p <= yMax) pts.push(`${f(x(r))},${f(y(p))}`);
  }
  out.push(
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#cfd5d0" stroke-dasharray="4 5"/>`,
  );
  // Label each curve where it enters the top of the plot.
  const top = (F * yMax) / (2 * yMax - F);
  out.push(
    `<text x="${f(x(top) + 6)}" y="${m.top + 12}" font-size="11" fill="#9aa59f">F1 ${Math.round(F * 100)}%</text>`,
  );
}

out.push(
  `<text x="${m.left + pw / 2}" y="${H - 18}" text-anchor="middle" fill="${ink}">Recall: share of human-verified issues found</text>`,
);
out.push(
  `<text transform="translate(20 ${m.top + ph / 2}) rotate(-90)" text-anchor="middle" fill="${ink}">Precision: share of comments that were real issues</text>`,
);

for (const t of tools) {
  out.push(
    `<circle cx="${f(x(t.r))}" cy="${f(y(t.p))}" r="5.5" fill="${tool}"><title>${t.name}: ${pct(t.p)} precision, ${pct(t.r)} recall</title></circle>`,
  );
  const l = labels[t.id];
  if (l)
    out.push(
      `<text x="${f(x(t.r) + l[0])}" y="${f(y(t.p) + l[1])}" text-anchor="${l[2]}">${t.name}</text>`,
    );
}

const bx = x(baseline.recall);
const by = y(baseline.precision);
const fx = x(final.recall);
const fy = y(final.precision);
out.push(
  `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${accent}"/></marker></defs>`,
);
out.push(
  `<line x1="${f(bx + 7)}" y1="${f(by + 1)}" x2="${f(fx - 10)}" y2="${f(fy - 1)}" stroke="${accent}" stroke-width="2" marker-end="url(#arrow)"/>`,
);
out.push(
  `<circle cx="${f(bx)}" cy="${f(by)}" r="6" fill="#fbfaf7" stroke="${accent}" stroke-width="2"><title>Baseline: ${pct(baseline.precision)} precision, ${pct(baseline.recall)} recall</title></circle>`,
);
out.push(
  `<circle cx="${f(fx)}" cy="${f(fy)}" r="7.5" fill="${accent}"><title>This reviewer: ${pct(final.precision)} precision, ${pct(final.recall)} recall</title></circle>`,
);
out.push(
  `<text x="${f(fx - 2)}" y="${f(fy + 26)}" text-anchor="middle" font-size="13" font-weight="600" fill="${accent}">This reviewer</text>`,
);
out.push(
  `<text x="${f(fx - 2)}" y="${f(fy + 42)}" text-anchor="middle" font-size="11" fill="${accent}">${pct(final.precision)} precision, ${pct(final.recall)} recall</text>`,
);
out.push(
  `<text x="${f(bx - 12)}" y="${f(by - 12)}" text-anchor="end" font-size="11" fill="${accent}">baseline</text>`,
);

// Legend in the empty upper-right corner.
const lx = W - m.right - 190;
const ly = m.top + 14;
out.push(
  `<rect x="${lx - 14}" y="${ly - 14}" width="190" height="76" rx="6" fill="#fbfaf7" stroke="${grid}"/>`,
  `<circle cx="${lx}" cy="${ly}" r="5.5" fill="${tool}"/><text x="${lx + 14}" y="${ly + 4}">Commercial reviewer (${tools.length})</text>`,
  `<circle cx="${lx}" cy="${ly + 24}" r="6.5" fill="${accent}"/><text x="${lx + 14}" y="${ly + 28}">This reviewer, final</text>`,
  `<circle cx="${lx}" cy="${ly + 48}" r="5.5" fill="#fbfaf7" stroke="${accent}" stroke-width="2"/><text x="${lx + 14}" y="${ly + 52}">This reviewer, baseline</text>`,
);

out.push('</g>', '</svg>', '');
writeFileSync(new URL('../docs/assets/benchmark.svg', import.meta.url), out.join('\n'));
console.log(`Wrote docs/assets/benchmark.svg from ${subset} (${tools.length} tools)`);
