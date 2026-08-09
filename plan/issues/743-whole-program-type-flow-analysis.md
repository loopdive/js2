---
id: 743
title: "Whole-program type flow analysis"
status: in-progress
assignee: ttraenkler/fable-743-fixpoint
pr: 4246
created: 2026-03-22
updated: 2026-08-08
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

## Implementation Plan — satellite local-variable typing (Fable spec, 2026-08-07)

Spec for the locals lever the 2026-08-07 Results section ranked #2, designed to
land WITH lever #1 (method-return facts) and with the `raise` attribution
question resolved. Everything below was verified against the branch
`claude/issue-743-mutual-fixpoint` @ `39dd7b543` (line anchors are that
revision) and against the acorn 8.16.0 dist
(`tests/dogfood/.acorn/package/dist/acorn.mjs`, extracted from
`tests/dogfood/fixtures/acorn-8.16.0.tgz` — dist line anchors below). Facts I
could not execute-check are labeled ASSUMPTION.

### 0. Verdict first (pricing): predicted acorn movers ≈ 0 — recommend AGAINST implementing this slice now; pivot

Read §7 for the per-slot chains. The one-line version: every f64-class slot in
the 40-unknown bucket chains through `Parser.pos`'s FIELD fact, and `Parser.pos`
is pinned `dynamic` by **at least five independent write families**, of which
the three ranked levers (locals, method returns, `raise` attribution) retire at
most two. Two of the surviving pins bottom out in **string-builtin calls**
(`this.input.indexOf(…)`, `.charCodeAt(…)`, `.match(…)[0].length`) that no
locals model can type, and one — the 22 `state.pos = <local>` regexp writes —
requires **nominal instance provenance** for an untracked receiver, a
qualitatively bigger analysis than anything in this family. Locals typing alone
moves **0** of the 40; locals + raise fix moves **0**; locals + raise + method
returns moves **0**. A spec that predicts zero movers should not be implemented
for the acorn census goal; §8 re-ranks. The design below is still written out in
full because (a) the evaluator-extension architecture (§3–§5) is the right
substrate for ANY future satellite precision work and settles the byte-identity
question once, and (b) the soundness analysis kills one UNSOUND suggestion the
2026-08-07 Results section's ranked-lever list contains (§5 — name-based
method-RETURN joins are not sound; the predecessor's §7 lesson repeats).

### 1. Scope and constraints (unchanged from the family, all load-bearing)

- SATELLITE ONLY. Main `IrUnitTypeMap` byte-identical (#1712 parity). One
  consumer: `src/codegen/fnctor-ctor-param-types.ts`, f64-only, flag
  `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` default OFF.
- Flag-off byte-identity vs origin/main asserted by sha256 on the standalone
  acorn binary (the mutual-fixpoint slice's procedure, baseline
  `11aa8e230bca8223…`, 861,854 B — re-derive on whatever main is current).
- Census baseline: **55 typed / 1 discarded / 40 unknown**; canaries 2,3,4,5;
  imports `[]`; 3 pre-existing parity IR-FALLBACKs.
- The shared lattice core stays ONE implementation. No forked evaluator: any
  new rule enters `inferExpr` behind an explicit extensions hook (§3.3) that
  the always-on main fixpoint never passes — that is how flag-off
  byte-identity survives without duplicating operator semantics.

### 2. Measured root cause, re-verified write-by-write on the dist

Every dist claim below was re-checked by grep/read on
`tests/dogfood/.acorn/package/dist/acorn.mjs` (acorn 8.16.0):

- VERIFIED `var Parser = function Parser(options, input, startPos)` :510;
  `this.input = String(input)` :523; `this.pos = startPos` :534;
  `this.pos = this.lineStart = 0` :538.
- VERIFIED `pp$4.raise = function(pos, message)` :3754 with
  `var err = new SyntaxError(message); err.pos = pos; …` :3760–3761 — the
  receiver is a single-assignment local whose initializer is
  `new SyntaxError(…)`, a global-builtin construction; `SyntaxError` is never
  assigned or shadowed anywhere in the dist (grep: the only occurrences are
  the two `new SyntaxError` sites, :3760 and the `RegExpValidationState`-path
  reuse via `raiseRecoverable = raise` :3765).
- VERIFIED the regexp family: 22 × `var start = state.pos` /
  20 × `state.pos = start` (plus `state.pos = pos` :4139-adjacent shapes,
  `state.pos = leadSurrogateEnd` :4791, `state.pos = 0` :4199) across
  `pp$1.regexp_*` methods :4281–5388. `state` is always a PARAM of the
  method, fed by name-based edges whose root is readRegexp's local
  `var state = this.regexpState || (this.regexpState = new
  RegExpValidationState(this))` :5823, with `this.regexpState = null` in the
  Parser ctor :592.
- VERIFIED `this.pos = end + 2` :5494 where
  `var start = this.pos, end = this.input.indexOf("*/", this.pos += 2)` :5492.
- VERIFIED `this.pos += octalStr.length - 1` :6125 where
  `var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0]`
  :6119, reassigned `octalStr = octalStr.slice(0, -1)` :6122.
- VERIFIED `this.pos += ch <= 0xffff ? 1 : 2` :6169 where
  `var ch = this.fullCharCodeAtPos()` :6166 — a this-method call whose own
  return chains through `this.fullCharCodeAt(this.pos)` :5487 into
  `charCodeAt`.
- VERIFIED `RegExpValidationState.prototype.advance`:
  `this.pos = this.nextIndex(this.pos, forceU)` :4113; `nextIndex` :4085
  returns `l` / `i + 1` / `i + 2` where `var s = this.source; var l =
  s.length` — the return bottoms out in `.length` on a field whose own fact
  cannot become `string` (see §5, last paragraph).
- VERIFIED benign sites that already work with the params-only scope:
  `this.pos += startSkip` :5509 (`startSkip` is a param), `this.pos += size`
  :5798 (`size` is a param), all integer-literal `+=`/`++` sites.

### 3. Design — local-binding lattice inside tracked bodies

#### 3.1 Model: flow-insensitive join over ALL assignments, with an eligibility gate

A local's lattice value is the JOIN of every contribution that can ever be
stored in it. This is the widen-only direction the whole family uses: a read
bounded by the join of all writes is sound wherever the read observes an
assigned value. Flow-sensitivity (SSA-lite, last-write-wins) is REJECTED:
last-write-wins is unsound across loop back-edges without a CFG, and SSA-lite
buys nothing here — §7 shows the acorn stalls are not ordering-precision
losses, they are missing-rule losses (builtins, provenance). Loops therefore
need no special handling at all: the join is order-free.

Per function-like body, a declared local (identifier-named `var`/`let`/`const`)
is **eligible** iff ALL of:

1. Its declaration carries an initializer. (A bare `var x;` makes `undefined`
   observable at reads the position rule below cannot exclude.)
2. No read of its symbol occurs lexically BEFORE the declaration within the
   enclosing function — where any reference inside a nested
   **FunctionDeclaration** counts as lexically-prior regardless of position
   (function-declaration hoisting lets a textually-later body run before the
   initializer; function EXPRESSIONS and arrows are values and cannot execute
   before their own definition site, so the position argument holds for them).
   With (1)+(2), every read the analysis can be asked about observes a value
   some recorded contribution produced — never `undefined`. Reassignments do
   NOT disqualify; they contribute to the join.
3. It is not a destructuring binding, not a `for-in`/`for-of` binding, not a
   catch-clause binding, and not a parameter (params are already modeled).
4. The enclosing function contains no direct `eval` identifier-call and no
   `with` statement (either can write var-scoped locals invisibly). Cheap
   per-function boolean computed during the scan.

Ineligible locals bind DYNAMIC (explicitly, so they shadow any outer binding
of the same name — see trap T6).

Contributions of an eligible local, mirroring the FieldWrite taxonomy
(`src/ir/fnctor-field-writes.ts:35–53`):

- declaration initializer and every `x = rhs` → eval(rhs) (chain-unwrapped);
- `x -= *= /= %= **= <<= >>= >>>= &= |= ^=`, `x++`/`x--` → F64;
- `x += rhs` → plus-join of the local's own running join with eval(rhs) —
  reuse `plusJoin` (`src/ir/fnctor-field-lattice.ts:159`), hoisting it to the
  shared model module;
- `x &&= ||= ??=` → eval(rhs) joined in (old value already in the join).

Closure capture needs NO extra poison: assignments inside nested
function-likes are assignments to the same symbol and enter the join like any
other (widening). What DOES need care is which SCOPE their RHS is evaluated
in — see §3.2.

#### 3.2 Evaluation scope and iteration mechanics

Two phases:

- **Scan phase** (once, alongside `scanFieldWrites`): build
  `localSpecs: Map<ts.SignatureDeclaration, LocalSpec[]>` on `AnalysisState`
  (`src/ir/fnctor-graph-model.ts:94`), where `LocalSpec = { name, eligible,
  contributions: { kind, expr?, declaringFn }[] }`, in declaration-position
  order. Contribution RHS evaluation is deferred; only shapes are recorded.
- **Per-iteration phase**: `buildScope` (`src/ir/fnctor-method-edges.ts:839`)
  currently binds params along the scope chain, outermost first. Extend it:
  after binding a chain link's params, evaluate that link's `LocalSpec`s in
  position order and bind each local into the same map before moving inward.
  Position order is closed under the eligibility rule: an eligible local's
  initializer cannot read a later-declared local (that read would be
  lexically-prior for the later local, making IT ineligible → DYNAMIC, which
  is what the partially-built scope answers anyway via the explicit DYNAMIC
  binding). Contributions whose `declaringFn` is a nested function are
  evaluated against the scope built so far plus DYNAMIC for the nested
  function's own params when it is not in the chain (exactly the existing
  params rule at :847).
- Local values are DERIVED per iteration from the current param/field/return
  facts (same recompute-from-seeds discipline as fields), so they are not new
  lattice variables and add no convergence obligations beyond the existing
  ones. Cache per iteration: `fx.localScopes: Map<ts.Node, Map<string,
  LatticeType>>`, cleared at the top of each iteration next to `fx.atoms`
  (`src/ir/fnctor-method-edges.ts:868`). NOT caching across iterations is
  load-bearing (trap T5).
- `<this>` inside local initializers: a proto-method's locals may read
  `this.x`. `buildScope` has no this-context today; thread the optional
  `thisCtx` that `writeContext` (`src/ir/fnctor-field-lattice.ts:167`) and the
  edge loop (:879–881) already possess into the locals evaluation, so a local
  init's DIRECT `this.<x>` read is answered by `readFieldFact` via the same
  extension hook (§3.3) that fixes nested reads.

#### 3.3 The evaluator extension hook (the architectural piece)

`evalValueExpr` (`src/ir/fnctor-field-lattice.ts:137`) special-cases only
TOP-LEVEL direct `this.<x>` reads; anything nested delegates to
`core.inferExpr`, which recurses internally — so satellite-only precision
(direct field reads at depth, method-call returns, any future builtin rule)
is structurally unreachable today. Fix at the core, compatibly:

- Add an optional trailing parameter to `inferExpr` and `walkBodyForReturns`
  (`src/ir/propagate.ts:691, :1369`):
  `ext?: { tryInfer(expr, scope): LatticeType | undefined }`.
- At the top of `inferExpr`'s dispatch (after the parenthesis unwrap, before
  the literal cases): `if (ext) { const t = ext.tryInfer(expr, scope); if (t
  !== undefined) return t; }`. Thread `ext` through EVERY internal recursion
  site (`inferObjectLiteralAtom` :914, `inferPropertyAccessAtom` :961,
  `inferElementAccessAtom` :981, the `walkBodyForReturns` var/return arms
  :1396–1409) — a partially-threaded hook produces wrong answers silently,
  not crashes (trap T4).
- Main-fixpoint call sites pass nothing → the always-on path is
  byte-identical by construction (assert via the existing binary-hash
  procedure).
- The satellite's `tryInfer` handles, in order: (a) direct `this.<x>` reads
  when a thisCtx is in force (subsuming the current top-level special case —
  keep the top-level path too so behavior without hooks is unchanged);
  (b) owner-resolved method-call returns (§5); (c) nothing else in this
  slice. Export via `_propagationCore` unchanged members plus the new
  parameter.

### 4. Decision — the `raise` `"all"`-attribution carve-out: YES, narrowable soundly; NO, it does not change the outcome

`err.pos = pos` (:3761) is an `"all"`-attributed write because `err` is an
untracked receiver. Carve-out: drop a write from the all-bucket when the
receiver is an identifier resolving to a local/var binding whose assignments
are ALL of the form `new B(…)` where `B` is an identifier whose symbol has
**no value declaration in this SourceFile** (a lib/global builtin) and whose
name is **never written** anywhere in the file (no `B = …`, no `var B`, no
shadowing declaration on the path — cheapest sound check: no in-file
declaration at all per the checker symbol, plus no in-file assignment to the
name). Soundness:

- In-module: a host builtin's construction result predates the module and
  cannot be an instance of a tracked fnctor; `new B(…)` where B is a plain
  in-file function could return a tracked instance (ctor-return-object
  semantics), which is why the carve-out requires B to be OUT-OF-FILE, not
  merely untracked.
- Cross-module: `globalThis.SyntaxError = Parser` after importing the module
  would defeat it. That attack lands in the SAME damage class the family
  already accepts at the export boundary (module header,
  `src/ir/fnctor-method-edges.ts:85–90`): the consumer is f64-only, a
  violating write coerces through the numeric unbox path to a NaN-class
  value, never a reinterpreted reference. State this in the carve-out's
  comment; it is a trust extension, not a proof.

So the answer to the posed question is: attribution CAN be narrowed soundly —
`err.pos = pos` does NOT legitimately widen `Parser.pos` forever. But
implementing it retires ONE of ≥5 independent pins on `Parser.pos` (§7), so
it re-ranks nothing by itself.

### 5. Decision — method-call returns on `this` receivers: owner-resolved ONLY; the Results section's "name-based join" suggestion is UNSOUND

The 2026-08-07 ranked-lever list says a "name-based join over write-once
methods of that name is sound (widening)". That transplants the WRITE-side
argument to the READ side, where it inverts. Feeding a method's params from
every same-name site over-approximates (extra feeds only widen the fact — the
sound direction). But CONSUMING a return fact requires the fact to
over-approximate every possible callee's return, and the name-based set
contains only TRACKED methods of that name: `recv.m()` where `recv` is an
untracked object with its own `m` (a user options object, an out-of-module
value) returns something no tracked node bounds. That is optimism in exactly
the direction the module header forbids — the same failure shape as the
predecessor spec's §7 error. Do NOT implement name-based return joins.

Sound rule — resolve the callee's OWNER, then read that one node's return
fact from `entries`:

- `this.m(args)` where the site's this-binder is a materialized proto-method
  of owner O (reuse `instanceThisOwnerAt`, `src/ir/fnctor-method-edges.ts:694`):
  dispatch resolves through O's prototype iff ALL of — O not `protoPoisoned`,
  `m` not in `runtimeDefinedProtoKeys(O)`, `m` not in `valueReadNames`,
  `methodWrites` has a good write-once proto entry for (O, m), AND `m` cannot
  be shadowed by an own property: `m` ∉ `fieldNamesByOwner(O)`, ∉ the
  all-bucket names (any `"all"` FieldWrite named `m`), ∉
  `fieldDynamicNames`/`fieldDynamicPerOwner(O)`, O ∉ `fieldPoisonedOwners`,
  and `!poisonAllFields`. Then return `entries.get(nodeOf(O,"proto",m)).returnType`.
- `C.m(args)` where `C` is an identifier resolving to a tracked ctor: the
  static slot via `staticMethodNode`, same poison checks on the static space.
- Anything else (untracked receiver, element-access callee, optional
  chaining): no answer — fall through to the core's DYNAMIC.

Honest yield note, so the implementer is not surprised: this rule DOES
resolve the shape `this.pos = this.nextIndex(this.pos, forceU)` (:4113,
thisOwner = RegExpValidationState) — but on acorn the resolved fact is still
DYNAMIC, because `nextIndex`'s own return joins `l` where `var l = s.length`,
`var s = this.source`, and (a) `.length` on a string-valued fact has no rule
in the shared lattice, (b) `this.source`'s fact cannot even reach `string`:
its reset write is `this.source = pattern + ""` (:4047) and `inferExpr`'s `+`
rule (`src/ir/propagate.ts:774–779`) is f64-or-DYNAMIC — there is no
string-concatenation producer in the shared core (only the field-level
`plusJoin` knows string-plus). Adding string rules to the shared core is a
main-map behavior change (NOT flag-gated) and is out of scope; adding them
satellite-side via the hook is possible future work but is NOT in this slice
(§8).

### 6. What is deliberately NOT in this slice

- No string-builtin return table (`String(x)`, `.length`, `.indexOf`,
  `.charCodeAt`, `.slice`, …) — each is individually sound only when the
  receiver's fact is provably `string`, which on acorn it never is (see §5);
  building the table without the string-fact substrate yields nothing and
  invites receiver-unsound shortcuts.
- No nominal instance provenance (typing `new Tracked(…)` results as
  owner-tagged references and narrowing untracked-receiver write attribution
  by provenance). This is the ONLY lever that can retire the 22
  `state.pos = <local>` all-bucket writes, and it is a new lattice dimension
  (structural object atoms are deliberately NOT nominal — two same-shape
  owners merge, so attribution-by-atom is unsound). Pricing it honestly: it
  needs a provenance atom, join rules, escape rules, and a re-audit of every
  attribution site — an XL-class follow-on that should only be considered if
  a corpus census justifies it. On acorn it is NECESSARY-but-not-sufficient
  for `Parser.pos` (the string-builtin pins remain).
- No `||`-caching-idiom rule (`this.regexpState || (this.regexpState = new
  …)`) and no null-bearing lattice atom — required for the `state` param's
  fact, same follow-on bucket.

### 7. Per-slot prediction for the 40 unknowns (pre-registered)

Chains verified per §2. "L" = locals (§3), "R" = raise carve-out (§4), "M" =
owner-resolved method returns (§5).

| Slot(s) | L alone | L+R | L+R+M | Chain (why) |
| --- | --- | --- | --- | --- |
| `Parser.pos` (typed in census via ctor path; its SATELLITE field fact is the gate for the rows below) | dynamic | dynamic | dynamic | Pins: (1) 22 × all-bucket `state.pos = start` — `start = state.pos`, `state` param DYNAMIC (regexpState `\|\|`-idiom + null write), so L evaluates the local to DYNAMIC; retiring the pin needs nominal provenance (§6). (2) `this.pos = end + 2` — `end = this.input.indexOf(…)`: string-builtin, no rule. (3) `this.pos += octalStr.length - 1` — `.match(…)[0]` then `.length`: no rule, plus-join drags DYNAMIC. (4) `this.pos += ch <= 0xffff ? 1 : 2` — `ch = this.fullCharCodeAtPos()`: M resolves the callee but its return bottoms in `charCodeAt` → DYNAMIC → condition DYNAMIC. (5) `err.pos = pos` — retired by R. Net: 4 of 5 pins survive |
| `Parser.start/end/lastTokStart/lastTokEnd` (4) | stall | stall | stall | `this.start = this.end = this.pos` — reads `Parser.pos` field fact (row above) |
| `Node.start` (1) | stall | stall | stall | `startNodeAt(this.start, …)` → `Parser.start` dynamic |
| `Token.start/end` (2) | stall | stall | stall | instance-atom path proven; `start`/`end` not IN the atom while dynamic |
| `Token.type/value`, `SourceLocation.start/end`, `Parser.startLoc/endLoc/lastTokStartLoc/lastTokEndLoc`, `BranchID.parent` (~9) | stall | stall | stall | ref-typed (TokenType/Position/BranchID refs); consumer is f64-only — no evaluator lever applies |
| `Scope.flags` (1–2) | stall | stall | stall | bitwise producers; needs the satellite i32 producer rule (different, cheap lever — §8) |
| `TokenType.label/keyword`, `TokContext.token/override` (+1) (~5) | stall | stall | stall | facts already proven string/bool; blocked on string-ABI consumption, not on evaluation |
| genuinely dynamic (~19) | stall | stall | stall | RegExp-object fields, `null` seeds, arrays, config reads — honest boxes |

**Predicted movers: 0 / 0 / 0.** Pre-registered wall-A/B trigger: run the
perf A/B only if ≥ 5 slots move (predicted: not run). Pre-registered census
gate: if implementation contradicts this table by moving ≥ 1 slot, record
which chain the table got wrong before celebrating — a mover this table
missed means a soundness argument above is likely wrong somewhere, and that
matters more than the slot.

### 8. Pricing verdict and re-ranked levers

This slice, as ranked by the 2026-08-07 Results section, prices at ~0 acorn
slots even bundled with lever 1 and the raise fix, because the ranked list
under-modeled two things this spec verified on the dist: the string-builtin
bottom of every tokenizer chain, and the provenance requirement behind the
regexp all-bucket writes. Under the program's own rule (< ~5 movers ⇒ say so),
the recommendation is: **do not implement; pivot.** Re-ranked by measured
yield per unit risk:

1. **Satellite i32/bitwise producer rule** (§7 row `Scope.flags`; the
   2026-08-06 section already called it "the cheap follow-up"): 1–2 slots,
   S-horizon, sound (JS bitwise is always numeric), implementable via the §3.3
   hook without touching the shared core's flag-off behavior.
2. **Ref/string-typed slot consumption** (bucket 3, ~5 slots already PROVEN
   by the graph; plus it is the entry ramp to the boxed-value 32% by a
   consumer-ABI route rather than an analysis route). This is
   Workstream-2-adjacent consumer work, not satellite analysis.
3. **String-builtin rules + `||`-caching + null-tolerant joins + nominal
   provenance as ONE priced program** (the only path to `Parser.pos` and its
   7 dependent f64 slots) — XL, only worth scheduling if a second corpus
   shows the same shape with fewer pins, since on acorn ALL of it is needed
   before the FIRST slot moves.
4. This locals slice — implement only as substrate (§3.3 hook + locals) if
   and when item 3 is scheduled; alone it moves nothing.

### 9. Files / functions to touch (anchors on `claude/issue-743-mutual-fixpoint` @ `39dd7b543`)

If implemented (per §8, deferred):

- `src/ir/propagate.ts` — `inferExpr` :691 (add `ext` param + top-of-dispatch
  consult; thread through :698, :736, :759–760, :841–845, :870-adjacent,
  :882, :889, :892 and the three atom helpers :914/:961/:981),
  `walkBodyForReturns` :1369 (`ext` threading in :1400/:1408),
  `_propagationCore` :1537 (no member changes; signatures widen).
- `src/ir/fnctor-graph-model.ts` — `AnalysisState` :94 (+`localSpecs`),
  hoist `plusJoin` here from `fnctor-field-lattice.ts:159`, add `LocalSpec`.
- NEW `src/ir/fnctor-local-bindings.ts` — scan (`scanLocalBindings(state)`,
  called from `analyze` next to `scanFieldWrites`
  `src/ir/fnctor-method-edges.ts:205`) + per-iteration
  `localScopeFor(fx, fnLike, outerScope, thisCtx)`. New module keeps the
  LOC ratchet honest (the 4-file split precedent).
- `src/ir/fnctor-method-edges.ts` — `buildScope` :839 (merge locals per chain
  link; accept optional `thisCtx`), `runFixpoint` :817 (clear
  `fx.localScopes` next to `fx.atoms` :868; construct the satellite `ext` and
  pass it at :884 and :901), `buildEdges`/`instanceThisOwnerAt` :694
  (unchanged; reused by §5).
- `src/ir/fnctor-field-lattice.ts` — `FixpointCtx` :32 (+`localScopes`,
  +`ext`), `evalValueExpr` :137 (pass `ext` to `core.inferExpr` :151),
  `writeContext` :167 (thread `thisCtx` into locals evaluation).
- `src/ir/fnctor-field-writes.ts` — §4 carve-out in `classifyFieldReceiver`
  :68 (before the `"all"` return :81) gated on the receiver-provenance check;
  the check itself lives in the new module.

### 10. Test fixtures the implementer must write

Extend the `tests/issue-743-*` pattern (`tests/issue-743-mutual-fixpoint.test.ts`
is the template — synthetic sources through `computeFnctorGraphCtorParamFacts`):

1. const-init local feeding a ctor field write → slot f64.
2. Reassigned local: `var a = 1; a = "s"` → join drags the fed slot off f64.
3. Declared-without-initializer local → DYNAMIC (and SHADOWS an outer
   same-name param — assert the inner binding wins).
4. Read-before-decl (`use(x); var x = 1`) → DYNAMIC.
5. Read inside a hoisted nested FunctionDeclaration, textually after the
   decl → DYNAMIC (the hoisting rule); same shape with an arrow → typed.
6. Closure reassignment (`var n = 1; arr.forEach(function(){ n = "s" })`) →
   join includes the nested write.
7. Destructuring / for-of binding → DYNAMIC.
8. Direct `eval` in the body → all locals of that function DYNAMIC.
9. Local in an EDGE argument position (not just a field-write RHS).
10. `this.m(…)` owner-resolved return typing a field; NEGATIVE twin where
    `m` is also an all-bucket field name (own-property shadow) → DYNAMIC.
11. NEGATIVE: same-name method on a second owner + untracked receiver call —
    assert the return fact is NOT consulted (no name-based return join).
12. §4 carve-out: `var e = new SyntaxError(m); e.f = arg` does not drag
    owner fields named `f`; twin with in-file `function SyntaxError(){}` →
    carve-out disabled; twin with `SyntaxError = Foo` in-file → disabled.
13. Flag-off byte-identity + census + canary assertions per the family's
    standing measurement protocol (§11 of the mutual-fixpoint spec).

### 11. Traps

- **T1 (soundness, repeats the predecessor's §7 lesson): no name-based
  RETURN joins** (§5). The ranked-lever list in the Results section above
  contains this exact unsound suggestion; it must not be implemented as
  written.
- **T2: function-declaration hoisting breaks lexical-position reasoning** —
  reads inside nested FunctionDeclarations are always-prior (§3.1 rule 2).
- **T3: `arguments` aliases PARAMS in sloppy mode** — a pre-existing,
  family-wide gap in the params-only scope (unmodeled today; the dist is
  sloppy-mode code). Locals are not aliasable by `arguments`, so this slice
  neither fixes nor worsens it; do not silently "fix" it here (it would
  change existing param facts and invalidate the baseline table).
- **T4: partial `ext` threading fails silently.** A recursion site that
  drops `ext` answers DYNAMIC for nested shapes and nothing crashes. Pin
  with fixture 5/9/10 variants that place the interesting read 2+ levels
  deep in an expression.
- **T5: per-iteration cache discipline.** Local scopes derive from facts
  that change per iteration; caching across iterations reintroduces the
  order-dependence the frozen-atoms rule (:864–869) exists to prevent. Clear
  with `fx.atoms`.
- **T6: an ineligible local must bind DYNAMIC explicitly**, not be omitted —
  omission lets an outer param/local of the same name leak through
  `scope.get(name)` (`src/ir/propagate.ts:732–734` falls back to DYNAMIC
  only when the name is entirely absent).
- **T7: do not add string rules to the shared core** (`+`-concatenation,
  `.length`) to make a fixture pass — that changes the always-on main map
  (flag-off identity break, #1712 hazard). Satellite-side only, via `ext`,
  and NOT in this slice (§6).
- **T8: `new <TrackedCtor>(…)` as a VALUE stays DYNAMIC** in this slice.
  Typing it as the instance atom looks free but is provenance work (§6) —
  the structural atom cannot carry attribution, and half-adding it invites
  the unsound attribution-by-shape shortcut.
- **T9: monotonicity.** Locals add derived reads through atoms and field
  facts, both non-monotone sources; the converged-or-EMPTY rule
  (`src/ir/fnctor-method-edges.ts:210–214`) already covers this — do not
  weaken it to "use best iteration".

ASSUMPTIONS for the implementer to check (none affect the §7 verdict's
direction, only its margins): (a) the exact membership of the ~19
"genuinely dynamic" bucket 4 is taken from the 2026-08-06 provenance table,
not re-measured here; (b) the census's `Parser.pos` "typed" status (via the
legacy ctor-path consumer) coexisting with a dynamic satellite field fact was
taken from the 2026-08-07 Results section, not re-run; (c) dist line anchors
are from the extracted `.acorn/package/dist/acorn.mjs` of the pinned 8.16.0
tarball — re-extract if `.acorn/` is absent in a fresh worktree.
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

## 2026-08-08 — second-corpus measurement (pako 2.1.0): the acorn conclusion does NOT generalize

The re-ranked levers above put "a second corpus" ahead of the field-fact XL
program: three levers priced out on acorn for corpus-shaped reasons, and the
question was whether the representation program is exhausted generally or only
there. **Answer: only there.** pako's untyped residue is dominated by exactly
the two levers acorn made look worthless.

### Setup

Tree: `41ad08c3` (main) + docs commits. Probe: compile the package's
self-contained dist bundle with `target: "standalone"`,
`JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`, then
read `fnctorFieldProvenanceRecords()` + `classifyFieldSlot` in-process (no
optimize step — slot decisions are made in codegen, before Binaryen). Same-tree
acorn control: `tests/dogfood/acorn-standalone-compile.mjs` reproduces the
recorded census EXACTLY — 96 slots, 56 / 1 / 39, canaries 2,3,4,5, imports
`[]` — so the cross-corpus comparison is same-commit, not cross-session.

### Corpus selection (two candidates rejected, recorded so nobody retries them)

- **styled-components 6.4.4** (the only substantial npm-compat package whose
  compile lane is green): its esm entry is a 39 KB re-export wrapper, not a
  self-contained bundle; standalone compile fails (50× TDZ "Cannot access 'n'
  before initialization") and produces **0 fnctor records**. Unusable.
- **luxon 3.7.2** (262 KB, 25 classes): **native `class` syntax — the fnctor
  machinery (function-constructor path) never engages, 0 records.** Also
  standalone-blocked (`String.prototype.match` unsupported, Intl host-import
  leaks). Beyond unusable, this is a finding in its own right: **the entire
  fnctor typing program is invisible to modern class-syntax bundles.** Any
  future corpus must be an ES5-style function-ctor bundle, or the program
  needs a class-ctor equivalent first.
- **pako 2.1.0** `dist/pako.esm.mjs` (226 KB — acorn's size class; zlib port;
  7 function-ctors; typed-array/numeric-heavy where acorn is string/object-
  heavy): census runs to completion. **Chosen.** One caveat: binary emit fails
  with a single error (packed `i16` leaked into a local — filed as **#4216**),
  so pako is census-only until that lands; codegen and all 122 slot decisions
  complete before the emit stage.

### The census, side by side

| | acorn 8.16.0 | pako 2.1.0 |
| --- | ---: | ---: |
| slots | 96 | 122 |
| typed | 56 (58.3 %) | **94 (77.0 %)** |
| discarded | 1 (1.0 %) | 3 (2.5 %) |
| unknown | 39 (40.6 %) | **25 (20.5 %)** |

pako's typed slots: 77× f64, 10× ref_null, 5× i32, 2× ref. Its discarded
bucket (`Deflate.strm: ZStream`, `Inflate.strm: ZStream`, `Inflate.header:
GZheader`) is acorn's #1712 shape-model gap, same cause, same size class.
Call-site param inference **works where its preconditions hold**: `Config`'s
four numeric tuning params are all typed f64 from ten all-literal `new Config`
sites.

### The 25 unknowns, bucketed (each verified in source)

1. **17 (68 %) — null-in-ctor, concretely assigned post-ctor** (`DeflateState`
   9, `InflateState` 8): `this.window = null` in the ctor; `s.window = new
   Uint8Array(...)`, `s.head = new Uint16Array(...)`, `s.l_desc = new
   TreeDesc(...)` in `deflateInit2`/`inflateInit` — monomorphic concrete
   writes outside the ctor. **The blocker is `deriveFnctorFields`' first-
   write-decides rule, not inference.** The lever is slot-typing from the JOIN
   OF ALL WRITES (the mutual-fixpoint slice already built the write scan that
   would feed it). Acorn has ~6 such slots; here it is two-thirds of the
   residue.
2. **5 (20 %) — ref-valued ctor args, concrete at every site**
   (`StaticTreeDesc.static_tree/extra_bits`, `TreeDesc.dyn_tree/stat_desc`,
   `Config.func`): module-const arrays, `Uint16Array` this-fields,
   `StaticTreeDesc` instances, function references. **The blocker is the
   f64-only consumer ABI** — the ref/string consumer that measured 1 slot /
   0 bytes on acorn has a real population here.
3. **1 — conditional-join extension**: `has_stree = static_tree &&
   static_tree.length` — the lhs is a ref (always truthy), so the `&&` always
   yields the numeric rhs; typing it needs the shipped ToBoolean-totality join
   rule extended to ref-typed lhs.
4. **2 (8 %) — open options objects** (`Deflate.options`, `Inflate.options`
   via `assign({}, DEFAULTS, options)`): acorn's `Parser.options` analog —
   genuinely dynamic, honest boxes.

**And 0 slots in acorn's dominant bucket.** The ~14-slot "integer-valued
`this`-field-read arguments" population that drives acorn's residue — and
motivates the `Parser.pos` field-fact XL program — simply does not exist here.

### Consequences for the lever ranking

- **The receiver-typing program is NOT exhausted generally — it is exhausted
  on acorn.** pako's residue is addressable, and by levers already
  half-built: (1) **all-writes slot join** (17 slots here vs ~6 on acorn;
  collection side exists in the mutual-fixpoint write scan), then (2) **ref-
  typed slot consumption** (5 slots here vs the measured 1/0-bytes on acorn).
- **The `Parser.pos` field-fact XL program is acorn-specific.** Do not
  greenlight it on generality grounds; if it is built, it is for acorn's
  perf number alone.
- Numeric-heavy corpora are already well served (77 % typed) — consistent
  with #4157's cross-runtime profile showing the remaining tax is in boxed
  VALUES and comparisons, not receivers.
- The `.d.ts`-seed lever stays untested on a second corpus: pako ships no
  bundled declarations (`@types/pako` is external). A typed-declaration
  corpus remains unmeasured.
- Wall-clock A/B is not applicable pre-#4216 (no binary); the census is the
  pre-registered instrument for this question and is deterministic.

Probe artifacts: `.tmp/file-census.mjs` (inline in this section's Setup),
outputs `.tmp/pako-census.json`, `.tmp/luxon-census.json`,
`.tmp/sc-census.json`, acorn control `.tmp/acorn-probe.{json,err}` — scratch
only; this section is the durable record.

## 2026-08-08 — Parser.pos program: pin-census instrument + the first two slices LANDED

The locals spec's §7 pin table was hand-traced and predates the levers that
landed later the same day. This session built the INSTRUMENT that makes the
table mechanical, re-measured, and retired the two cheapest pin families the
fresh census exposed.

### The instrument: `JS2WASM_FNCTOR_FIELD_FACT_TRACE=<field | Owner.field | *>`

`src/ir/fnctor-field-fact-trace.ts`, hooked into `runFieldPass` /
`fieldContribution` (env-gated, inert off; records overwrite per iteration so
the surviving snapshot is post-convergence). For each matching `owner.field`
it prints every reaching write with site line, attribution, kind, and its
evaluated contribution — plus, for `+=` writes, the RHS value SEPARATELY,
because a plus-assign contribution folds the field's running fact in via
`plusJoin`: a dynamic contribution with a clean RHS is **derivative** (clears
when the roots do), only a dynamic RHS or a dynamic plain assign is a **root
pin**. Probe idiom: `.tmp/pos-pin-census.mjs` (fixture-style synthetic program
over the dist, then `formatFieldFactTrace()`).

### What the live census corrected in the §7 table

- **Pin (4) — `+= ch <= 0xffff ? 1 : 2` — was ALREADY retired** by the
  shipped conditional-join rule; the table predates it.
- **The "benign" `+= 2` / `+= 3` / `+= startSkip` sites were NOT benign** —
  every `+=` on a dynamic running fact reads as dynamic regardless of its RHS
  (the plusJoin feedback). They are derivative, not pins, but the spec's
  "already work" claim was measuring the wrong thing.
- `Parser.pos`: 79 reaching writes, **root pins = (1) `err.pos = pos` :3761,
  (2) 22× all-bucket `state.pos = …`, (3) `this.pos = end + 2` :5494,
  (4) `+= size` :5798 (rhs dynamic), (5) `+= octalStr.length - 1` :6125.**

### Slice A — builtin-instance receiver carve-out (§4 decision, now implemented)

`classifyFieldReceiver` (src/ir/fnctor-field-writes.ts) now attributes a write
NOWHERE when the receiver is an identifier with a single in-file
`var x = new B(…)` declaration, `B` resolves entirely out-of-file (or not at
all — an undeclared global cannot be a tracked in-file ctor), and the binding
is never reassigned by ANY in-file assignment form (full taxonomy: `=`,
compounds, logical assigns, `++`/`--`, for-in/of targets, destructuring —
where the shorthand-property case needs
`checker.getShorthandAssignmentValueSymbol`, NOT `getSymbolAtLocation`, which
answers the PROPERTY symbol; the negative test caught exactly that). The §4
cross-module trust note is carried in the code comment.

### Slice B — arithmetic F64-producer (`- * / % **`), `src/ir/fnctor-f64-producers.ts`

Fourth satellite evaluator rule: either operand provably not a BigInt ⇒ the
expression is a Number — same `ApplyStringOrNumericBinaryOperator` totality
argument as the i32-producer rule (mixed numeric types throw; no value flows
on the counterexample path), minus the Int32 wrap. Retires pin (5) — the
literal `1` alone proves `octalStr.length - 1` numeric, no string substrate
needed — which is CHEAPER than the §6-priced string-builtin route for that
pin. `+` deliberately absent (string-or-number; `plusJoin`'s business).

### Measured result (all on the acorn dist, same session)

| | before | after |
| --- | --- | --- |
| `Parser.pos` root pin families | 5 | **2** (the 22 all-bucket writes · `end + 2`) + one dynamic `size` param |
| `err.pos = pos` :3761 | pins every owner's `pos` | attributed nowhere |
| `+= octalStr.length - 1` / ternary / `+= literal` sites | pins | derivative |
| flag-off standalone binary | — | **byte-identical** (sha256 `fbea40a8…`, 948,264 B, A/B by file copy) |
| flag-on slot census | 56 / 1 / 39 | **56 / 1 / 39 — unchanged, as pre-registered** (no slot moves until ALL pins retire) |
| suites | — | `issue-743-*` + `issue-4155-*` + `issue-2660-*` + `ir-propagate*` + `ir-frontend-widening` **299/299**, new `issue-743-pos-pin-slices.test.ts` 9/9 |

`RegExpValidationState.pos` root pins after the slices: the same 22 all-bucket
writes, `this.pos = this.nextIndex(this.pos, forceU)` :4113 (owner-resolved
method returns, §5), `this.pos = pos` :4139 (dynamic param).

### Fixture trap, recorded for the next test author

A no-call-site function's params sit at UNKNOWN (lattice bottom), and
`f64Compatible(unknown)` is TRUE by design — so a fixture whose "dynamic"
value is an unused entrypoint's param proves nothing (the first draft of this
slice's negative tests passed vacuously). Use a property read (`p.v`) to
manufacture a provably-DYNAMIC value.

## Implementation Plan — receiver-provenance attribution (Fable spec, 2026-08-08)

The next `Parser.pos` slice: re-attribute the 22 all-bucket `state.pos = …`
writes to `RegExpValidationState` so they stop dragging every other owner's
`pos`. Attribution-only — NO new lattice dimension, which is what keeps this
below §6's XL pricing of full value-provenance.

**Sound rule.** An `"all"`-attributed write with receiver identifier `r` may
be re-attributed to tracked owner `R` iff every value reaching `r` is (a) the
result of `new R(…)`, or (b) `null`/`undefined` (the write throws — vacuous).

**Domain.** `⊥ | R (single owner) | ⊤`, join: `⊥∨x=x`, `R∨R=R`, `R∨R'=⊤`.

**Placement.** A provenance-only fixpoint AFTER `buildEdges`, BEFORE
`runFixpoint`, then rewrite `w.owner` before the value fixpoint runs —
attribution must be static input to the value fixpoint; rewriting it during
iteration is non-monotone.

**Feeding.** Param provenance joins over the SAME `edges[].argExprs` the value
fixpoint feeds from, with the same poison gates (a poisoned/escaped callee's
params stay ⊤ — narrowing is what needs proof here, so any gap must widen).
Expression provenance: `new <Ident>(…)` → its owner if a tracked callable,
else ⊤ · `null`/`undefined` literal → ⊥ · identifier → param provenance, or a
single-assignment local's initializer provenance (reuse
`assignedIdentifierSymbols` from the §4 carve-out — a local with one
initialized declaration and no in-file reassignment) · `a || b` / `a ?? b` →
join · `(x = e)` chain → provenance of `e` · `this.<f>` read where the
this-binder is tracked owner O, guarded exactly like `readFieldFact`
(poison/interception checks) → join over the provenance of every write to
O.f's carrier (recursive — participates in the fixpoint) · anything else → ⊤.

**Rewrite rule.** Only rewrite `owner: "all"` → `R` when `R` already has the
field name in `fieldNamesByOwner` (a re-attributed write must not manufacture
field-presence evidence); keep `attribution: "all"` semantics (no snapshot,
never definite). Writes whose receiver's provenance is ⊤ or ⊥ stay in the
all-bucket unchanged (⊥ = only null reaches it — could drop entirely, but
keeping it is the conservative first cut).

**Pre-registered acorn expectation.** `state` param of `pp$1.regexp_*` ←
method-call args `this.regexp_*(state)` ← local `var state =
this.regexpState || (this.regexpState = new RegExpValidationState(this))` ←
`regexpState` writes {ctor `null`, the `||`-assign `new R(this)`} → provenance
R. All 22 writes re-attribute; `Parser.pos`'s remaining root pins become
`end + 2` (:5494) and `+= size` (:5798) — locals/string-substrate territory.
`RegExpValidationState.pos` KEEPS the 22 writes and stays dynamic until its
own valuation levers land (locals + §5 method returns). Verify with the pin
census (`JS2WASM_FNCTOR_FIELD_FACT_TRACE=pos`), which prints attribution
per write.

**Gates.** Flag-off byte-parity (file-copy A/B, sha compare) · family suites ·
negative tests: receiver fed by two different owners → ⊤; receiver also fed by
an untracked call's result → ⊤; escaped/poisoned method's param → ⊤;
`||`-idiom where the field also has a third write of another owner → ⊤.

### What remains for `Parser.pos`, re-priced by the census

1. **Receiver-provenance attribution for the 22 `state.pos` writes** — the
   attribution-only variant: prove `state`'s def-chain closes over
   `{new RegExpValidationState(…), null}` (through the `||`-caching idiom and
   the `regexpState` field's writes) and attribute the writes to that owner
   instead of `"all"`. No new lattice dimension — cheaper than §6's XL
   pricing of full value-provenance, but still needs the locals model for the
   chain. This is now the binding constraint on `Parser.pos`.
2. **Locals + string-builtin substrate for `end + 2`** (§3 spec exists;
   `this.input = String(input)` gives the string fact, `.indexOf` the f64).
3. The `size` param fact (:5798) — likely falls out of whichever of the two
   above lands first; measure, don't assume.

## 2026-08-08 — Parser.pos program IMPLEMENTED (provenance + locals + string substrate): the field fact flips, census 39 → 34, and the VALUE-level instruments both read zero

Branch `issue-743-field-param-mutual-fixpoint` (agent ttraenkler/fable-743-fixpoint).
Implements all three "What remains" items above in one slice, because the pin
census proved no proper subset moves a single slot (`Parser.pos` had three
independent root pins and every dependent slot chains through its FIELD fact).

### What shipped

- **`src/ir/fnctor-receiver-provenance.ts`** — the 2026-08-08 spec, as written:
  `⊥ | R | ⊤` domain, param-provenance fixpoint over the SAME edge set as the
  value fixpoint, `"all"` → R rewrite before `runFixpoint` (static input), only
  when R already carries the field name. `new B(…)` for an out-of-file,
  never-written `B` is ⊥ (the §4 trust class); a tracked ctor whose body has a
  `return <expr>` is ⊤ (ctor-return-override); `a && b` contributes `b` only
  (no object is falsy). All 22 `state.pos = …` writes re-attribute to
  `RegExpValidationState`; `err.pos`-class writes were already gone (§4 slice).
- **`src/ir/fnctor-local-bindings.ts`** — the locals model as an
  `InferExtension` rule resolving by SYMBOL (shadowing is structural, trap T6
  never arises), join over all contributions, `+=` via the same
  string-or-number plus join. Retires the `+= size` pin: every `finishOp` size
  argument is a literal-fed local (`var size = 1; ++size; size = c ? 3 : 2`).
- **`src/ir/fnctor-string-producers.ts`** — `String(x)` → string (host-global
  guard: no in-file declaration/write of `String`); `indexOf`/`lastIndexOf`/
  `charCodeAt` and `.length` → f64 on a receiver the evaluator PROVES string,
  guarded on the method name never being property-written in-file
  (`defineProperties` maps resolve through `resolveLiteralKeys`, which acorn's
  `prototypeAccessors` needs — a blunt decline-all there kills the module).
  Retires the `end + 2` pin via `this.input`'s string field fact.
- **Ctor carrier facts generalized** (`collectThisReadFacts` →
  `collectCtorCarrierFacts`): the node-keyed map now also answers
  `<param>.<field>` carriers (`this.start = p.start` — the Token pattern),
  evaluated post-convergence with the SOLVED fixpoint context; the consumer
  branch in `fnctor-ctor-param-types.ts` widened accordingly. This is what
  makes Token.start consumable — the 2026-08-07 measured table's "atom path"
  expectation was right about the FACT and silent about the CONSUMER.

### Defect found by measurement in the SHIPPED mutual fixpoint (fixed here)

The `+=` field contribution read the field's own PREVIOUS-iteration fact
(`plusJoin(fieldFacts.get(owner).get(name), rhs)`). That is a RATCHET, not a
fixpoint variable: the atom-mediated reads make facts transiently DYNAMIC
(iteration 1, before `input` enters the instance atom), and the feedback edge
then locks the transient in — measured on acorn as `Parser.pos: final dynamic
over 56 writes` with every single contribution evaluating f64. It violates the
recompute-from-seeds discipline the fixpoint's own monotonicity note demands,
and was invisible until now only because root pins kept `pos` dynamic anyway.
Fixed by solving `X = join(base, plusJoin(X, rhs_i))` WITHIN the per-name pass
(`solvePlusFeedback`, lattice-height-bounded inner loop).

### Measurements (same env as the family: acorn standalone `-O3`, `JS2WASM_FNCTOR_FIELD_PROVENANCE=1 JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`)

- **Census 56 typed / 1 discarded / 39 unknown → 61 / 1 / 34.** Movers, all
  f64: `Parser.start`, `Parser.end`, `Parser.lastTokStart`, `Parser.lastTokEnd`
  (ctor chain `this.start = this.end = this.pos`, keyed on the now-f64
  `this.pos` read), `Token.start` (`this.s = p.start` via the param atom +
  the new carrier path). Canaries 2,3,4,5; imports `[]`; exactly the 3
  pre-existing parity IR-FALLBACKs. Binary byte-count unchanged (1,041,855 B
  in the canary-bearing census config).
- **Pin census**: `Parser.pos — final: f64 over 56 write(s)` (was: dynamic
  over 78). `RegExpValidationState.pos` keeps the 22 re-attributed writes and
  stays dynamic, as the spec pre-registered (its own valuation levers — locals
  cannot type `var start = state.pos` while `state`'s VALUE fact is dynamic —
  remain out of scope).
- **Flag-off byte-identity**: sha256
  `93ee8e78e505ef5e76f9097f1aff3d7f15fc2057f2bb22d02fd1dc1be44bdf1f`
  (1,028,259 B, canary-free config) — identical with this branch's sources and
  with `upstream/main`'s, A/B by file copy in one worktree.
- **$AnyValue allocation census (the #4157 value-level metric; #3927/#4185
  instrument, export-name join, `-O3`, full self-parse driver, checksum 422
  both sides): ZERO movement.** Total allocations 233,320 flag-off and
  flag-on; `$AnyValue` (`type_122`: 2×i32 1×f64 1×eqref 1×externref, ~32 B)
  22,008 flag-off and flag-on — matching #4157's "~22 k residual" row. The
  five typed slots eliminate no boxing on this corpus's hot path. Binary
  +124 B flag-on in that config.
- **Wall A/B not run, per pre-registration**: the mutual-fixpoint spec §11 set
  the trigger at ≥10 movers (5 moved), and the allocation delta of ZERO means
  a wall A/B on this box (~10 % noise floor, #4157 §6) cannot resolve the
  change — running it would produce a quotable-but-meaningless sign.

### Spec deviations (recorded, with evidence)

1. **Locals eligibility is STRICTER than the locals spec §3.1**: the
   declaration must be a DIRECT child statement of the declaring function's
   body block. The spec's initializer+position rule is falsified by
   `if (c) var x = 1; use(x)` — initializer present, read positionally after,
   still observes `undefined` when `c` is false. Pinned by test.
2. **Closure-write contributions are DYNAMIC**, not precisely joined (§3.1
   wanted nested-scope evaluation): evaluating a nested fn's RHS against the
   read-site scope resolves same-named identifiers to the WRONG binding. On
   the corpus every pin-relevant local is closure-free, so the precision buys
   nothing. Pinned by test.
3. **An escaped constructor does NOT defeat provenance at a still-visible
   `new R(…)` site** — escape poisons R's PARAM facts (unseen call args), not
   what `new R` constructs. The spec's "poisoned callee's params stay ⊤" gate
   holds where it matters (a write through an escaped function's param stays
   in the all-bucket); both directions pinned by tests.
4. `join(f64, string)` is a lattice UNION atom, not DYNAMIC — the consumer's
   f64-only gate rejects it either way; tests assert `not f64` rather than a
   specific top.

### The honest read against #4157's <20 acceptance

34 is not <20, and the remaining buckets say no evaluator-precision slice gets
there: ~19 genuinely dynamic (RegExp objects, null seeds, arrays, config
reads), ~9 ref-class (Position/SourceLocation/TokenType/BranchID instances +
`RegExpValidationState.parser` — needs the ref-typed consumer ABI that
measured 1 slot / 0 bytes on acorn, plus nominal provenance), ~5 non-f64
atoms (string/bool — string-ABI consumption), `Node.start` (blocked on T8:
`new Tracked(…)` as a VALUE stays DYNAMIC — the nominal-provenance XL
program), `Token.end`/`Parser.end`-field (hard-pinned by
`node.loc.end = loc` :3895 — an all-bucket write on a non-identifier
receiver, out of reach of identifier-keyed provenance; note the Parser.end
SLOT still moved because the ctor chain keys on `this.pos`). With the
value-level instruments reading zero on 5 slots, the census bucket is no
longer a proxy for the boxed-VALUES tax on this corpus — the #4157 line
should re-anchor on the allocation census ($AnyValue 22,008/parse) rather
than the slot count.

**Flag verdict: `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` STAYS OFF** — 5 slots, zero
allocation movement, +124 B.

### Continuation point

- The next census movers, if wanted: (a) ref/string-typed slot consumption
  (~9+5 slots, spec + DO-NOT-BUILD pricing above — re-price against the new
  baseline), (b) nominal provenance / T8 (Node.start + the regexp locals),
  both XL-class and previously priced out on acorn alone; pako's 25-unknown
  census is the second data point that could justify (a).
- The value-level lever #4157 actually needs is upstream of slots entirely
  (the 22 k `$AnyValue` and 47.7 k regex-scratch streams — see #4157's
  redirect section).

## 2026-08-08 — DEFAULTS FLIPPED: the derivation family ships ON (stakeholder decision)

**Stakeholder decision, 2026-08-08: "derive types always; consumers arrive
later."** Every prior "flag verdict: STAYS OFF" in this file was decided on a
*benefit* criterion — the pass moved no slots, no allocations, no wall time on
acorn. That criterion is retired. The derivation runs by default now; whether a
consumer exploits it is a separate question, answered later and per-consumer.

What that changes about the evidence bar: the question is no longer "does this
pay?" but **"is this free?"** — i.e. conformance-neutral and affordable at
compile time. Those are the two numbers this section records, and they are the
two nobody had produced. Every prior measurement in this file is a *slot census*
or a *binary byte count*; the family has never been run against test262, and its
compile-time cost has never been quantified at all.

### Flip pattern

The #4241 layout-emit idiom, verbatim: **unset ⇒ ON**, explicit `0` / `off` /
empty ⇒ OFF. Boolean-shaped on purpose — a malformed value cannot half-enable
anything, it merely fails to disable. The unset-spelling tests invert with the
default, exactly as `tests/issue-3927-fnctor-layout-emit.test.ts` did.


### Flag inventory and disposition

Identified from CODE, not from this file's prose — the issue records name more
levers than exist as gates.

| flag | what it gates | disposition |
| --- | --- | --- |
| `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` (#4117/#743) | the satellite graph, and `new`-site PARAMETER narrowing in both inference lanes (`ir/propagate.ts`, `codegen/declarations/param-return-inference.ts`) | **flipped ON** |
| `JS2WASM_DTS_ENTRYPOINT_SEEDS` (#743) | `.d.ts` entrypoint parameter seeds | **flipped ON** |
| `JS2WASM_FNCTOR_TYPED_READS` (#4155 P2) | typed `struct.get`/`struct.set` for a struct-typed receiver | **flipped ON** |
| `JS2WASM_FNCTOR_TYPED_BINDINGS` (#2660 S3b) | binding retype to `(ref null $__fnctor_F)` | **flipped ON** |
| `JS2WASM_FNCTOR_CTOR_PARAM_SLOTS` (NEW) | `inferFnctorFieldTypeFromCtorParam` — turning a ctor-param fact into a physical field SLOT | **EXCLUDED, opt-in `=1`** |
| `JS2WASM_FNCTOR_TYPED_INSTANCES` | — | already ON since 2026-08-04, untouched |
| `JS2WASM_FNCTOR_LAYOUT_EMIT` | — | already ON since 2026-08-08 (#4241), untouched |

The #4246 satellite passes — `ir/fnctor-receiver-provenance.ts`,
`ir/fnctor-local-bindings.ts`, `ir/fnctor-string-producers.ts` — have **no gate
of their own**. They are composed into the satellite evaluator by
`ir/fnctor-eval-extensions.ts` and are unreachable except through
`JS2WASM_FNCTOR_CTOR_PARAM_TYPES`, so that flag is what turns them on. Nothing
separate to flip.

### The one sub-lever DELIBERATELY EXCLUDED, and why

`inferFnctorFieldTypeFromCtorParam` types a field's physical slot from the
CONSTRUCTOR's write. Nothing in it consults writes that reach the field from
anywhere else, so a later store of another kind is silently lost:

```js
var A = function A(n) { this.tag = n; };
var a = new A(1);
a.tag = "s";
typeof a.tag === "string";   // 1 with the lever off  ·  0 with it on
```

Both arms have the hole, probed separately — the `this.f = <param>` arm and the
`this.f = this.<y>` field-fact arm. The field-fact arm was expected to be safe
(the satellite's field pass joins over reaching writes) and is not: it
enumerates `this.<f>` writes inside the owner's methods, and `a.mark = "s"`
through an instance BINDING is not in that set.

**The defect class is not new.** The identical wrong answer is reachable on
`main` today with every flag off whenever the constructor writes a literal
(`this.tag = 1` derives f64 and loses the later string write the same way).
What this lever changes is the POPULATION — it extends the hazard to
opaque-parameter constructor writes, which is the normal shape in real JS and
precisely the acorn case the lever was built for.

Against that: the slots it recovers measured **zero** value-level effect
(#4246 — `$AnyValue` 22,008 of 233,320 allocations per parse, identical
flag-on and flag-off) for +124 B. Enlarging a silent-wrong-answer class in
exchange for a measured null is a bad trade in the one direction that matters
(memory: *a bigger number bought with a silent wrong answer is negative value*),
so the DEFAULT stays sound and the lever is opt-in via
`JS2WASM_FNCTOR_CTOR_PARAM_SLOTS=1`.

**Unblocked by #4250** — the whole-program per-field write-kind verdict. That
issue records the mechanism sketch, the `main`-baseline repro, and the
acceptance criterion that flips this flag to the family's normal rule.

Consequence worth stating plainly: with the slot lever off, the satellite graph
has no consumer, so the #4246 passes do not execute on a default compile. The
derivation that IS live by default is the `new`-site parameter narrowing in
both inference lanes. "Derive types always" is satisfied for the parameter
half; the field half waits on #4250.

### Two defects the flip found (both fixed here)

Neither was visible while the flag was OFF, because nothing exercised the
combination. Both are in the excluded lever's path, and are fixed anyway so
that whoever turns it on — or lands #4250 — does not re-find them.

1. **Presence-tracked fields were narrowed to a machine slot.** A
   conditional-only field carries a `$$presence_0` bit and answers `undefined`
   through the read dispatcher, which only works while the slot keeps its
   externref carrier. Measured on
   `function T(k){ this.keyword=k; if(k>100){this.opt=k;} }`: `$opt` derived
   `(mut f64)` with the presence bit intact, and
   `this.type.opt === undefined ? -1 : this.type.opt` returned an opaque boxed
   object where the flag-off compile returned `-800`. The #3683 S4a numeric and
   #3753 S1 string promotions both already carve out `onlyConditional` fields;
   this adds the third carve-out. It has to be a REVERT after the constructor
   walk rather than a guard at the narrowing site, because presence-tracking is
   not decided when the field type is chosen.

2. **The narrowing fired in the JS-HOST lane**, where its trust argument ("the
   module owns every write") does not hold. `tests/issue-3683-numeric-fields.ts`
   states the rule in its own comment and pins it; the pin went red. Now gated
   to standalone, matching `numericPropertyNames` (standalone-only) and
   `fnctor-typed-bindings.ts` admission rule 1, and matching every measurement
   this pass has ever been given.

A third finding is an INSTRUMENT issue, recorded because it would mislead the
next reader: the #3683 S4a differential suite compiles its control lane with
`JS2WASM_NUMERIC_FIELDS=0` to reproduce pre-S4a field shapes, and #743's
narrowing reaches some of the same slots by a different proof. With it on, nine
pins failed on their BASELINE assertion — reading as "S4a broke" when S4a had
not moved. That suite now pins `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=0` in BOTH
lanes so it keeps measuring one variable.
