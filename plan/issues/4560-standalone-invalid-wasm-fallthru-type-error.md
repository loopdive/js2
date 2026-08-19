---
id: 4560
title: "Standalone emits INVALID Wasm: `type error in fallthru[0] (expected (ref null N), got (ref N))` in __module_init / __cb_0"
status: ready
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
goal: es5
related: [4556, 4163]
origin: "2026-08-19 ES5 standalone push, #4556 array lane, bucket I. Spun out because it is a codegen validity bug, not an Array semantics gap."
---

# #4560 — standalone emits invalid Wasm (fallthru nullability mismatch)

## Severity: this is not a conformance gap, it is a broken module

The compiler produces a binary the **engine refuses to instantiate**:

```
CompileError: type error in fallthru[0] (expected (ref null 6), got (ref N))
```

A failing conformance assertion is a wrong answer; this is a module that cannot
run at all. It is filed separately from #4556 for that reason — it happens to
have been found via two Array rows, but nothing about it is Array-specific.

## Reproduction

Both under `--target standalone`:

- `built-ins/Array/prototype/toLocaleString/A3_T1.js` — fails in `__module_init`
- `built-ins/Array/prototype/toString/A1_T4.js` — fails in `__cb_0`

```bash
npx tsx .tmp/t262.mts built-ins/Array/prototype/toLocaleString/A3_T1.js
npx tsx .tmp/t262.mts built-ins/Array/prototype/toString/A1_T4.js
```

## Diagnosis so far

The message is a **nullability** mismatch on a block's fallthrough value: a
non-null `(ref N)` is produced where the block's result type is the nullable
`(ref null N)`. Wasm subtyping makes `(ref N) <: (ref null N)`, so a plain value
mismatch would validate — meaning the defect is more likely an inverted
expectation in the block signature the emitter writes, or a fallthrough arm typed
from a different site than the one that produced the value.

The two failing sites differ (`__module_init` vs a generated callback `__cb_0`),
so this is not one stray call site.

## Why it matters beyond these two rows

Any construct that hits the same emitter path produces an uninstantiable module.
The two known rows are how it surfaced, not the extent of it. A validity bug that
only shows up on two conformance tests is under-sampled by construction, so the
first task is to find the shape, not to fix the two rows.

## Acceptance criteria

- Both reproductions instantiate and run (pass or fail on their assertions — but
  no `CompileError`).
- A minimal non-test262 repro is added under `tests/` capturing the emitted block
  signature, so the shape is pinned rather than the two rows.
- The standalone ES5 guard (551 locally-verified-passing rows) stays clean.
