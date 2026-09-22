#!/usr/bin/env python3
"""Execute independent behavioral checks for the published development fixtures."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parents[1]/'examples/regressions'
checks={
 'required-error-flow': '''from batch import make_batch
assert make_batch("2") == ["0", "1"]
try: make_batch("not-a-count")
except ValueError: pass
else: raise AssertionError("required invalid configuration was silently accepted")
''',
 'optional-fallback-flow': '''from batch import make_batch
assert make_batch("2") == ["0", "1"]
assert make_batch("not-a-count") == []
''',
 'unsafe-command-flow': '''import runner,shlex
from unittest.mock import patch
payload = "HEAD; printf unsafe"
with patch.object(runner.subprocess, "run") as run:
 runner.show_revision(payload)
 command = run.call_args.args[0]
 assert run.call_args.kwargs.get("shell") is not True, "request input becomes shell syntax"
 assert command == ["git", "show", payload]
''',
 'quoted-command-flow': '''import runner,shlex
from unittest.mock import patch
for payload in ["HEAD; printf unsafe", "$(printf unsafe)", "a'b\\nc", "--output=export.txt", "--help"]:
 with patch.object(runner.subprocess, "run") as run:
  runner.show_revision(payload)
  command = run.call_args.args[0]
  args = shlex.split(command) if run.call_args.kwargs.get("shell") else command
  assert args == ["git", "show", payload], "input must stay one literal argument"
''',
}
for name,code in checks.items():
 for side in ['base','head']:
  result=subprocess.run([sys.executable,'-B','-c',code],cwd=root/name/side,capture_output=True)
  expected=1 if side=='head' and name in ['required-error-flow','unsafe-command-flow'] else 0
  if result.returncode != expected:
   raise SystemExit(f'{name}/{side}: expected exit {expected}, got {result.returncode}')
  print(f'{name}/{side}: expected behavior verified (exit {result.returncode})')
