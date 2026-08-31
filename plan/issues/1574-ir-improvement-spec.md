---
id: 1574
title: "IR Type Analysis & Optimization Pass Improvements"
status: ready
created: 2026-05-21
updated: 2026-05-21
goal: ir-retirement
sprint: Backlog
owner: architect
related: 1131, 1167a, 1167b, 1167c, 1126, 1231, 1169, 1370, 1373
---
# IR Type Analysis & Optimization Pass Improvements

A research document scoping concrete, file/line-anchored improvements to the
middle-end IR's type analysis and post-IR optimization passes. The companion
agent (`arch-ir`, task #85) tracks **why** functions still fall back to legacy
direct-emit; this document assumes the function is already on the IR path and
asks **what better Wasm can we emit for it.**

Reading order for a dev picking up any item below:

1. The "Current state" pointers in §1.
2. The §6 quick-wins table for low-risk, high-ROI starters.
3. The relevant per-item spec in §2 / §3 / §4 with file + line citations.

---

## Section 1: Current IR type system — strengths and gaps

### 1.1 What the IR currently tracks

The middle-end IR (`src/ir/nodes.ts`) carries an `IrType` discriminated union
that covers:

| `IrType.kind`  | Storage                              | Where it's produced                                                |
|----------------|--------------------------------------|--------------------------------------------------------------------|
| `val { val }`  | a `ValType` (i32, i64, f32, f64, …)  | leaf nodes, arithmetic, comparison                                 |
| `val { signed }` (#1126 Stage 1) | `i32` w/ signedness fact | `js.bit*` chains, comparisons, conversions                         |
| `string`       | backend-resolved (extern or `$AnyString`) | string literals, `string.concat`                              |
| `object { shape }` | `(ref $S)` for canonicalised struct | object literals, propagated #1231 inference                       |
| `closure { signature }` | `(ref $base)` + subtype for captures | function expressions / arrow fns                              |
| `class { shape }` | `(ref $ClassStruct)`                | `new ClassName(...)` (#1169d)                                      |
| `extern { className }` | `externref`                     | `extern.new`, `extern.regex` (#1169i)                              |
| `union { members }` | `$union_<members>` tagged struct | propagation (`f64 \| bool`), `box`/`unbox`/`tag.test`              |
| `boxed { inner }` | `$box_<inner>` ref-cell struct      | mutable closure captures                                           |

Propagation (`src/ir/propagate.ts`) computes a per-function `TypeMap` over a
seven-element lattice (`unknown / f64 / i32 / u32 / bool / string / object /
union<atoms> / dynamic`). Worklist fixpoint runs to ≤ 50 iterations, with a
`LATTICE_UNION_MAX_MEMBERS = 4` cap and a `LATTICE_OBJECT_SHAPE_MAX_DEPTH = 3`
cap to guarantee termination.

### 1.2 Where type information is **lost or imprecise**

1. **No control-flow narrowing.** The IR has no concept of "this value's type
   is `f64` only on the then-branch of `if (typeof x === 'number')`". The
   AST→IR lowerer (`src/ir/from-ast.ts:1381`) maps an IR type → typeof string
   for emitting `typeof` itself, but the **inverse** (narrowing on a typeof
   comparison) is absent. As a result, a function like
   `function format(x: number|string) { return typeof x === 'string' ? x.length : x + 1; }`
   either falls back entirely or compiles every branch with the widest type.

2. **Non-null narrowing is ad-hoc.** `IsIrTypeNullable` is checked at
   property-access sites (`from-ast.ts:118-120`, the `#1375` TS-narrowing
   fast-path). A single non-null narrowing helper is missing; every callsite
   re-derives the fact via `getNonNullableType()` on the TS checker. Inside
   the IR (post-`if (x !== null)`), the IR builder still emits
   `ref.as_non_null` even when the same SSA value is already provably
   non-null in this block.

3. **Lattice atoms drop signedness on join.** Stage 2 of #1126 added `i32`
   and `u32` atoms, but `join(i32, u32) = f64` (because the atoms widen to
   the smallest common supertype that still has Wasm representation).
   Programs that mix `>>> 0` with `| 0` lose i32-domain typing on the join,
   triggering a `convert_i32_s` / `convert_f64_i32` roundtrip.

4. **No return-type backflow through monomorphize clones.** The pass clones
   polymorphic helpers (`src/ir/passes/monomorphize.ts:55-67`) but operates
   under a hard guard: "body instructions do NOT consume any parameter as an
   operand" (lines 28-34). The guard structurally rules out the most
   valuable monomorphization targets — typed helpers like
   `function add(a, b) { return a + b; }` — because their bodies *do*
   consume `a` and `b`. Re-inferring `resultType` after clone-time param
   substitution is the listed follow-up; it has not landed.

5. **TypeMap is not consulted for **locals**, only for params and returns**
   (`propagate.ts:82-87`). A `let x = someTypedCall();` assigns an `unknown`
   to `x` for cross-function reasoning, even when the callee's TypeMap entry
   precisely returns `f64`. Within from-ast's per-function inference, this
   is recovered by inferring expression types at the SSA build site; across
   function boundaries (e.g. when `x` is later passed to another local
   function), the fact is lost.

6. **Object-shape inference formerly carried a default-on emergency
   rollback.** #1231 retired that frontend fact-changing switch on 2026-08-31;
   unannotated `{x, y}` returns now always use the bounded shape inference.
   The conservative widening rules remain: when the inference cannot prove a
   closed shape, the returned IR type collapses to `dynamic` and the function
   falls back.

7. **Class types are nominal-only.** `classShapeEquals` (`nodes.ts:302-304`)
   compares classes by `className` alone, on the documented assumption "one
   declaration per class per unit." Cross-unit class types (which arrive
   when we wire ES modules / .d.ts) will need structural equality plus a
   resolver-level identity map; today the IR has no representation for
   "this `extern.SomeClass` is the same type as our local `SomeClass`."

8. **No constant tracking for ref-typed values.** `IrConst` covers i32, i64,
   f32, f64, bool, null, undefined. `ref.is_null` is documented in
   `passes/constant-fold.ts:259-264` as non-foldable for that reason — the
   IR cannot represent a known-null or known-non-null reference symbolically.
   Branches on `recv?.method()` therefore stay dynamic even when the
   receiver is a `new ClassName(...)` literal upstream.

### 1.3 TypeScript information available but **not used**

The TS checker exposes:

- **Narrowed types** at each AST node (via `checker.getTypeAtLocation(node)`),
  which already reflect typeof / truthiness / discriminated-union narrowing
  done by TS itself.
- **Signatures** for property accesses (`checker.getResolvedSignature`) —
  including overload selection and inferred return types of generic methods.
- **Symbol flags** distinguishing `const` from `let` and `readonly` fields
  from mutable ones.
- **Branded primitives** (e.g. `type UserId = number & { __brand }`) which
  always erase to `number` in TS but carry semantic information the IR could
  use to keep two distinct `f64` locals in disjoint domain space (no impl
  consequence today, future-proofing).

Of these, only **narrowed types at the function-signature level** are read
(via `seedReturnType` → `tsTypeToLattice` in `propagate.ts:379-426`).
Per-statement / per-expression narrowing is unused.

---

## Section 2: Type analysis improvements

For each item: title → mini-issue spec (current / proposed / mechanism /
impact / difficulty).

### 2.1 Control-flow narrowing for `typeof x === "string"` and `typeof x === "number"`

**Current behavior.** The selector accepts `typeof x === "string"` as a
Phase-1 binary expression (`select.ts:1506-1514`), but the lowering produces
an i32 bool comparison only — the then-branch's reference to `x` keeps the
widest type (typically `union { f64, string }` or `extern`). The body emits
`unbox` / `extern.convert_any` round-trips on every use of `x` inside the
arm.

**Proposed behavior.** When the IR builder encounters an `if (typeof x op
"<literal>")` statement, it should:

1. Tag the then- and else-blocks with a per-SSA-value type override
   (`IrValueId → IrType`) seeded from the typeof literal:
   - `"number"` → narrow to `irVal(f64)`
   - `"string"` → narrow to `{ kind: "string" }`
   - `"boolean"` → narrow to `irVal(i32)` (i32 bool)
   - `"object"` → narrow to non-null `object` / `class` / `extern`
   - `"undefined"` → narrow to a sentinel `undefined` IrType
2. Resolve uses of `x` within the arm against the override before the
   per-function `typeOf` map.

**Mechanism.**
- Add a new `IrType` overlay on `IrBlock` (sibling to `blockArgs`) called
  `narrowings: ReadonlyMap<IrValueId, IrType>`.
- In `from-ast.ts`'s `lowerIfStatement`, before recursing into either arm,
  inspect the condition. Recognise four shapes:
  - `typeof x === "<literal>"` / `typeof x !== "<literal>"`
  - `x === null` / `x !== null` / `x == null` / `x != null`
  - `typeof x === typeof y` (rare; skip)
  - `x instanceof ClassName` (defer to a follow-up)
- Push the narrowing into the arm's block before lowering its body. The
  arm-local resolver walks block.narrowings first.
- Lowerer (`lower.ts`): block narrowings are erased before emission —
  they only affect the IR's type queries, not the Wasm output (Wasm
  doesn't need them; the narrower IR type just unlocks better op
  selection upstream).

**Expected impact.** The body-shape-rejected bucket
(`scripts/ir-fallback-baseline.json` line 4 — 22 unintended) includes a
known cluster of functions that use `if (typeof x === 'string')` to guard
string operations. A best-guess estimate is **5–8 functions claimed back**
into the IR. Bigger win: the *already-claimed* IR functions that use
narrowing today emit one `__unbox_number` / `extern.convert_any` per use of
the narrowed variable; expect ~2-5% Wasm size reduction in code that uses
union-typed locals.

**Difficulty.** Medium. The narrowing detection is mechanical, but threading
the per-block override map through `from-ast.ts`'s `typeOf` / `tryTypeOf`
without breaking the existing `calleeTypes` map needs care. The verifier
(`src/ir/verify.ts`) must learn to accept arm-local type differences
without flagging an SSA-type-mismatch error.

---

### 2.2 Non-null narrowing after `if (x !== null) { … }`

**Current behavior.** The IR's `isIrTypeNullable` is consulted only at
property-access sites and only with the TS checker fast-path
(`from-ast.ts:114-120` for `#1375`). After a programmer-written null check,
every subsequent use of `x` in the then-block still emits `ref.as_non_null`
or a guarded cast at lowering time.

**Proposed behavior.** Recognise `if (x !== null)`, `if (x != null)`, and
truthiness checks `if (x)` (when `x`'s static type is `ref_null T`). Inside
the then-block, the value of `x` has IrType `ref T` instead of `ref_null T`.
Lowering then naturally elides the `ref.as_non_null`.

**Mechanism.** Same as §2.1 — reuse the per-block narrowing overlay. The
condition recogniser adds a fourth shape:

```ts
// `x !== null` or `x !== undefined` or `x != null`
if (isNullCompare(cond)) {
  narrowings.set(x.valueId, nonNullable(typeOf(x)));
}
```

where `nonNullable(t)` strips `ref_null` → `ref` for ValType and leaves
other IrType kinds unchanged (extern is always nullable at the Wasm level,
but most narrowable cases use a structural ref).

**Expected impact.** Mostly Wasm-size and speed. The peephole pass
(`src/codegen/peephole.ts:103-109` — pattern 1) catches `ref.cast +
ref.as_non_null` but the surrounding null-test scaffolding still emits.
Estimate **3–5% reduction in `ref.as_non_null` ops** in IR-claimed
functions, and 1-2 functions claimed back from `body-shape-rejected`.

**Difficulty.** Easy after §2.1 lands. Without §2.1 it's medium because
the block-overlay infrastructure has to be built anyway.

---

### 2.3 Lattice integer-domain join refinement (`i32 ⊔ u32 → i32?`)

**Current behavior.** `join(i32, u32) = f64` in `propagate.ts` (the lattice
widens to the smallest atom that both lower to in Wasm storage — both lower
to `i32`, but the signed/unsigned domain conflicts force a widen). This
loses the i32-domain typing on the join: post-Stage 3 (#1126), chained
bitwise ops convert back to f64 across the join, then back to i32 on the
next operator.

**Proposed behavior.** Introduce an `int32_unspecified` atom (or extend the
i32 atom with `signed: undefined`) that represents "we know the storage is
i32 but we've forgotten the domain." Operations that depend on signedness
(`shr_s` vs `shr_u`, signed vs unsigned compare) check for the unspecified
atom and either:
- Emit the signed variant (matching JS `| 0` semantics) when the consumer
  doesn't care, OR
- Insert an explicit re-sign coercion (`i32` is bit-identical to `u32`, so
  the coercion is free — just a typing fact, no Wasm op).

**Mechanism.**
- Add `signed: "signed" | "unsigned" | "either"` to the `i32` lattice atom.
- `join(i32-signed, i32-unsigned)` → `i32-either`.
- Joining `i32-either` with `f64` still widens to `f64` (Wasm storage
  differs).
- Update `from-ast.ts`'s Stage-3 bitwise lowering to read `signed: "either"`
  as "pick signed default; no coercion needed."

**Expected impact.** Specific to programs with mixed bitwise idioms
(`(h ^ b) | 0`, `(x * P) >>> 0`). Estimate <1% size delta on the test262
corpus but a clean win on the FNV hash / hash mixer benchmarks the team
already uses for #1126 validation.

**Difficulty.** Easy. Three-call-site change in `propagate.ts` plus a
matching read in `from-ast.ts`'s bit-op lowerer.

---

### 2.4 Re-infer `resultType` in monomorphize clones

**Current behavior.** `monomorphize.ts:25-43` lists the "operand-free-of-
params" guard as a hard requirement. A callee like:

```ts
function add(a, b) { return a + b; }
```

uses params as operands and is excluded — even though the call sites have
fully known argument types and the lattice can re-infer the body trivially
after substitution.

**Proposed behavior.** Drop the operand-free guard. When cloning, walk
the clone's instructions and re-set `resultType` based on the substituted
param types using a tiny local inference function:

- `binary(op, lhs, rhs).resultType` = `inferBinaryResultType(op, typeOf(lhs), typeOf(rhs))`
- `unary(op, rand).resultType` = `inferUnaryResultType(op, typeOf(rand))`
- `select.resultType` = `join(typeOf(then), typeOf(else))`
- For other ops, retain `resultType` unchanged (they're already
  param-independent).

If the re-inference cannot type the body (e.g. produces a `dynamic` atom),
abandon the clone — fall back to legacy behavior for the call site.

**Mechanism.**
- Add `reinferTypes(fn: IrFunction, paramOverride: IrType[]): IrFunction | null`
  in `src/ir/passes/monomorphize.ts`. Returns `null` when re-inference
  fails.
- Replace `monomorphize.ts`'s `isMonomorphizable` filter to drop the
  "no param operands" check (lines 28-34), and call `reinferTypes` after
  the clone-and-substitute step. If `null`, skip the clone.
- Verify with the existing `verifyIrFunction` pass — should still pass.

**Expected impact.** Larger than it looks. Every place test262 currently
emits `__box_number` / `__unbox_number` around a call to a polymorphic
helper now emits a typed call instead. Estimate **10-30 functions claimed
back** from `body-shape-rejected` + a measurable speedup (no per-call box
allocations).

**Difficulty.** Medium. The re-inference is small but has to cover every
op in the `IrBinop` / `IrUnop` sets; missing one silently produces wrong
types. Recommend a unit test exercising every op.

---

### 2.5 Propagate locals through the per-function TypeMap

**Current behavior.** `propagate.ts:82-87` and `walkBodyForReturns` (around
`propagate.ts:300+`) only track params + body return values. `let x =
someTypedCall()` doesn't seed `x`'s lattice type for cross-function
reasoning.

**Proposed behavior.** Extend `walkBodyForReturns` to also track simple
local declarations:

```ts
function walkBody(body, scope, entries, onReturn) {
  for (const stmt of body.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const initType = inferExpr(decl.initializer, scope, entries);
          scope.set(decl.name.text, initType);
        }
      }
      continue;
    }
    // ... existing return walk
  }
}
```

The expanded scope flows into `inferExpr` on subsequent statements, so a
later `return otherFunc(x)` sees the precise type of `x` and joins it
correctly into the callee's params via the inbound graph.

**Mechanism.** One function in `propagate.ts`; no change to lattice
constants or `join` rules. The fixpoint termination guarantees still hold
because the scope is per-function (no cycles introduced).

**Expected impact.** Helps recursive numeric kernels that thread an
intermediate `let` through several functions. Estimate **2–4 functions
claimed back** from `param-type-not-resolvable` (`baseline.json` line 5 —
1 unintended remaining; this is a known stragglers list).

**Difficulty.** Easy.

---

### 2.6 Symbolic ref-constant lattice element (`ref-known-non-null`)

**Current behavior.** `IrConst` (in `nodes.ts:376-383`) has no entry for
"a reference that is known to be non-null and of type T." `ref.is_null` is
explicitly listed as non-foldable in `passes/constant-fold.ts:259-264`.
A function that contains `const m = new Map(); m?.get(k);` cannot fold the
`?.` away — even though the IR builder knows `m` is `extern{className:
"Map"}` from an extern.new and therefore non-null.

**Proposed behavior.** Extend `IrConst` with a `ref-non-null` discriminant
carrying the SSA value-id of the producing `new` / `struct.new` / `array.new`
instruction. The constant-folder propagates this through `ref.is_null` →
`bool: false` and (via `br_if` folding) collapses the dead arm of
short-circuit chains.

**Mechanism.**
- Add `{ kind: "ref-non-null"; producer: IrValueId }` to `IrConst`.
- In `constant-fold.ts`, when the producing instruction is
  `class.new` / `object.new` / `extern.new` / `array.new` / `closure.new`,
  seed the const-def map with this kind.
- Extend `foldUnary` for `ref.is_null`:
  ```ts
  case "ref.is_null": {
    if (rand.kind === "ref-non-null") return { kind: "bool", value: false };
    return null;
  }
  ```
- The peephole pass (`src/codegen/peephole.ts`) already has pattern 5
  (ref.test + ref.cast → ref.as_non_null) which exploits the same fact
  at the Wasm-IR level. This proposal does the cleanup one layer earlier,
  before Wasm is even emitted.

**Expected impact.** Optional-chain heavy code (test262 builtins for
TypedArray methods, Map / Set iteration) emits 1-2 fewer ops per chain
link. Estimate **0.5–1% Wasm size on test262**.

**Difficulty.** Easy.

---

### 2.7 Cross-function arg-narrowing via call-site refinement

**Current behavior.** `propagate.ts` joins arg expression types into the
callee's param lattice. A callee called with `f64` from one site and
`unknown` from another collapses to `f64` (since `unknown ⊔ X = X`). But
the callee is then compiled assuming `f64` for ALL its callers, including
the `unknown` one — which must coerce at the call site.

**Proposed behavior.** Run a second pass after fixpoint: for each call
site whose arg type is a strict subtype of the callee's resolved param
type, mark the site as monomorphic. Combined with §2.4, this lets the
monomorphize pass clone the callee per call-site type without needing a
distinct lattice tuple.

**Mechanism.** Tag `CallSite` (in `propagate.ts:432-435`) with an
`argTypes: LatticeType[]` derived from `inferExpr` at the site, separately
from the callee's joined param. The monomorphize pass consults the per-
site `argTypes` instead of (or alongside) the joined callee params.

**Expected impact.** Couples with §2.4. Without §2.4 this is harmless but
also no win. With §2.4 it pushes monomorphize from "n distinct lattice
tuples" to "n distinct call sites" — modest expansion (still bounded by
`MAX_VARIANTS_PER_CALLEE = 4`).

**Difficulty.** Easy as a §2.4 follow-on.

---

### 2.8 Inline-time constant folding (re-run CF in callees)

**Current behavior.** `inlineSmall.ts` splices callee instructions into
the caller and renames operand IDs. The post-inline integration loop runs
`runHygienePasses` (CF + DCE + simplifyCFG) on modified callers
(`integration.ts:354-355`).

**Gap.** When a polymorphic callee is inlined and one of its operands was
a const at the call site, the inlined instructions don't fold immediately
because CF runs **before** inline. Re-running CF after inline catches some
cases but not all — only the inlined arithmetic, not downstream uses in
the caller that were const-defined to a non-const before inline.

**Proposed behavior.** After every `inlineSmall` rewrite that succeeded,
**iterate** CF + DCE on the caller until fixpoint (not just once). The
existing single pass catches the first fold; subsequent folds (e.g. a
const-folded `if` collapsing a block, exposing more const operands in the
fall-through path) need iteration.

**Mechanism.** In `integration.ts:354-355`, wrap `runHygienePasses` in a
fixed-iteration loop (cap 5; in practice 1-2 iterations suffice). The
existing reference-equality check (`changed = afterCF !== before`)
terminates cheaply.

**Expected impact.** Tiny on the unintended fallback count (no claim
delta); modest on Wasm size for IR-claimed functions that inline heavily.
Estimate **0.3–1% Wasm size** on programs with several thin wrapper
functions.

**Difficulty.** Trivial.

---

### 2.9 Branded primitives and TS-only types preserved across the IR boundary

**Current behavior.** `tsTypeToLattice` (`propagate.ts:402-426`) maps TS
types to lattice atoms by flag checks. Branded types like
`type UserId = number & { __brand }` carry `NumberLike` flag → lattice
`F64`. The brand is erased.

**Future-proofing proposal.** Add a `brand: string` annotation to the i32
/ f64 lattice atoms that survives joins (joining two same-branded atoms
preserves the brand; joining differently-branded atoms erases it). The
IR doesn't use the brand for anything today, but the field reserves space
for a future "disallow `Celsius + Fahrenheit`" diagnostic and is
preserved end-to-end.

**Mechanism.** Single optional field on lattice atoms; defaults to
`undefined`; joins drop on mismatch.

**Expected impact.** Zero today. Defensive infrastructure for future
ergonomic features (typed unit arithmetic, distinguishing handle types).

**Difficulty.** Easy, but **defer unless requested** — no immediate user
value.

---

### 2.10 Pass-through of TS-inferred narrowed types into IR

**Current behavior.** Inside a function body, the TS checker has already
narrowed types at every expression. `inferExpr` in `propagate.ts` re-does
this narrowing inside the propagation pass using only the lattice — the
checker's per-node type isn't consulted.

**Proposed behavior.** When the IR builder lowers an expression, instead
of (or alongside) the lattice inference, ask the TS checker for the
narrowed type and convert it to an IrType. The checker has already done
typeof-narrowing, discriminated-union narrowing, and assertion-narrowing
(`assert(typeof x === 'number')`) that our IR-side narrowing pass would
otherwise need to re-implement.

**Mechanism.** Pass `ts.TypeChecker` into `lowerFunctionAstToIr` (already
done via `buildTypeMap`, but the per-expression narrowed type is not
consulted in the lowering loop). On each `Identifier` resolution in
`from-ast.ts`, call `checker.getTypeAtLocation(idNode)` and convert via
`tsTypeToIrType`.

**Cost.** Checker calls aren't free; estimate 5-10ms per IR-claimed
function in larger programs. Gate behind an env var or use sparingly
(only when the SSA-tracked type is `unknown` or `dynamic`).

**Expected impact.** Subsumes §2.1, §2.2, and parts of §2.5 by leaning on
TS's existing narrower. Per-issue impacts add up — estimate **8–15
functions claimed back** total when combined with the lattice work.

**Difficulty.** Hard. The checker has a deep API surface; the conversion
function (`tsTypeToIrType`) needs to handle every TS type kind. The
existing partial implementation (`tsTypeToLattice` in `propagate.ts`) is
the template but covers only the lattice's flat atoms.

---

## Section 3: Optimization passes

### 3.1 Pass: dead-arm elimination in `IrInstrIf` (constant condition)

**What it does.** Currently `constant-fold.ts:103-109` notes that const
`IrInstrIf` conditions ARE recognised but the arms are NOT collapsed:

> we COULD collapse to one branch — left as a future optimization.
> Leaving the if-instr unmodified preserves correctness; we miss the
> dead-arm DCE opportunity.

This pass folds the `if` to a flat splice of the taken arm + binding the
chosen arm value to the if's `result` SSA id.

**Pipeline position.** In `passes/constant-fold.ts:103-109`. Add the
collapse logic in `tryFoldInstr`; on collapse, also rebuild the surrounding
instruction list (splicing the chosen arm in place of the if).

**Expected impact.** Tiny on test262 (rarely is the cond a true const in
real code), but eliminates dead code in inlined callees where the inline
exposed a now-const condition. Estimate **<1% size** but improves
codegen-test stability (smaller diffs).

**Difficulty.** Medium — splicing changes the SSA id density; care is
needed to keep `valueCount` consistent.

---

### 3.2 Pass: strength reduction (`f64.mul x 2.0` → `f64.add x x`, `i32.mul x 2` → `i32.shl x 1`)

**What it does.** Replace multiplications by power-of-two constants with
shifts (i32) or adds (f64). Wasm engines do most of this themselves; we
do it pre-emission so the IR is smaller and downstream passes see fewer
distinct ops.

**Pipeline position.** New pass `src/ir/passes/strength-reduce.ts`, run
after constant-fold and before lower.

**Patterns:**
- `i32.mul x C` where `C` is a power of 2 → `i32.shl x log2(C)`
- `i32.mul x 1` → `x`
- `i32.mul x 0` → `i32.const 0`
- `f64.mul x 2.0` → `f64.add x x` (one fewer immediate byte, no
  semantic change)
- `f64.mul x 1.0` → `x` (CAREFUL: spec-compliant for non-NaN; safe
  because the IR's f64 type is the JS `number`, and `1.0 * NaN === NaN`
  in both forms)
- `i32.shl x 0` / `i32.shr_s x 0` / `i32.shr_u x 0` → `x`

**Expected impact.** Mostly compiler-side wins (smaller IR → faster
later passes). Wasm size: ~0.5%; runtime: Binaryen does these too at
-O2+, so end-binary impact is negligible. The win is in *unoptimized*
output, useful when `--optimize` isn't on.

**Difficulty.** Easy.

---

### 3.3 Pass: common subexpression elimination within a basic block

**What it does.** Within one `IrBlock`, hash each pure instruction by its
op + operands. On hash hit, replace later occurrences with the earlier
SSA value.

**Pipeline position.** New pass `src/ir/passes/local-cse.ts`, run after
constant-fold (so the const-folded operands hash the same) and before
DCE (so the eliminated defs get reaped).

**Pure-op definition.** Mirror the `isSideEffecting` predicate in
`passes/dead-code.ts:57` — any op listed there is NOT eligible. The pure
set is: const, binary, unary, select, box, unbox, tag.test, global.get,
object.get (when the field is `readonly`), refcell.get, vec.len.

**Hash key.** `(op, operands…)` where operands are SSA value ids. Two
defs hash identical iff every operand is the same id (not just same
type) — so `a + b` and `a + c` don't collapse even when `b == c`
dynamically.

**Expected impact.** Common in loops: `arr.length` in `for (let i=0;
i<arr.length;…)` reduces to one length load. The legacy emitter has its
own version of this (`array-element-typing.ts`'s length-hoist); on the
IR side this restores the same optimization for IR-claimed loop bodies.
Estimate **2–4% Wasm size on loop-heavy code**.

**Difficulty.** Easy-to-medium. The `readonly` exception for object.get
requires looking up the IrObjectShape; defer that subcase to a follow-on.

---

### 3.4 Pass: tail-call optimization for self-recursive IR functions

**What it does.** A function whose last expression is `return self(…)`
emits `return_call` instead of `call + return`. The IR already supports
`return_call` in lower.ts; we don't emit it from the IR path today.

**Pipeline position.** Mod-level pass `src/ir/passes/tail-call.ts`, run
post-inline and post-monomorphize so we see the final call graph.

**Patterns recognized.**
- Terminator block ends in `call f` immediately followed by `return v`
  where `v` is the call result and the call has all args fully
  materialized in the same block.
- Same for sibling-call (call to a different function in the same Wasm
  module).

**Expected impact.** Eliminates stack growth in deeply-recursive numeric
kernels (fib, ackermann, parsers). Specific test262 wins: any "for-loop-
as-recursion" stress test. The team's existing fib benchmark is the best
validation target. Estimate **bounded-stack guarantee** for the cases
that previously needed manual conversion to iteration.

**Difficulty.** Medium. The IR's basic-block terminator is `return v`,
not "call followed by return," so the recognition has to look at the
last `IrInstrCall` in the block + the terminator together. Verifier
needs to accept the new "call-then-return" tail terminator if we add a
new kind, OR we can synthesize the existing `return_call` via a special
flag on `IrInstrCall` (`isTail: boolean`).

---

### 3.5 Pass: closure-call devirtualization

**What it does.** When the IR knows a `closure.call` value's `IrFuncRef`
statically (i.e., the closure was constructed in the same function with
a known funcref capture), emit a direct `call` instead of going through
`call_ref` on the funcref field.

**Pipeline position.** New pass `src/ir/passes/devirtualize-closure.ts`,
run after inline (so most thin closures have been inlined first) and
before lower.

**Mechanism.** Track every `closure.new` and remember which funcref it
captured. When a `closure.call` uses an SSA value that has a known
closure.new producer with a literal funcref, replace with a direct
`IrInstrCall` to that funcref's name.

**Expected impact.** Limited to programs that build a closure and call it
immediately (synchronous callbacks). Frequent in `arr.forEach((x) => …)`
style code; the array-method fast-path already devirtualizes these in
legacy codegen (`array-methods.ts`). This pass extends the same fact to
user-written code.

**Difficulty.** Medium. Detecting "the funcref capture is a literal" is
straightforward; tracking the producer through SSA across blocks needs
care. Defer to single-block-producer cases in v1 and extend later.

---

### 3.6 Pass: `extern.convert_any` / `any.convert_extern` round-trip elimination

**What it does.** Recognise the pattern `extern.convert_any` followed
later (possibly in a different block) by `any.convert_extern` on the
same SSA value and eliminate both — the value never left Wasm space,
the round-trip was a no-op.

**Pipeline position.** Either as a new IR-level pass or as a `peephole.ts`
pattern (Wasm-IR level). Wasm-level is simpler — the existing peephole
already handles the analogous `ref.cast + ref.as_non_null` case.

**Mechanism (Wasm-IR level).** In `src/codegen/peephole.ts`, add a
Pattern 7:
```
local.set N    ;; an externref
local.get N
any.convert_extern  ;; ⇒ anyref
...
extern.convert_any  ;; ⇒ externref again — if N's type was externref
                    ;;     and no intervening op consumed the anyref,
                    ;;     both can be removed.
```

**Expected impact.** Surprisingly large — the IR emits coercion pairs
freely when a value crosses from `extern` to a struct ref and back
(common in iterator protocols). Estimate **1-3% Wasm size**.

**Difficulty.** Medium. The detection has to bound the "no intervening
consumer" window; safe approximation is "same basic block, no calls in
between."

---

### 3.7 Pass: short-circuit folding for `&&` / `||` with known left

**What it does.** When the left of a `||` is a known-truthy constant
(`true`, non-zero const, ref-non-null), collapse to just the left. When
the left of `&&` is `false`, collapse to `false`. When `&&`'s left is
truthy, collapse to the right. (`||` falsey-left → right.)

**Pipeline position.** Part of `constant-fold.ts` — add to the binary
table for `i32.and`/`i32.or` when both operands are i32 booleans (the
common case from `from-ast.ts`'s lowering of `&&`/`||`).

**Note.** Today the IR represents `&&` and `||` as i32.and / i32.or **with
both operands fully evaluated** (no short-circuit semantics). This is
semantically wrong for side-effecting RHS but correct for the Phase-1
restricted shape where both operands are pure. The new fold targets the
constant-true / constant-false left specifically and is safe regardless.

**Expected impact.** <0.5% Wasm size. Mainly useful as a follow-on to
`§3.1` (dead-arm elimination of `if`) because folded if-chains often
expose constant `&&`/`||` operands.

**Difficulty.** Trivial.

---

### 3.8 Pass: loop-invariant code motion (LICM)

**What it does.** Detect SSA values defined inside a loop body whose
operands are all loop-invariant (defined outside the loop). Hoist the
definition to the loop's pre-header.

**Pipeline position.** New pass `src/ir/passes/licm.ts`, run after
local-CSE (§3.3) so the dominant CSE opportunities are already collapsed.

**Caveats.**
- Side-effecting ops (call, global.set, raw.wasm) are never hoistable.
- Loops in our IR are represented as `for.loop` / `while.loop` / `forof.*`
  instructions whose `body` is an instruction buffer (`lower.ts:1714-1773`)
  — NOT as back-edges in the block graph. So LICM operates on the
  per-loop body buffer, not the block CFG.

**Expected impact.** Sizable on numerics-loop code (`for (i=0; i<n; i++)
arr[i] = some_const_expression`); modest on test262 (mostly small loops).
Estimate **1-2% on hot loops, near-zero on the average corpus.**

**Difficulty.** Medium. The "definition is loop-invariant" check needs
to look at every operand's def-site and ensure it's outside the loop
body buffer. The buffer-based loop model (rather than CFG-based) makes
that lookup simpler than a typical LICM.

---

### 3.9 Pass: switch-table generation from dense if-else chains

**What it does.** Recognise patterns like
```ts
if (n === 0) return a; else if (n === 1) return b; else if …
```
and emit a `br_table` instead of a cascade of `i32.eq + br_if`. The IR
doesn't represent `br_table` yet (only `br_table` in the `types.ts` Instr
union as a no-immediate placeholder; `select.ts` doesn't even claim
`SwitchStatement`).

**Pipeline position.** New pass; AND a feature gate at the selector level
to claim `SwitchStatement`. Both pieces needed; recommend in this order:
1. Selector slice for `SwitchStatement` lowering to a chain of `br_if`s
   (no perf gain on its own).
2. This pass to consolidate into `br_table`.

**Expected impact.** Substantial speedup for parser-heavy code (handler
dispatch in test262 builtins, state machines). Estimate **5-15% speedup
on switch-dispatch hot paths, near zero size delta** (br_table is more
compact for ≥ 4 cases but each case-body is unchanged).

**Difficulty.** Hard. Requires extending the IR with a `br_table`
terminator AND adding `SwitchStatement` to the selector. Multi-issue
scope. Track as its own goal, not a single pass.

---

### 3.10 Pass: ref.cast elimination when the type is statically known

**What it does.** Today the IR's `lower.ts:1027` and `:1054` emit
`ref.cast` to recover a subtype. When the producing SSA value's IrType is
already provably the subtype (e.g. immediately after a `struct.new` or
a successful `ref.test`-guarded branch), the cast is redundant.

**Pipeline position.** Hybrid: best done at IR level so the lowerer
doesn't emit the redundant op at all. New IR pass
`src/ir/passes/cast-elimination.ts`, run after local-CSE.

**Patterns.**
- `ref.cast T` on a value already typed as `(ref T)` → no-op.
- `ref.cast T` on a value of type `(ref U)` where `U <: T` → no-op.
- `ref.cast T` immediately after `ref.test T → bool: true (constant)` →
  the cast becomes `ref.as_non_null` only (or no-op if the type is
  already non-null).

**Expected impact.** Modest — most of these are already caught by the
peephole pass at the Wasm-IR level (`peephole.ts:103-109` pattern 1).
The IR-level version catches an additional ~20% of cases that don't
adjacency-pair after lowering. Estimate **0.5-1% Wasm size.**

**Difficulty.** Easy after §2.6 (ref-known-non-null lattice) lands.

---

## Section 4: WasmGC-specific opportunities

### 4.1 Field-access devirtualization on monomorphic receivers

**Insight.** WasmGC's `struct.get $S $f` requires the input to already be
`(ref $S)`. When the receiver's static IrType is `class { shape:
{className: "Point"} }`, the resolver already knows the struct typeIdx
and the field offset for `x`. No dispatch table is needed; the lowering
is a single `struct.get`.

This already works for `IrType.class` (`lower.ts:1112-1138`,
`class.get`/`class.set`/`class.call`). What does NOT work:
- Property accesses lowered through `extern { className: "Map" }` (which
  go through `extern.prop` host calls — fine, that's the contract for
  pseudo-extern classes).
- Polymorphic receivers (`(IrType.union with class members)`) which
  today fall back to `dynamic` since the lattice doesn't support
  "union-of-class".

**Proposal.** Add `union<class>` as a representable lattice atom (NOT a
backend storage type — backend stays at the supertype). The IR lowerer
emits `ref.test` chains for fields that exist on a subset of the union's
members, and `struct.get` directly on the common supertype's fields.

**Expected impact.** Unblocks discriminated-union OOP patterns:

```ts
type Shape = Circle | Square;
function area(s: Shape): number { return s.kind === "circle" ? Math.PI * s.r * s.r : s.s * s.s; }
```

— today `area` falls back. With this feature, claim back **~5 functions
in test262** for the discriminated-union surface area, plus any user
code that uses tagged unions.

**Difficulty.** Hard — requires lattice changes, IR-type changes,
resolver changes, and a verification pass.

---

### 4.2 Escape analysis for stack-only structs (note as future opportunity)

**Insight.** A `struct.new $S` whose only uses are field reads in the
same function and which is never stored / passed / returned could in
principle be "unboxed" — replace the struct with individual locals for
each field, never allocate. WasmGC has no stack allocation today; this
would have to be a pure IR-level rewrite.

**Caveat.** Major complexity (alias analysis, escape tracking through
calls, mutability). **Not recommended for near-term work** — track as
future improvement.

**Expected impact.** Substantial GC pressure reduction on object-heavy
inner loops. But the test262 corpus is not GC-bound today (Wasm's
generational GC handles thousands of small allocs cheaply).

**Difficulty.** Hard.

---

### 4.3 Sub-struct sharing for inline-record-typed object fields

**Insight.** When an `IrObjectShape` has a field whose type is itself an
`IrObjectShape`, the resolver registers two separate struct types. A
future optimisation could inline the inner struct's fields into the
outer struct, eliminating one heap allocation. Requires careful aliasing
analysis (the inner struct must never be observed as a separate
identity).

**Difficulty.** Hard. Defer.

---

### 4.4 Vec specialization: `(ref $arr_f64)` instead of `(ref $arr_externref)`

**Status.** Already implemented (`#1181` / Slice 6 — `resolveVec` returns
a vec lowering keyed on element ValType). The IR claims `T[]` /
`Array<T>` with concrete `T` and the vec struct uses the matching
WasmGC array type. **Note in this section for completeness** — no new
work proposed.

---

### 4.5 Devirtualized iterator protocol

**Insight.** `__iterator`/`__iterator_next`/etc. (host imports) are
called whenever a `for-of` loop sees a non-vec, non-string iterable.
When the IR knows the iterable is a `Map`, `Set`, or other extern with a
known iterator implementation, the host call can be replaced by direct
WasmGC ops against the extern's internal storage.

**Caveat.** Requires exposing the extern class's iterator-emitting
methods through the IR resolver. Tight coupling to the host extern-class
machinery — design with care. Reasonable target post-#1238.

**Difficulty.** Medium. Slice as: (1) Map; (2) Set; (3) generators.

---

## Section 5: Priority-ordered backlog

Sort key: `(claim-back functions × Wasm-size delta × confidence) / difficulty`.

| Rank | Title                                                                   | Impact (claims / size) | Difficulty | Depends on |
|------|-------------------------------------------------------------------------|------------------------|------------|------------|
| 1    | §2.4 Re-infer resultType in monomorphize clones                         | 10-30 / 2-5%           | Medium     | —          |
| 2    | §2.1 Typeof control-flow narrowing                                      | 5-8 / 2-5%             | Medium     | per-block overlay |
| 3    | §3.3 Local CSE within basic block                                       | 0 / 2-4%               | Easy-med   | —          |
| 4    | §2.2 Non-null narrowing                                                 | 1-2 / 3-5%             | Easy       | §2.1 overlay |
| 5    | §3.4 Tail-call optimization (return_call)                               | 0 / stack savings      | Medium     | —          |
| 6    | §3.6 extern.convert_any / any.convert_extern round-trip elimination     | 0 / 1-3%               | Medium     | —          |
| 7    | §2.5 Locals in propagation TypeMap                                      | 2-4 / 0.5%             | Easy       | —          |
| 8    | §2.6 Symbolic ref-non-null lattice                                      | 0 / 0.5-1%             | Easy       | —          |
| 9    | §3.1 Dead-arm elimination in `IrInstrIf`                                | 0 / <1%                | Medium     | —          |
| 10   | §3.5 Closure-call devirtualization                                      | 0 / 1-3% (hot)         | Medium     | —          |
| 11   | §3.10 IR-level ref.cast elimination                                     | 0 / 0.5-1%             | Easy       | §2.6       |
| 12   | §3.2 Strength reduction                                                 | 0 / <0.5%              | Easy       | —          |
| 13   | §3.7 Short-circuit folding                                              | 0 / <0.5%              | Trivial    | §3.1       |
| 14   | §2.10 TS-checker per-expression narrowing pass-through                  | 8-15 / 2-4%            | Hard       | —          |
| 15   | §4.1 Field-access devirt on monomorphic receivers (union<class>)        | 5+ / 2-3%              | Hard       | lattice extension |
| 16   | §3.8 LICM                                                               | 0 / 1-2% (hot loops)   | Medium     | §3.3       |
| 17   | §3.9 Switch-table generation                                            | 0 / 5-15% (switch hot) | Hard       | selector slice |
| 18   | §2.3 Lattice i32 vs u32 join refinement                                 | 0 / <0.5%              | Easy       | —          |
| 19   | §2.8 Iterate CF + DCE post-inline                                       | 0 / 0.3-1%             | Trivial    | —          |
| 20   | §2.7 Cross-function arg-narrowing call-site refinement                  | depends on §2.4        | Easy       | §2.4       |
| 21   | §4.5 Devirtualized iterator protocol                                    | 0 / depends            | Medium     | extern-class work |
| 22   | §2.9 Branded primitives (defensive)                                     | 0 / 0                  | Easy       | — (defer)  |
| 23   | §4.2 Escape analysis                                                    | 0 / GC pressure        | Hard       | — (defer)  |
| 24   | §4.3 Sub-struct inlining                                                | 0 / GC pressure        | Hard       | — (defer)  |

---

## Section 6: Quick wins (≤ 1 day each)

Cherry-picked from the backlog. A dev with no prior IR exposure can
implement any of these in a session by following the linked spec section.

| # | Title | Section | Expected outcome |
|---|-------|---------|------------------|
| Q1 | Iterate CF + DCE in post-inline integration loop | §2.8 | Single 5-line change in `integration.ts:354`; small Wasm size win. |
| Q2 | Symbolic ref-non-null lattice for `IrConst` | §2.6 | Add one `IrConst` variant + ~10 lines in `constant-fold.ts`. Eliminates `?.` overhead on `new` results. |
| Q3 | Strength reduction pass | §3.2 | New 60-line file; pure rewrite, no IR-shape changes. |
| Q4 | Lattice `i32 vs u32 join` refinement | §2.3 | One-field-on-atom change + 3 callsites in `propagate.ts`. |
| Q5 | Local CSE within basic block (`global.get`-only fast slice) | §3.3 | Start with the safest pure ops (`global.get`, `const`); extend later. ~150 LOC. |
| Q6 | Locals in propagation TypeMap | §2.5 | Single function in `propagate.ts` (~30 lines). Claims back a handful of functions. |
| Q7 | Short-circuit folding for `i32.and`/`i32.or` with known boolean operand | §3.7 | 20 lines in `BINARY_FOLD_TABLE` of `constant-fold.ts`. |
| Q8 | Dead-arm collapse for `IrInstrIf` with const cond | §3.1 (subset: don't rebuild SSA) | Punt on full splice; just record the dead arm in DCE liveness so its instructions get reaped. ~50 LOC. |

For each quick-win, the dev workflow is:

1. Read the §-section spec in this doc.
2. Read the cited file(s) in `src/ir/`.
3. Add a test case in `tests/ir/` (mirroring existing tests for the pass).
4. Implement + verify.
5. Run `pnpm run check:ir-fallbacks` to confirm no fallback regressions
   (Q6 should *reduce* counts, others should be neutral).
6. Run `npm test -- tests/equivalence.test.ts` for the affected scope.

---

## Appendix A: How a dev integrates a new IR pass

The pipeline lives in `src/ir/integration.ts`. New passes plug into one
of two stages:

1. **Per-function hygiene loop** (`runHygienePasses` around line 660):
   currently `constantFold → deadCode → simplifyCFG` iterated to fixpoint.
   Add a new pure pass (CSE, strength-reduce, cast-elim) into the loop
   in topological order — CSE before DCE, strength-reduce before CSE.

2. **Module-scope pass sequence** (lines 344-394):
   `inlineSmall → re-hygiene → monomorphize → taggedUnions → re-hygiene`.
   Devirtualization, tail-call, LICM go here. Order them carefully:
   - Devirtualization BEFORE inline (so devirt'd calls become eligible).
   - Tail-call AFTER monomorphize (so the call target is final).
   - LICM AFTER local-CSE (so hoisted ops aren't redundant with hoisted siblings).

Every pass must:
- Return the same `IrFunction` / `IrModule` reference if it made no changes
  (so the surrounding loop can detect fixpoint via `Object.is`).
- Preserve the verifier invariants (`verifyIrFunction` runs after every
  pass in integration.ts).
- Be pure (idempotent given the same input).

---

## Appendix B: Open architectural questions for the team

1. **Should narrowing live on `IrBlock` or be a separate `IrTypeOverlay`
   structure?** The block-attached approach (§2.1, §2.2) is simpler but
   adds a field every block carries; the overlay approach is cleaner but
   requires plumbing through more APIs.

2. **Lattice extension policy.** Adding new atoms (`§2.3` u32 specifics,
   `§4.1` union<class>) interacts with the union member cap
   (`LATTICE_UNION_MAX_MEMBERS = 4`). When the cap is hit, do we widen
   to `dynamic` (current) or to a narrower fallback (e.g.
   `union<object>`)? This is a future-design question.

3. **Devirtualization vs inlining ordering.** Doing devirt before inline
   reaches more sites; doing it after inline is simpler (the inlined
   bodies already carry the resolved funcrefs as IrFuncRef-typed const
   captures). Pick one and document.

4. **Pass framework cost.** Each new IR pass adds compilation latency.
   Running every IR-claimed function through every pass on every compile
   may not stay tractable at 100+ passes. Recommend a tiered approach
   (per-function hygiene = cheap, always-on; module-scope = opt-in via
   level flag, like Binaryen's `-O1`/`-O2`).

---

*End of spec.*
