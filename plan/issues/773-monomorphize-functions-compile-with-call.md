---
id: 773
title: "Monomorphize functions: compile with call-site types, not generic externref"
horizon: xl
status: ready
created: 2026-03-22
updated: 2026-07-18
priority: critical
feasibility: hard
model: opus
fable_role: spec
reasoning_effort: max
task_type: performance
area: codegen
language_feature: monomorphization
goal: compiler-architecture
sprint: current
depends_on: [1124]
related: [743, 744, 745, 2773, 904, 1046]
test262_pass_impact: high
---

# #773 -- Monomorphize functions: compile with call-site types, not generic externref

## Problem

Functions are compiled with `externref` parameters when the compiler does not
know the argument type. But at many call sites, the exact struct or value type
**is** known. This forces an unnecessary round-trip:

- `extern.convert_any` at the call site
- `any.convert_extern` + `ref.cast` inside the callee

Issue `#1124` now documents why this is hard to solve cleanly in the current
pipeline: the compiler does not yet have a real middle-end where call-site
facts can persist as stable analysis inputs. This issue should therefore depend
on that architecture direction.

## Approach

Default to specific types, fall back to generic only when necessary:

1. Pre-pass:
   before compiling function bodies, scan all call sites to collect the
   concrete argument types each function is called with.
2. Specialize:
   for each function, if all call sites pass the same concrete type for a
   parameter, type that parameter as that concrete ref/value directly.
3. Monomorphize:
   if a function is called with 2-3 different useful type combinations,
   compile one variant per combination.
4. Generic fallback:
   only compile with `externref` parameters when:
   - the function is exported
   - the function is stored in a variable or passed as a callback
   - the function is called with more than N different type combinations
   - the parameter type is genuinely `any` or a large union
5. Call-site dispatch:
   at each call site, call the specialized variant directly if one exists for
   the argument types.

## Benefits

- eliminates `extern.convert_any` / `any.convert_extern` round-trips
- enables direct `struct.get` instead of `ref.test` + `ref.cast` chains
- reduces generic dispatch inside otherwise monomorphic functions
- improves downstream runtime optimization by keeping call sites monomorphic

## Acceptance criteria

- functions called with known concrete types use concrete parameter types
- only exported or genuinely polymorphic functions use generic `externref`
  parameters
- call-site type information can select specialized variants without losing
  correctness
- net improvement in test262 pass count and/or generated code quality
- no regressions in equivalence tests

## Notes

- Depends on `#1124`, which establishes the need for a middle-end with stable
  call-site metadata and a principled place for monomorphization
- `#744` is the more explicit cloned-function follow-up for polymorphic call
  sites once whole-program type flow and specialization infrastructure exist

## Implementation Plan (Author: Fable architect, spec-only, 2026-07-18)

Implementer: **Opus for Slice 1 only** (see the model note at the end). Line
numbers are against `origin/main` at spec time — re-grep before editing.

### Review finding — this is NOT greenfield; the engine already exists (V1)

The single most important correction to the issue's framing: **a
module-scoped monomorphization pass already shipped and is live in the
pipeline.** `src/ir/passes/monomorphize.ts` (`monomorphize(mod, registry)`,
spec #1167c) is wired into `src/ir/integration.ts:618`
(`const monoResult = monomorphize(monoIn, allocRegistry)`), between the
`inlineSmall` pass and the `taggedUnions` pass, on the middle-end IR. It already
does the core of what this issue's "Approach" describes:

- collects every IR-local call site's `(callee, argTypes)` tuple across the
  whole **module** (`monomorphize.ts:120-143`);
- groups per callee by arg-type tuple and clones tuples `1..N` into
  `callee$<suffix>` variants (`:194-218`), repointing each call site to its
  typed clone (`:266-292`);
- caps variants at `MAX_VARIANTS_PER_CALLEE = 4` (`:73`) and callee size at
  `MAX_CALLEE_SIZE = 20` (`:75`), with a pass-end `GROWTH_BUDGET = 0.5`
  whole-module bloat guard (`:77`, `:231-239`);
- the clone's params are retyped to the concrete tuple and its body lowers to
  `ValType`-typed Wasm, avoiding the `__box_number`/`__unbox_number` round-trip.

So #773 is a **re-homing + extension** of that pass, exactly the way #904's
Fable review re-homed onto the real `src/link/`. Do **not** write a second
monomorphizer in `src/codegen/`. The issue's original `files:`-style note
("monomorphize() in src/codegen/index.ts") predates the middle-end IR (#1124,
DONE) and is stale — the middle-end IR is the correct and only home
(see "Which axis" below).

### Where this lives on the two axes (decided)

Per `docs/architecture/codegen-axes.md` and #1124's explicit "insert a middle-end
IR" outcome, monomorphization is a **front-end / middle-end concern, backend-
agnostic**: it rewrites the typed SSA IR (`IrModule` / `IrFunction`) and defers
all Wasm materialization to the shared lowering (`src/ir/lower.ts` +
`backend/wasmgc-emitter.ts` / `backend/linear-emitter.ts`). This is why it is
**representation-neutral** and composes with the value-rep lanes (#745/#2773):
the pass only decides _which signature to clone_ (in `IrType` terms); it never
emits `extern.convert_any` / `struct.new` / boxing ops itself. Operate on the IR,
**not** the direct AST→Wasm path — the AST path is the legacy lane being retired
(#2855), and a call-site-cloning rewrite there would be an "ad hoc extension of
direct AST-to-Wasm lowering" that #1124 explicitly ruled out.

### The V1 restrictions — the ceiling this issue must lift

`isMonomorphizable` (`monomorphize.ts:382-396`) gates a callee to:

1. **single-block** body,
2. body ≤ `MAX_CALLEE_SIZE` instrs,
3. terminator is `return`,
4. **body instructions must NOT consume any parameter as an operand**
   (`:388-395`) — the narrowest, most limiting rule.

Restriction (4) means today the pass only handles "identity-like" helpers
(`return param`, `return const`) — precisely because retyping a param from
`externref` to `f64` would invalidate any `f64.add(param, …)` whose operand type
the pass does not re-infer. The pass's own comment (`:32-34`) names the next
phase: _"later phases will re-infer instruction resultTypes under the retyped
params."_ That is Slice 2 below. There is also no cross-**file** (whole-program)
scope: `buildTypeMap` (`src/ir/propagate.ts:220`) and the call-site collection
are per-compilation-unit; cross-module callees drop to `dynamic`
(`propagate.ts:80-82`). That is Slice 3.

### Analysis architecture (already partly built — map, don't rebuild)

- **Call graph**: `buildCallGraph(decls)` (`propagate.ts:241`) for the type-flow
  seed; the monomorphize pass builds its own direct-call edge set inline
  (`computeRecursiveSet`, `:305`) for recursion detection. Reuse both; do not
  add a third call-graph builder.
- **Specialization candidates**: the grouped `Map<callee, Map<tupleKey, calls>>`
  in `monomorphize.ts:156-174`. `tupleKey`/`irTypeKey` (`:418-453`) is the
  canonical specialization-key primitive — **this is the same keying #904 Pass 1
  and #1046 Slice 4 must serialize** across the artifact boundary (see the
  interaction contract). Keep one key function.
- **Polymorphic-site detection**: a callee with `byKey.size >= 2` distinct
  tuples (`:195`) is polymorphic; `byKey.size === 1` is monomorphic-by-
  observation (Slice 1's target — currently a no-op).
- **Type facts**: parameter/return `IrType`s come from `buildLocalTypeOf`
  (`monomorphize.ts:351`) + the Phase-2 `TypeMap` (`propagate.ts:buildTypeMap`).
  All checker access is in the **front-end analysis layer** (`propagate.ts` reads
  `ts.checker` directly, pre-codegen, emitting name-keyed `IrType`, never a
  `ts.Type`) — this is _outside_ the oracle-ratchet gate, which polices
  raw-checker access in `src/codegen/**` only. Do NOT reach for `ctx.oracle`
  inside the IR passes; do route any NEW codegen-side type query (Slice 3's
  cross-module binding) through `ctx.oracle.signatureOf` (`oracle.ts:89`).

### Specialization mechanics (existing, keep)

- **Per-signature clones**: `cloneWithParamTypes` (`monomorphize.ts:491`) deep-
  copies the callee, retypes params, forks alloc-site ids (`forkAllocInInstr`,
  #1586 rule), and derives the clone return type via `deriveReturnType` (`:555`).
- **Naming**: `callee$<nameSuffixFor(tuple)>` (`:212`, `:455-467`),
  uniquified against `usedNames` (`:469-475`). Stable/deterministic (sorted tuple
  keys) — a load-bearing property for the `.widl` serialization contract.
- **Dedup**: none today — a Slice-4 opportunity (structurally identical clones
  across callees collapse to one). Not required for Slices 1-3.
- **Bloat cap**: `MAX_VARIANTS_PER_CALLEE = 4` + `MAX_CALLEE_SIZE = 20` +
  whole-module `GROWTH_BUDGET = 0.5` (abandon-the-whole-pass if exceeded). This
  is the single bloat policy; #904/#1046 must manage their specialization budget
  **inside** this cap, not add a parallel knob (per #904's review).
- **Registration**: clones have no `ts.FunctionDeclaration` and no pre-allocated
  funcIdx; `integration.ts:698-720` allocates a placeholder `WasmFunction` slot
  and records it in `ctx.funcMap` so the Phase-3 lowerer resolves the clone's
  `IrFuncRef`. Any new clone-producing slice inherits this path for free.

### Slice decomposition

**Slice 0 — landed (V1, #1167c).** Module-scoped clone-on-≥2-tuples for
identity-like callees. Baseline; no work.

**Slice 1 — single-variant specialize-in-place (THE self-contained, zero-
regression PR; Opus-implementable).**

Target the issue's own step 2 ("if all call sites pass the same concrete type
for a parameter, type that parameter as that concrete ref/value directly") —
the case V1 skips because of the `byKey.size < 2` guard (`monomorphize.ts:195`).

- **Trigger**: a monomorphizable callee (passes the _existing_ `isMonomorphizable`
  gate — so still the narrow identity-like set, keeping Slice 1 safe) whose call
  sites across the whole module observe **exactly one** concrete arg-type tuple,
  that tuple is not already the callee's declared signature, and no tuple element
  is `dynamic`/`unresolvable`.
- **Action**: **retype the original function's params in place** to that tuple
  (no clone, **zero new instructions, growth-budget-irrelevant**) and record the
  narrowed signature so downstream lowering and the caller's coercion emit the
  direct typed `call`. Reuse `cloneWithParamTypes`'s retype+`deriveReturnType`
  logic applied to the original (factor the param-retype/return-derive core into
  a shared helper `retypeParamsInPlace(fn, tuple)` that both the clone path and
  Slice 1 call).
- **Exclusions (correctness envelope)**: exported functions (external callers
  unknown → keep declared signature), address-taken / closure-captured callees
  (a `closure.new`/`IrFuncRef`-as-value use — not a direct `call` target),
  callees with any call site whose args are not all resolvable, and any callee
  the recursion set flags (`computeRecursiveSet`). These are the same exclusions
  V1 already encodes; Slice 1 adds no new unsafe surface.
- **Why zero-regression**: (a) it only _narrows_ a signature every observed
  caller already satisfies, so no call site changes shape incorrectly; (b) the
  pipeline already re-runs `verifyIrFunction` + hygiene on every touched function
  post-pass (`integration.ts:638-662`) — a bad retype surfaces as a verify error
  and the function is dropped, never miscompiled; (c) for any module with no
  qualifying callee the pass output is byte-identical (the new branch is a pure
  addition guarded by `byKey.size === 1 && qualifies`).
- **Files**: `src/ir/passes/monomorphize.ts` (the new single-variant branch +
  the extracted `retypeParamsInPlace` helper); no `integration.ts` change needed
  (in-place retype keeps the same funcIdx — no placeholder slot). Tests:
  `tests/ir-monomorphize-slice1.test.ts`.

**Slice 2 — lift restriction (4): re-infer instruction resultTypes under
retyped params (Fable).** Remove the "body must not consume params as operands"
gate by, after retyping params, walking the (single-block, ≤20-instr) body and
recomputing each instr's `resultType` from its now-retyped operands (binary/
unary/select/box/unbox/etc.), bailing the whole clone if any instr can't be
consistently re-typed (fall back to not cloning that tuple). This unlocks the
high-value **numeric kernels** (`fib`, `square(x){return x*x}`) that motivate the
issue. Real lattice reasoning + join/bail correctness → Fable. Backstopped by the
same verify gate.

**Slice 3 — whole-PROGRAM (cross-file) scope (Fable).** Today's candidate
collection and `buildTypeMap` are per-compilation-unit; cross-module callees drop
to `dynamic` (`propagate.ts:80-82`). Extend the call-site/type-flow seed across
the module graph so a callee imported from another unit can be specialized to a
consumer's concrete pin. This is the shared substrate for **#1046 Slice 4** and
**#904 Pass 1** — the `.widl` `specializations[]` table is the serialization of
this slice's IR variants across the artifact boundary. Cross-module binding is
the one place a NEW codegen-side type query appears → route through
`ctx.oracle.signatureOf`. Value-rep-boundary sensitive → coordinate with
#745/#2773 (see contract). Fable, multi-PR.

**Slice 4 — recursion/SCC + multi-block + clone dedup (Fable).** Specialize the
entry of a recursive function and keep intra-SCC recursive calls within the same
specialization (issue's "Limits" bullet); allow multi-block bodies; add
structural clone dedup to claw back bloat headroom so `MAX_VARIANTS` can rise.
Fable.

### Wasm-level effect (illustrative, produced by lowering — not emitted by this pass)

Before (V1 can't specialize `square`; param stays boxed):

```wat
;; square: (externref) -> externref
local.get $x            ;; externref
call $__unbox_number    ;; -> f64
local.get $x
call $__unbox_number    ;; -> f64
f64.mul
call $__box_number      ;; -> externref
return
```

After Slice 2 (param retyped f64, body re-inferred):

```wat
;; square$f64: (f64) -> f64
local.get $x
local.get $x
f64.mul
return
```

### Test plan

- `tests/ir-monomorphize-slice1.test.ts` (Slice 1): (a) a helper called only with
  `f64` gets its param retyped in place and the caller emits a typed `call` with
  no box/unbox — assert IR param `IrType` is `val:f64` and count of `box`/`unbox`
  instrs is 0; (b) an **exported** helper with a single concrete caller is NOT
  retyped (keeps declared signature); (c) an address-taken helper (passed to
  `closure.new`) is NOT retyped; (d) a module with no qualifying callee emits
  byte-identical wasm (byte-diff neutrality gate, #1917 style); (e) a helper with
  two distinct tuples still follows the V1 clone path unchanged (no interaction
  regression).
- Reuse the existing monomorphize unit tests as the V1 regression guard.
- Full validation is CI/`merge_group` (test262) — this pass is broad-impact;
  never gate on scoped sweeps alone.

### Regression risks

- **Signature narrowing at a boundary the pass can't see.** A callee that is
  monomorphic within the unit but reachable from outside (export / re-export /
  indirect table entry) must keep its declared signature. Slice 1's exclusion set
  is the guard; verify it covers `IrFuncRef`-as-value (closures), `exported`, and
  any Phase-3 table registration. This is the highest-risk area — over-narrowing
  an externally-reachable function corrupts every external call.
- **Alloc-provenance**: in-place retype must preserve alloc-site ids (Slice 1
  does no cloning, so no fork needed — but assert `assertAllocProvenance` still
  passes, as `integration.ts:650` already checks).
- **Value-rep drift (#745/#2773)**: never hardcode the current externref-boxing
  ABI (see contract). A specialized `IrType` must lower through whatever rep the
  value-rep lanes land.
- **Bloat**: Slices 2/4 add clones — the existing `GROWTH_BUDGET = 0.5` global
  guard is the backstop; do not weaken it without dedup (Slice 4) landing first.

### Interaction contracts

- **#743 (whole-program type flow)** — supplies the parameter/return `IrType`
  facts (`buildTypeMap`) that seed candidate detection. #773 is the _consumer/
  specializer_; #743 is the _analysis_. They share `src/ir/propagate.ts` and the
  `IrType` lattice. Slice 3 of #773 and the cross-file extension of #743 are the
  same work — coordinate to land jointly.
- **#745 / #2773 (value-rep, both in-progress)** — **the boundary contract:**
  #773 decides _which signature to clone_ (an `IrType` tuple); the value-rep lane
  decides _how each `IrType` lowers to Wasm_ (externref-box today, `$AnyValue`
  tagged carrier or reconstructed-struct tomorrow). These compose **only if**
  #773 stays in `IrType` space and never emits box/convert/struct ops directly.
  Concretely: a `dynamic` `IrType` (with the #2949 optional `JsTag` refinement) is
  the value-rep-neutral carrier — a "known union" param is a `dynamic` with a
  narrowed tag set, and #773 may specialize on it without knowing its Wasm layout.
  This lets the two lanes land independently. Both lanes must agree that
  **finalize-stable typeIdx** (#2773 keystone) is materialized _after_
  monomorphization (integration.ts order: mono → TU → lower), so clone typeIdx
  assignment stays deterministic.
- **#904 / #1046 Slice 4** — cross-module specialization is **#773 applied at a
  module boundary**. They MUST reuse #773's `tupleKey`/`irTypeKey` as the
  specialization-key and #773's clone-emit as the variant producer; the `.widl`
  `specializations[]` table is the serialization of #773's variants. Do not build
  a parallel specializer or a parallel bloat cap (#904 review, finding 4).
- **#744** — the explicit polymorphic-clone case; already subsumed by V1's
  `byKey.size >= 2` clone path. #744 should be closed-as-covered or narrowed to
  "Slice 2/4 body-shape lifts" once those land.

### Model recommendation

**Slice 1 → Opus-safe** (mirrors #1046's slice-1 scoping): it is a single
additive branch in one pass file, inside the _existing_ narrow safety envelope,
with the pipeline's `verifyIrFunction` + `assertAllocProvenance` +
byte-diff-neutrality as hard backstops. Frontmatter `model: opus` scopes the
next dispatchable unit (Slice 1). **Slices 2-4 require Fable** (instruction-level
type re-inference, cross-module flow, SCC reasoning) — re-dispatch each with the
model bumped; do not hand an Opus a Slice-2+ task.
