import subprocess
from command import command_for_revision

def show_revision(revision: str):
    return subprocess.run(command_for_revision(revision), check=True, capture_output=True)
