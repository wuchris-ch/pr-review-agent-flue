#!/usr/bin/env node
import { createHash } from 'node:crypto';
// Decode first model completions with each pinned reviewer's own validation rules.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [reportPath, casePath, baselineRoot, candidateRoot, outputPath] = process.argv.slice(2);
if (!outputPath)
  throw new Error(
    'usage: inspect-comparison.mjs REPORT CASES BASELINE CANDIDATE NEW_PRIVATE_OUTPUT',
  );
if (existsSync(outputPath)) throw new Error('preserve existing comparison output');
const report = JSON.parse(readFileSync(reportPath));
const cases = JSON.parse(readFileSync(casePath));
const inputs = new Map();
for (const testcase of cases) {
  const bytes = readFileSync(resolve(dirname(casePath), testcase.diff));
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    report.cases.find((item) => item.id === testcase.id)?.input_sha256
  ) {
    throw new Error('development input changed after the comparison');
  }
  inputs.set(testcase.id, bytes);
}
const baseline = await import(pathToFileURL(resolve(baselineRoot, 'dist/json.js')));
const candidate = await import(pathToFileURL(resolve(candidateRoot, 'dist/evidence.js')));
for (const record of report.records) {
  const request = record.requests.find(
    (item) => item.phase === 'initial' && item.status === 200 && item.model_output,
  );
  record.first_pass = { valid: false, output: null };
  if (!request) continue;
  try {
    if (record.variant === 'baseline')
      record.first_pass.output = baseline.extractReview(request.model_output);
    else {
      const bytes = inputs.get(record.case_id);
      const packets = candidate.evidencePackets(
        candidate.indexDiff(bytes.toString('utf8')),
        90_000,
      );
      if (packets.length !== 1)
        throw new Error('first-pass decoding requires single-partition development cases');
      record.first_pass.output = candidate.groundReview(
        request.model_output,
        packets[0],
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
    record.first_pass.valid = true;
  } catch {
    /* Preserve invalid first attempts as invalid; do not repair them here. */
  }
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
