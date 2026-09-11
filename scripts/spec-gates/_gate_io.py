"""_gate_io.py - shared file reader for the spec-gate scripts.

Every gate opens only paths built from directory-listing entries, never
from CLI text; this helper adds the runtime backstop. Pure standard
library, zero dependencies. Imported by sibling scripts, so run them as
files (`python3 scripts/spec-gates/validate_spec.py ...`) with the repo
root as cwd.
"""

import os
import sys


def read_text_file(path, root):
    """Read a UTF-8 text file, refusing paths that escape root.

    Exits 2 on refusal or when the target is not a file.
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
