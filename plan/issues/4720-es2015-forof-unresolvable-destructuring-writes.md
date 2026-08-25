---
id: 4720
title: "ES2015 for-of array assignment writes to unresolvable references"
status: in-progress
created: 2026-08-25
updated: 2026-08-25
assignee: codex/4720-es2015-forof-unresolvable-destructuring-writes
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen, destructuring, for-of
es_edition: es6
language_feature: for-of-assignment-destructuring
related: [2602, 4715]
depends_on: [4715]
loc-budget: 180
loc-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts
func-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref
---

# #4720 — for-of assignment destructuring must preserve unresolvable PutValue

## Scope and live baseline

The initial baseline was measured on `upstream/main` commit `aeaad6e90`
(2026-08-25) in the assembled `runTest262File` seam. After stacking repaired
#4939 tip `1b585f27a`, the live baseline below was rerun with pinned
`pnpm@10.30.2`.

The requested three rows fail in both compiler lanes. The array-rest strict
counterpart has the same unresolved-reference write root cause and is retained
as the only sibling in this bounded array-pattern cluster:

| file | host/GC | standalone | observed signature |
| --- | --- | --- | --- |
| `language/statements/for-of/dstr/array-rest-put-unresolvable-no-strict.js` | fail | fail | sloppy write leaves no global binding; final read reports `ReferenceError` |
| `language/statements/for-of/dstr/array-elem-put-unresolvable-no-strict.js` | fail | fail | sloppy write leaves no global binding; final read reports `ReferenceError` |
| `language/statements/for-of/dstr/array-elem-put-unresolvable-strict.js` | fail | fail | strict PutValue throws a null/non-object payload, not a `ReferenceError` instance |
| `language/statements/for-of/dstr/array-rest-put-unresolvable-strict.js` | fail | fail | strict PutValue throws a null/non-object payload, not a `ReferenceError` instance |

On the repaired dependency baseline, the four unresolved rows fail in both
lanes while all seven controls pass. The lexical/const controls owned by the
dependency PR are the four rows from #4715:

- `array-rest-put-let.js`
- `array-rest-put-const.js`
- `array-elem-put-let.js`
- `array-elem-put-const.js`

They pass once #4939 is stacked. Do not broaden this issue into the
object-pattern family: its reader
and write paths are separate; only the array rows above are in scope.

## Root cause

The for-of assignment-pattern writer emits direct local/module-global stores
for identifier targets. It does not perform the full §6.2.5.6 `PutValue` arm
for an identifier that is absent from the known binding set. Consequently,
sloppy unresolvable targets are not created on the realm global object, while
strict targets do not produce a proper `ReferenceError` object. Rest and
element writes use different tuple/vec/externref paths, so the fix must be
wired at each actual identifier write point after source-value evaluation.

## Dependency and repaired baseline

Depends on #4939 (PR `codex/4715-es2015-forof-destructuring-write-errors`) for
the lexical/const write guards and proper TDZ `ReferenceError` payloads. The
dependency is now stacked at repaired tip `1b585f27a` (merged locally as
`2b6637f3c`); its `control/try-finally-early-exit` regression is repaired.
Before implementation, the four #4715 lexical/const controls passed in both
host/GC and standalone, while the four unresolved-reference rows above still
failed in both lanes. The member controls also remained passing.

## Implementation plan

1. Stack this branch on the repaired #4939 head and rerun the baseline controls
   before changing code. (Complete.)
2. Extend the for-of assignment writer with the existing global-environment
   `PutValue` machinery: evaluate each element/default/rest value first, then
   write an unresolvable sloppy identifier through the realm global object and
   throw a proper `ReferenceError` for strict mode.
3. Cover tuple, vec, externref-array, rest, and out-of-bounds array-element
   writes without changing member targets or the #4939 lexical/const guards.
4. Add focused host and standalone pins for the four in-scope rows, preserving
   the two member controls and all four #4715 lexical/const controls. Keep the
   compiler source delta within the 180-line budget.

## Non-goals

This issue does not change object-pattern assignment lowering, for-await
lowering, iterator protocol behavior, lexical/const semantics owned by #4939,
or the existing property-target `no-get` residuals.

## Acceptance

- The three named rows and the array-rest strict sibling pass in host/GC and
  standalone through the assembled harness.
- The two member controls and all four #4939 lexical/const controls remain
  passing in both lanes.
- Focused tests, TS5/TS7 typechecks, lint, format, and pre-push validation
  pass after the dependency is repaired.
- Compiler source growth is at most 180 lines and no unrelated files change.

## Test Results

Baseline probe controls were structurally healthy in both lanes: the harness
must-pass fixture returned `pass` and the must-fail fixture returned `fail`.
The exact rows and controls were run with:

```text
pnpm dlx pnpm@10.30.2 exec node --import tsx scripts/harness-flip-probe.ts \
  --paths <in-scope rows and controls> --timeout 60000
pnpm dlx pnpm@10.30.2 exec node --import tsx scripts/harness-flip-probe.ts \
  --target standalone --paths <in-scope rows and controls> --timeout 60000
```

Implementation matrix (repaired #4939 stacked) is green: 11/11 pass in host
and 11/11 pass in standalone (four unresolved rows, four lexical/const
controls, and three member/rest controls). The focused `tests/issue-4720.test.ts`
also passed in both lanes.

Typecheck and formatting gates passed with pinned pnpm 10:

- `pnpm run typecheck:ts5`
- `pnpm run typecheck:ts7` / `pnpm run typecheck`
- targeted Biome lint on the changed source/test files
- `pnpm run format:check`

The repository-wide `pnpm run lint` reports the existing baseline diagnostic
population (1672 diagnostics, including unchanged files), while the changed
source and focused test lint cleanly; the pre-push lint gate completed
successfully. The full pre-push gate also passed its format, oracle-ratchet,
coercion-site, numeric-local parity, and issue-integrity checks.
