#!/usr/bin/env python3
"""ReviewBench scores of judged findings in the leaderboard's three severity views.

judge.ts scores a findings directory with the benchmark's scorer and writes <dir>/scores.json.
This script sums the scorer's counts for each pull request over the whole benchmark and over named
subsets. It reports grounded precision, recall and F1 on all severities, on high and medium
severity and on high severity. A pull request without a findings file counts with zero findings.

    python3 evals/reviewbench/report.py --bench <ReviewBench clone> \
        --scored default=<dir> --scored thorough=<dir> \
        --subset test_set=<ReviewBench clone>/corpus/test/test.json \
        --subset fresh_sample=evals/reviewbench/fresh-sample.json \
        --answers default=<answers dir> --answers thorough=<answers dir>,<answers dir> --out results.json
"""
import argparse
import json
import statistics
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--bench", required=True, type=Path, help="clone of review-bench/ReviewBench")
parser.add_argument("--scored", action="append", required=True, metavar="LABEL=DIR", help="directory judge.ts scored")
parser.add_argument("--subset", action="append", default=[], metavar="LABEL=MANIFEST.json")
parser.add_argument("--answers", action="append", default=[], metavar="LABEL=DIR[,DIR]", help="saved answers, for the cost of a review")
parser.add_argument("--measured", help="date of the run, kept in the output")
parser.add_argument("--note", help="one line about the run, kept in the output")
parser.add_argument("--out", type=Path, help="write the aggregate numbers here (no finding text)")
args = parser.parse_args()

VIEWS = {"all": None, "high_medium": ("high", "medium"), "high": ("high",)}
COUNTS = ("matched_tp_count", "matched_count", "golden_covered_count", "golden_tp_count")


def key(entry):
    return f"{entry['nwo'].replace('/', '_')}_{entry['pr_number']}-{entry['head'][:8]}"


keys = [key(entry) for entry in json.loads((args.bench / "corpus/manifest.json").read_text())]
subsets = {"all": set(keys)}
for spec in args.subset:
    label, _, manifest = spec.partition("=")
    subsets[label] = {key(entry) for entry in json.loads(Path(manifest).read_text())} & set(keys)
if args.subset:
    subsets["rest"] = set(keys) - set().union(*(members for label, members in subsets.items() if label != "all"))

golden = {}
for name in keys:
    findings = json.loads((args.bench / "golden" / f"{name}.json").read_text())["findings"]
    golden[name] = Counter(finding["severity"] for finding in findings if finding["tp_fp"] == "tp")


def counts(metrics, name, severities):
    """The scorer's counts for one pull request in one view; zero findings when it has no scores."""
    if metrics is None:
        return [0, 0, 0, sum(n for severity, n in golden[name].items() if severities is None or severity in severities)]
    parts = [metrics["overall"]] if severities is None else [metrics["by_severity"][s] for s in severities if s in metrics["by_severity"]]
    return [sum(part[count] for part in parts) for count in COUNTS]


def view(per_pr, members, severities):
    matched_tp, matched, covered, total = (sum(column) for column in zip(*(counts(per_pr.get(name), name, severities) for name in members)))
    precision = matched_tp / matched if matched else 0.0
    recall = covered / total if total else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4), "golden_true_positives": total}


costs = {}
for spec in args.answers:
    label, _, directories = spec.partition("=")
    costs[label] = {}
    for name in keys:
        metas = [Path(directory) / f"{name}-1.meta.json" for directory in directories.split(",")]
        if all(meta.exists() for meta in metas):
            costs[label][name] = sum(json.loads(meta.read_text()).get("costUsd") or 0 for meta in metas)

report = {key: value for key, value in (("measured", args.measured), ("note", args.note)) if value}
report.update({"pull_requests": len(keys), "configurations": {}})
for spec in args.scored:
    label, _, directory = spec.partition("=")
    scores = json.loads((Path(directory) / "scores.json").read_text())
    per_pr = {row["pr_key"]: row["metrics"] for row in scores["per_pr"]}
    unknown = sorted(set(per_pr) - set(keys))
    if unknown:
        raise SystemExit(f"{label}: scores for pull requests outside the benchmark: {unknown[:3]}")
    report["judge"] = scores["judge"]
    report["configurations"][label] = {}
    for subset, members in subsets.items():
        members = sorted(members)
        paid = [costs[label][name] for name in members if name in costs.get(label, {})]
        row = {
            "pull_requests": len(members),
            "pull_requests_without_findings_file": sum(1 for name in members if name not in per_pr),
            "findings_per_pr": round(sum(per_pr[name]["overall"]["candidate_count"] for name in members if name in per_pr) / len(members), 1),
            "cost_usd_per_pr": round(statistics.mean(paid), 2) if paid else None,
            **{name: view(per_pr, members, severities) for name, severities in VIEWS.items()},
        }
        report["configurations"][label][subset] = row
        print(f"{label:10} {subset:13} {row['pull_requests']:3} PRs {row['findings_per_pr']:5.1f}/PR | " + " | ".join(
            f"{name} P {100 * row[name]['precision']:5.1f} R {100 * row[name]['recall']:5.1f} F1 {100 * row[name]['f1']:5.1f}" for name in VIEWS))

if args.out:
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=1) + "\n")
