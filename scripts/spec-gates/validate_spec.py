#!/usr/bin/env python3
"""validate_spec.py - deterministic closure-gate checks for a feature spec.md.

Adapted for CodeDeck from the tlc-spec-driven skill (Felipe Rodrigues,
github.com/felipfr, CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/).
Changes from the original: required sections fitted to the CodeDeck fixed
core (goal, acceptance criteria, out-of-scope); the Requirement
Traceability check was dropped (our specs do not all carry IDs); the
assumptions section matches either "Assumptions" or "Open questions";
invoked from the repo root as `python3 scripts/spec-gates/validate_spec.py`;
opened paths are built from directory listings, never from CLI text.

What it checks (heuristic markdown inspection, not a full parser):
  ERROR  - no goal section (Goal/Goals/Problem Statement)
  ERROR  - no acceptance-criteria section, or no numbered criteria in it
  ERROR  - an acceptance criterion has no SHALL (not testable)
  ERROR  - an Out of Scope section is missing
  ERROR  - an Assumptions row has an empty "Chosen default" or "Rationale"
  WARN   - an AC has SHALL but no recognizable EARS lead keyword
  WARN   - no assumptions/open-questions section at all
  WARN   - open questions are not explicitly resolved

Usage:
  python3 scripts/spec-gates/validate_spec.py [feature] [--strict]

  Run from the repo root. feature is a bare feature name under
  .specs/features/ (never a path). Omitted -> auto-detect the single
  feature.
  --strict  Treat warnings as errors.

Exit codes: 0 pass, 1 errors found (or warnings under --strict), 2 usage error.
"""

import argparse
import os
import re
import sys


from _gate_io import read_text_file as _read_text_file


GOAL_TITLES = {"goal", "goals", "problem statement"}
AC_TITLE = "acceptance criteria"
OUT_OF_SCOPE = "out of scope"

PLACEHOLDER_RE = re.compile(r"^\s*\[.+\]\s*$")


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
FEATURES_DIR = os.path.join(".specs", "features")


def resolve_spec(target):
    """Return the spec.md path for a feature NAME. Run from the repo root.

    Names only, never paths: the returned path is built from a
    directory-listing entry, so no caller-controlled text reaches the
    filesystem.
    """
    if target is not None and not NAME_RE.match(target):
        print(f"validate_spec: pass a feature name (letters, digits, '-' and '_'), not a path: {target!r}", file=sys.stderr)
        raise SystemExit(2)
    if not os.path.isdir(FEATURES_DIR):
        return None
    entries = sorted(os.listdir(FEATURES_DIR))
    if target is None:
        with_spec = [e for e in entries if os.path.isfile(os.path.join(FEATURES_DIR, e, "spec.md"))]
        if len(with_spec) == 1:
            return os.path.join(FEATURES_DIR, with_spec[0], "spec.md")
        if not with_spec:
            return None
        raise SystemExit(
            "validate_spec: multiple features found; pass one explicitly:\n  "
            + "\n  ".join(with_spec)
        )
    match = next((e for e in entries if e == target), None)
    if match is None or not os.path.isfile(os.path.join(FEATURES_DIR, match, "spec.md")):
        return None
    return os.path.join(FEATURES_DIR, match, "spec.md")


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator(line):
    return bool(re.match(r"^\s*\|?[\s:|-]+\|?\s*$", line)) and "-" in line


def find_section(lines, predicate):
    """Return (start, end) line indices for the first ## section matching."""
    start = None
    for i, ln in enumerate(lines):
        m = re.match(r"^#{1,3}\s+(.*?)\s*$", ln.strip())
        if m and predicate(m.group(1).strip().lower()):
            start = i + 1
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start, len(lines)):
        if re.match(r"^#{1,3}\s", lines[j]):
            end = j
            break
    return (start, end)


def classify_ears(text):
    """Return (ok, note). ok requires a SHALL; note records the EARS shape."""
    low = text.strip().lower()
    if not re.search(r"\bshall\b", low):
        return (False, "no SHALL")
    kws = []
    if re.search(r"\bwhile\b", low):
        kws.append("WHILE")
    if re.search(r"\bwhen\b", low):
        kws.append("WHEN")
    if re.match(r"^\s*if\b", low) or re.search(r"\bif\b.*\bthen\b", low):
        kws.append("IF/THEN")
    if re.search(r"\bwhere\b", low):
        kws.append("WHERE")
    if len(kws) >= 2:
        return (True, "complex (" + "+".join(kws) + ")")
    if kws:
        pattern = {
            "WHILE": "state-driven",
            "WHEN": "event-driven",
            "IF/THEN": "unwanted-behavior",
            "WHERE": "optional-feature",
        }[kws[0]]
        return (True, pattern)
    if re.match(r"^\s*the\b", low):
        return (True, "ubiquitous")
    return (True, "warn: SHALL present but no EARS lead keyword")


def check(spec_path, root):
    lines = _read_text_file(spec_path, root).splitlines()
    errors, warnings = [], []

    # 1. Goal section.
    if find_section(lines, lambda t: t in GOAL_TITLES) is None:
        errors.append("missing goal section (## Goal, ## Goals, or ## Problem Statement)")

    # 2. Acceptance criteria are numbered and SHALL-shaped. Criteria live
    # in a ## section or under `**Acceptance Criteria**:` labels in stories.
    ac = find_section(lines, lambda t: t == AC_TITLE)
    ranges = [range(*ac)] if ac is not None else []
    for i, ln in enumerate(lines):
        if re.match(r"^\*{0,2}Acceptance Criteria\*{0,2}\s*:?\s*$", ln.strip()):
            ranges.append(range(i + 1, len(lines)))
    items = []
    for r in ranges:
        for i in r:
            ln = lines[i]
            m = re.match(r"^\s*\d+[.)]\s+(.*)$", ln)
            if m:
                items.append((i + 1, m.group(1).strip()))
                continue
            stripped = ln.strip()
            if stripped == "":
                continue  # blank lines often sit between label and items
            if re.match(r"^#{1,3}\s", ln) or stripped.startswith("**") or stripped.startswith("```"):
                break
    # ranges can overlap (a label inside the ## section); keep first hit.
    items = list(dict.fromkeys(items))
    if not items:
        errors.append("no acceptance criteria found (## Acceptance criteria section or **Acceptance Criteria** blocks with numbered items)")
    else:
        for lineno, item in items:
            if PLACEHOLDER_RE.match(item):
                continue
            ok, note = classify_ears(item)
            if not ok:
                errors.append(f"L{lineno}: criterion has no SHALL (not testable): {item[:70]}")
            elif note.startswith("warn"):
                warnings.append(f"L{lineno}: SHALL but no EARS keyword (WHEN/WHILE/WHERE/IF or 'The ... shall'): {item[:60]}")

    # 3. Out of Scope.
    if find_section(lines, lambda t: t == OUT_OF_SCOPE) is None:
        errors.append("missing required section: ## Out of Scope")

    # 4. Assumptions / open questions.
    b = find_section(lines, lambda t: "assumption" in t or "open question" in t)
    if b is None:
        warnings.append("no Assumptions / Open questions section (ambiguities have nowhere to land)")
    else:
        rows = [lines[i] for i in range(*b) if lines[i].strip().startswith("|")]
        data = [r for r in rows if not is_separator(r)]
        if data:
            data = data[1:]  # header row
        for r in data:
            cells = split_row(r)
            if len(cells) < 3:
                continue
            assumption, chosen, rationale = cells[0], cells[1], cells[2]
            if PLACEHOLDER_RE.match(assumption) and PLACEHOLDER_RE.match(chosen):
                warnings.append("Assumptions table still contains template placeholder rows")
                continue
            if not chosen or PLACEHOLDER_RE.match(chosen):
                errors.append(f"assumption '{assumption[:40]}' has empty 'Chosen default'")
            if not rationale or PLACEHOLDER_RE.match(rationale):
                errors.append(f"assumption '{assumption[:40]}' has empty 'Rationale'")
        oq = [lines[i] for i in range(*b) if "open questions" in lines[i].lower()]
        oq_clean = re.sub(r"[*_]", "", " ".join(oq)).lower()
        if oq and not re.search(r"open questions.*:\s*none", oq_clean):
            warnings.append("open questions do not read as resolved ('Open questions: none')")

    return errors, warnings


def main(argv=None):
    p = argparse.ArgumentParser(prog="validate_spec.py", description="Closure-gate checks for a feature spec.md.")
    p.add_argument("target", nargs="?", default=None)
    p.add_argument("--strict", action="store_true")
    args = p.parse_args(argv)

    spec = resolve_spec(args.target)
    if not spec:
        print("validate_spec: could not locate a spec.md. Pass a feature name and run from the project root.", file=sys.stderr)
        return 2

    errors, warnings = check(spec, os.path.abspath("."))
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  ERROR {e}")
    fail = errors or (warnings and args.strict)
    print(f"\nvalidate_spec: {len(errors)} error(s), {len(warnings)} warning(s) in {spec}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
