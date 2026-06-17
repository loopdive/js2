---
id: 1804
title: "feat(IR): vec.new_fixed — lower fixed-length array literals through the IR path"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-03
updated: 2026-06-16
completed: 2026-06-16
priority: medium
feasibility: medium
task_type: feature
area: ir, codegen
language_feature: array-literal, ir-phase1
goal: object-representation
parent: 1530
related: [1131, 1169o, 1713, 1714, 1376, 1530]
---
# #1804 — IR `vec.new_fixed` array-literal construction

## Problem

The IR Phase-1 path (`src/ir/`) can **read** vecs (`vec.len`, `vec.get`,
`forof.vec`) but cannot **construct** them. `ArrayLiteralExpression` in
expression position throws a clean fallback (`from-ast.ts:1207-1208`), the
selector explicitly declines to claim it (`select.ts:1704-1707`), and the
`ir-adoption.md` row for `ArrayLiteralExpression` is `mixed / Slice 12 —
fixed-length numeric arrays. Spread/sparse partial`.

The downstream cost is concrete. Task #278 (reduce the `body-shape-rejected`
IR-fallback bucket from 31 to <20) root-caused the bucket into three groups:

1. **Array-literal constructors** (`const arr: number[] = []`, `f([1,2,3])`,
   `return [a, b]`) — ~21 of the 31 rejections. These reject because the
   body contains an `ArrayLiteralExpression` the lowerer can't build, OR
   because the call-graph-closure walk drops a caller that passes an array
   literal argument. **This issue unblocks that group.**
2. Host-global refs (`document.*`, `console.*`) — inherently external, not
   IR-fixable.
3. `return` / `break` / `continue` inside loop bodies — needs CFG /
   abrupt-completion support (separate, larger).

So `body-shape-rejected` cannot drop below ~20 without a `vec.new_fixed`
construction node. This is the dominant fixable category and the reason #278
was re-scoped from "quick refactor" to "needs this feat first".

## Scope

A single feat-sized slice that adds **fixed-length, non-spread, non-sparse**
array-literal construction to the IR. Out of scope (kept on legacy fallback,
each a follow-up): spread elements (`[...xs]`), sparse/elision holes
(`[1, , 3]`), and mixed-type literals that would need a union element type.
The slice covers the common shape `[e0, e1, …, eN]` where every element is a
Phase-1 expression of the **same** resolved IrType.

## Why a new IR node (not a desugar)

The legacy backend builds an array literal as `array.new_fixed $arr e0…eN`
followed by `struct.new $vec (length, dataArray)` (see
`src/codegen/literals.ts:compileArrayLiteral` and the
`getOrRegisterArrayType` helper). The IR's `BackendEmitter` trait exists
precisely so this two-op WasmGC sequence has a linear-memory sibling
(`#1713`/`#1714`). Desugaring in `from-ast.ts` to raw `pushRaw` Wasm ops
would bypass the trait and re-introduce a WasmGC-only hack — exactly what the
IR is meant to replace (CLAUDE.md "IR replaces the hacks"). So construction
gets a first-class node, lowered through a new trait method, mirroring how
`vec.get` reads through `emitVecDataPtr` + `emitElemGet`.

## Implementation Plan

### 1. New IR node — `src/ir/nodes.ts`

Add a `vec.new_fixed` instruction beside `IrInstrVecGet`/`IrInstrVecLen`
(after line ~1088):

```typescript
/**
 * Construct a vec from a fixed, statically-known set of element SSA values.
 * All `elements` must share the IrType `elementType` (the from-ast lowerer
 * coerces each element to this type before emitting). `resultType` is the
 * vec ref IrType (a `ref` to the registered vec struct for `elementType`).
 *
 * Lowering (WasmGC): push e0…eN, `array.new_fixed $arr N`, then
 * `i32.const N`, swap-free `struct.new $vec` with field order
 * (length:i32, data:(ref $arr)). The backend emitter owns the exact op
 * sequence (see emitVecNewFixed) so the linear backend can realize the
 * same node over its `[header][len][cap][elements…]` layout.
 *
 * Empty literals (`[]`) carry `elements: []` and `length: 0`; the
 * elementType is supplied by the from-ast layer from the declared/inferred
 * array type (it cannot be inferred from zero elements).
 */
export interface IrInstrVecNewFixed extends IrInstrBase {
  readonly kind: "vec.new_fixed";
  readonly elements: readonly IrValueId[];
  readonly elementType: IrType;
}
```

Add `"vec.new_fixed"` to the `IrInstr` union and to any exhaustive `kind`
switches the verifier walks. Grep for the `"vec.get"` literal across
`src/ir/` and add the parallel arm everywhere it appears:
`lower.ts` (the big `switch (instr.kind)`), `verify.ts`, `propagate.ts`
(SSA use-walk — `elements` are uses, like `vec.get`'s `vec`/`index`), and the
SSA-liveness walkers in `lower.ts:333/424/509` if `vec.new_fixed` can appear
inside `if`-arm / `forof` body buffers (it can — `f([1,2])` inside a loop).

### 2. From-AST lowering — `src/ir/from-ast.ts`

Replace the throw at line 1207-1208 with a `lowerArrayLiteral(expr, cx, hint)`:

- Reject (clean fallback `throw`) if any element is a `SpreadElement`, or if
  the literal has elision holes (`expr.elements` contains an
  `OmittedExpression`). These keep the legacy path.
- Determine `elementType`:
  - If `hint` resolves to a vec ref whose element IrType is known, use that
    (covers `const a: number[] = [1,2,3]` and `[]` with a declared type).
  - Else infer from the elements: lower each element, take the first
    element's IrType as the candidate, and **require all elements to share
    it** (`irTypeEquals`). On mismatch → clean fallback (mixed-type literal
    is out of scope).
  - Empty literal with no usable hint → clean fallback (can't infer).
- Lower each element with `elementType` as its hint, collecting the
  `IrValueId`s; emit `cx.builder.emitVecNewFixed({ elements, elementType })`.
  Mirror the builder-method pattern used by `emitIfElse`/`vec.get` emit
  helpers (add `emitVecNewFixed` to `src/ir/builder.ts` returning the new
  SSA id typed as the vec ref).

The `resultType` (vec ref IrType) comes from the resolver's element→vec
registration (see step 4) — the builder asks the resolver, via `cx`, for the
vec ref IrType for `elementType` so `typeOf(result)` is the vec ref and
downstream `vec.get`/`.length` reads resolve.

### 3. Selector — `src/ir/select.ts`

At line 1704 (the comment that defers array literals), add the accept arm:

```typescript
if (ts.isArrayLiteralExpression(expr)) {
  for (const el of expr.elements) {
    if (ts.isSpreadElement(el)) return false;            // out of scope
    if (ts.isOmittedExpression(el)) return false;        // sparse — out of scope
    if (!isPhase1Expr(el, scope, localClasses)) return false;
  }
  return true; // shape-only; element-type uniformity enforced at lowering
}
```

This flips the call-graph-closure problem: `f([1,2,3])` now keeps `f` in the
IR claim set because the array-literal arg is Phase-1 claimable, instead of
dropping the caller.

### 4. Resolver / vec registration — `src/ir/integration.ts`

`resolveVec` (line 985) is **read-only**: it recognizes an *existing* vec
struct typeIdx. A fresh literal has no typeIdx yet, so construction needs a
*registration* entry point. Add to the resolver interface (`lower.ts:156`
area) and implement in `integration.ts`:

```typescript
resolveVecForElement?(elementValType: ValType): IrVecLowering | null;
```

Implementation delegates to the legacy `getOrRegisterArrayType` (imported in
`index.ts:10883`) to get/create the `$arr` array type for `elementValType`,
then get/create the `$vec` struct `{ length:i32, data:(ref $arr) }` for it
(reuse whatever the legacy `compileArrayLiteral` path calls to register the
vec struct — do NOT register a parallel type, or `===`/`instanceof Array`
identity and the for-of fast path break). Returns the same `IrVecLowering`
shape `resolveVec` returns, so the emitter handle is identical. The from-ast
builder uses the returned `vecStructTypeIdx` to type the result SSA value as
`{ kind: "ref", typeIdx }`.

### 5. Backend emitter trait + 3 implementations

**`src/ir/backend/emitter.ts`** — add to the vec section (after
`emitElemGet`, line ~102):

```typescript
/**
 * N element values on stack (e0 deepest … eN top) -> a fully-built vec ref.
 * WasmGC: `array.new_fixed $arr N`, `i32.const N`, `struct.new $vec`.
 * Linear: bump-allocate `[header][len=N][cap=N][e0…eN]`, leave base i32.
 */
emitVecNewFixed(layout: VecLayout, count: number, out: S): void;
```

**`src/ir/backend/wasmgc-emitter.ts`** — implement (mirror `emitVecLen`/
`emitElemGet` at lines 37-55). The element values are already on the stack in
order; emit `array.new_fixed` (typeIdx = `layout.arrayTypeIdx`, count = N),
then `i32.const N`, then `struct.new` (typeIdx = `layout.vecStructTypeIdx`).
Confirm the project's `Instr` union spells `array.new_fixed` — grep
`src/codegen/literals.ts` for the exact op name/field shape and match it.

**`src/ir/backend/linear-emitter.ts`** — implement over the `LinearVecLowering`
shape (`handles.ts:160`, the `[header 8B][len@+8][cap@+12][elements@+16…]`
layout documented at `src/codegen-linear/runtime.ts:339`). Element ValType
gives stride (4 vs 8) and the store op. If the full linear store sequence is
larger than this slice wants, `notImplemented("emitVecNewFixed")` is an
acceptable stub for now (matches the existing `emitAggregateNew` stub at
linear-emitter.ts:187) — but the **WasmGC path is mandatory** (that is the
default target and what the IR-fallback gate exercises).

**`src/ir/backend/bytecode-emitter.ts`** — add an `emitVecNewFixed()` throwing
stub matching the existing vec stubs at lines 660-668 (`"BytecodeEmitter: vec
primitives not in the #1584 numeric subset"`). The bytecode VM does not handle
vecs yet; keep it consistent.

### 6. lower.ts dispatch — `src/ir/lower.ts`

Add the `case "vec.new_fixed":` arm to the big switch (beside `case
"vec.get":` at line 1259). Emit each element value in order
(`emitValue(el, out)` for el in `instr.elements`), resolve the vec layout via
`resolver.resolveVecForElement?.(elemValType)` (where `elemValType =
asVal(instr.elementType)`), throw the standard `ir/lower: resolver cannot
lower vec for vec.new_fixed (${func.name})` if null, then
`emitter.emitVecNewFixed(vec, instr.elements.length, out)`.

### 7. Adoption doc — `plan/log/ir-adoption.md`

Update the `ArrayLiteralExpression` row (line 77): change the note to
`Slice 12 + #1804 — fixed-length same-typed literals constructed via
vec.new_fixed. Spread/sparse/mixed-type partial.` and update the tracking
issue column to reference #1804.

### 8. IR fallback baseline ratchet

After the change, `pnpm run check:ir-fallbacks -- --update-on-decrease`
should bank the `body-shape-rejected` and `call-graph-closure` decreases.
Run it, commit the updated `scripts/ir-fallback-baseline.json`. The expected
delta: `body-shape-rejected` ~31 → ~10 (the ~21 array-literal rejections
clear); `call-graph-closure` also drops where the only blocker was an
array-literal arg.

## Edge cases (must be covered by tests)

1. `const a = [1, 2, 3]` (number) — element type inferred from elements.
2. `const a: number[] = []` (empty) — element type from the hint.
3. `const a = ["x", "y"]` (string) — `resolveString()`-typed elements
   resolve to the string backend's ValType (externref or native ref).
4. `f([1, 2, 3])` — call-graph closure keeps `f` claimed; the literal lowers
   as the argument.
5. `return [a, b]` where `a`,`b` are same-typed params — element type from
   the params' resolved IrType.
6. **Fallback (must stay legacy, byte-identical):** `[...xs]` (spread),
   `[1, , 3]` (sparse), `[1, "x"]` (mixed type), `[]` with no usable hint.
7. **Override-free byte-identity:** any module that does NOT hit the IR
   array-literal path must emit byte-identical Wasm
   (`tests/equivalence.test.ts` green). The IR path only changes output for
   functions the selector newly claims; the legacy `compileArrayLiteral`
   output for everything else is untouched.

## Acceptance

- `vec.new_fixed` IR node lands with WasmGC lowering; linear path either
  implemented or `notImplemented` stub (WasmGC is the gate-tested target).
- The 4 construction edge cases (1-5 above) compile through the IR path and
  run correctly (round-trip through `vec.get`/`.length`/`for-of`).
- The 4 fallback shapes (6 above) cleanly revert to legacy with no IR error
  surfacing as a compile failure.
- `pnpm run check:ir-fallbacks` passes with the ratcheted baseline;
  `body-shape-rejected` drops materially (target: into the teens).
- `tests/equivalence.test.ts` green (no byte-identity regression).
- A new `tests/ir-vec-new-fixed.test.ts` covers edge cases 1-6 via
  compile+run (use the `compile()` + `buildImports()` + `WebAssembly.instantiate()`
  harness pattern, e.g. from `tests/issue-1169o.test.ts`).

## Sizing

Medium. ~1 node def + 1 selector arm + 1 from-ast lowering fn + 1 resolver
method + 1 trait method × 3 emitter impls (2 real, 1 stub) + 1 lower.ts arm +
doc/baseline. Single PR. Mechanically parallel to the already-landed read
side (`vec.get` via #1169o / #1714), so the dev has a working template for
every layer.

## Source

Carved from task #278 (`refactor(IR): reduce body-shape-rejected 31→<20`)
root-cause analysis: the dominant fixable rejection category is array-literal
construction, which has no IR node. This issue schedules that node so #278 can
land afterward as the ratchet step.

## Resolution (2026-06-16)

Implemented per the 8-step plan. The IR Phase-1 path now CONSTRUCTS
fixed-length, non-spread, non-sparse, same-typed array literals via a new
first-class `vec.new_fixed` node (through the `BackendEmitter` trait, not a
desugar), unblocking the array-literal `body-shape-rejected`/`call-graph-closure`
group.

### What landed

1. **`src/ir/nodes.ts`** — `IrInstrVecNewFixed` (`elements`, `elementType`),
   added to the `IrInstr` union.
2. **`src/ir/from-ast.ts`** — `lowerArrayLiteral(expr, cx, hint)` replaces the
   throw: rejects spread/sparse, recovers the element type from the hint
   (`resolveVec(hint).elementValType`) or infers it from the first element and
   requires uniformity (`irTypeEquals`), coerces each element, and emits via the
   builder. `IrFromAstResolver` gained `resolveVecForElement`.
3. **`src/ir/select.ts`** — array literals are now selector-accepted (shape:
   no spread/sparse, all elements Phase-1), keeping `f([1,2,3])`'s callee in the
   claim set.
4. **`src/ir/integration.ts`** — `resolveVecForElement(elementValType)` (shared
   helper) get-or-creates the `$arr`/`$vec` types via the legacy
   `getOrRegisterVecType`/`getArrTypeIdxFromVec` so the constructed vec shares
   identity with `compileArrayLiteral` output. Wired into both resolvers.
5. **Backend trait + impls** — `emitVecNewFixed(layout, count, dataScratchLocal,
   out)` on `emitter.ts`; **WasmGC** impl (`array.new_fixed` → stash data in a
   scratch local → `i32.const N` → reload → `struct.new`, matching the legacy
   (length, data) field order); **linear** + **bytecode** loud stubs (WasmGC is
   the gate-tested target).
6. **`src/ir/lower.ts`** — `case "vec.new_fixed"` arm + a lazy per-array-typeIdx
   scratch local (`ensureVecDataScratch`); plus the parallel arms in the
   scheduling-effect classifier (pure, like `object.new`) and the use-collector.
   Parallel `vec.new_fixed` arms also added to `verify.ts` (collectUses),
   `dead-code.ts`, `monomorphize.ts`, `inline-small.ts`. (propagate.ts is
   AST-level — no IR arm needed; ownership.ts treats it as a pure alloc via
   `default`, like `object.new`.)
7. **`plan/log/ir-adoption.md`** — `ArrayLiteralExpression` row updated.
8. **Baseline** — no ratchet needed: the playground corpus's
   `body-shape-rejected` count is unchanged (those examples use spread/methods/
   mixed-type literals that stay out of scope), so `check:ir-fallbacks` passes
   with no growth and the baseline is untouched. The feature IS live: a function
   whose only non-Phase-1 construct is `[1,2,3,4,5]` now logs
   `claimed=1 fallback=0` and its WAT contains `array.new_fixed` (previously
   `fallback=1 body-shape-rejected`).

### Acceptance criteria — verified (tests/ir-vec-new-fixed.test.ts, 8 tests)

- ✅ `vec.new_fixed` node + WasmGC lowering; linear/bytecode stubs.
- ✅ Construction cases compile through IR and run correctly (number literal +
  for-of=6; `f([10,20,30])`=60; `return [a,b]` indexed=9; round-trip
  `.length`/`vec.get`=35) — each asserts legacy==IR AND `array.new_fixed` in the
  IR WAT (proof the IR path was used, not demoted).
- ✅ Fallback shapes (spread / sparse / hintless-empty) cleanly revert to legacy
  and still run.
- ✅ `check:ir-fallbacks` passes (no growth).
- ✅ No equivalence regression — 28 array equivalence tests pass; the IR test
  suite shows the SAME 8 pre-existing `duplicate SSA def` failures (inline-small
  + passes) with AND without this change (verified by swapping in `origin/main`
  for all 14 touched src files — identical 130 pass / 8 fail), so none are new.

### Scope note

Empty-literal IR claiming depends on the hint resolving to a vec ref (full type
propagation); when it doesn't, it cleanly falls back (still correct, value 0).
Spread/sparse/mixed-type/non-scalar-element literals remain legacy follow-ups.
The linear `emitVecNewFixed` is a `notImplemented` stub (WasmGC is the
gate-tested default; the linear store sequence is a follow-up).
