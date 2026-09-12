#!/usr/bin/env python3
"""Apply a separately pinned evaluator's unchanged scorer to paired development results."""
import argparse,json,math,statistics,sys,importlib.util,hashlib
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--evaluator',required=True)
p.add_argument('--report',required=True)
p.add_argument('--regressions',required=True)
p.add_argument('--out',required=True)
a=p.parse_args()
if Path(a.out).exists():raise SystemExit('preserve existing scoring output')
sys.path.insert(0,str(Path(a.evaluator)/'src'))
from agent_eval.external_review_eval import parse_review_output,score_review_output,score_to_grade,DEFAULT_THRESHOLD
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
strict_gates={}
gate_script=Path(a.evaluator)/'scripts/record_review_eval.py'
if not gate_script.exists():raise SystemExit('the pinned evaluator must include scripts/record_review_eval.py')
spec=importlib.util.spec_from_file_location('pinned_gate',gate_script)
gate_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate_module)
corpus=gate_module._load(Path(a.evaluator)/'benchmarks/reviewer-corpus/v1/corpus.yaml')
for variant in ['baseline','candidate']:
 selected=[]
 for row,raw in zip(records,report['records'],strict=True):
  if row['variant']!=variant or row['cohort']!='familiar-development':continue
  final=row['final'];outcome='infra_error' if not final['valid'] else 'accepted' if final['accepted'] else 'rejected'
  selected.append({'case_id':row['case_id'],'trial':row['trial'],'outcome':outcome,'score':final.get('score'),'first_attempt':{'outcome':outcome,'output':raw['output'],'deterministic':final},'corrected_attempt':None})
 average=sum(r['score'] or 0 for r in selected)/len(selected)
 converted={'corpus_id':corpus['corpus_id'],'corpus_version':corpus['version'],'grade':score_to_grade(average),'results':selected}
 converted_path=Path(a.out).with_name(Path(a.out).stem+f'-{variant}-strict-input.json')
 converted_path.write_text(json.dumps(converted,indent=2)+'\n');converted_path.chmod(0o600)
 markdown=gate_module.build_record(converted_path,Path(a.evaluator)/'benchmarks/reviewer-corpus/v1/corpus.yaml',Path(a.evaluator)/'benchmarks/reviewer-corpus/v1/benchmark.yaml',model='model-gateway/reviewer',evaluator_commit='048a8d498085e3d371ecf6008b9c2018b0f27112',reviewer_commit=report[variant]['commit'])
 strict_gates[variant]={'passed':'**Release gate: PASS**' in markdown,'record':markdown,'gate_source_sha256':hashlib.sha256(gate_script.read_bytes()).hexdigest()}
result={'evaluator_threshold':DEFAULT_THRESHOLD,'summary':summary,'strict_gates':strict_gates,'records':records}
Path(a.out).write_text(json.dumps(result,indent=2)+'\n');Path(a.out).chmod(0o600)
print(json.dumps(summary,indent=2))
