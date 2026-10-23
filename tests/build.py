"""Build fixtures and render the test projects.

Usage: uv run --project ~/python-global python tests/build.py
"""

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
SITE = TESTS / "site"
FALLBACK = TESTS / "fallback"
EXT = ROOT / "_extensions"


def run(*args, cwd=None):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, args))} failed:\n{proc.stdout}\n{proc.stderr}")
    return proc.stdout + proc.stderr


def compile_fixtures():
    slides = SITE / "slides"
    slides.mkdir(exist_ok=True)
    for typ in (TESTS / "fixtures").glob("*.typ"):
        run("quarto", "typst", "compile", str(typ), str(slides / f"{typ.stem}.pdf"))
    shutil.copy(slides / "deck43.pdf", slides / "my deck.pdf")
    shutil.copy(slides / "deck169.pdf", FALLBACK / "deck.pdf")


def install_extension(project: Path):
    target = project / "_extensions"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(EXT, target)


def build():
    compile_fixtures()
    for project in (SITE, FALLBACK):
        install_extension(project)
    site_log = run("quarto", "render", cwd=SITE)
    fallback_log = run("quarto", "render", "fallback.qmd", cwd=FALLBACK)
    return site_log, fallback_log


if __name__ == "__main__":
    site_log, fallback_log = build()
    print(site_log[-3000:])
    print(fallback_log[-1500:])
