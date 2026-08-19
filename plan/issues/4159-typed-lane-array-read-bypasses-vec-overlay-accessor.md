---
id: 4159
title: "SOUNDNESS: typed-lane array element access bypasses the #3251 vec overlay — a defineProperty accessor index reads the stale element and drops the setter write (standalone, confirmed)"
status: done
completed: 2026-08-07
assignee: ttraenkler/W15
sprint: 78
created: 2026-08-04
updated: 2026-08-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone
language_feature: arrays, property-descriptors
goal: standalone-mode
related: [3251, 3116, 2042, 3185]
origin: "Design review of #3251's fast-path guard, 2026-08-04"
# (#3102 LOC ratchet) Work Item A declares two new CodegenContext flags. A
# context field has no subsystem module to live in — types.ts IS the
# declaration site — so the growth is the irreducible cost of the flags
# themselves, not logic added to a barrel. Comments were trimmed first; the
# full rationale lives in this issue instead.
# S3/S5 (2026-08-07): all emission logic lives in the NEW subsystem module
# src/codegen/typed-lane-overlay-route.ts. The residual growth at the two
# call sites (+20 / +14 after comment-trimming) is the dispatch decision
# itself — the gate + exclusion predicates + the routed call, which must sit
# where the receiver-shape facts (taClass, regexp-vec, arguments-rooted)
# already exist; re-deriving them inside the module would need raw checker
# queries the oracle ratchet forbids.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
# (#3400 func ratchet) +2 lines in createCodegenContext: the two new flags need
# an initialiser each, next to the existing protoIndexDirty. Same reasoning as
# the LOC grant — a context field's initialiser has exactly one legal home.
# S3/S5: compileElementAccessBody +19 / compileElementAssignment +13 — the
# dispatch gates described above; emission is in typed-lane-overlay-route.ts.
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/expressions/assignment.ts::compileElementAssignment
# (#1917 coercion engine) __unbox_number +1 in the new module: same native and
# same shape as the #3169 any-key retry arm this emission mirrors — (a) the
# numeric-retry NaN gate, (b) unboxing a getter's boxed return for a
# numeric-hint consumer. No new ToString/ToNumber matrix is introduced.
coercion-sites-allow:
  - src/codegen/typed-lane-overlay-route.ts
---

# #4159 — typed-lane array element access bypasses the vec overlay (accessor arm)

## Summary

`Object.defineProperty(arr, "1", { get, set })` on a statically-typed
`number[]` is **silently ignored** by the typed inline `array.get` / `array.set`
lane under `--target standalone`. The read returns the stale vec element and the
write goes into the vec instead of calling the setter. No trap, no diagnostic —
a wrong answer.

This is not a missing feature; it is an **incoherence between two halves of the
same object**. #3251's overlay made the *dynamic* lane correct while the typed
lane kept reading the raw backing, so `arr[1]` and `dyn[1]` on the same array at
the same instant disagree.

## Confirmed repro (2026-08-04, this branch, `pnpm install` + `npx tsx`)

```ts
// A — typed read through a getter
export function f(): number {
  const arr: number[] = [10, 20, 30];
  Object.defineProperty(arr, "1", { get: function () { return 99; }, configurable: true });
  return arr[1];                       // got 20, expected 99   ❌
}

// B — typed write through a setter
let seen: number = 0;
export function f(): number {
  const arr: number[] = [10, 20, 30];
  Object.defineProperty(arr, "1", {
    set: function (v: number) { seen = v; },
    get: function () { return 99; },
    configurable: true,
  });
  arr[1] = 5;
  return seen;                         // got 0, expected 5     ❌
}
```

Controls that PASS, which is what localises the bug:

```ts
// data descriptor on the same index — the value write-back keeps the vec coherent
Object.defineProperty(arr, "1", { value: 77, writable: true, configurable: true });
return arr[1];                         // got 77                ✅

// same array, same accessor, read through the DYNAMIC lane
const dyn: any = arr;
return dyn[1];                         // got 99                ✅
```

So: **data descriptors are fine, accessors are not, and only the typed lane is
wrong.** Probe scripts: `.tmp/probe-typed-accessor.mts`, `.tmp/probe2.mts`
(scratch, not committed — the repro above is self-contained).

## Root cause

From `src/codegen/vec-overlay.ts`'s own header (#3251 S1), the coherence
strategy is explicitly two-pronged:

> Data-define VALUES are written back INTO the vec (per-carrier
> `__vec_elem_set_<t>`) so the typed inline `array.get` fast path stays coherent
> with **zero read overhead** […] Dynamic reads (`__extern_get_idx` […]) get a
> finalize-spliced overlay prologue: accessor entries invoke their getter via
> `__call_accessor_get` […]

That is a sound design **for data descriptors only**. An accessor define has no
value to write back — and the epic's implementation plan says the typed read is
"raw `array.get` inline — NOT hookable cheaply". The result is that the accessor
arm has *no* path to the typed lane at all. `grep -n overlay src/codegen/object-ops.ts
src/codegen/expressions/*.ts` returns one comment and no consultation.

The epic's stated mitigation — "accessor defines do NOT extend the vec length
for OOB indices" (the #3116 hole-materialisation lesson) — protects only
*out-of-bounds* indices. The failing case is **in-bounds**, where the element
already exists and the typed read is a plain `array.get`.

## Why this matters more than its test count

- It is a **wrong answer, not a refusal**. The compiler emits confident code.
  Every other #3251 gap either throws or produces a diagnosable failure.
- It is **lane-incoherent within one program**: `arr[1] !== dyn[1]` for the same
  `arr` and the same instant, decided purely by the static type of the reference.
  Whether a read is correct depends on whether the type checker happened to keep
  the array monomorphic — an invisible, non-local property.
- The #3251 acceptance criteria include *"dense-array fast path unchanged (no
  perf/behaviour regression)"* — the fast path is indeed unchanged, which is
  exactly the problem. **The epic can meet its stated criteria with this hole
  open**, so it needs to be tracked separately rather than assumed covered.

## Suggested direction (needs an architect call, do not implement blind)

The tension is real and the whole point of the overlay is to avoid taxing the
dense path, so "just route typed reads through the overlay" is the wrong fix. A
guard is needed whose cost the dense case does not pay. Options, cheapest first:

1. **Per-carrier deopt flag consulted only when the module-global overlay state
   is non-null.** The existing outer guard
   (`global.get $__vec_overlay_state; ref.is_null`) already gives a
   near-zero-cost "no descriptors anywhere in this module" check. A typed read
   could emit `if overlay-state != null → call the dynamic path; else →
   array.get`. Programs that never touch `defineProperty` on an array pay one
   global load + null test per element access — measurable in a hot loop, so
   this needs benchmarking, not assertion.
2. **Hoist the guard out of the loop.** For a typed loop over a local array
   whose identity does not escape, the guard is loop-invariant; check once on
   entry and pick a dense or generic loop body. Same shape as the per-call
   protector proposed for prototype-chain lookups.
3. **Escape-based specialisation.** If a `number[]` local provably never reaches
   `Object.defineProperty`/`Reflect.defineProperty` or any dynamic sink, the
   typed lane is unconditionally safe and needs no guard at all. This is the
   only option with genuinely zero steady-state cost, and it is also the most
   work.
4. **Refuse instead of miscompiling.** Interim: if the compiler sees a
   `defineProperty` with an accessor descriptor targeting a value that also has
   typed-lane reads, emit a structured compile error. Turns a silent wrong
   answer into a diagnosable refusal while the real fix is designed. Consistent
   with the `STRICT_IR_REASONS` philosophy of promoting silent fallbacks to hard
   errors.

## Acceptance criteria

- `arr[1]` on a typed `number[]` with an accessor index invokes the getter, on
  both the typed and dynamic lanes, and the two agree.
- `arr[1] = v` invokes the setter rather than writing the backing.
- Dense-array benchmark suite shows no regression beyond an agreed budget —
  state the measured number, do not assert "negligible".
- Host/gc lane behaviour is determined and stated (see below).
- Standalone floor NET ≥ 0.

## Open questions

- **Host/gc lane is UNVERIFIED.** Instantiating the host build needs a
  `string_constants` import module that the quick probe could not supply, so the
  same repro was not run there. #3251 states the host lane routes through
  `__defineProperty_desc` / `__vec_set_elem` (#3116) imports, which suggests it
  may be coherent — but that is inference, not measurement. Verify before
  scoping.
- **Non-writable data descriptors, typed write** — `writable: false` then
  `arr[1] = 5` throws a `WebAssembly.Exception` in standalone. That may well be
  the spec-correct strict-mode `TypeError` (module code is strict); the probe did
  not decode the exception payload, so this case is **inconclusive** and is
  deliberately not claimed as a defect here.
- How many test262 files does this account for? Not measured. The #3251 epic
  sizes the accessor-index cluster at ~204 host-free assertion failures via the
  *dynamic* lane, which the overlay already fixed. The typed-lane share is
  probably small in test262 (the corpus is untyped JS) and much larger in
  real TypeScript input — which is the dogfooding risk, not a conformance one.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate` (record
  `#4159 … status=reserved`, read from `origin/issue-assignments`). The
  allocator's open-PR scan degraded (`gh` unavailable in this container), so
  `--allow-unscanned` was used after scanning the open-PR set through the GitHub
  API: two open PRs (#4106, #4123), highest issue id introduced is 4154. The
  required `check:issue-ids:against-main` gate remains the backstop.
- No regression test is added with this issue on purpose — a committed failing
  test would red the `equivalence-gate` for every unrelated PR. Add it with the
  fix.

## Implementation Plan

> **Superseded in four places by `## Architect Spec (fable)` below (2026-08-05).**
> That review ran three new probes and refuted: (1) Work Item C's premise — the
> dynamic write path does not invoke setters either, so routing typed writes
> there today converts "wrong value stored" into "write silently dropped";
> (2) `getVecOverlayCore(ctx)` — unimplementable, the overlay core is minted at
> finalize, after body compilation; (3) part of the write-site list —
> `assignment.ts` L4459 is the `$__subview` arm and is out of scope;
> (4) #4160's generic-arm location. The compile-time pre-scan-flag mechanism
> itself was **confirmed**. Where the two disagree, the architect spec wins.

### Root cause

`compileElementAccessBody` (`src/codegen/property-access.ts`, ~L5285-5330) lowers
a typed `arr[i]` to `struct.get $__vec_<k> 1` (the backing) followed by a raw
`array.get`. It never consults the #3251 companion table, so an accessor entry —
which by construction has **no value written back into the vec** — is invisible.
The write side is the same shape: `emitBoundsGuardedArraySet`
(`property-access.ts:3361`) and the `array.set` sites in
`expressions/assignment.ts` (~L4459, ~L4634-4653) store into the backing without
asking whether index `i` carries a setter.

### The design constraint, and why a runtime guard is the WRONG first answer

The premise of #3251's overlay is that the dense path pays nothing. A runtime
check at every element access (`global.get $__vec_overlay_state; ref.is_null`)
would put a load and a branch inside every counted loop — including the
`isSafeBoundsEliminated` arm, which exists specifically to make hot loops emit a
bare `array.get`. That trades a correctness bug for a perf regression.

**This codebase already has the right pattern, twice, and it is a COMPILE-TIME
flag, not a runtime cell:** `ctx.usesArrayHoles` and `ctx.arrayProtoIndexDirty`
(`src/codegen/array-holes.ts`, `scanForArrayHoles`, #2001 S2). Both are set by a
cheap AST pre-scan before body compilation; when clear — the overwhelmingly
common case — the guarded emission is simply never generated and every array
read stays **byte-identical**. That is a stronger no-regression guarantee than
any benchmark argument, because there is no new instruction to measure.

The pre-scan's own header states the reason it must be a pre-pass rather than a
lazy per-site flag: function compilation order is not source order, so a lazily
set flag desyncs reads in one function against stores in another. The same
hazard applies here — reuse the pre-scan, do not invent a lazy flag.

### Work Item A: `ctx.vecAccessorDescriptorDirty` pre-scan flag — **LANDED 2026-08-05**

Shipped with #4160 slice 1 in one commit (the spec's own "land A once, consume it from both"). `isNonDataDescriptorDefine` covers `Object.defineProperty`/`defineProperties`/`Object.create`/`Reflect.defineProperty`, treats a provably data-only literal as clean (so #3251's value write-back keeps its fast path), and recurses one level into a descriptor bag. A descriptor held in a variable, a spread, or a computed key all set the flag — unprovable means dirty. Byte-identity A/B'd against main over 14 compilations: identical. Work Items B and C remain.

**Risk**: Low — purely additive; no emission changes at all.
**Priority**: 1st

**File: `src/codegen/array-holes.ts`** (or a sibling; `scanForArrayHoles` is
already the single AST pre-scan pass and its early-exit already tracks two flags)
- Extend the existing `visit` walk with a third predicate,
  `isAccessorDescriptorDefine(node)`: a call to
  `Object.defineProperty` / `Object.defineProperties` / `Object.create` /
  `Reflect.defineProperty` whose descriptor argument is **not provably a
  data-only object literal**. An object literal carrying only
  `value`/`writable`/`enumerable`/`configurable` keys is provably data-only and
  does NOT set the flag; anything with `get`/`set`, a spread, a computed key, or
  a non-literal descriptor expression DOES.
- Deliberately over-approximate, exactly as `isArrayProtoIndexWrite` does: a
  module that might install an accessor anywhere loses the typed fast path
  everywhere. Record that in the doc comment.

**File: `src/codegen/context/types.ts`** — add `vecAccessorDescriptorDirty: boolean`.
**File: `src/codegen/context/create-context.ts`** — initialise `false` (~L130,
next to `arrayProtoIndexDirty`).

**Test**: a unit test asserting the flag is set for
`Object.defineProperty(a, "1", {get(){}})` and clear for
`Object.defineProperty(a, "1", {value: 1})`. No codegen assertions yet.

### Work Item B: route the typed READ when the flag is set
**Risk**: Medium — touches the hot element-read path, but only under the flag.
**Priority**: 2nd

**File: `src/codegen/vec-overlay.ts`**
- Export the overlay-core handles. `VecOverlayReserved` already carries
  `stateGlobalIdx` and `lookupIdx` but the interface is only consumed
  in-module; expose a `getVecOverlayCore(ctx)` accessor so `property-access.ts`
  can emit a call without importing internals piecemeal.

**File: `src/codegen/property-access.ts`**
- Function `compileElementAccessBody` (~L5285-5330). Gate on
  `ctx.standalone && ctx.vecAccessorDescriptorDirty`. When set, emit the
  overlay-aware read instead of the raw `array.get`:
  `state == null ? array.get : __extern_get_idx(vec, i)`. The dynamic chokepoint
  already has the finalize-spliced accessor prologue (#3251) and is proven
  correct by control C in the repro above — **reuse it, do not re-implement the
  accessor invocation.**
- The `isSafeBoundsEliminated` arm gets the same treatment. Do **not** try to
  keep it bare: if the module might install an accessor, a bounds-eliminated
  read is exactly as unsound as any other.
- When the flag is clear, the function must emit what it emits today, byte for
  byte. Assert this with a WAT-diff test, not by inspection.

**Test**: `.tmp` repro case A promoted to `tests/issue-4159.test.ts` —
`arr[1]` returns 99, and `(arr as any)[1]` still returns 99.

### Work Item C: route the typed WRITE when the flag is set
**Risk**: Medium.
**Priority**: 3rd

**File: `src/codegen/expressions/assignment.ts`** (~L4459, ~L4634-4653) and
**`src/codegen/property-access.ts`** `emitBoundsGuardedArraySet` (L3361)
- Same gate, same shape: route to the dynamic set path so a setter entry invokes
  `__call_accessor_set` and a `writable:false` entry drops the store (or throws
  in strict mode — see the open question below, resolve it before implementing).

**Test**: repro case B — `arr[1] = 5` calls the setter.

### Edge cases

- **Data descriptors must not regress.** They are correct today via the
  value write-back; the flag must not reroute them into a slower path
  unnecessarily. Control B in the repro is the regression test.
- **`Object.create(proto, descriptorBag)`** — a descriptor bag is a *nested*
  object literal, so the "provably data-only" check has to recurse one level.
- **A descriptor held in a variable** (`const d = {get(){}}; defineProperty(a,"1",d)`)
  is not a literal at the call site — the over-approximation must catch it, which
  the "not provably data-only" phrasing does.
- **Host/gc lane** — gate on `ctx.standalone` until the host behaviour is
  measured (open question below). Host output must stay byte-identical.

### Sequencing note

Work Item A is independently valuable and zero-risk: it can land alone, and the
flag it introduces is the same mechanism **#4160** needs for prototype-chain
index inheritance (that issue's `Object.prototype` scan is the sibling
predicate). Land A once, consume it from both.

### What this plan deliberately does NOT do

- No runtime protector global in the element-access path — see above.
- No escape analysis. It would give a tighter flag (per-array rather than
  per-module) but it is a much larger change, and the compile-time module flag
  already gives byte-identical output for every program that does not call
  `defineProperty` with an accessor — which is approximately all real input.
  Escape analysis is the follow-up if the coarse flag ever measurably hurts a
  real workload; file it then, with the measurement.

## Architect Spec (fable, 2026-08-05)

Unified spec for the shared substrate behind #4159 + #4160, validating the draft
`## Implementation Plan` above against the code and against three new
measurements. Probes run on this tree (standalone target, compile + instantiate):

| Probe | Program | Expected (spec) | Measured |
| --- | --- | --- | --- |
| P1 | dynamic-lane `arr[1] = 5` through a defined setter | 5 (setter runs) | **0 — write silently dropped** |
| P2 | `Array.prototype.forEach.call({0:0,2:2,length:3})` after `Object.prototype[1]=111` | sum 113, visits 3 | **sum 2, visits 2 — absent own index skipped, inherited index invisible** |
| P3 | `Object.prototype[1]=111` then `({length:3})[1]` | 111 | **miss (NaN) — the write lands nowhere** |

### Verdict

The compile-time pre-scan-flag design is **correct and confirmed as the right
mechanism** — when the flags are clear no new instruction exists, which is the
byte-identity guarantee the draft wants. But the draft is wrong in four places,
each of which changes the work plan:

1. **Work Item C's premise is false (P1).** "Route the typed write to the dynamic
   set path so a setter entry invokes `__call_accessor_set`" assumes a
   setter-invoking dynamic path. There isn't one: the `__extern_set` overlay
   prologue hits `FLAG_ACCESSOR` and emits a bare `return`
   (`src/codegen/vec-overlay.ts:1404-1409`) — silent drop, measured. The
   setter-invoke + `writable:false` enforcement is exactly #3251 **S2**,
   implemented and validated but UNMERGED on fork branch
   `issue-3251-s2-write-enforcement` (tip `766af9b980`, per the epic's 2026-07-23
   reconciliation note). The write slice must land **after** (or subsume) S2 —
   routing typed writes into today's `__extern_set` only changes "wrong value
   stored" into "write silently dropped".
2. **`getVecOverlayCore(ctx)` cannot exist as proposed.** The overlay core (state
   global, numeric-flag global, `__vec_overlay_lookup`) is minted at FINALIZE
   only — `fillVecOverlayHelpers` -> `ensureOverlayCore`, ctx fields set at
   `vec-overlay.ts:313-324`. `compileElementAccessBody` runs during body
   compilation, before any of those indices exist, so a typed read can never bake
   `global.get $__vec_overlay_state`. The correct emission is a `call` to
   **`__extern_get_idx` by funcMap name** (reserved early under standalone by
   `ensureObjectRuntime`; the overlay prologue is finalize-spliced into it,
   `vec-overlay.ts:1494-1608`, and is the path repro control C already proves
   correct). See (d).
3. **The draft's write-site list is partly wrong.** `assignment.ts` ~L4459 is the
   `$__subview` (TypedArray subarray) arm — integer-indexed-exotic semantics,
   explicitly out of overlay scope; do not touch it. The real plain-vec
   user-write sites are enumerated in (c).
4. **#4160's generic arm does not primarily live in `__hof_*`.** Measured (P2):
   `Array.prototype.forEach.call(obj, function(){...})` with an inline callback
   compiles through `compileArrayLikeBorrow`
   (`src/codegen/array-prototype-borrow.ts:339-489`), an inline per-call-site
   loop that already gates every iteration on `__extern_has_idx` ("spec
   HasProperty used to skip holes", `array-prototype-borrow.ts:607`) — that is
   why P2 skipped the absent index. The missing piece is not a new loop shape; it
   is that **`__extern_has_idx` / `__extern_get_idx` answer own-only** and there
   is **no runtime store for prototype index writes at all** (P3). Put the
   prototype fallback in those two chokepoints and every consumer (borrow loops,
   `__hof_*` Gets, direct dynamic reads) is fixed at once.

### (a) The `arrayProtoIndexDirty` claim — VERIFIED

Exactly one consumer: `shouldHoleSkip` (`src/codegen/array-methods.ts:5590-5592`,
`ctx.usesArrayHoles && !ctx.arrayProtoIndexDirty && elemType.kind === "externref"`).
Its effect is only to DISABLE the #2001-S2 HOF hole-visit-skip, falling back to
visit-with-`undefined` (doc comment at `array-methods.ts:5581-5588` says so
explicitly). No prototype walk exists anywhere downstream of the flag. Setter:
`scanForArrayHoles` (`src/codegen/array-holes.ts:69-70`), predicate
`isArrayProtoIndexWrite` (`array-holes.ts:107-132`) — `Array.prototype` only
(`isArrayPrototypeExpr`, L78-85). Declared `context/types.ts:1407`, initialised
`create-context.ts:130`. Pre-scan call sites: `codegen/index.ts:3859`
(single-source) and `index.ts:6337` (multi-source, OR across files).

### (b) Flags: THREE, one shared walk; the eval hole is real but compile-time-closable

Distinct flags, because their consumers and their deopt costs are disjoint — one
merged flag would make `Object.prototype[0] = 1` deoptimise every typed element
read and an array accessor-define deoptimise every HOF loop:

- **`vecAccessorDescriptorDirty`** (#4159) — "some array receiver may carry a
  non-data / non-writable own descriptor". Consumers: typed element read/write
  lanes only.
- **`protoIndexDirty`** (#4160) — the existing `arrayProtoIndexDirty` with
  `isArrayPrototypeExpr` widened to `Object.prototype` (rename; only 5 references
  exist, all listed in (a), so migrate rather than alias). Consumers:
  `shouldHoleSkip` (existing) + the new runtime-store emissions in (c).
- **`dynamicCodeDirty`** — set by any call whose callee identifier is `eval` or
  `Function` / `new Function(...)`. ORs into BOTH flags above (i.e. the scan sets
  both when it fires). Rationale below.

All three set by the **existing** `scanForArrayHoles` walk (extend the early-exit
at `array-holes.ts:60` to include the new flags, or it will stop scanning before
finding them). Same over-approximation discipline, same pre-pass timing — the
function-compilation-order desync argument in the file header
(`array-holes.ts:52-57`) applies identically.

**The eval hole is real, and it already bites the EXISTING flag today.** Static
eval inlining (#1163, `src/codegen/expressions/eval-inline.ts:1-18`) parses a
compile-time-constant eval string and splices its statements into the current
function **during body compilation** — after the pre-scan has run. So
`eval('Array.prototype[0] = 1')` never sets `arrayProtoIndexDirty` on today's
main. Setting the flag lazily at splice time is unsound (the desync hazard
above), so the fix is the `dynamicCodeDirty` predicate: eval presence dirties
everything, compile-time only.

**A runtime cell is NOT needed, including for the dynamic-code lane.** Measured
basis: standalone has no runtime store that eval'd code could invalidate — P3
shows a prototype index write lands nowhere. Runtime eval (host `__extern_eval`
#1164, standalone provider `js2wasm:runtime-eval` #2928/#2527) runs the eval'd
script in a fresh module / the interp; its prototype writes cannot reach the
parent's compiled arrays today, so there is no working behaviour for a missed
invalidation to break. Once `dynamicCodeDirty` forces the generic arm, that arm
consults the runtime stores introduced in (c) — which is precisely the surface a
future runtime-eval boundary write would have to target anyway. A runtime cell
buys something only if we want eval-containing modules to KEEP the fast path;
that is a measurement-driven follow-up, not part of this substrate. (UNVERIFIED:
whether the runtime-eval interp can mutate a parent-module array passed across
the boundary at all; irrelevant to soundness under the over-approximation,
relevant only to that future refinement.)

### (c) The generic arm, concretely

**#4160 — prototype-index store + chokepoint fallbacks (standalone).**

1. **Store.** Two module globals `(ref null $Object)` — companions for
   `%Object.prototype%` and `%Array.prototype%` — in a NEW sibling module
   (suggest `src/codegen/proto-index-store.ts`; vec-overlay is 1,748 lines and
   under the #3102 ratchet). Companion minted on first write via
   `__new_plain_object`, so the `$Object` machinery (`__obj_find`,
   `__defineProperty_value` validation) is reused wholesale — the same
   delegate-don't-duplicate argument as #3251's companion.
2. **Write arms** (all emission gated on `ctx.standalone && ctx.protoIndexDirty`):
   - `__extern_set` gets a `$NativeProto` brand arm: `ref.test $NativeProto`
     (`ctx.nativeProtoTypeIdx`, `native-proto.ts:180-198`) -> brand ==
     Object.prototype / Array.prototype glue brand (`getBuiltinBrand`) -> numeric
     key -> store into the matching companion. This is what makes
     `Object.prototype[1] = 1` land (P3 fix). Splice at the same finalize point
     as the existing prologues, same append-locals discipline.
   - `__defineProperty_value` / `__defineProperty_accessor` get the same brand
     arm (covers `Object.defineProperty(Array.prototype, "0", ...)`, which
     `isArrayProtoIndexWrite` already recognises as a dirtying shape).
3. **Read fallbacks** (same gate): final arms in **`__extern_has_idx`** and
   **`__extern_get_idx`** — after own struct fields / sidecar / vec / companion
   arms miss, canonical non-negative integer key -> consult the Array.prototype
   companion iff the receiver is a `$__vec_base`, then the Object.prototype
   companion for every receiver. This mirrors the host lane's architect-ratified
   design `_protoIndexHas` / `_protoIndexGet` (`src/runtime.ts:372-417`,
   consulted at `runtime.ts:9692` and `:9776`), including accessor invocation on
   Get. One store, two chokepoints, every consumer inherits it:
   `compileArrayLikeBorrow`'s has-gated loop
   (`array-prototype-borrow.ts:346-351,472`), the `__hof_*` steppers' Gets
   (`hof-native.ts:143-148`), and plain dynamic `o[i]`.
4. **`__hof_*` HasProperty gate.** `ensureNativeArrayHof` builds its loop at
   reserve time with NO per-index presence check (`hof-native.ts:351-374` — every
   index in `[0,len)` is visited). Under `protoIndexDirty` only, wrap the
   per-iteration body of the presence-sensitive methods
   (forEach/map/filter/some/every/reduce/reduceRight per §23.1.3.*) in
   `if (__extern_has_idx(recv, i))` — the flag is known before any body compiles,
   so the flag-clear helper body is byte-identical by construction. (The
   own-absent-index visit-with-undefined bug for flag-CLEAR modules is real but
   belongs to #3185/#2001 scope, not this substrate — do not widen here.)
5. **`LengthOfArrayLike` as a real `[[Get]]`** stays #4160 slice 3, independent
   of these flags; nothing here blocks it.

**#4159 — typed-lane routing (standalone).**

- **Read** — `compileElementAccessBody` (`src/codegen/property-access.ts:4452`
  ff.). Two regions to gate on `ctx.standalone && ctx.vecAccessorDescriptorDirty`:
  the vec-struct arm (raw fast paths at L5299-5314 `isSafeBoundsEliminated`
  `array.get` and the shared bounds-checked read at L5379) and the raw-array arm
  (L5416-5435 ff.). When the flag is set: `extern.convert_any` the receiver,
  `f64.convert` the index, `call __extern_get_idx` (funcMap name — #16 re-resolve
  discipline, exactly as `hof-native.ts:91-97` does), then coerce the externref
  result back to the expected ValType (`__unbox_number` for an f64 context; pass
  through for externref). Defensively `ensureObjectRuntime(ctx)` first and fall
  back to today's raw emission if `__extern_get_idx` is absent — a flag-set
  module virtually always has the runtime already (the dirtying `defineProperty`
  call pulls it in), but `dynamicCodeDirty` can set the flag without it. Do NOT
  exempt the `isSafeBoundsEliminated` arm (draft is right here).
- **Write** — same gate, route to
  `__extern_set(recvExt, __box_number(f64 i), boxedValue)`. Sites (audited;
  complete for user-visible element writes):
  - `expressions/assignment.ts` L4654-4667 (bounds-eliminated `array.set`),
    L4699-4816 (grow path, store at L4816), L4943 (raw-array assign),
    L2640-2651 (destructuring element target `[a[i]] = src`).
  - `expressions/unary-updates.ts` L1863 and the `emitBoundsGuardedArraySet`
    calls at L913/L926 (`arr[i]++` family; helper defined at
    `property-access.ts:3362`).
  - NOT `assignment.ts` L4459 (`$__subview`) and NOT the L4423-4428 `$__ta_view`
    arm — integer-indexed exotics, out of scope.
  - `assignment.ts` L1909 (rest-destructuring copy loop) writes a fresh internal
    array — leave the write; note its paired `array.get` READ of the source vec
    is a per-index `[[Get]]` in spec terms (an accessor should fire on rest
    destructuring). Record as a known boundary, don't fix in this pass.
  - **Sequencing: this slice lands only after #3251 S2** (see Verdict 1). Resolve
    the `writable:false` strict-throw open question there — module code is
    strict, so §13.15.2/§10.1.9 requires a TypeError; today's dynamic lane
    silently drops, which S2's enforcement arm is the right place to fix.

**Host lane.** All of the above is `ctx.standalone`-gated; host output must be
byte-identical (the #1917 sha-compare discipline, as done for #3251 S1). Two open
host questions stay open and are NOT resolved by this spec: the #4159 host repro
(issue's own open question), and why 63% of the #4160 cluster fails on host
despite `_protoIndexHas/Get` existing there — a host-lane probe is the first task
of whoever picks up #4160's host half; do not assume the standalone mechanism
transfers.

### (d) Exports from vec-overlay.ts: NONE needed

With routing through `__extern_get_idx` / `__extern_set`, the cross-module "API"
is funcMap names — the established pattern (`hof-native.ts:91-97`,
`ta-hof-map-filter.ts:74`, `array-prototype-borrow.ts:471-484`). The draft's
`getVecOverlayCore(ctx)` is rejected: its handles do not exist until finalize
(Verdict 2), and exporting them would invite baked global indices that the
`registry/imports.ts:456-457` shift fixup only partially covers. The overlay's
ctx-visible fields (`vecOverlayStateGlobalIdx` / `vecOverlayNumericGlobalIdx`,
`context/types.ts:1829-1841`) already exist for the shift machinery — do not grow
that surface. The #4160 proto-index store is a new module and consumes
object-runtime natives by name; nothing from vec-overlay.

### (e) Slices, risk, and how byte-identity is PROVEN

Proof method, per slice: an A/B compile of a fixed corpus (all
`playground/examples/*.ts` + the dense-array benchmarks) on branch vs main,
comparing sha256 of the emitted standalone binary per file (the
`.tmp/probe-host-bytes.mts` pattern from #3251 S1), with a WAT dump diff of any
differing function. Shas pasted into the PR description. Additionally commit one
durable structural test per consumer slice: compile a canonical flag-clear
dense-loop program and assert the emitted WAT for the loop function contains
**no** `call $__extern_get_idx` / no `__extern_has_idx` gate — that assertion
survives in CI where a branch-vs-main diff cannot.

| # | Slice | Contents | Risk | Byte-identity proof scope |
| --- | --- | --- | --- | --- |
| S0 | Pre-scan flags (lands alone; #4159 WI-A + #4160 slice 1 merged) | `vecAccessorDescriptorDirty` + `protoIndexDirty` widening + `dynamicCodeDirty` predicate; ctx fields; early-exit fix at `array-holes.ts:60`; flag unit tests | **Low** | Corpus-wide identical EXCEPT programs with (`usesArrayHoles` and (`Object.prototype` index write or eval)), where `shouldHoleSkip` now correctly disables — an intended, existing-consumer behaviour change; name those files in the PR |
| S1 | #4160 store + chokepoint arms | proto-index-store module; `__extern_set`/define-native `$NativeProto` brand arms; `__extern_has_idx`/`__extern_get_idx` fallback arms | **Medium-high** (MOP chokepoints; finalize-splice discipline — append locals, fresh Instr factories per the shared-instr double-remap hazard) | Corpus-wide identical (all emission flag-gated); P2 -> 113/3, P3 -> 111 |
| S2 | #4160 `__hof_*` has-gate | flag-gated per-iteration `__extern_has_idx` in `ensureNativeArrayHof` | **Medium** | `__hof_*` bodies flag-clear identical; `15.4.4.18-7-b-12` passes |
| S3 | #4159 typed READ | `compileElementAccessBody` both arms | **Medium** (hot path, but compile-time-gated) | Corpus-wide identical; repro A returns 99 on both lanes; control B (data descriptor) unregressed |
| S4 | Land #3251 S2 | salvage fork branch `issue-3251-s2-write-enforcement` (fresh main merge + revalidate, per epic notes) | **Medium** (pre-validated but 2 weeks stale) | Its own #3251 discipline; P1 -> 5 afterwards |
| S5 | #4159 typed WRITE | assignment/unary-update sites in (c) | **Medium-high** (most sites; strict-throw semantics decided in S4) | Corpus-wide identical; repro B returns 5; `writable:false` behaviour matches S4's decision on both lanes |

S0 is the shared substrate both issues consume — land it once, first. S1/S2
(#4160) and S3 (#4159) are independent after S0 and can proceed in parallel
lanes; S5 strictly after S4.

### Two NEW confirmed defects surfaced by this review

Neither is covered by an existing issue and both are measured, not inferred:

- **P1 — the DYNAMIC write lane drops setters too.** `vec-overlay.ts:1404-1409`
  returns bare on `FLAG_ACCESSOR`. #4159's summary says "only the typed lane is
  wrong"; that is now known to be too narrow for **writes** (it remains accurate
  for reads, where control C passes). The fix is #3251 S2, which exists but is
  unmerged.
- **P3 — a prototype index write lands nowhere in standalone.**
  `Object.prototype[1] = 111` followed by `({length:3})[1]` misses entirely.
  This is the substrate #4160 assumed it could extend; it does not exist yet, so
  #4160's slice 1 must CREATE the store, not just widen a scan.

### Verification of the architect spec (opus, 2026-08-05)

The spec above was independently re-checked rather than taken on trust. All
three probes reproduce exactly as reported, on this tree:

```
P3  Object.prototype[1]=111 then ({length:3})[1]  -> NaN   (expected 111)
P1  dynamic arr[1]=5 through a defined setter     -> 0     (expected 5)
P2  forEach.call over array-like, inherited idx   -> 2     (expected 113)
```

Citations spot-checked and confirmed verbatim: the bare `return` on
`FLAG_ACCESSOR` (`vec-overlay.ts` ~L1409), the `__extern_has_idx` hole-skip
comment (`array-prototype-borrow.ts:607`), `shouldHoleSkip` as the sole
`arrayProtoIndexDirty` consumer (`array-methods.ts:5590-5592`), and the host
lane's `_protoIndexHas`/`_protoIndexGet` (`runtime.ts:409/417`, consulted at
`:9692` and `:9776`).

**One claim is UNCONFIRMED and slice S4 must not be planned as a salvage until
it is checked.** The spec states that #3251 S2 is "implemented and validated but
UNMERGED on fork branch `issue-3251-s2-write-enforcement` (tip `766af9b980`)".
That is a faithful quotation of the epic (`plan/issues/3251-…md:345-352`) — but
it is a citation of a *document*, not of the *remote*. From this checkout:

- `git ls-remote --heads origin | grep -c 3251` -> **0**
- `git cat-file -t 766af9b980` -> **not a valid object name**

`origin` here is upstream (`loopdive/js2`) and no `fork` remote is configured, so
the branch was simply invisible from this checkout.

**RESOLVED 2026-08-05 — the branch exists and the spec's claim stands.** Confirmed
by the project lead against the fork (`ttraenkler/js2`):
`issue-3251-s2-write-enforcement` is present, not deleted and not moved, and its
tip is exactly `766af9b980` (full sha
`766af9b9801188a1f6a5af2edf02e98e497bad4f`) — a merge commit dated 2026-07-18,
*"Merge branch 'issue-3251-array-overlay-s1' into
issue-3251-s2-write-enforcement"*.

**S4/S5 are therefore a SALVAGE, not unwritten work**, and the architect spec's
sequencing holds as written: merge current `main` into that branch, re-validate,
and open the S2+S3 PR. The pre-check this section asked for is discharged; no
further gate on S4 from this direction.

The lesson worth keeping is about the *method*, not the outcome: the epic's prose
turned out to be accurate, but it was still a report about external state, and a
checkout that cannot see the fork cannot confirm it. Verify against the remote
that owns the ref, or say plainly that you could not.

## Test Results — S3+S5 implementation (W15, 2026-08-07)

Implemented per the architect spec, with one deliberate widening: S3 routes
BOTH numeric-provable keys (`__extern_get_idx` direct) and everything else
(externref key → `__extern_get`, miss-retry positionally — the #3169 arm's
exact order + string gate), because the test262-relevant shape is a
STRING-spelled index on a vec-typed receiver (the propertyHelper
monomorphization: a helper whose `obj` param only ever receives arrays gets
the vec type, and its `obj[name]` read took the typed lane). All emission in
`src/codegen/typed-lane-overlay-route.ts`; dispatch gates at
`compileElementAccessBody` (vec arm) and `compileElementAssignment`
(isVecStruct arm), `ctx.standalone && ctx.vecAccessorDescriptorDirty` only.

**Chokepoint health was measured BEFORE routing into them** (probe chain
`.tmp/p1..p10`, worktree `agent-a29d9657414900b64`): `__extern_get_idx`
invokes companion getters for numeric keys; `__extern_get` for string keys;
`__extern_set` invokes setters, enforces `writable:false` (#3251-S2 / PR
#4142) and grows on OOB index writes. One pre-existing dynamic-lane hole is
NOT fixed here (deliberately): a `number|string` UNION-typed key on an
externref receiver reaches `__extern_get` as a boxed number and misses
(`isAnyTypedIndexExpression` excludes unions from the #3169 retry by design —
widening it is a separate decision with its own blast radius).

| measurement | result |
| --- | --- |
| tests/issue-4159.test.ts on origin/main (file-copy A/B) | 4 repros RED, 4 controls green |
| tests/issue-4159.test.ts on branch | 8/8 green |
| 558-file descriptor lever, post-#4155 base | 178/558 |
| 558-file descriptor lever, this branch | **185/558 — FIXED 7, BROKE 0** |
| gates | tsc, oracle-ratchet +0/+0, loc/func-budget (granted, see frontmatter), coercion-sites (granted), ir-fallbacks all OK |

The modest lever delta is EXPLAINED, not unexpected: 172 of the 373 remaining
lever failures compile in runtime-eval CONSUMER mode (propertyHelper's
`Function.prototype.call.bind` primordial captures flip the whole module), and
there a function-DECLARATION getter is a broken callable before any
read-routing matters — root-caused and filed as **#4197** with the full probe
chain. This fix's primary value is soundness for real typed input (the
lane-incoherence wrong-answer) plus the non-consumer-mode slice of the lever.
