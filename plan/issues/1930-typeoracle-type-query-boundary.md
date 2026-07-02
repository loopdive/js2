---
id: 1930
title: "TypeOracle — one type-query boundary between the TS checker and codegen (unblocks TS7, kills suppression heuristics)"
status: in-progress
assignee: ttraenkler/dev-2937f
sprint: current
model: fable
created: 2026-06-10
updated: 2026-07-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
---

> **Unblocked 2026-07-02**: `blocked_by: [2167]` removed — #2167 (Fable model
> disabled) is `done`; the Fable lane is live and this design is executing on it.

# #1930 — TypeOracle: one type-query boundary

## Problem

There is no abstraction between the TypeScript checker and codegen:

- **~397 `getTypeAtLocation` call sites** across 20+ codegen files thread a
  live `ts.TypeChecker` and raw `ts.Type` objects everywhere. The only
  firewalls are the small `ValType` mapper (`checker/type-mapper.ts:38`) and
  the partial IR `TypeMap`.
- This **forecloses the project's own TS7 plan**: typescript-native-preview
  has no JS-API TypeChecker; the shim already throws under `--ts7`
  (`src/ts-api.ts:114-131`, #1029). Migration today would be a rewrite.
- Type knowledge is fragmented across **four** uncoordinated mechanisms: the
  TS checker, the IR lattice (`ir/propagate.ts:220`), `shape-inference.ts`,
  and import-resolver's syntactic `any` stubs.
- The `number|null` → bare `f64` lowering spawned ~300 lines of heuristics
  (`compiler.ts:98-391`) that _suppress the checker's own correct
  diagnostics_, recognizing only direct `!== null` if-guards — suppression
  is inconsistent, and `compiler.ts:387-390` reaches into the unsupported
  internal `isTypeAssignableTo` API.

## Proposed approach

Architect spec first; then mechanical migration:

1. Define `TypeOracle` — the closed set of queries codegen actually needs
   (survey the 397 sites; expect ~15 query kinds: valTypeOf(node),
   isNullable, callSignatureOf, elementTypeOf, propertyTypeOf, …) returning
   **compiler-owned types** (ValType/IrType-level), never `ts.Type`.
2. Implement `TsCheckerOracle` (today's behavior) behind it; migrate codegen
   sites file-by-file with a grep ratchet on `getTypeAtLocation`
   (same mechanics as the #1095 cast budget).
3. Fold nullable-primitive handling into the lowering (branded externref or
   (i32-flag, f64) pair — coordinate with #1852's per-backend value
   representation), then delete the suppression heuristics in
   `compiler.ts:98-391`.
4. Later backends: TS7 LSP-based oracle; IR TypeMap as a refinement layer.

## Acceptance criteria

- Ratchet file counts direct checker access in `src/codegen/`; CI fails on
  growth; trend to zero.
- The suppression-heuristic block is deleted; `number|null` programs compile
  with correct semantics (tests).
- A `--ts7` smoke path can construct the oracle without `createProgram`.

## Source

Compiler quality review 2026-06. Related: #1029 (TS7), #1852, #1948 (numeric
lattice consumes the oracle). Needs `/architect-spec`.

## Amendment (2026-06-11, analysis program)

Define a **thin first slice as the boxing prerequisite** (report 05 §5):
the value-representation work (#2072/#2080 P0, #2104 JsTag module) needs
only a small TypeOracle facade — ONE CodegenContext field exposing 3–4
queries (staticJsTypeOf(expr), isBooleanProducing(expr), union parts) —
not the full decomposition. CodegenContext is now measured at ~190 fields
/ 445 mutation sites (grown past the review's count); the full
decomposition is sprint-64+ scale and blocks nothing if the thin slice
lands first. Sequence: thin slice in sprint 62 alongside boxing P0; full
boundary later.

## Design (2026-07-02, dev-2937f — the authoritative spec for this issue)

Measured on `origin/main` at design time (full categorization by the
oracle-survey pass, 2026-07-02): **51 files** in `src/codegen/` use the
checker directly, **~869** total checker/type-method calls, **446**
`getTypeAtLocation` (51% of all queries — THE query). Concentration:
`expressions/calls.ts` 62 · `index.ts` 54 · `declarations.ts` 52 ·
`property-access.ts` 28 · `literals.ts` 27 · `new-super.ts` 23 ·
`assignment.ts` 21.

**Survey record (bucket → count):**

| Intent bucket                            | Count                                                                                                                    | Notes                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| valTypeOf                                | 446 raw `getTypeAtLocation` → 300 `resolveWasmType` + 28 `mapTsTypeToWasm` downstream                                    | only 22 inline compositions; **assign-then-multi-use dominates** — one query result feeds several intents, so `typeFactOf` must return a fact rich enough for all of them (drives the TypeFact shape below) |
| nullable/union inspection                | ~299 `.flags &` (Null 34 / Undefined 43 / Void 40) + 15 `.isUnion()` + 14 `getNonNullableType`                           | post-query reads on the bound local                                                                                                                                                                         |
| call signature                           | 169 (`getReturnTypeOfSignature` 65, `getCallSignatures` 49, `getResolvedSignature` 28, `getSignatureFromDeclaration` 25) |                                                                                                                                                                                                             |
| symbol resolution (name/decl — NOT type) | 159 (`getSymbolAtLocation` 156)                                                                                          | excluded from type-ratchet v1 (name resolution)                                                                                                                                                             |
| element/type-args                        | 24 `getTypeArguments`                                                                                                    |                                                                                                                                                                                                             |
| property type                            | 21 (`getTypeOfSymbol` 16, `getTypeOfSymbolAtLocation` 5)                                                                 |                                                                                                                                                                                                             |
| contextual type                          | 18 `getContextualType`                                                                                                   |                                                                                                                                                                                                             |
| apparent/index-sig                       | 13                                                                                                                       |                                                                                                                                                                                                             |
| ts.Type-as-Map-key                       | ~12 (`anonTypeMap` set/get)                                                                                              | Slice 5                                                                                                                                                                                                     |
| typeToString                             | 4                                                                                                                        | diagnostics                                                                                                                                                                                                 |
| isTypeAssignableTo                       | **0 in codegen**                                                                                                         | lives only in `compiler.ts` suppression                                                                                                                                                                     |

**i32/boolean-safety matchers — FIVE divergent + 1 type-based, none share a
predicate** (Slice 3 kill list): `isI32SafeExprForArray`
(`array-element-typing.ts:58`, miscompile-strict #2789), `isI32PureExpr` +
`isI32MulSafe` (`binary-ops.ts:1682/:1671`, ToInt32-context #1179),
`isBooleanExpr` (`declarations.ts:2160`, kernel fixpoint #2795),
`isNumericExpr` (`declarations.ts:1951`), `resultIsI32` (`binary-ops.ts:3124`,
op-kind table), `isStrictBooleanReturnType` (`shared.ts:435`, ts.Type-based).
Four are pure syntax walks that never touch the checker — first unification
target.

**Three fronted surfaces** (not one): (a) the 51 codegen files; (b)
`src/checker/type-mapper.ts` — NOT small: **26 exports** forming a parallel
predicate surface (`isNumberType/isStringType/isSymbolType/
getNullablePrimitiveInfo/…`) that folds into the oracle in Slice 2; (c)
`src/compiler.ts` `number|null` suppression — actual range **~117–461**
(wider than the review's 98–391), an ~18-function flow-narrowing engine and
a checker consumer OUTSIDE `src/codegen/` (Slice 7, needs #1852).

Four uncoordinated type-knowledge mechanisms confirmed live: checker-direct
(all 51 files), IR lattice (`ir/propagate.ts:220 buildTypeMap`, consumed
only by IR selector + lowerer), `shape-inference.ts:33 collectShapes`
(consumed by ONE file: `declarations.ts`), import-resolver `any`-stubs
(`import-resolver.ts:626`, pre-checker). `--ts7` shim throws at
`ts-api.ts:114–131`.

### Agreed seams (recorded verbatim decisions, 2026-07-02)

Three single-source efforts converge on the IR boundary. Seams were agreed
by name with both owners BEFORE this design froze:

- **#2134 effect model (dev-2912f, ACKED)**: effects table keyed strictly on
  `IrInstr` kind, lives at `src/ir/effects.ts` as a dependency-free leaf,
  needs zero type facts, imports nothing from `src/checker/`. If an
  emission/reorder decision ever needs a type-ish fact it reads the IrType
  resolved at from-ast time (oracle-produced); no new local matchers.
- **#2135/#2138 capability predicate (dev-2138f, ACKED with two constraints
  that SHAPE this design)**:
  - **Constraint A (purity of inputs)**: oracle answers MUST be pure
    functions of `(checker, AST node)` — NEVER of `ctx.mod`,
    `ctx.structFields`, or any codegen registry. Proven need: under
    `JS2WASM_IR_FIRST` the planning block MOVES (before vs after
    `compileDeclarations`) and `ctx.structFields` mutates during body
    compilation, so a registry-dependent "oracle" would answer differently
    at the two pipeline positions. Registry-dependent knowledge (class
    shapes, vec typeIdx) is NOT an oracle query.
  - **Constraint B (query-only)**: no side effects. Today
    `resolveWasmType`-family "resolution" REGISTERS Wasm types
    (`getOrRegisterVecType`, `ensureStructForType`) as a side effect. The
    oracle returns the type FACT; the CALLER registers. Absorbing
    registration would smuggle mutable-state dependence back in.
  - The capability predicate's type-resolvability legs
    (`param-type-not-resolvable` / `return-type-not-resolvable` /
    `type-resolution-failure`) will consume the oracle once the facade
    lands, retiring the `select.ts resolveParamType` vs
    `codegen/index.ts resolvePositionType` drift.
  - Ratchet coordination: dev-2138f's in-flight #2972 adds ONE
    `getTypeAtLocation` site in `src/codegen/declarations.ts` — the seeded
    baseline carries a +1 pre-authorization for it (see Slice 1).

### D1 — the fact vocabulary is registry-free (`TypeFact`, not `ValType`)

Constraint A forces the central design decision: **`ValType` itself is
registry-coupled** (`{kind:"ref", typeIdx}` indexes `ctx.mod.types`). The
oracle therefore speaks a NEW compiler-owned fact language, `TypeFact`,
strictly ABOVE `ValType` — primitives (number/boolean/string/bigint/symbol/
undefined/null/void), `array(element)`, `tuple(elements)`,
`function(signature)`, `class(name)`, `builtin(name)`, `object(shape)`,
`union(parts, nullable, undefinable)`, `any`/`unknown`, and
`unresolvable` (the #2135 resolvability signal). See
`src/checker/oracle.ts` for the authoritative definition.

The existing `mapTsTypeToWasm` (`src/checker/type-mapper.ts`) is ALREADY
nearly pure (flags → ValType) — it becomes the internal flag-classifier the
`TsCheckerOracle` uses to produce primitive facts. A codegen-side adapter
(Slice 2: `src/codegen/oracle-adapter.ts`) maps `TypeFact → ValType`,
performing registration (`ensureStructForType`, `getOrRegisterVecType`) in
the CODEGEN lane where mutation belongs. Split = query (checker-side,
memoizable, position-independent) / registration (codegen-side, ordered,
mutating).

### D2 — query-only, memoized, constructible without `createProgram`

`TsCheckerOracle` wraps the checker; per-node `WeakMap` memo caches (the
"gathered four times" perf theme dies here — identical answers at any
pipeline position are a FEATURE under #2138's IR-first hoist). Constructor
takes the checker interface only — the future `LspOracle` (TS7, `--ts7`
acceptance) constructs from `src/checker/language-service.ts` without
`createProgram`. `ts.Type` never appears in a parameter or return type of
the public surface.

### D3 — the frozen query surface (v1)

| Query                                            | Replaces (bucket)                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `typeFactOf(node): TypeFact`                     | the valTypeOf majority (446 sites, via the adapter)                                                       |
| `staticJsTypeOf(expr): JsTag \| "mixed"`         | the thin boxing-slice query (amendment); JsTag per #2104                                                  |
| `isBooleanProducing(expr): boolean`              | the five divergent boolean/i32 matchers (Slice 3 deepens with the kernel analysis)                        |
| `nullabilityOf(node): { nullable; undefinable }` | ~299 union-flags inspection reads                                                                         |
| `unionPartsOf(node): TypeFact[] \| undefined`    | `.isUnion()` walkers                                                                                      |
| `signatureOf(node): SignatureFact \| undefined`  | the 169 signature sites                                                                                   |
| `propertyFactOf(node, name): TypeFact`           | `getTypeOfSymbol` chains                                                                                  |
| `elementFactOf(node): TypeFact`                  | array/tuple element resolution                                                                            |
| `contextualFactOf(expr): TypeFact \| undefined`  | 18 `getContextualType` sites                                                                              |
| `builtinReceiverOf(node): string \| undefined`   | nominal-symbol gates (`symName !== "Date"`-class; the #2767 bare-`var` receiver family standardizes here) |
| `typeKeyOf(node): OracleTypeKey`                 | `ts.Type`-as-Map-key identity uses (`anonTypeMap`, `objectHashConsumerTypes`) — opaque interned token     |
| `declaredNameOf(node): string \| undefined`      | the type-NAME subset of symbol lookups                                                                    |

**Explicitly OUT of the oracle** (agreed seams): capability/claimability
(#2135), effect classification (#2134), anything registry-dependent
(Constraint A), and pure SYMBOL/BINDING resolution (159 `getSymbolAtLocation`
sites — name resolution, not type knowledge; stays on the checker, not
counted by type-ratchet v1).

### D4 — what dies (end state)

1. The five-plus divergent i32/boolean-safety matchers →
   `isBooleanProducing` / `staticJsTypeOf` (one definition, one brand
   decision).
2. Raw `ts.Type`/checker threading in `src/codegen/` → 0 via ratchet
   (seed: 448 `getTypeAtLocation` / 843 `ctx.checker.` across 53 files —
   post-#2495/#2510 counts, slightly above the survey's origin/main
   numbers).
3. `ts.Type`-keyed maps → `OracleTypeKey`-keyed (note: the #2937
   `objectHashConsumerTypes` poison is type-identity-keyed — migrates with
   `anonTypeMap` in Slice 5, identity semantics preserved by the token's
   interning contract).
4. The `number|null` suppression engine in `compiler.ts` (~117–461, incl.
   the internal `isTypeAssignableTo`) — LAST, after nullable lowering lands
   (coordinate #1852); it is OUTSIDE the v1 ratchet scope and gets its own
   ratchet entry when Slice 7 starts.
5. The `--ts7` shim throw (`src/ts-api.ts:114–131`) for the oracle-covered
   surface.
6. `type-mapper.ts`'s 26-export parallel predicate surface — folds into
   oracle queries (Slice 2), leaving `mapTsTypeToWasm` as the oracle's
   internal classifier.

### D5 — migration order (staged slices, each with per-slice proof)

Proof standard per slice (the #2976 standard): byte-diff neutrality on a
no-affected-construct corpus (sha256), scoped vitest guards, ratchet
decrease recorded, no test262 regressions via PR CI.

- **Slice 1 (THIS PR)**: `src/checker/oracle.ts` (TypeFact + TypeOracle +
  TsCheckerOracle) · `ctx.oracle` field · `scripts/check-oracle-ratchet.mjs`
  - `pnpm run check:oracle-ratchet` wired into `quality` (per-file counts of
    `getTypeAtLocation` + `ctx.checker.` under `src/codegen/`; baseline JSON;
    growth fails; `--update-on-decrease` banks improvements — mechanics from
    `check:ir-fallbacks` #2855) · ONE pilot migration (`expressions/unary.ts`
    Symbol→number guard, byte-diff-verified neutral) · baseline carries a +1
    pre-authorization for #2972's declarations.ts site.
- **Slice 2**: the `typeFactOf` mechanical bucket + the codegen adapter,
  file-by-file, largest first (`expressions/calls.ts` 62, `index.ts` 54,
  `declarations.ts` 52); fold type-mapper predicates.
- **Slice 3**: boolean/i32 matcher consolidation (`isBooleanProducing` +
  a `toInt32SafetyOf` refinement if the #1179/#2789 contexts prove
  irreconcilable under one predicate — they encode DIFFERENT questions:
  pack-safety vs ToInt32-context cheapness; the oracle may need both,
  but defined ONCE each).
- **Slice 4**: signatures/properties/elements/contextual buckets.
- **Slice 5**: `typeKeyOf` — `anonTypeMap` + `objectHashConsumerTypes` off
  `ts.Type` keys.
- **Slice 6**: #2135 adoption (dev-2138f's lane, their PR): resolvability
  legs consume `typeFactOf(...).kind === "unresolvable"`.
- **Slice 7**: nullable-primitive lowering + `compiler.ts` suppression
  deletion (needs #1852 alignment) · `LspOracle` for `--ts7` smoke.

### D6 — ratchet mechanics

`scripts/oracle-ratchet-baseline.json`: `{ files: { file: {
getTypeAtLocation, ctxChecker } }, preauthorized: [ { file, field, extra,
reason } ] }`. CI (in `quality`) fails when any file's count exceeds
baseline+preauth; `--update-on-decrease` banks lower counts;
`--update` reseeds wholesale (intentional changes only, with a written
reason). Seeded with a +1 pre-authorization for #2972
(declarations.ts, agreed with dev-2138f 2026-07-02).

## Slice 3 (2026-07-02, dev-2937f) — i32-safety matcher unification: the three-question doctrine + divergence verdicts

Full-body analysis of every matcher (including a SEVENTH the survey missed:
`isI32SafeExpr` in `function-body.ts:448` — the scalar-local Q-CANON sibling
that `isI32SafeExprForArray`'s own header says it "mirrors"). The matchers
resolve into **three genuinely different questions** that MUST NOT merge into
one predicate:

- **Q-CANON** — "is this VALUE a canonical int32 (no observable i32↔f64
  divergence — no −0, no overflow, no uint32 reinterpretation)?" Two
  implementations: `isI32SafeExprForArray` (array packing, #2789) and
  `isI32SafeExpr` (scalar-local promotion, #1236). Codegen-state-coupled
  (i32-local sets) → NOT an oracle query (Constraint A); doctrine home is
  the array matcher's header.
- **Q-WRAP** — "may this be EVALUATED in i32 such that the result is
  bit-identical to ToInt32(spec value), GIVEN an enclosing ToInt32
  (bitwise/`|0`) context?" One implementation: `isI32PureExpr` +
  `isI32MulSafe` (binary-ops.ts, #1179). Codegen-state-coupled (i32 locals,
  #2682 loop proofs) → NOT an oracle query.
- **Q-TAG** — "what JS tag does this statically produce?" Checker lane:
  oracle `typeFactOf`/`isBooleanProducing`/`isStrictBooleanReturnType`;
  syntactic lane: `isSyntacticallyBooleanExpr` (NOW defined once in
  `src/checker/oracle.ts`, extracted from the `declarations.ts` kernel
  fixpoint) + `isNumericExpr` (representability variant, packaged below).

**Why one predicate is impossible** (the audit's implicit assumption was
wrong): `a + b` of two i32 locals is Q-WRAP-safe (f64 add exact ≤ 2^32; wrap
≡ ToInt32) but Q-CANON-UNSAFE (`i32.trunc_sat_f64_s` saturates on overflow —
the #1236/#2789 miscompile class). `x >>> 1` is Q-WRAP-safe (bits identical
under ToInt32) but Q-CANON-unsafe (value above 2^31 reinterprets negative).

### Divergence-verdict table

| #      | Divergence (same expression, different answers)                                                                                                            | Verdict                                                                                                                                                                                                 | Action                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1** | Unary `-x` (non-literal operand): array Q-CANON **rejects** (#2789, −0 hazard); scalar Q-CANON **accepted** — violating its own header contract ("not −0") | **Scalar matcher was WRONG — latent silent miscompile.** Probed live on main: `let x = 0; let y = -x; Object.is(y, -0)` → `false` (spec: `true`); the #2789 fix was never propagated to the scalar lane | **FIXED this slice** (`function-body.ts` minus-arm now admits only `-<non-zero int literal>`, verbatim #2789 semantics; demotion-only ⇒ sound). Probe flips to spec. Guard: `tests/issue-1930-i32-safety.test.ts` |
| **V2** | `a + b` / `a - b`: Q-WRAP accepts, Q-CANON rejects                                                                                                         | **Both correct** — different questions (wrap-equivalence vs canonicality; saturation only bites Q-CANON)                                                                                                | Doctrine cross-refs at both sites; never copy arms                                                                                                                                                                |
| **V3** | `x >>> y`: Q-WRAP (`isBitwiseOpKind`) accepts, both Q-CANON matchers exclude                                                                               | **Both correct** — bits ToInt32-identical under the guaranteed parent; value diverges without it                                                                                                        | Doctrine cross-refs                                                                                                                                                                                               |
| **V4** | Equality ops (`== === != !==`): array Q-CANON accepts (boolean 0/1 is canonical); scalar Q-CANON accepts only relational `< <= > >=`                       | **Scalar is conservatively incomplete, not wrong** (only demotes). Aligning would PROMOTE more locals — an optimization with its own proof burden                                                       | Documented; NOT changed this slice (behavior-neutral conservatism kept)                                                                                                                                           |
| **V5** | `!x` / `x instanceof y` / `x in y`: Q-TAG boolean says yes; neither Q-CANON matcher has arms for them                                                      | **Conservative gap, not wrong** (boolean IS canonical i32; arrays/locals holding them demote to f64 today)                                                                                              | Documented; promotion = future optimization slice                                                                                                                                                                 |
| **V6** | Q-TAG checker lane vs syntactic lane: a `: boolean`-typed identifier read is boolean per checker, rejected by the syntactic spine                          | **Both stay, separately** — merging would newly brand kernel returns (behavior change in return-type inference, #2795/#2770 lineage) and needs its own measured slice                                   | `isBooleanProducing` (checker) and `isSyntacticallyBooleanExpr` (syntactic) documented as deliberate siblings                                                                                                     |
| **V7** | `isStrictBooleanReturnType` (shared.ts) vs oracle boolean fact                                                                                             | **Semantically identical** (same flag test incl. strict union rejection) — duplicated only because callers hold raw `ts.Type` from signature plumbing                                                   | Cross-ref locked; migration = Slice-4 `signatureOf` bucket (six `brandExternMethodResult` call sites)                                                                                                             |
| **V8** | `isNumericExpr` treats `true`/`false`/`!x` as "numeric"                                                                                                    | **Intentional layering, not a divergence**: it answers REPRESENTABILITY in the numeric lanes (kernel return inference), not tag. Boolean ⊂ numeric-representable by design                              | Documented; its spine extraction mirrors the boolean one (mechanical, packaged)                                                                                                                                   |

### Shipped this slice

1. **V1 fix** — the scalar −0 miscompile (`function-body.ts`), probed
   end-to-end (`Object.is(-x, -0)` now spec-correct).
2. **`isSyntacticallyBooleanExpr`** — the Q-TAG syntactic boolean spine
   defined ONCE in `src/checker/oracle.ts`; the `declarations.ts` kernel
   fixpoint delegates with its live candidate-set hook (accept-set
   verbatim-identical; byte-diff-verified).
3. **Doctrine cross-references** at all sites (array-element-typing,
   function-body via V1 comment, binary-ops, shared.ts) naming the question
   each matcher answers and forbidding cross-question arm copying.

### Packaged as mechanical follow-ups (NOT this slice — Opus-lane per doctrine)

- `isNumericExpr` spine extraction (mirror of the boolean spine; same hook
  pattern, larger arm set).
- V7 migration: the six `brandExternMethodResult` sites onto
  `oracle.signatureOf` (Slice-4 signature bucket).
- Optional structural merge of the two Q-CANON implementations into one
  parameterized `isCanonicalI32Expr(expr, opts)` — semantics are now
  ALIGNED (post-V1) and documented; the merge is pure code motion with the
  V4 conservatism table as the parity spec.
- V4/V5 promotions (equality/boolean forms into Q-CANON) — optimization
  slices with their own measurement obligations.
