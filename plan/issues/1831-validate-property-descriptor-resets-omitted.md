---
id: 1831
title: "_validatePropertyDescriptor resets omitted attributes to false on redefine (residual #1334)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 61
parent: 1334
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

**Why status stays `ready` (partial):** the user-visible symptom
(`Object.getOwnPropertyDescriptor(o,"k").enumerable` reading back the preserved
flag on a **plain object literal**) is NOT resolved by the store fix alone — on
these receivers the descriptor *readback* goes through a separate path that does
not consult the sidecar flag store (a #1629-family enumeration/readback gap;
same shape as #1828/#1830 where the runtime-sidecar fix sits under an
unreachable readback path). The store fix here is the correct, no-regression
prerequisite; the readback wiring (route `getOwnPropertyDescriptor` /
enumeration on plain-object-literal receivers through `_wasmPropDescs`) is a
follow-up slice for senior-dev/architect.

Tests: `tests/issue-1831-redefine-descriptor-flags.test.ts` (3 — value update,
non-enumerable-preserved-via-`Object.keys`, first-def-defaults).

