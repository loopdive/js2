---
id: 4644
title: "Compiler-emitted call thunks push one operand fewer than the callee's declared arity → invalid Wasm"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-28
completed: 2026-08-28
assignee: ttraenkler/opus-dev-4644
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, calls
language_feature: calls, varargs, toString
goal: correctness
related: [4628, 4627, 4645]
# The fixes are argument-padding at four existing emit sites; each one has to
# state WHY the old operand count was wrong, and the explanation is the point
# (see "Implementation notes"). Splitting these functions is #3399's job and
# would bury a one-operand fix inside a refactor.
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/type-coercion.ts
func-budget-allow:
  - src/codegen/index.ts::emitToPrimitiveMethodExports
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitMethodDispatch
  - src/codegen/index.ts::emitDispatchForMethod
  - src/codegen/type-coercion.ts::coerceType
---

# #4644 — Call thunks push one operand fewer than the callee's declared arity

## Problem

A compiler-emitted call thunk sets up **N−1** operands for a callee declared
with **N** parameters. The module compiles cleanly — `compile()` reports zero
errors — and then `WebAssembly.compile()` rejects the binary.

Found by the #4628 spike while compiling `@js-temporal/polyfill@0.5.1`: **5 of
14 slices** emitted a binary the validator refuses. All five are the same
family.

| Count | Validator message | Callee |
| --- | --- | --- |
| 3 | `not enough arguments on the stack for local.set (need 1, got 0)` | `__class_call_formatToParts_vararg`, `__call_toString` ×2 |
| 2 | `not enough arguments on the stack for call (need N, got N−1)` | `__call_toString` (need 2, got 1); `IslamicBaseHelper_estimateIsoDate` (need 5, got 4) |

**Not Temporal-specific.** The polyfill is just the corpus that surfaced it.

**Not the same bug as #4627**, despite sharing the validate gate. #4627 was a
*type* mismatch on a `global.set` (f64 carrier, i32 value); this is an *arity*
shortfall on a call. Fixing one does not fix the other — #4627's fix
(`569d78f7`) is already on `main` and these still reproduce.

## Why this matters beyond the polyfill

`IslamicBaseHelper_estimateIsoDate` is an **ordinary user function**, not a
synthesized thunk. The `__call_*` / `__class_call_*` naming on the other four
suggests a thunk-synthesis bug, but that fifth sample says the shortfall
reaches plain calls too — so the blast radius is wider than the names imply.
Establish which of the two it actually is before scoping a fix.

This class of defect is also **silent by construction**: `compile()` returns
success, so nothing upstream of `WebAssembly.compile()` notices. Any corpus
that is compiled but never instantiated will report it as a clean pass.

## Reproduce

```bash
DOGFOOD_TEMPORAL_POLYFILL=1 node node_modules/vitest/dist/cli.js run \
  tests/dogfood/temporal-polyfill.test.ts
```

The harness (`tests/dogfood/temporal-polyfill-harness.mjs`, landed by #4628 /
PR #4789) pins `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0`, links them, and
compiles in slices. The five failing slices are reported individually with the
validator's message and the offending function name.

## Investigation entry points

- `__call_toString` accounts for three of the five — start there; a
  `toString` thunk is synthesized in a small number of places and the
  divergence should be visible by inspection.
- `__class_call_formatToParts_vararg` is the **vararg** thunk path, and the
  vararg spread is a plausible place to lose exactly one operand (the
  count/array pair, or a receiver).
- `local.set (need 1, got 0)` vs `call (need N, got N−1)` may be the same
  producer failing at two different consumption points, or two bugs. Decide
  which before fixing — three of one and two of the other is not obviously one
  root cause.

## Acceptance criteria

1. All 14 slices of the polyfill harness pass `WebAssembly.validate()`.
2. A regression test under `tests/` for each distinct root cause found (one if
   the two message shapes share a producer, two if they don't).
3. No net regression on the test262 baseline.
4. If any of the five turns out to need a separate fix that is out of scope,
   file it and say so — do not leave a slice silently failing.

## Implementation notes (2026-08-28)

**Answer to the issue's own question — FOUR producers, not one, and not two.**
The two validator message shapes do not partition them: three producers can
emit either message depending on which consumer trips first, and the fifth
sample (`IslamicBaseHelper_estimateIsoDate`) was right to look different — it is
the only one whose producer is ordinary user-method dispatch.

| # | Producer | Bug | Sample |
| --- | --- | --- | --- |
| 1 | `emitVirtualMethodDispatchByTag` (`src/codegen/expressions/virtual-dispatch.ts`) | Shared argument temps sized from `candidates[0]`'s Wasm signature, then pushed unchanged into EVERY arm | `IslamicBaseHelper_estimateIsoDate`, `need 5, got 4` |
| 2 | `emitToPrimitiveMethodExports` + the `${Class}_toString` / `${Class}_valueOf` calls in `type-coercion.ts` | ToPrimitive passes zero arguments; the emitters pushed only the receiver, ignoring parameters the method DECLARES | `__call_toString` ×3 |
| 3 | The host vararg class bridge `__class_call_<m>_vararg` (`src/codegen/index.ts`) | `funcRestParams.restIndex` is a SOURCE param index; the bridge read it as a Wasm param index | `__class_call_formatToParts_vararg` |
| 4 | The same virtual-dispatch cascade's `__tag` read | "Field 0 is `__tag` in every class struct this path can see" was asserted, never checked; an object-literal struct's field 0 is its first property | `i32.eq[0] expected i32, found struct.get of type externref` |

Producer 4 was **already on `main` and invisible**: the validator stops at the
first bad function, and in every affected module an earlier function failed
first. It only surfaced *after* producer 1 was fixed. That is the general shape
of this issue — one invalid function hides every later one, so "5 failing
slices" was a floor, not a count.

Two details worth carrying forward:

- **Producer 1's failure MODE depends on declaration order.** The candidate list
  follows `classParentMap` insertion order. Narrow-first gives the issue's
  `need N, got N−1`; wide-first gives a surplus operand, which surfaces as
  `type error in fallthru[0]`. Same defect, and a repro that only covers one
  ordering tests half of it.
- **Padding `externref` with `ref.null.extern` is WRONG, not merely
  approximate.** It reads as JS `null`, and `null === undefined` is false, so a
  method that inspects its omitted argument takes the wrong branch — measured
  8 instead of 42 on `class N { valueOf(hint) { return hint === undefined ? 41
  : 7 } } ; new N() + 1`. `canonicalUndefinedExternInstrs` degrades to that
  silently when `__get_undefined` is not imported, which is exactly the case
  for a module whose only use of it IS the pad. `emitToPrimitiveMethodExports`
  now registers the import up front, and the mid-body sites route through
  `pushDefaultValue`, which registers it and flushes the index shift.
  **Consequence for callers: a `funcIdx` read BEFORE the pad may be stale** —
  every one of the five sites re-reads it from `funcMap` afterwards.

### Result

All **14/14** slices of the polyfill harness pass `WebAssembly.validate()` (was
9/14). Regression tests: `tests/issue-4644-call-thunk-arity.test.ts`, one
minimized case per producer, each verified to FAIL on `main` and pass after.
Each asserts a clean `compile()` *and* a successful `WebAssembly.compile()` —
asserting only the first passes on the buggy compiler, which is the whole
character of this bug family.

### Out of scope — filed separately

- **#5168** — the host dynamic method bridge does not RESOLVE a rest-parameter
  class method at run time (`TypeError: formatToParts is not a function`).
  Pre-existing and independent of the arity fix: it reproduces identically for
  `m(...rest)`, whose operand count was never wrong.

## Notes

Blocks the Option A path in #4628 (compiling the polyfill as the runtime
`Temporal` implementation). #4628's decision was "keep Option A, but the CE
count is not the binding constraint — these two compiler bugs are."
