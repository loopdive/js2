---
id: 2981
title: Tagged-template equivalence tests reconcile to spec-correct TemplateStringsArray param type
status: done
sprint: current
priority: high
horizon: m
assignee: ttraenkler/opus-3
completed: 2026-07-02
---

# #2981 — tagged-template equivalence tests: `string[]` → `TemplateStringsArray`

## Problem (triage of TaskList #37)

fable-6 flagged 11 tagged-template-literal equivalence tests in
`tests/equivalence/ts-wasm-equivalence.test.ts` failing with COMPILE-ERROR on
clean current main, suspected to be a recent (~30-PR) merge-wave regression.

## Root cause — NOT a recent regression

Bisected the exact repro (`function tag(strings: string[]) { return strings.raw[0] }`
tagged with a template) against historical main:

| commit base | date       | result |
| ----------- | ---------- | ------ |
| origin/main | 2026-07-02 | FAIL   |
| main~30     | 2026-07-02 | FAIL   |
| main~300    | 2026-06-28 | FAIL   |
| main~1000   | 2026-06-17 | FAIL   |
| main~1600   | 2026-06-03 | FAIL   |

Fails identically back to at least June 3 — **not** a merge-wave regression.

The tag-function signatures declared `strings: string[]`, but a tagged template
call passes a `TemplateStringsArray` (`ReadonlyArray<string> & { raw }`), which is
**not** assignable to a mutable `string[]`. The compiler surfaces the TS checker's
diagnostics; `TS2345` (argument not assignable) has been a **hard** compile error
since 2026-04-16 (`d8cfbb7a` — "fail on incompatible TypeScript annotations"
removed 2345/2322 from `DOWNGRADE_DIAG_CODES`). The `.raw` cases additionally hit
`TS2339` ("Property 'raw' does not exist on type 'string[]'"). The tests predate
that tightening and were simply written with spec-incorrect types — real
TypeScript rejects `function tag(strings: string[])` used as a template tag too.

The compiler's own lowering is correct: `resolveWasmType` (src/codegen/index.ts
~12430) already matches `TemplateStringsArray` and lowers it to the template-vec
struct `{ length, data, raw }`.

## Fix

Reconcile the test tag-function signatures to the spec-correct
`TemplateStringsArray` (and, where a tag returned the array, its return type and
the receiving `eq`/`getTemplate`/local types). No compiler source change.

Files touched (test-only):

- `tests/equivalence/ts-wasm-equivalence.test.ts` (11 cases)
- `tests/equivalence/iife-tagged-templates.test.ts` (5 cases)
- `tests/equivalence/iife-and-call-expressions.test.ts` (3 cases)
- `tests/issue-141.test.ts`
- `tests/issue-229.test.ts`

## Verification (output-diff, not assumption)

`assertEquivalent` compiles each snippet to wasm AND runs the same source as the
JS reference, comparing outputs. After the fix:

- ts-wasm-equivalence: 29/29 pass (tagged-template block 13/13)
- iife-tagged-templates: 5/5 pass
- iife-and-call-expressions tagged-template block: 3/3 pass
- issue-141 + issue-229: 22/22 pass

## Follow-up (flagged to lead)

`tests/iife-and-call-expressions.test.ts` and `tests/iife-tagged-templates.test.ts`
at the repo root are stale duplicates of their `tests/equivalence/` counterparts
with a broken `./helpers.js` import (helpers live at `tests/equivalence/helpers.ts`).
They collect **0 tests** (never run). Candidate for deletion — left untouched here
to keep this PR scoped to the failing lane.
