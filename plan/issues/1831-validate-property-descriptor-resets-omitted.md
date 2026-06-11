---
id: 1831
title: "_validatePropertyDescriptor resets omitted attributes to false on redefine (residual #1334)"
status: done
created: 2026-06-04
updated: 2026-06-11
priority: medium
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 61
parent: 1334
pr: 1282
claimed_by: codex-developer
claimed_at: 2026-06-07T10:12:25.359Z
completed: 2026-06-10
---
# #1831 — partial redefine clears previously-set descriptor flags

Residual of #1334 (marked done, sprint 50).

## Symptom
After `o.k` is enumerable/writable, `Object.defineProperty(o,"k",{value:5})` clears
`enumerable`/`writable`/`configurable` instead of preserving the absent fields.

## Location
`src/runtime.ts:1262-1272`: `newFlags` built from truthiness of each
`desc.writable/enumerable/configurable` (omitted ⇒ 0); when `existing` is
configurable, `:1272` returns `newFlags` directly.

Follow-up finding: the same reset existed in the compiler's
`definedPropertyFlags` bookkeeping for typed struct/object-literal fast paths,
and first `defineProperty` calls on fields synthesized by empty-object widening
needed an explicit descriptor sidecar write so runtime readback sees default
`false` attributes.

## Spec
ECMAScript §10.1.6.3 ValidateAndApplyPropertyDescriptor — absent fields are kept.
Scope: the WasmGC-struct sidecar fallback.

## Fix
When `existing !== undefined`, start from `existing` and only overwrite flags whose
descriptor field is explicitly present (`desc.writable !== undefined`, etc.).

## Progress (2026-06-04, dev-w1) — store fixed; readback is a separate slice

Fixed `_validatePropertyDescriptor` (`src/runtime.ts`) per §10.1.6.3: `newFlags`
now seeds from the existing descriptor and overwrites only the
explicitly-present fields (data↔accessor kind included); on first definition,
omitted attributes still default to false. A partial redefine like
`Object.defineProperty(o,"k",{value:5})` no longer clears a previously-set
writable/enumerable/configurable in the **stored** sidecar descriptor.

**Verified (no regression)**: value-update and first-definition-defaults pass;
a non-enumerable property stays out of `Object.keys` across a partial redefine;
all 37 tests across the #1629* / #1364a descriptor suites stay green.
(`tests/object-define-property*.test.ts` fail only to *collect* — pre-existing
missing `tests/helpers.js`, unrelated to this change, identical pristine vs
fixed.)

**Historical gap after this partial fix:** the user-visible symptom
(`Object.getOwnPropertyDescriptor(o,"k").enumerable` reading back the preserved
flag on a **plain object literal**) is NOT resolved by the store fix alone — on
these receivers the descriptor *readback* goes through a separate path that does
not consult the sidecar flag store (a #1629-family enumeration/readback gap;
same shape as #1828/#1830 where the runtime-sidecar fix sits under an
unreachable readback path). The store fix here is the correct, no-regression
prerequisite; the readback wiring (route `getOwnPropertyDescriptor` /
enumeration on plain-object-literal receivers through `_wasmPropDescs`) is a
follow-up slice. That gap is addressed by the 2026-06-07 codex-developer work
below.

Tests: `tests/issue-1831-redefine-descriptor-flags.test.ts` (3 — value update,
non-enumerable-preserved-via-`Object.keys`, first-def-defaults).

## Progress (2026-06-07, codex-developer) — readback fixed

Implemented the remaining readback slice. The compiler now applies
`ValidateAndApplyPropertyDescriptor`-style flag merging to the
`definedPropertyFlags` side table instead of rebuilding flags from the partial
descriptor. Existing object-literal/struct fields seed from the default
writable/enumerable/configurable data descriptor, while fields synthesized only
to store an `Object.defineProperty` result are treated as first definitions and
keep omitted attributes defaulted to false.

The struct value path now writes a complete applied descriptor to the runtime
sidecar when needed, so single-key `Object.getOwnPropertyDescriptor` and plural
`Object.getOwnPropertyDescriptors` agree on omitted attributes after redefines.
Focused tests moved to the requested `tests/issue-1831.test.ts`.

Validation:
- `pnpm vitest run tests/issue-1831.test.ts`
- `pnpm vitest run tests/issue-1831.test.ts tests/issue-1629-S1.test.ts tests/issue-1629b.test.ts tests/issue-1629-S2.test.ts tests/issue-856.test.ts tests/issue-1460.test.ts`
- `pnpm typecheck`

## Final refresh (2026-06-07, codex-developer attempt 30)

PR #1282 already exists and remains ready for review. Merged current
`origin/main` into `symphony/1831` after GitHub reported the branch behind
`main`, then reran the scoped validation above successfully. Status remains
`in-review` until the PR-status poller observes the merge.
