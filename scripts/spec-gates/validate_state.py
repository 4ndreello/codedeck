#!/usr/bin/env python3
"""validate_state.py - deterministic completion gate for a feature.

Adapted for CodeDeck from the tlc-spec-driven skill (Felipe Rodrigues,
github.com/felipfr, CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/).
Changes from the original: invocation from the repo root as
`python3 scripts/spec-gates/validate_state.py`; gate logic unchanged
(a done feature must have a real PASS validation.md with file:line
evidence, because our validation.md already follows that shape).

It does NOT merely check that validation.md exists: a report that is
empty, still holds the template placeholder, or has no evidence fails.

Operates only on the .specs/ markdown artifacts. No dependencies. Run
from the project root (the dir that contains .specs/).
Meant as the closing gate of Execute - not a manual step.

Usage:
  python3 scripts/spec-gates/validate_state.py [feature]

Run from the repo root. feature is a bare feature name (never a path).

Exit codes: 0 ok, 1 a completed feature is missing a real PASS report,
            2 usage error.
"""

import argparse
import os
import re
import sys

# A file:line citation: a path with an extension, then :<line>. e.g. src/a.ts:42
EVIDENCE_RE = re.compile(r"[\w./-]+\.[A-Za-z0-9]+:\d+")


def _read_text_file(path, root):
    """Read a UTF-8 text file, refusing paths that escape root.

    Every file these gates open must live under the repo you run from. An agent passing a faulty absolute path gets a clean
    usage error, never foreign content. Exits 2 on refusal.
    """
    base = os.path.realpath(root)
    target = os.path.realpath(path)
    if os.path.commonpath([base, target]) != base:
        print(f"refusing to read outside project root {base}: {path}", file=sys.stderr)
        raise SystemExit(2)
    if not os.path.isfile(target):
        print(f"not a file: {path}", file=sys.stderr)
        raise SystemExit(2)
    with open(target, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _verdict(text):
    """Return 'pass', 'fail', 'unfilled', or None from a validation report."""
    lines = text.splitlines()
    candidates = [
        ln for ln in lines
        if re.search(r"^#{1,4}\s*validation\b", ln.strip(), re.IGNORECASE)
        or re.search(r"\*{0,2}result\*{0,2}\s*:", ln.strip(), re.IGNORECASE)
    ]
    hay = " ".join(candidates) if candidates else text
    has_pass = re.search(r"\bPASS\b", hay) is not None
    has_fail = re.search(r"\bFAIL\b", hay) is not None
    if has_pass and has_fail:
        # Both present on the verdict line = unfilled template "[PASS | FAIL]".
        return "unfilled"
    if has_pass:
        return "pass"
    if has_fail:
        return "fail"
    return None


def _appears_complete(fdir, root):
    """Conservative completeness heuristic for the cross-check mode."""
    if os.path.exists(os.path.join(fdir, "validation.md")):
        return True
    tasks = os.path.join(fdir, "tasks.md")
    if not os.path.exists(tasks):
        return False
    body = _read_text_file(tasks, root)
    if not re.search(r"^#{2,4}\s+T\d+\s*:", body, re.MULTILINE):
        return False
    if re.search(r"^\s*-\s*\[\s\]", body, re.MULTILINE):
        return False  # unchecked box remains -> still in progress
    return True


def _check_feature(fdir, name, root):
    """Return list of error strings for one feature (empty = pass)."""
    errors = []
    vpath = os.path.join(fdir, "validation.md")
    if not os.path.exists(vpath):
        errors.append(
            f"{name}: no validation.md - Execute is not done until validation "
            f"is written and independent. Dispatch validation before marking done."
        )
        return errors
    text = _read_text_file(vpath, root)
    verdict = _verdict(text)
    if verdict is None:
        errors.append(f"{name}: validation.md has no PASS/FAIL verdict (a prose-only report does not count)")
    elif verdict == "unfilled":
        errors.append(f"{name}: validation.md verdict is still the template placeholder '[PASS | FAIL]' - not filled")
    elif verdict == "fail":
        errors.append(f"{name}: validation.md verdict is FAIL - route the ranked gaps to fix tasks, then re-verify (feature is not done)")
    if verdict == "pass" and not EVIDENCE_RE.search(text):
        errors.append(f"{name}: validation.md is PASS but cites no file:line evidence - evidence-or-zero not satisfied")
    return errors


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
FEATURES_DIR = os.path.join(".specs", "features")


def _resolve(feature):
    base = FEATURES_DIR
    if feature is not None and not NAME_RE.match(feature):
        print(f"validate_state: pass a feature name (letters, digits, '-' and '_'), not a path: {feature!r}", file=sys.stderr)
        raise SystemExit(2)
    if not os.path.isdir(base):
        print(f"validate_state: no {base} directory - nothing to check.")
        return []
    # Names only: directories below come from the listing, so no
    # caller-controlled text reaches the filesystem.
    entries = sorted(os.listdir(base))
    dirs = [e for e in entries if os.path.isdir(os.path.join(base, e))]
    if feature:
        # An explicit target is always honored; otherwise the gate would
        # silently pass ("nothing to check") on exactly the feature named.
        match = next((e for e in dirs if e == feature), None)
        if match is None:
            print(f"validate_state: feature not found: {feature}", file=sys.stderr)
            raise SystemExit(2)
        return [(os.path.join(base, match), match)]
    if len(dirs) == 1:
        return [(os.path.join(base, dirs[0]), dirs[0])]
    if not dirs:
        print("validate_state: no features under .specs/features/ - nothing to check.")
        return []
    root = os.path.abspath(".")
    picked = [(os.path.join(base, d), d) for d in dirs if _appears_complete(os.path.join(base, d), root)]
    if not picked:
        print("validate_state: no completed feature detected (all in progress) - nothing to gate.")
    return picked


def main(argv=None):
    p = argparse.ArgumentParser(prog="validate_state.py", description="Deterministic completion gate: a done feature must have a real PASS validation report.")
    p.add_argument("feature", nargs="?", default=None, help="Feature name (default: sole feature, else cross-check all completed)")
    args = p.parse_args(argv)
    root = os.path.abspath(".")

    targets = _resolve(args.feature)
    all_errors = []
    for fdir, name in targets:
        all_errors += _check_feature(fdir, name, root)

    for e in all_errors:
        print(f"  ERROR {e}")
    n = len(all_errors)
    checked = ", ".join(name for _, name in targets) or "(none)"
    print(f"\nvalidate_state: {n} error(s) across [{checked}]")
    return 1 if n else 0


if __name__ == "__main__":
    raise SystemExit(main())
