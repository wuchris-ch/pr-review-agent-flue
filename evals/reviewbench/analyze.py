#!/usr/bin/env python3
"""Offline ReviewBench analysis from judged pools of agent findings.

A pool holds every finding of several review runs of one kind (findings.mjs) and the matcher's
decisions for them (judge.ts). This script composes reviews from those runs without another model
call: one run, several runs merged, or runs from different pools merged. A mix such as
"bugs=1,broad=2" is scored for every choice of runs and the scores are averaged.

Scoring follows ReviewBench's scripts/lib/match-types.ts (resolveForScoring) and
scripts/eval/scorer.ts. Grounded precision is the share of matched findings whose golden finding
is a true positive. Grounded recall is the share of true-positive golden findings that some
finding covers. Findings that match no golden finding do not count for or against precision.

Runs are merged the way src/stages/agent-stage.ts merges agent passes: two findings from
different passes are one finding when they cite the same file, sit at most three lines apart and
their titles share at least a fifth of their words. Each merged group keeps its longest write-up.

--same-issue replaces that rule for one pool with a decision model's answers: two findings merge
when the model's probability that they describe the same problem reaches the threshold
(see evals/decision-model).

    python3 evals/reviewbench/analyze.py --pool bugs=<pool dir> --pool broad=<pool dir> \
        --mix bugs=1 --mix broad=1 --mix bugs=1,broad=1 --out results.json
"""
import argparse
import itertools
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--work", type=Path, default=Path.home() / ".cache/pr-review-reviewbench")
parser.add_argument("--pool", action="append", required=True, metavar="LABEL=DIR")
parser.add_argument("--mix", action="append", default=[], metavar="LABEL=N[,LABEL=N]")
parser.add_argument("--same-issue", metavar="LABEL=RESULTS.jsonl", help="decision-model answers for pairs of one pool's findings")
parser.add_argument("--same-issue-threshold", type=float, default=0.7)
parser.add_argument("--out", type=Path, help="write the aggregate numbers here (no finding text)")
args = parser.parse_args()

SEVERITIES = ("high", "medium", "low")
STOP_WORDS = set("the a an of to in is and or for on with that this it as be are not when by from at if".split())


def changed_lines(key):
    """New-side line numbers each file's diff adds."""
    out, file, line = defaultdict(set), None, 0
    for raw in (args.work / "pr" / key / "diff.patch").read_text(errors="replace").splitlines():
        if raw.startswith("+++ "):
            file = raw[6:] if raw.startswith("+++ b/") else None
        elif raw.startswith("@@"):
            match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", raw)
            line = int(match.group(1)) if match else 0
        elif file and raw.startswith("+"):
            out[file].add(line)
            line += 1
        elif file and not raw.startswith("-") and not raw.startswith("\\"):
            line += 1
    return out


def words(title):
    return {word for word in re.findall(r"[a-z0-9_]+", title.lower()) if word not in STOP_WORDS and len(word) > 2}


# Load every pool; keep the pull requests that every run of every pool reviewed.
pools = {}
for spec in args.pool:
    label, _, directory = spec.partition("=")
    index = json.loads((Path(directory) / "index.json").read_text())
    pools[label] = {**index, "details": json.loads((Path(directory) / "scores.details.json").read_text())}
keys = sorted(
    key
    for key in set.intersection(*(set(pool["details"]) for pool in pools.values()))
    if all(str(run) in pool["reviews"][key] for pool in pools.values() for run in pool["runs"])
)
dropped = sorted(set.union(*(set(pool["findings"]) for pool in pools.values())) - set(keys))
PR = {}
for key in keys:
    changed = changed_lines(key)
    candidates = []
    for label, pool in pools.items():
        matched = {c["candidate_index"]: sorted(set(c["matched_golden_indices"])) for c in pool["details"][key]["correspondences"]}
        for position, finding in enumerate(pool["findings"][key]):
            lines = changed.get(finding["file"])
            candidates.append({
                **finding,
                "pass": (label, finding["run"]),
                "position": position,
                "golden": matched.get(position, []),
                "on_changed_line": bool(lines) and finding["line"] in lines,
                "words": words(finding["title"]),
            })
    PR[key] = {"candidates": candidates, "golden": next(iter(pools.values()))["details"][key]["golden"]}

same_issue_pool, same_issue = None, {}
if args.same_issue:
    same_issue_pool, _, answers = args.same_issue.partition("=")
    for line in Path(answers).read_text().splitlines():
        row = json.loads(line)
        key, _, pair = row["id"].rpartition("#")
        same_issue[(key, *map(int, pair.split("-")))] = row["answers"]["same"]["noul"]


def same_problem(key, one, two):
    if one["pass"] == two["pass"] or one["file"] != two["file"]:
        return False
    if one["pass"][0] == two["pass"][0] == same_issue_pool:
        return same_issue.get((key, one["position"], two["position"]), 0) >= args.same_issue_threshold
    if abs(one["line"] - two["line"]) > 3:
        return False
    return len(one["words"] & two["words"]) / max(1, len(one["words"] | two["words"])) >= 0.2


def counts(key, chosen, severities=None):
    """resolveForScoring over the chosen candidates, in order."""
    golden, candidates = PR[key]["golden"], PR[key]["candidates"]
    wanted = lambda g: severities is None or golden[g]["severity"] in severities
    covered, claimed, matched_tp, matched = set(), set(), 0, 0
    for j in chosen:
        covered.update(candidates[j]["golden"])
        for g in candidates[j]["golden"]:
            if g not in claimed:
                claimed.add(g)
                if wanted(g):
                    matched += 1
                    matched_tp += golden[g]["tp_fp"] == "tp"
                break
    total = sum(1 for g, item in enumerate(golden) if item["tp_fp"] == "tp" and wanted(g))
    found = sum(1 for g in covered if golden[g]["tp_fp"] == "tp" and wanted(g))
    return matched_tp, matched, found, total


def f1(precision, recall):
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def score(review, severities=None):
    """review maps a pull request to the candidate indices it reports."""
    sums, per_pr, findings = [0, 0, 0, 0], [], 0
    for key in PR:
        chosen = review.get(key, [])
        row = counts(key, chosen, severities)
        sums = [a + b for a, b in zip(sums, row)]
        findings += len(chosen)
        per_pr.append((row[0] / row[1] if row[1] else None, row[2] / row[3] if row[3] else None))
    precision = sums[0] / sums[1] if sums[1] else 0.0
    recall = sums[2] / sums[3] if sums[3] else 0.0
    macro_p = statistics.mean([p for p, _ in per_pr if p is not None] or [0.0])
    macro_r = statistics.mean([r for _, r in per_pr if r is not None] or [0.0])
    return {"precision": precision, "recall": recall, "f1": f1(precision, recall), "macro_f1": f1(macro_p, macro_r), "findings_per_pr": findings / len(PR)}


def merged(key, passes):
    """Findings of the given passes after merging duplicates across passes."""
    candidates = PR[key]["candidates"]
    chosen = [j for j, c in enumerate(candidates) if c["pass"] in passes]
    parent = {j: j for j in chosen}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in itertools.combinations(chosen, 2):
        if same_problem(key, candidates[a], candidates[b]):
            parent[find(a)] = find(b)
    groups = defaultdict(list)
    for j in chosen:
        groups[find(j)].append(j)
    return [max(members, key=lambda j: candidates[j]["chars"]) for members in groups.values()]


def mean(rows):
    return {name: round(statistics.mean(row[name] for row in rows), 4) for name in rows[0]}


def review_cost(label):
    values = [r["costUsd"] for by_run in pools[label]["reviews"].values() for r in by_run.values() if r.get("costUsd")]
    return statistics.mean(values) if values else None


def percent(value):
    return f"{100 * value:5.1f}"


golden_tp = [item for pr in PR.values() for item in pr["golden"] if item["tp_fp"] == "tp"]
report = {
    "pull_requests": len(PR),
    "pull_requests_dropped_for_a_missing_review": len(dropped),
    "golden_true_positives": len(golden_tp),
    "golden_true_positives_by_severity": dict(Counter(item["severity"] for item in golden_tp)),
    "golden_false_positives": sum(1 for pr in PR.values() for item in pr["golden"] if item["tp_fp"] == "fp"),
    "pools": {},
    "mixes": [],
}
print(f"{len(PR)} pull requests ({len(dropped)} dropped for a missing review), {len(golden_tp)} golden true positives {report['golden_true_positives_by_severity']}")

for label, pool in pools.items():
    reviews = [r for key in keys for r in pool["reviews"][key].values()]
    costs = [r["costUsd"] for r in reviews if r.get("costUsd")]
    seconds = sorted(r["wallMs"] / 1000 for r in reviews if r.get("wallMs"))
    runs = []
    for run in pool["runs"]:
        own = {key: [j for j, c in enumerate(pr["candidates"]) if c["pass"] == (label, run)] for key, pr in PR.items()}
        exact = {key: [j for j in chosen if PR[key]["candidates"][j]["on_changed_line"]] for key, chosen in own.items()}
        runs.append({"run": run, "own_locations": mean([score(own)]), "exact_changed_lines": mean([score(exact)])})
        print(f" {label} run {run}: P {percent(runs[-1]['own_locations']['precision'])} R {percent(runs[-1]['own_locations']['recall'])} F1 {percent(runs[-1]['own_locations']['f1'])} | on changed lines only F1 {percent(runs[-1]['exact_changed_lines']['f1'])}")
    by_runs = Counter()
    by_runs_severity = defaultdict(Counter)
    for pr in PR.values():
        for g, item in enumerate(pr["golden"]):
            if item["tp_fp"] == "tp":
                found_by = len({c["pass"] for c in pr["candidates"] if c["pass"][0] == label and g in c["golden"]})
                by_runs[found_by] += 1
                by_runs_severity[item["severity"]][found_by] += 1
    report["pools"][label] = {
        "runs": pool["runs"],
        "reviews": len(reviews),
        "cost_usd_mean": round(statistics.mean(costs), 3) if costs else None,
        "cost_usd_median": round(statistics.median(costs), 3) if costs else None,
        "seconds_median": round(statistics.median(seconds)) if seconds else None,
        "seconds_p90": round(seconds[int(0.9 * (len(seconds) - 1))]) if seconds else None,
        "single_runs": runs,
        "true_positives_by_number_of_runs_that_found_them": {str(n): by_runs[n] for n in sorted(by_runs)},
        "by_severity": {s: {str(n): by_runs_severity[s][n] for n in sorted(by_runs_severity[s])} for s in SEVERITIES},
    }

for spec in args.mix:
    wanted = {label: int(n) for label, _, n in (part.partition("=") for part in spec.split(","))}
    choices = [itertools.combinations([(label, run) for run in pools[label]["runs"]], n) for label, n in wanted.items()]
    overall, high_medium, high = [], [], []
    for choice in itertools.product(*choices):
        passes = set(itertools.chain.from_iterable(choice))
        review = {key: merged(key, passes) for key in PR}
        overall.append(score(review))
        high_medium.append(score(review, ("high", "medium")))
        high.append(score(review, ("high",)))
    costs = [review_cost(label) for label in wanted]
    row = {
        "mix": wanted,
        **mean(overall),
        "high_medium_precision": mean(high_medium)["precision"],
        "high_medium_recall": mean(high_medium)["recall"],
        "high_medium_f1": mean(high_medium)["f1"],
        "high_precision": mean(high)["precision"],
        "high_recall": mean(high)["recall"],
        "high_f1": mean(high)["f1"],
        "cost_usd_per_pr": None if None in costs else round(sum(cost * n for cost, n in zip(costs, wanted.values())), 2),
        "run_choices": len(overall),
    }
    report["mixes"].append(row)
    cost = "" if row["cost_usd_per_pr"] is None else f" | ${row['cost_usd_per_pr']:.2f}/PR"
    print(f" {spec:32} P {percent(row['precision'])} R {percent(row['recall'])} F1 {percent(row['f1'])} | {row['findings_per_pr']:5.1f}/PR | high+medium F1 {percent(row['high_medium_f1'])} | high P {percent(row['high_precision'])} R {percent(row['high_recall'])} F1 {percent(row['high_f1'])}{cost}")

if args.out:
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=1) + "\n")
