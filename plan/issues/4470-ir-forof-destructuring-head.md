---
id: 4470
title: "ir: adopt destructuring for-of heads — BLOCKED on the nested-vec element carrier (measured)"
status: blocked
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: ttraenkler/opus-4470
priority: medium
horizon: s
feasibility: hard
task_type: adoption
area: ir
goal: ir-full-coverage
related: [3518, 3583, 2952, 2379]
---

# #4470 — IR adoption of destructuring for-of heads

## Problem

`for (const [p, q] of arr)` rejects the whole enclosing function from the IR
front-end. Per the `ForOfStatement` row of `plan/log/ir-adoption.md` (measured
2026-08-15, #3583) the reject arm is `nontail-forof` — `isPhase1ForOfInScope`
requires `ts.isIdentifier(decl.name)`.

The planned slice was: lift that arm for a simple ARRAY pattern, keep the
existing for-of loop, and expand the pattern inside the loop body by reusing
`lowerArrayPattern` — the same per-leaf `vec.get` lowering the VariableStatement
destructuring row already claims.

## Outcome — the head is NOT the blocker; the element carrier is

The head change is small and works. The blocker is one layer down: the pattern's
source is the **for-of element**, so adopting the head requires an element that
is *itself an indexable vec*. **The IR cannot represent a vec whose element is a
vec**, at either of two independent layers, and lifting the selector arm without
fixing that turns programs that compile today into **hard compile errors**.

Do not re-attempt the selector change on its own.

### Measured — head shapes, before (main @ 3faec1ae)

`planIrCompilation(..., { trackFallbacks: true })`, arm detail via
`JS2WASM_IR_SHAPE_DIAG=1`. Subject `f`, iterable a param.

| head shape                    | claimed | reject arm                         |
| ----------------------------- | ------- | ---------------------------------- |
| `for (const r of rows)`       | CLAIM   | —                                  |
| `for (const [a, b] of rows)`  | no      | `nontail-forof:ForOfStatement`     |
| `for (const [a] of rows)`     | no      | `nontail-forof:ForOfStatement`     |
| `for (const [, b] of rows)`   | no      | `nontail-forof:ForOfStatement`     |
| `for (const [a = 1] of rows)` | no      | `nontail-forof:ForOfStatement`     |
| `for (const [[a]] of rows)`   | no      | `nontail-forof:ForOfStatement`     |
| `for (const [a, ...r] of …)`  | no      | `nontail-forof:ForOfStatement`     |
| `for (const { x } of pts)`    | no      | `nontail-forof:ForOfStatement`     |
| `for (let [a, b] of rows)`    | no      | `nontail-forof:ForOfStatement`     |

Every shape rejects at the same arm — the row's claim reproduces exactly.

### Measured — head shapes with the arm lifted (prototype)

Selector change: accept `ts.isArrayBindingPattern(decl.name)` when it passes the
existing `isPhase1BindingPattern` (identifier leaves, no default / rest / nesting;
sparse holes allowed), add the leaf names to the inner scope. Object patterns and
wider array patterns keep rejecting, at new arms `forof-head-object-pattern` /
`forof-head-pattern-complex`.

| head shape                    | claimed | reject arm                                        |
| ----------------------------- | ------- | ------------------------------------------------- |
| `[a, b]` / `[a]` / `[, b]`    | CLAIM   | —                                                 |
| `let [a, b]`                  | CLAIM   | —                                                 |
| `[a, b]` + break/continue     | CLAIM   | —                                                 |
| `[a = 1]` / `[[a]]` / `[a,…r]`| no      | `forof-head-pattern-complex:ArrayBindingPattern`   |
| `{ x }`                       | no      | `forof-head-object-pattern:ObjectBindingPattern`   |

So the selector side is a solved problem. What it claims cannot be lowered.

### Measured — the element carrier (this is the blocker)

`compile(..., { experimentalIR: true, trackIrOutcomes: true })`, outcome read off
`irOutcomes` for the subject function, with the prototype applied:

| iterable type            | outcome                                                                                | severity                |
| ------------------------ | -------------------------------------------------------------------------------------- | ----------------------- |
| `number[][]`             | `unsupported@resolve` — `array element TypeNode ArrayType could not be lowered to a primitive ValType` | soft demote to legacy   |
| `Array<Array<number>>`   | `unsupported@resolve` — same, via `Array<T>`                                            | soft demote to legacy   |
| `[number, number][]`     | `unsupported@resolve` — `unsupported TypeNode kind TupleType`                           | soft demote to legacy   |
| `string[][]`             | `invariant@resolve` — `prepared vec element vec<externref> is not supported`             | **HARD compile error**  |
| `any[][]`                | `invariant`/`unsupported@build` on the first op over an externref leaf                   | mixed, some hard        |

Two independent layers refuse a nested vec:

1. **`resolvePositionType`** (`src/codegen/index.ts` ~L989) — for `T[]` it accepts
   an element that resolves to `f64`/`i32` (→ `irVec`) or to
   `string`/`dynamic` (→ externref). A `number[]` element resolves to
   `irVec(f64)`, whose `kind` is `"vec"`, matches no arm, and throws.
2. **`prepared-vector-support.ts` L70** — the prepared-vector registry accepts
   element ValTypes `f64`/`i32`/`externref` only. `string[][]` gets past layer 1
   (its inner `string[]` resolves to a `ref_null $vec_externref`, a `val`), then
   dies here as an `invariant`, which is a **hard error**, not a demote.

### Layer 2 is a LIVE bug on `main`, not just a #4470 blocker

Measured on `main` @ `3faec1ae` with **no change applied** and a plain
**identifier** head:

```ts
function f(rows: string[][]): number {
  let n = 0;
  for (const r of rows) { n = n + 1; }
  return n;
}
```

→ `success: false`, `invariant@resolve`, `unexpected-internal-throw`,
`prepared vec element vec<externref> is not supported`. **A plain `for-of` over
a `string[][]` parameter does not compile today.** The claim is taken (layer 1
passes), the prepared-vector registry then refuses the logical
`vec<vec<externref>>`, and because that is an `invariant` rather than an
`unsupported`, it hard-fails instead of demoting to the perfectly good legacy
body. Pinned in `tests/issue-4470.test.ts` section C as a KNOWN DEFECT so the
fix is noticed. Worth its own issue — the lead should allocate an id; it is
user-visible and independent of any IR adoption work.

The flat control cases are healthy: `number[]` for-of and `const [a, b] = xs`
over a `number[]` both claim and emit IR bodies.

### The regression this would have shipped

Five `string[][]` programs, base vs prototype, same source, `compile()` +
instantiate + call:

| program                            | base (main)            | with the arm lifted            |
| ---------------------------------- | ---------------------- | ------------------------------ |
| concat both leaves                 | legacy, `"abcd"` ✓     | soft demote, `"abcd"` ✓        |
| count iterations, leaves unused    | legacy, `2` ✓          | **HARD CE** (`invariant@resolve`) |
| bind first leaf, return it         | legacy, `"y"` ✓        | **HARD CE** (`invariant@build`)   |
| sparse `[, b]` concat              | legacy, `"BD"` ✓       | soft demote, `"BD"` ✓          |
| break/continue                     | legacy, `"2"` ✓        | soft demote, `"2"` ✓           |

Two of five working programs become compile errors. That is the whole finding:
the reject arm named in the matrix is real but is *not* the constraint, and
removing it is a net negative until the carrier exists.

## What would unblock this

In order — the head change is last, not first:

1. Represent a vec whose element is a vec. That means an arm in
   `resolvePositionType` for `elemIr.kind === "vec"` (register the inner vec and
   use its `ref_null` as the outer element ValType) **and** nested logical vec
   support in `prepared-vector-support.ts` (value-rep / #2379 territory).
2. Only then lift `nontail-forof` for array patterns. The lowering is ~10 lines:
   thread a `ForOfBinding` (`name | pattern`) through `lowerForOfStatement` →
   `lowerForOfVec`, and inside `collectBodyInstrs`, ahead of the user statement,
   `lowerArrayPattern(pattern, cx.builder.emitSlotRead(elementSlot), bodyCx)`.
   Emitting from inside the body collector is what makes the leaf reads re-run
   per iteration. Reject the pattern head on the string and iter-host arms — a
   `(ref $AnyString)` char and an opaque externref are not indexable.
3. Residuals that stay rejecting either way: defaults (`[a = 1]`), nesting
   (`[[a]]`), rest (`[a, ...r]`), and OBJECT patterns (the for-of element slot
   carries a `val` ValType, not `IrType.object`, so `lowerObjectPattern` has
   nothing to bind against).

## Adjacent pre-existing defects (NOT caused by this issue)

Both confirmed against base with no prototype applied. Each deserves its own
issue; both are orthogonal to the for-of head.

1. **`string[][]` for-of is a hard CE** — see "Layer 2 is a LIVE bug" above.
2. **`.length` on an externref-carried string leaf** is an `invariant@build`
   HARD error, reached by the plain identifier head (`for (const r of rows)`
   over `string[]`) and by the already-claimed var-decl destructuring row
   (`const [a] = row`).

Both share one shape: a claimed unit hits an `invariant` where an `unsupported`
demote would have kept a working legacy body. That classification choice, not
the missing capability, is what turns a gap into a compile error.

## Test Results

`tests/issue-4470.test.ts` pins three things, so the next attempt starts from
evidence rather than from the matrix row:

- the current reject arm for each head shape (selector contract);
- node-equivalent runtime semantics for destructuring for-of heads on the
  current (legacy) path — the semantics a future adoption must preserve;
- the carrier boundary itself: an array-of-arrays iterable does not resolve to
  an IR vec with an indexable element. When someone fixes the carrier these
  assertions flip and point here.

22 tests, all green (`npx vitest run tests/issue-4470.test.ts`, 2026-08-15).
Section B runs each program against Node with the annotations stripped, so the
semantics anchor is a differential check rather than a hand-computed constant.

Gates (no `src/` change in this PR, so the IR budgets are expected to be flat,
and were):

| gate                                | result                        |
| ----------------------------------- | ----------------------------- |
| `tests/issue-4470.test.ts`          | 22/22 pass                    |
| `pnpm run check:ir-fallbacks`       | no growth                     |
| `node scripts/gen-ir-adoption.mjs --check` | clean                  |
| `pnpm run check:ir-only`            | host 37/37, floors unchanged  |
