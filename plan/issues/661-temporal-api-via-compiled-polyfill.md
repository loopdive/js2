---
id: 661
title: "Temporal API via compiled polyfill or minimal implementation"
status: done
pr: 1274
created: 2026-03-20
updated: 2026-06-11
priority: medium
feasibility: medium
reasoning_effort: high
goal: spec-completeness
sprint: 61
es_edition: n/a
language_feature: temporal
task_type: feature
test262_fail: 1128
files:
  src/codegen/expressions.ts:
    new:
      - "Temporal namespace with PlainDate/PlainTime/Duration classes"
claimed_by: codex-developer
claimed_at: 2026-06-07T10:10:20.796Z
completed: 2026-06-10
---

# #661 — Temporal API via compiled polyfill or minimal implementation

## Status: done

1,128 Temporal tests fail (currently skipped by safety filter). Rather than implementing the spec from scratch, try compiling the existing JS polyfill.

### Approach 1: Compile @js-temporal/polyfill

The polyfill is pure JS (~15,000 lines). If js2wasm can compile it:

1. `npm install @js-temporal/polyfill`
2. Write a thin TS wrapper that imports and re-exports the polyfill
3. Compile the wrapper — the polyfill becomes native Wasm
4. Inject the compiled Temporal namespace into test262 preamble

**Likely blockers:** dynamic property access, prototype chains, BigInt, complex string parsing. But attempting it reveals exactly which compiler features are missing — the polyfill becomes a real-world stress test.

### Approach 2: Minimal implementation (if polyfill fails)

If the polyfill hits too many unsupported patterns, implement a stripped-down version (~500 lines) covering just what test262 needs:

- `Temporal.PlainDate(year, month, day)` + `.year/.month/.day` + `.from(string)` + `.toString()`
- `Temporal.PlainTime(hour, min, sec)` + getters + `.from()` + `.toString()`
- `Temporal.Duration(years, months, days, ...)` + getters + `.from()` + `.toString()`
- `Temporal.Now.plainDateISO()` → hardcoded current date
- `.equals()`, `.add()`, `.subtract()` on PlainDate/PlainTime

### Decision tree

1. Try compiling polyfill → if <50 CE, fix them and ship
2. If 50-200 CE → the CE list becomes a prioritized bug list (real-world impact!)
3. If >200 CE → implement minimal subset instead

### Why this matters

The polyfill attempt is valuable even if it fails — it's a real-world TypeScript library, not synthetic test262 patterns. Every CE it hits represents a real developer who can't compile their code.

## Complexity: M (polyfill attempt) or L (minimal impl)

## Attempt 22 findings

Implemented the minimal native subset rather than vendoring `@js-temporal/polyfill`. The shipped path adds WasmGC structs for ISO-only `Temporal.PlainDate`, `Temporal.PlainTime`, and `Temporal.Duration`, then wires:

- `new Temporal.PlainDate(...)`, `new Temporal.PlainTime(...)`, `new Temporal.Duration(...)`
- `Temporal.PlainDate.from(...)`, `Temporal.PlainTime.from(...)`, `Temporal.Duration.from(...)`
- `Temporal.Now.plainDateISO()` as a deterministic `2026-06-07` value
- PlainDate/PlainTime field getters, `.equals()`, `.add()`, `.subtract()`, `.toString()`, `.toJSON()`, `.toLocaleString()`
- Duration field getters, `.add()`, `.subtract()`, `.negated()`, `.abs()`, `.toString()`, `.toJSON()`, `.toLocaleString()`, `.sign`, `.blank`

The implementation follows the current TC39 Temporal proposal shape for these operations: constructors initialize internal slots, `.from()` routes through `ToTemporal*`, getters return slots, and `.toString()` delegates to the Temporal string abstract operations. This is intentionally not full Temporal: calendars beyond ISO, time zones, option bags, descriptors/prototypes, and complete test262 edge ordering remain follow-up work.

Scoped validation:

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm exec vitest run tests/issue-661.test.ts`
- `pnpm exec prettier --check src/codegen/temporal-native.ts src/codegen/expressions/calls.ts src/codegen/expressions/new-super.ts src/codegen/property-access.ts src/runtime.ts tests/issue-661.test.ts`
- `pnpm exec biome lint src/codegen/temporal-native.ts src/runtime.ts tests/issue-661.test.ts --diagnostic-level=error`

Note: an accidental `pnpm test -- tests/issue-661.test.ts` invocation was not scoped by Vitest in this repo and started unrelated suites. It surfaced unrelated pre-existing failures before the intended single-file command was rerun correctly.

## Attempt 31 refresh

PR #1274 already existed for the minimal native Temporal subset, but its older
CI run had stale baseline/report-merge failures after `origin/main` moved. The
branch was refreshed by merging the latest `origin/main` through the updated
`origin/symphony/661` branch, preserving the existing implementation and PR
metadata.

Scoped validation after the main-merge refresh:

- `pnpm exec tsc --noEmit --pretty false`
- `pnpm exec vitest run tests/issue-661.test.ts`
- `pnpm exec prettier --check src/codegen/temporal-native.ts src/codegen/expressions/calls.ts src/codegen/expressions/new-super.ts src/codegen/property-access.ts src/runtime.ts tests/issue-661.test.ts plan/issues/661-temporal-api-via-compiled-polyfill.md`
- `pnpm exec biome lint src/codegen/temporal-native.ts src/runtime.ts tests/issue-661.test.ts --diagnostic-level=error`
- `pnpm run check:issues`

Local repository note: `git fsck --connectivity-only` still reports unrelated
corrupted reflog/commit-graph entries for `symphony/1831`; disabling
`core.commitGraph` for the merge command avoided that local metadata issue.
