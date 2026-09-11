## Spec gates

These gates are fixed. They run on every feature slice, on every harness, whether or not any skill is available. No model judgment exempts them.

- Spec gate: no Execute without a spec holding a goal, acceptance criteria with SHALL (one behavior each), and out-of-scope. Run `python3 scripts/spec-gates/validate_spec.py <feature>` from the repo root before confirming the spec. Non-zero exit means fix first.
- Task gate: every task points to its spec requirement and fills Tests plus Gate. Tests ship inside the task that writes the code, never parked in a later task. Tests none holds only when every touched layer is marked none in the matrix; otherwise test to the strongest type among the touched layers. Run `python3 scripts/spec-gates/validate_tasks.py <feature>` before approving tasks.
- Coverage matrix before Execute: one row per code layer touched, with test type, where the tests live, and the command that runs them. Treat the confirmed matrix as the authority for the run.
- Slice close: the spec-named tests pass, plus one behavior fault in a scratch copy that the tests catch. Discard the scratch. Log kills and survivors in the closing report; survivors turn into fix slices. A done feature carries a validation report with PASS and file:line evidence, checked by `python3 scripts/spec-gates/validate_state.py <feature>`.
- Decisions: record what you sized, what you scoped out, and what the probes killed. They land in the closing report in one batch, never as questions mid-run.

Shapes, tables, and the verifier procedure live in `plugin/prompts/spec-workflow.md`. Read it when writing specs, tasks, or validation reports.
