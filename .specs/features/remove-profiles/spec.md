# Remove setup profiles

## Problem Statement

CodeDeck currently combines the top-level configuration with a selected setup profile. The profile path can make doctor report one role setup while launches use another. Remove profile selection so every command resolves roles from the top-level configuration.

## Goals

CodeDeck has one setup, stored in the top-level configuration. Legacy `profiles` and `activeProfile` values remain untouched as opaque user data and have no effect on commands.

## Out of Scope

| Item | Reason |
| --- | --- |
| Codex CLI's own `-p` profile flag handling in `open.ts` and its tests | It is an upstream Codex option, not a CodeDeck setup profile. |
| Historical feature specs | They document prior work and remain history. |
| Fixture data in tests/mods-agents/pane.test.ts | It is fixture data, not profile behavior. |
| The real user configuration under the user's configuration directory | This task changes repository code only. |
| New abstractions or unrelated formatting changes | They are outside the requested removal. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Existing profile keys during setup saves | Preserve their values as opaque JSON without reading or typing them. | Setup should retain user data while making those keys inert. | Yes |

**Open questions:** none.

## User Stories

### P1: Use one setup

**User Story:** As a CodeDeck user, I want every command to use the top-level configuration so that doctor and launches agree.

**Why P1:** Setup profiles currently let doctor and launch paths report or use different role bindings.

**Acceptance Criteria:**

1. **R1:** The CLI SHALL NOT register a profile command. `codedeck profile ...` SHALL be reported as an unknown command.
2. **R2:** The `codedeck run`, `codedeck open`, and `codedeck setup` commands SHALL NOT accept a `--profile` option.
3. **R3:** WHEN the configuration contains `activeProfile` and/or `profiles` keys THEN run, open, setup, web setup, and doctor SHALL resolve roles from the top-level configuration only.
4. **R4:** WHEN CLI, wizard, or web setup saves configuration THEN it SHALL write top-level fields and preserve existing `profiles` and `activeProfile` values unchanged.
5. **R5:** WHEN doctor prints text output THEN it SHALL show a `Roles` header without a profile label or `Profile` section; doctor JSON SHALL omit `activeProfile` and `activeProfileError`.
6. **R6:** The web setup page SHALL have no profile target and no `Profile:` label.

**Independent Test:** Run the focused command contract, role resolution, setup save, doctor, and web setup tests with conflicting legacy profile data.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| R-01 | P1: Use one setup | Execute | Verified |
| R-02 | P1: Use one setup | Execute | Verified |
| R-03 | P1: Use one setup | Execute | Verified |
| R-04 | P1: Use one setup | Execute | Verified |
| R-05 | P1: Use one setup | Execute | Verified |
| R-06 | P1: Use one setup | Execute | Verified |

## Coverage matrix

| Requirement | Coverage |
| --- | --- |
| R1 | CLI command registration contract |
| R2 | CLI option contracts for run, open, and setup |
| R3 | Run, open, setup, web setup, and doctor tests with conflicting legacy key data |
| R4 | Setup save preservation tests for CLI, wizard, and web paths |
| R5 | Doctor text and JSON contract tests |
| R6 | Web setup page target and label contract tests |

## External Dependencies

None.
