import os
import subprocess
from command import command_for_revision

def show_revision(revision: str):
    if os.name != "posix":
        raise RuntimeError("This command runner requires POSIX")
    return subprocess.run(command_for_revision(revision), shell=True, check=True, capture_output=True)
