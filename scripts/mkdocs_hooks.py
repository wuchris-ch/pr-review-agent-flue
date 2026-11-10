"""MkDocs hooks that publish the repository's Markdown docs as one site.

The site source is docs/, but a few pages live elsewhere in the repository,
such as the root README. This hook adds those pages to the site and rewrites
relative links so that every link works on the published site:

- A link to a published page points to that page.
- A link to another file in docs/ (an image, a JSON sample) stays relative.
- A link to anything else, such as source code, points to GitHub.

A link to a path that does not exist stays as written, so a strict build
still reports it.
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path

from mkdocs.structure.files import File

REPOSITORY_URL = "https://github.com/wuchris-ch/pr-review-agent-flue"
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent

# Pages outside docs/: repository path -> path on the site.
EXTRA_PAGES = {
    "README.md": "index.md",
    "CONTRIBUTING.md": "contributing.md",
    "examples/README.md": "examples.md",
    "evals/README.md": "evaluation.md",
    "integrations/github-app/README.md": "guides/github-app.md",
}
SITE_TO_REPOSITORY = {site: repository for repository, site in EXTRA_PAGES.items()}

# The target of an inline Markdown link or image when it is a relative path.
# Matching from "](" handles badges, which are images wrapped in links.
RELATIVE_LINK = re.compile(r"(\]\()(?!https?:|mailto:|#|/)([^)\s]+)(\))")


def on_files(files, config):
    for repository_path, site_path in EXTRA_PAGES.items():
        files.append(
            File.generated(
                config,
                site_path,
                abs_src_path=str(REPOSITORY_ROOT / repository_path),
            )
        )
    return files


def repository_path_of(site_path: str) -> str:
    return SITE_TO_REPOSITORY.get(site_path, f"docs/{site_path}")


def site_link(target: str, page_repository_path: str, page_site_path: str) -> str:
    path, _, anchor = target.partition("#")
    suffix = f"#{anchor}" if anchor else ""
    repository_target = posixpath.normpath(
        posixpath.join(posixpath.dirname(page_repository_path), path)
    )
    if not (REPOSITORY_ROOT / repository_target).exists():
        return target
    if repository_target in EXTRA_PAGES:
        site_target = EXTRA_PAGES[repository_target]
    elif repository_target.startswith("docs/") and (REPOSITORY_ROOT / repository_target).is_file():
        site_target = repository_target.removeprefix("docs/")
    else:
        kind = "tree" if (REPOSITORY_ROOT / repository_target).is_dir() else "blob"
        return f"{REPOSITORY_URL}/{kind}/main/{repository_target}{suffix}"
    relative = posixpath.relpath(site_target, posixpath.dirname(page_site_path) or ".")
    return f"{relative}{suffix}"


def on_page_markdown(markdown, page, config, files):
    site_path = page.file.src_uri
    repository_path = repository_path_of(site_path)
    return RELATIVE_LINK.sub(
        lambda match: match.group(1)
        + site_link(match.group(2), repository_path, site_path)
        + match.group(3),
        markdown,
    )
