import shlex

def command_for_revision(revision: str):
    return f"git show {shlex.quote(revision)}"
