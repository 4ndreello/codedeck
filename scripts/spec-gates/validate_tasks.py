#!/usr/bin/env python3
"""validate_tasks.py - deterministic pre-approval checks for a feature tasks.md.

Adapted for CodeDeck from the tlc-spec-driven skill (Felipe Rodrigues,
github.com/felipfr, CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/).
Changes from the original: invocation from the repo root as
`python3 scripts/spec-gates/validate_tasks.py`; check logic unchanged
because our tasks.md already follows the same shape (Test Coverage Matrix,
Gate Check Commands, Execution Plan, Task Breakdown, T-tasks with Tests
plus Gate, Depends on, fenced phase diagrams); every file read is confined
under the repo root (path-injection guard).

What it checks (heuristic markdown inspection, not a full parser):
  ERROR  - a required section is missing
  ERROR  - a task is missing its `Tests` or `Gate` field
  ERROR  - a task depends on a task in a LATER phase (dependencies point back only)
  ERROR  - a dependency edge shown in the diagram has no matching `Depends on`
           (and vice-versa) when both sides are parseable
  WARN   - a task's `Where` names multiple files (granularity smell -> split it)
  WARN   - a task says `Tests: none` (confirm the coverage matrix agrees)
  WARN   - the diagram could not be parsed confidently (cross-check skipped)

Usage:
  python3 scripts/spec-gates/validate_tasks.py [feature] [--strict]

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


REQUIRED_SECTIONS = ["Test Coverage Matrix", "Gate Check Commands", "Execution Plan", "Task Breakdown"]
TASK_RE = re.compile(r"^#{2,4}\s+(T\d+)\s*:", re.IGNORECASE)
EDGE_RE = re.compile(r"\bT\d+\b")
FILE_HINT_RE = re.compile(r"[\w./-]+\.\w{1,6}\b")


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
FEATURES_DIR = os.path.join(".specs", "features")


def resolve_tasks(target):
    """Return the tasks.md path for a feature NAME. Run from the repo root.

    Names only, never paths: the returned path is built from a
    directory-listing entry, so no caller-controlled text reaches the
    filesystem.
    """
    if target is not None and not NAME_RE.match(target):
        print(f"validate_tasks: pass a feature name (letters, digits, '-' and '_'), not a path: {target!r}", file=sys.stderr)
        raise SystemExit(2)
    if not os.path.isdir(FEATURES_DIR):
        return None
    entries = sorted(os.listdir(FEATURES_DIR))
    if target is None:
        with_tasks = [e for e in entries if os.path.isfile(os.path.join(FEATURES_DIR, e, "tasks.md"))]
        if len(with_tasks) == 1:
            return os.path.join(FEATURES_DIR, with_tasks[0], "tasks.md")
        if not with_tasks:
            return None
        raise SystemExit(
            "validate_tasks: multiple features found; pass one explicitly:\n  "
            + "\n  ".join(with_tasks)
        )
    match = next((e for e in entries if e == target), None)
    if match is None or not os.path.isfile(os.path.join(FEATURES_DIR, match, "tasks.md")):
        return None
    return os.path.join(FEATURES_DIR, match, "tasks.md")


def section_present(lines, name):
    return any(re.match(r"^#{1,4}\s+" + re.escape(name) + r"\b", ln.strip()) for ln in lines)


def parse_tasks(lines):
    """Return a dict: task_id -> {'deps': set, 'tests': str|None, 'gate': str|None, 'where': str}."""
    tasks = {}
    current = None
    for ln in lines:
        m = TASK_RE.match(ln.strip())
        if m:
            current = m.group(1).upper()
            tasks[current] = {"deps": set(), "tests": None, "gate": None, "where": ""}
            continue
        if current is None:
            continue
        stripped = ln.strip()
        dm = re.match(r"^\*{0,2}Depends on\*{0,2}\s*:\s*(.*)$", stripped, re.IGNORECASE)
        if dm:
            body = dm.group(1)
            if "none" not in body.lower():
                for e in EDGE_RE.findall(body.upper()):
                    tasks[current]["deps"].add(e)
        wm = re.match(r"^\*{0,2}Where\*{0,2}\s*:\s*(.*)$", stripped, re.IGNORECASE)
        if wm:
            tasks[current]["where"] = wm.group(1)
        tm = re.match(r"^\*{0,2}Tests\*{0,2}\s*:\s*(.*)$", stripped, re.IGNORECASE)
        if tm:
            tasks[current]["tests"] = tm.group(1).strip()
        gm = re.match(r"^\*{0,2}Gate\*{0,2}\s*:\s*(.*)$", stripped, re.IGNORECASE)
        if gm:
            tasks[current]["gate"] = gm.group(1).strip()
    return tasks


def parse_phase_membership(lines):
    """Map task_id -> phase index, read from '### Phase N' headers."""
    membership = {}
    phase_idx = 0
    in_phase = False
    for ln in lines:
        pm = re.match(r"^#{2,4}\s+Phase\s+(\d+)", ln.strip(), re.IGNORECASE)
        if pm:
            phase_idx = int(pm.group(1))
            in_phase = True
            continue
        if in_phase:
            # Map only on task headers (### Tn:), never on mere references.
            hm = TASK_RE.match(ln.strip())
            if hm:
                membership[hm.group(1).upper()] = phase_idx
    return membership


def parse_diagram_edges(lines):
    """Best-effort: parse 'Tx -> Ty' arrow chains from fenced blocks."""
    edges = set()
    in_fence = False
    found_any_arrow = False
    for ln in lines:
        if ln.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            continue
        norm = ln.replace("→", "->").replace("──", "-").replace("-", "-")
        if "->" not in norm:
            continue
        segments = [s for s in re.split(r"->", norm)]
        seq = []
        for seg in segments:
            ids = EDGE_RE.findall(seg.upper())
            seq.append(ids[-1] if ids else None)
        for a, b in zip(seq, seq[1:]):
            if a and b:
                edges.add((a, b))
                found_any_arrow = True
    return edges, found_any_arrow


def check(tasks_path, root):
    lines = _read_text_file(tasks_path, root).splitlines()
    errors, warnings = [], []

    for name in REQUIRED_SECTIONS:
        if not section_present(lines, name):
            errors.append(f"missing required section: ## {name}")

    tasks = parse_tasks(lines)
    if not tasks:
        warnings.append("no tasks (### T1: ...) parsed - is this file filled in?")
        return errors, warnings

    for tid, t in tasks.items():
        if t["tests"] is None:
            errors.append(f"{tid}: missing `Tests` field")
        elif t["tests"].lower().startswith("none"):
            warnings.append(f"{tid}: Tests: none - confirm the Test Coverage Matrix says 'none' for this layer")
        if t["gate"] is None:
            errors.append(f"{tid}: missing `Gate` field")
        files = FILE_HINT_RE.findall(t["where"])
        if len(set(files)) > 1:
            warnings.append(f"{tid}: `Where` names multiple files {sorted(set(files))} - granularity smell, consider splitting")

    membership = parse_phase_membership(lines)
    for tid, t in tasks.items():
        p_here = membership.get(tid)
        if p_here is None:
            continue
        for dep in t["deps"]:
            p_dep = membership.get(dep)
            if p_dep is not None and p_dep > p_here:
                errors.append(f"{tid} (phase {p_here}) depends on {dep} (phase {p_dep}) - dependencies must point backward or within the same phase")

    edges, parsed = parse_diagram_edges(lines)
    if not parsed:
        warnings.append("diagram arrows not parsed confidently - diagram/definition cross-check skipped (verify by hand)")
    else:
        def intra_phase(a, b):
            pa, pb = membership.get(a), membership.get(b)
            if pa is None or pb is None:
                return True
            return pa == pb

        dep_edges = set()
        for tid, t in tasks.items():
            for dep in t["deps"]:
                dep_edges.add((dep, tid))
        only_in_diagram = {(a, b) for (a, b) in (edges - dep_edges) if intra_phase(a, b)}
        only_in_defs = {(a, b) for (a, b) in (dep_edges - edges) if intra_phase(a, b)}
        for a, b in sorted(only_in_diagram):
            if a in tasks and b in tasks:
                errors.append(f"diagram shows {a} -> {b} but {b} has no matching `Depends on: {a}`")
        for a, b in sorted(only_in_defs):
            errors.append(f"{b} declares `Depends on: {a}` but the diagram has no {a} -> {b} arrow")

    return errors, warnings


def main(argv=None):
    p = argparse.ArgumentParser(prog="validate_tasks.py", description="Pre-approval checks for a feature tasks.md.")
    p.add_argument("target", nargs="?", default=None)
    p.add_argument("--strict", action="store_true")
    args = p.parse_args(argv)

    tasks_path = resolve_tasks(args.target)
    if not tasks_path:
        print("validate_tasks: could not locate a tasks.md. Pass a feature name and run from the project root.", file=sys.stderr)
        return 2

    errors, warnings = check(tasks_path, os.path.abspath("."))
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  ERROR {e}")
    fail = errors or (warnings and args.strict)
    print(f"\nvalidate_tasks: {len(errors)} error(s), {len(warnings)} warning(s) in {tasks_path}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
