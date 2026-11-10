"""Image-owned watchdog survives loss of the orchestrator process."""

import json
import os
import re
import shutil
import signal
import subprocess
from pathlib import Path
from xml.etree import ElementTree

SOURCE = Path("/input/workspace")
# Maven writes target/ and a local repository, so Maven projects build in a private copy.
BUILD = Path("/tmp/build")
FRAME = re.compile(r"^\s*at ([\w$.]+)\.[\w$<>]+\(([\w$]+\.java):(\d+)\)", re.MULTILINE)


def source_frame(build, line):
    """Map a Java stack frame to /input/workspace/<path>:<line> when it is in main sources."""
    match = FRAME.match(line)
    if not match:
        return line.strip()
    class_name, file_name, number = match.groups()
    package = class_name.rsplit(".", 1)[0].replace(".", "/") if "." in class_name else ""
    for path in build.glob(f"**/src/main/java/{package}/{file_name}"):
        return f"{SOURCE / path.relative_to(build)}:{number}"
    return line.strip()


def surefire_report(build):
    """Summarize Surefire XML reports: test count plus each failed or erroring test."""
    tests, problems = 0, []
    for report in sorted(build.glob("**/target/surefire-reports/TEST-*.xml")):
        suite = ElementTree.parse(report).getroot()
        tests += int(suite.get("tests", "0"))
        for case in suite.iter("testcase"):
            for kind in ("failure", "error"):
                for problem in case.findall(kind):
                    lines = (problem.text or "").splitlines()
                    trace = [line for line in lines if line.strip().startswith("at ")]
                    problems.append(
                        {
                            "test": f"{case.get('classname')}.{case.get('name')}",
                            "kind": kind,
                            "type": problem.get("type", ""),
                            "message": (problem.get("message") or "")[:500],
                            "frames": [source_frame(build, line) for line in trace[:10]],
                        }
                    )
    return {"tests": tests, "problems": problems}


with open("/input/evidence/command.json") as source:
    command = json.load(source)
maven = (SOURCE / "pom.xml").is_file()
environment = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "PYTHONPATH": "/input/workspace",
    "PYTHONDONTWRITEBYTECODE": "1",
}
workspace = SOURCE
if maven:
    workspace = shutil.copytree(SOURCE, BUILD)
    environment |= {
        "HOME": "/tmp",
        "JAVA_HOME": "/opt/java/openjdk",
        "MAVEN_ARGS": "--offline --batch-mode --no-transfer-progress "
        "-Dmaven.repo.local=/tmp/m2 -Dmaven.repo.local.tail=/opt/maven-repo",
        "MAVEN_OPTS": "-XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xss1m",
    }
process = subprocess.Popen(command, cwd=workspace, start_new_session=True, env=environment)
try:
    status = process.wait(timeout=30)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    print("execution deadline exceeded", flush=True)
    raise SystemExit(124)
if maven:
    # Printed last, after the build exits, so test output cannot follow it.
    print("SUREFIRE " + json.dumps(surefire_report(BUILD)), flush=True)
raise SystemExit(status)
