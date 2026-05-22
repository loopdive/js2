---
id: 743
title: "Whole-program type flow analysis"
status: ready
created: 2026-03-22
updated: 2026-04-28
priority: critical
feasibility: hard
reasoning_effort: max
goal: performance
required_by: [744, 904, 905]
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

With whole-program visibility, the compiler sees *all* call sites simultaneously — strictly more information than a JIT's speculative type feedback. A function `add(a, b) { return a + b }` called only with numbers should compile to pure `f64.add` with zero overhead, identical to explicitly typed TypeScript.

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
function add(a, b) { return a + b; }
add(1, 2);        // a: f64, b: f64
add(3, 4);        // a: f64, b: f64 (confirms)
// Result: add compiled as (f64, f64) → f64, pure Wasm arithmetic
```

```javascript
function process(x) { return x + 1; }
process(5);       // x: f64
process("hi");    // x: string → CONFLICT with f64
// Result: x stays externref (or monomorphize — see #744)
```

## Relation to existing issues
- Supersedes #684 (usage-based inference) — whole-program analysis is strictly more powerful
- Extends #685 (return type flow) — bidirectional, not just return → call site
- Extends #686 (closure capture types) — captures get concrete types from flow analysis
- Extends #318 (call-site parameter inference) — multi-level, not single-hop

## Complexity: XL

## Implementation Plan

(Author: architect, 2026-05-21. Concrete plan that wires a new
inter-procedural analysis pass between TS checker and codegen,
reusing existing IR infrastructure in `src/ir/`.)

### Entry point

New module `src/checker/type-flow.ts` exporting:

```ts
export interface ProgramTypeMap {
  paramTypes:  Map<ts.Symbol, ValType[]>;  // resolved per function
  returnType:  Map<ts.Symbol, ValType>;
  localTypes:  Map<ts.Symbol, ValType>;
  callGraph:   Map<ts.Symbol, ts.Symbol[]>; // callee -> callers
}

export function runTypeFlowAnalysis(
  program: ts.Program,
  checker: ts.TypeChecker,
): ProgramTypeMap;
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
