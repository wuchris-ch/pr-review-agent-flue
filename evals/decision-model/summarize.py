#!/usr/bin/env python3
"""Summarize decision-model runs on the tasks from build_tasks.py.

Each task folder holds rows.jsonl (the rows and labels) and results/<run>.jsonl (the model's
answers, as jev-bench writes them). The newest run in each folder is read.

    python3 evals/decision-model/summarize.py --verify <dir> --verify-text-only <dir> \
        --duplicates <dir> --out evals/decision-model/results/summary.json
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--verify", type=Path)
parser.add_argument("--verify-text-only", type=Path)
parser.add_argument("--duplicates", type=Path)
parser.add_argument("--out", type=Path)
args = parser.parse_args()


def load(folder):
    rows = {row["id"]: row for row in map(json.loads, (folder / "rows.jsonl").read_text().splitlines())}
    run = sorted(path for path in (folder / "results").glob("*.jsonl") if not path.name.endswith(".misses.jsonl"))[-1]
    results = [json.loads(line) for line in run.read_text().splitlines()]
    return rows, [r for r in results if r["id"] in rows], {
        "model": results[0]["model"],
        "calls": len(results),
        "input_tokens": sum(r["usage"]["input_tokens"] for r in results),
        "cost_usd": round(sum(r["cost_usd"] for r in results), 4),
    }


def auc(scored):
    """Chance that a random yes row gets a higher score than a random no row."""
    yes = [score for score, label in scored if label]
    no = [score for score, label in scored if not label]
    return round(sum((p > n) + 0.5 * (p == n) for p in yes for n in no) / (len(yes) * len(no)), 3)


def precision_recall(predicted, labels):
    tp = sum(1 for p, y in zip(predicted, labels) if p and y)
    return {"precision": round(tp / max(1, sum(predicted)), 3), "recall": round(tp / max(1, sum(labels)), 3)}


def verify(folder):
    rows, results, run = load(folder)
    scored = [(r["answers"]["valid"]["noul"], rows[r["id"]]["labels"]["valid"], rows[r["id"]], r) for r in results]
    out = {"rows": len(scored), "true_positives": sum(label for _, label, _, _ in scored), "run": run,
           "auc": auc([(score, label) for score, label, _, _ in scored])}
    test = [(score, label) for score, label, _, r in scored if r["split"] == "test"]
    dev = [(score, label) for score, label, _, r in scored if r["split"] == "dev"]
    accuracy = lambda group, cutoff: sum((score >= cutoff) == label for score, label in group) / len(group)
    cutoff = max((n / 100 for n in range(5, 96, 5)), key=lambda c: accuracy(dev, c))
    out["test_split"] = {"rows": len(test), "cutoff_chosen_on_dev": cutoff, "accuracy": round(accuracy(test, cutoff), 3),
                         "accuracy_always_yes": round(sum(label for _, label in test) / len(test), 3)}
    return out, scored


report = {}
if args.verify:
    out, scored = verify(args.verify)
    # What the model could score without reading anything: who wrote the finding, and how long it is.
    by_producer = defaultdict(list)
    for _, label, row, _ in scored:
        by_producer[row["meta"]["producer"]].append(label)
    prior = lambda row, label: (sum(by_producer[row["meta"]["producer"]]) - label) / max(1, len(by_producer[row["meta"]["producer"]]) - 1)
    out["baseline_auc"] = {
        "producer_true_positive_rate_leave_one_out": auc([(prior(row, label), label) for _, label, row, _ in scored]),
        "message_length": auc([(row["meta"]["message_chars"], label) for _, label, row, _ in scored]),
    }
    out["auc_within_one_producer"] = {
        producer: {"rows": len(labels), "true_positives": sum(labels), "auc": auc([(s, l) for s, l, row, _ in scored if row["meta"]["producer"] == producer])}
        for producer, labels in sorted(by_producer.items())
        if min(sum(labels), len(labels) - sum(labels)) >= 15
    }
    real = [(round(r["answers"]["severity"]["score"]), ("low", "medium", "high").index(row["meta"]["severity"])) for _, label, row, r in scored if label]
    out["severity_exact_agreement_on_true_positives"] = round(sum(a == b for a, b in real) / len(real), 3)
    report["verify"] = out
if args.verify_text_only:
    report["verify_text_only"] = verify(args.verify_text_only)[0]
if args.duplicates:
    rows, results, run = load(args.duplicates)
    labelled = [(r["answers"]["same"]["noul"], rows[r["id"]]) for r in results if "same" in rows[r["id"]]["labels"]]
    labels = [row["labels"]["same"] for _, row in labelled]
    report["duplicates"] = {
        "pairs": len(labelled),
        "same_problem": sum(labels),
        "run": run,
        "auc": auc([(score, row["labels"]["same"]) for score, row in labelled]),
        "baseline_auc": {
            "title_word_overlap": auc([(row["meta"]["title_overlap"], row["labels"]["same"]) for _, row in labelled]),
            "line_closeness": auc([(-row["meta"]["line_gap"], row["labels"]["same"]) for _, row in labelled]),
        },
        "model_at_0.5": precision_recall([score >= 0.5 for score, _ in labelled], labels),
        "model_at_0.7": precision_recall([score >= 0.7 for score, _ in labelled], labels),
        "rule_within_3_lines": precision_recall([row["meta"]["line_gap"] <= 3 for _, row in labelled], labels),
        "rule_within_3_lines_and_title_overlap_0.2": precision_recall([row["meta"]["line_gap"] <= 3 and row["meta"]["title_overlap"] >= 0.2 for _, row in labelled], labels),
    }
print(json.dumps(report, indent=1))
if args.out:
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=1) + "\n")
