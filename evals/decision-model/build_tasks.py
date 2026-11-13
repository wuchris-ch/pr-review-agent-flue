#!/usr/bin/env python3
"""Build decision-model tasks from ReviewBench data, in the task-folder format of jev-bench.

A decision model answers typed questions about a text with probabilities and never writes text.
Two questions matter to a reviewer that runs several passes:

  verify      Is this review finding a true positive? One row per golden finding of the test set,
              labelled by ReviewBench. The row shows the finding, the diff near it and the file
              near it. --text-only leaves the code out, to test whether the model reads it.
  duplicates  Do two findings describe the same problem? One row per pair of findings that
              different runs of one judged pool placed in the same file. A pair is labelled when
              both findings matched a golden finding: "same" when they matched the same one.
              --all-pairs also writes the unlabelled pairs, for an end-to-end merge.

    python3 evals/decision-model/build_tasks.py verify --bench <ReviewBench clone> --out <task dir>
    python3 evals/decision-model/build_tasks.py duplicates --pool <pool dir> --out <task dir>
"""
import argparse
import itertools
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("task", choices=["verify", "duplicates"])
parser.add_argument("--out", required=True, type=Path)
parser.add_argument("--bench", type=Path, help="clone of review-bench/ReviewBench (verify)")
parser.add_argument("--work", type=Path, default=Path.home() / ".cache/pr-review-reviewbench", help="checkouts from evals/reviewbench/prepare.py (verify)")
parser.add_argument("--text-only", action="store_true", help="verify: show the finding without any code")
parser.add_argument("--pool", type=Path, help="judged pool from evals/reviewbench (duplicates)")
parser.add_argument("--all-pairs", action="store_true", help="duplicates: include pairs without a label")
args = parser.parse_args()

VERIFY = {
    "valid": {"type": "noul", "instructions": "Is this review finding a true positive: a real, correctly described problem in this pull request's code that the author should act on? Answer no when the finding is factually wrong about the code shown, describes behaviour that is intended, is only a style preference, or is too vague to act on."},
    "severity": {"type": "score", "instructions": "If the finding is real, how severe is the problem?", "criteria": [
        "Low: a minor issue such as naming, documentation, a small maintainability problem or a missing test",
        "Medium: a real defect or risk with limited impact",
        "High: a serious defect such as wrong results, data loss, a security hole or a crash"]},
}
SAME = {"same": {"type": "noul", "instructions": "Do finding A and finding B describe the same underlying problem in the code, so that one fix would resolve both? Answer no when they are about different problems, even in the same function or on nearby lines."}}


def hunks_near(diff, file, start, end, limit=80):
    keep, current, in_file = [], None, False
    for raw in diff.splitlines():
        if raw.startswith("diff --git "):
            in_file, current = raw.endswith(" b/" + file), None
        elif in_file and raw.startswith("@@"):
            match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?", raw)
            first = int(match.group(1))
            last = first + int(match.group(2) or 1)
            current = [raw] if first - 15 <= end and last + 15 >= start else None
            if current is not None:
                keep.append(current)
        elif in_file and current is not None and not raw.startswith(("+++", "---")):
            current.append(raw)
    text = "\n".join("\n".join(hunk) for hunk in keep).splitlines()
    return "\n".join(text[:limit]) + ("\n[diff cut]" if len(text) > limit else "")


def code_near(repo, file, start, end, pad=25):
    path = repo / file
    if not path.is_file():
        return "[file not present after the change]"
    lines = path.read_text(errors="replace").splitlines()
    first, last = max(1, start - pad), min(len(lines), end + pad)
    last = min(last, first + 110)
    return "\n".join(f"{n:5} {lines[n - 1][:220]}" for n in range(first, last + 1))


def verify_rows():
    for entry in json.loads((args.bench / "corpus/test/test.json").read_text()):
        key = f"{entry['nwo'].replace('/', '_')}_{entry['pr_number']}-{entry['head'][:8]}"
        golden = json.loads((args.bench / "golden" / f"{key}.json").read_text())
        diff = (args.work / "pr" / key / "diff.patch").read_text(errors="replace")
        for position, finding in enumerate(golden["findings"]):
            start, end = int(finding["start_line"]), int(finding["end_line"])
            state = [
                "PULL REQUEST: " + str(entry.get("title") or "")[:200],
                f"FILE: {finding['file']} (lines {start}-{end})",
                "",
                "REVIEW FINDING:",
                finding["message"][:2500],
            ]
            if not args.text_only:
                state += [
                    "",
                    "DIFF OF THIS FILE NEAR THE FINDING:",
                    hunks_near(diff, finding["file"], start, end) or "[no changed lines near the finding]",
                    "",
                    "FILE NEAR THE FINDING, AFTER THE CHANGE:",
                    code_near(args.work / "repos" / key, finding["file"], start, end),
                ]
            yield {
                "id": f"{key}#{position}",
                "state": "\n".join(state),
                "labels": {"valid": finding["tp_fp"] == "tp"},
                "meta": {"severity": finding["severity"], "producer": finding["producer"], "message_chars": len(finding["message"])},
            }


def duplicate_rows():
    index = json.loads((args.pool / "index.json").read_text())["findings"]
    details = json.loads((args.pool / "scores.details.json").read_text())
    for key, candidates in index.items():
        messages = [f["message"] for f in json.loads((args.pool / "findings" / f"{key}.json").read_text())["findings"]]
        matched = {c["candidate_index"]: set(c["matched_golden_indices"]) for c in details[key]["correspondences"]}
        for a, b in itertools.combinations(range(len(candidates)), 2):
            one, two = candidates[a], candidates[b]
            if one["file"] != two["file"] or one["run"] == two["run"]:
                continue
            labelled = bool(matched.get(a)) and bool(matched.get(b))
            if not labelled and not args.all_pairs:
                continue
            words = [set(re.findall(r"[a-z0-9_]+", c["title"].lower())) for c in (one, two)]
            yield {
                "id": f"{key}#{a}-{b}",
                "state": f"FILE: {one['file']}\n\nFINDING A (line {one['line']}):\n{messages[a][:1500]}\n\nFINDING B (line {two['line']}):\n{messages[b][:1500]}",
                "labels": {"same": bool(matched[a] & matched[b])} if labelled else {},
                "meta": {"line_gap": abs(one["line"] - two["line"]), "title_overlap": len(words[0] & words[1]) / max(1, len(words[0] | words[1]))},
            }


rows = list(verify_rows() if args.task == "verify" else duplicate_rows())
question = "valid" if args.task == "verify" else "same"
args.out.mkdir(parents=True, exist_ok=True)
with (args.out / "rows.jsonl").open("w") as handle:
    for row in rows:
        handle.write(json.dumps(row) + "\n")
(args.out / "task.json").write_text(json.dumps({
    "name": "Is this review finding a true positive?" if args.task == "verify" else "Do two review findings describe the same problem?",
    "questions": VERIFY if args.task == "verify" else SAME,
    "scoring": [{"question": question}],
}, indent=2))
labelled = [row for row in rows if question in row["labels"]]
print(f"{len(rows)} rows, {len(labelled)} labelled, {sum(row['labels'][question] for row in labelled)} labelled yes, about {sum(len(row['state']) for row in rows) // 4:,} tokens")
