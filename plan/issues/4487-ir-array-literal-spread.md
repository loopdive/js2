---
id: 4487
title: "IR: adopt SPREAD in array literals (`[...a, x]`) for statically-provable source lengths"
status: in-progress
assignee: ttraenkler/opus-4487
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: fix
area: ir
language_feature: arrays
goal: ir-full-coverage
parent: 2855
related: [3518, 3583, 1804]
loc-budget-allow:
  - src/ir/array-spread-shape.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #4487 — IR: adopt spread in array literals

`SpreadElement` is the only remaining hard reject inside the otherwise
IR-owned array-literal shape. Measured on `origin/main`
(793b5c0, `.tmp/spread-probe.ts`, `JS2WASM_IR_SHAPE_DIAG=1`): **every**
spread shape rejects at one arm, `expr-arraylit-spread`, regardless of what
the source is:

| shape | reject arm (before) |
| --- | --- |
| `[...a]` | `expr-arraylit-spread:SpreadElement` |
| `[...a, x]` | `expr-arraylit-spread:SpreadElement` |
| `[x, ...a, y]` | `expr-arraylit-spread:SpreadElement` |
| `[...a, ...b]` | `expr-arraylit-spread:SpreadElement` |
| `[...p]` (param) | `expr-arraylit-spread:SpreadElement` |
| `[...g()]` | `expr-arraylit-spread:SpreadElement` |
| `[..."ab"]` | `expr-arraylit-spread:SpreadElement` |
| `[1, 2, 3]` (baseline) | CLAIMED |

So one uniform arm hides two very different situations, and the matrix row
records "spread" as if it were a single feature.

## Why only *some* spreads can be adopted

`vec.new_fixed` (#1804) is the IR's only array-allocation node and its count
is a **compile-time** number — the WasmGC emitter lowers it to
`array.new_fixed` / `array.new_default` with an `i32.const` length
(`src/ir/backend/wasmgc-emitter.ts` `emitVecNewFixed`), and the linear
emitter realises the same fixed `[header][len][cap][elements…]` intent.
There is no `vec.new(n)` taking a runtime length, and no bulk-copy
primitive. A runtime-length spread therefore needs a genuinely new IR node
kind plus matching lowerings in every backend — out of scope here.

What *is* in scope: sources whose element count is provable at compile time.
Those expand **element-wise** into the existing fixed literal, which also
buys the two JS semantics that matter for free:

- **copy, not alias** — `vec.new_fixed` allocates a fresh backing array, so
  mutating either side afterwards is not observable through the other.
- **left-to-right evaluation** — elements, spread reads included, are
  lowered in source order.

## Scope

Adopted (`src/ir/array-spread-shape.ts`):

1. `inline-literal` — the operand is itself a dense array literal
   (`[...[1, 2], x]`). Elements are inlined verbatim; the operand is never
   allocated. This mirrors the call-argument spread expansion that already
   ships (`isStaticSpreadSource`, slice 8a).
2. `fixed-const-vec` — the operand is an identifier bound by a
   function-local `const` whose initializer is a dense array literal, **and**
   whose length is provably invariant across the enclosing function. The
   lowerer emits one `vec.get` per index against the source lowered once.

The invariance proof is a name-text scan of the declaring function scope.
Every occurrence of the name must be a length-preserving, non-escaping read:
an element read `a[i]`, a `.length` read, `for (… of a)`, or a spread into an
array literal. Refused: any write position (`a[i] = v` extends the array when
the index is out of range, so index writes are refused too), `a.length = n`,
any method call (`a.push(…)`), passing `a` anywhere it could be aliased and
resized, and any competing binding of the same name. Module-level `const`s
are excluded — a module global can be mutated from any function, so a
whole-function scan proves nothing.

Still rejecting, now under their own arm `expr-arraylit-spread-dynamic-source`
so the residual is legible: spread of a parameter, of a call result, of a
`let` binding, of a string (the iterator protocol), and of a `const` array
that could be resized or escape. Sparse literals keep `expr-arraylit-sparse`.

A non-scalar (string/externref-carrier) spread source demotes at build time
through `IrUnsupportedError` rather than a bare `Error`: `vec.get` on a
string vec yields the STORED `externref` while a sibling string literal
lowers as `IrType.string`, and the two cannot share one `vec.new_fixed`
element type. A bare throw reads as an unexpected internal throw under
IR-first and fails the compile instead of falling back — measured, see the
test file.

## Acceptance criteria

- `[...a]`, `[...a, x]`, `[x, ...a, y]`, `[...a, ...b]` over same-typed
  numeric/boolean `const` vecs are selector-CLAIMED and IR-emitted, and agree
  with both legacy codegen and Node.
- Element order, length and copy (non-aliasing) semantics are asserted
  claim-backed, not vacuously.
- Dynamic-length sources still reject, with the typed arm preserved.
- `check:ir-fallbacks` shows no bucket growth; `gen:ir-adoption --check`
  clean; `check:ir-only` host 37/37 and the standalone floors unchanged.

## Test Results

See `tests/issue-4487.test.ts`.
