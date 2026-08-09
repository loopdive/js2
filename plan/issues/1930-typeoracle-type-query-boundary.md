---
id: 1930
title: "TypeOracle — one type-query boundary between the TS checker and codegen (unblocks TS7, kills suppression heuristics)"
status: ready
sprint: current
model: fable
fable_role: spec
created: 2026-06-10
updated: 2026-07-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
loc-budget-allow: [src/codegen/binary-ops.ts]
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

## Slice 2 progress — mechanical symbol-fold (dev-1930o, 2026-07-02)

**Shipped (PR branch `issue-1930-oracle-slice2`, stacked on Slice-1 #2517):**
the first tranche of the Slice-2 `type-mapper`-predicate fold — the 8 codegen
call sites that read a symbol type via
`isSymbolType(<checker>.getTypeAtLocation(x))` now call
`ctx.oracle.staticJsTypeOf(x) === "symbol"` (the Slice-1 pilot's pattern,
generalised):

- `binary-ops.ts` — to-numeric binary op, ×2 (`expr.left`/`expr.right`)
- `expressions/new-super.ts` — `new Number` / `new Boolean` of a symbol arg, ×2
- `expressions/calls.ts` — `Number(sym)`; native-strings `String(sym)`, ×2
- `expressions/builtins.ts` — `Math.*` numeric-arg symbol guard
- `expressions/unary-updates.ts` — `sym++` / prefix update

Ratchet: `getTypeAtLocation` 448→440, `ctx.checker` 843→835 (−8 each), banked
via `--update-on-decrease`. **Proof:** byte-diff-neutral on the #2138 corpus
(examples ×2 modes + STRIDE-50 test262 = 1102 compiles), SHA-identical
before/after; `tsc --noEmit` clean; scoped guards in
`tests/issue-1930-oracle-slice2.test.ts`.

**Why only symbol in this tranche (per-site divergence hazard — read before
extending the fold):** the 26 `type-mapper` predicates are NOT all 1:1 with a
v1 oracle query, so this is a per-predicate fold, not a blanket one:

- `isStringType` ALSO matches the `String` **wrapper object** (`new String()`),
  which the oracle classifies as `{kind:"builtin", name:"String"}` → jsTag
  `"object"`; so `staticJsTypeOf(x) === "string"` is NOT equivalent. EXCLUDED
  until a wrapper-aware query/composition exists.
- `isBooleanType` diverges on a collapsed `true|false` union (the oracle folds
  it to `boolean`); safe only where the site provably never sees that union.
- `getNullablePrimitiveInfo` also needs `primitiveKind` — richer than v1's
  `nullabilityOf`; deferred to Slice 4 (wants a `nullablePrimitiveOf` query).

`isSymbolType` has no wrapper/union complication → provably equivalent, hence
the safe first tranche. (Note: the Slice-1 pilot comment in `unary.ts` still
contains the literal `…getTypeAtLocation(operand)` string, so it is still
counted by the ratchet regex; a trivial reword there would bank 1 more −1 each.)

## Reserved-judgment determination (dev-1930o, 2026-07-02)

Per the senior-dev scoping split: the **five divergent i32/boolean-safety
matchers (Slice 3)** require deciding WHICH i32-safety semantics is correct at
each divergence — a value-judgment reserved for the frontier model. I checked
this file for a recorded **divergence-verdict table** (each divergence resolved
with a decision): **ABSENT.** The design (the i32/boolean-safety-matchers ¶,
D4.1, D5 Slice 3) only _names_ the matchers and flags the open question
(whether the #1179 ToInt32-context and #2789 pack-safety questions are
reconcilable under one predicate). I therefore did the mechanical slices only
and did NOT invent the verdicts. Slice 3 is separately in-flight on branch
`issue-1930-slice3-i32-matchers` (the reserved lane) — left to that owner.

## Implementation Plan (Fable, 2026-07-18) — Slice-3 salvage (live miscompile on main) + remaining sequencing

### 1. URGENT salvage: the Slice-3 verdict work is DONE but STRANDED, and it contains a live-miscompile fix

The reserved lane completed: `upstream/issue-1930-slice3-i32-matchers` @
`724c272065` (2026-07-02) carries the full three-question doctrine, the
V1–V8 divergence-verdict table, the **V1 −0 miscompile fix**, the
`isSyntacticallyBooleanExpr` Q-TAG spine extraction, and 130 lines of guard
tests. It was **never merged and has no open PR** — stranded 16 days.

**Verified TODAY on current main: the V1 miscompile is still live.**
`isI32SafeExpr` (`src/codegen/function-body.ts:442`) still accepts unary
`-x` for any i32-safe operand (`:453–456`), so
`let x = 0; let y = -x; Object.is(y, -0)` returns `false` (spec: `true`) —
the #2789 −0 fix was propagated to the array matcher but never to the scalar
sibling. This is a silent wrong-value bug on main, not a refactor nicety.

**Salvage protocol (Opus, M):** do NOT merge or re-push the stale branch —
a 16-day-old branch merged into today's main can silently revert landed work
(established lesson). Instead: fresh branch from `upstream/main`; port the
additions from `git diff 3ef85411a7..724c272065` (files:
`function-body.ts`, `array-element-typing.ts`, `binary-ops.ts`,
`declarations.ts`, `shared.ts`, `src/checker/oracle.ts`,
`tests/issue-1930-i32-safety.test.ts`, the issue-file section); re-ground
every anchor (oracle.ts and declarations.ts have grown since 07-02 — the
kernel-fixpoint delegation must be re-diffed against the current `#2795`
lineage); re-run the byte-diff proof and the live probe. Land the V1 fix
even if the spine extraction needs rework — they are separable; V1 alone is
an S.

### 2. The three-question doctrine + verdict table (recorded on main; reviewed and ADOPTED)

The stranded branch's doctrine, reviewed against current source and adopted
by this plan as the authoritative Slice-3 spec. The i32-safety matchers
answer **three genuinely different questions that must never merge**:

- **Q-CANON** — "is this VALUE a canonical int32 (no −0, no overflow
  saturation, no uint32 reinterpretation)?" Two siblings:
  `isI32SafeExprForArray` (`array-element-typing.ts`, #2789) and
  `isI32SafeExpr` (`function-body.ts:442`, #1236). Codegen-state-coupled
  (i32-local sets) ⇒ **NOT an oracle query** (Constraint A).
- **Q-WRAP** — "may this be evaluated in i32 bit-identically to
  ToInt32(spec value), GIVEN an enclosing ToInt32 context?"
  `isI32PureExpr`/`isI32MulSafe` (`binary-ops.ts`, #1179).
  Codegen-state-coupled ⇒ NOT an oracle query.
- **Q-TAG** — "what JS tag does this statically produce?" Checker lane =
  oracle (`isBooleanProducing`/`typeFactOf`/`isStrictBooleanReturnType`);
  syntactic lane = `isSyntacticallyBooleanExpr` + `isNumericExpr`.

Why one predicate is impossible: `a + b` of two i32 locals is Q-WRAP-safe
(wrap ≡ ToInt32) but Q-CANON-unsafe (`i32.trunc_sat_f64_s` saturates);
`x >>> 1` is Q-WRAP-safe but value-divergent above 2^31.

| #      | Divergence                                                                  | Verdict                                                                            | Action                                                                                  |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **V1** | unary `-x`: array Q-CANON rejects (#2789 −0), scalar accepted               | scalar matcher WRONG — live silent miscompile (re-verified 2026-07-18)             | fix via salvage §1 (minus admits only `-<non-zero int literal>`; demotion-only ⇒ sound) |
| **V2** | `a + b`/`a - b`: Q-WRAP accepts, Q-CANON rejects                            | both correct — different questions                                                 | doctrine cross-refs at both sites; never copy arms                                      |
| **V3** | `x >>> y`: Q-WRAP accepts, both Q-CANON exclude                             | both correct                                                                       | doctrine cross-refs                                                                     |
| **V4** | equality ops: array Q-CANON accepts (0/1 canonical), scalar only relational | scalar conservatively incomplete, not wrong (only demotes)                         | documented; alignment = separate optimization slice with proof burden                   |
| **V5** | `!x`/`instanceof`/`in`: Q-TAG yes, Q-CANON no arms                          | conservative gap, not wrong                                                        | documented; promotion = future optimization                                             |
| **V6** | Q-TAG checker vs syntactic lane on `: boolean`-typed identifier             | both stay, separately — merging changes kernel return-type inference (#2795/#2770) | deliberate siblings, documented                                                         |
| **V7** | `isStrictBooleanReturnType` (shared.ts) vs oracle boolean fact              | semantically identical; duplicated only by raw-`ts.Type` plumbing                  | migrate in Slice-4 `signatureOf` bucket (six `brandExternMethodResult` sites)           |
| **V8** | `isNumericExpr` treats booleans as numeric                                  | intentional layering (representability, not tag)                                   | documented; spine extraction mirrors the boolean one                                    |

**One correction to the frozen design (D4.1):** "the five divergent matchers
die into `isBooleanProducing`/`staticJsTypeOf`" is wrong as written — only
the **Q-TAG** lane unifies into the oracle. Q-CANON and Q-WRAP are
Constraint-A-excluded (registry/codegen-state-coupled) and permanently stay
codegen-local; their end state is _doctrine cross-references + aligned
semantics + (optionally) one parameterized `isCanonicalI32Expr(expr, opts)`
for the two Q-CANON siblings_ — pure code motion once V1 lands, with the V4
conservatism table as the parity spec.

### 3. Remaining slice sequencing (current ratchet: 454 `getTypeAtLocation` / 853 `ctx.checker.` across 53 files; gate is change-scoped net-per-field since #3273)

1. **Slice-3 salvage** (§1, M) — the only slice with a correctness payload;
   first.
2. **Slice 2 continuation** (mechanical, Opus, per-predicate fold) — largest
   files first (`expressions/calls.ts`, `index.ts`, `declarations.ts`).
   Honor the recorded per-predicate hazards: `isStringType` (String-wrapper
   divergence — excluded until a wrapper-aware query exists),
   `isBooleanType` (collapsed `true|false` union), `getNullablePrimitiveInfo`
   (needs a richer `nullablePrimitiveOf`, Slice 4). Byte-diff-neutral proof
   per tranche (the Slice-2 standard above).
3. **Slice 4** — signature/property/element/contextual buckets; includes the
   V7 migration.
4. **Slice 5** — `typeKeyOf` (`anonTypeMap` + `objectHashConsumerTypes` off
   raw `ts.Type` keys; interning contract preserves identity).
5. **Slice 6** — #2135 resolvability-leg adoption (their lane).
6. **Slice 7** — nullable-primitive lowering + `compiler.ts` suppression
   deletion; still gated on #1852 alignment; LAST.

## Slice-3 salvage LANDED (opus-dev-a, 2026-07-18)

The reserved Slice-3 lane (`issue-1930-slice3-i32-matchers` @ `724c272065`,
2026-07-02) sat stranded 16 days with no PR. Its central payload was a **live
silent miscompile on main**: the scalar Q-CANON matcher `isI32SafeExpr`
(`function-body.ts`) still accepted unary `-x` for any i32-safe operand, so
`let x = 0; let y = -x; Object.is(y, -0)` returned `false` (spec `true`) — the
#2789 −0 fix reached the array sibling but never the scalar one. Re-verified
live on current main before the fix.

Per the silent-revert hazard the stale branch was NOT merged. The additions
were **extracted onto a fresh branch off `upstream/main`** and re-grounded
against drift (the `isBooleanExpr` closure had moved from `declarations.ts` to
`declarations/param-return-inference.ts`; the `array-element-typing.ts` header
had already absorbed the #2789 wording). Ported verbatim:

- **V1 fix** (`function-body.ts`): unary `-` now admits ONLY
  `-<non-zero integer literal>` (a `-1`-style sentinel, no −0 hazard). Strict
  subset of prior acceptance ⇒ demotion-only ⇒ sound, matching #1236/#2789.
- **Q-TAG spine extraction**: `isSyntacticallyBooleanExpr` defined ONCE in
  `src/checker/oracle.ts` (Constraint-A-clean — the kernel-fixpoint's evolving
  candidate set is an explicit hook parameter); the #2795 `isBooleanExpr`
  kernel closure delegates with a verbatim-identical accept-set.
- **Doctrine cross-references** at every matcher site (Q-CANON in
  `array-element-typing.ts`, Q-WRAP in `binary-ops.ts`, Q-TAG in `shared.ts`)
  forbidding cross-question arm copying (verdicts V2/V3/V7).
- Guards: `tests/issue-1930-i32-safety.test.ts` (V1 both shapes + sentinel
  non-demotion + #2795 branding + spine spot-checks).

No `oracle_version` bump: this is a codegen fix, not a test262 verdict-logic
change — `check-verdict-oracle-bump` gates only the harness scorer files.
The V1 fix and the spine extraction are separable; both landed together here.
The remaining oracle slices (2, 4–7) and the Q-CANON structural merge are
unchanged follow-ups.

**loc-budget note**: the Q-WRAP doctrine comment adds +11 LOC to the god-file
`binary-ops.ts` (2815→2826). This is intended, load-bearing documentation (the
cross-reference that prevents the next dev from copy-pasting a Q-WRAP arm into a
Q-CANON matcher — the exact V1 bug class), so it is granted the change-scoped
`loc-budget-allow` frontmatter entry on this issue file.

## Review (Fable, 2026-07-24)

**The Slice-3 V1 scalar `-0` miscompile is FIXED on main — verified
empirically.** The minus-arm of `isI32SafeExpr`
(`src/codegen/function-body.ts:458-473`) now admits only
`-<non-zero integer literal>`, mirroring the #2789 array-lane fix; landed in
`20569059b` ("fix(#1930): Slice 3 salvage — V1 scalar -0 miscompile fix +
boolean spine extraction", 2026-07-18), an ancestor of main tip `7652f0337`.
Probe re-run 2026-07-24 (`.tmp/probe-1930-neg-zero.mts`, not committed):
`let y = -x; return 1/y` with `x=0` returns `-Infinity` (i.e. `-0`
preserved, `Object.is(-x, -0)` correct).

Housekeeping: the stranded branch `upstream/issue-1930-slice3-i32-matchers`
(tip `793c2260`, contains `724c272065`) still exists and still diverges from
main by ~1.4K inserted lines (i32-safety doctrine tests, oracle tests, a
declarations.ts refactor). The miscompile fix itself is fully salvaged; the
residue needs a deliberate extract-onto-fresh-branch-or-discard decision by
this issue's owner. Do NOT merge the stale branch as-is. The TypeOracle
epic scope above remains open and unaffected.
