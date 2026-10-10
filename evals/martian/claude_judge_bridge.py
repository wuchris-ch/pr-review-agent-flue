#!/usr/bin/env python3
"""Serve a Claude model as a second judge for judge.py.

Exposes a loopback, non-streaming OpenAI-compatible /v1/chat/completions endpoint and answers
each request with `claude -p` with every tool turned off, so the judge model only reads the
prompt. Claude Code must be installed and signed in.

    python3 evals/martian/claude_judge_bridge.py --port 8792 &
    export JUDGE_BASE_URL=http://127.0.0.1:8792/v1 JUDGE_API_KEY=local
    python3 evals/martian/judge.py --model claude-sonnet-5-5 --out evals/martian/runs/sonnet/mine ...
"""
import argparse
import json
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--port", type=int, default=8792)
parser.add_argument("--concurrency", type=int, default=8)
parser.add_argument("--timeout", type=int, default=900, help="seconds for one judge call")
args = parser.parse_args()
slots = threading.BoundedSemaphore(args.concurrency)
scratch = tempfile.mkdtemp(prefix="claude-judge-")


def text_of(content) -> str:
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content if isinstance(content, str) else ""


def complete(body: dict) -> str:
    messages = body.get("messages", [])
    system = "\n\n".join(text_of(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
    user = "\n\n".join(text_of(m.get("content")) for m in messages if m.get("role") not in ("system", "developer"))
    if (body.get("response_format") or {}).get("type") == "json_object":
        system = (system + "\n\nYour reply must be a single valid JSON object and nothing else.").strip()
    command = ["claude", "-p", "--model", body.get("model") or "claude-sonnet-5-5", "--tools", "", "--safe-mode",
               "--no-session-persistence", "--output-format", "json"]
    if body.get("reasoning_effort"):
        command += ["--effort", body["reasoning_effort"]]
    if system:
        command += ["--system-prompt", system]
    problem = "no reply"
    for attempt in range(3):
        with slots:
            try:
                done = subprocess.run(command, input=user, capture_output=True, text=True, timeout=args.timeout, cwd=scratch)
            except subprocess.TimeoutExpired:
                problem = "timeout"
                continue
        try:
            events = json.loads(done.stdout)
            events = events if isinstance(events, list) else [events]
            result = next(event for event in reversed(events) if event.get("type") == "result")
        except (ValueError, StopIteration):
            problem = f"unreadable output (exit {done.returncode})"
        else:
            if not result.get("is_error") and result.get("result"):
                return re.sub(r"^```(?:json)?\s*|\s*```$", "", result["result"].strip())
            problem = "claude reported an error"
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(problem)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self.reply(404, {"error": {"message": "not found"}})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        try:
            content = complete(body)
        except RuntimeError as error:
            return self.reply(502, {"error": {"message": str(error)}})
        self.reply(200, {"object": "chat.completion", "model": body.get("model"),
                         "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}]})


print(f"Claude judge bridge on http://127.0.0.1:{args.port}/v1", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()

