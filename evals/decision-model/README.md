# Decision model experiments

A decision model answers typed questions about a text with probabilities and never writes text. A reviewer that runs several passes could use one for two jobs: reject false findings, and merge findings that repeat each other. These experiments measure both on [ReviewBench](https://github.com/review-bench/ReviewBench)'s 25-PR test set with [Jev](https://typesafe.ai) (`jev-1.13.0`, measured November 13, 2026). All four runs cost $0.17 in total.

| Job | Result |
| --- | --- |
| Tell a true finding from a false one | **No.** The model scores how a finding is written. It gave the same ranking with and without the code |
| Tell that two findings describe the same problem | **Yes.** AUC 0.992 on 1,701 labelled pairs, 95% precision at 93% recall |

## Verifying a finding

The test set has 565 labelled findings: 352 true positives and 213 false positives. Each row showed the finding, the diff near it and the file near it, and asked whether the finding is a true positive.

| Scorer | AUC |
| --- | ---: |
| Jev, finding with code | 0.869 |
| Jev, finding without any code | 0.868 |
| Which tool wrote the finding (that tool's true-positive rate on the other rows) | 0.862 |
| Length of the finding | 0.717 |
| Jev, only findings written by Claude Sonnet 4.6 (185 rows) | 0.673 |
| Jev, only findings written by Gemini 2.5 Pro (85 rows) | 0.757 |

Removing the code changed the AUC by 0.001, so the model did not use the code. The labelled false positives come mostly from a few producers, and knowing the producer alone ranks the findings as well as the model does. Within one producer, the model is much weaker. Its severity answer matched ReviewBench's severity on 45% of the true positives.

On the 190 rows of the test split the model was right on 80.5% with the code and 77.9% without it, against 61.1% for always answering yes.

## Detecting duplicates

Five independent review passes of each pull request produced 603 findings. A pair is two findings from different passes in the same file. 1,701 pairs have a label from ReviewBench's matcher: both findings matched a golden finding, and the pair is "same" when they matched the same one (677 pairs).

| Scorer | AUC | Precision | Recall |
| --- | ---: | ---: | ---: |
| Jev, probability at least 0.5 | 0.992 | 95.2% | 92.8% |
| Jev, probability at least 0.7 | | 97.4% | 89.5% |
| Share of title words in common | 0.914 | | |
| Line distance | 0.838 | | |
| Rule: at most 3 lines apart | | 82.7% | 69.0% |
| Rule: at most 3 lines apart and a fifth of the title words in common (the engine's rule) | | 98.3% | 50.2% |

## Merging five passes end to end

All 2,695 pairs went to the model ($0.068, about $0.003 per pull request), and [`analyze.py`](../reviewbench/analyze.py) merged the five passes with its answers in place of the engine's rule.

| Merge rule | Findings per PR | Grounded precision | Grounded recall | F1 |
| --- | ---: | ---: | ---: | ---: |
| No merge | 24.1 | 90.6% | 39.5% | 55.0% |
| The engine's rule | 13.1 | 89.9% | 38.4% | 53.8% |
| Jev, probability at least 0.7 | 8.4 | 91.1% | 37.2% | 52.8% |

The model removed 65% of the findings as repeats, where the rule removed 46%, and it cost 1.2 points of recall against the rule. Each merged group keeps one write-up, and the matcher ties one write-up to fewer golden findings than several. ReviewBench does not count repeats against precision, so its score does not reward the shorter review. A person who reads 8 comments instead of 13 does.

The engine keeps its rule, which needs no extra service. The model is the better merger when a review must be short.

## Reproduce

[jev-bench](https://github.com/wuchris-ch/jev-bench) sends a task folder to the model and needs `TYPESAFE_API_KEY`. The pools come from [`evals/reviewbench`](../reviewbench/README.md).

```sh
python3 evals/decision-model/build_tasks.py verify --bench <ReviewBench clone> --out tasks/verify
python3 evals/decision-model/build_tasks.py verify --bench <ReviewBench clone> --out tasks/verify-text-only --text-only
python3 evals/decision-model/build_tasks.py duplicates --pool <bugs pool> --out tasks/duplicates
python3 evals/decision-model/build_tasks.py duplicates --pool <bugs pool> --out tasks/duplicates-all --all-pairs
python3 -m jev_bench run tasks/verify            # from a jev-bench clone, once per task folder

python3 evals/decision-model/summarize.py --verify tasks/verify --verify-text-only tasks/verify-text-only \
  --duplicates tasks/duplicates --out evals/decision-model/results/summary.json
python3 evals/reviewbench/analyze.py --pool bugs=<bugs pool> --mix bugs=2 --mix bugs=3 --mix bugs=5 \
  --same-issue bugs=tasks/duplicates-all/results/<run>.jsonl --out evals/decision-model/results/merge-with-decision-model.json
```

Numbers: [`results/summary.json`](results/summary.json) and [`results/merge-with-decision-model.json`](results/merge-with-decision-model.json). Task rows contain review text and source code, so they stay out of the repository.
