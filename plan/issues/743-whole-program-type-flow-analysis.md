---
id: 743
title: "Whole-program type flow analysis"
status: ready
created: 2026-03-22
updated: 2026-07-18
priority: critical
feasibility: hard
model: fable
fable_role: spec
reasoning_effort: max
goal: performance
sprint: current
required_by: [744, 904, 905]
related: [773, 745, 2773, 1046, 1124, 1131]
files:
  src/checker/type-mapper.ts:
    breaking:
      - "extend mapTsTypeToWasm with whole-program type context"
  src/checker/index.ts:
    new:
      - "buildCallGraph(): construct inter-procedural call graph"
      - "propagateTypes(): iterative type flow solver across call graph"
  src/codegen/index.ts:
    breaking:
      - "use resolved whole-program types instead of local TS checker types"
  src/codegen/expressions.ts:
    breaking:
      - "use narrowed parameter/return types from whole-program analysis"
---

# #743 — Whole-program type flow analysis

## Status: open

## Problem

js2wasm currently resolves types locally: each function's parameter and return types come from TypeScript's checker, which for untyped JavaScript defaults to `any` → `externref`. This forces boxing/unboxing at every operation boundary, even when static analysis of the entire program could prove concrete types.

With whole-program visibility, the compiler sees _all_ call sites simultaneously — strictly more information than a JIT's speculative type feedback. A function `add(a, b) { return a + b }` called only with numbers should compile to pure `f64.add` with zero overhead, identical to explicitly typed TypeScript.

## Approach

### Phase 1: Call graph construction

Build a directed call graph during the declaration collection pass:

- Nodes: all function/method declarations
- Edges: call expressions → callee declarations
- Track argument types at each call site (from literals, other resolved types)

### Phase 2: Iterative type propagation

Fixed-point solver that propagates concrete types through the call graph:

1. Seed with known types: literals, typed parameters, typed returns
2. Forward propagation: argument types at call sites → parameter types of callees
3. Backward propagation: return types of callees → variable types at call sites
4. Iterate until no types change (convergence guaranteed — type lattice is finite: concrete type → externref fallback)

### Phase 3: Integration with codegen

Replace `ctx.checker.getTypeAtLocation()` lookups with resolved whole-program types where available. Fall back to TS checker types when whole-program analysis is inconclusive.

### Type lattice

```
i32  f64  i64  ref $struct  funcref  externref (top/unknown)
 \    |    /        |          |         /
  \   |   /         |          |        /
   concrete types   |          |       /
         \          |         /       /
          \         |        /       /
           externref (fallback)
```

Types flow upward (widen) on conflict. If all call sites agree → concrete type. If any disagree → externref.

### Example

```javascript
function add(a, b) {
  return a + b;
}
add(1, 2); // a: f64, b: f64
add(3, 4); // a: f64, b: f64 (confirms)
// Result: add compiled as (f64, f64) → f64, pure Wasm arithmetic
```

```javascript
function process(x) {
  return x + 1;
}
process(5); // x: f64
process("hi"); // x: string → CONFLICT with f64
// Result: x stays externref (or monomorphize — see #744)
```

## Relation to existing issues

- Supersedes #684 (usage-based inference) — whole-program analysis is strictly more powerful
- Extends #685 (return type flow) — bidirectional, not just return → call site
- Extends #686 (closure capture types) — captures get concrete types from flow analysis
- Extends #318 (call-site parameter inference) — multi-level, not single-hop

## Complexity: XL

## Implementation Plan (Refreshed: Fable, 2026-07-18 — supersedes the 2026-05-21 Opus draft)

### Audit verdict — the plan below was written before the middle-end IR shipped; most of it is stale

The 2026-05-21 draft (preserved verbatim below, under "Original 2026-05-21
plan") proposed a **new `src/checker/type-flow.ts`** inter-procedural pass wired
between the TS checker and codegen. That was the right idea, but it was **built
in a different place under a different program (#1124 → #1131)**, and four of its
concrete assumptions no longer hold on `origin/main`. Verified against current
main:

1. **`src/checker/type-flow.ts` was NEVER created — the work landed in the
   middle-end IR as `src/ir/propagate.ts`.** #1124 (DONE) decided to insert a
   JS/TS-aware SSA middle-end; #1131 implemented Phase-2 interprocedural type
   propagation there. `buildTypeMap(sourceFile, checker)`
   (`src/ir/propagate.ts:220`) already does exactly the draft's Passes 1-3:
   builds a call graph (`buildCallGraph`, `:241`), runs an optimistic
   fixed-point over a lattice (`LatticeType`, `:131`; atoms
   f64/bool/string/object + `union` capped at `LATTICE_UNION_MAX_MEMBERS = 4`,
   `:138`; `dynamic` = top), and returns a name-keyed `TypeMap`
   (`:192-197`). It even handles the draft's recursion example (`fib`) via the
   optimistic-start-and-refine pattern documented at `propagate.ts:60-73`. It is
   called from `src/codegen/index.ts:1702`. **So "Phase 1/2/3" of the draft are
   substantially DONE — just at the IR layer, not `src/checker/`.** Re-home the
   remaining scope here, the same way #904's review re-homed onto the real
   `src/link/`.

2. **The `ProgramTypeMap` keyed by `ts.Symbol` and attached to `TypedAST` is the
   wrong data model now.** The shipped `TypeMap` is keyed by **function name
   (string)** and carries `IrType`, not `ValType`, and lives in the IR front-end
   — deliberately, so no `ts.Type`/`ts.Symbol` escapes into codegen. The draft's
   `TOP_UNKNOWN` sentinel is the shipped `dynamic` atom; the draft's "reuse
   `ValType` from `shared.ts`" is superseded by `IrType` +
   `lowerTypeToIrType` (`propagate.ts:1154`). Do not attach a second symbol-keyed
   map to `TypedAST`.

3. **The oracle boundary did not exist in May and the draft violates it.** The
   draft's Pass 5 ("replace `checker.getTypeAtLocation()` in
   `codegen/expressions.ts` / `codegen/index.ts` with `ProgramTypeMap` lookups,
   falling back to `mapTsTypeToWasm`") would add raw-checker-adjacent flow into
   codegen. Since #1930/#3273 the **oracle-ratchet gate forbids raw
   `checker.*` in `src/codegen/**`**; new codegen type queries must route through
`ctx.oracle` (`src/checker/oracle.ts`). The correct division is: the
whole-program analysis reads the checker in the **front-end**
(`propagate.ts`is pre-codegen and emits`IrType`, so it is outside the gate),
and any codegen-side consumption goes through `ctx.oracle`. `mapTsTypeToWasm`
still exists (`src/checker/type-mapper.ts:39`) but is a front-end mapper, not a
   codegen entry point.

4. **The "subsumes #684/#685/#686/#318" claims are stale — all four are DONE**
   (verified: `status: done` on each). They landed as independent single-hop
   inferences, NOT via a #743 mega-pass. The Relation section's "supersedes /
   extends" framing should read "historically related; those shipped
   independently." #743's live remainder is the part none of them cover:
   **cross-function AND cross-file whole-program flow feeding monomorphization**.

5. **Value-rep flux (#745/#2773, both in-progress) is unaccounted for.** The draft
   assumes types lower to a fixed `ValType` set with `externref` as the single
   fallback. The value-rep lanes are changing the fallback (tagged `$AnyValue`
   carrier / reconstructed structs). #743 must emit **`IrType` facts** and let the
   value-rep lowering decide the Wasm rep — never bake `externref` as _the_
   fallback. The lattice's `dynamic` atom (with #2949's optional `JsTag`) is the
   value-rep-neutral carrier.

### Net verdict: what's actually left (the refreshed scope)

The whole-program type-flow **engine exists and runs today**, but two gaps
remain — and they are exactly the gaps #773's Slices 2-3 need:

- **Gap A — per-compilation-unit only.** `buildTypeMap` runs on a single
  `sourceFile` (`propagate.ts:220`) and **drops every cross-module callee to
  `dynamic`** (documented at `propagate.ts:80-82`: "does not attempt to infer
  types that cross module boundaries"). Whole-_program_ (cross-file) flow is
  not done. This is the shared substrate for #773 Slice 3, #1046 Slice 4, and
  #904 Pass 1.
- **Gap B — the flow refines _IR-selection_ eligibility, not yet a general
  specialization oracle.** Today `TypeMap` gates which functions the IR selector
  claims (`src/ir/select.ts`) and seeds `calleeTypes` for the lowerer. Exposing
  the same facts as a first-class _monomorphization candidate_ signal (which
  callee is monomorphic-by-observation, with what pin) is the #773 hand-off — a
  thin adapter over the existing `TypeMap`, not a new solver.

### Refreshed plan of record

1. **Do NOT create `src/checker/type-flow.ts`.** Extend `src/ir/propagate.ts`
   (the shipped interprocedural pass) and `src/ir/select.ts` (the consumer).
2. **Close Gap A**: lift `buildTypeMap` from `sourceFile`-scoped to
   module-graph-scoped so imported callees carry real `IrType` facts instead of
   `dynamic`. Cross-`ts.Program` identity is bridged by the `.widl` interchange
   format (#1046) — two separately compiled units have disjoint `ts.Type`
   identities, so the cross-unit seed reads the producer's `.widl`
   (pre-resolved `wasmType`), NOT a shared checker. Any codegen-side binding of a
   cross-module signature routes through `ctx.oracle.signatureOf`
   (`oracle.ts:89`).
3. **Close Gap B**: expose a `monomorphizationCandidates(TypeMap, callGraph)`
   view that #773's pass consumes (the `tupleKey`/`irTypeKey` primitive in
   `src/ir/passes/monomorphize.ts:418` is the shared key). #743 supplies the
   facts; #773 does the cloning.
4. **Value-rep contract**: emit `IrType` (never `ValType`/`externref`); let
   `lowerTypeToIrType` + the value-rep lowering (#745/#2773) materialize the ABI.
   `dynamic`+`JsTag` is the neutral carrier for known unions.

Acceptance and test targets from the original plan (below) still stand where
they measure `externref` reduction / test262 neutrality; the entry point,
data model, and codegen-integration sections are **superseded** by the above.

---

### Original 2026-05-21 plan (SUPERSEDED — retained for provenance)

(Author: architect, 2026-05-21. Concrete plan that wires a new
inter-procedural analysis pass between TS checker and codegen,
reusing existing IR infrastructure in `src/ir/`.)

### Entry point

New module `src/checker/type-flow.ts` exporting:

```ts
export interface ProgramTypeMap {
  paramTypes: Map<ts.Symbol, ValType[]>; // resolved per function
  returnType: Map<ts.Symbol, ValType>;
  localTypes: Map<ts.Symbol, ValType>;
  callGraph: Map<ts.Symbol, ts.Symbol[]>; // callee -> callers
}

export function runTypeFlowAnalysis(program: ts.Program, checker: ts.TypeChecker): ProgramTypeMap;
```

Invoked from `src/checker/index.ts` after `createProgram` in the
existing `buildTypedAST` (line ~80-120 area) before codegen runs.

### Data structure changes

1. **`ProgramTypeMap`** as above, attached to `TypedAST`
   (src/checker/index.ts:43): add field
   `programTypeMap: ProgramTypeMap`.

2. **`CodegenContext`** gains `ctx.programTypes: ProgramTypeMap` —
   passed through `compile(ast)` entry.

3. **Type lattice value** — reuse existing `ValType` from
   `src/codegen/shared.ts`, with a new sentinel `TOP_UNKNOWN` that
   corresponds to externref fallback. `f64`, `i32`, `ref $StructN`
   are concrete; `TOP_UNKNOWN` is the join-on-conflict result.

### Numbered algorithm

1. **Pass 1 — collect functions**
   1. Walk all source files, collect every
      `ts.FunctionDeclaration | ts.FunctionExpression |
ts.ArrowFunction | ts.MethodDeclaration | ts.Constructor`.
   2. For each, record symbol, parameter symbols, parameter
      type-annotations (if any), declared return type (if any).
   3. Seed `paramTypes` with annotated types via existing
      `mapTsTypeToWasm` (src/checker/type-mapper.ts:38).

2. **Pass 2 — collect call sites**
   1. For every `CallExpression` / `NewExpression` resolve callee
      symbol (`checker.getResolvedSignature(call).declaration`).
   2. Add edge `caller → callee` in `callGraph`.
   3. For each argument, compute its observed type from:
      - literal (`42` → f64, `"x"` → string, `true` → i32)
      - identifier whose type is already in `localTypes`
      - prior call's `returnType[callee]`
      - else `TOP_UNKNOWN`
   4. Record at call site as `argTypes[i]`.

3. **Pass 3 — fixed-point solver**

   ```
   changed = true
   while changed:
     changed = false
     for each function f:
       newParam[i] = join(currentParam[i], over all call-sites' argTypes[i])
       if newParam[i] != currentParam[i]: changed = true
     for each function f:
       analyze body of f using currentParam to derive newReturn
       if newReturn != currentReturn[f]: changed = true
   ```

   - `join`: if both equal → that type; else → `TOP_UNKNOWN`.
   - Body analysis: lightweight type-of-expression on AST nodes; for
     `BinaryExpression('+')` with both f64 params → f64; with mixed
     or unknown → TOP_UNKNOWN; for `return e` → type of `e`.
   - Convergence: lattice height is finite (concrete → TOP_UNKNOWN
     is one step); terminates in O(call-graph-depth) iterations,
     typically <10 for real programs.

4. **Pass 4 — locals**
   1. Forward-flow within each function with finalized parameter
      types to populate `localTypes`.
   2. Use existing `src/ir/propagate.ts` as a reference — extend or
      reuse its lattice machinery rather than re-implementing.

5. **Pass 5 — codegen integration**
   1. `src/codegen/expressions.ts`, `src/codegen/index.ts`,
      `src/codegen/declarations.ts`: replace
      `checker.getTypeAtLocation(node)` followed by
      `mapTsTypeToWasm` with `ctx.programTypes.localTypes.get(symbol)
?? mapTsTypeToWasm(checker.getTypeAtLocation(node), checker)`.
   2. Function signatures emitted in `declareFunction` use
      `paramTypes[fn]` + `returnType[fn]` when available, else
      checker fallback.

### Example wasm output — `function add(a, b) { return a + b } add(1,2)`

Before:

```wat
;; add: (externref, externref) -> externref
local.get $a
local.get $b
call $__binary_plus
return
```

After:

```wat
;; add: (f64, f64) -> f64
local.get $a
local.get $b
f64.add
return
```

### Edge cases

- **Recursive calls (`fact(n)`)**: solver handles — fixed-point still
  converges because the recursive edge contributes its current type.
- **Polymorphic call sites with conflicting types**: parameter widens
  to `TOP_UNKNOWN`; emit existing externref path. (Monomorphization
  is #744's job, not #743.)
- **Higher-order functions (`map(f, x)`)**: callee is a parameter;
  treat `f` as funcref and propagate its signature from callers.
  When unknown, fall back to externref dispatch.
- **`arguments` object**: presence forces `TOP_UNKNOWN` for all
  params.
- **`eval` / dynamic property access**: forces `TOP_UNKNOWN` on the
  containing function's locals.
- **Exported functions**: external callers are unknown, so exported
  signatures honour their TS annotations only; non-annotated exports
  stay externref.
- **TS `any` annotation** — explicit `any` is a programmer assertion;
  treat as TOP_UNKNOWN regardless of inference.
- **TS `unknown`**: same as `any` for our purposes.
- **Returns through `throw`**: contributes no return type.
- **Symbol-keyed methods**: keyed by symbol, not name; still track
  via symbol identity.
- **BigInt vs Number**: never join (BigInt promotes to its own
  concrete type via #1535).
- **Class field initializers**: collected at constructor analysis
  time.
- **Generators / async**: returns wrapped in iterator/promise; track
  the inner yield/await type per #680, #1042.

### Performance budget

- Bound by `O(|call-edges| × lattice-height)`; lattice height is
  small (1-2 steps). For test262 sample (~5k functions) expect <2s.
- Cache call-graph between incremental compiles by symbol identity.

### Test262 paths to watch

- `test/built-ins/Math/*` — many monomorphic numeric paths
- `test/language/expressions/addition/*` — confirms f64 specialization
- `test/built-ins/Number/prototype/*` — return-type flow

Acceptance: ≥20% reduction in `externref` use in emitted wasm for
test262 corpus; no test262 regression.

### Dependencies

- **#684** — usage-based inference; #743 subsumes and replaces it.
- **#685, #686, #318** — single-hop / closure-capture inference;
  also subsumed.
- Provides foundation for: **#746** (hidden classes), **#744**
  (monomorphization), **#904** (link-time specialization), **#905**
  (versioned shapes).
- Reuses existing `src/ir/propagate.ts` lattice infrastructure;
  coordinate to avoid duplication.

### Risks

- **TS API performance**: `checker.getResolvedSignature` per call is
  expensive; cache aggressively by call-expression identity.
- **Soundness with mutable globals**: a global variable mutated from
  one function affects another; track via a single
  `globalTypes` slot, joined on every write site.
- **Ship behind `ctx.useTypeFlow` flag**; soak-test in CI for a week
  before defaulting to on.
