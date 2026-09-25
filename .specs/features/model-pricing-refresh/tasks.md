# Model pricing refresh tasks

## Tasks

### T1: Refresh the static model prices

**Requirement:** R1
**Tests:** Assert representative direct and provider-prefixed ids in `tests/pricing.test.ts`, including cached prices and both real prefixed ids.
**Gate:** `npx vitest run tests/pricing.test.ts`

### T2: Resolve dated model ids

**Requirement:** R2
**Tests:** Assert `claude-haiku-4-5-20251001` resolves to the undated price in `tests/pricing.test.ts`.
**Gate:** `npx vitest run tests/pricing.test.ts`

### T3: Resolve bracketed context tags

**Requirement:** R3
**Tests:** Assert `claude-opus-5[1m]` resolves to the untagged price in `tests/pricing.test.ts`.
**Gate:** `npx vitest run tests/pricing.test.ts`

### T4: Preserve unknown model cost handling

**Requirement:** R4
**Tests:** Assert an unknown model returns `null` with non-zero tokens and with `usage` absent in `tests/pricing.test.ts`.
**Gate:** `npx vitest run tests/pricing.test.ts`

## Coverage matrix

| Layer | Test type | Test file | Command |
| --- | --- | --- | --- |
| Core pricing | Unit | `tests/pricing.test.ts` | `npx vitest run tests/pricing.test.ts` |
