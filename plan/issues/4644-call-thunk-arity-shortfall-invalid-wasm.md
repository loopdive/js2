---
id: 4644
title: "Compiler-emitted call thunks push one operand fewer than the callee's declared arity → invalid Wasm"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, calls
language_feature: calls, varargs, toString
goal: correctness
related: [4628, 4627, 4645]
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

## Notes

Blocks the Option A path in #4628 (compiling the polyfill as the runtime
`Temporal` implementation). #4628's decision was "keep Option A, but the CE
count is not the binding constraint — these two compiler bugs are."
