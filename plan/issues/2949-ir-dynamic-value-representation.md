---
id: 2949
title: "IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType (make untyped JS claimable)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-29
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [1852, 1926, 2138, 2135, 2855]
origin: "2026-07-02 July Fable audit (plan/log/analysis-2026-07/00-ir-async-standalone-audit.md §1)"
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/codegen/index.ts
  - src/codegen/any-helpers.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
branch: codex/2949-acorn-module-var-scalars
---

# #2949 — the IR's type system is Wasm types, not JS types

## Problem

`IrType`'s leaf is `{kind: "val", val: ValType}` (`src/ir/nodes.ts:56ff`).
There is **no dynamic / any / JsTag representation inside the IR**. Every
value the front-end cannot statically resolve to a concrete Wasm type causes
whole-function rejection (`param-type-not-resolvable`,
`type-resolution-failure`, most of `body-shape-rejected` transitively).

Measured consequence (#2138 slice-2 measurement): the IR claimed **8 bodies
across 4 of 233 corpus files** on a JS-heavy corpus. The bucket-to-zero
program (#2855/#2856–#2859) is measured against 13 typed playground
examples; zeroing those buckets leaves the test262-scale claim rate in
single digits. **"IR as the only front-end" is arithmetically unreachable
without dynamic values in the IR type lattice.** This is the north star's
true critical path and previously had no filed issue.

The codegen-level D1 value-rep program (JsTag enum, brands, boxed-any
carriers — #1852/#1926/#2040 family) is done or in flight, but it lives
below the IR: the IR and the value-rep model have never met.

## Approach (architect spec first — this issue starts as the spec)

1. **Spec slice (this issue, first deliverable):** extend the `IrType`
   lattice with `{kind: "dynamic", tag?: JsTag}` (statically-known-tag
   refinement optional), define verifier rules (what ops accept dynamic
   operands, where explicit `IrInstrBox`/`IrInstrUnbox`/`IrInstrTagTest`
   nodes are required), and define the lowering contract: dynamic maps to
   the existing boxed-any carrier on WasmGC (per #1852 carrier policy) and
   to the f64-value+i32-tag cell on linear (deferred, #1852-G4/#2956).
   The trait methods `emitBox`/`emitUnbox`/`emitTagLoad` already exist
   (declared-optional) on `BackendEmitter` — this spec makes them
   load-bearing (coordinate with #2953).
2. **Slice 2:** `from-ast.ts` emits dynamic-typed IR for unresolvable
   locals/params instead of throwing; selector capability rows widen
   accordingly (#2135 table, claim instead of defer for
   `param-type-not-resolvable` / `type-resolution-failure` shapes).
3. **Slice 3:** lower dynamic ops via the canonical boxed-any helpers
   (reuse `addUnionImportsViaRegistry` / native classifier paths — do NOT
   mint a second boxing engine; June audit D4 rule).
4. **Slice 4:** measure claim-rate delta on the 233-file corpus + full
   test262 (`ir_first` lane, #2947); ratchet buckets down with the
   measurement as evidence.

## Acceptance criteria

- IrType has a dynamic kind with documented verifier rules; verify.ts
  enforces them (hard-fail lane stays on).
- A function with an unannotated `any` param round-trips: claimed by the
  selector, IR-built, lowered, byte-behavior-equal to legacy on the
  equivalence suite.
- Claim-rate measurement recorded here (corpus + test262 scale), with the
  before/after bucket counts.
- No second boxing implementation: lowering routes through the existing
  boxed-any registry helpers.

## Risks

- Blast radius is the whole IR pipeline; keep slices flag-free but
  additive (a dynamic-typed function that would previously reject is the
  only behavior change).
- Interaction with #2138 skip-set: a claimed-because-dynamic function must
  still satisfy the skipped-slot hard-error contract.

## Implementation Plan — Slice 1 (RATIFIED, fable-1, 2026-07-02)

### 0. What slice 1 ships (and what it deliberately does not)

Slice 1 is the **type-lattice + verifier + lowering-contract** slice. It is
**byte-inert by construction**: no producer (`from-ast.ts`, selector,
propagation) emits `dynamic`-typed IR yet, so no compiled module changes.
Producers land in slice 2 (coordinated with #2138's skip-set contract, which
is in flight on `issue-2138-ir-first-slice1`); box/unbox/tag.test _lowering_
for dynamic operands lands in slice 3 (via the emitter contract, coordinated
with #2953). Slice-1 lowering arms throw staged
`"… lands in #2949 slice 3"` errors so a premature producer fails loudly.

### 1. The lattice extension (`src/ir/nodes.ts`)

```ts
| { readonly kind: "dynamic"; readonly tag?: JsTag }
```

- `dynamic` is the **TOP** of the IrType lattice: every other IrType enters
  it only via an explicit `box` node and leaves it only via an explicit
  `unbox` (after a `tag.test` proof). **No implicit conversions** — this is
  what keeps the typed mainline unboxed (#1852 §3 invariant).
- `tag?: JsTag` is an optional **static refinement**: the producer proved
  the runtime partition (e.g. inside a `tag.test`-guarded branch). It never
  changes the carrier; it only licenses checked unboxes without a runtime
  re-test. `irTypeEquals` is **exact** on the refinement (both absent or
  both equal) — producers must widen to bare `dynamic` before joins
  (branch args, slot writes), because silently merging two refinements
  would keep whichever tag came first.
- `JsTag` is the **existing** canonical tag enum (#2104), extracted verbatim
  to the dependency-free leaf `src/codegen/js-tag.ts` (re-exported from
  `value-tags.ts` so all existing imports are unchanged). One tag table for
  codegen and IR — the June-audit D4 rule (no second tag/boxing engine)
  holds at the type level too. The extraction exists because `ir/nodes.ts`
  is a pure leaf imported by both layers; importing `value-tags.ts` (which
  pulls `ts-api` + codegen context types) from it would knot the module
  graph.

### 2. Node contracts (`box` / `unbox` / `tag.test` widened, not duplicated)

One boxing concept in the IR, discriminated by the operand/target **type**
(the type system carries representation, not the node kind — same principle
as `string`/`object`/`closure` resolver-deferred kinds):

- `box{ value, toType }` — `toType` may now be `dynamic` (erasure into the
  carrier). The operand must NOT itself be dynamic (re-box is provably
  redundant; verifier R1 rejects).
- `unbox{ value, tag?, jsTag? }` — `tag: ValType` became optional; it is
  REQUIRED for union operands (V1 contract, verifier-enforced) while
  dynamic operands use `jsTag: JsTag` (REQUIRED there). `jsTag` must have a
  payload (`jsTagUnboxKind(jsTag) !== null`) — Null/Undefined are singleton
  partitions and cannot be unboxed (R2). If both fields are present they
  must be consistent (scalar partitions exact, String/Object/Function
  ref-shaped).
- `tag.test{ value, tag?, jsTag? }` — same field discipline; `jsTag` may be
  ANY partition including Null/Undefined (testing for them is the point)
  (R3).

`jsTagUnboxKind(tag)` (in `js-tag.ts`) is the canonical partition→payload
mapping, derived from the `$AnyValue` layout
(`{tag, i32val, f64val, refval, externval}`): NumberI32/Boolean → `"i32"`,
NumberF64 → `"f64"`, String/Object/Function → `"ref"` (exact ValType is a
backend decision at lowering), Null/Undefined → `null` (no payload).

### 3. Verifier rules (`src/ir/verify.ts`, all enforced in slice 1)

- **R1 (box):** `toType` union (existing member rule) or dynamic (operand
  must not be dynamic).
- **R2 (unbox):** operand union (existing rules + `tag` now required-if-
  union) or dynamic (`jsTag` required, payload-bearing, `tag` consistent).
- **R3 (tag.test):** operand union (as R2) or dynamic (`jsTag` required,
  any partition).
- **R4 (scalar ops):** ALL `binary`/`unary` ops reject dynamic operands
  ("requires an explicit unbox"). Note `valKindOf` returns `null` for
  non-`val` kinds, which would have silently _skipped_ the existing kind
  rule — the explicit dynamic check closes that hole. Conservative on
  purpose (`ref.is_null` included); relax per-op when a slice needs it.
  Loop `condValue` (must-be-i32) already rejects dynamic via the existing
  #1980 rule.
- **R5 (joins):** enforced structurally by exact `irTypeEquals` in the
  existing branch-arg type checks; producers widen refinements first.
- **R6 (returns):** existing `returnTypeAssignable` already behaves
  correctly for dynamic (it is reference-shaped: scalar→dynamic result
  flags "needs a box the IR doesn't emit"; dynamic→scalar flags; ref→
  dynamic passes) — no change needed, documented here.

### 4. Lowering contract (`src/ir/lower.ts` + `integration.ts`)

- `IrLowerResolver.resolveDynamic?(): ValType` — returns the module's
  canonical **boxed-any carrier**, and MUST equal legacy
  `resolveWasmType`'s any/unknown arm so IR-claimed and legacy functions
  agree on the `any` ABI:
  - WasmGC **fast/standalone** → `ref_null $AnyValue` (via the idempotent,
    append-only `ensureAnyValueType`).
  - WasmGC **host (non-fast)** → `externref`.
  - **Linear** → deferred (#1852-G4/#2956); method omitted, lowering throws.
- `lowerIrTypeToValType` gains the dynamic arm (resolver-deferred, like
  string/object/closure). The `tag` refinement never changes the carrier.
- Dynamic box/unbox/tag.test **op** lowering is slice 3: it must route
  through the emitter contract (`emitBox`/`emitUnbox`/`emitTagLoad`,
  promoted from optional per #1852-G1) and the existing `__any_box_*` /
  classifier helper family — never a second boxing engine. Slice 3 keys the
  layout-handle union on `IrUnionLowering | IrDynamicLowering` (new handle:
  `{ carrier: ValType, anyValueTypeIdx, tagFieldIdx, payloadFieldIdx(jsTag) }`)
  — spec'd here so #2953's `pushRaw`-routing can anticipate the shape.

### 5. Slice-1 file inventory

- `src/codegen/js-tag.ts` (new leaf): `JsTag` moved verbatim +
  `jsTagUnboxKind`. `value-tags.ts` re-exports both.
- `src/ir/nodes.ts`: dynamic kind, `irDynamic`/`isDynamic`, `irTypeEquals`
  arm, widened box/unbox/tag.test contracts.
- `src/ir/verify.ts`: R1–R4.
- `src/ir/lower.ts`: `resolveDynamic` contract, type-lowering arm, staged
  slice-3 errors, union-path `tag` guard.
- `src/ir/integration.ts`: `makeResolver().resolveDynamic` (additive; no
  overlap with #2138's in-flight diff, which touches only
  `codegen/index.ts`).
- `src/ir/{from-ast,passes/monomorphize}.ts` + `lower.ts`/`integration.ts`
  describe/key helpers: dynamic arms (refinement-distinct keys).
- NOT touched: `select.ts` (capability rows are slice 2), `emitter.ts`
  (#2953's surface), `propagate.ts` (its lattice `dynamic` maps onto
  `IrType.dynamic` in slice 2).

## Test Results — Slice 1 (2026-07-02, fable-1)

- `tests/issue-2949-ir-dynamic-type.test.ts` — 19/19 pass (tag-table
  identity, lattice equality, verifier R1–R4 positive+negative, lowering
  contract incl. missing-resolver and staged-slice-3 failures).
- **Byte-inertness PROVEN** (not just argued):
  `scripts/prove-emit-identity.mjs` baseline captured on clean main
  (`affc55523`), `check` on this branch → **IDENTICAL, all 39
  (file,target) hashes match** across gc/standalone/wasi targets.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket (no
  selector change, as designed).
- Related suites: `issue-2104-value-tags` (JsTag move), `ir/phase3c`
  (union box/unbox/tag.test V1 path), `ir-frontend-widening`,
  `ir-backend-emitter` — all pass. `ir-scaffold.test.ts` has 2 failures
  that reproduce identically on clean main (pre-existing, unrelated —
  `__unbox_number` link error + `func.params not iterable`).
- `npx tsc --noEmit` clean; the new IrType variant surfaced exactly 4
  boxed-fallthrough describe/key helpers + 2 optional-`tag` consumers,
  all fixed with explicit dynamic arms.

- **Equivalence-suite classification** (`tests/equivalence/`, 211 files /
  1638 tests): a triple-concurrent run showed 56 failures — re-run SOLO the
  count collapses to **4 failures in 2 files**
  (`arguments-nested-and-loops` 1, `iife-and-call-expressions` 3), and
  clean main (`affc55523`) solo on the same 2 files shows the **identical
  2-files / 4-failed / 112-passed** result. Verdict: 4 pre-existing main
  failures + ~52 load flakes (the known pass→compile-timeout mode under
  CPU contention). **Zero equivalence regressions from this branch**,
  consistent with the 39/39 byte-identity proof.

## Handoff — Slice 2+ (written at 2026-07-02 budget wind-down, fable-1)

Slice 1 is complete and PR'd from branch `issue-2949-ir-dynamic-value-rep`
(worktree was `agent-a581bd5866af72b4b`, disposable). The claim lock will be
released at termination so the next window's senior-dev can pick this up.

**Slice 2 (producers + selector) — start here:**

1. `src/ir/propagate.ts` already computes a `dynamic` lattice top; today
   from-ast REJECTS when it converges there. Map lattice-`dynamic` →
   `irDynamic()` for params/locals/returns instead of throwing
   (`param-type-not-resolvable` / `type-resolution-failure` /
   `return-type-not-resolvable` shapes first).
2. Widen the #2135 capability rows in `select.ts` to claim those shapes.
   **Coordinate with #2138 first** — sr-irfirst's
   `issue-2138-ir-first-slice1` (in flight at wind-down, touches
   `src/codegen/index.ts`) owns the skip-set contract; a
   claimed-because-dynamic function must still satisfy the skipped-slot
   hard-error rules. Merge their landed work before touching select.ts.
3. The verifier is already strict (R1–R4 enforced, hard-fail lane on) —
   producers that emit un-unboxed dynamic uses will fail verify, which is
   the designed backstop while slice 3 lowering is absent. Until slice 3,
   producers may only emit MOVE-shaped dynamic flows (param→return,
   param→call-arg with dynamic signature) — the lowering arms for dynamic
   box/unbox/tag.test throw staged errors on purpose.

**Slice 3 (lowering):** route dynamic box/unbox/tag.test through
`emitBox`/`emitUnbox`/`emitTagLoad` + a new `IrDynamicLowering` handle
(shape spec'd in §4 above) backed by the `__any_box_*`/`$AnyValue` family
(`ensureAnyValueType` / `boxToAny` / `__any_from_extern`). Coordinate with
#2953 (BackendEmitter pushRaw routing — unowned at wind-down).

**Slice 4 (measurement):** 233-file corpus + `ir_first` test262 lane
(#2947); record claim-rate + bucket deltas HERE per acceptance criteria.

**Gotchas discovered:** (a) `resolveWasmType`'s any-arm is mode-split
(`ctx.fast` → `ref_null $AnyValue`, else externref) — `resolveDynamic` in
`integration.ts` mirrors it and MUST stay in lockstep; (b) `valKindOf`
returns null for non-val IrTypes, so any new per-op verifier rule must
explicitly check `kind === "dynamic"` or it silently skips; (c)
`prove-emit-identity.mjs` (baseline on main, check on branch) is the cheap
byte-inertness oracle — use it on every producer-free slice.

## Implementation Notes — Slice 2 (fable-2949, 2026-07-04, branch `issue-2949-jstag-dynamic`)

Slice 2 ships the first **producers**: unannotated params/returns whose
propagated lattice type is `unknown` (no evidence) or `dynamic` (top) now
resolve to `IrType.dynamic` and CLAIM, instead of rejecting the whole
function. The surface is deliberately **move-only** (no box/unbox/tag.test
lowering exists until slice 3), enforced by a new selector gate.

### What changed (and the WHY behind each decision)

1. **`select.ts` — `ResolvedKind` gains `"dynamic"`.**
   `resolveParamType`/`resolveReturnType` return it when: no annotation AND
   the TypeMap entry EXISTS and its lattice kind is `unknown`/`dynamic`.
   The `mapped !== undefined` requirement is load-bearing: class methods
   don't participate in TypeMap propagation (`entry` is undefined there) and
   must NOT silently become dynamic-claimable — method claiming carries the
   typeIdx-parity contract with `class-bodies.ts`. Lattice `union` stays
   rejected (that shape belongs to #2135's union rows, which have a real
   V1 boxing path). Binding patterns with a dynamic verdict stay rejected
   (destructuring a dynamic needs dynamic property access — slice 3+).
   Generators with dynamic params stay rejected (no dynamic arm in the
   gen prologue/yield machinery).

2. **`select.ts` — `dynamicUsesAreMoveOnly` (the precision gate).** Claim
   only when every dynamic value strictly MOVES:
   - `return <dyn>` (iff the return resolved dynamic; dually, a dynamic
     return REQUIRES every return argument to be dyn-shaped — a concrete
     value there would need a box);
   - dyn-arg → dyn-param of a DIRECT call to a local function, where the
     callee's per-param verdict is computed by the SAME `resolveParamType`
     the callee's own claim check uses (selector↔override drift is
     impossible by construction);
   - `const`/`let` alias (`const y = x`) — the alias joins the dyn set;
     re-assignment `y = <expr>` scans the RHS against the LHS's dyn-ness;
   - statement-position calls (a DROPPED dynamic result is fine — `drop`
     of the carrier ref validates).
     Everything else — arithmetic, truthiness, property access, calling the
     dyn value, mixed concrete/dynamic returns, dyn-into-concrete-param,
     spread over a dyn-param callee — keeps the EXISTING rejection bucket
     (`param-type-not-resolvable` / `return-type-not-resolvable`).

   **Why precision instead of claim-then-demote:** (a) under
   `JS2WASM_IR_FIRST=1` a claimed+skipped function that build-demotes is a
   HARD compile error (the #2138 skipped-slot contract); (b) the #1923
   post-claim metering treats demotions as regressions-in-waiting; (c) the
   unannotated population is the MAJORITY of JS code — claiming it all and
   demoting most would double-compile the world for nothing. The scan
   mirrors what from-ast can actually build; the demotion channel remains
   as the backstop for scan bugs, and slice-2 testing shows ZERO demotions
   across every claimed shape.

3. **`codegen/index.ts` — `resolvePositionType` dynamic arm**, predicate-
   identical to the selector arms (`!node && mapped && unknown|dynamic` →
   `irDynamic()`). Positioned AFTER the concrete/object lattice arms so
   nothing previously resolvable changes. Existing lowering from slice 1
   (`lowerIrTypeToValType` → `resolveDynamic()`) does the rest.

4. **`codegen/index.ts` — IR-first skip-set gate 6**: functions whose
   override signature contains a dynamic type stay compile-twice under
   `JS2WASM_IR_FIRST=1`. Insurance while the move-only scan is new — a
   scan↔builder divergence demotes benignly instead of becoming a
   skipped-slot hard error. Lift in slice 3/4 with an `ir_first`-lane
   measurement.

5. **from-ast / verify / lower: ZERO changes needed.** The move-shaped
   surface is entirely type-driven through existing code: params take the
   override (`resolveIrType` prefers override when no annotation),
   identifier loads are type-agnostic, the direct-call path checks
   `irTypeEquals(argType, expected)` (dynamic==dynamic exact),
   `coerceReturnValue` passes non-`val` declared results through, and R6
   `returnTypeAssignable` accepts dynamic→dynamic. This is the payoff of
   slice 1 putting `dynamic` in the TYPE lattice instead of minting new
   node kinds.

### Measured facts worth keeping (probes on main @ 4f68ed670)

- **The explicit-`any` annotation path has a REAL fast-mode ABI divergence
  today**: `export function f(x: any): any { return x; }` compiled
  `fast: true` emits `(param externref) (result externref)` on the IR path
  but `(param (ref null $AnyValue))` on the legacy path (`experimentalIR:
false`) — `resolvePositionType`'s AnyKeyword arm predates the mode split.
  WAT-diff evidence in the slice-2 session. `dynamic` does NOT inherit
  this: `resolveDynamic()` mirrors `resolveWasmType`'s mode split, and the
  slice-2 tests assert the claimed function's `func $f` header is
  byte-equal to the legacy header in BOTH modes. Unifying `any` onto
  `dynamic` (slice 3b below) fixes the divergence.
- **The IR claim FIXES a live legacy miscompile**: host-mode legacy
  compiles `function g(x){return x} export function f(x){return g(x)}`
  such that `f("hello")` → null, `f(null)` → 0, `f({a:1})` → garbage
  (legacy call-site/return coercion mangles non-number args through the
  pass-through). The IR-claimed version returns identity for all six
  test values. Expect small test262 IMPROVEMENTS from pass-through-shaped
  helpers, not just neutrality.
- Lattice facts: unannotated params sit at `unknown` unless call-site
  evidence narrows them (propagation flows `g(1)` → g's param f64 — such
  functions claim CONCRETELY, not dynamically, which is why
  `f(){return g(1)}` still claims with zero dynamic involvement).

## Test Results — Slice 2 (2026-07-04, fable-2949)

- `tests/issue-2949-slice2-dynamic-producers.test.ts` — **22/22 pass**:
  claims (identity / pass-through chain / const alias / unused param /
  statement-position dyn call), precision rejections (arith, truthiness,
  property access, mixed returns, dyn→concrete arg, dyn-callee call,
  destructured dyn param — all keep their buckets), run-behavior identity
  across number/string/null/bool/object in host mode, fast-mode compile
  with zero demotions, ABI lockstep (IR `func $f` header == legacy header
  in host AND fast mode; fast carrier is the $AnyValue ref, NOT externref),
  IR-first gate 6 (dynamic claim not skipped, typed sibling still skipped).
- **Zero post-claim demotions** on every claimed shape (asserted in every
  compile test — `irPostClaimErrors` empty).
- **Byte-identity vs main**: `prove-emit-identity.mjs` baseline on clean
  main (4f68ed670), check on branch → IDENTICAL, all 39 (file,target)
  hashes across gc/standalone/wasi. The playground corpus contains no
  claimable unannotated move-only functions, so slice 2 is byte-inert
  there by construction.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket and no
  post-claim entries.
- Related suites: `issue-2949-ir-dynamic-type` (slice 1) 19/19,
  `issue-1228` (any/void selector) 9/9, `ir-frontend-widening` +
  `ir-backend-emitter` pass; `ir-scaffold` has the same 2 failures as
  clean main (pre-existing, verified side-by-side).
- `npx tsc --noEmit` clean; prettier + biome clean.

## Claim-rate measurement — Slice 2, corpus scale (2026-07-04, fable-2949)

Production-exact sweep (captures the `[ir-fallback]` selector telemetry from
real `compile()` calls) over the #2138-style corpus: 287 files = 13 playground
examples + `examples/` + stride-200 test262 sample. Script pattern banked in
the slice-2 session (`.tmp/claim-sweep.mts`, gitignored; STRIDE=200).

| metric                            | main (4f68ed670) | slice 2 | delta                                      |
| --------------------------------- | ---------------- | ------- | ------------------------------------------ |
| files compiled OK                 | 248/287          | 248/287 | 0                                          |
| top-level fns (claim denominator) | 178              | 178     | 0                                          |
| **claimed**                       | **13**           | **13**  | **0 (identical claim SET, per-file diff)** |
| `return-type-not-resolvable`      | 30               | 14      | **−16**                                    |
| `param-type-not-resolvable`       | 3                | 1       | **−2**                                     |
| `body-shape-rejected`             | 50               | 67      | **+17**                                    |
| `destructuring-param-complex`     | 1                | 2       | +1 (re-bucket)                             |
| post-claim demotions              | 0                | 0       | 0                                          |

**The honest reading — the type gate was NOT the binding constraint at
test262 scale; the body-shape gate is.** Unlocking dynamic types converts
type-resolution rejections into shape rejections nearly 1:1 on this corpus
(the −18 type buckets reappear as +17 shape / +1 destructuring); the bodies
that pass Phase-1 shape were mostly typed already. The claim mechanism itself
is proven (targeted tests + equivalence-corpus shapes claim, build, run), but
the audit's "dynamic values make untyped JS claimable" is **necessary, not
sufficient**: the measured claim-rate delta materializes only as (a) slice-3
producers widen past move-only (real bodies USE their params — truthiness,
arith, property access), and (b) the #1370/#2855 shape surface widens. Plan
slice-4's measurement against BOTH levers, and expect the near-term needle to
move from (a).

Risk implication (good news): slice 2's test262/merge-group exposure is
minimal — identical claim sets on the 287-file sample means the behavioral
flips are confined to move-only-shaped helpers (rare in test bodies, more
common in harness-style pass-throughs).

---

## Implementation Plan — Slice 3: dynamic op lowering (Opus-executable)

**Goal**: lower `box{toType: dynamic}`, `unbox{jsTag}`, `tag.test{jsTag}`
so producers can widen past move-only. This replaces the staged
`"… lands in #2949 slice 3"` errors in `lower.ts`.

1. **`IrDynamicLowering` handle** (shape ratified in §4 above): extend the
   layout-handle union in `lower.ts` with
   `{ carrier: ValType, anyValueTypeIdx: number, tagFieldIdx: 0, payloadFieldIdx(jsTag): number }`
   provided by a new `IrLowerResolver.resolveDynamicLowering?()` in
   `integration.ts`. WasmGC fast/standalone: derives from
   `ensureAnyValueType` ($AnyValue = `{tag:i32, i32val, f64val, refval:eqref,
externval:externref}`; payload field by `jsTagUnboxKind`: i32→1, f64→2,
   ref→3 for native refs / 4 for externref-shaped). Host (non-fast): the
   carrier is externref — box/unbox route through the EXISTING
   `__box_number`/`__unbox_number`/classifier import family, NOT struct
   fields. Do not mint a second boxing engine (June-audit D4): every emit
   goes through `emitBox`/`emitUnbox`/`emitTagLoad` on `BackendEmitter`
   (promoted from optional; coordinate with #2953 if still unowned) or the
   `__any_box_*` helper family.
2. **`box(value, dynamic)`**: scalar f64/i32(+bool brand) → struct.new
   $AnyValue with the right tag (fast) / `__box_number`-family (host).
   String/object/closure refs → tag Function/Object/String + refval (fast)
   / `extern.convert_any` (host). Null/undefined singletons per #2106.
3. **`unbox(value, jsTag)`**: fast → `struct.get` payload field AFTER the
   producer's `tag.test` proof (verifier R2 already enforces the field
   discipline); host → `__unbox_number` / cast family.
4. **`tag.test(value, jsTag)`**: fast → `struct.get tag` + `i32.eq`
   (Null/Undefined test via tag too); host → classifier import
   (`__typeof`-family) — reuse the tag-5 field-4 three-way classifier rules
   (memory `reference_2040_tag5_field4_three_way_classifier`).
5. **R6 hardening (REQUIRED before any producer emits ref→dynamic)**: the
   verifier currently PASSES ref-shaped→dynamic returns (slice-1 doc), but
   the LOWERING of that flow is only valid with an explicit box (a bare
   `(ref $C)` is not a $AnyValue subtype; in host mode it needs
   `extern.convert_any`). Slice 3 must either make the verifier reject
   un-boxed ref→dynamic returns or teach `coerceReturnValue` a dynamic arm
   that emits the box. Slice 2 never produces this flow (the move-only
   scan rejects it) — do not widen the scan before this lands.
6. **Producer widening** (same PR or a follow-up, each with its own
   claim-rate delta): `if (x)` truthiness via tag.test+unbox; `x === lit`
   via tag.test; `return <concrete>` under dynamic return via box;
   concrete-arg → dyn-param via box; `typeof x` via tag read. Each widening
   is a `dynamicUsesAreMoveOnly` arm flip + a from-ast lowering arm — keep
   the scan and the builder in lockstep (they are the same capability row,
   #2135).
7. **Lift gate 6** (`computeIrFirstSkipSet`) only after an `ir_first`-lane
   test262 run shows zero dynamic-claim build demotions.

**Verification protocol**: prove-emit-identity (39-hash corpus) must stay
IDENTICAL for any slice that adds only lowering arms (no producer change);
each producer widening re-runs the claim sweep (below) + full CI.

## Implementation Notes — Slice 3 (fable-2949s3, 2026-07-04, branch `issue-2949-slice3-lowering`)

Slice 3 ships the **lowering substrate**: the three staged `"lands in #2949
slice 3"` errors in `lower.ts` are replaced with real arms, driven by a new
`IrDynamicLowering` handle. **Producer-free and byte-inert by construction**
(prove-emit-identity: all 39 (file,target) hashes IDENTICAL vs main
`cf2fb1c40`); the move-only scan, gate 6, and the zero-demotion invariant are
untouched. Decisions and the WHY:

1. **Handle shape** (`backend/handles.ts` `IrDynamicLowering`): the ratified
   §4 record (`carrier`/`anyValueTypeIdx`/`tagFieldIdx`/`payloadFieldIdx`)
   PLUS emit-time op-sequence methods (`emitBox`/`emitUnbox`/`emitTagTest`)
   in the proven `emitStringConcat` resolver-emit style. The emitter-trait
   trio (`emitBox?` on `BackendEmitter`) was NOT promoted — the union arms it
   was declared for still go through `pushRaw`, and rerouting both families
   is #2953's surface; the handle exposes the gc layout so that migration
   can consume it later. FuncIdx values are resolved BY NAME at emit time
   (never captured at handle creation) — the #2191/#2193 repoint discipline.
2. **gc strategy boxes via `boxToAny` itself** (a body-only FunctionContext
   shim), not a re-derived helper choice — ONE kind→tag policy for legacy
   and IR (D4), including the #42 native-string re-tag arm and the
   `honestAnyBoxing` flag, for free. Unbox routes through the CANONICAL
   readers `__any_unbox_f64` / `__any_unbox_i32` (not raw `struct.get`) for
   the number partitions.
3. **V2 numeric-class deviation from the plan sketch (deliberate)**: plan
   step 4 said `tag.test` = `struct.get tag + i32.eq` (exact). But the host
   carrier CANNOT split NumberI32/NumberF64 (`typeof` has one "number") —
   exact gc tests would make producer decision trees mode-divergent (host
   `tag.test(NumberI32)` true for 0.5, gc false). So `tag.test` on EITHER
   number partition is the CLASS test in both strategies (gc:
   `(tag−2) ≤u 1`, host: `__typeof_number`), per js-tag.ts's V2 invariant
   ("consumers must treat {2,3} as a single class"); the payload choice
   lives in the UNBOX tag (F64 → V2-safe f64 read; I32 → trunc-sat).
4. **Box refinement hint**: `box{toType: {kind:"dynamic", tag}}` maps the
   refinement onto `boxToAny`'s `jsType` hint (same "never override
   representation" contract). Load-bearing case: Boolean-refined i32 boxes
   tag-4 (`__any_box_bool` / `__box_boolean`) — without it i32 always boxes
   as a NUMBER (legacy unbranded parity), and `true` would round-trip as
   `1`. Producers that know the partition MUST refine the box target.
5. **R6 hardening = verifier rejection**, not auto-box: `returnTypeAssignable`
   now accepts ONLY dynamic (bare or refined) into a dynamic declared
   result. Auto-boxing in `coerceReturnValue` was rejected because box is a
   PRODUCER decision (the scan must mirror it 1:1 — see note 7) and a silent
   coercion would let scan/builder drift compile. Zero-delta today: the
   move-only scan never produces the flow. Dual direction (dynamic value →
   externref-val declared result) unchanged.
6. **Host `Object` tag.test needs two reads** (`typeof === "object" &&
!ref.is_null` — host `typeof null === "object"` but Null is its own
   partition), so `emitTagTest` takes a lazy scratch-local allocator;
   `lower.ts` allocates one carrier-typed local per function (`$dyn_tag_
scratch`, same pattern as the bitwise/vec scratches). gc arms never use
   it. Host `Null` test is `ref.is_null` (JS null IS the null externref;
   undefined is a non-null host value).
7. **Producer widening DESCOPED from this PR — with a load-bearing lattice
   finding**: the planned "mixed return boxes the concrete arm" producer is
   mostly VACUOUS as specced, because `join(unknown, number) = number` in
   propagate.ts — `f(x){ if(c) return x; return 0; }` types its return
   CONCRETE f64 (the optimistic no-evidence join), NOT dynamic. The scan
   correctly rejects that shape today (dyn value into concrete result), and
   the type-honest fix is a **soundness-driven return-WIDENING slice**
   (selector + `resolvePositionType` symmetry: any dyn-shaped return arg ⇒
   return verdict dynamic ⇒ box the concrete arms), not a bolt-on box in
   `coerceReturnValue`. Only the rare lattice-TOP population (union-cap
   overflow params) hits "literal return under dynamic verdict" as written.
   Widening the scan for that sliver risks the zero-claim-then-demote
   invariant (load-bearing under JS2WASM_IR_FIRST) for ~no claim delta, so
   slice 3 lands the substrate only; the widening family (truthiness via
   tag.test+unbox, return-widening + box, concrete-arg→dyn-param box) is
   the follow-up producer slice with its own claim-sweep evidence.
8. **Registration discipline**: `preregisterDynamicSupport` walks the IR
   (deep, `forEachInstrDeep`) BEFORE Phase 3 and registers the full backing
   (fast: `ensureAnyHelpers`; host: `addUnionImports`) so no emit can
   trigger a mid-emission funcIdx shift (#329/#2078 class). Both entry
   points are idempotent.
9. **Known hazards banked for the producer slice** (documented in the
   handle docs too): (a) a wasm-null gc carrier TRAPS in `tag.test`/`unbox`
   `struct.get` — producers must null-guard or normalize at entry
   (coherent with #2106 S1's $undefined singleton, tag 1 — same table,
   suspended, no live interlock: verified `issue-2106` is backlog/resume-
   only, `$undefined`reservation in`ensureAnyValueType`matches`JsTag.Undefined = 1`); (b) `unbox(String)`yields the extern-shaped
payload (externref) in BOTH modes — native-string consumers need a
convert+cast op that lands with the first string-consuming producer;
(c)`tag.test(Function)` is mechanical (tag 7) but closures BOX AS
   tag-6 Object today — no producer may emit Function tests until #2963
   Phase 1 reifies function values (host/gc would diverge on them).

## Test Results — Slice 3 (2026-07-04, fable-2949s3)

- `tests/issue-2949-slice3-dynamic-lowering.test.ts` — **16/16 pass**,
  including REAL RUNTIME execution of both strategies (a first for the
  box/unbox/tag.test arms; the union V1 arms were only ever instr-level):
  hand-built IrFunctions lowered against the PRODUCTION `makeDynamicLowering`
  over a real `CodegenContext` (real `ensureAnyHelpers` / `addUnionImports`
  registration), production `emitBinary`, instantiated and executed.
  - gc (fast + js-string config): box→unbox f64 identity (incl. −0, NaN),
    V2 cross-tag reads (i32 box → f64 unbox; f64 box → trunc-sat i32),
    Boolean-refined box → tag-4 proof, numeric-CLASS tag.test from BOTH
    partition tags, negative tags (String/Null on numbers, Number on bools).
  - host: real JS values through dynamic params — String/Object(excl.
    null!)/Null-vs-Undefined/Number/Function classifiers, `__box_number`/
    `__unbox_number` round-trip, Boolean unbox.
  - handle-contract: payload-field table (1/2/3/4 + singleton throws),
    canonical-family routing (D4), V2 class-test equality across partition
    tags, carrier↔resolveDynamic lockstep, host scratch protocol.
  - failure modes: missing/null `resolveDynamicLowering`, jsTag backstops.
  - R6: string→dynamic return REJECTED, box→return clean, dyn/refined-dyn
    moves clean, scalar→dynamic still rejected.
- `tests/issue-2949-ir-dynamic-type.test.ts` 19/19 (one staged-error
  expectation updated to the new missing-resolver contract error),
  `issue-2949-slice2-dynamic-producers` 22/22, `issue-2104-value-tags`,
  `backend-contract` — 62/62 across the four suites.
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline on clean
  main (`cf2fb1c40`), check on branch → **IDENTICAL, all 39 (file,target)
  hashes** across gc/standalone/wasi.
- `pnpm run check:ir-fallbacks` — OK, zero delta, no post-claim entries
  (no selector/producer change, as designed).
- Adjacent IR suites (`tests/ir/`, `ir-frontend-widening`,
  `ir-backend-emitter`, `ir-scaffold`): 164/173; the 9 failures
  (`ir-scaffold` 2, `ir/passes` 4, `ir/inline-small` 3) reproduce with the
  IDENTICAL counts on clean main `cf2fb1c40` run side-by-side — pre-existing,
  unrelated (ir-scaffold's 2 were already recorded in the slice-1/2 notes).
- `npx tsc --noEmit` clean.

## Implementation Plan — Slice 3b: unify explicit `any` onto `dynamic`

`resolvePositionType`'s AnyKeyword arm (`codegen/index.ts:592`) and the
selector's `"any"` kind currently map `x: any` to **externref in ALL
modes**, which diverges from legacy's fast-mode $AnyValue ABI (measured,
see slice-2 notes — a claimed `f(x: any): any` has a DIFFERENT fast-mode
signature than its legacy callers expect). Change both arms to `dynamic`
(and delete the `"any"` ResolvedKind) once slice 3's box/unbox lands, so
`any`-annotated and unannotated positions are the same type. **Blast
radius**: currently-claimed any-functions change fast-mode signatures
(that's the FIX) and host-mode stays byte-equal (dynamic lowers to
externref there). Needs: the #1228 tests updated, a fast-mode cross-call
probe (legacy caller → IR callee), and full CI. Do NOT fold into slice 3's
lowering PR — separate, revertible.

## Implementation Notes — Slice 3b (fable-2949s3, 2026-07-04, branch `issue-2949-slice3b-any-unification`, stacked on slice 3)

Ships as planned: `resolvePositionType`'s AnyKeyword arm → `irDynamic()`
(codegen/index.ts), the selector's AnyKeyword arms → `"dynamic"`, and the
`"any"` ResolvedKind is DELETED. Findings beyond the plan:

1. **`any[]` element preservation**: the AnyKeyword flip would have made
   `resolvePositionType(any[])`'s element resolution return `dynamic` →
   `null` elemVal → previously-claimed `any[]` functions silently drop to
   legacy. Added an explicit `dynamic → externref` element arm in the
   ArrayTypeNode case (element rep is #2379/#1852 territory, not 3b) —
   byte-preserving, probe-verified. (Separately: the fast-mode any[]
   IR-vs-legacy header divergence — legacy narrows to a different vec
   type + i32 result — is PRE-EXISTING on main, probe-verified
   side-by-side, untouched here.)
2. **The plan's "fast-mode cross-call probe (legacy caller → IR callee)"
   is unconstructible for top-level calls** — pinned in the tests: the
   selector's call-graph-closure rule EVICTS a claimable any-callee when
   a non-claimable function calls it, so mixed legacy→IR top-level edges
   cannot exist. The ABI unification's cross-front-end exposure is the
   export boundary, class-method claims (the typeIdx-parity guard now
   MATCHES legacy in fast mode instead of demoting), and future producer
   widenings. A future call-graph relaxation must revisit the ABI story —
   the pinning test will fire.
3. **Claim-then-demote channel closed**: the old `"any"` kind claimed
   every any-param function unconditionally (from-ast threw on non-move
   uses → post-claim demotion, NOT covered by gate 6 pre-3b since the
   signature carried externref, not dynamic). Now any-annotated functions
   run through `dynamicUsesAreMoveOnly` pre-claim (e.g. `a === b` on any
   params: was claim→demote, now a clean `param-type-not-resolvable`
   rejection) AND gate 6 covers the claims (dynamic signature ⇒
   compile-twice under IR_FIRST).
4. Byte-inert on the 39-hash corpus (no claimed any-functions there);
   the behavior change is confined to any-annotated IR claims — fast-mode
   signatures now equal legacy's (the FIX), host-mode bytes unchanged.

## Test Results — Slice 3b (2026-07-04, fable-2949s3)

- `tests/issue-2949-slice3b-any-dynamic.test.ts` — **8/8**: #1228 surface
  stays claimed; `===`-on-any rejects PRE-claim with the scan's bucket;
  mixed any/unannotated chains claim; host header parity (unchanged) and
  **fast header parity — the FIX** (`func $f` == legacy's, NOT externref);
  call-graph-closure eviction pinned; host-mode runtime identity across
  number/string/null/undefined/bool/object; any[] claim + host header
  parity + fast zero-demotion compile.
- `tests/issue-1228.test.ts` 9/9 UNCHANGED (the `===` fallback test passes
  via the new pre-claim rejection instead of post-claim demotion).
- Slice 1/2/3 suites: 74/74 combined. `check:ir-fallbacks` OK, zero delta.
- `prove-emit-identity` vs main baseline: IDENTICAL (39/39) — corpus has
  no claimed any-functions; drift is confined to the intended population.
- `npx tsc --noEmit` clean.

## Banked adoption slices (unlocked by this substrate; Opus-tier)

### A. #2963 Phase 2 — any-callable scalar-param dispatch

Phase 2 is blocked on value-call dispatch mis-selecting same-ARITY
candidates for scalar-param reified builtins (`Number.isInteger` traps —
see #2963 "value-call-path blocker"). The substrate fix: a function value
held dynamically is a **Function-tagged dynamic value whose refval is the
closure struct**; call sites recover it by `tag.test(Function)` +
`unbox(Function)` + `ref.test` against candidate closure types keyed on
the EXACT static closure type (param ValTypes), not arity. Land as: (1)
key `__callable_param_*` candidate selection (`expressions/calls.ts`
~13230–13640) on closure struct typeIdx recovered via `ref.test` chains;
(2) once slice 3's unbox exists, route the externref-widened `const f = …`
read through the dynamic carrier instead of raw externref so the tag is
available. Acceptance: `const f = Number.isInteger; f(4)` → true,
standalone, no trap, no `__get_builtin`.

### B. #2984 buckets (1)+(2) — gOPD on builtins (method-value reification)

Measured verdict in #2984: descriptor SHAPE is fixed; the residual gap is
that `descriptor.value` for a builtin method is a **non-first-class
placeholder** (path-dependent `typeof`, non-invocable, non-canonical).
The substrate answer: a builtin method VALUE is the #2963 Phase-1
singleton closure, carried as a Function-tagged dynamic value. Slices:
(1) descriptor `.value` writes store the singleton (identity `===
Array.prototype.forEach` holds by the singleton property); (2) `.value`
reads produce the dynamic carrier so `typeof` reads the Function tag
(fixes the inline-vs-const instability — same read path everywhere); (3)
invocation `d.value.call(arr, cb)` = the same recovery as slice A +
thisArg threading (slice C). Bucket (2)'s ctor-receiver CE retires when
the `__get_builtin` fallthrough in `property-access.ts` can instead
materialize the singleton value. Do NOT attempt a descriptor-layer-only
fix (re-breeds the placeholder — #2984's explicit warning).

### C. `.call`/`.apply` on a closure VALUE (the #3015/#3016 residual family)

Two known concrete defects, both "function value lost its callable type":

- `identifier.call(...)` handler (`src/codegen/expressions/calls.ts`
  ~L4831): when the receiver identifier is a closure-typed local, the
  lowering DROPS thisArg and mis-dispatches; with the dynamic carrier the
  receiver read keeps the Function tag and `.call` lowers to unbox →
  closure-struct invoke with explicit thisArg prepend.
- property-access `.call` (e.g. `d.get.call(obj)` from a descriptor):
  there is NO closure-value recovery path today — the value arrives as
  opaque externref. Same recovery as slice A; the descriptor read (slice
  B step 2) must produce the tagged carrier first.
- #3015 (`arr.some(cb)` where cb is a dynamic function-typed param):
  prefer its Direction 1 (preserve the closure struct through argument
  evaluation) for the TYPED-param case — no dynamic carrier needed; the
  dynamic carrier is the answer only for genuinely-untyped callbacks
  (post-slice-3 unbox to closure). Don't conflate the two in one PR.

### Sequencing

slice 3 (lowering) → {slice 3b (any unification), A (#2963 P2)} → B/C in
either order (both consume A's recovery helper). Producer widenings (step 6) can proceed in parallel with A–C once slice 3 lands. Each slice: own
PR, own claim-rate/CE-delta measurement, prove-emit-identity for
untouched lanes.

## Implementation Notes — Slice 4: return-widening measured VACUOUS-ADJACENT; do NOT ship in isolation (opus-2949s4, 2026-07-04, branch `issue-2949-s4-return-widening`)

**Verdict: the isolated return-widening producer has a measured claim delta
of ~0 at test262 scale and must NOT be shipped alone.** It is a necessary
CO-REQUISITE of the dynamic-use-in-body producer family (step 6), not an
independent slice. Landing it in isolation would be dead codegen carrying a
load-bearing scan↔builder 1:1-lockstep obligation (drift = a
`JS2WASM_IR_FIRST` skipped-slot hard error) for zero payoff. Evidence,
mechanism, and the corrected next step below.

### What "return-widening" was specced to do (and why it can't fire alone)

Slice-3 note 7 flagged the specced "mixed-return box producer" as vacuous
because `join(unknown, number) = number`. The honest correction was a
return-WIDENING slice: _any dyn-shaped return arg ⇒ widen the return verdict
to `dynamic` ⇒ box the concrete return arms_. The target population is a
function like `f(x){ if(c) return x; return 0; }` (x an unannotated → dynamic
param): one arm moves a dynamic value, another returns a concrete literal, and
the join **collapses** the return to concrete `f64` so the slice-2 move-only
scan rejects `return x` (dyn into concrete result).

**Source-confirmed collapse** (`src/ir/propagate.ts:840-842`): `join` is
`dynamic ∨ x = dynamic` (840), but `unknown ∨ concrete = concrete` (841-842,
the optimistic no-evidence arm). A dyn (=`unknown`) param arm joined with a
concrete co-arm yields the concrete type — the return is NEVER lattice-dynamic
from this mix. And two _distinct concrete_ arms join to `union`
(propagate.ts:872), which is #2135's tagged-union rows, not the dynamic
carrier. So a return is lattice-`dynamic` **only** when an arm is already
dynamic (union-cap-overflow params) — the "rare sliver" slice-3 named.

### Measurement (three independent probes, banked in `.tmp/`)

1. **AST shape ceiling** (`widening-ceiling2.mts`, over-approximation — ignores
   body-shape / call-graph gating): across **4452 files** (playground + test262
   stride-12), **5295** functions, **928** with an unannotated param, only
   **8** match the widening shape (≥1 dyn-move return + ≥1 concrete return) —
   0.18% of unannotated-param functions, ~1 per 556 files.

2. **Real-selector on those candidates** (`real-selector-probe.mts`, production
   `planIrCompilation`): EVERY reachable candidate rejects for a reason
   return-widening cannot convert:
   - `nextUp`/`nextDown` (Temporal precision test) → `body-shape-rejected`
     (`nontail-if-cond:PrefixUnaryExpression`; also `new Float64Array`, BigInt,
     element stores) — never reaches the type gate.
   - `handleGet` (Locale getter-order) → `body-shape-rejected`.
   - `callbackfn` (`Array.prototype.reduce` test) → `param-type-not-resolvable`,
     but NOT because of its mixed `return curVal;`/`return false;` — because the
     body USES the dyn params non-trivially (`idx > 0`, `obj[idx] === curVal`,
     `obj[idx-1] === prevVal`): comparison + property access on dynamic values,
     which need the slice-3 unbox producers (`tag.test`+`unbox`), NOT
     return-widening.

3. **Corpus aggregate** (`widening-aggregate.mts`, production selector over a
   test262 stride-40 sample): the intersection {functions rejecting on
   `param-/return-type-not-resolvable`} ∩ {functions with the widening shape}
   is an OVER-count of the true flip set (a member may reject for a body-use
   reason, not the return arm). It read **0** in the sampled prefix (stable
   through 500 files before a probe-perf timeout: claimed=4, type-rejects=11,
   widen-intersect=**0** throughout), consistent with the ~8-per-4452 ceiling
   density. Crucially, even the ~8
   ceiling members corpus-wide (incl. `callbackfn`) are each blocked by a
   NON-return cause per probe 2 — so the _true_ return-widening flip set (return
   arm is the SOLE blocker) is **empty** on this corpus, which is the decisive
   number, not the aggregate's sampled 0.

**Honest reading:** this is not the fully-vacuous case (the box producer, which
never fired) — the shape does exist (~8 ceiling). It is _vacuous-adjacent_: the
surviving population after body-shape + move-only gating is empty, because any
function with a dyn param that also mixes returns invariably USES that param in
the body (comparison/arith/property access), and that use is the binding
blocker — exactly the slice-2 finding ("the body-shape/use gate is the binding
constraint, not the type gate") applied to producers.

### Why NOT ship an isolated byte-inert substrate

- To be byte-inert it must claim ZERO functions (else the widened function's
  Wasm signature flips `f64`→dynamic carrier at the export/caller boundary).
  Claiming zero ⇒ the new scan-arm + from-ast box-producer are dead code.
- That dead code still carries the **load-bearing** obligation that the
  selector's widening decision and the from-ast box producer agree 1:1 (a
  claimed-then-demote under `JS2WASM_IR_FIRST` is a skipped-slot hard error;
  the box is a PRODUCER decision per slice-3 note 5 — no silent
  `coerceReturnValue` auto-box). Maintaining that lockstep for no claim is
  pure liability.
- Slice-3 note 7 already prescribed this: the widening family lands WITH its
  use-producer siblings, measured together — not as an isolated sliver.

### Corrected next step (the real lever)

Return-widening is a **co-requisite** of, and must be bundled into, the
**dynamic-use-in-body producer slice** (this issue's step 6): truthiness
`if (x)` and `x ? a : b` via `tag.test`+`unbox`; comparison `x === lit` /
`x > lit` via `tag.test`(+unbox); property access `x.p` / `x[i]` via dynamic
read. Those producers are what the reachable population (`callbackfn` and the
bulk of real untyped-JS bodies) actually needs; a function unblocked by them
that ALSO returns a concrete arm alongside a dyn arm then needs the return box —
so return-widening rides along, measured against the SAME claim sweep, with the
signature-flip exposure validated in one full-CI pass rather than for a
zero-delta sliver. Recommend re-scoping step 6 as one XL producer slice
(architect pass first — it overlaps the `select.ts` move-only scan +
`from-ast` lowering region that #3000-1b's `buildIrClassShapes` work also
touches; coordinate). The isolated "return-widening only" task is closed as
**wont-fix-in-isolation** with this evidence.

---

## Implementation Plan — Slice 5: dynamic-use-in-body producer (architect-ratified, 2026-07-05)

This is the s4-mandated re-scope of step 6 into landable, independently-
verifiable sub-slices. It is the **claim-rate lever** for the whole issue:
s4 PROVED that isolated return-widening is vacuous because the return arm is
never the sole blocker — every reachable candidate is ALSO blocked by a
non-move dynamic body-USE (`callbackfn`: `idx > 0`, `obj[idx]`,
`obj[idx] === curVal`). So the producer that matters is the one that lowers
dynamic VALUE USE in the body, with return-widening bundled in.

### 0. What the current tree already provides (grounding, upstream/main @ read-time)

Before writing any code, note the substrate slices 1–3 already landed — this
slice is mostly **wiring existing pieces**, not building box/unbox from
scratch:

- **The node-level lowering is DONE** (`src/ir/lower.ts` cases `"box"`
  ~L1231, `"unbox"` ~L1288, `"tag.test"` ~L1331). They are real (not staged
  errors), driven by `resolver.resolveDynamicLowering()` →
  `IrDynamicLowering` (`src/ir/backend/handles.ts:197`), backed by
  `$AnyValue` / `__any_box_*` / `__any_unbox_*` (gc) and
  `__box_number` / classifier imports (host). `$dyn_tag_scratch` is already
  allocated per-function in `lower.ts` (~L827).
- **The `IrType.dynamic` lattice + verifier R1–R6** are enforced
  (`src/ir/verify.ts`): dynamic operands may ONLY feed box/unbox/tag.test
  and moves; **R4 forces an explicit `unbox` before any `binary`/`unary`**
  (verify.ts ~L1061); `if.stmt`/loop `condValue` must be i32 (structural
  backstop). The producer therefore MUST unbox/ToBoolean a dynamic operand
  down to a concrete ValType before feeding it to any scalar op or branch —
  the verifier is the hard backstop that makes a producer bug fail loudly.
- **The move-only selector gate** (`src/ir/select.ts`
  `dynamicUsesAreMoveOnly` ~L1178) is the ONLY thing rejecting these bodies:
  `if(x)`/`x===lit`/`x>lit`/`obj[idx]` all pass `isPhase1StatementList`
  (they are ordinary Phase-1 shapes), reach the move-only gate, and fail it
  → bucket `param-type-not-resolvable` (or `return-type-not-resolvable`,
  select.ts ~L925). **That bucket is exactly what this slice drains.**

**What is MISSING (the work of this slice):**

1. `src/ir/builder.ts` has **NO** `emitBox`/`emitUnbox`/`emitTagTest`
   methods (grep: 0 hits) — producers cannot construct the nodes yet.
2. `src/ir/from-ast.ts` has no dynamic arm in `lowerBinary` (~L5218),
   `lowerElementAccess` (~L2579), `lowerPropertyAccess` (~L2200),
   `lowerConditional` (~L4993), nor in the `if`/`while`/`for`/`do` condition
   paths (~L945, `coerceLoopCondToBool` ~L4028).
3. `IrDynamicLowering` exposes `emitBox`/`emitUnbox`/`emitTagTest` but **not**
   the higher-level carrier ops the body-uses actually need (see §1).
4. `select.ts` `dynamicUsesAreMoveOnly` rejects every body-use.

### 1. Architectural correction to the s4/step-6 framing: route through the CANONICAL carrier helpers, not hand-rolled tag.test chains

s4 wrote the forms "via `tag.test`+`unbox`". That is the RIGHT primitive for
a **known-literal fast path**, but it is NOT the D4-compliant lowering for the
general case, and the general helpers ALREADY EXIST in the codegen layer:

- **Truthiness** `ToBoolean(dyn) → i32`: `emitToBoolean` in
  `src/codegen/coercion-engine.ts:383`. For the boxed-any carrier it emits
  `__any_unbox_bool` (gc `ref null $AnyValue`) / `__is_truthy` (host
  externref) — proper JS truthiness (`0`/`NaN`/`""`/`null`/`undefined` →
  falsy), one call, both modes.
- **Strict/loose equality** `dyn === x → i32`: `__any_strict_eq` /
  `__any_eq` (coercion-engine `emitAnyEqOperands` + `emitStrictEq`/
  `emitLooseEq`, ~L440+), which take two carrier operands. `dyn === lit` =
  box the literal to the carrier (box lowering already exists) + call the
  helper. `dyn === dyn` = both already carriers.
- **Relational** `dyn > lit → i32`: `emitToNumber` (coercion-engine) on the
  dyn side → `f64.gt` (the numeric-abstract-relational common case), with
  the string×string arm deferred (see S5.3 scope).
- **Property access** `dyn[i]` / `dyn.p`: the dynamic member-read MOP. This
  is the ONE form with no clean single-helper carrier op today — it is the
  `$Object` dynamic-reader substrate (memory
  `project_standalone_any_string_value_read_substrate`). Treat it as the
  heavy, substrate-adjacent sub-slice (S5.4).

**Decision:** add these as new methods on `IrDynamicLowering`
(`emitToBoolean(): Instr[]`, `emitStrictEq(negate): Instr[]`,
`emitToNumber(): Instr[]`, and — S5.4 — `emitMemberGet(...)`), each produced
by `integration.ts`'s `makeDynamicLowering` by routing to the SAME
coercion-engine functions legacy uses (pass the body-only `FunctionContext`
shim already used for `boxToAny` in slice 3, per that slice's note 2). This
keeps ONE ToBoolean/equality/ToNumber engine (D4) and guarantees IR-claimed
and legacy functions agree byte-for-byte on these coercions. `tag.test`+`unbox`
remains available and is the right lowering only when a producer statically
knows the literal's partition AND wants to skip the general dispatch — NOT the
default; do not hand-roll it in from-ast for the general arms.

### 2. The conjunction problem — why sub-slices split mechanism-from-producer

s4's reachable exemplar (`callbackfn`) needs truthiness-adjacent + relational

- property-access + dyn×dyn-eq **simultaneously**; a function claims only when
  EVERY dynamic body-use is handled. Therefore a per-form _producer_ (scan-arm
  flip) will measure a claim delta of ~0 until the last form its reachable
  population needs also lands — the exact vacuity trap s4 hit. To stay landable
  without shipping dead lockstep-bearing code, decompose along the
  **mechanism / producer** seam, mirroring how slices 1–3 already split
  (lowering landed byte-inert; producers landed separately):

* **Mechanism sub-slices (S5.0–S5.4): byte-inert, unit-proven, no scan
  change.** Each adds the handle method + builder emit + from-ast lowering
  arm for one form, but leaves `dynamicUsesAreMoveOnly` REJECTING it. So
  from-ast never sees the form in a claimed function yet → **zero compiled
  output changes** → self-proof is `prove-emit-identity.mjs` IDENTICAL (39
  hashes) PLUS slice-3-style unit tests that hand-build the IR and EXECUTE
  it against the production lowering. No claim, so no `JS2WASM_IR_FIRST`
  lockstep liability (the s4 hazard is specifically a _claiming_ producer
  with dead scan lockstep — a lowering-only slice has none).
* **Producer sub-slice (S5.P): flips the scan arms for the landed forms
  together + bundles return-widening + boxes concrete arms.** This is the
  ONLY slice that changes claims, gated on a reachability probe (§4), and it
  carries the real claim-rate measurement and full CI. It may split into
  ≥1 producer PR IF the reachability probe (§4) finds a non-empty
  single-form flip set; default is one bundling producer.

This ordering means the hard, reviewable lowering lands first (small, green,
byte-inert PRs), and the risky claim-flip lands last as one measured,
full-CI PR — the inverse of shipping a byte-inert producer that claims 0.

### 3. Sub-slice sequence

Each mechanism slice: own PR; branch from `upstream/main`; `emitBox`-family
plumbing (S5.0) is the shared dependency, land it first. Collision surface is
`from-ast.ts` + `handles.ts` + `integration.ts` + `builder.ts` (additive arms
only) for S5.0–S5.4, and `select.ts` `dynamicUsesAreMoveOnly` for S5.P — the
same region #3000-1b/C/E (merged) and slices 2/3 touched, so land the
mechanism PRs first and rebase S5.P onto them.

#### S5.0 — builder emit plumbing (foundation, byte-inert)

- **Files/functions:** `src/ir/builder.ts` — add `emitBox(value, toType)`,
  `emitUnbox(value, jsTag)`, `emitTagTest(value, jsTag)` (append the
  respective `IrInstrBox`/`IrInstrUnbox`/`IrInstrTagTest`; result type:
  box→`toType`, unbox→`irVal` of the partition payload ValType via
  `jsTagUnboxKind`, tag.test→`irVal i32`). `typeOf` already covers them.
- **Lowering change:** none (nodes already lower).
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity.mjs` IDENTICAL (39/39); a unit test
  builds a box→tag.test→unbox round-trip and executes it (gc + host), proving
  the builder emits verifier-clean nodes that lower and run. `tsc` clean.
- **Anti-vacuity:** N/A (pure plumbing; its consumers are S5.1–S5.4).

#### S5.1 — truthiness lowering (mechanism, byte-inert)

- **Files/functions:** `handles.ts` `IrDynamicLowering` + `integration.ts`
  `makeDynamicLowering`: add `emitToBoolean(): Instr[]` routing to
  `coercion-engine.emitToBoolean` for the carrier (`__any_unbox_bool` gc /
  `__is_truthy` host). `builder.ts`: `emitDynTruthy(value): IrValueId`
  (i32 result) emitting a new `IrInstrDynTruthy` (or reuse `unbox{Boolean}`
  only if the operand is Boolean-refined — but general truthiness is NOT
  Boolean-unbox, it is ToBoolean, so a dedicated node/handle op is required;
  add `IrInstrDynTruthy{value}` → i32, lowered via the new handle method).
  `from-ast.ts`: in the `if` (~L945), `while`/`for`/`do` condition paths and
  `coerceLoopCondToBool` (~L4028) and `lowerConditional` (~L4993) condition,
  when `typeOf(cond).kind === "dynamic"`, emit `emitDynTruthy` instead of the
  current "must be i32" throw.
- **Scan-arm change:** none (scan still rejects a dyn condition; from-ast arm
  is exercised only by unit tests until S5.P).
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit test executes
  `function f(x){ if(x) return 1; return 0; }`-shaped hand-built IR over gc +
  host and asserts JS truthiness for `0/NaN/""/null/undefined/{}/"a"/5`.
- **Anti-vacuity:** deferred to S5.P; this slice claims nothing by design.

#### S5.2 — strict/loose equality lowering (mechanism, byte-inert)

- **Files/functions:** `handles.ts`/`integration.ts`: `emitStrictEq(negate):
Instr[]` and `emitLooseEq(negate)` routing to `coercion-engine`'s
  `__any_strict_eq`/`__any_eq` (both operands carrier-shaped). `builder.ts`:
  `emitDynEq(lhs, rhs, {negate, loose})` → i32. `from-ast.ts` `lowerBinary`
  (~L5218): for `===`/`!==`/`==`/`!=` when either operand is dynamic — box
  the concrete operand to the carrier (existing `emitBox{toType:dynamic}`,
  refining the box tag from the literal's kind where known), leave dyn
  operands as-is, emit `emitDynEq`. `dyn === null` / `dyn === undefined`
  lower via `tag.test{Null|Undefined}` (the payload-less partitions —
  cheaper and exact) rather than the general helper.
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit tests execute
  `dyn === 5`, `dyn === "s"`, `dyn === null`, `dyn === undefined`,
  `dyn === true`, and `dyn === dyn` over gc + host, asserting SameValue/`===`
  semantics incl. cross-type falsity (`"5" === 5` → false).
- **Anti-vacuity:** deferred to S5.P.

#### S5.3 — relational lowering (mechanism, byte-inert)

- **Scope:** numeric-abstract-relational only (`dyn </<=/>/>= lit|dyn` via
  `ToNumber` → `f64` compare). The string×string relational arm is DEFERRED
  (needs the native-string compare path; a dyn operand whose runtime tag is
  String falls back through ToNumber = NaN, i.e. all-false — spec-correct for
  `"a" > 0` but WRONG for `"b" > "a"`; so restrict producer admission in
  S5.P to relational against a NUMERIC literal, where ToNumber(dyn) vs number
  is spec-complete, and reject dyn-string-relational to keep correctness).
- **Files/functions:** `handles.ts`/`integration.ts`: `emitToNumber():
Instr[]` routing to `coercion-engine.emitToNumber` (carrier → f64).
  `builder.ts`: `emitDynToNumber(value)` → f64. `from-ast.ts` `lowerBinary`
  relational arm: `emitDynToNumber` on dyn operand(s), then the existing
  `f64.lt`/`gt`/… path.
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit tests execute
  `dyn > 0`, `dyn <= 10` for number/bool/null (→0)/undefined(→NaN→false)
  carriers over gc + host.
- **Anti-vacuity:** deferred to S5.P.

#### S5.4 — dynamic member read (mechanism, byte-inert, substrate-adjacent — HEAVIEST)

- **Scope + risk:** `dyn[i]` / `dyn.p` is the general MOP on an arbitrary any
  value — the `$Object` dynamic-reader substrate. This is where the reachable
  population's real weight sits (`obj[idx]`), and it is the sub-slice most
  likely to need its own architect pass / to be split further. Route through
  the SAME legacy any-member helper the codegen layer uses (identify the
  concrete import in `src/codegen/property-access.ts` / `object-ops.ts`; if
  none is cleanly reusable, this sub-slice is BLOCKED on a substrate helper
  and must be filed as a dependency, NOT hand-rolled — see the substrate
  memory notes). Element index that is itself dynamic (`obj[idx]` with `idx`
  dynamic) needs `ToPropertyKey(dyn)` first — bundle or defer per the helper's
  signature.
- **Files/functions:** `handles.ts`/`integration.ts`: `emitMemberGet(name?)`
  / `emitElementGet()` routing to the legacy any-member reader. `builder.ts`:
  `emitDynMemberGet(recv, key)` → dynamic. `from-ast.ts` `lowerPropertyAccess`
  (~L2200) / `lowerElementAccess` (~L2579): dynamic-receiver arm.
- **Scan-arm change:** none.
- **Acceptance:** `prove-emit-identity` IDENTICAL; unit tests execute
  `dyn.length`, `dyn[0]`, `dyn["k"]` over host (gc where the substrate reader
  exists) asserting value + tag preservation (the substrate's known
  drop-native-string-value hazard MUST be covered — reference
  `project_standalone_any_string_value_read_substrate`).
- **Anti-vacuity:** deferred to S5.P; if BLOCKED on substrate, S5.P proceeds
  WITHOUT property-access and its reachability probe (§4) must be re-run
  excluding property-access-bearing candidates.

#### S5.P — the producer + return-widening (the ONLY claim-flipping slice)

- **Files/functions:** `src/ir/select.ts` `dynamicUsesAreMoveOnly` (~L1178) —
  relax `scanExpr`/`scanStmt` arms 1:1 with the from-ast arms that landed in
  S5.1–S5.4:
  - **truthiness:** `scanStmt` `isIfStatement`/`isWhileStatement`/for/do —
    the condition may now be dyn-shaped (currently `scanExpr(cond, false)`
    rejects it); add an `allowDynCondition` path that accepts a bare dyn name
    / dyn-returning call in condition position (lowers via S5.1).
  - **equality:** `scanExpr` `isBinaryExpression` `===/!==/==/!=` — accept a
    dyn operand on either side (currently `if (expectDyn) return false; …`
    rejects), matching S5.2. Result is concrete i32, so `expectDyn` stays
    false for the enclosing context.
  - **relational (numeric-literal only):** `</<=/>/>= ` accept a dyn operand
    IFF the other operand is a numeric literal/concrete f64 (S5.3 scope
    guard — reject dyn×dyn-string-relational).
  - **property access:** `isPropertyAccessExpression`/`isElementAccess` —
    accept a dyn receiver; the RESULT is dynamic (a member read of any is
    any), so the access can itself be a dyn move (feeds return / another
    dyn-accepting position). Only if S5.4 landed unblocked.
  - **return-widening (co-requisite, s4):** in the claim gate (select.ts
    ~L768/L925) widen the return verdict to `dynamic` when ANY return arg is
    dyn-shaped even if a co-arm is concrete; and in `from-ast` return
    lowering box the concrete arms via `emitBox{toType:dynamic}` (R6 already
    rejects un-boxed non-dynamic→dynamic returns, so the box is mandatory and
    the verifier enforces the lockstep). This is where s4's return-widening
    finally has a non-empty population (rides on the body-use unblock).
- **Lowering change:** none new — S5.1–S5.4 already landed the arms; S5.P only
  opens the scan + adds the return-box producer arm.
- **Acceptance measurement (REAL claim delta — s4 discipline):**
  1. Run the production claim sweep (`.tmp/claim-sweep.mts` pattern, STRIDE
     ~40–200, 287+ file corpus = 13 playground + `examples/` + test262
     stride sample) on `upstream/main` baseline and on the S5.P branch;
     record the table (files OK / claim denominator / **claimed** /
     `param-type-not-resolvable` / `return-type-not-resolvable` /
     `body-shape-rejected` / **post-claim demotions**) exactly as the
     slice-2 measurement table in this file.
  2. **PASS criteria:** `claimed` strictly increases; `param-/return-
type-not-resolvable` drops by the claim increase and does NOT reappear
     as `body-shape-rejected` (that reappearance was s4's slice-2 signature
     of a vacuous type-gate move — here the body IS handled, so it must not
     recur); `post-claim demotions == 0` (the `JS2WASM_IR_FIRST` skipped-slot
     invariant — load-bearing).
  3. Full CI + `ir_first` test262 lane (#2947); expect small IMPROVEMENTS
     from pass-through/harness-shaped bodies (slice-2 note documented the
     live legacy miscompile the IR path fixes), zero regressions.
  4. Lift `computeIrFirstSkipSet` gate 6 (`codegen/index.ts`) only AFTER the
     `ir_first` lane shows zero dynamic-claim build demotions (per slice-3
     plan step 7).
- **check:ir-fallbacks bucket that drops:** `param-type-not-resolvable` and
  `return-type-not-resolvable` (refresh baseline with `--update-on-decrease`).

### 4. Anti-vacuity gate — MANDATORY before building S5.P (and before splitting it per-form)

s4's lesson: measure the REAL flip set, do not ship a producer that claims 0.
BEFORE writing the S5.P scan-arm flips, run TWO probes (bank in `.tmp/`,
reuse s4's `widening-ceiling2.mts` / `real-selector-probe.mts` /
`widening-aggregate.mts` patterns):

1. **Ceiling probe (AST over-approximation):** across the 4452-file corpus,
   count functions with ≥1 unannotated (→dynamic) param whose ONLY
   non-Phase-1-or-move constructs are the forms landed in S5.1–S5.4. This is
   the upper bound on the flip set.
2. **Real-selector reachability probe:** run production `planIrCompilation`
   over those candidates; the TRUE flip set = candidates that reject TODAY on
   `param-/return-type-not-resolvable` AND whose every dynamic body-use is now
   covered by the landed forms (i.e. would pass the relaxed scan). s4's
   decisive number was that the return-arm-sole-blocker set was EMPTY — the
   analogous decisive number here is: **is the covered-body flip set
   non-empty?**

**Gate:** build S5.P (or a per-form producer split) ONLY for a form/combination
whose real-selector flip set is non-empty. If the probe shows the reachable
population needs property-access (S5.4) and that is substrate-blocked, S5.P
ships WITHOUT property-access and the probe is re-run on the reduced form set;
if THAT flip set is also empty, S5.P is deferred (documented, like s4) rather
than shipped byte-inert. The mechanism slices S5.0–S5.4 remain valuable
regardless (they are the substrate the producer and the #2963/#2984/#3015
adoption slices in "Banked adoption slices" all consume) — only the
scan-flip is gated.

### 5. Honest sizing verdict (is the lever smaller/bigger than framed?)

- **Smaller than "build box/unbox producers":** the node lowering, the
  carrier helpers (`emitToBoolean`/`__any_strict_eq`/`emitToNumber`), the
  verifier, the handle, and the scratch local ALL already exist. S5.0–S5.3
  are thin wiring PRs.
- **Bigger/harder than "flip the scan for three forms":** (a) the reachable
  population needs a CONJUNCTION of forms, so no single-form producer is
  claim-productive — the claim delta is back-loaded onto S5.P; (b) S5.4
  (dynamic member read) is a substrate-scale problem (`$Object` dynamic
  reader) that may block, and it is the form the reachable population most
  needs; (c) relational correctness forces a numeric-literal-only restriction
  (string relational deferred). **Net:** the mechanism is turnkey and safe to
  land incrementally; the CLAIM payoff is real but concentrated in S5.P and
  contingent on S5.4 — so the honest expectation is a modest test262 claim-
  rate delta at first, growing only as S5.4's substrate and the #1370/#2855
  shape surface widen. Do not promise a large delta from S5.1–S5.3 alone; the
  probe in §4 sets the expectation before the code is written.

## Implementation Notes — S5.0 (opus-s5-0, 2026-07-05, branch `issue-2949-s5-0-emit-plumbing`)

S5.0 ships the builder-level emit vocabulary for the dynamic carrier —
`IrFunctionBuilder.emitBox` / `emitUnbox` / `emitTagTest` (`src/ir/builder.ts`).
These are the ONLY missing piece #1 the §0 grounding named: the node-level
LOWERING already landed in slices 2/3 (`lower.ts` box/unbox/tag.test cases →
`resolveDynamicLowering` → `IrDynamicLowering`), but a producer had no way to
CONSTRUCT the nodes. Now it does. **Pure plumbing, byte-inert by
construction**: no producer calls the methods (select.ts/from-ast.ts
untouched), so no compiled function changes.

Decisions and the WHY:

1. **Result-type mapping mirrors the node contracts (nodes.ts §box/unbox/
   tag.test), not a new policy.** `emitBox → toType`; `emitTagTest → irVal
i32`; `emitUnbox → irVal(<payload ValType>)` where the payload kind comes
   from the canonical `jsTagUnboxKind` (js-tag.ts): `i32` (NumberI32/Boolean),
   `f64` (NumberF64), `ref` (String/Object/Function). This is the SAME table
   the verifier (R2/R3) and the gc `payloadFieldIdx` use — one tag/payload
   policy (D4), no second table.

2. **The `ref` payload declares `externref` (deliberate, plumbing-level).**
   The runtime ref ValType is mode-split — host: the externref carrier IS the
   value (identity unbox); WasmGC: String rides `externval` (externref),
   Object/Function ride `refval` (eqref) — so no single static ValType is
   exactly right in both backends. `externref` is the host-universal and the
   gc-String choice; the S5.4 member-read producer (the first ref-payload
   consumer) refines it where a native ref is required (slice-3 hazard (b)).
   S5.0 has no ref-payload consumer, so this is inert.

3. **Two construction-time guards, matching verifier R1/R2, for a sharper
   error than a downstream verify/lower failure**: `emitBox` throws on an
   already-dynamic operand (re-box is redundant — R1); `emitUnbox` throws on
   a payload-less singleton jsTag (Null/Undefined — R2; also, there is no
   payload ValType to declare). Valid uses are unaffected — the guards only
   fire on producer bugs, so byte-inertness holds.

4. **Compose with the S5.1+ coercion-engine plan, not against it.** These
   methods construct the RAW box/unbox/tag.test nodes; S5.1+ route the
   general body-uses (truthiness/equality/relational) through the EXISTING
   coercion-engine helpers (`emitToBoolean`/`__any_strict_eq`/`emitToNumber`)
   exposed as new `IrDynamicLowering` methods (§1 of the S5 plan), reserving
   `tag.test`+`unbox` for the known-literal fast paths. S5.0's vocabulary is
   exactly those fast-path primitives plus the box every producer needs.

## Test Results — S5.0 (2026-07-05, opus-s5-0)

- `tests/issue-2949-s5-0-emit-plumbing.test.ts` — **8/8 pass**. Node-shape +
  result-IrType assertions for all three methods (incl. the full
  `jsTagUnboxKind` payload table), the R1 re-box guard and R2 singleton-unbox
  guard, verifier-clean built functions, and — RAISED to full runtime
  execution against the PRODUCTION `makeDynamicLowering` over a real
  `CodegenContext` — `box → tag.test → unbox → select` round-trips executed
  in BOTH strategies: gc ($AnyValue, pure module) and host (externref +
  import family). f64 value round-trip (incl. −0/NaN/2^40), numeric-class
  tag.test true, cross-tag (String) tag.test false → guarded 0,
  Boolean-refined box round-trip, NumberI32 box round-trip.
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline captured on a
  clean worktree at the base (`647cd6763`), `check` on this branch →
  **IDENTICAL, all 39 (file,target) hashes** across gc/standalone/wasi.
- Adjacent #2949 suites: slice 1 (`ir-dynamic-type`) 19/19, slice 2
  (`slice2-dynamic-producers`) 22/22, slice 3 (`slice3-dynamic-lowering`)
  16/16 — 65/65 combined with S5.0.
- `npx tsc --noEmit` clean; prettier clean.
- **S5.1 (truthiness) is ready to build on this**: it adds the
  `emitDynTruthy` builder method + `IrDynamicLowering.emitToBoolean` handle
  arm (routing to `coercion-engine.emitToBoolean`) and the from-ast `if`/loop
  condition arm; the box/unbox/tag.test primitives it needs for the
  known-literal paths now exist.

## Implementation Notes — S5.1 (opus-s5-1, 2026-07-05, branch `issue-2949-s5-1-truthiness`)

S5.1 ships **dynamic-value truthiness** — `ToBoolean(dyn) → i32` for a boxed-any
value in condition position. Mechanism slice: byte-inert by construction (the
selector's move-only gate still rejects a dynamic condition, so from-ast never
builds the node in a CLAIMED function). **prove-emit-identity: 39/39 IDENTICAL**
vs the branch base (`82dd5552c`). Decisions and the WHY:

1. **A dedicated `IrInstrDynTruthy{value}` node (→ i32), NOT `unbox{Boolean}`.**
   The plan (§S5.1) is explicit: general JS `ToBoolean` (§7.1.2) is defined over
   EVERY partition (`0`/`NaN`/`""`/`null`/`undefined` falsy), whereas
   `unbox{Boolean}` reads a _proven boolean's_ payload and is valid only under a
   `tag.test(Boolean)` proof. Truthiness needs no proof and no partition switch,
   so it is its own op. The node's blast radius is the usual `never`-exhaustive
   IR switch set (nodes.ts `forEachNestedBuffer`/`mapNestedBuffers`/`directUses`,
   lower.ts + verify.ts `collectUses`, effects.ts purity, monomorphize +
   inline-small rename/uses) — tsc's exhaustiveness checks flagged each; all
   covered.

2. **Lowering routes to the CANONICAL `coercion-engine.emitToBoolean` (D4), via
   a new `IrDynamicLowering.emitToBoolean()` handle arm** — NOT a hand-rolled
   `tag.test`+`unbox` chain. gc (`$AnyValue` carrier) → `__any_unbox_bool`; host
   (externref carrier) → `__is_truthy`. This is the SAME engine legacy `if (x)`
   uses (`ensureI32Condition`), so an IR-claimed condition is byte-parity with
   legacy. `tag.test`+`unbox` stays reserved for the known-literal fast paths
   (e.g. `dyn === null`, S5.2). Registration is already covered:
   `preregisterDynamicSupport` runs `ensureAnyHelpers` (gc, registers
   `__any_unbox_bool`) / `addUnionImports` (host, registers `__is_truthy`)
   up-front, so the internal `ensureAnyHelpers`/`ensureLateImport` inside
   `emitToBoolean` are idempotent no-ops at emit time (no mid-emission funcIdx
   shift). `isDynamicOp` gained a `dyn.truthy` arm so the preregister fires.

3. **from-ast arms are the single choke point `coerceLoopCondToBool`** (covers
   `if`/`while`/`for`/`do`) **plus `lowerConditional`** (ternary): when the
   condition's IrType is `dynamic`, emit `emitDynTruthy` instead of the "must be
   i32" throw. These are reachable ONLY once S5.P opens the selector scan; today
   the move-only gate rejects a dynamic condition, so the corpus never hits them
   → byte-inert (proven). They are exercised by hand-built-IR unit tests.

4. **LOAD-BEARING byte-parity finding — gc mode inherits `__any_unbox_bool`'s
   NaN-is-truthy quirk.** The canonical gc helper tests a NumberF64 payload with
   `f64val != 0` (`any-helpers.ts` `__any_unbox_bool`), and `NaN != 0` is TRUE
   in Wasm — so a boxed NaN reads **truthy** in gc mode. This is NOT a
   regression I introduced: it is exactly what legacy `if (boxedAnyNaN)` does
   today (same helper, same call site). The D4 mandate is byte-parity with the
   ONE ToBoolean engine, so S5.1 faithfully inherits it rather than minting a
   spec-corrected second policy. **Host mode IS spec-correct** (`__is_truthy`
   gives `NaN → falsy`). The gc NaN divergence is a pre-existing
   `__any_unbox_bool` gap (fixable only at the helper — `f64.ne 0` should be
   `f64.abs; f64.const 0; f64.gt`, matching the coercion-engine f64 arm — but
   that is a legacy-affecting change and belongs in its own issue, out of S5.1
   scope). The S5.1 unit test asserts the ACTUAL behavior (`NaN → 1` gc,
   `NaN → 0` host) with this rationale inline, so the quirk is pinned, not
   hidden. Producers that admit numeric truthiness in S5.P should note this gc
   edge (rare in practice; boxed-NaN conditions are unusual).

5. **Verifier hard backstop**: `dyn.truthy` operand must be `dynamic`
   (verify.ts structural check + a construction-time guard in `emitDynTruthy`).
   A concrete scalar already has an inline ToBoolean via the existing
   `coerceLoopCondToBool` numeric arm, so routing one through the carrier helper
   is a producer bug — rejected loudly at build and verify. Result is i32,
   already satisfying the if/loop `condValue`-must-be-i32 structural rules.

## Test Results — S5.1 (2026-07-05, opus-s5-1)

- `tests/issue-2949-s5-1-truthiness.test.ts` — **7/7 pass**: node shape +
  i32 result + verifier-clean; construction-time non-dynamic-operand guard;
  verifier rejection of a hand-crafted concrete-operand `dyn.truthy` (defense
  in depth); handle→helper D4 routing (gc single `__any_unbox_bool` call, host
  single `__is_truthy` call); and RUNTIME execution against the PRODUCTION
  `makeDynamicLowering` over a real `CodegenContext` in BOTH strategies —
  gc: boxed number (0/-0 falsy, NaN→1 byte-parity, finite non-zero truthy) +
  Boolean-refined box; host: FULL JS-truthiness spectrum
  (`0`/`NaN`/`""`/`null`/`undefined`/`{}`/`"a"`/`5`) via a dynamic externref
  param + `__is_truthy`.
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline captured on a
  clean worktree at the branch base (`82dd5552c`), `check` on this branch →
  **IDENTICAL, all 39 (file,target) hashes** across gc/standalone/wasi.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket, no post-claim
  demotions (no selector/producer change, as designed).
- Adjacent #2949 suites: S5.0 (`s5-0-emit-plumbing`) 8/8, slice 1
  (`ir-dynamic-type`) 19/19, slice 2 (`slice2-dynamic-producers`) 22/22,
  slice 3 (`slice3-dynamic-lowering`) 16/16, slice 3b (`slice3b-any-dynamic`)
  8/8 — 73/73 combined. `tests/ir/` + `ir-frontend-widening` +
  `ir-backend-emitter`: the only failures are the pre-existing 7
  (`ir/passes` 4, `ir/inline-small` 3 — `__unbox_number` LinkError) that
  reproduce with IDENTICAL counts on the clean base `82dd5552c` run
  side-by-side (documented in the S5.0 / slice-3 notes).
- `npx tsc --noEmit` clean; prettier clean.

**S5.2 (equality lowering) is ready next** — the substrate it needs already
exists: `emitBox{toType:dynamic}` (S5.0), the `coercion-engine`
`__any_strict_eq`/`__any_eq` helpers, and the `tag.test{Null|Undefined}`
fast-path primitives (S5.0). S5.2 adds `IrDynamicLowering.emitStrictEq`/
`emitLooseEq` (routing to those helpers) + `emitDynEq` on the builder + the
`lowerBinary` `===`/`!==`/`==`/`!=` dynamic arm, and lowers
`dyn === null`/`dyn === undefined` via `tag.test` rather than the general
helper. Mechanism slice, byte-inert, same prove-emit-identity + unit-test
discipline. The claim-flip stays back-loaded onto S5.P (§4 anti-vacuity
probe gates it).

## Implementation Notes — S5.2 (opus-s5-2, 2026-07-05, branch `issue-2949-s5-2-eq`)

S5.2 ships **dynamic-value strict/loose equality** — `dyn === x` / `dyn !== x`
/ `dyn == x` / `dyn != x` (either or both operands boxed-any carriers) → `i32`.
Mechanism slice: byte-inert by construction (the selector's move-only gate
still rejects a dynamic-eq body, so from-ast never builds `dyn.eq` in a CLAIMED
function). **prove-emit-identity: 39/39 IDENTICAL** vs the branch base
(`bfa59bc68`). Decisions and the WHY:

1. **A dedicated `IrInstrDynEq{lhs, rhs, loose, negate}` node (→ i32), not a
   `binary`.** Verifier R4 forbids dynamic operands on `binary`/`unary`; carrier
   equality is its own op (both operands MUST be dynamic — the producer boxes any
   concrete operand into the carrier first). `loose` selects `==`/`!=` vs
   `===`/`!==`; `negate` appends `i32.eqz` for the `!==`/`!=` half (the helper
   always computes the positive form). Same `never`-exhaustive blast radius as
   S5.1's `dyn.truthy` — nodes.ts (union + `forEachNestedBuffer` /
   `mapNestedBuffers` leaf groups + `directUses`), lower.ts uses + case,
   verify.ts (collectUses + operand-dynamic rule), effects.ts (pure), integration
   `isDynamicOp`, monomorphize + inline-small rename/uses — tsc's exhaustiveness
   flagged each. `dyn.eq` joins the two-operand `[lhs, rhs]` group (string.eq),
   NOT the single-operand `dyn.truthy` group.

2. **THE LOAD-BEARING FINDING — the equality engine is MODE-SPLIT; the spec's
   `__any_strict_eq`/`__any_eq` is the gc/standalone path ONLY, NOT host.** The
   spec said "route through `__any_strict_eq`/`__any_eq`". That is correct for
   the **gc (fast/standalone)** carrier — there the operands ARE `$AnyValue`,
   `emitEqOperand` is identity, and `__any_strict_eq`/`__any_eq` are exactly what
   legacy `compileAnyBinaryDispatch` emits (byte-parity, and the tag-5 field-4
   classifier owns cross-type falsity + numeric-class `5 === 5.0` + `NaN === NaN
→ false` via `f64.eq`). **But for the host (non-fast) externref carrier it is
   WRONG.** I verified against the real compiler (probe on `compileAndInstantiate`
   of `function looseEq(a:any,b:any){return a==b?1:0}` in host mode): legacy host
   `"5" == 5 → 1`, `null == undefined → 1` (spec-correct). Routing the host path
   through `boxToAny(externref,"unknown")` + `__any_eq` (my first attempt,
   mirroring `emitAnyEqOperands`) gives `"5" == 5 → 0`, `null == undefined → 0` —
   a DIVERGENCE, because `boxToAny("unknown")` is a compile-time tag decision that
   boxes every externref as opaque tag-5, so `__any_eq`'s §7.2.15 String⇄Number /
   tag-1 null==undefined arms never fire. The `__any_*_eq` family is the
   **standalone `noJsHost` branch** in `binary-ops.ts` (`emitAnyEqFromExternTemps`),
   not host's. **Legacy host `any === any` compares the raw externrefs via
   `__host_eq` (JS `===`) / `__host_loose_eq` (JS `==`).** So the host strategy
   routes through those imports: `emitEqOperand` = `[]` (externref IS the
   `__host_eq` operand shape), `emitStrictEq` = `__host_eq`, `emitLooseEq` =
   `__host_loose_eq`. This is D4-faithful (one equality engine PER BACKEND — the
   SAME the matching legacy lowering uses) and byte-parity with the legacy host
   runtime result. `preregisterDynamicSupport` registers `__host_eq` /
   `__host_loose_eq` (late imports, funcIdx-shift-safe up-front) for a host module
   carrying a `dyn.eq`; the gc `ensureAnyHelpers` already covers `__any_*_eq`.
   Standalone/wasi is the `gc` strategy (fast) → `__any_*_eq`, no host-import leak
   into a host-free module.

3. **`emitEqOperand` is a per-operand hook, emitted immediately after each
   operand is pushed** (so no scratch local is needed), currently identity in
   BOTH strategies. It exists so a future backend that needs real per-operand
   marshalling has the seam; today gc-carrier == `$AnyValue` == `__any_*_eq`
   shape, host-carrier == externref == `__host_*_eq` shape, both identity.

4. **`dyn === null` / `dyn === undefined` (STRICT) use the exact
   `tag.test{Null|Undefined}` fast path, NOT the general helper**, wired inside
   from-ast's existing `tryFoldNullCompare` / `tryLowerUndefinedCompare` (they
   already lower the "other" operand and branch on its IrType — the natural home
   for a dynamic arm). LOOSE `== null` / `== undefined` is NOT a single tag test
   (`== null` matches both null and undefined, §7.2.15), so it is left to legacy
   (return null → demote), never folded. The general `dyn === x` / `dyn === dyn`
   arm lives in `lowerBinary` after operand lowering, before the string-operand
   path (a `dyn === "s"` mixes dynamic + string), and boxes the concrete operand
   with a literal-kind refinement (numeric literal / f64 → NumberF64; `true`/
   `false` → Boolean so it boxes tag-4, NOT the number default; string → String);
   an un-refinable non-literal `i32` (number-vs-boolean-ambiguous) demotes cleanly
   rather than mis-tagging. All from-ast arms are reachable only once S5.P opens
   the scan; today the move-only gate rejects a dynamic-eq body, so they are
   byte-inert (proven) and exercised only by hand-built-IR unit tests.

5. **NaN respects `NaN !== NaN`** — the task's explicit concern. The gc
   `__any_strict_eq` number arm is `f64.eq` (any-helpers.ts ~L2285), so
   `NaN === NaN → 0`; host `__host_eq` is JS `===`, likewise `0`. Verified at
   runtime in BOTH strategies. This is CLEANER than S5.1's inherited
   `__any_unbox_bool` NaN-is-truthy quirk — equality gets NaN right in both modes
   because both helpers compare numbers with the spec `f64.eq` semantics.

## Test Results — S5.2 (2026-07-05, opus-s5-2)

- `tests/issue-2949-s5-2-eq.test.ts` — **7/7 pass**: node shape + i32 result +
  loose/negate flags + verifier-clean; construction-time non-dynamic-operand
  guard (lhs AND rhs); verifier rejection of a hand-crafted concrete-operand
  `dyn.eq`; handle→helper D4 routing (gc: `emitEqOperand` identity +
  `__any_strict_eq`/`__any_eq` +eqz-on-negate; host: identity + `__host_eq`/
  `__host_loose_eq`); and RUNTIME execution against the PRODUCTION
  `makeDynamicLowering` over a real `CodegenContext` in BOTH strategies —
  gc: strict/loose number eq incl. `NaN === NaN → 0` (spec-correct) and `0 ===
-0 → 1`, `!==` negation, numeric-CLASS (tag-2 i32 box === tag-3 f64 box),
  cross-type strict falsity (boxed number vs boxed boolean → 0); host: full
  spectrum via externref params — number/string/bool equality, cross-type
  falsity (`"5" === 5`, `true === 1` → 0), `NaN === NaN → 0`, null/undefined
  (`null === null → 1`, `null === undefined → 0` strict), LOOSE coercions
  (`"5" == 5 → 1`, `null == undefined → 1`, `0 == false → 1`), and the strict
  null/undefined `tag.test` FAST-PATH primitive.
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline captured on a
  clean worktree at the branch base (`bfa59bc68`), `check` on this branch →
  **IDENTICAL, all 39 (file,target) hashes** across gc/standalone/wasi.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket, no post-claim
  demotions (no selector/producer change, as designed).
- Adjacent #2949 suites: S5.0 8/8, S5.1 7/7, slice 1 19/19, slice 2 22/22,
  slice 3 16/16, slice 3b 8/8 — **87/87 combined with S5.2**. `tests/ir/` +
  `issue-2104-value-tags`: the only failures are the pre-existing 7 (`ir/passes`
  4, `ir/inline-small` 3 — `__unbox_number` harness LinkError) recorded
  identically in the S5.0 / S5.1 / slice-3 notes.
- `npx tsc --noEmit` clean; prettier + biome clean.

**S5.3 (relational: `dyn </<=/>/>=`) is ready next** — the substrate it needs
exists: `emitBox` (S5.0), and the coercion-engine `emitToNumber` (carrier →
f64) is the target for a new `IrDynamicLowering.emitToNumber` arm + `emitDynToNumber`
on the builder + the `lowerBinary` relational arm (ToNumber(dyn) → `f64.lt`/`gt`/…).
Scope guard per the S5 plan §S5.3: numeric-abstract-relational only, admit a dyn
operand only against a NUMERIC literal (string×string relational deferred — a
dyn-string ToNumber = NaN gives all-false, spec-correct for `"a" > 0` but WRONG
for `"b" > "a"`). Same mechanism-slice discipline: byte-inert, prove-emit-identity
39/39, hand-built-IR unit tests over gc + host. The claim-flip stays back-loaded
onto S5.P (§4 anti-vacuity probe).

## Implementation Notes — S5.3 (opus-s5-3, 2026-07-05, branch `issue-2949-s5-3-relational`)

S5.3 ships **dynamic-value numeric-abstract relational** — `dyn </<=/>/>= x`
(either or both operands boxed-any carriers) → `i32`, via a new single-operand
`dyn.to_number{value}` node (ToNumber → f64) feeding the EXISTING `f64.lt`/`gt`/
`le`/`ge` compare path. Mechanism slice, byte-inert by construction (the move-only
selector gate still rejects a dynamic-relational body, so from-ast never builds
`dyn.to_number` in a CLAIMED function). **prove-emit-identity: 39/39 IDENTICAL**
vs the branch base (`e66b066d4`). Decisions and the WHY:

1. **A single-operand `IrInstrDynToNumber` node → f64 (the `dyn.truthy` shape,
   NOT the two-operand `dyn.eq` shape).** Unlike equality — where the WHOLE
   comparison routes through one helper (`__any_strict_eq`/`__host_eq`) — the
   relational mechanism per the S5 plan is `ToNumber(dyn) → f64` + the existing
   numeric compare. So the node is a ToNumber PRIMITIVE (like `dyn.truthy` is a
   ToBoolean primitive), and from-ast emits `emitBinary("f64.lt", …)` on the
   converted operands. Same `never`-exhaustive blast radius as S5.1's
   `dyn.truthy`: nodes.ts (union + the two no-nested-buffer switch groups +
   `directUses`), lower.ts (case + `collectIrUses`), verify.ts (operand-dynamic
   rule + `collectUses`), effects.ts (pure), integration `isDynamicOp`,
   monomorphize + inline-small single-operand rename/uses — tsc's exhaustiveness
   flagged each; `dyn.to_number` joins the single-operand `[instr.value]` group.

2. **THE LOAD-BEARING FINDING — legacy `any < any` is a FULL Abstract Relational
   Comparison (§7.2.11), mode-split THREE ways, NONE of them a bare ToNumber.**
   The task asked, mirroring S5.2's `__host_eq` lesson, whether legacy host
   `any < any` routes through a `__host_*` JS-relational helper. It DOES — and
   there are three distinct legacy lowerings (verified against the REAL compiler,
   `compileToWat` of `function f(a:any,b:any){return a<b?1:0}` in each mode):
   - **host (default)**: `a < b` → `call __host_compare(a, b)` then compare the
     result to `-1` — a JS-relational IMPORT (full ARC incl. string×string
     lexicographic). This is the exact analog of S5.2's `__host_eq`.
   - **fast (JS-host, WasmGC rep)**: relational FALLS THROUGH
     `compileAnyBinaryDispatch` (only `+`/equality dispatch through it —
     `binary-ops.ts:1091-1096`) to "compile with numeric hint" → `__unbox_number`
     (`Number(v)`) per operand + numeric compare. String-correct via `Number()`.
   - **standalone**: a pure-Wasm runtime branch — `if both-are-strings →
lexicographic string compare, else → __any_to_f64 each + f64.lt` (the full
     ARC in Wasm; the else arm reads the box's f64 slot for a string → 0, a known
     legacy mixed-string/number gap).
     The `__any_lt`/`__any_gt`/`__any_le`/`__any_ge` helper family EXISTS
     (`any-helpers.ts:2466`, `__any_to_f64` both operands + `f64.op`) but is NOT the
     path `a < b` on two `any` operands actually takes (relational falls through
     dispatch). So there is no single "legacy relational helper" for me to route the
     whole comparison through — the S5-plan design (ToNumber(dyn) + f64 compare) is
     the numeric ARM of this ARC, deliberately implementing ONLY the numeric case.

3. **Per-backend ToNumber routing (D4-faithful, byte-parity with each backend's
   ToNumber engine):**
   - **gc/fast/standalone** → `__any_to_f64` — THE canonical boxed-any→f64 helper
     legacy's `__any_lt` family + the arithmetic helpers use (null→0, undefined→
     NaN, boolean→0/1, number→value). Chosen DIRECTLY, deviating from the plan's
     "route through `coercion-engine.emitToNumber`", because that function's
     `$AnyValue` arm goes through `coerceType(…,"number")`, which allocates a
     temp local via `allocTempLocal` (verified — it crashes on a body-only shim);
     the handle's pure `readonly Instr[]` contract cannot supply the function
     locals. `__any_to_f64` is the single-call, no-locals, D4-canonical
     equivalent (registered by `ensureAnyHelpers`, resolved by NAME at emit time).
   - **host** → `coercion-engine.emitToNumber` on the externref carrier →
     `__unbox_number` (`Number(v)`, §7.1.4). The externref arm is a clean single
     call with NO local allocation (verified), so the body-only `FunctionContext`
     shim is sound (same pattern as the gc `emitBox`). `addUnionImports` (run
     up-front in `preregisterDynamicSupport` — `isDynamicOp` gained a
     `dyn.to_number` arm) registers `__unbox_number`, so the internal
     `addUnionImports` is an idempotent no-op — no mid-emission funcIdx shift.

4. **String relational is DEFERRED (scope), and the numeric-literal restriction
   makes the numeric arm spec-complete.** A boxed-string operand ToNumbers (host
   `Number("5")=5`; gc `__any_to_f64` reads the box's f64 slot → 0, matching
   legacy `__any_lt`). ARC only takes the both-strings lexicographic branch when
   BOTH operands are strings; against a NUMBER, ARC does ToNumber both — so
   `dyn <rel> numericLiteral` is spec-correct under the numeric arm even when
   `dyn` is a string (host: `Number(dyn)`; the gc string→0 gap matches legacy
   `__any_lt` and is the documented deferred imperfection). Hence the S5.P scan
   admits a dynamic relational operand ONLY against a numeric literal/concrete.
   The `from-ast` `relOperandToF64` helper enforces the mechanism side: a dynamic
   operand ToNumbers via `dyn.to_number`; a concrete `f64` is used as-is; ANY
   other concrete kind (i32/ref/string) returns `null` → clean demote (no
   i32/string→number coercion added here; numeric literals lower to `f64` under
   the f64 operand hint, covering `dyn > 0` / `dyn <= 10`).

5. **NaN is correct in both modes** — the numeric arm is a plain `f64.{lt,gt,le,
ge}`, and every relational compare with a NaN operand is `false` (§7.2.11).
   `undefined` ToNumbers to NaN → all relational false; `null` → 0; boolean →
   0/1. Verified at runtime in BOTH strategies (no S5.1-style inherited quirk —
   relational never touches `__any_unbox_bool`).

6. **Verifier hard backstop**: `dyn.to_number` operand must be `dynamic`
   (verify.ts structural rule + a construction-time guard in `emitDynToNumber`).
   A concrete numeric operand already converts to f64 inline, so routing one
   through the carrier ToNumber helper is a producer bug — rejected loudly at
   build and verify. Result is f64, consumed by the numeric compare.

## Test Results — S5.3 (2026-07-05, opus-s5-3)

- `tests/issue-2949-s5-3-relational.test.ts` — **7/7 pass**: node shape + f64
  result + verifier-clean; construction-time non-dynamic-operand guard; verifier
  rejection of a hand-crafted concrete-operand `dyn.to_number` (defense in
  depth); handle→helper D4 routing (gc single `__any_to_f64`, host single
  `__unbox_number`); and RUNTIME execution against the PRODUCTION
  `makeDynamicLowering` over a real `CodegenContext` in BOTH strategies —
  gc ($AnyValue): dyn(number) vs concrete + dyn<dyn for `</<=/>/>=`, fractional
  f64 compare (not i32 truncation), boolean partition (`true`→1/`false`→0),
  `NaN → false`; host (externref): number/bool/null(→0)/undefined(→NaN→false)/
  string(`Number()`, spec-correct against a numeric operand) across
  `</>/>=`, plus dyn<dyn.
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline captured on a
  clean worktree at the branch base (`e66b066d4`), `check` on this branch →
  **IDENTICAL, all 39 (file,target) hashes** across gc/standalone/wasi.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket, no post-claim
  demotions (no selector/producer change, as designed).
- Adjacent #2949 suites: S5.0 8/8, S5.1 7/7, S5.2 7/7, slice 1 19/19, slice 2
  22/22, slice 3 16/16 — **86/86 combined with S5.3**.
- `npx tsc --noEmit` clean; prettier clean; biome introduces ZERO new errors
  (the per-file counts are byte-identical at the base `e66b066d4` — pre-existing
  IR-codebase biome-vs-prettier style deltas; prettier is the CI quality gate).

**S5.4 (dynamic member read: `dyn[i]` / `dyn.p`) is ready next — but it is the
HEAVIEST sub-slice and substrate-adjacent** (per §S5.4). Unlike S5.1–S5.3, the
`$Object` dynamic-reader has NO clean single-helper carrier op today (memory
`project_standalone_any_string_value_read_substrate` — the reader drops
native-string values). The next agent MUST first identify whether a legacy
any-member reader in `property-access.ts` / `object-ops.ts` is cleanly reusable
(route through it, D4) or whether S5.4 is BLOCKED on a substrate helper — in
which case file the dependency and do NOT hand-roll (per the §S5.4 "BLOCKED on a
substrate helper" clause). If S5.4 blocks, S5.P proceeds WITHOUT property-access
and its §4 reachability probe re-runs on the reduced form set. The S5.1–S5.3
mechanism substrate (truthiness / equality / relational ToNumber) is complete and
consumed by both S5.P and the banked #2963/#2984/#3015 adoption slices regardless.

## Implementation Notes — S5.4 (INVESTIGATION VERDICT: substrate-BLOCKED as a thin-wiring slice; the value-drop premise is CORRECTED) (opus-s5-4, 2026-07-05, branch `issue-2949-s5-4-member-read`)

**Verdict: S5.4 (dynamic member read) is NOT a clean "route through a legacy
reader" wiring slice like S5.1–S5.3. It is substrate-BLOCKED — but for a
DIFFERENT and more precise reason than the `project_standalone_any_string_value_
read_substrate` memory framed it. Per the §S5.4 "BLOCKED on a substrate helper …
do NOT hand-roll" clause and the task's explicit "do NOT hand-roll a carrier"
instruction, S5.4 ships as this docs finding + a filed substrate dependency, and
S5.P proceeds WITHOUT property-access on the reduced form set (truthiness + eq +
relational).** Evidence and the exact reasons below.

### Premise correction — the native-string-value-drop substrate is FIXED on current main

The memory (`project_standalone_any_string_value_read_substrate`, dated
2026-06-21) says the `$Object` dynamic (`any`-typed) reader `__extern_get` DROPS
native-string VALUES in standalone (`const o: any = {v:"hi"}; o.v.length → 0`).
**Re-probed against current main (`b4e368b9a`) — it no longer reproduces.** The
#2580 M-series dyn-read substrate (`src/codegen/dyn-read.ts`) + #2896 fixed it.
Four probes (banked in `.tmp/probe-s54-*.mts`), value returned [want]:

| probe (host / standalone)                                      | host | standalone |
| -------------------------------------------------------------- | ---- | ---------- |
| `const o:any={v:"hello"}; o.v.length` [5]                      | 5    | 5          |
| `const o:any={n:7}; o.n` [7]                                   | 7    | 7          |
| cross-`any`-boundary `reader(o).v.length`, `o={v:"hello"}` [5] | 5    | 5          |
| cross-`any`-boundary `reader(o).v === "hi"` [1]                | 1    | 1          |
| dynamic-param `o[0]` on `[7,8,9]` [7]                          | 7    | (compiles) |
| dynamic-param `o[i]` on `({a:5},"a")` [5]                      | 5    | (compiles) |
| dynamic-param `o["k"]` on `{k:3}` [3]                          | 3    | (compiles) |

So string values survive (host + standalone), and named + static-index +
DYNAMIC-index reads all work in legacy. The "reader drops values" blocker is
gone. **This premise correction is the load-bearing finding — do not re-cite the
2026-06-21 memory as the S5.4 blocker; it is stale.**

### The REAL blocker — there is no single reusable carrier op; the legacy any-read is the whole AST/oracle-driven dispatch tree

The reason S5.4 cannot be a thin wiring slice is architectural, not a value bug:

1. **The legacy `any`-receiver read is `compilePropertyAccess` + the element-access
   dispatch (`src/codegen/property-access.ts`, ~3364 onward) — thousands of lines
   of AST-node + checker-oracle + speculative-recompile logic**: transactional
   `snapshotSpeculative`/`rollbackSpeculative`, the `.length` special-case, the
   `moduleUsesDelete` tombstone-aware arms (#2179), the native-string arms, the
   vec fast-paths + struct-field alternates, the async-body decline (#2602 desync
   guard), the #2077 `catch (e)` arm. It reads `ctx.oracle.typeFactOf(node)` and
   branches on a dozen static conditions. **An `IrDynamicLowering` handle method
   (pure `readonly Instr[]`, driven from `lower.ts` off a body-only
   `FunctionContext` shim) has NONE of those inputs** — no `ts.Node`, no checker
   oracle, no speculation machinery. It cannot route through that tree with
   byte-parity.

2. **The one leaf-shaped helper — `emitDynGet` (`src/codegen/dyn-read.ts:224`) —
   breaks the pure-handle contract that S5.0–S5.3 are built on.** It does NOT
   return `Instr[]`; it pushes directly into a live `fctx.body`, ALLOCATES real
   function locals (`allocLocal(fctx, …)` in the host `.length` vec/closure-meta
   arm), and does mid-emit late-import shifting (`ensureLateImport` +
   `flushLateImportShifts(ctx, fctx)`) on the REAL function body. The
   `makeDynamicLowering` resolver (integration.ts:1835) emits every op through a
   `{ body: [] } as unknown as FunctionContext` shim precisely because the S5.0–3
   ops touch ONLY `.body`. `emitDynGet` on that shim would (a) crash
   `allocLocal` (no `.locals` array), and (b) run `flushLateImportShifts` against
   the shim's empty body while the REAL IR-emitted body's baked funcidx go
   un-shifted — the #2043/#2078 mid-emission funcidx-shift class. **This is the
   exact wall S5.3 hit** (its note 3: it rejected `coercion-engine.emitToNumber`'s
   `$AnyValue` arm for the identical `allocTempLocal`-on-a-shim reason and chose
   the locals-free `__any_to_f64` instead). For member-read there is no
   locals-free equivalent — the `.length` vec-dispatch and the ToPropertyKey path
   genuinely need scratch locals and receiver-kind `ref.test` chains.

3. **Carrier impedance (gc): `emitDynGet` yields a UNIFORM `externref`
   (dyn-read.ts:143), but the gc/standalone `dynamic` carrier is
   `(ref null $AnyValue)`** (the handle's `carrier`, `resolveDynamic()`). A
   faithful `dyn.p → dynamic` in gc mode therefore needs an externref→`$AnyValue`
   conversion AFTER the read. The available op (`__any_from_extern`) re-tags an
   opaque externref as tag-5 — which is lossy for the number/boolean partitions
   the result may carry. That re-tag IS the tag-preservation hazard the §S5.4
   acceptance flags ("value + tag preservation … MUST be covered"); it is not a
   clean identity like the host case (host carrier == externref == `emitDynGet`'s
   result).

4. **The population-dominant `obj[idx]` form has no single-helper path even
   though legacy supports it.** `emitDynGet` is NAMED-key only (`keyName: string`);
   its comments (dyn-read.ts:264) state non-`length` keys "skip the vec arm … go
   straight to `__extern_get`" and vec INDEXED reads are "a later slice." A
   dynamic index (`obj[idx]`, idx dynamic) needs `ToPropertyKey(dyn)` first, which
   the dyn-read substrate does not expose as a call-site primitive. Legacy handles
   `o[i]` via its element-access dispatch (a different code path than
   `emitDynGet`), again AST-driven. §S5.4 itself says "the reachable population's
   real weight sits in `obj[idx]`" — so the form S5.P most needs is the one with
   the least reusable substrate.

### Why NOT ship a narrow host-only named-`.p` slice anyway (the s4 anti-vacuity discipline)

A narrow S5.4 (host-mode named-`dyn.p` via `emitDynGet`, deferring gc + indexed +
dynamic-index) was considered and rejected: (a) it still requires a NEW
fctx-carrying handle-method contract + a key-dependent `preregisterDynamicSupport`
walk — an architectural change to `IrDynamicLowering`, not thin wiring; (b) it is
host-clean only (gc needs the lossy carrier conversion); (c) being byte-inert with
no producer, its ONLY consumer is S5.P, whose reachable population needs INDEXED
reads on BOTH backends — so it would be dead mechanism carrying a load-bearing
scan↔builder lockstep obligation (a `JS2WASM_IR_FIRST` skipped-slot hard error on
drift) for ~zero claim payoff. That is exactly the s4 vacuity anti-pattern this
issue's own §4/§5 warn against. A mechanism slice is only valuable if a producer
can consume it; S5.4's producer can't consume a host-only-named-key half-slice.

### The substrate dependency to file (the clean unblock — Option B, recommended)

Extract a genuine single-helper carrier op in the dyn-read substrate that the IR
handle can route through with byte-parity, locals-free at the call site:

```
__dyn_member_get(recv: <carrier>, key: <carrier>) -> <carrier>
```

- Mode-correct carrier in AND out ($AnyValue gc/standalone, externref host) — no
  externref↔$AnyValue impedance at the IR boundary.
- Handles named + indexed + dynamic-index uniformly (absorb `ToPropertyKey(dyn)`
  and the `.length`/vec-index/receiver-kind dispatch INTO the helper body, so the
  call site is a bare `call` with no scratch locals — the same shape as
  `__any_strict_eq`/`__any_to_f64` that S5.2/S5.3 route through cleanly).
- Registered up-front by `preregisterDynamicSupport` (idempotent, funcidx-shift-
  safe), so the IR handle method stays a pure `readonly Instr[]` `[call
__dyn_member_get]` and the S5.0–3 body-only-shim contract is preserved.
- Then S5.4 becomes the intended thin wiring: `IrDynamicLowering.emitMemberGet()`
  → `[call __dyn_member_get]`; `builder.emitDynMemberGet(recv,key) → dynamic`;
  the `from-ast` `lowerPropertyAccess`/`lowerElementAccess` dynamic-receiver arm.

This is a **senior-dev/value-rep substrate slice** (the memory's "one focused
senior-dev/value-rep change" disposition still applies — just re-aimed from
"stop dropping string values" (done) to "expose a locals-free, carrier-uniform,
named+indexed member-get primitive"). It should get its own architect pass; it is
NOT dev-tractable as thin wiring on top of the current `emitDynGet` shape.

### Coordination with #3037 CS1b(ii) (opus-3037-cs1bii)

Confirmed no collision: this investigation is IR-layer + docs only and does NOT
modify `src/codegen/property-access.ts` or the element-access identity carrier.
The concluded direction (a NEW `__dyn_member_get` substrate helper in
`dyn-read.ts`, routed THROUGH — not modifying — the existing readers) also stays
clear of #3037's equality-operand tag-6 carrier work in property-access.ts. If the
filed substrate dependency is picked up, its author should coordinate with the
#3037 line since both touch the any-member-read substrate.

### S5.P readiness — reduced form set (truthiness + eq + relational), gated on its own §4 probe

Per §4: with property-access BLOCKED, S5.P ships WITHOUT the property-access scan
arm and re-runs its anti-vacuity reachability probe on the REDUCED form set
(truthiness + eq + relational-vs-numeric-literal only). **Caution for the S5.P
author (do NOT skip §4):** the s4 measurement + slice-3 note 7 already showed the
reachable unannotated-param population overwhelmingly needs a CONJUNCTION that
INCLUDES property access (e.g. the `Array.prototype.reduce` `callbackfn`:
`idx>0 && obj[idx]===curVal && obj[idx-1]===prevVal` — property-access + eq). With
property access removed, the reduced flip set is likely near-empty, in which case
S5.P is DEFERRED (documented, like s4), not shipped byte-inert. The S5.1–S5.3
mechanism substrate remains valuable regardless (consumed by the banked
#2963/#2984/#3015 adoption slices). Run the §4 ceiling + real-selector probes on
the reduced set BEFORE writing any S5.P scan-arm flip; build only a non-empty
flip set.

## Implementation Notes — S5.5 (fable-11th, 2026-07-10, branch `issue-2949-s5-5-dyn-arith`)

S5.5 ships **dynamic numeric arithmetic** — the missing producer form the #3053
U2 measurement named as its follow-up 2 (the reduce-style `obj[idx-1]` bodies
need dynamic ARITHMETIC, not just member reads). Mechanism slice, byte-inert by
construction (the move-only selector gate still rejects a dynamic-arithmetic
body). **prove-emit-identity: 39/39 IDENTICAL** vs the branch base
(`cda6ab047b`). Decisions and the WHY:

1. **NO new IR nodes, NO handle/lowering changes — pure from-ast wiring of the
   existing S5.1/S5.3 primitives.** Unlike S5.1–S5.3 (each added a node +
   handle arm), the arithmetic forms decompose entirely into landed vocabulary:
   `dyn.to_number` (S5.3) feeds the EXISTING f64 ops. The whole slice is two
   from-ast arms:
   - `tryLowerDynamicArithmetic` in `lowerBinary` (after the S5.3 relational
     arm): `-`→`f64.sub`, `*`→`f64.mul`, `/`→`f64.div`, `%`→ the shared
     exact-`__fmod` helper call (#2945/#2056 — the SAME `emitCall {FMOD_FN}`
     the concrete `%` case emits, so every fmod edge — `x % 0`→NaN, `-0 % x`→
     −0, sign-of-dividend — agrees bit-for-bit with legacy). Operands convert
     via the S5.3 `relOperandToF64` (doc generalized, now shared): dynamic →
     `dyn.to_number`, concrete f64 → as-is, anything else → `null` → clean
     demote.
   - `lowerPrefixUnary` dynamic arms: `-x` → `dyn.to_number` + `f64.neg`
     (§13.5.5); `+x` → a BARE `dyn.to_number` (§13.5.4 Unary Plus IS
     ToNumber); `!x` → `dyn.truthy` (S5.1) + `i32.eqz` (§13.5.7 — inherits
     S5.1's documented gc boxed-NaN-is-truthy byte-parity quirk; host is
     spec-correct).

2. **Why these four binary operators are SPEC-COMPLETE under ToNumber (no
   relational-style scope restriction needed):** `-`/`*`/`/`/`%` are pure
   ToNumber operators (§13.7 multiplicative, §13.8.2 subtraction) —
   ApplyStringOrNumericBinaryOperation with a numeric-only opText never takes
   a string branch. So the S5.P scan may admit a dynamic arithmetic operand
   against ANY counter-operand shape (unlike relational's numeric-literal-only
   restriction): `"7" - "2"` is 5 by spec, and a string operand ToNumbers per
   §7.1.4 (host `Number(v)`; the gc boxed-string→f64-slot gap matches legacy
   `__any_sub`-family behavior — the documented S5.3 deferred imperfection,
   same magnitude, same fix path). BigInt is out of IR scope.

3. **`+` stays EXCLUDED (deliberate, pinned by test):** JS `+` is ToPrimitive
   - string-concat-OR-add dispatch, not a ToNumber operator. The Row-7
     `proveAdditiveOperand` gate (#2781) already demotes an unprovable-`any` `+`
     to the SAFE legacy `emitAnyAdd`; a dynamic operand reaching the kind
     dispatch demotes on the type-mismatch throw. A dynamic `+` producer needs
     the ToPrimitive machinery — a separate slice if S5.P's probe shows the
     population needs it.

4. **Bitwise/shift ops stay rejected** (ToInt32/ToUint32 territory — needs a
   `dyn`→i32 conversion policy; not in this slice, demotes cleanly).

## Test Results — S5.5 (2026-07-10, fable-11th)

- `tests/issue-2949-s5-5-dyn-arith.test.ts` — **8/8 pass**. NEW test approach
  for a from-ast-only slice: the tests drive `lowerFunctionAstToIr` DIRECTLY
  with `paramTypeOverrides: [dynamic]` (the exact selector/override contract)
  on real parsed sources, then execute the from-ast OUTPUT against the
  PRODUCTION `makeDynamicLowering` over a real `CodegenContext`:
  - node shapes: `x - 1` emits ONE `dyn.to_number` (not the concrete literal)
    - `f64.sub`; `x % y` routes through `__fmod` BY NAME; `+x` is a bare
      `dyn.to_number` with NO unary op; `!x` uses `dyn.truthy`, NOT ToNumber;
  - demotes pinned: `x + 1` (concat dispatch), `x - "a"` (string
    counter-operand), `x & 1` (bitwise) all throw → legacy;
  - gc runtime ($AnyValue): from-ast functions called through hand-built
    box-wrappers (the slice-2 dyn-arg→dyn-param call shape) — dec/mul/div/
    mod/neg/toNum over boxed numbers + Boolean-refined carriers, incl.
    NaN propagation, −0 (`Object.is(-0 % 3, -0)`, `Object.is(-0, neg(0))`),
    `x % 0 → NaN`, `1/0 → Infinity`, `0/0 → NaN`, fractional fmod;
  - host runtime (externref): from-ast functions called DIRECTLY with real JS
    values — `dec("5")=4`, `sub("7","2")=5` (`-` never concatenates),
    `mul("abc",4)=NaN`, `dec(true)=0`, `dec(null)=-1`, `dec(undefined)=NaN`,
    `toNum("42")=42`/`toNum("")=0`/`toNum(null)=0`, and the full `!x`
    truthiness spectrum (0/NaN/""/null/undefined → 1; 5/"a"/{} → 0).
- **Byte-inertness PROVEN**: `prove-emit-identity.mjs` baseline captured on
  clean main (`cda6ab047b`, /workspace sync), check on this branch →
  **IDENTICAL, all 39 (file,target) hashes** across gc/standalone/wasi.
- `pnpm run check:ir-fallbacks` — OK, zero delta in every bucket, no
  post-claim demotions (no selector/producer-admission change, as designed).
- Adjacent #2949 suites all green: S5.0 8/8, S5.1 7/7, S5.2 7/7, S5.3 7/7,
  slice 1 19/19, slice 2 22/22, slice 3 16/16, slice 3b 8/8 — **93/93**, plus
  S5.5's 8 = 101 combined.
- `npx tsc --noEmit` clean; prettier clean.

**S5.P is next (the claim-flip)** — with S5.5 landed, the full form set the
reachable population needs is now mechanism-complete: truthiness (S5.1) + eq
(S5.2) + relational-vs-numeric (S5.3) + member/element read (#3053 U1/U2,
scan ALREADY open for those) + numeric arithmetic (S5.5) + return-widening
(bundled). Run the §4 anti-vacuity probes FIRST (ceiling + real-selector) on
this full set — the `callbackfn` exemplar (`idx>0 && obj[idx]===cur &&
obj[idx-1]===prev`) is now coverable in principle (relational + eq +
element-access + `idx-1` arithmetic all exist). Build the scan flip ONLY for a
measured non-empty flip set, with the slice-2-style claim-sweep table + full
CI as the acceptance evidence, and lift gate 6 only after an `ir_first`-lane
run shows zero dynamic-claim demotions.

## Implementation Notes — S5.P Acorn dynamic operators (2026-07-29)

The claim flip is non-empty on the exact runtime-dynamic Acorn 8.16.0 driver
from draft PR #3796:

- baseline at `fa8bfd5462192e`: **0 emitted / 43 terminal functions**;
- this slice: **14 emitted / 43 terminal functions**;
- post-claim ABI or lowering withdrawals: **0**;
- remaining: 19 body shapes, 3 logical-value shapes, 2 RegExp constructor
  shapes, 2 parameter shapes, 2 call-graph closures, and 1 constructor
  resolution shape.

The selector now admits the already-landed dynamic equality, numeric
relational, numeric arithmetic, unary coercion, and condition producers. It
still rejects dynamic `+`, dynamic-vs-dynamic relational comparison, and
non-literal concrete equality operands because their complete runtime
dispatch is not yet modeled.

Planning consumes the same implicit-parameter scalar inference as direct
declaration lowering. The projected type is also used by the IR override map,
so a claimed helper cannot widen to `dynamic` and later fail callable ABI
parity. This preserved the direct backend's numeric-call-site optimization and
removed the three measured Acorn parity withdrawals. Projection is restricted
to parameters feeding the admitted scalar operators, avoiding a whole-source
call-site scan for unrelated harness parameters.

That projection deliberately excludes functions containing the #1210
string-builder loop shape. Making an untyped builder function claimable would
move it off the legacy cached-buffer and loop-local integer optimizations before
#3745 has migrated the latter. The existing IR owned-append path remains
available to already-typed functions; newly inferred builder functions stay on
their current optimized path until the remaining optimization is present in IR.

Non-fast standalone needed two runtime corrections exposed only after the
claim became live:

- dynamic ToNumber now uses the canonical standalone
  ToPrimitive(`"number"`) + unbox route with late-import shift tracking;
- dynamic strict/loose equality uses native externref equality helpers instead
  of JS-host imports.
- direct calls box concrete numeric arguments at explicit-`any` parameter
  boundaries, including the `Math.pow(...)` equivalence shape.

Dynamic member reads used directly by equality remain pre-claim fallbacks.
Array callbacks pass their `obj` argument in a direct array carrier, while the
current dynamic member helper expects boxed-any input; claiming that seam made
`obj.length === n` return the wrong result.

## Implementation Notes — direct-only dynamic member equality (2026-07-29)

The callback-carrier restriction is now narrowed to the functions that need it.
When a dynamic-member equality candidate is actually encountered, the selector
performs one cached source-wide reference scan: only declaration names and
direct identifier calls are accepted. Any value use, including passing a named
function to an array HOF, keeps dynamic member equality on the direct path.
Sources without such a candidate pay no scan cost.

Functions used only through their declared ABI can reuse the existing
`dyn.member_get` plus dynamic equality lowering. This admits the exact
runtime-dynamic Acorn `checkKeyName` helper without changing the member reader,
boxing model, or any direct-backend file owned by draft PR #3796. The focused
runtime test covers both Acorn key shapes and pins the named-callback refusal.

The exact unchanged #3796 compile/outcome driver moves from 15 to **16 emitted
functions out of 43**, with zero ABI/lowering withdrawals. The final parity
step projects the direct declaration pass's inferred native-string parameter
into both selector and IR override types; scalar projected parameters are
accepted as boxable dynamic-equality operands. Without that shared projection,
selection succeeded but `checkKeyName` withdrew on a string-vs-dynamic
`typeIdx` mismatch.

Validation for this slice:

- exact #3796 driver: 16/43 emitted, zero post-claim withdrawals;
- focused dynamic-member/operator/callback suites: 30/30 pass;
- equivalence matrix: 8/8 shards, zero new regressions;
- typecheck, fallback/adoption/oracle, LOC, function-budget, and linear-IR
  gates pass.

The first PR run caught an eager-scan compile-work increase in the #3437
harness gate. Moving the proof behind the candidate arm removes that cost:
current `origin/main` and this branch both measure 111,517 shared
`forEachChild` calls on the deterministic harness fixture. The existing budget
is unchanged.

The required #3471 guard then exposed a second parity edge: lattice propagation
could classify an untyped polymorphic comparator parameter as string even
though its direct declaration ABI correctly stayed dynamic after inconclusive
call sites. Candidate parameter projection now reports that dynamic result
explicitly and takes precedence over nonnumeric lattice kinds in both selection
and the IR override. Grounded Acorn string parameters still project as string,
while `isSameValue(a, b)` retains its boxed dynamic ABI. The established
numeric speculative view remains intact so #3551 still exercises patch-time
parity withdrawal and caller-cascade safety.

Focused whole-compiler tests execute these paths in standalone and assert real
IR emission plus zero post-claim failures. The exact #3796 driver remains the
per-slice measurement input. Its synthesized module uses a 32,768-element
`array.new_fixed`; V8 rejects fixed arrays above 10,000 elements, so that
driver is a compile/outcome probe rather than the focused runtime fixture.

## Implementation Notes — implicit indexed-parameter ABI (2026-07-29)

Acorn's untyped `isInAstralSet(code, set)` now emits through IR. Direct
declaration lowering already infers `set` as the exact
`ref null __vec_f64` carrier from its call sites. Planning now reuses that
exact `IrType` instead of reducing the decision to a scalar-only label.
Projection remains restricted to `__vec_*` / `__arr_*` carriers; incidental
anonymous object shapes are not admitted.

Two selector seams were required by the exact source:

- the dynamic `code` parameter is compared with the proven numeric local
  `pos` inside a `for` loop, so the existing dynamic-to-number relational
  lowering is admitted for proven f64 counterparts and the dynamic-use scan
  now descends through ordinary `for` statements;
- `isIdentifierStart` and `isIdentifierChar` remain on the direct path because
  of their RegExp constructors. Standalone caller closure is relaxed only when
  every untyped parameter has a production-certified projection and at least
  one is an indexed carrier. Their already-emitted calls therefore keep the
  exact direct callable ABI while the leaf body moves to IR.

The unchanged #3796 runtime-dynamic compile/outcome driver moves from 16 to
**17 emitted functions out of 43**, with `isInAstralSet` added and zero
post-claim withdrawals. Remaining terminal blockers are:

- 15 body-shape rejections;
- 3 parameter-type rejections;
- 3 logical-value rejections;
- 2 RegExp-constructor rejections;
- 2 call-graph closures;
- 1 constructor-resolution rejection.

The slice does not touch the direct-backend files owned by draft PR #3796.

Validation for this slice:

- exact #3796 driver: 17/43 emitted, zero post-claim withdrawals;
- focused implicit-parameter and IR guard suites: 26/26 pass;
- broader curated guard matrix: 182 pass, 4 skipped;
- equivalence matrix: 8/8 shards, zero new regressions;
- typecheck, lint, fallback/adoption/oracle, LOC, function-budget, harness
  compile-budget, and linear-IR gates pass.

## Implementation Notes — unique module `var` scalars (2026-07-30)

Acorn's `functionFlags(async, generator)` now emits through IR. Its scope-bit
constants are unique top-level `var` declarations rather than lexical
bindings. The module-binding resolver now admits exactly numeric and boolean
`var` declarations in ES modules when the checker resolves one non-merged,
non-repeated declaration. Reads and writes reuse the existing allocator-owned
legacy module global; scripts, repeated declarations, and non-scalar values
remain outside this capability.

The helper's implicit boolean parameters are used only as ternary conditions.
That use is now eligible for the same direct-declaration inference projection
used by the callable ABI. Standalone caller closure is relaxed for an
all-boolean projected parameter set, while the existing indexed-carrier
exemption remains unchanged. The patch-time ABI guard still owns final parity.

The unchanged #3796 runtime-dynamic compile/outcome driver moves from 17 to
**18 emitted functions out of 43**, with `functionFlags` added and zero
post-claim withdrawals. The terminal blocker census becomes:

- 14 body-shape rejections;
- 3 parameter-type rejections;
- 3 logical-value rejections;
- 2 RegExp-constructor rejections;
- 2 call-graph closures;
- 1 constructor-resolution rejection.

The slice does not touch the direct-backend files owned by draft PR #3796.

Validation for this slice:

- exact #3796 driver: 18/43 emitted, zero post-claim withdrawals;
- focused module-var and prior #2949/ABI guards: 29/29 pass;
- module-binding matrix: 53 pass, with the same 2 stale assertions reproduced
  on current main;
- equivalence matrix: 8/8 shards, zero new regressions;
- typecheck, fallback/adoption/oracle, linear-IR, LOC, function-budget, and
  harness compile-budget gates pass.

## Implementation Notes — recursive boolean results with a dynamic ABI (2026-07-30)

Acorn's `isLocalVariableAccess` and `isPrivateFieldAccess` now emit through IR.
Both are unannotated recursive predicates: their declared callable ABI remains
dynamic, but every return expression is a boolean composition of comparisons
and direct self-recursion.

The selector proves that closed return family without changing the signature.
The dynamic-use scan then admits only boolean `&&` / `||` operands, including a
dynamic self-call result. AST-to-IR lowers those operands through `dyn.truthy`,
keeps short-circuit control flow, and boxes the concrete i32 result with the
Boolean tag at the dynamic return boundary. A mixed-value logical expression
such as `value || 42` remains `logical-value-unsupported`.

The unchanged #3796 runtime-dynamic compile/outcome driver moves from 18 to
**20 emitted functions out of 43**, adding `isLocalVariableAccess` and
`isPrivateFieldAccess` with zero post-claim withdrawals. The terminal blocker
census becomes:

- 14 body-shape rejections;
- 4 parameter-type rejections;
- 1 logical-value rejection;
- 2 RegExp-constructor rejections;
- 1 call-graph closure;
- 1 constructor-resolution rejection.

Draft PR #3808 independently adds grounded implicit-any numeric-local inference
to AST-to-IR. Its `from-ast.ts` changes are line-disjoint from this slice; the
first branch to rebase must retain both. Its closed fixed outer token-table
representation and specialized proven `Parser.options` open-object reads are
also IR parity requirements for retiring the direct path.

Validation for this slice:

- exact #3796 driver: 20/43 emitted, zero post-claim withdrawals;
- focused recursive-boolean and prior #2949 claim-flip suites pass;
- mixed-value logical fallback is pinned;
- typecheck and the standard IR gates pass.
