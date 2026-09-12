#!/usr/bin/env python3
"""Freeze the public development corpus and authored fixtures for a paired comparison."""
import argparse,json,sys,hashlib
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--evaluator',required=True)
p.add_argument('--out-dir',required=True)
a=p.parse_args()
evaluator=Path(a.evaluator).resolve();out=Path(a.out_dir).resolve()
if out.exists():raise SystemExit('use a new private output directory to preserve previous cohorts')
sys.path.insert(0,str(evaluator/'src'))
from agent_eval.corpus import load_corpus,validate_corpus
corpus_root=evaluator/'benchmarks/reviewer-corpus/v1'
# This path is the published development corpus, never a holdout manifest.
if not validate_corpus(corpus_root/'corpus.yaml',execute=False).valid:raise SystemExit('published development corpus validation failed')
corpus,_=load_corpus(corpus_root/'corpus.yaml')
regressions=Path(__file__).resolve().parents[1]/'examples/regressions'
references=json.loads((regressions/'manifest.json').read_text())
cases=[{'id':c.id,'source':corpus_root/c.diff,'root':corpus_root,'sha256':c.artifact_sha256[c.diff]} for c in corpus.cases]
cases += [{'id':c['id'],'source':regressions/c['diff'],'root':regressions} for c in references]
if len({c['id'] for c in cases})!=len(cases):raise SystemExit('development case IDs overlap')
out.mkdir(parents=True,mode=0o700);(out/'inputs').mkdir(mode=0o700)
manifest=[]
for c in cases:
 if not c['id'].replace('-','').isalnum():raise SystemExit('unsupported development case ID')
 source=c['source'].resolve();source.relative_to(c['root'].resolve())
 if source.suffix!='.diff':raise SystemExit('only development diff files may be sent to the reviewer')
 data=source.read_bytes()
 if 'sha256' in c and hashlib.sha256(data).hexdigest()!=c['sha256']:raise SystemExit('development source changed after validation')
 target=out/'inputs'/(c['id']+'.diff');target.write_bytes(data);target.chmod(0o600)
 manifest.append({'id':c['id'],'diff':str(target)})
for name,value in [('cases.json',manifest),('regressions.json',references)]:
 target=out/name;target.write_text(json.dumps(value,indent=2)+'\n');target.chmod(0o600)
print(f'Frozen {len(cases)} development inputs in {out}')
