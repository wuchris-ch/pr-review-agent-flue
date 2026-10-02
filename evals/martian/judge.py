#!/usr/bin/env python3
"""Score PR reviews on Martian's offline code review benchmark with one batched judge.

Martian's pipeline asks a judge model about every (golden comment, candidate) pair.
This judge asks once per PR and tool with every golden comment and candidate
numbered, using the same matching rule, then writes evaluations in Martian's
format so their scoring profiles apply unchanged. Published tools' extracted
candidates and duplicate groups are re-judged with the same model for a
like-for-like comparison, and agreement with Martian's published GPT-5.2
judgments is reported.

    python3 evals/martian/judge.py --benchmark ~/Projects/_benchmarks/martian-code-review-benchmark/offline \
        --reviews evals/results/comparison-...-baseline --arm context-validated --name pr-review-agent \
        --tools coderabbit,bugbot --out evals/martian/runs/baseline
"""
import argparse, hashlib, json, os, re, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROMPT = """You are evaluating AI code review tools.
For each golden (expected) comment, decide which candidate issues from the tool's review identify the SAME underlying issue.

Instructions:
- Accept semantic matches: different wording is fine if it is the same problem.
- Focus on whether they point to the same bug, concern, or code issue.
- A candidate that raises a different problem in the same file or function is not a match.
- List every matching (golden, candidate) pair. Omit non-matching pairs.

Golden comments:
{golden}

Candidate issues:
{candidates}

Respond with ONLY a JSON object:
{{"matches": [{{"golden": <golden number>, "candidate": <candidate number>, "confidence": <0.0-1.0>, "reasoning": "<brief>"}}]}}"""

PROFILES = {
    "strict": {"bug", "security", "concurrency", "data", "api"},
    "core": {"bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect"},
    "all": {"bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect", "style", "speculative"},
}


class Judge:
    def __init__(self, base_url, api_key, model, effort, cache_path):
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.key, self.model, self.effort = api_key, model, effort
        self.cache_path = Path(cache_path)
        self.cache = {}
        if self.cache_path.exists():
            for line in self.cache_path.read_text().splitlines():
                row = json.loads(line)
                self.cache[row["key"]] = row["result"]
        self.lock = threading.Lock()

    def ask(self, prompt):
        key = hashlib.sha256(f"{self.model}|{self.effort}|{prompt}".encode()).hexdigest()
        if key in self.cache:
            return self.cache[key]
        body = {"model": self.model, "temperature": 0, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": "You are a precise code review evaluator. Always respond with valid JSON."},
                             {"role": "user", "content": prompt}]}
        if self.effort:
            body["reasoning_effort"] = self.effort
        last = None
        for attempt in range(6):
            try:
                req = urllib.request.Request(self.url, data=json.dumps(body).encode(), method="POST",
                                             headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"})
                with urllib.request.urlopen(req, timeout=900) as resp:
                    content = json.load(resp)["choices"][0]["message"]["content"].strip()
                content = re.sub(r"^```(?:json)?|```$", "", content).strip()
                result = json.loads(content)
                if not isinstance(result.get("matches"), list):
                    raise ValueError("no matches list")
                with self.lock:
                    self.cache[key] = result
                    with open(self.cache_path, "a") as fh:
                        fh.write(json.dumps({"key": key, "result": result}) + "\n")
                return result
            except Exception as exc:  # retried, then reported as an error
                last = exc
                time.sleep(min(60, 2 ** attempt))
        return {"error": str(last)[:200]}


def evaluate(judge, golden, candidates, groups):
    """Return a Martian-format evaluation for one PR and tool."""
    base = {"total_candidates": len(candidates), "total_golden": len(golden), "errors": []}
    if not candidates:
        return {**base, "skipped": False, "true_positives": [], "false_positives": [], "tp": 0, "fp": 0,
                "false_negatives": [{"golden_comment": g["comment"], "severity": g.get("severity"), "category": g.get("category")} for g in golden],
                "fn": len(golden), "errors_count": 0}
    prompt = PROMPT.format(
        golden="\n".join(f"G{i + 1}. {g['comment']}" for i, g in enumerate(golden)),
        candidates="\n".join(f"C{j + 1}. {c}" for j, c in enumerate(candidates)))
    result = judge.ask(prompt)
    if "error" in result:
        return {**base, "skipped": False, "errors": [result["error"]], "errors_count": 1,
                "true_positives": [], "false_positives": [], "false_negatives": [], "tp": 0, "fp": 0, "fn": 0}
    siblings = {}
    for group in groups or []:
        for i in group:
            siblings[i] = set(group) - {i}
    best = {}
    for m in result["matches"]:
        try:
            g, c, conf = int(str(m["golden"]).lstrip("G")) - 1, int(str(m["candidate"]).lstrip("C")) - 1, float(m.get("confidence", 1))
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= g < len(golden) and 0 <= c < len(candidates) and conf > best.get(g, (None, -1, ""))[1]:
            best[g] = (c, conf, m.get("reasoning", ""))
    matched = set()
    for c, _, _ in best.values():
        matched.add(c)
        matched |= siblings.get(c, set())
    tps = [{"golden_comment": golden[g]["comment"], "severity": golden[g].get("severity"), "category": golden[g].get("category"),
            "matched_candidate": candidates[c], "confidence": conf, "reasoning": why} for g, (c, conf, why) in sorted(best.items())]
    fns = [{"golden_comment": x["comment"], "severity": x.get("severity"), "category": x.get("category")}
           for i, x in enumerate(golden) if i not in best]
    fps = [{"candidate": c} for j, c in enumerate(candidates) if j not in matched]
    return {**base, "skipped": False, "true_positives": tps, "false_positives": fps, "false_negatives": fns,
            "tp": len(tps), "fp": len(fps), "fn": len(fns), "errors_count": 0}


def score(evaluations, categories, profile, urls=None):
    cats, totals = PROFILES[profile], {}
    for url, by_tool in evaluations.items():
        if urls is not None and url not in urls:
            continue
        for tool, ev in by_tool.items():
            t = totals.setdefault(tool, {"tp": 0, "fp": 0, "fn": 0, "prs": 0, "errors": 0})
            t["tp"] += sum(1 for x in ev.get("true_positives", []) if (x.get("category") or categories.get(x["golden_comment"])) in cats)
            t["fn"] += sum(1 for x in ev.get("false_negatives", []) if (x.get("category") or categories.get(x["golden_comment"])) in cats)
            t["fp"] += ev.get("fp", 0)
            t["prs"] += 1
            t["errors"] += ev.get("errors_count", 0)
    out = {}
    for tool, t in totals.items():
        p = t["tp"] / (t["tp"] + t["fp"]) if t["tp"] + t["fp"] else 0.0
        r = t["tp"] / (t["tp"] + t["fn"]) if t["tp"] + t["fn"] else 0.0
        out[tool] = {**t, "precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0}
    return out


def finding_text(f):
    return f"{f['file']}:{f['line']}: {f['detail']}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--benchmark", required=True, type=Path, help="Martian offline/ directory")
    ap.add_argument("--reviews", action="append", default=[], help="comparison directory (repeatable)")
    ap.add_argument("--arm", action="append", default=[], help="arm to score from each --reviews (repeatable, paired by order)")
    ap.add_argument("--name", action="append", default=[], help="leaderboard name for each --reviews (repeatable)")
    ap.add_argument("--repetition", type=int, default=1)
    ap.add_argument("--tools", default="", help="comma-separated published tools to re-judge")
    ap.add_argument("--manifest", type=Path, default=Path("evals/external/manifest.json"))
    ap.add_argument("--split", type=Path, default=Path("evals/martian/split.json"))
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--model", default=os.environ.get("JUDGE_MODEL", "gpt-5.5"))
    ap.add_argument("--effort", default=os.environ.get("JUDGE_EFFORT", "medium"))
    ap.add_argument("--concurrency", type=int, default=6)
    args = ap.parse_args()
    base_url, key = os.environ.get("JUDGE_BASE_URL"), os.environ.get("JUDGE_API_KEY")
    if not base_url or not key:
        sys.exit("set JUDGE_BASE_URL and JUDGE_API_KEY (any OpenAI-compatible endpoint)")
    args.out.mkdir(parents=True, exist_ok=True)
    judge = Judge(base_url, key, args.model, args.effort, args.out.parent / "judge-cache.jsonl")

    bench = args.benchmark
    data = json.loads((bench / "results/benchmark_data.json").read_text())
    published = json.loads((bench / "results/openai_gpt-5.2/candidates.json").read_text())
    dedup = json.loads((bench / "results/openai_gpt-5.2/dedup_groups.json").read_text())
    reference = json.loads((bench / "results/openai_gpt-5.2/evaluations.json").read_text())
    manifest = {c["id"]: c["url"] for c in json.loads(args.manifest.read_text())}
    categories = {g["comment"]: g.get("category") for e in data.values() for g in e["golden_comments"]}

    jobs = []  # (url, tool, candidates, groups)
    for reviews, arm, name in zip(args.reviews, args.arm, args.name):
        for case_id, url in manifest.items():
            path = Path(reviews) / f"{case_id}-{arm}-{args.repetition}.json"
            if not path.exists():
                print(f"missing review: {path.name} (scored as a failed review)", file=sys.stderr)
                jobs.append((url, name, None, None))
                continue
            findings = json.loads(path.read_text())["review"]["findings"]
            jobs.append((url, name, [finding_text(f) for f in findings], None))
    for tool in filter(None, args.tools.split(",")):
        for url in manifest.values():
            if tool in published.get(url, {}):
                cands = [c["text"] for c in published[url][tool] if c.get("text")]
            else:
                # Same fallback as Martian's judge: raw review comment bodies.
                reviews = [r for r in data[url].get("reviews", []) if r.get("tool") == tool]
                cands = [c["body"] for r in reviews for c in r.get("review_comments", []) if c.get("body")]
            jobs.append((url, tool, cands, dedup.get(url, {}).get(tool)))

    evaluations, done = {}, [0]

    def run(job):
        url, tool, cands, groups = job
        golden = data[url]["golden_comments"]
        if cands is None:
            ev = evaluate(judge, golden, [], None)
            ev["review_failed"] = True
        else:
            ev = evaluate(judge, golden, cands, groups)
        ev["tool"] = tool
        evaluations.setdefault(url, {})[tool] = ev
        done[0] += 1
        if done[0] % 25 == 0:
            print(f"judged {done[0]}/{len(jobs)}", flush=True)

    with ThreadPoolExecutor(args.concurrency) as pool:
        list(pool.map(run, jobs))
    (args.out / "evaluations.json").write_text(json.dumps(evaluations, indent=2))

    split = json.loads(args.split.read_text()) if args.split.exists() else {}
    subsets = {"all": None, **{k: {manifest[i] for i in v if i in manifest} for k, v in split.items()}}
    report = {"judge": {"model": args.model, "effort": args.effort}, "cases": len(manifest), "scores": {}, "reference_gpt52": {}}
    for subset, urls in subsets.items():
        for profile in ("core", "strict"):
            report["scores"][f"{subset}/{profile}"] = score(evaluations, categories, profile, urls)
            ref = {u: {t: v for t, v in by.items() if t in set(args.tools.split(","))} for u, by in reference.items() if u in manifest.values()}
            report["reference_gpt52"][f"{subset}/{profile}"] = score(ref, categories, profile, urls)

    # Agreement with Martian's GPT-5.2 judge on whether each golden comment was found.
    agree = total = both = ours_only = theirs_only = 0
    for url, by_tool in evaluations.items():
        for tool, ev in by_tool.items():
            if tool not in reference.get(url, {}):
                continue
            ours = {x["golden_comment"] for x in ev.get("true_positives", [])}
            theirs = {x["golden_comment"] for x in reference[url][tool].get("true_positives", [])}
            for g in data[url]["golden_comments"]:
                a, b = g["comment"] in ours, g["comment"] in theirs
                total += 1
                agree += a == b
                both += a and b
                ours_only += a and not b
                theirs_only += b and not a
    if total:
        po = agree / total
        pa = (both + ours_only) / total
        pb = (both + theirs_only) / total
        pe = pa * pb + (1 - pa) * (1 - pb)
        report["agreement_with_gpt52"] = {"golden_decisions": total, "agreement": po,
                                          "cohens_kappa": (po - pe) / (1 - pe) if pe < 1 else 1.0,
                                          "found_by_both": both, "only_this_judge": ours_only, "only_gpt52": theirs_only}
    (args.out / "report.json").write_text(json.dumps(report, indent=2))
    for key in ("all/core",) + tuple(f"{k}/core" for k in split):
        print(f"\n{key}  (judge {args.model} {args.effort})")
        rows = sorted(report["scores"][key].items(), key=lambda kv: -kv[1]["f1"])
        for tool, m in rows:
            ref = report["reference_gpt52"][key].get(tool)
            extra = f"   gpt-5.2 judge F1 {ref['f1'] * 100:5.1f}%" if ref else ""
            print(f"  {tool:<22} P {m['precision'] * 100:5.1f}%  R {m['recall'] * 100:5.1f}%  F1 {m['f1'] * 100:5.1f}%  "
                  f"tp {m['tp']:3} fp {m['fp']:3} fn {m['fn']:3}{extra}")
    if "agreement_with_gpt52" in report:
        a = report["agreement_with_gpt52"]
        print(f"\nagreement with GPT-5.2 judgments: {a['agreement'] * 100:.1f}% of {a['golden_decisions']} golden decisions, kappa {a['cohens_kappa']:.2f}")


if __name__ == "__main__":
    main()
