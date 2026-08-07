---
id: 743
title: "Whole-program type flow analysis"
status: ready
created: 2026-03-22
updated: 2026-08-06
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
