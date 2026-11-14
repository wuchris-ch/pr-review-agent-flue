# ReviewBench, offline

Scores the agent reviewer on [ReviewBench](https://github.com/review-bench/ReviewBench) pull requests without a container or a submission. The scripts run the same review requests as [the adapter](../../integrations/reviewbench/README.md), save every answer, and score the findings with the benchmark's own matcher and scorer. Results and method: [docs/results.md](../../docs/results.md#reviewbench-offline-november-13).

| File | Purpose |
| --- | --- |
| `prepare.py` | Checks out each pull request at its head commit and saves its diff, the way the benchmark's `scripts/try-agent.sh` does. |
| `review.mjs` | Runs one kind of review pass (`bugs` or `breadth`) on every checkout with Claude Code. Saves each answer with the cost and duration Claude Code reports. Saved answers are reused. |
| `findings.mjs` | Pool mode: every finding of every run in one findings file per pull request. Engine mode: the findings the adapter writes for one configuration, from the saved answers. |
| `judge.ts` | Matches a findings directory to the golden findings with ReviewBench's matcher and computes grounded precision, recall and F1 with its scorer. |
| `analyze.py` | Composes reviews from judged pools without another model call: one run, several runs merged, or runs of different pools merged. Each mix is scored for every choice of runs. |
| `report.py` | Sums the scorer's counts of judged findings over the whole benchmark and over subsets, in the leaderboard's three severity views. |
| `judge-models.json` | Model list that points ReviewBench's matcher at a local endpoint. |
| `fresh-sample.json` | 30 pull requests outside the test set: the first 30 of the other 194 when sorted by SHA-256 of their key. |
| `full-run.json` | The setup of the run over all 219 pull requests. It was committed before that run started. |
| `results/` | Aggregate scores, and the public leaderboard's numbers on the day of the run. Review text and source code stay out of the repository. |

## Run

```sh
npm ci && npm run build
git clone https://github.com/review-bench/ReviewBench ../ReviewBench && (cd ../ReviewBench && npm ci --ignore-scripts)

# 1. Check out the 25-PR test set (or --manifest evals/reviewbench/fresh-sample.json --work <another dir>).
python3 evals/reviewbench/prepare.py --bench ../ReviewBench

# 2. Review. Claude Code must be installed and signed in.
node evals/reviewbench/review.mjs --out answers/bugs --lens bugs --runs 5
node evals/reviewbench/review.mjs --out answers/broad --lens breadth --runs 2
node evals/reviewbench/review.mjs --out answers/broad-sonnet --lens breadth --runs 2 --model claude-sonnet-5-5

# 3. One pool per kind of pass.
node evals/reviewbench/findings.mjs --answers answers/bugs --runs 1,2,3,4,5 --out pools/bugs
node evals/reviewbench/findings.mjs --answers answers/broad --runs 1,2 --out pools/broad
node evals/reviewbench/findings.mjs --answers answers/broad-sonnet --runs 1,2 --out pools/broad-sonnet

# 4. Judge each pool with Claude Sonnet 5, the benchmark's judge model, served through Claude Code.
python3 evals/martian/claude_judge_bridge.py --port 8795 --effort low &
export PI_CODING_AGENT_DIR="$(mktemp -d)" && cp evals/reviewbench/judge-models.json "$PI_CODING_AGENT_DIR/models.json"
for pool in bugs broad broad-sonnet; do
  (cd ../ReviewBench && npx tsx "$OLDPWD/evals/reviewbench/judge.ts" --bench . --pool "$OLDPWD/pools/$pool" \
    --provider claude-cli --model claude-sonnet-5)
done

# 5. Compose and score mixes.
python3 evals/reviewbench/analyze.py --pool bugs=pools/bugs --pool broad=pools/broad --pool broad-sonnet=pools/broad-sonnet \
  --mix bugs=1 --mix bugs=5 --mix broad=1 --mix bugs=1,broad=1 --mix bugs=1,broad-sonnet=2 --out results.json
```

To score exactly what the adapter writes for one configuration, build its findings from the saved answers and judge that directory:

```sh
node evals/reviewbench/findings.mjs --engine bugs=answers/bugs:1,breadth=answers/broad:1 --out engine/bugs1-broad1
(cd ../ReviewBench && npx tsx "$OLDPWD/evals/reviewbench/judge.ts" --bench . --pool "$OLDPWD/engine/bugs1-broad1" \
  --provider claude-cli --model claude-sonnet-5)
```

## All 219 pull requests

`full-run.json` fixes the setup of the run over the whole benchmark. The steps are the ones above with `prepare.py --full`, one run of each kind of pass, and the adapter's findings for each configuration. `report.py` then writes the scores and [`scripts/render-reviewbench-chart.mjs`](../../scripts/render-reviewbench-chart.mjs) draws them beside the leaderboard.

```sh
python3 evals/reviewbench/prepare.py --bench ../ReviewBench --full --work work
node evals/reviewbench/review.mjs --work work --out answers/bugs --lens bugs
node evals/reviewbench/review.mjs --work work --out answers/broad --lens breadth
node evals/reviewbench/findings.mjs --work work --engine bugs=answers/bugs:1 --out engine/default
node evals/reviewbench/findings.mjs --work work --engine bugs=answers/bugs:1,breadth=answers/broad:1 --out engine/thorough
# Judge engine/default and engine/thorough as in step 4, then:
python3 evals/reviewbench/report.py --bench ../ReviewBench --scored default=engine/default --scored thorough=engine/thorough \
  --subset test_set=../ReviewBench/corpus/test/test.json --subset fresh_sample=evals/reviewbench/fresh-sample.json \
  --answers default=answers/bugs --answers thorough=answers/bugs,answers/broad --out evals/reviewbench/results/full-run.json
node scripts/render-reviewbench-chart.mjs
```

## What is scored

Grounded precision is the share of matched findings whose golden finding is labelled a true positive. Grounded recall is the share of true-positive golden findings that some finding covers. A finding that matches no golden finding counts neither for nor against precision, and a repeat of a matched finding does not count twice. The leaderboard ranks by grounded F1.

ReviewBench also reports "augmented" metrics, for which a tool-calling judge classifies the unmatched findings. `judge.ts` skips that step, so these scripts report grounded metrics only.
