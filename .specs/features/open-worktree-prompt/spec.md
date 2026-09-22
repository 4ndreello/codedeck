# Open worktree prompt

- OWP-01: For an interactive `open` without worktree flags or `--resume`, ask once after role resolution and before starting the daemon when cwd is in a git repository.
- OWP-02: A trimmed, case-insensitive `y` or `yes` enables `opts.worktree` and follows the existing `--worktree` launch path.
- OWP-03: An empty answer, `n`, or `no` continues without a worktree.
- OWP-04: Any other answer prints `Answer y or n.` to stderr and asks again.
- OWP-05: EOF rejects with `Worktree selection was interrupted; nothing was launched.` before the daemon starts or a session is adopted.
- OWP-06: `--worktree` skips the question and opens in a worktree.
- OWP-07: `--no-worktree` skips the question and opens in the current directory; omitting both flags leaves the option undefined.
- OWP-08: Non-interactive launches, including no-TTY and `-p`/`--print`, do not ask and do not use a worktree by default.
- OWP-09: A cwd outside a git repository does not trigger the question.
- OWP-10: `--resume` without `--worktree` does not trigger the question.
