---
id: 4560
title: "Standalone emits INVALID Wasm: `type error in fallthru[0] (expected (ref null N), got (ref N))` in __module_init / __cb_0"
status: done
sprint: current
created: 2026-08-19
updated: 2026-08-19
completed: 2026-08-19
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

- `test262/test/built-ins/Array/prototype/toLocaleString/S15.4.4.3_A3_T1.js` — fails in `__module_init`
- `test262/test/built-ins/Array/prototype/toString/S15.4.4.2_A1_T4.js` — fails in `__cb_0`

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

## 2026-08-19 FIXED — commit `0cc8e8f` on `es5-array`

**Both modules now load and run. The row count deliberately does NOT move** —
lane stayed 22/62, guard 551/551. This is recorded as a validity fix, not a
conformance gain; reading it as +2 would be wrong.

### Root cause

The native `join` fold's element switch had four arms — boolean, numeric,
`externref`, and a terminal `else` that **assumed a string ref** and emitted
`ref.as_non_null`. An array of object literals is none of those: its element type
is a `(ref null $__anon_N)` closed struct, so the `else` fired and the fold's
`local.set` into the `(ref $AnyString)` result rejected it.

Minimal repro (standalone):

```js
var o = { valueOf: function () { return "+"; } };
[o].join();   // CompileError: type error in fallthru[0] (expected (ref null 6), got (ref 80))
```

`var o = {}` compiles fine — a property-less literal gets a different element
carrier — which is why the shape looked rarer than it is.

**Fix:** `extern.convert_any` is total over every GC ref, so a struct element
becomes an ordinary `externref` and reuses the `any[]` lane's
`__extern_toString` — the same ToString `String(a[i])` uses, so the two cannot
disagree. String carriers keep the untouched path via a supertype-chain walk
rather than an id comparison. Extracted to `array-join-element.ts`, which also
shrinks `array-methods.ts`.

### Why neither row flips — measured, not assumed

- **`toString/S15.4.4.2_A1_T4`** now passes five of six assertions, then fails
  because **`new Array(o)` loses the element**. `literals.ts` (~L5168)
  deliberately widens the one-element case to a `__vec_externref`; the consumer
  coerces that to the contextual `(ref null $__anon)` carrier via
  `emitVecToVecBody`, whose per-element `ref.test`-guarded cast **cannot**
  succeed — the literal has a method, so it was materialised to `$Object`, not to
  the closed struct its TS type resolves to. **Two representations for one TS
  type; the cast silently yields `null`.** That is #2809 representation
  territory, same family as bucket **D** in #4556.
- **`toLocaleString/S15.4.4.3_A3_T1`** now runs and fails on inherited
  `Array.prototype[1]` — plain bucket **B**, the documented `proto-index-store.ts`
  boundary.

### Scope decision

This issue keeps **only the invalid-Wasm half**, which is done. The
one-element-`new Array(o)` representation split should be folded into **#2809**
rather than tracked here.
