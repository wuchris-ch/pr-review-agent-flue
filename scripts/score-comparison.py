#!/usr/bin/env python3
"""Apply a separately pinned evaluator's unchanged scorer to paired development results."""
import argparse,json,math,statistics,sys
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--evaluator',required=True)
p.add_argument('--report',required=True)
p.add_argument('--regressions',required=True)
p.add_argument('--out',required=True)
a=p.parse_args()
if Path(a.out).exists():raise SystemExit('preserve existing scoring output')
sys.path.insert(0,str(Path(a.evaluator)/'src'))
from agent_eval.external_review_eval import parse_review_output,score_review_output,DEFAULT_THRESHOLD
from agent_eval.review_benchmark import load_manifest,BenchmarkCase
manifest=load_manifest(Path(a.evaluator)/'benchmarks/reviewer-corpus/v1/benchmark.yaml')
cases={c.id:c for c in manifest.cases}
familiar=set(cases)
for c in json.loads(Path(a.regressions).read_text()):
 cases[c['id']]=BenchmarkCase.model_validate({'id':c['id'],'expected':[{'id':f'{c["id"]}-{i}','severity':f['severity'],'category':f['category'],'file':f['file'],'line_start':f['line'],'line_end':f['line']} for i,f in enumerate(c['reference_findings'])]})
report=json.loads(Path(a.report).read_text())
records=[]
for record in report['records']:
 case=cases[record['case_id']]
 result={k:record[k] for k in ['case_id','trial','variant','exit_code','latency_ms','correction_requests']}
 result['cohort']='familiar-development' if case.id in familiar else 'authored-multifile-regression'
 result['clean']=not case.expected_findings
 result['http_requests']=len(record['requests'])
 result['usage_reports']=sum(x['usage'] is not None for x in record['requests'])
 for phase in ['first_pass','final']:
  value=record.get('first_pass',{}).get('output') if phase=='first_pass' else record['output']
  if value is None or (phase=='final' and record['exit_code']!=0):
   result[phase]={'accepted':False,'valid':False};continue
  output=parse_review_output(json.dumps(value))
  score=score_review_output(case,output)
  matches_without_line=[(expected,predicted) for expected in case.expected_findings for predicted in output.findings if expected.severity==predicted.severity and expected.category==predicted.category and expected.file==predicted.file]
  result[phase]={**score.model_dump(),'accepted':score.score>=DEFAULT_THRESHOLD,'valid':True,'localization_failure':score.verdict_correct and score.false_negatives>0 and any(not (e.line_start<=f.line<=e.line_end) for e,f in matches_without_line),'blocked':output.blocked}
 records.append(result)
summary=[]
for cohort in ['familiar-development','authored-multifile-regression','all-development']:
 for variant in ['baseline','candidate']:
  rs=[r for r in records if r['variant']==variant and (cohort=='all-development' or r['cohort']==cohort)]
  if not rs:continue
  latency=sorted(r['latency_ms'] for r in rs)
  summary.append({'cohort':cohort,'variant':variant,'evaluations':len(rs),'accepted':sum(r['final']['accepted'] for r in rs),'first_pass_accepted':sum(r['first_pass']['accepted'] for r in rs),'invalid_final':sum(not r['final']['valid'] for r in rs),'clean_cases':sum(r['clean'] for r in rs),'clean_passes':sum(r['clean'] and r['final']['accepted'] for r in rs),'localization_failures':sum(r['final'].get('localization_failure',False) for r in rs),'wrong_block_decisions':sum(r['final']['valid'] and not r['final']['verdict_correct'] for r in rs),'correction_requests':sum(r['correction_requests'] for r in rs),'corrections_to_acceptance':sum(not r['first_pass']['accepted'] and r['final']['accepted'] for r in rs),'http_requests':sum(r['http_requests'] for r in rs),'usage_reports':sum(r['usage_reports'] for r in rs),'median_latency_ms':statistics.median(latency),'p95_latency_ms':latency[math.ceil(.95*len(latency))-1]})
result={'evaluator_threshold':DEFAULT_THRESHOLD,'summary':summary,'records':records}
Path(a.out).write_text(json.dumps(result,indent=2)+'\n');Path(a.out).chmod(0o600)
print(json.dumps(summary,indent=2))
