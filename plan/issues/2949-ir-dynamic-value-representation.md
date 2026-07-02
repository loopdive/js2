---
id: 2949
title: "IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType (make untyped JS claimable)"
status: in-progress
assignee: ttraenkler/fable-1
sprint: current
created: 2026-07-02
updated: 2026-07-02
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
