// Grounded ReviewBench scoring of one findings pool with the benchmark's own matcher and scorer.
//
// Run it from a clone of review-bench/ReviewBench (after "npm ci" there) so its dependencies resolve:
//
//   PI_CODING_AGENT_DIR=<dir with models.json> npx tsx <this repo>/evals/reviewbench/judge.ts \
//     --bench . --pool <pool dir> --provider claude-cli --model claude-sonnet-5 [--concurrency 3]
//
// It writes <pool>/scores.json (grounded metrics) and <pool>/scores.details.json (which golden
// findings each candidate matched). Matcher decisions are cached per pull request.
//
// ReviewBench also classifies unmatched findings with a tool-calling judge to report "augmented"
// metrics. That step is skipped here: unmatched findings get a placeholder label, which changes
// augmented numbers only. Grounded precision and recall depend only on the matcher and the golden
// labels, and the leaderboard ranks by grounded F1.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const opts: Record<string, string> = { concurrency: "3", bench: "." };
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!opts.pool || !opts.provider || !opts.model) throw new Error("usage: judge.ts --bench <dir> --pool <dir> --provider <name> --model <id>");
const bench = resolve(opts.bench);
const pool = resolve(opts.pool);
const { dedup } = await import(bench + "/scripts/golden/pipeline.ts");
const { resolveForScoring } = await import(bench + "/scripts/lib/match-types.ts");
const { scorePR, aggregate } = await import(bench + "/scripts/eval/scorer.ts");
const { loadCandidateFindings } = await import(bench + "/scripts/eval/input-validation.ts");

const { byPR, stats } = loadCandidateFindings(pool + "/findings");
if (stats.skipped_files.length) throw new Error("skipped candidate files: " + JSON.stringify(stats.skipped_files.slice(0, 3)));
const cacheDir = resolve(opts.cache ?? pool + "/judge-cache");
mkdirSync(cacheDir, { recursive: true });

const keys = [...byPR.keys()].sort();
const results: any[] = [];
const details: Record<string, any> = {};
let next = 0;
let calls = 0;
async function worker() {
  while (next < keys.length) {
    const key = keys[next++];
    const candidate = byPR.get(key)!;
    const goldenText = readFileSync(bench + "/golden/" + key + ".json", "utf8");
    const golden = JSON.parse(goldenText);
    const hash = createHash("sha256").update(opts.provider + "|" + opts.model + "|" + goldenText + "|" + JSON.stringify(candidate.findings)).digest("hex").slice(0, 32);
    const cachePath = cacheDir + "/" + key + "-" + hash + ".json";
    let correspondences;
    if (existsSync(cachePath)) correspondences = JSON.parse(readFileSync(cachePath, "utf8"));
    else {
      const pipeline = await dedup(candidate.findings, golden, { matcher: { provider: opts.provider, modelId: opts.model } });
      correspondences = pipeline.correspondences;
      calls += pipeline.matcher_stats?.llm_calls ?? 0;
      writeFileSync(cachePath, JSON.stringify(correspondences));
    }
    const scoring = resolveForScoring(correspondences, golden.findings.length);
    const placeholder = new Map([...scoring.unmatched].map((i: number) => [i, { ...candidate.findings[i], tp_fp: "fp", severity: "low", category: "unclassified" }]));
    results.push(scorePR({
      pr_key: key,
      golden: golden.findings.map((g: any) => ({ file: g.file, start_line: g.start_line, end_line: g.end_line, message: g.message, tp_fp: g.tp_fp, severity: g.severity, category: g.category })),
      candidate_count: candidate.findings.length,
      matched: scoring.matchedToGolden,
      unmatched: scoring.unmatched,
      covered_golden: scoring.coveredGolden,
      unmatched_classifications: placeholder,
    }));
    details[key] = {
      candidates: candidate.findings.length,
      correspondences,
      golden: golden.findings.map((g: any) => ({ tp_fp: g.tp_fp, severity: g.severity, category: g.category })),
    };
    console.log(key + ": " + candidate.findings.length + " findings, covered " + scoring.coveredGolden.size + " of " + golden.findings.length + " golden");
  }
}
await Promise.all(Array.from({ length: Number(opts.concurrency) }, worker));
const agg = aggregate(results);
const f1 = (m: any) => (m.grounded_precision && m.grounded_recall ? (2 * m.grounded_precision * m.grounded_recall) / (m.grounded_precision + m.grounded_recall) : 0);
const row = (name: string, m: any) => name + " grounded P " + (100 * (m.grounded_precision ?? 0)).toFixed(1) + " R " + (100 * (m.grounded_recall ?? 0)).toFixed(1) + " F1 " + (100 * f1(m)).toFixed(1);
console.log("PRs " + agg.pr_count + ", matcher calls " + calls);
console.log(row("micro", agg.micro.overall));
console.log(row("macro", agg.macro.overall));
writeFileSync(pool + "/scores.json", JSON.stringify({ judge: opts.provider + "/" + opts.model, pr_count: agg.pr_count, micro: agg.micro, macro: agg.macro, per_pr: agg.per_pr }, null, 1));
writeFileSync(pool + "/scores.details.json", JSON.stringify(details));
