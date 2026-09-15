# Spec Workflow Reference

On-demand companion to the Spec gates partial. The partial holds the fixed
gates; this file holds the shapes. Read the section you need when writing
specs, tasks, or validation reports. This file is not inlined into any prompt.

## EARS acceptance criteria

One behavior per criterion, always with SHALL, concrete values instead of
vague words (a status code, a message, a bound; never "quickly" or
"gracefully").

| Shape | Template | Use for |
| ----- | -------- | ------- |
| Invariant | The [system] SHALL [response] | Always-on constraints |
| Event | WHEN [trigger] THEN the [system] SHALL [response] | Response to a discrete trigger |
| State | WHILE [state] the [system] SHALL [response] | Behavior that holds during a state |
| Optional | WHERE [flag] the [system] SHALL [response] | Behavior behind a flag or capability |
| Fault | IF [bad condition] THEN the [system] SHALL [handling] | Errors, invalid input, timeouts |

Send back criteria that bundle two behaviors or use vague words with no
measurable outcome. `validate_spec.py` flags any criterion without SHALL.

## Assumptions table

Every ambiguity is resolved with the human or recorded here. Nothing proceeds
unmarked.

| Assumption / decision | Chosen default | Rationale |
| --------------------- | -------------- | --------- |
| [ambiguity] | [what we do] | [why] |

An empty Chosen default or Rationale cell fails `validate_spec.py`.

## Task granularity

One task is one deliverable: one component, one function, one endpoint, one
file change. Two or three cohesive things in one file are acceptable; multiple
files or components mean split. A `Where` naming several files is a smell.

Each task carries: What (one sentence), Where (file), Depends on (task ids or
None), Requirement (spec id or story), Done when (binary checkboxes), Tests
(unit, integration, e2e, or none per the matrix), Gate (quick, full, or
build), and the planned commit message.

Dependencies point backward or within the same phase, never to a later phase.
The execution diagram must match every `Depends on` and vice versa.
`validate_tasks.py` checks fields, direction, and diagram parity.

No tasks.md yet and more than 5 steps ahead: stop and write tasks.md first.
Three or fewer obvious steps may stay inline as an execution plan.

## Coverage matrix and gates

Built from the repo before Execute: sample existing tests for style and
location, read the real commands from package manifests and CI config, never
invent them.

| Code Layer | Required Test Type | Location Pattern | Run Command |
| ---------- | ------------------ | ---------------- | ----------- |
| [layer] | [unit/integration/e2e/none] | [glob or path] | [command] |

Quick gate after unit-only tasks, full gate after integration or e2e tasks,
build gate (build plus lint plus tests) after phases and config-only tasks.
`Tests: none` is valid only for a layer the matrix marks none.

## Verifier procedure

Validation is the closing step of Execute, never a prompt away. A fresh pair
of eyes re-derives coverage from the spec; the author never verifies alone.

1. Re-anchor every AC to its spec-defined outcome and confirm the test asserts
   that exact outcome, citing `file:line` plus the assertion. No citation
   means not covered. Vague spec outcomes get flagged, never silently passed.
2. Run the build-level gate. Non-zero exit stops everything.
3. Inject 1 to 3 behavior faults (flipped condition, wrong return, off-by-one,
   removed side effect) in scratch copies only, never the real tree (`git
   stash` is forbidden here), confirm the tests kill each one, discard the
   scratch, and confirm the real tree matches its pre-sensor baseline.
   Survivors become fix tasks.
4. Write `.specs/features/<slug>/validation.md` with PASS or FAIL, per-AC
   evidence, sensor kills plus survivors, and the diff range. Gaps become fix
   tasks; after 3 fix and re-verify rounds, escalate to the human.
5. Run `validate_state.py`. It demands a filled PASS plus file:line evidence.

## Decision log

Batch into the closing report: what you sized, what you scoped out, what the
probes killed, with the reason each time. One batch at the end, no questions
mid-run.

## Batch rule

More than about 8 tasks means offering split workers: consecutive whole
phases per worker, sequential batches, each reporting tasks done, commit
hashes, test counts, and deviations before the next starts. Eight or fewer
runs inline.
