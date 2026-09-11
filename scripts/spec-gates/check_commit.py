#!/usr/bin/env python3
"""check_commit.py - deterministic commit-message validation.

Adapted for CodeDeck from the tlc-spec-driven skill (Felipe Rodrigues,
github.com/felipfr, CC-BY-4.0, https://creativecommons.org/licenses/by/4.0/).
Changes from the original: commit types extended to the ones this repo uses
(ref, meta, license, revert); the description must start UPPERCASE (our
convention capitalizes it); the length warning follows our 70-char subject
rule; the message arrives via --message or stdin, never via a file path,
so no caller-controlled text reaches the filesystem. Pure standard
library, zero dependencies.

It reads the message from --message or stdin. As a git `commit-msg` hook,
wrap the call:

    #!/bin/sh
    exec python3 scripts/spec-gates/check_commit.py --message "$(cat "$1")"

What it checks:
  ERROR  - header does not match  type(scope): description
  ERROR  - type is not one of the repo's commit types
  ERROR  - description is empty, starts lowercase, or ends with a period
  ERROR  - `!` breaking marker present but no `BREAKING CHANGE:` footer
  WARN   - header longer than 70 characters

Usage:
  python3 scripts/spec-gates/check_commit.py --message "feat(auth): Add email validation"
  echo "fix(cart): Prevent negative quantity" | python3 scripts/spec-gates/check_commit.py

Exit codes: 0 pass, 1 violation, 2 usage error.
"""

import argparse
import re
import sys

TYPES = ["feat", "fix", "ref", "perf", "docs", "test", "style", "build", "ci", "chore", "meta", "license", "revert"]
HEADER_RE = re.compile(r"^(?P<type>\w+)(?:\((?P<scope>[^)]+)\))?(?P<bang>!)?: (?P<desc>.+)$")


def read_message(args):
    # Text only, never a file path: the message arrives via --message or
    # stdin, so no caller-controlled text reaches the filesystem. A git
    # hook wraps the call, e.g.:
    #   exec python3 scripts/spec-gates/check_commit.py --message "$(cat "$1")"
    if args.message is not None:
        return args.message
    if args.msgfile:
        print("check_commit: pass the message via --message or stdin, not a file path.", file=sys.stderr)
        raise SystemExit(2)
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


def check(message):
    errors, warnings = [], []
    # Ignore comment lines (git puts '#' comments in the message file).
    lines = [ln for ln in message.splitlines() if not ln.lstrip().startswith("#")]
    while lines and not lines[0].strip():
        lines.pop(0)
    if not lines:
        return (["empty commit message"], warnings)

    header = lines[0].rstrip()
    if len(header) > 70:
        warnings.append(f"header is {len(header)} chars (>70): {header[:60]}...")

    m = HEADER_RE.match(header)
    if not m:
        errors.append(f"header does not match 'type(scope): description': {header!r}")
        return (errors, warnings)

    ctype = m.group("type")
    desc = m.group("desc")
    bang = m.group("bang")

    if ctype not in TYPES:
        errors.append(f"type '{ctype}' is not one of: {', '.join(TYPES)}")
    if not desc.strip():
        errors.append("description is empty")
    else:
        if desc[:1].islower():
            errors.append(f"description should start uppercase: '{desc[:30]}'")
        if desc.rstrip().endswith("."):
            errors.append("description should not end with a period")

    body = "\n".join(lines[1:])
    breaking_footer = bool(re.search(r"^BREAKING CHANGE:", body, re.MULTILINE))
    if bang and not breaking_footer:
        errors.append("'!' breaking marker present but no 'BREAKING CHANGE:' footer")

    return (errors, warnings)


def main(argv=None):
    p = argparse.ArgumentParser(prog="check_commit.py", description="Validate a commit message.")
    p.add_argument("msgfile", nargs="?", default=None, help="path to a commit message file (as git passes to commit-msg)")
    p.add_argument("--message", default=None, help="the commit message as a string")
    args = p.parse_args(argv)

    message = read_message(args)
    if not message.strip():
        print("check_commit: no message provided (pass a file, --message, or pipe via stdin).", file=sys.stderr)
        return 2

    errors, warnings = check(message)
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  ERROR {e}")
    if errors:
        print("\ncheck_commit: FAIL")
        return 1
    print("check_commit: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
