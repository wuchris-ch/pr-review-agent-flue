#!/usr/bin/env python3
"""Render a Markdown leaderboard from judge reports.

    python3 evals/martian/summarize.py --published evals/martian/runs/published-tools/report.json \
        --ours evals/martian/runs/heldout-final/report.json --subset heldout --profile core
"""
import argparse, json
from pathlib import Path

NAMES = {
    "qodo-extended-v2": "Qodo (extended)", "qodo-v2": "Qodo", "augment": "Augment", "bugbot": "Cursor Bugbot",
    "devin": "Devin", "gitlab": "GitLab Duo", "greptile-v4-1": "Greptile v4.1", "greptile-v5": "Greptile v5",
    "macroscope": "Macroscope", "gemini-v2": "Gemini", "copilot-v2": "GitHub Copilot (v2)", "copilot": "GitHub Copilot",
    "sourcery": "Sourcery", "kodus-v2": "Kodus", "claude-code": "Claude Code", "coderabbit": "CodeRabbit",
    "claude": "Claude", "baz": "Baz", "codeant-v2": "CodeAnt", "kg": "KG", "graphite": "Graphite", "cubic-v2": "cubic",
}
# Martian publishes extracted candidates for these tools on at most one PR, so their published
# scores rest on extraction output that is not in the repository. Raw-comment fallback is
# not comparable, so they are left out of the leaderboard.
EXCLUDED = {"cubic-v2", "kodus-v2", "sourcery", "claude-code", "greptile-v5"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--published", type=Path, required=True)
    ap.add_argument("--ours", type=Path, action="append", default=[])
    ap.add_argument("--subset", default="all")
    ap.add_argument("--profile", default="core")
    args = ap.parse_args()
    key = f"{args.subset}/{args.profile}"
    rows = {}
    for tool, m in json.loads(args.published.read_text())["scores"][key].items():
        if tool not in EXCLUDED:
            rows[NAMES.get(tool, tool)] = (m, False)
    for path in args.ours:
        for tool, m in json.loads(path.read_text())["scores"][key].items():
            rows[f"**{tool}**"] = (m, True)
    print(f"| Rank | Reviewer | F1 | Precision | Recall |\n|---:|---|---:|---:|---:|")
    for rank, (name, (m, _)) in enumerate(sorted(rows.items(), key=lambda kv: -kv[1][0]["f1"]), 1):
        print(f"| {rank} | {name} | {m['f1'] * 100:.1f}% | {m['precision'] * 100:.1f}% | {m['recall'] * 100:.1f}% |")


if __name__ == "__main__":
    main()
