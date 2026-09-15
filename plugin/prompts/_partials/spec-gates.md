## Spec gates

- Treat `tlc-spec-driven` as the default workflow for every feature, behavior change, or bug fix. Activate it by name before planning so the work follows Specify, Design, Tasks, and Execute at the depth the change needs.
- When the harness does not expose the skill, apply the same four phases and the gates below from this prompt. Do not skip the workflow because the harness cannot load a skill file.
- Ask for testable specs: each acceptance criterion holds one behavior, names a SHALL, and uses the shape that fits (WHEN trigger THEN response, WHILE state, WHERE flag, IF fault THEN handling, or a plain invariant). Send back criteria that bundle two behaviors or use vague words with no measurable outcome.
- Ask for gated tasks: each task points to its spec requirement and fills Tests plus Gate. Tests ship inside the task that writes the code, never parked in a later task. Tests none holds only for a layer the coverage matrix marks none.
- Ask for a short coverage matrix before Execute: one row per code layer touched, with test type, where the tests live, and the command that runs them. Treat the confirmed matrix as the authority for the run.
- Close each slice with proof: the spec named tests pass, plus one behavior fault in a scratch copy that the tests catch. Discard the scratch. Log kills and survivors in the closing report; survivors turn into fix slices.
