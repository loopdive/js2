---
id: 3182
title: "Code-bloat elimination EPIC: consolidate duplicated codegen scaffolding into the existing shared machinery"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
model: fable
horizon: xl
reasoning_effort: high
task_type: epic
area: codegen
goal: maintainability
sprint: current
related: [742, 808, 869, 1849, 2141, 2855, 3029, 3090, 3098, 3102, 3107, 3109]
subsumes: [1849]
---

# #3182 — Code-bloat elimination EPIC

## Scope boundary (read first)

Three bloat axes already have owners — this epic does NOT overlap them:

- **#3090** deletes the dormant **legacy direct-codegen front-end** the IR
  supersedes (~40–55K LOC, gated). This epic targets duplication inside the
  code #3090's audit classifies as **STAYS/RUNTIME** — the substrate and
  stdlib-emission modules that survive the front-end retirement.
- **#2855/#2856-#2859** retire the IR fallback buckets (front-end axis).
- **#742/#808** continue the god-file *extraction* series (moving code).
  This epic is about *deleting* copies, not relocating them.

Umbrella: #3029 (clean-compiler-architecture). LOC-regrowth ratchet: #3102.

Every slice below carries the same hard acceptance criterion:
**no behavior change — zero test-diff** (equivalence suite byte-stable where
feasible; test262 CI delta must be exactly 0 regressions / 0 progressions
attributable to the slice). A consolidation that "fixes" behavior en passant
is out of scope for that slice — file a separate issue.

All `file:line` anchors below were verified against `origin/main`
on 2026-07-12 (branch `plan-bloat-elimination-fable`).

## The duplication inventory (verified)

### D1 — "throw a real JS error instance" template, ≥4 hand-rolled copies

Canonical implementation: `buildThrowJsErrorInstrs`
(`src/codegen/expressions/helpers.ts:231-252`, #3175): noJsHost →
`emitWasiErrorConstructor`, `addStringConstantGlobal`, `ensureLateImport
__new_<Kind>`, `flushLateImportShifts`, string instrs, optional `call`,
`throw $exc`. Copies that re-implement the same shape:

| Copy | Where | Divergence from canonical |
| --- | --- | --- |
| `dvTypeErrorThrow` | `src/codegen/dataview-native.ts:653` (#3173) | no self-flush — caller pre-builds template before body (funcIdx-capture ordering) |
| `emitDataViewRangeError` | `src/codegen/dataview-native.ts:628` | same, RangeError |
| `emitBrandCheckTypeError` | `src/codegen/native-proto.ts:558` | sinks into a raw `Instr[]` (not fctx), unconditional `emitWasiErrorConstructor` |
| `emitThrowString` + `throwStringInstrs` | `src/codegen/array-methods.ts:137,144` | bare-string variant; `emitThrowString` is a **verbatim** private copy of `src/codegen/expressions/helpers.ts:38` |

### D2 — receiver brand-check, partially adopted

`emitReceiverBrandCheck`/`emitReceiverBrandThrow`
(`src/codegen/receiver-brand.ts:58,146`, #3171) is the parameterized gate
(struct `ref.test` + optional kind-tag refinement + catchable TypeError).
Adopters: collections-brand, array-object-proto, map-runtime, set-runtime,
collections-es2025. NOT yet routed through it:

- DataView brand gate — `DV_BRAND_MESSAGE`, `src/codegen/dataview-native.ts:640`
  (hand-rolled test/throw around the #3173 templates).
- RegExp standalone brand check — `src/codegen/regexp-standalone.ts:1022`
  (via native-proto's `emitBrandCheckTypeError`, D1 copy).

### D3 — five shape-path `Array.prototype.*.call` duplicates

`compileArrayPrototypeCall` (`src/codegen/array-methods.ts:2290`) has TWO
lanes for the same methods:

- shape-inferred lane → dedicated near-clones of the direct-method
  implementations: `compileArrayPrototypeIndexOf` (:2378), `...Includes`
  (:2501), `...Every` (:2585), `...Some` (:2727), `...ForEach` (:2849)
  — ~700 LOC duplicating `compileArrayIndexOf` (:4462), `...Includes`
  (:4659), `...Every` (:8199), `...Some` (:8134), `...ForEach` (:7695),
  including a second copy of the closure-invocation loop scaffolding.
- TS-type lane → a **synthetic-call rewrite** (:2356-2371) that routes to
  `compileArrayMethodCall` and reuses everything.

The duplicates exist only because `compileArrayMethodCall`'s receiver
resolution (`resolveArrayInfo`/`resolveArrayInfoFromWasmType` at :3312-3313,
`resolveArrayInfoForExpression` :652) never consults `ctx.shapeMap`.

### D4 — #1849 residuals (refreshed 2026-07-12)

| #1849 item | Current state |
| --- | --- |
| `compileSuperMethodCall` ≈ `compileSuperElementMethodCall` | **still duplicated** — `src/codegen/expressions/new-super.ts:545` vs `:666` |
| closure-iterable drainers ×2 | **now ×3**: `_drainClosureIterableToArray` `src/runtime.ts:2938`, `_drainWasmClosureIterable` `:3031`, `_drainIterable` `:10605` |
| `resolveVec` verbatim dup | **FIXED** — consolidated into `resolveVecForElementImpl` (`src/ir/integration.ts:960`, both call sites delegate) |
| `__extern_has` `in`-block ×2 | **evolved** — the `binary-ops.ts:630-745` region was rewritten under #2741/#2617 into a deliberate policy split (primitive-RHS TypeError vs externref Proxy-MOP route); re-verify before touching, likely legitimately distinct now |
| ~7× typed-default blocks in new-super | **mostly fixed** — `pushDefaultValue` used at `:122`/`:642`; sweep for residue |
| (new, same class) `truthyEnv` | verbatim dup: `src/codegen/index.ts:1438` vs `src/codegen/fallback-telemetry.ts:73` |

### D5 — dynamic-receiver array-like HOF loops, per-call-site vs shared stepper

`compileArrayLikePrototypeCall` (`src/codegen/array-methods.ts:763-1887`,
~1,124 LOC) emits a fresh `[[Get]]`-style element loop **at every call
site** for any-typed `Array.prototype.X.call(obj, …)`. Meanwhile #3098's
`ensureNativeArrayHof` (`src/codegen/hof-native.ts:74`) already emits ONE
shared `__hof_<name>` helper per method (11 methods: forEach/map/filter/
find/findIndex/findLast/findLastIndex/every/some + reduce/reduceRight) over
the same `__extern_length`/`__extern_get_idx` substrate + the
`__apply_closure` bridge — but only under `ctx.standalone`, and only when
reached via `closed-method-dispatch.ts` / `expressions/calls.ts`. Under
standalone there are therefore **two dynamic-receiver HOF lowerings** of
the same ES2025 semantics.

## Slices (independently claimable; each is its own PR)

**Filed as claimable child issues (2026-07-12):** S1 → **#3191**,
S2 → **#3192** (stacked on #3191), S3 → **#3193** (medium — array-methods.ts
hot), S4 → **#3194**, S5 → **#3195**, S6 → **#3196** (medium — array-methods.ts
hot, L). This epic stays the tracking umbrella.

### S1 — Unify the JS-error-throw templates on `buildThrowJsErrorInstrs` [M]

- **Remove**: `dvTypeErrorThrow` (dataview-native.ts:653),
  `emitDataViewRangeError` (dataview-native.ts:628),
  `emitBrandCheckTypeError` (native-proto.ts:558), and the verbatim
  `emitThrowString`/`throwStringInstrs` copies (array-methods.ts:137,144).
- **Route through**: `buildThrowJsErrorInstrs` / `emitThrowString`
  (expressions/helpers.ts:231/38). **Hoist them first** into a
  layering-safe leaf module (suggest `src/codegen/js-errors.ts`;
  `expressions/helpers.ts` re-exports for existing importers) — runtime
  modules (dataview-native, native-proto, array-methods) must not import
  from `expressions/` (front-end layer; #3029 layering).
- **Parameterize the two real divergences** (options bag, not new copies):
  (a) sink = fctx vs raw `Instr[]`; (b) self-flush
  (`flushLateImportShifts`) vs caller-flushes (the dataview
  pre-body-template ordering, documented at dataview-native.ts:620-627 —
  preserve it EXACTLY; a wrong flush here is the #1839-class index-shift
  hazard).
- **Acceptance**: zero test-diff; all four copies deleted; no new import
  cycles (`pnpm run typecheck` clean).

### S2 — Route DataView + RegExp brand checks through `receiver-brand.ts` [M, after S1]

- **Remove**: the hand-rolled DataView brand gate around
  dataview-native.ts:640 and the regexp-standalone.ts:1022 usage of
  native-proto's D1 copy.
- **Route through**: `emitReceiverBrandCheck`/`emitReceiverBrandThrow`
  (receiver-brand.ts:58/146) with a struct-only `ReceiverBrandSpec` (no
  `kindField`) for `$__dataview` / the RegExp struct.
- **Judgment gate**: receiver-brand consumes a stack receiver inside an
  fctx; the DataView accessors build throw templates BEFORE the body. If
  the ordering contract can't be met without weakening receiver-brand's
  API, **stop at S1's shared throw template** and record the decision here
  — do not force-fit (that would be a worse coupling than the dup).
- **Acceptance**: zero test-diff; brand TypeError messages byte-identical.

### S3 — Delete the five shape-path `Array.prototype.*.call` duplicates [M]

- **Remove**: `compileArrayPrototype{IndexOf,Includes,Every,Some,ForEach}`
  (array-methods.ts:2378-3075, ~700 LOC).
- **Route through**: the existing synthetic-call rewrite
  (array-methods.ts:2356-2371) → `compileArrayMethodCall`.
- **Mechanism**: make the receiver resolution shapeMap-aware — extend
  `resolveArrayInfoForExpression` (:652) (or the :3312 resolution chain)
  to consult `ctx.shapeMap` for identifier receivers, mirroring the lookup
  at :2323. Then the shape-inferred lane can take the same rewrite and the
  five clones die.
- **Edge cases to verify before deleting** (diff the clone vs the direct
  impl): callback-must-be-inline-arrow gate (:2603 vs the direct lane's
  `setupArrayCallback`), receiver null-guard, `undefined`-capable results.
  If a clone encodes a semantic the direct lane lacks, port the semantic
  FIRST (separate commit) so the deletion commit stays zero-diff.
- **Acceptance**: zero test-diff; ~700 LOC net negative in
  array-methods.ts.

### S4 — new-super.ts: extract the shared super-dispatch core [S] *(from #1849)*

- **Remove**: the duplicated body between `compileSuperMethodCall`
  (new-super.ts:545) and `compileSuperElementMethodCall` (:666) — the
  no-class/no-parent fallbacks had already diverged in #1849's 2026-06-04
  review; re-diff first and unify on the correct (spec-side) branch,
  parameterizing method-name-vs-element lookup.
- Sweep the file for residual hand-rolled typed-default blocks;
  `pushDefaultValue` (type-coercion.ts) is already imported and used at
  :122/:642.
- **Acceptance**: zero test-diff.

### S5 — runtime.ts: one parameterized closure-iterable drainer [S] *(from #1849)*

- **Remove**: the trio `_drainClosureIterableToArray` (runtime.ts:2938),
  `_drainWasmClosureIterable` (:3031), `_drainIterable` (:10605) — unify
  behind one drainer with a strategy/options param (loop cap, field
  resolution, wasm-exports access). Diff the three first: the divergences
  (different loop caps, #928 buffer-drain semantics) are the *parameters*,
  not reasons to keep copies.
- Also: fold the `truthyEnv` verbatim dup (index.ts:1438,
  fallback-telemetry.ts:73) into one export (trivial rider).
- **Acceptance**: zero test-diff.

### S6 — Standalone dynamic-HOF lane: de-inline `compileArrayLikePrototypeCall` onto the #3098 steppers [L]

- **Remove** (standalone lane only): the per-call-site HOF loop emission
  inside `compileArrayLikePrototypeCall` (array-methods.ts:763-1887) for
  the 11 `NATIVE_HOF_METHODS` — replace with arg-marshalling + a call to
  the shared `__hof_<name>` helper from `ensureNativeArrayHof`
  (hof-native.ts:74).
- **Keep the JS-host lane as-is**: it rides host imports as the sanctioned
  fast path (dual-mode principle, CLAUDE.md); `ensureNativeArrayHof`'s
  `__extern_get_idx` array-like arms are emitted only under
  `ctx.standalone` (`objArrayLikeArms` in `ensureObjectRuntime`), so
  extending the stepper to host mode is a **separate decision** — file a
  follow-up if the spike shows it viable, don't smuggle it in.
- **Boundary watch**: hof-native documents deliberate boundaries
  (reduce-of-empty returns undefined instead of TypeError; dense carriers,
  no hole-skip — hof-native.ts:43-49). If `compileArrayLikePrototypeCall`'s
  inline loop currently implements the *stricter* spec behavior for a
  method, routing through the stepper would be a behavior CHANGE — that
  method stays on the inline path until the stepper closes the gap
  (tracked under #3098), and the slice notes it.
- **Acceptance**: zero test-diff on the standalone/wasi test262 lanes AND
  the host lane; per-call-site loop copies gone for the migrated methods.

## Near-duplicates deliberately left separate (do NOT consolidate)

1. **Typed-receiver per-method HOF emitters** (`compileArrayFilter/Map/
   Reduce/Find/...`, array-methods.ts:7096-8265) vs the boxed `__hof_*`
   steppers: the typed lane exists precisely to avoid boxing every element
   and predicate result through externref (`__box_number`/`__is_truthy`).
   Folding it into the boxed stepper is an over-generalization that
   pessimizes the fast path. It already shares scaffolding
   (`setupArrayCallback` :6502, `setupArrayLoop` :6571, `buildCallAndCheck`
   :7072, `emitArrayLoop` :6948) — that's the right level of sharing.
2. **Typed vec-struct TypedArray lane** (`compileTypedArraySet`
   array-methods.ts:8900, `typedArrayElemLoad` :9009) vs the **dataview
   byte-view codec** (`emitTaViewElementGet/Set` dataview-native.ts:2271/
   2326, `emitTaDynViewElementGet/Set` :2533/2666): different
   representations (WasmGC element arrays vs byte-decoded views with a
   runtime `kind`). The two-arm router (`emitDynViewMethodTwoArm`
   array-methods.ts:3158) is already the shared seam between them.
3. **`buildTruthyCheck`/`buildFalsyCheck`** (array-methods.ts:6882/6922,
   typed inline ToBoolean) vs native `__is_truthy` (boxed externref
   ToBoolean): same boxing rationale as (1). (Micro-rider allowed: fold
   `buildFalsyCheck` into `buildTruthyCheck(negate)` — inside one file,
   no cross-lane unification.)
4. **`__extern_has` `in`-operator arms** (binary-ops.ts:630-745): rewritten
   since #1849 under #2741/#2617 into a deliberate three-way policy split
   (primitive-RHS TypeError / static struct fold / externref Proxy-MOP
   route). Treat as legitimately distinct unless a re-diff shows the
   *emission* (not the policy) is still copy-pasted.
5. **WasmGC vs linear backends** (`src/codegen/` vs `src/codegen-linear/`):
   alternatives by design (#1527, docs/architecture/codegen-axes.md) —
   never a dedup target.
6. **Legacy direct front-end vs IR front-end**: real duplication, but
   OWNED by #3090/#2855 with deletion gates (G1-G4 in the #3090 audit).
   Out of this epic's scope.

## Related in-flight work (already high/current — not re-tagged here)

- #2141 (tag-5 ABI untangle), #3029 (architecture umbrella),
  #3090 (legacy-handler deletion).
- Elevated alongside this epic (separate issues): #742, #808, #869,
  #3107 (`as Instr` codemod — 13,359 occurrences measured 2026-07-12),
  #3109 (test-helper consolidation — 133 files re-declare `compileAndRun`).
- Closed as stale during this groom: #803, #805, #810 (extractions already
  landed as `src/codegen/expressions/{calls,assignment}.ts` and
  `src/codegen/class-bodies.ts`), #1582 (walkInstructions already
  iterative — `src/codegen/walk-instructions.ts:23`).
- #1849 is **subsumed** by S4/S5 (+ the D4 table records what already got
  fixed).

## Ordering / conflict notes

- S1 → S2 are stacked (S2 consumes S1's hoisted module).
- S3, S4, S5 are independent of everything else and of each other.
- S6 touches `array-methods.ts` alongside S3 — claim sequentially or
  coordinate ranges (S3 is :2378-3075, S6 is :763-1887; disjoint but both
  shift line numbers — re-anchor by symbol, not line).
- All slices conflict-risk against #742's in-progress calls.ts work is
  low (different files), but re-merge `origin/main` before enqueue as
  usual.
