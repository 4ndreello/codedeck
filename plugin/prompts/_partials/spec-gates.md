## Spec gates

- Ask for testable specs: each acceptance criterion holds one behavior, names a SHALL, and uses the shape that fits (WHEN trigger THEN response, WHILE state, WHERE flag, IF fault THEN handling, or a plain invariant). Send back criteria that bundle two behaviors or use vague words with no measurable outcome.
- Ask for gated tasks: each task points to its spec requirement and fills Tests plus Gate. Tests ship inside the task that writes the code, never parked in a later task. Tests none holds only when every touched layer is marked none in the matrix; otherwise test to the strongest type among the touched layers.
- Ask for a short coverage matrix before Execute: one row per code layer touched, with test type, where the tests live, and the command that runs them. Treat the confirmed matrix as the authority for the run.
