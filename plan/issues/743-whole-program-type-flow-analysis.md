---
id: 743
title: "Whole-program type flow analysis"
status: in-progress
assignee: ttraenkler/opus-impl-4
created: 2026-03-22
updated: 2026-08-07
priority: critical
horizon: xl
feasibility: hard
model: fable
fable_role: spec
reasoning_effort: max
goal: performance
sprint: current
required_by: [744, 904, 905]
related: [4157, 773, 745, 2773, 1046, 1124, 1131]
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
loc-budget-allow:
  # +19 (1483 → 1502, crossing the 1500 god-file threshold by 2): the
  # `new F(…)` call-graph edge in `buildCallGraph` — 8 lines of code and a
  # compressed rationale comment. The site collector is the ONE place
  # call-graph edges exist, so the widening cannot live in a satellite
  # module; the full rationale and the transitive-proof tests were placed in
  # tests/issue-743-ctor-sites-in-fixpoint.test.ts instead of comment bulk.
  # Plus +31 (1502 → 1533) for the `.d.ts` entrypoint-seed slice: the seed
  # APPLICATION (`applyDtsEntrypointSeeds`) must run inside the seeding loop
  # of `buildIrUnitTypeMap` — the one place fixpoint seeds are formed. All
  # collection/discovery logic lives in the new
  # src/checker/dts-entrypoint-seeds.ts.
  # Plus +26 (1533 → 1559) for the graph-completeness slice: the exported
  # `_propagationCore` block (named re-exports of the lattice rules + a
  # rationale comment) so the method-edge satellite
  # (src/ir/fnctor-method-edges.ts) shares the EXACT join/inferExpr semantics
  # instead of forking them. All new analysis logic lives in the satellite.
  # Plus +9 (1559 → 1568) for the field↔param mutual-fixpoint slice: ONE rule in
  # `inferExpr` resolving `this` from the reserved scope key `"<this>"`, plus the
  # comment explaining why that key (and not `"this"`, which a TS this-parameter
  # would bind) is provably inert for the main fixpoint. `inferExpr` is the one
  # place an expression's lattice value is decided, so a satellite cannot host
  # it; everything else lives in the satellite's four modules.
  # Plus +34 (1568 → 1602) for the satellite i32/bitwise producer slice: the
  # `InferExtension` hook. Two lines of it are the hook consult; the rest is one
  # optional `ext` parameter threaded through `inferExpr`, its three atom
  # helpers and `walkBodyForReturns` (11 recursion sites — a site that DROPS it
  # answers the pre-extension type silently, so the threading is exhaustive by
  # construction rather than by review), plus the doc comment that states the
  # flag-off byte-identity argument. The rule ITSELF is a new satellite module,
  # src/ir/fnctor-i32-producers.ts; nothing about the rule lives here.
  - src/ir/propagate.ts
  # +6: a three-line comment and one call in `deriveFnctorFields`, which is the
  # single place a fnctor field slot is chosen and therefore the only place this
  # narrowing can be applied. All of the decision logic — the flag, the
  # parameter-resolution checks, the call-site query and the f64-only
  # restriction — lives in the new `fnctor-ctor-param-types.ts`.
  - src/codegen/fnctor-escape-gate.ts
  # +5 (9565 → 9570): threading `ctx.dtsEntrypointSeeds` as the 4th argument of
  # the single `buildIrOverlayIdentityMaps` call (formatter wrapped the call).
  # No logic added to the god-file.
  - src/codegen/index.ts
  # +22 (1736 → 1758): flag-gated `.d.ts` resolution + seed collection in
  # `compileSourceSync` — the one place the single-source Program is built, so
  # the extra-root text and the shared seed map must be produced here. The
  # actual logic lives in src/checker/dts-entrypoint-seeds.ts; this is plumbing
  # plus doc comments.
  - src/compiler.ts
  # +7 (3423 → 3430): one optional field each on CodegenOptions and
  # CodegenContext (`dtsEntrypointSeeds`) with their doc comments.
  - src/codegen/context/types.ts
func-budget-allow:
  # `deriveFnctorFields` 300 -> 301, crossing the threshold by one line for the
  # call described above. Splitting it is a real refactor (#3399) and doing it
  # underneath a flag-gated inference change would make both harder to review;
  # the function is not growing in complexity, only in one delegation.
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
  # ~295 → ~307: the `.d.ts`-seed plumbing (resolve → analyze option → collect →
  # codegen option) lives on the single-source compile path this function IS.
  # Decomposing the compile entry is #3399-class work, not something to smuggle
  # under a flag-gated inference change.
  - src/compiler.ts::compileSourceSync
  # 549 → 554: the ONE `buildIrOverlayIdentityMaps` call gains the seed-map
  # argument and the formatter wraps it to one-arg-per-line. No new logic.
  - src/codegen/index.ts::planIrOverlay
  # 409 → 410: one optional-field spread wiring `dtsEntrypointSeeds` onto ctx.
  - src/codegen/context/create-context.ts::createCodegenContext
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

## 2026-08-06 — fixpoint measured on acorn: ZERO slots beyond single-hop; the bucket needs entrypoint seeds, not more propagation

With all three `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` consumers enabled (legacy
scan #4117, field slots, IR fixpoint `new`-edges #4131), the acorn census is
`typed 54 / discarded 1 / unknown 41` — the unknown bucket did not move by a
single slot relative to single-hop (+181 B binary). Canaries 2,3,4,5, zero
imports, the usual 3 IR-FALLBACKs.

**Root cause, confirmed from two directions.** The #4155 Phase 2 census
independently established that first-hop receivers are erased to externref
before any read compiles; the census here shows the same starvation at the
seed level: acorn's `new Parser(options, input, startPos)` arguments trace to
the parameters of EXPORTED entry points (`parse`, `parseExpressionAt`,
`tokenizer`) that are only called from OUTSIDE the module. An internal-only
fixpoint has no call sites for them, so every chain bottoms out at `dynamic`
regardless of how many hops propagation can cross. Transitivity was never the
missing piece on this corpus — SEEDS are.

**The lever this exposes: seed exported-function parameters from the shipped
`.d.ts` (#4074).** acorn's own type declarations say `parse(input: string,
options: Options)`. A declared-signature seed for exported entrypoints is
exactly the information the fixpoint is starving for, and it composes with
the propagation machinery this issue already landed (the seeds flow through
`mk → new Parser` chains that #4131's edges now carry). This is also the
first #743 sub-lever with a plausible claim on the 41-slot bucket, since both
internal-only approaches are now measured at 2 slots.

Consequence for the flag: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` stays OFF — two
measured nulls (single-hop, fixpoint) and no consumer until entrypoint
seeding exists.

### Implementation sketch — `.d.ts` entrypoint seeding (the next #743 slice)

Mechanism, staying inside the existing architecture:

1. **Load the shipped declarations.** When compiling a `.js`/`.mjs` entry whose
   package carries a sibling `.d.ts` (acorn: `dist/acorn.d.ts`), add it to the
   Program (the language service already accepts extra roots). Zero effect on
   files without declarations.
2. **Match exported symbols.** For each EXPORTED function in the compiled
   module with an implicit-`any` parameter, look up the same-named export in
   the `.d.ts` and take its declared parameter types (`parse(input: string,
   options: Options)`); interfaces resolve through the existing checker.
3. **Seed, do not force.** Feed the declared types into `seedFromDeclaration`
   in `src/ir/propagate.ts` as SEEDS for exported functions' params (today
   they seed `dynamic` for lack of call sites). The fixpoint — including the
   #4131 `new`-edges — propagates them inward; a conflicting internal call
   site still widens per the lattice. Legacy lane: the same seed consulted by
   `inferParamTypeFromCallSites` where `sawCallSite === false` (the
   exported-entrypoint case it explicitly distinguishes, #3471), keeping
   IR/legacy parity.
4. **Trust boundary, stated honestly:** a `.d.ts` is a CLAIM, not a proof —
   external callers may violate it. Seeded params therefore need the same
   guarded-entry treatment as any externref→typed boundary (guard at the
   export wrapper, not blind trust in the body). That is the main design
   cost and the reason this is its own slice, not an evening patch.

Expected effect (to be measured, not assumed): `input: string` alone types
`this.input` (`String(input)` already native) plus every position derived
from it; `options: Options` collides with the #2937 hash-consumer routing for
`getOptions` and may be unseedable — check before promising the bucket moves.

## 2026-08-06 — `.d.ts` entrypoint seeding IMPLEMENTED (flag `JS2WASM_DTS_ENTRYPOINT_SEEDS`, default OFF): mechanism lands, acorn census does NOT move

Implemented per the sketch above (branch `claude/issue-743-dts-entrypoint-seeds`):

1. **Load**: `resolveDtsEntryDeclarations` (src/checker/dts-entrypoint-seeds.ts) —
   explicit `CompileOptions.entryDeclarations` text or the on-disk sibling
   (`x.mjs` → `x.d.mts`/`x.d.ts`) of a `.js`/`.mjs`/`.cjs` entry; the text is
   added to the single-source Program as an extra root
   (`__entry_declarations__.d.ts`) whose own diagnostics are filtered.
2. **Match**: `collectDtsEntrypointSeeds` — `export function` declarations in
   the `.d.ts` matched against the entry's exported top-level function
   declarations (export modifier or `export { local as pub }` specifiers),
   keyed by LOCAL name; per-param atoms `f64` (`number`) / `string` (`string`),
   `null` for everything else (interfaces, optionals, rest).
3. **Seed, both lanes, ONE map**: IR fixpoint — `applyDtsEntrypointSeeds` in
   `buildIrUnitTypeMap` replaces only `unknown` seed positions; call-site
   evidence still joins on top (conflict ⇒ widen; proven by test). Legacy —
   `inferImplicitAnyParamType` consults the seed strictly in the
   `sawCallSite === false` arm (#3471), ahead of the body-usage heuristic;
   plus a **one-hop arg-forwarding** in `inferParamTypeFromCallSites`'s
   any-identifier arm (a seeded entrypoint's own param passed directly to
   `f(…)`/`new F(…)` types as the seed, only while the entrypoint has zero
   internal call sites). **Recorded deviation/extension**: the sketch named
   only the `sawCallSite === false` consult; without the one-hop forwarding
   the IR fixpoint types a downstream fnctor param that the single-hop legacy
   scan cannot, and the claim demotes through the "function typeIdx parity
   mismatch" fallback — the exact hazard the sketch warns about. The
   forwarding mirrors precisely the fixpoint's first hop, under the same
   no-internal-evidence condition.
4. **Trust boundary (narrowed scope, as pre-authorized)**: seeds are limited to
   `string`/`number`, the two types whose export boundary already guards:
   f64 params sit behind the Wasm JS API's ToNumber (a violating `{}` crosses
   as NaN, never as a reinterpreted reference — pinned by test); native-string
   ref params REJECT a violating external call with TypeError at the boundary
   (pinned). In externref-string lanes the string seed is a deliberate ABI
   no-op. `boolean` was considered and excluded: ToInt32 at an i32 boundary
   ("abc" → 0) diverges from JS truthiness, so a violating call would change
   observable behavior rather than merely coerce.

### Measurements (2026-08-06, standalone dogfood, `-O3`)

Baseline (flag off, `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1
JS2WASM_FNCTOR_FIELD_PROVENANCE=1`): census **54 / 1 / 41**, canaries
2,3,4,5, imports `[]`, exactly the 3 pre-existing parity IR-FALLBACKs
(parse/parseExpressionAt/tokenizer), 866,808 B.

Flag on (same env + `JS2WASM_DTS_ENTRYPOINT_SEEDS=1`, `dist/acorn.d.mts`
supplied): census **54 / 1 / 41 — unchanged**, canaries 2,3,4,5, imports `[]`,
same 3 IR-FALLBACKs, 867,144 B (+336 B).

Per-param seeding on acorn's entrypoints (all four seedable exports):

| export              | param     | declared | seed   | effect on acorn                                                             |
| ------------------- | --------- | -------- | ------ | --------------------------------------------------------------------------- |
| `parse`             | `input`   | string   | string | joins with the 4 in-module canary call sites (already string) — no new fact |
| `parse`             | `options` | Options  | null   | unseedable (interface), as pre-registered                                   |
| `parseExpressionAt` | `input`   | string   | string | same as `parse.input`                                                       |
| `parseExpressionAt` | `pos`     | number   | f64    | joins with the canary literal `3` — no new fact                             |
| `parseExpressionAt` | `options` | Options  | null   | unseedable                                                                  |
| `tokenizer`         | `input`   | string   | string | same as `parse.input`                                                       |
| `tokenizer`         | `options` | Options  | null   | unseedable                                                                  |
| `getLineInfo`       | `input`   | string   | string | has internal call sites (`raise` path) — evidence governs, seed inert       |
| `getLineInfo`       | `offset`  | number   | f64    | same                                                                        |

**Why the census did not move (root cause, honest):** the chain from every
seeded entrypoint into `Parser`'s constructor breaks at a **property call**
(`parse` → `Parser.parse(input, options)`) followed by **`new this(options,
input)`** — neither is an identifier call/new, so neither lane's call graph
carries the seed across. `var Parser = function Parser(...)` is additionally a
function *expression*, outside the propagation population. On this corpus the
canaries also already provide string/f64 evidence for the entrypoints'
seedable params, so the seeds add no new facts at all. The `.d.ts` seed lever
is real (proven end-to-end on the fixture: declared `number` → fixpoint →
`new`-edge → fnctor field slot emits `f64`, both lanes in parity, zero parity
demotions) but the acorn bucket needs the NEXT lever: **static-method /
property-call edges** (`Parser.parse`, `new this`) in the call graph. The
+336 B flag-on delta comes from lattice changes on positions with no
conclusive internal evidence (`unknown` → seeded atom) shifting IR selection
slightly; canaries and IR-FALLBACK count are unchanged.

**Flag verdict: stays OFF** — measured null on the target corpus; no consumer
until property-call edges exist.

### Known pre-existing issues encountered (NOT introduced here; reproduced on untouched origin/main)

- `function addOne(n) { return n + 1; } export function top(k: number): number
  { return addOne(k); }` (pkg.ts, standalone) **hard-fails** under default
  IR-first: selection claims `addOne` off the lattice f64 fact, but from-ast's
  `+` provability does not consume lattice param facts →
  "'+' operands not provably both-number or both-string" after the legacy body
  was skipped. Flag-on seeding can steer additional functions into this
  pre-existing trap (same trigger as call-site narrowing) — one more reason
  the flag stays OFF until the from-ast gap is fixed.
  **RESOLVED by #4177 (2026-08-06):** `proveAdditiveOperand` now consumes the
  fixpoint's own facts (`src/ir/lattice-param-facts.ts` — never-written param
  atoms + certified direct-call return atoms), so the fixture compiles and the
  seeding flags no longer steer functions into this trap (verified: both #743
  suites green with `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1
  JS2WASM_DTS_ENTRYPOINT_SEEDS=1`). This blocker is off the flag-OFF list; the
  remaining flag rationale is the measured-null verdict above.
- `tests/issue-3486-fnctor-constructor-identity.test.ts` ("own fields and
  enumeration are untouched…") fails on untouched origin/main (ownKeys returns
  `''`), unrelated to this change.

**Deferred**: the `benchmark:acorn:standalone-dynamic` perf A/B — the lane is
owned by a concurrently-running measurement (binding-retype); run it after
that lane frees. Multi-file (`compileMulti`/project) and linear-backend seed
plumbing are out of scope for this slice (single-source path only — the
dogfood/measurement lane).

## 2026-08-06 — call-graph COMPLETENESS slice (method-call + `new this` edges) IMPLEMENTED: the chain closes, census moves 41 → 40, and the remaining 40 are now precisely characterized

Branch `claude/issue-743-graph-edges`. This is the slice both measured nulls
above named: prototype/static-method call edges and `new this(…)` edges, plus
the population widening for function-EXPRESSION constructors
(`var Parser = function Parser(…)`).

### Architecture — WHY a satellite fixpoint, not a wider `buildIrUnitTypeMap`

`src/ir/fnctor-method-edges.ts` runs a SECOND, self-contained fixpoint over a
wider population (top-level fn decls + top-level `var F = function(){}` ctors +
write-once static/prototype methods, incl. the `var pp = F.prototype` alias
form), reusing the exact lattice core exported from propagate.ts
(`_propagationCore`). The main `IrUnitTypeMap` is untouched — proven by the
gates below — because its entries feed IR selection and the legacy-parity
seams: widening its population or edges would shift IR claims/ABIs, the exact
#1712-class typeIdx-demotion hazard. The satellite's facts feed exactly ONE
consumer — the f64-only fnctor field-slot narrowing in
`src/codegen/fnctor-ctor-param-types.ts` (fallback when the #4117 single-hop
scan is inconclusive), under the SAME `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` flag.
Parity is by construction: both backends read field shapes through the shared
`deriveFnctorFields`, and no compiled SIGNATURE consumes the satellite facts
(deliberately — the ctor-ABI half stays externref exactly as #4117 shipped it;
the field store unboxes). The oracle-ratchet stays clean because the checker
access lives in src/ir; the codegen consumer passes `ctx` as a structural
`{ checker }` host.

### Soundness (widening beats guessing — the rules that made the edges honest)

- Method edges are NAME-BASED over-approximations: any `recv.m(…)` site feeds
  every write-once method named `m` unless the receiver is provably the
  constructor object (then only that ctor's static slot). A site that
  dispatches elsewhere only widens; a site that reaches the method but is
  unmatched is structurally impossible for named calls.
- Value escapes poison: a ctor/fn referenced outside callee/property-base/
  export positions gets all-DYNAMIC params (aliases like `var C2 = F` would
  construct it unseen). ONE boundary-only shape is admitted — acorn's API
  mirror `Parser.acorn = { Parser: Parser, … }`, where the holding property is
  used nowhere else in the module (same trust class as `export { Parser }`).
- A method name READ in value position anywhere publishes no method nodes;
  dynamic-key access on a TRACKED base (`pp[k]`, `F[k]`, `this[k]`) drops the
  owner (or everything for `this[k]`); Symbol-keyed access is exempt
  (`pp[Symbol.iterator] = …` cannot collide with string-keyed slots).
  Dynamic-key calls on UNTRACKED bases (acorn's `plugins[i](cls)`) are the one
  DOCUMENTED gap, shared with dynamic instance reads — family-consistent (the
  legacy #4117 scan has no escape analysis at all), bounded by the f64-only
  consumer (a violating value coerces at the store, never reinterprets).
- `new this(…)` is an edge only inside a write-once STATIC method (`this` is
  the ctor); in prototype methods `this` is an instance (skip); in a plain
  function `this` is rebindable → ALL ctor facts drop.

### Measurements (acorn-standalone-compile, `-O3`, `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`)

- Census: **55 typed / 1 discarded / 40 unknown** (baseline 54/1/41). The slot
  that moved is `Parser.pos`: canary literal `3` → `parseExpressionAt.pos`
  (fn-decl edge) → static `Parser.parseExpressionAt.pos` (METHOD edge) →
  `new this(options, input, pos)` (NEW-THIS edge) → ctor `startPos` →
  `this.pos = startPos` → f64 slot. The two-hop-through-a-method chain the
  previous nulls could not cross now carries end-to-end (also pinned by
  tests/issue-743-method-edges-in-fixpoint.test.ts).
- Canaries 2,3,4,5; imports `[]`; exactly the 3 pre-existing parity
  IR-FALLBACKs (parse/parseExpressionAt/tokenizer) — no growth.
- Binary: 874,228 B flag-on, unchanged from the pre-slice flag-on run (the
  single slot flip is size-neutral after Binaryen). Flag-off byte-identity vs
  origin/main asserted by hash (sha256 `326b2873…`, 861,712 B on a 1-canary
  fixture, this branch's files vs origin/main's files — identical).
- Compile time: 67.8 s vs 73.2 s baseline on the same box — the satellite
  (270 method nodes, 1,472 edges on acorn) is invisible in compile noise.
- Graph diagnostics (inert, `JS2WASM_LOG_FNCTOR_GRAPH=1`): callables=56
  (poisoned: only the two predicates used through a conditional-expression
  callee), methods=270, edges=1472, no space poisons.

### The honest number is 40, not <20 — WHY, per slot (the #4157 target needs three MORE levers)

Full per-slot table measured via `fnctorFieldProvenanceRecords()`:

1. **`this`-field-read arguments (~14 slots, the dominant bucket)**:
   `Parser.start/end/lastTokStart/lastTokEnd` (`this.start = this.end =
   this.pos`), `Node.start` (`startNodeAt(this.start, …)` → `new Node(this,
   pos, loc)`), `SourceLocation.start/end` + `Parser.startLoc/endLoc/
   lastTok*Loc` (Position instances from `this.curPosition()`),
   `Token.type/value/start/end` (`new Token(this)` then `p.start` reads),
   `BranchID.parent` (`this.branchID` forward). The args are field READS of a
   receiver, which `inferExpr` types DYNAMIC — narrowing them needs a
   this-scope fed by the very field facts being derived: a MUTUAL fixpoint
   between field types and param facts. That is the next slice, and several of
   these are Position/SourceLocation REFS that also need ref-typed (not
   f64-only) consumption.
2. **Bitwise-numeric blocked by the shared lattice (1-2 slots)**:
   `Scope.flags` — every producer is `a | b` / `functionFlags(…)`, and the
   lattice types bitwise ops DYNAMIC while `JS2WASM_IR_I32_DOMAIN` (Stage 3
   emitter pending, #1126) is off. JS bitwise is ALWAYS numeric, so a
   satellite-local producer rule would be sound — deliberately NOT forked in
   this slice to keep one lattice; recorded as the cheap follow-up.
3. **Non-f64 atoms the consumer excludes (~5 slots)**: the graph already
   PROVES `TokenType.label: string`, `TokContext.token: string` (facts
   `TokenType(string, dynamic)`, `TokContext(string, bool, bool, dynamic,
   bool)`) — consuming them is the native-string-ABI question the `.d.ts`
   slice documented, not a graph question. `TokenType.keyword`,
   `TokContext.override` similar.
4. **Genuinely dynamic (~19 slots)**: RegExp-object fields
   (`keywords/reservedWords*`), `value = null` seeds, arrays (`context`),
   config-object reads (`binop = conf.binop || null`), `regexpState = null`,
   `RegExpValidationState.parser/unicodeProperties/groupNames`. Honest boxes.

**Flag verdict: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` stays OFF.** The graph
completeness this issue's measured nulls asked for now exists and carries
facts end-to-end, but one recovered slot is not a consumer. The bucket's next
levers are (1) the field↔param mutual fixpoint, (2) ref/string-typed slot
consumption, (3) the bitwise producer rule — in that order of expected yield.

Known pre-existing issue encountered (NOT introduced here, reproduced
flag-off): the minimal `P.parse("code", 42)` static-method fixture returns
null at runtime in standalone through the dynamic static-dispatch path — the
E2E test therefore pins flag-on ≡ flag-off behavior plus the f64 slot, not an
absolute value.

## Implementation Plan — field↔param mutual fixpoint (Fable spec, 2026-08-07)

Spec for the next slice: solve fnctor FIELD SLOTS and ctor/method PARAM facts
in ONE fixpoint inside the satellite (`src/ir/fnctor-method-edges.ts`), so the
~14-slot "`this`-field-read arguments" bucket (dominant remainder of the 40)
can converge. Design is complete; no module code was written. Everything below
was verified against `origin/main` at `fb4a76d83` (post-#4166, post-#4177) —
line anchors are from that revision.

### 0. Scope and constraints (all carried from the family, all load-bearing)

- SATELLITE ONLY. The main `IrUnitTypeMap` stays byte-identical (#1712 parity
  hazard). One consumer: `src/codegen/fnctor-ctor-param-types.ts`, f64-only
  (i32/u32 lower to f64), flag `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` (default OFF).
- Field-slot facts must agree with what `deriveFnctorFields`
  (`src/codegen/fnctor-escape-gate.ts:1533`) will emit: a field written
  non-numerically ANYWHERE (methods included) must widen.
- Flag-off byte-identity vs origin/main asserted by sha256 on the acorn
  dogfood binary.
- Census baseline after #4166: **55 typed / 1 discarded / 40 unknown**;
  canaries 2,3,4,5; imports `[]`; exactly 3 pre-existing IR-FALLBACKs.

### 1. The cycle, restated precisely

Today the satellite fixpoint solves only PARAM (+ return) lattice variables;
field types are derived AFTERWARD by `deriveFnctorFields` in one direction
(param fact → slot). The blocked chains all pass through a field READ:

```
Parser ctor: this.pos = startPos            (param → field, has no variable today)
Parser ctor: this.start = this.end = this.pos   (field → field, unresolvable)
pp.startNodeAt = function(pos, loc) { return new Node(this, pos, loc) }
   caller: this.startNodeAt(this.start, this.startLoc)   (field → param arg)
Node ctor: this.start = pos                 (param → field)
Token ctor (function Token(p)): this.start = p.start     (param-receiver field read)
   site: new Token(this) in a Parser proto method
```

Fix: add per-owner FIELD SLOT lattice variables to the satellite fixpoint and
iterate params and fields together to convergence. Widen-only, same
`_propagationCore` (`src/ir/propagate.ts:1528`), same write-once / escape /
dynamic-key discipline the satellite already has.

### 2. Data model (all in `src/ir/fnctor-method-edges.ts`)

Extend `AnalysisState` (:121) and the fixpoint state:

- `fieldWrites: FieldWrite[]` where

  ```ts
  interface FieldWrite {
    owner: IrUnitId | "all";      // "all" = name-based over-approximation
    name: string;
    kind: "assign" | "numeric-op" | "plus-assign" | "logical-assign" | "poison";
    carrier?: ts.Expression;      // chain-unwrapped RHS (kind assign/plus/logical)
    scopeChain: readonly ts.SignatureDeclaration[]; // as Edge.scopeChain
    thisOwner?: IrUnitId;         // owner whose instance `this` is bound to, if tracked
    readSnapshot?: ReadonlySet<string>; // definite-before set for this-read resolution
    definite: boolean;            // participates in definiteCtorFields
  }
  ```

- `definiteCtorFields: Map<IrUnitId, Set<string>>` — names definitely
  assigned by the END of the ctor (see §4).
- `fieldDynamicNames: Set<string>` (name poisoned for ALL owners) and
  `fieldDynamicPerOwner: Map<IrUnitId, Set<string>>`; a global
  `poisonAllFields: boolean`.
- Fixpoint side: `fieldFacts: Map<IrUnitId, Map<string, LatticeType>>`,
  recomputed from scratch each iteration exactly like params are (see §6 —
  this recompute-from-scratch is load-bearing for correctness).
- Post-fixpoint outputs (memo per SourceFile — replace the current
  `memo` value (:149) with a struct holding BOTH maps):
  - the existing name-keyed ctor param facts;
  - `thisReadFacts: Map<ts.Node, LatticeType>` — for every ctor field write
    whose chain-unwrapped carrier is a `this.<y>` read, the FINAL resolved
    lattice value, keyed by the carrier `PropertyAccessExpression` NODE.
    Node-keyed lookup is what the consumer uses — it avoids re-deriving
    definiteness/ordering in codegen and cannot drift from the satellite.

### 3. Edge (a) — writes into field slots (the write scan)

Collect in `scanFile` (:536) or a sibling walk. For every write-ish operation
on a property, classify the RECEIVER first:

1. `this.<name> = rhs` (incl. literal-key `this["name"] = rhs`): find the
   this-binder via `enclosingThisBinder` (:697; arrows are transparent).
   - binder is a tracked ctor (callable node's `fn`) → `owner = thatId`. If
     the write is a DIRECT statement of the ctor body (no intervening
     function-like of any kind, arrows included), it participates in the
     ordered/definite walk of §4; a write nested in an arrow/callback inside
     the ctor is attributed to the owner but is NOT definite and gets
     `readSnapshot = ∅` (an arrow may run at any time or never).
   - binder is a MATERIALIZED proto-method node of owner F → `owner = F`,
     non-definite, `readSnapshot = definiteCtorFields(F)`.
   - binder is a materialized STATIC method → attribute NOWHERE (its `this`
     is the ctor OBJECT; instance fields untouched). Note in passing: this
     also means `this.m = fn` in a static method installs a static method the
     METHOD-space scan does not see — pre-existing gap, do not fix here.
   - anything else (demoted methods, plain functions, class members,
     object-literal methods, top-level) → `owner = "all"` (name-based
     over-approximation, the same trust move as the name-based method edges):
     the RHS eval still runs with the binder's scope chain, so
     `pp.finishNodeAt`-style writes (`node.end = pos`) contribute their real
     (often f64) types instead of poisoning. This is what keeps `Parser.end`
     alive — do NOT replace it with a name-poison.
2. `<expr>.<name> = rhs` where `<expr>` is NOT `this` and `spaceOfBase` (:367)
   does NOT claim it (i.e. not a method-space install): `owner = "all"`, same
   rationale as above. (If `spaceOfBase` claims it, it is a method install —
   already handled; a `F.prototype.x = 5` DATA property cannot intercept
   own-field writes and reads are blocked by definiteness, so no field action.)
3. Compound assignments (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `<<=`, `>>=`,
   `>>>=`, `&=`, `|=`, `^=`) and `++`/`--` on any of the receivers above:
   - all-numeric operators and `++`/`--` → contribute `F64` (`kind:
     "numeric-op"`); JS guarantees a number result regardless of the old
     value. acorn writes `this.pos += n` constantly — omitting this rule
     makes `pos` facts silently wrong, not just imprecise.
   - `+=` → `kind: "plus-assign"`: contribution is `plus(fieldFactCurrent,
     evalRhs)` with the local rule: either side string → STRING; both
     f64-compatible (`f64`/`i32`/`u32`/`unknown`) → F64; any dynamic →
     DYNAMIC. (`undefined + 1` is NaN — still a number; `undefined + "s"` is
     a string — both covered.)
   - `&&=`/`||=`/`??=` → contribute `evalRhs` only (the old value is already
     in the fact).
4. Poisons (field-level, mirroring the method-space discipline):
   - `delete this.<name>` in tracked ctor/proto-method → name → DYNAMIC for
     owner AND remove from definite; `delete <untracked>.<name>` → DYNAMIC
     for ALL owners (also non-definite everywhere).
   - dynamic-key WRITE-ish (`this[k] = v`, `this[k] += v`, `this[k]++`,
     `delete this[k]`, non-Symbol `k` — reuse `isSymbolKeyed` :184): binder
     tracked → ALL fields of that owner DYNAMIC + definite cleared; binder
     untracked → `poisonAllFields = true`. Dynamic-key writes on UNTRACKED
     non-`this` bases remain the family's DOCUMENTED GAP (same class as
     #4166's dynamic instance reads; the legacy #4117 scan has no escape
     analysis at all; f64-only consumption bounds damage to ToNumber-class
     coercion at a store).
   - `Object.defineProperty(this, 'x', …)` / `Object.assign(this, …)` in a
     tracked fn → field `x` (or ALL fields for assign / non-literal key)
     DYNAMIC + non-definite for the owner. On untracked bases → documented
     gap (same class as above). Extend `handleObjectDefine` (:450).
   - Destructuring assignment targets containing any property access
     (`({a: this.x} = o)`, `[obj.y] = a`) → DYNAMIC that name (owner if
     this-based-and-tracked, else all owners). Over-poisoning here is fine.
   - `for (this.x in o)` / `for (obj.x of a)` targets → same treatment.
   - Owners with `protoPoisoned` or any `runtimeDefinedProtoKeys` entry: a
     replaced/unknown prototype (or a literal-keyed accessor install) can
     carry ACCESSORS that intercept `this.x =` writes and `this.x` reads —
     for `protoPoisoned` set ALL that owner's fields DYNAMIC + definite
     cleared; for `runtimeDefinedProtoKeys` do it per key.
   - A value-ESCAPED (poisoned) callable → all its field facts DYNAMIC (its
     params are already all-DYNAMIC; field facts must follow or literals like
     `this.type = ""` would survive an owner we no longer understand).

### 4. Definiteness and ordering (the undefined-read guard)

A `this.<y>` read is resolvable ONLY if `y` is provably assigned before the
read can execute — otherwise the read yields `undefined`, and an f64 fact
would turn `undefined` into NaN at a coercing store (observable divergence;
this is exactly why the #3683 numeric promotion at
`fnctor-escape-gate.ts:1778` excludes presence-tracked fields).

- Per owner, walk the CTOR body top-level statements in order, mirroring (in
  simplified form) `guaranteedAssignmentsInClosedStatement` /
  `containsConstructorReturn` (`fnctor-escape-gate.ts:1623/:1647`):
  - plain `ExpressionStatement` assignment chains → definite writes; each
    write records `readSnapshot` = the running definite set BEFORE its
    statement (chain members share the statement's snapshot);
  - `Block` → recurse with the running set;
  - `if/else` with BOTH arms → each arm walks with the inherited prefix
    (branch-local writes accumulate within the arm for that arm's snapshots);
    after the statement, definite += intersection of the two arms — this is
    the rule that keeps acorn's `pos`/`lineStart`/`curLine` definite;
  - any other statement (loops, if-without-else, try, switch): recurse
    generically; writes inside are non-definite and use the frozen
    prefix as `readSnapshot`;
  - a statement containing a `return` STOPS definite accumulation for
    `definiteCtorFields` (mid-ctor return completes construction without the
    later writes) — but later writes' own `readSnapshot`s keep growing along
    the straight-line path (reaching write W implies the prior statements
    ran).
- Read resolution rule (`readFieldFact(owner, name, snapshot)`):
  DYNAMIC if `poisonAllFields` / owner field-poisoned / `name ∈
  fieldDynamicNames(∪ per-owner)` / `name ∉ writtenNames(owner)` / `name ∉
  snapshot`; otherwise the CURRENT fact — including `unknown`. Returning raw
  `unknown` (not DYNAMIC) for a written-but-not-yet-resolved field is what
  lets cycles close instead of pessimizing on iteration order (§6).

### 5. Edge (b) — field reads feeding params, in three forms

1. **Direct `this.<x>` arguments and write carriers.** Introduce ONE wrapper
   used for every edge-arg eval and every field-write RHS eval:

   ```ts
   evalValueExpr(expr, scope, thisCtx /* {owner, snapshot} | undefined */):
     e = unwrap parens/as/nonnull            // reuse unwrap (:171)
     while (e is `lhs = rhs` assignment) e = rhs   // chain carrier, mirrors
                                                   // escape-gate :1561
     if (e is PropertyAccess on ThisKeyword && thisCtx)
       return readFieldFact(thisCtx.owner, e.name.text, thisCtx.snapshot)
     return core.inferExpr(e, scope, entries, resolver)
   ```

   `Edge` (:108) gains `thisOwner?: IrUnitId`, set at edge creation
   (`buildEdges` :705) from `enclosingThisBinder(site)`: ONLY when the binder
   is a materialized PROTO-method of owner F (snapshot =
   `definiteCtorFields(F)`). Static methods bind `this` to the ctor object
   (skip); ctor-internal call sites are skipped in this slice (conservative —
   acorn's relevant sites are all in methods).

2. **Bare `this` arguments (`new Token(this)`) and NESTED reads
   (`this.pos - this.lineStart`).** These pass through `core.inferExpr`
   recursion, which cannot see field facts. Add ONE inert rule to
   `inferExpr` in `src/ir/propagate.ts` (before the final `return DYNAMIC`,
   :894):

   ```ts
   if (expr.kind === ts.SyntaxKind.ThisKeyword) return scope.get("<this>") ?? DYNAMIC;
   ```

   and have the satellite bind scope key `"<this>"` to an OBJECT ATOM built
   per owner per iteration: fields where `name ∈ definiteCtorFields(owner)` ∧
   fact is a `LatticeAtom` (f64/i32/u32/bool/string/object within the depth
   cap `LATTICE_OBJECT_SHAPE_MAX_DEPTH`), name-sorted (atom invariant, see
   `inferObjectLiteralAtom` :934). Then:
   - `new Token(this)` → the arg infers to the owner's atom → Token's param
     fact IS the instance shape → `this.start = p.start` in Token's ctor
     resolves via the EXISTING `inferPropertyAccessAtom` (:952) — the
     param-receiver bucket (Token.start/end) needs NO new machinery;
   - `this.pos - this.lineStart` → property reads on the atom → F64 via the
     existing arithmetic rule (:774).

   WHY `"<this>"` and not `"this"`: TS `this`-parameters produce a real
   parameter whose `p.name.text === "this"`, and the MAIN fixpoint's scope
   builder inserts params by text — a `"this"` key would let the new rule
   fire in the main map and break flag-off byte-identity. `"<this>"` is not
   spellable as an identifier, so the rule is provably inert for the main
   fixpoint (verified against `seedParamType` :536 and the main `buildScope`).
   This is the ONLY touch to `propagate.ts` (+2 lines; extend the existing
   `loc-budget-allow` grant comment in this file's frontmatter).

3. **`readSnapshot` for write carriers**: ctor direct writes use their
   ordered snapshot (§4); proto-method writes use `definiteCtorFields`;
   `"all"`-attributed writes get NO thisCtx (their `this`, if any, is
   untracked → nested reads widen via the missing sentinel).

### 6. Fixpoint mechanics (extend `runFixpoint` :781)

- Keep the existing recompute-from-scratch-per-iteration structure and add a
  field pass per iteration: for each non-poisoned owner, `newFieldFact(name)
  = join over that name's writes` of the §3 contributions, evaluated with
  `buildScope(write.scopeChain)` (+ `"<this>"` atom when `thisOwner` is set)
  and `evalValueExpr`. Change detection covers params, returns, AND field
  facts.
- **Monotonicity caveat, and why recompute-from-scratch is load-bearing**:
  the atom-mediated reads are NOT monotone — a fact rising `unknown → f64`
  makes a field ENTER the atom, which can make a dependent fact DROP
  `dynamic → f64` on the next iteration. Because every fact is recomputed
  from seeds each iteration, stale pessimism heals; the loop must run until
  NOTHING changes. The direct-read path (§5.1) returns raw `unknown` for
  written-but-unresolved fields precisely so ctor-param↔field cycles start
  optimistic and converge upward instead of freezing at DYNAMIC.
- **Non-convergence = no output.** If `MAX_ITERS` (:817, 50) exhausts with
  changes still occurring, return EMPTY facts (params AND fields AND
  thisReadFacts). The current code silently uses possibly-unconverged
  entries; with non-monotone atom lag that would be unsound. Empty-on-bail is
  strictly safe and only reachable under adversarial shapes.
- Output name-uniqueness rule stays as-is (:259-266); `thisReadFacts` are
  recorded in a final post-convergence pass over ctor writes (poisoned or
  duplicate-named owners contribute nothing).

### 7. Call-forwarding soundness holes to close while touching edges

These pre-date this slice but directly gate the validity of field facts
(fields are seeded from params; params must see every construction path):

- `F.call(this, a, b)` / `F.apply(this, args)` with F a tracked callable:
  currently NO edge (callee is a property access named `call`; the
  static-slot lookup finds nothing; args are silently dropped). Add: direct
  `F.call(…)` callee → edge with `argExprs = args.slice(1)`; direct
  `F.apply(…)` → mark F all-params-DYNAMIC (args unknowable). This is the
  ES5 subclass pattern (`function Sub(){ Parser.call(this, …) }`) — without
  it a `.call` site with a string arg would be invisible to an f64 fact.
- `F.bind` anywhere, or `F.call`/`F.apply` NOT in direct-callee position
  (extracted): poison F (unseen construction/invocation alias).
- Property name `constructor` used as a callee (`new x.constructor(…)`,
  `x.constructor(…)`) or read in a non-comparison position: `poisonAllCtors`
  — `F.prototype.constructor === F` by default, so this reaches any ctor
  with unseen args. Comparison operands (`x.constructor === Foo`) are safe
  and MUST stay safe (common type-check idiom; blanket-poisoning it would
  nuke real corpora). Grep the acorn dist for `.constructor`, `.call(`,
  `.bind(` BEFORE finalizing these rules to confirm the cost on the target
  corpus is nil (believed nil for `constructor`/`bind`; `.call` sites exist
  but on untracked receivers).

### 8. Consumer extension (`src/codegen/fnctor-ctor-param-types.ts`)

In `inferFnctorFieldTypeFromCtorParam` (:71): after the flag (:77) and
externref (:79) gates, FIRST chain-unwrap `valueExpr` exactly like
`deriveFnctorFields`' carrier loop (`fnctor-escape-gate.ts:1561`), then:

- unwrapped expr is an Identifier → existing param path unchanged
  (:80-119);
- unwrapped expr is a `this.<y>` PropertyAccess → look up the satellite's
  node-keyed `thisReadFacts` (new export, e.g.
  `computeFnctorGraphCtorThisReadFacts(sourceFile, host)`) by NODE identity;
  fact kind `f64`/`i32`/`u32` → `{ kind: "f64" }`, else null. No name
  requirement for this path (node-keyed), but keep it AFTER the flag gate.
  The `host` stays the structural `{ checker }` slice — the raw checker use
  remains in `src/ir`, outside the oracle-ratchet gate.

This is the piece that makes `this.start = this.end = this.pos` type the
`start`/`end` SLOTS; the param path alone cannot see it. Note the existing
call site passes the un-unwrapped `valueExpr` — do the unwrap inside the
consumer, not at the call site (keeps `deriveFnctorFields`' +0 line budget).

### 9. Per-slot expectations for the ~14-slot bucket (measure, don't assume)

| Slot | Expected chain | Verdict expected |
| --- | --- | --- |
| `Parser.start/end/lastTokStart/lastTokEnd` | `pos` fact f64 (shipped #4166) → §8 this-read consumer + §3 method writes (`this.start = this.pos` in `next`/finish paths) | MOVE (if every write numeric — verify `+=`) |
| `Node.start` | `this.start` arg → `startNodeAt.pos` (method edge) → `new Node` edge → `pos` param → slot | MOVE |
| `Token.start/end` | `new Token(this)` → param atom → `p.start`/`p.end` reads | MOVE (atom path §5.2) |
| `Token.type/value` | `p.type` is a TokenType ref / `p.value` heterogeneous | STALL — non-f64 |
| `SourceLocation.start/end`, `Parser.startLoc/endLoc/lastTokStartLoc/lastTokEndLoc` | Position INSTANCES from `curPosition()` | STALL — ref-typed consumption is the next lever, out of scope |
| `BranchID.parent` | `this.branchID` forward, ref/undefined | STALL — non-f64 |

So the honest expectation is ~5-8 movers; the ≥10-slot wall-A/B trigger
probably does NOT fire. If it does move ≥10, run the standalone-dynamic wall
A/B (§11).

### 10. Tests (extend the `tests/issue-743-*` pattern; read
`tests/issue-743-method-edges-in-fixpoint.test.ts` first for the compile +
provenance-record assertion technique)

New `tests/issue-743-mutual-fixpoint.test.ts`:

1. Minimal two-fnctor cycle that CONVERGES, E2E slot assertion: ctor writes
   `this.pos = startPos; this.start = this.pos;`, a proto method calling
   `mk(this.start)` into a second fnctor — assert both fnctors' slots emit
   f64 flag-on and the runtime result is flag-off-identical.
2. `new T(this)` param-atom case (`this.s = p.start`) — Token pattern.
3. Conflict cycle WIDENS: add a method write `this.start = "s"` — slot must
   stay externref; and a string-written field feeding an arg must widen the
   downstream param.
4. Definiteness: read of a conditionally-assigned field must NOT narrow
   (undefined hazard); ordering: `this.a = this.b; this.b = 1;` — `a` must
   NOT narrow.
5. Poison coverage: `delete this.x`; `this[k] = v`;
   `Object.defineProperty(this, …)`; destructuring target; and the
   name-based cases — `obj.start = "s"` on an untracked base widens
   `Parser.start`, while `node.end = pos` (numeric param) does NOT poison.
6. `.call` forwarding: `F.call(this, "s")` widens; `F.apply` drops facts;
   extracted `F.bind` poisons.
7. Flag-off parity (byte-identity of a fixture compile, mirroring the
   existing suites' pattern).

Re-run: all `issue-743-*`, `issue-3520*`, `issue-4155*`, `issue-2660*`,
`equivalence`, `ir-*` suites. Gates by EXIT CODE: tsc, lint (biome), oracle-
ratchet, loc-budget (extend #743's grant for propagate.ts +2), func-budget,
dead-exports, coercion-sites, stack-balance, check:ir-fallbacks, prettier.

### 11. Measurement protocol

1. Baseline (flag-off) sha256 byte-identity vs origin/main on the acorn
   dogfood binary (same technique as #4166's `326b2873…` assertion).
2. Census: compile the acorn dist standalone `-O3` with
   `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`
   (see `tests/issue-4155-fnctor-field-provenance.test.ts` and the #4155
   issue file for the census harness; `fnctorFieldProvenanceRecords()` gives
   per-slot rows). Report the full per-slot movement table for the §9 bucket
   — which moved, which stalled, and the per-slot reason. Canaries must stay
   2,3,4,5, imports `[]`, exactly 3 IR-FALLBACKs.
3. Wall A/B ONLY if ≥10 slots move: `pnpm run
   benchmark:acorn:standalone-dynamic`, 3+ pairs, order-reversed per #3927
   §6 (the box is quiet but not trusted). Flag default changes only on clean
   evidence; otherwise `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` STAYS OFF and the
   Results section says so.

### 12. Traps (read before coding)

- **The local branch name `claude/issue-743-mutual-fixpoint` is held by a
  stale worktree** (`.claude/worktrees/agent-a4418ac275892567a`, parked at
  the already-merged graph-edges tip `d799f3785`). Work on a differently
  named local branch and push via refspec (`git push --no-verify origin
  HEAD:refs/heads/claude/issue-743-mutual-fixpoint`), or have the tech lead
  remove the stale worktree first.
- Do NOT put the ThisKeyword rule behind key `"this"` (§5.2) — main-map
  byte-identity breaks via TS this-params.
- Do NOT let atom-mediated reads stand in for direct reads (§5.1): the atom
  cannot represent `unknown` fields, and a DYNAMIC-on-unknown direct read
  freezes the very cycles this slice exists to close.
- Treat MAX_ITERS exhaustion as failure (empty output), not as "use what we
  have" — the atom lag makes intermediate states unsound to consume.
- Compound assignments and `++`/`--` are WRITES (acorn: `this.pos += …`).
  Missing them makes facts wrong, not just incomplete.
- The consumer must unwrap assignment CHAINS before classifying `valueExpr`
  (`this.start = this.end = this.pos` hands the consumer the inner
  assignment, not the read).
- `numericPropertyNames` (#3683, `fnctor-escape-gate.ts:1778`) already
  promotes some slots in standalone AFTER derivation — run the census with
  the exact same env as #4166's baseline so the 55/1/40 comparison is
  apples-to-apples.
- Never `git stash`; never pipe a command whose exit code you need; claim
  with `node scripts/claim-issue.mjs 743 <agent> --branch
  claude/issue-743-mutual-fixpoint` before starting (the 2026-08-07 spec
  claim has been released).

## 2026-08-07 — field↔param mutual fixpoint IMPLEMENTED: the mechanism lands and is proven E2E; the acorn census does NOT move, and the blocker is now measured per write

Branch `claude/issue-743-mutual-fixpoint`. Implements the Fable spec above as
written, with two deviations flagged below (one of them a spec error that would
have shipped an UNSOUND fact, one an over-poison that zeroed the corpus).

### What shipped

Field slots are now lattice VARIABLES solved together with params inside the
satellite. Both directions of the cycle carry end-to-end, pinned by
`tests/issue-743-mutual-fixpoint.test.ts` (24 tests):

- **edge (a)** — the full write taxonomy: plain assign, `+= -= *= /= %= **= <<=
  >>= >>>= &= |= ^=`, `++`/`--`, `&&= ||= ??=`, name-based `"all"` attribution
  for untracked receivers, and the poison set (`delete`, `this[k]`,
  `Object.defineProperty/assign` on `this`, destructuring and for-in/of targets,
  replaced/runtime-defined prototypes, escaped owners);
- **edge (b)** — direct `this.<x>` reads answered from the field facts (raw
  `unknown`, not DYNAMIC, so cycles start optimistic), and nested/bare-`this`
  reads answered from a per-owner instance ATOM bound to scope key `"<this>"`;
- the undefined-read guard: an ordered ctor walk with `if/else` intersection and
  return-freezing, so a read that could observe `undefined` never carries a
  numeric fact;
- MAX_ITERS exhaustion returns EMPTY facts, never a partial state (the
  atom-mediated reads are not monotone).

The satellite was split from one file into four (`fnctor-graph-model.ts`,
`fnctor-field-writes.ts`, `fnctor-field-lattice.ts`, `fnctor-method-edges.ts`)
rather than granting a god-file allowance: the single file reached 1,720 LOC,
+220 over the ratchet, and the next slice would have inherited it.

### Measurements (same env as #4166: acorn-standalone-compile, `-O3`, `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`)

- **Census: 55 typed / 1 discarded / 40 unknown — UNCHANGED from the #4166
  baseline. Zero slots moved.** Binary 874,370 B, byte-count unchanged. Canaries
  2,3,4,5; imports `[]`; exactly the 3 pre-existing parity IR-FALLBACKs
  (parse / parseExpressionAt / tokenizer).
- Flag-off byte-identity vs `origin/main` asserted by sha256 on the standalone
  acorn binary: `11aa8e230bca82234672bc5b1ea7f44817ffec0d1e44a67acfe70884b84ba89d`,
  861,854 B — identical this-branch vs origin/main, before AND after the module
  split.
- Wall A/B **not run**: the spec pre-registered it at ≥10 movers; 0 moved.
- Compile time 73.8 s — the field lattice is invisible in compile noise.

### Per-slot verdict for the §9 bucket — every one traces to ONE root cause

| Slot | Spec expectation | Measured | Why |
| --- | --- | --- | --- |
| `Parser.start/end/lastTokStart/lastTokEnd` | MOVE (if every write numeric — "verify `+=`") | **STALL** | `Parser.pos`'s FIELD fact is `dynamic`; these are all `this.x = … = this.pos` |
| `Node.start` | MOVE | **STALL** | `startNodeAt(this.start, …)` — `Parser.start` is dynamic, so `Node`'s `pos` param is dynamic |
| `Token.start/end` | MOVE (atom path) | **STALL** | `new Token(this)` DOES bind the instance atom (`Token(object)` is proven), but `start`/`end` are not IN the atom: only fields with an ATOM fact are, and they are dynamic |
| `Token.type/value`, `SourceLocation.*`, `Parser.*Loc`, `BranchID.parent` | STALL | STALL | as predicted — non-f64 / ref-typed |

**Root cause, measured write-by-write on `Parser.pos`** (the field every stalled
slot reads through):

1. `err.pos = pos` in `pp$9.raise` — an `"all"`-attributed write onto a
   `SyntaxError`. `raise`'s `pos` param is DYNAMIC, and under the spec's
   (correct, sound) name-based attribution that single write drags EVERY owner's
   `pos` field to DYNAMIC.
2. ~22 × `state.pos = start` in the `regexp_*` methods, where `start` is a LOCAL
   (`var start = state.pos`). The shared scope model is **params-only**, so
   every local infers DYNAMIC.
3. `this.pos = end + 2`, `this.pos += size` — same locals problem; `+=` with a
   DYNAMIC RHS is correctly DYNAMIC (`x + y` is string-or-number).
4. `this.pos = this.nextIndex(this.pos, forceU)` — `inferExpr` resolves only
   IDENTIFIER callees, so every METHOD call is DYNAMIC even though the satellite
   holds that method's return fact.

So the mutual fixpoint is not the binding constraint on this corpus; **the
value-flow precision of the shared evaluator is**. Ranked next levers, with the
evidence above:

1. **Method-call return facts in `evalValueExpr`** — the satellite already has
   per-method return lattice values; `core.inferExpr` cannot reach them. A
   name-based join over write-once methods of that name is sound (widening) and
   directly fixes (4).
2. **Non-reassigned local bindings in `buildScope`** — fixes (2)/(3). Note the
   cheap check: this alone does NOT unblock acorn, because `state.pos` is itself
   dynamic; it must land WITH lever 1.
3. **Per-name attribution refinement for `"all"` writes** — (1) is one write on
   an object that is provably not a fnctor instance (`new SyntaxError`). A
   "receiver's constructor is a known non-tracked builtin" carve-out would
   retire it. This is the only one that needs new soundness argument.

### Spec deviations (both material, both with evidence)

1. **§7 says the `.call` sites in acorn are "on untracked receivers". They are
   NOT, and the omission was UNSOUND, not merely imprecise.** `finishNodeAt`
   (acorn `dist/acorn.mjs:3891`) is a top-level function DECLARATION — a tracked
   callable — and it is invoked ONLY as `finishNodeAt.call(this, …)` (:3902,
   :3908). Before this slice that shape produced no edge *and* no poison, so its
   params stayed at lattice BOTTOM (`unknown`) forever, and its `node.end = pos`
   write then contributed *nothing* to `end` instead of widening it. That is
   optimism in the direction the whole design forbids. Implemented as specified
   (`.call` → edge with `args.slice(1)`; `.apply` → poison; extracted
   `.call`/`.apply`/`.bind` → poison; `.constructor` outside a comparison →
   `poisonAllCtors`). Measured cost on acorn: `.constructor` 0 sites, `.bind` 0,
   `.apply` 0, `.call` 6 of which exactly 2 hit a tracked callable.
2. **§3.4's dynamic-key poison must NOT fire on non-`this` receivers.** Read
   literally, `newNode[prop] = node[prop]` (acorn's `copyNode`) sets
   `poisonAllFields`, which is a whole-module kill switch: measured, it zeroed
   *every* acorn field fact (the first census run came back with
   `poisonAllFields=true` and all 11 owners fully dynamic). The paragraph's own
   next sentence names untracked non-`this` dynamic-key writes as the family's
   DOCUMENTED GAP, so the poison is scoped to `this[k]`-form writes, where the
   owner is localizable. Pinned by a test.

Minor, where the spec was silent or redundant: the `"poison"` `FieldWrite.kind`
and the `definite` flag are not carried (poisons live in the state's sets;
definiteness is produced by §4's ordered walk, which is the only consumer);
`.apply` uses the existing node-level poison rather than a params-only variant
(strictly more conservative, and 0 sites on the corpus); direct this-reads match
`PropertyAccessExpression` only, not string-literal element access.

### Gates / suites

`tsc` 0 · biome lint 0 · prettier 0 · oracle-ratchet 0 · loc-budget 0 (grant:
propagate.ts +9) · func-budget 0 · dead-exports 0 · coercion-sites 0 ·
stack-balance 0 · check:ir-fallbacks 0. Suites: new `issue-743-mutual-fixpoint`
24/24; `issue-743-*` 49/49; `issue-4155-*`, `issue-2660-*`, `ir-*` green except
`ir-scaffold` (1) and four `tests/equivalence/*` cases, all four A/B-confirmed
PRE-EXISTING on `origin/main` sources in this same worktree. The nine
`issue-3520-*` census failures are likewise pre-existing.

**Flag verdict: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` STAYS OFF.** The lever the
2026-08-06 measurement named as #1 by expected yield now exists, is proven
end-to-end on synthetic cycles, and pays nothing on acorn. The honest reading is
that the remaining 40 are not gated on graph reach or on field↔param mutuality —
they are gated on how precisely a value expression can be evaluated once the
graph gets you there.

## 2026-08-07 — satellite i32/bitwise producer rule IMPLEMENTED: the rule and the evaluator-extension hook land; the acorn census does NOT move, and the missing two levers are now measured, not guessed

Branch `claude/issue-743-i32-producer`, stacked on `claude/issue-743-mutual-fixpoint`
(PR #4175, not yet on main). Implements re-ranked lever 1 from the locals spec's
§8 — "1–2 slots, S-horizon, sound" — via the `InferExtension` hook that spec's
§3.3 designed.

### What shipped

- **`InferExtension`** (`src/ir/propagate.ts`): an optional trailing `ext` on
  `inferExpr`, its three atom helpers and `walkBodyForReturns`, consulted once
  at the top of `inferExpr`'s dispatch. A satellite gets first refusal on every
  node; returning `undefined` falls through to the unchanged shared dispatch.
  The always-on `buildIrUnitTypeMap` path passes nothing, so main-map parity
  holds **by construction**, not by measurement. This is the substrate the
  locals spec asked for, and it is now in place independent of whether the
  locals slice is ever scheduled.
- **`src/ir/fnctor-i32-producers.ts`**: the producer rule. `& | ^ << >>` and
  their compound twins → `i32`; `>>>`/`>>>=` → `u32`; `~` → `i32`. The
  satellite's consumer collapses `i32`/`u32`/`f64` into one f64 slot, which is
  why the satellite may take a fact the MAIN map withholds behind
  `JS2WASM_IR_I32_DOMAIN` (there an `i32` is an instruction-selection promise
  Stage 3 has not shipped).

**The rule is deliberately WIDER than the core's**, and this is the one piece of
new soundness reasoning in the slice. The core demands `f64Compatible` on BOTH
operands; the semantics need much less. `ApplyStringOrNumericBinaryOperator`
takes `ToNumeric` of both operands and throws a TypeError if the two results
differ in type, so **one provably-Number operand is sufficient**: the expression
either throws (no value flows) or both were Numbers and the result is an
Int32. `"abc" | 0`, `undefined | 0` and `({}) | 0` are all Int32s the core
calls DYNAMIC. Three consequences worth stating once:

- `string` and `bool` operands count as proof (`ToNumeric` of either is a
  Number); `object` does **NOT**, because `ToPrimitive` runs user code and the
  satellite's `object` atoms include instance shapes of constructors in the
  module under analysis, which can define `Symbol.toPrimitive`. `unknown` is
  lattice BOTTOM and is never evidence.
- Two unproven operands stay DYNAMIC: both could be BigInts, and a BigInt
  reaching an f64 field slot is the miscompile this guard exists to prevent.
- `>>>` needs **no** guard at all — `BigInt::unsignedRightShift` throws
  unconditionally, so the operator has no BigInt-producing form.

### Measurements (acorn-standalone-compile, `-O3`, `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`)

- **Census 55 typed / 1 discarded / 40 unknown — UNCHANGED. Zero slots moved**,
  verified row-by-row (all 96 rows compared on `slot` and `verdict` against a
  baseline run of the same probe on the unpatched base). Binary 874,370 B,
  byte-count unchanged. Canaries 2,3,4,5; imports `[]`; exactly the 3
  pre-existing parity IR-FALLBACKs (parse / parseExpressionAt / tokenizer).
- **Flag-off byte-identity**: sha256 of the standalone acorn binary is
  `f54ecf75af4f62227af4abb7e002224d243b1fd3e5253a081b85bd0620c463f5`
  (874,280 B) — identical with the branch's sources and with the base's,
  A/B'd by file copy in one worktree.
- Wall A/B **not run** (pre-registered at ≥5 movers; 0 moved).

### Why 0 — measured per lever on the dist, not argued

The locals spec's §7 named `Scope.flags` as the row this lever would move. It
is the right row and the lever is not sufficient. Running the satellite over
`tests/dogfood/.acorn/package/dist/acorn.mjs` and over edited copies — each
edit *simulating* one candidate lever — and reading `Scope`'s ctor param fact:

| variant | `Scope` param0 |
| --- | --- |
| A — as shipped, with this slice's producer rule | `dynamic` |
| B — A + module-level numeric consts (`SCOPE_TOP = 1`, …) bound in scope | `dynamic` |
| C — B + condition-agnostic conditionals | **`f64`** |
| Z — upper bound: every `enterScope` argument replaced by a literal | `f64` |

C reaching the same answer as the Z upper bound is the load-bearing part:
nothing beyond those three rules pins the slot. So `Scope.flags` needs
**exactly three** evaluator rules and **any two of them move nothing**:

1. **the bitwise producer rule** (this slice) — it is what makes
   `functionFlags(…) | SCOPE_SUPER | (allowDirectSuper ? … : 0)` and
   `SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER` numeric, and what carries
   `functionFlags`' own body (`SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | …`,
   left-associative, so the literal on the far left proves the whole chain);
2. **module-level numeric constants in scope** — acorn calls
   `this.enterScope(SCOPE_SWITCH)` with a bare module `var`, and the satellite's
   scope is params-only, so `scope.get(name)` answers DYNAMIC;
3. **condition-agnostic conditionals** — 2 of the 8 `enterScope` sites are
   `cond ? A : B` with a DYNAMIC `cond`. The core bails on
   `!boolCompatible(cond)`, but **ToBoolean is total and never throws, so the
   condition's type cannot affect the RESULT type**: `join(whenTrue, whenFalse)`
   is correct whatever the condition is. This one is a strict soundness
   *improvement* over the existing guard, not a relaxation of it.

That table is the actionable output of this slice. It is also a correction to
the spec's §8 pricing: lever 1 was costed at "1–2 slots" standalone, and
standalone it is worth 0 — the `Scope.flags` chain was priced without checking
what the other seven `enterScope` arguments evaluate to.

### Gates / suites

`tsc` 0 · biome lint 0 · prettier 0 · oracle-ratchet 0 · loc-budget 0 (grant:
propagate.ts +34) · func-budget 0 · dead-exports 0 · coercion-sites 0 ·
stack-balance 0 · check:ir-fallbacks 0. Suites: new
`tests/issue-743-i32-producers.test.ts` 27/27 (per-operator arms, the BigInt
guard incl. the `object`-is-not-proof negative, 8 nesting-depth fixtures for the
threading failure mode, main-map inertness, and an E2E where a bitwise-only slot
goes `externref` → `f64` with identical runtime behaviour); `issue-743-*` 50/50;
`issue-4155-fnctor-field-provenance` 8/8.

**Flag verdict: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` STAYS OFF.**

## 2026-08-07 — levers 2 and 3 IMPLEMENTED: the three-rule prediction holds, `Scope.flags` flips, census 55/1/40 → 56/1/39

Same branch (`claude/issue-743-i32-producer`), continuing the slice above. The
producer rule's probe predicted that `Scope.flags` needs **exactly three**
evaluator rules and that any two move nothing; this slice implements the other
two and the prediction is confirmed to the slot, with real guards rather than
the probe's edited-source simulation.

### What shipped

- **`src/ir/fnctor-module-consts.ts` — lever 2, module-level numeric constants.**
  Resolves a top-level `var`/`let`/`const` to `f64` when it can prove the
  binding only ever holds a Number. **Three obligations, none optional**, and the
  third is the one that is easy to miss:
  1. **VALUE** — the initializer is a constant numeric expression built from
     numeric literals, `- + ~`, the numeric binary operators and *previously
     accepted* constants (so acorn's `SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION | …`
     resolves and a forward reference does not). Deliberately **not** "the
     checker says `number`": in an untyped `.mjs` that is an inference over code
     TypeScript never type-checks, and a later `X = "s"` is a silent error rather
     than a widened type. `BigIntLiteral` falls through and is refused.
  2. **STABILITY** — one write ANYWHERE in the module poisons, including
     compound assignment, `++`/`--`, `for…of` targets and destructuring targets
     (`[X] = a`, `({X} = o)`, `({p: X} = o)`). `with` and direct `eval` anywhere
     poison every constant in the module: both can name a binding without
     leaving an identifier occurrence for the write scan to see. A **script**
     (non-module) is refused outright — its top-level `var` is a writable
     global-object property, reachable as `globalThis.X` with no identifier
     occurrence at all. That module-only restriction is the same one
     `directTopLevelDeclaration` (`src/ir/module-bindings.ts`, #2949) already
     applies to fix a unique top-level `var` to one scalar slot.
  3. **INITIALISEDNESS** — no read may observe the binding's hoisted
     `undefined`. `var X = 1` holds `undefined` from module instantiation until
     its own statement runs, and an `f64` fact for a read in that window turns
     `undefined` into NaN at a coercing store. **This is not a residual we
     accepted; it is proved per binding**, and the satellite is already on
     record refusing exactly this hazard elsewhere — `readFieldFact` answers
     DYNAMIC for a field outside its definiteness snapshot with the same
     one-line justification.
  Resolution is by **symbol**, never by name: a parameter or local that shadows
  a module constant keeps its own (more precise) fact. The name set is only a
  pre-filter in front of the checker call.
- **The conditional-join rule** (`src/ir/fnctor-eval-extensions.ts`) — lever 3,
  and the single factory that composes all three rules onto the one
  `InferExtension` the core accepts. The three answer on disjoint node kinds
  (binary/`~` · identifier · conditional), so composition order is not a
  semantic choice.

### Obligation 3's machinery, and why the obvious shortcut costs the whole lever

The init-order bound rests on one hard JavaScript guarantee — **a function
cannot be invoked before the code that creates its closure has run** — plus one
consequence: a method installed by `pp.enterScope = function (…) {…}` at
statement 610 does not exist at statement 100, so no receiver can dispatch to it
there. That is why property dispatch, which this analysis does not model at all,
cannot break the bound.

HOISTED top-level function declarations are the one shape with no creation
bound. Their bound comes from their **references** instead — a hoisted function
runs only if something names it, and every name sits in a context with a bound
of its own; the equations are solved by a greatest fixpoint (initialise to
"never runs during init", relax downward), which correctly answers "never" for a
mutually-recursive group nothing else references. Costing a hoisted declaration
at 0 instead — the obvious conservative shortcut — rejects acorn's
`functionFlags` (`SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | …`), and with it
`SCOPE_FUNCTION`/`SCOPE_ASYNC`/`SCOPE_GENERATOR`, and with those the entire
lever: the producer rule then has no proven operand anywhere in that chain.
Both directions are pinned by test.

Two escapes are handled bluntly because they are rare and unbounded: `with` /
direct `eval` (above), and a **cyclic import**, which can call an exported
function before this module's top level has run — so with any `import` present
every hoisted declaration drops to 0 and the bound propagates outward through
the same equations.

### Lever 3's soundness — ToBoolean TOTALITY (read this before "restoring" the guard)

The core answers DYNAMIC whenever `!boolCompatible(cond)`, and `boolCompatible`
is `bool || unknown` — so even `1 ? 2 : 3` was DYNAMIC. **That guard is
over-conservative, not soundness-required.** `A ? B : C` evaluates the
condition, applies `ToBoolean`, and then evaluates exactly one branch, so the
value is B's or C's and `join(B, C)` covers both. `ToBoolean` is a **total**
function defined by a table over the whole type domain (Undefined/Null → false,
Boolean → itself, Number/BigInt → zero-or-NaN, String → emptiness, Symbol →
true, Object → true). It has no abrupt-completion path and it invokes **no user
code** — in particular it does not go through `ToPrimitive`, so no `valueOf` /
`Symbol.toPrimitive` can run and no third value can be produced. There is
therefore no assignment of a type to the condition under which the RESULT type
could differ from `join(B, C)`. (If the condition itself throws, no value flows
and any fact is vacuously sound — the same reasoning the previous slice's BigInt
guard uses.)

The rule is a strict **refinement**: where the core's guard passes it already
computes exactly this join; where it fails it answers DYNAMIC, which is above
the join in the lattice. It can only lower a fact, never raise one. The rationale
is stated at length on the function itself so the next reader does not "fix" it
back.

### Measurements (acorn-standalone-compile, `-O3`, `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`)

Per-slot movement, all 96 rows compared on `slot` and `verdict` against a
baseline run of the same probe on this branch's tip before the slice:

| slot           | before               | after           |
| -------------- | -------------------- | --------------- |
| `Scope.flags`  | `externref`/`unknown` | `f64`/`typed`  |
| (95 others)    | unchanged             | unchanged      |

- **Census 55 typed / 1 discarded / 40 unknown → 56 / 1 / 39.** Exactly the
  predicted slot, and only it. Nothing predicted failed to move: the producer
  slice named `Scope.flags` alone, and the remaining 39 are the buckets the
  method-edges slice characterised (≈14 `this`-field-read arguments, ≈5 non-f64
  atoms the f64-only consumer excludes, ≈19 genuinely dynamic) — all of which
  need *different* levers, not more evaluator precision.
- Binary 937,274 B → **937,301 B** (+27 B). Canaries 2,3,4,5; imports `[]`;
  exactly the 3 pre-existing parity IR-FALLBACKs (parse / parseExpressionAt /
  tokenizer), unchanged from baseline.
- **Flag-off byte-identity**: sha256
  `fc51f61f426ade114fb1a00c03e3a5d591ab4a23ff21de4f375641e5b667d946`
  (923,976 B), measured on the pinned acorn dist with the branch's satellite
  sources and again with **origin/main's** — identical. A/B'd by file copy in
  one worktree, so the claim covers the whole branch (both slices), not just
  this one.
- Wall A/B **not run** (pre-registered at ≥5 movers; 1 moved).

### Per-lever attribution — the three-rule claim, re-measured against the real implementation

Reading `Scope`'s ctor param-0 fact over the real acorn dist, dropping one rule
at a time from the composition:

| composition                          | `Scope` param0 |
| ------------------------------------ | -------------- |
| levers 1 + 2 + 3 (shipped)           | **`f64`**      |
| levers 1 + 3 (no module constants)   | `dynamic`      |
| levers 1 + 2 (no conditional join)   | `dynamic`      |

This reproduces the producer slice's A/B/C probe table with guarded rules rather
than edited sources — including the guards, which is the part the simulation
could not test. It also completes the correction to the locals spec's §8
pricing: lever 1 alone was worth 0, and all three together are worth **1 slot**,
the bottom of the "1–2" the spec estimated for lever 1 by itself.

### Gates / suites

`tsc` 0 · biome lint 0 · prettier 0 · oracle-ratchet 0 · loc-budget 0 (no new
grant — both rules are new satellite modules; `propagate.ts` is untouched by
this slice) · func-budget 0 · dead-exports 0 · coercion-sites 0 · stack-balance 0
· check:ir-fallbacks 0. Suites: new `tests/issue-743-eval-extensions.test.ts`
32/32 (one negative per obligation, both directions of the hoisted-reader bound,
the shadowing-parameter case, the `object`-is-not-proof boundary re-pinned under
the new rules, and an E2E whose slot needs BOTH new rules and no bitwise
operator at all); `issue-743-*` + `issue-4155-*` + `issue-2660-*` +
`ir-propagate-i32*` + `ir-frontend-widening` **300/300**.

**Flag verdict: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` STILL STAYS OFF.** One slot on
the dogfood corpus is a working lever, not a consumer. The bucket's remaining
levers are unchanged in rank: (1) ref/string-typed slot consumption for the ≈5
atoms the graph already proves, (2) `this`-field-read arguments beyond what the
mutual fixpoint reaches. Neither is an evaluator-precision question, which is
what this slice and the one above it have now exhausted.

## Implementation Plan — ref/string consumer ABI (Fable spec, 2026-08-07)

Spec for re-ranked **lever 2** — extend the fnctor field-slot consumer beyond
f64 to ref (`(ref null $__fnctor_F)`) and native-string (`(ref null $AnyString)`)
slots, for the "≈5 non-f64 atoms the graph already PROVES" bucket the 2026-08-06
method-edges section named. Measured against `origin/main` + this branch
(`claude/issue-743-i32-producer` @ `ffc8ca8bf`, i.e. PR #4202's rules included);
line anchors are from that revision.

### 0. Verdict first (pricing): **DO NOT BUILD.** The bucket is 1 slot, not 5, and that 1 slot is worth ZERO bytes — measured, not predicted

Three numbers decide it, all measured on the pinned acorn 8.16.0 dist in this
worktree:

1. **The bucket is 1, not ≈5.** Cross-referencing the census's 39 `unknown`
   rows against the satellite's per-owner **FIELD** facts (`JS2WASM_LOG_FNCTOR_GRAPH=1`,
   `src/ir/fnctor-method-edges.ts:262`), exactly **two** unknown slots carry a
   non-`dynamic` field fact: `TokContext.token` (`string`) and
   `RegExpValidationState.parser` (`object`). `object` is a **structural** atom
   with no nominal identity, so it cannot name a struct type (§2). That leaves
   **one** typeable slot on the whole corpus.
2. **The ≈5 figure was read off PARAM facts, and params are the wrong
   quantity.** The 2026-08-06 section cited `TokenType(string, dynamic)` /
   `TokContext(string, bool, bool, dynamic, bool)` — those are ctor-parameter
   facts, and they predate the mutual fixpoint (2026-08-07), which is what first
   made per-field facts exist. A slot must agree with **every** write the
   analysis can see, not just the constructor's. Measured, `TokenType.label`'s
   param fact is `string` while its FIELD fact is `dynamic` (§3.1). Pricing a
   slot lever off param facts overcounts it by 5×.
3. **Flipping the one typeable slot changes the emitted binary by 0 bytes.**
   A/B'd by file copy in one worktree (`JS2WASM_TMP_TOKCTX=1` forcing
   `TokContext.token` into the #3753 `$AnyString` promotion at
   `fnctor-escape-gate.ts:1808`, verified applied by instrumenting the
   post-promotion field list → `token:ref_null,isExpr:i32,preserveSpace:i32,
   override:externref,generator:i32`): **937,301 B before and after**, canaries
   2,3,4,5, imports `[]`, exactly the 3 pre-existing IR-FALLBACKs. The slot is
   constructed 10× at module init and read 4× module-wide; `-O3` normalises the
   difference away completely.

Under the program's own rule (< ~5 movers ⇒ say so), the recommendation is **do
not implement**. This is the third consecutive slice to price out, and the
reason has now converged: the bucket that remains is not gated on which ABI the
consumer can express, it is gated on `Parser.pos`'s field fact (lever 3 of the
locals spec's §8 list — the XL string-builtin/provenance program).

### 1. Baseline re-verified in this lane (do not take it on trust)

`JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`,
standalone acorn `-O3`, via a probe over
`tests/dogfood/acorn-standalone-compile.mjs` reading
`fnctorFieldProvenanceRecords()`:

- census **56 typed / 1 discarded / 39 unknown** (96 rows), binary **937,301 B**,
  compile 64.4 s, canaries **2,3,4,5**, imports `[]`, errors = exactly the 3
  parity IR-FALLBACKs (`parse` / `parseExpressionAt` / `tokenizer`).

Matches PR #4202's stated numbers exactly. The single `discarded` row is
`Parser.options` (the #2937 object-hash-consumer path), unchanged since #4155.

### 2. The REF half — every slot fails, and for TWO independent reasons

The prompt's premise was that #4155 Phase 1's machinery
(`resolveFnctorInstanceType`, `fnctor-typed-instances.ts:74`) makes ref slots
cheap: it already maps an instance type onto a reserved `$__fnctor_F` with
guarded casts and presence tracking. That machinery is real and it already
fires — it is exactly what took the `discarded` bucket 4 → 1 and typed
`Parser.type`, `Node.loc`, `Token.loc`. **The excluded-comment's recorded fears
(`fnctor-ctor-param-types.ts:32-34`, "refs … carry their own null and identity
questions at a struct field") are therefore SOLVED for the case they cover.**
`Node.loc` is `ref_null` **and** presence-tracked today, which settles the
`Node.loc` interplay question directly: presence bits (#2847) are orthogonal to
the slot type, and the #3683/#3753 carve-outs on `onlyConditional` exist because
those are POST-derivation promotions of a slot whose dispatcher arm must still
answer `undefined` — a checker-derived ref slot never had that problem.

What is NOT solved is getting a *name* for the type when the checker has
nothing. Measured per slot (probe: run `analyzeFnctorEscapeGate` over the dist,
print each ctor's first `this.<f> = …` carrier and
`receiverStruct.get(carrier)`):

| slot | ctor carrier (acorn dist) | why no `(ref null $__fnctor_F)` |
| --- | --- | --- |
| `Parser.startLoc`, `Parser.endLoc` | `this.curPosition()` | **(a)** `Position` is **not an approved fnctor** — gate classification `{"keep-static":3}`, `approvedNames = TokenType, SourceLocation, Parser, Node, BranchID, RegExpValidationState`. No reserved struct exists to name. **(b)** `curPosition` is guarded by `if (this.options.locations)`, so it is not the single-return chain `inferReturnStruct` requires |
| `Parser.lastTokStartLoc`, `Parser.lastTokEndLoc` | `null` | same (a); the later writes are Positions |
| `SourceLocation.start`, `SourceLocation.end` | bare params `start` / `end` | same (a); plus no provenance — the call args are `p.startLoc` / `p.endLoc`, property reads that `buildReceiverStructMap` (`:1157`) does not bind |
| `Token.type`, `Token.value`, `Token.start`, `Token.end` | `p.type` / `p.value` / `p.start` / `p.end` | `Token` not approved; and `p` is unpinned because the site is `new Token(this)` and `inferExprStruct` (`:1188`) has **no bare-`this` rule** (it handles `this` only inside `new this(…)`, `:1202`). Even pinned, the carriers are field READS, not the instance |
| `BranchID.parent`, `BranchID.base` | `parent`, `base \|\| this` | field facts `dynamic`; `this` unhandled as above |
| `RegExpValidationState.parser` | bare param `parser` | field fact is `object` — **structural, not nominal**. Site is `new RegExpValidationState(this)`, so `receiverStruct` binds nothing for the same bare-`this` gap. The ONE slot where a bounded extension exists (§2.1) |
| `Node.sourceFile`, `Parser.sourceFile` | `parser.options.directSourceFile`, `options.sourceFile` | not ref-class — string-or-undefined config reads, field fact `dynamic` |

`receiverStruct` on this corpus has 1,128 entries and pins **exactly one**
constructor carrier: `Parser.type = types$1.eof → __fnctor_TokenType` — the slot
that is already typed. Zero ref-class unknowns are reachable through it.

#### 2.1 The one extension that would work, and why it is still a no

Teaching `inferExprStruct` a bare-`this`-inside-a-lifted-proto-method rule
(`resolveEnclosingFnctorOwner`, already used at `:1203`) would pin
`RegExpValidationState`'s `parser` param to `__fnctor_Parser`. Do not do it as
part of a *slot* lever:

- `receiverStruct` is a **use-site flow map with ambiguity invalidation**
  (`:1252-1269`), not a write-set join. It answers "this expression is an F" for
  a dispatch pin, where a wrong answer costs nothing because the pin is checked.
  A **slot type** must hold every value ever written to the field, which is a
  different obligation and one this map never took on.
- The failure mode is materially worse than the family's accepted bound. For
  f64 a violating write is ToNumber-coerced to NaN; for `$AnyString` it becomes
  `ref.null`. Both are *coercions* in the sense that the store is total and the
  value class is preserved-or-degraded predictably. For a **specific struct**
  target there is no JS coercion at all: `type-coercion.ts:2290` emits
  `local.tee / any.convert_extern / local.tee / ref.test T / if` and the else
  arm is `ref.null` (`:2340`) — a wrong value is silently **destroyed**, and the
  field reads back as absent. That is a new failure class, not an extension of
  an accepted one.
- Payoff: `.parser` has 5 syntactic accesses in the whole dist, none in the
  tokenizer.

### 3. The STRING half — one slot, and the lane split is already precedent

#### 3.1 Why four of the five "proven string" slots are not proven

| slot | param fact | FIELD fact | why the field widens |
| --- | --- | --- | --- |
| `TokContext.token` | `string` | **`string`** | only write is `this.token = token` (dist `:2428`) — **TYPEABLE** |
| `TokenType.label` | `string` | `dynamic` | name-based `"all"` attribution: `node.label = null` (`:1054`), `node.label = this.parseIdent()` (`:1057`), `node.label = expr` (`:1340`) are writes to a *Node*, and the sound over-approximation drags every owner's `label`. Same shape as the `err.pos = pos` pin the mutual-fixpoint section measured |
| `TokenType.keyword` | — | `dynamic` | the ctor write is `this.keyword = conf.keyword` (`:112`) — a property read on an untracked base, which `inferExpr` types DYNAMIC. (`options.keyword = name` at `:136` would contribute `string`; it is not the binding write) |
| `TokContext.override` | `dynamic` | `dynamic` | ctor param 3 is a function-or-`undefined` (`this.override = override`, `:2431`) |
| `SourceLocation.source` | — | `dynamic?` | `p.sourceFile` property read, **and** presence-tracked |

So the string bucket is **1**, and it is a slot #3753's own name-keyed analysis
already declines: `analyzeStringPropertyNames` requires ≥1 *provably* string
write, and `this.token = token` is a bare parameter read, which that analysis
classifies as opaque by design. The satellite's contribution is real — it is the
only thing on the corpus that can prove that parameter is a string — it is just
worth one cold slot.

#### 3.2 Lane split (unchanged from the dts-seeds precedent, if ever built)

The existing #3753 gate at `fnctor-escape-gate.ts:1808` is already exactly the
required split: `ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 &&
JS2WASM_STRING_FIELDS !== "0"`. In externref-string lanes the promotion is a
deliberate ABI **no-op**, mirroring the `.d.ts` string seed. Verified live on
this corpus: `nativeStrings=true anyStrTypeIdx=6` at TokContext derivation time,
so the lazy-type hazard the comment warns about does not bite here.

#### 3.3 Conversion costs, at both ends

- **Write** (`externref → ref_null $AnyString`, `type-coercion.ts:2290`):
  `local.tee` + `any.convert_extern` + `local.tee` + `ref.test` + an `if` whose
  else arm is TWO further nested test/cast ladders — the `new String(…)` wrapper
  recovery (`:2312`, via `__wrapper_string_value`) and the `$AnyValue` tag-5
  payload arm (`:2348`). ≈20 instructions and 2 temp locals **per store site**.
- **Read** (`ref_null $AnyString → externref`): `ref.is_null` + `extern.convert_any`
  with an `undefined`-singleton arm (`:1701`), or nothing at all when the
  consumer wants the native string.

#3753's own justification is that "the cost this removes is per-ACCESS, not
per-write". `TokContext` inverts that ratio: 10 construction sites against 4
accesses. That is the arithmetic behind the measured 0-byte delta.

### 4. The payoff question this lever exists for — answered NO on both halves

- **Hot paths.** Syntactic `.name` counts on the dist: `type` 204, `pos` 245,
  `input` 116 — and all three of those slots are **already typed**
  (`Parser.type` `ref_null $__fnctor_TokenType` via #4155 Phase 1;
  `Parser.pos` f64; `Parser.input` `ref` string from the checker). The
  ref/string candidates are `token` 4, `override` 3, `parser` 5, `label` 7,
  `startLoc` 20, `endLoc` 4, `branchID` 10. The tokenizer's hot fields are not
  in this bucket; the ones that are (`Parser.start/end/lastTokStart/lastTokEnd`)
  are **f64**-class and blocked on `Parser.pos`'s field fact.
- **`updateContext` specifically.** `TokenType.updateContext` is
  **method-valued**, and #4155 Phase 2 refuses a property access in callee
  position outright and by design (`fnctor-typed-reads.ts`, "A member CALL is
  NEVER static off the struct type" — the rule that killed the #1712 attempt).
  A typed slot there can never feed it.
- **Do the dormant flags get values?** No. #4155 Phase 2 needs a receiver whose
  compiled ValType is a `$__fnctor_F`; a *string* field is not one, so the
  string half feeds it nothing. The one ref candidate's receiver chain
  (`this.regexpState`) is itself `externref`, so the chain breaks upstream of
  the slot. **The default-off question for `JS2WASM_FNCTOR_TYPED_READS` and the
  #2660 S3b binding retype does NOT reopen on this lever.**

### 5. Soundness rules, recorded for whoever builds this later

If a future corpus makes the bucket worth it, these are the obligations:

1. **Consult the FIELD fact, never the param fact.** A slot must agree with the
   join over every write `deriveFnctorFields` *and* the satellite's write scan
   can see — including `"all"`-attributed writes on untracked receivers. The
   satellite computes exactly this (`runFieldPass`,
   `src/ir/fnctor-field-lattice.ts:212`) but does **not export it**; a builder
   must add a `computeFnctorGraphFieldFacts` export beside the two at
   `fnctor-method-edges.ts:137/:154`.
2. **Presence-tracked fields keep their carrier** for a *promotion*, but a
   checker-derived ref slot may be presence-tracked (`Node.loc` is both today).
   The rule is about where the type is chosen, not about the type.
3. **External/violating writes.** The ctor ABI stays `externref` by design
   (#4166), so every store goes through the guarded coercion above. For f64 that
   is ToNumber; for `$AnyString` it is test-or-null; for a named struct it is
   test-or-null with no coercion semantics at all (§2.1). Only the first two are
   inside the family's accepted bound.
4. **Do not reuse `receiverStruct` as a slot-type oracle** (§2.1).

### 6. Correction to the measurement protocol: the CENSUS CANNOT SEE THIS LEVER

`recordFnctorFieldProvenance` is called from `recordThisField`
(`fnctor-escape-gate.ts:1595`), which runs during
`collectThisAssignments(body.statements)` (`:1706`) — **before** the #3683
numeric promotion (`:1778`) and the #3753 string promotion (`:1808`). The census
is therefore a **pre-promotion** measure of the slot choice.

Consequences, both load-bearing for the next slice:

- The `Scope.flags` 55 → 56 move was census-visible only because the ctor-param
  consumer is invoked at `:1579`, *inside* `recordThisField`. A ref/string
  consumer implemented as a promotion is invisible to the census even when it
  changes the struct.
- Conversely, routing the same slot flip through
  `inferFnctorFieldTypeFromCtorParam` **would** print 57/1/38 — while emitting a
  byte-identical binary. **A census delta from this lever would be an artifact
  of where the hook sits, not evidence of value.** Anyone reporting "+1 slot"
  here must also report the binary delta, or the number means nothing.

### 7. Files / anchors, if it is ever scheduled

- `src/ir/fnctor-field-lattice.ts:212` (`runFieldPass`) → new export of
  `solved.fieldFacts` through `fnctor-method-edges.ts` `GraphFacts`
  (`fnctor-graph-model.ts:140`).
- `src/codegen/fnctor-ctor-param-types.ts:71` — the consumer; needs the FIELD
  NAME, which it does not currently receive (derive it from
  `valueExpr.parent`'s LHS, or widen the call at `fnctor-escape-gate.ts:1579`).
- `src/codegen/fnctor-escape-gate.ts:1808` — the string lane gate to mirror.
- Do **not** touch `fnctor-typed-instances.ts:74`; the instance-type path is
  orthogonal and already correct.

### 8. Re-ranked levers after this measurement

1. **`Parser.pos`'s field fact** — string-builtin rules + `||`-caching +
   null-tolerant joins + nominal provenance as ONE priced XL program (unchanged
   from the locals spec's §8 item 3). It gates 7 dependent f64 slots and is the
   only path left to the tokenizer's remaining boxes.
2. **A second corpus.** Three levers in a row have now priced out on acorn
   specifically, each for a corpus-shaped reason (entry-point seeds inert
   because canaries already supply the facts; locals blocked by string builtins;
   ref/string blocked because acorn's non-f64 fields are written from property
   reads). Before spending XL on item 1, measure whether a second dogfood
   package shows the same shape — the answer changes what item 1 is worth.
3. **This lever** — build only as a rider on item 1, and only after re-measuring
   the field-fact bucket on that corpus.

Verified assumptions: (a) the satellite probe runs over the extracted
`tests/dogfood/.acorn/package/dist/acorn.mjs` under a synthetic
`ts.ScriptKind.JS` program, matching the technique the i32-producer slice used —
its facts agreed with the in-compile census on every cross-checkable row;
(b) `approvedNames` / gate classifications are from
`analyzeFnctorEscapeGate` on that same source; (c) the 0-byte A/B forced the
promotion at the #3753 site rather than through the flag's own consumer, because
the two produce the same struct shape and the former needs no plumbing — §6
explains why that choice does not weaken the conclusion.
