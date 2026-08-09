---
id: 3484
title: "Iterator Helpers (host lane): Iterator global + Iterator.prototype.{map,filter,take,drop,flatMap,reduce,find,some,every,forEach,toArray} — ~84 host fails"
status: blocked
blocked_reason: "Slice 1 (un-gate native helpers to host) is infeasible as scoped — the native iterator substrate transitively requires the standalone object runtime, which is not host-safe (see Investigation findings 2026-07-21). Needs an architect decision between (A) host-safe object runtime and (B) AST desugaring to for-of, before a dev can proceed."
created: 2026-07-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
goal: test262-conformance
model: opus
sprint: Backlog
horizon: xl
related: [2903]
---

# #3484 — Iterator Helpers for the host lane

Implement the TC39 Iterator Helpers proposal (`%Iterator.prototype%.{map, filter,
take, drop, flatMap, reduce, find, some, every, forEach, toArray}` + the `Iterator`
global) for the **JS-host lane**. ~84 host-lane test262 fails
(`built-ins/Iterator/prototype/**`) currently report `X is not a function` and a
handful of value mismatches.

## Current state (verified 2026-07-20 while triaging)
- **The native helpers already exist — but STANDALONE ONLY.** `iter-lazy-native.ts`
  (`LAZY_ITER_METHODS = {map, filter, take, drop, flatMap}`) and `iter-hof-native.ts`
  (`NATIVE_ITER_HOF_METHODS = {find, every, some, forEach, reduce, toArray}`) emit
  WasmGC helper constructors via `closed-method-dispatch.ts`, gated on
  `ctx.standalone` (closed-method-dispatch.ts:243/253). In HOST mode `iter.take(n)`
  routes through `__extern_method_call`, which cannot drive a WasmGC iterator →
  silently `undefined`.
- **The `Iterator` global is not defined in either lane.** A bare `Iterator`
  identifier falls to the "unimplemented global" null-externref fallback
  (`expressions/identifiers.ts:1221`).
- **Host-reflection shortcut does NOT work (ruled out).** Exposing bare `Iterator`
  as `__extern_get(__get_globalThis(), "Iterator")` so `Iterator.prototype.take.call(x)`
  uses Node's native (spec-compliant) helpers FAILS: our iterators AND plain objects
  are WasmGC/`$Object` values the host's `Iterator.prototype.take` can't drive via
  `.call` (probe: `[].values()` → yields 0; `{next(){…}}` → "undefined is not a
  function"). So the helpers must be implemented natively in-compiler for the host
  lane too — not delegated to the host.

## Failure shape
Tests use BOTH forms:
1. Method-call: `iter.map(f).take(n).toArray()` (host-lane: currently `undefined`).
2. First-class + generic: `Iterator.prototype.take.call(genericObj, limit)` where
   `genericObj` is any object with a `.next` method (GetIteratorDirect). Requires a
   real `Iterator.prototype.take` function value + generic applicability.
Method frequency in the 84: flatMap 12, every 9, some 9, take 8, find 8, reduce 8,
map 6, forEach 6, filter 5, drop 2, toArray 1 (+ ~10 semantic/edge).

## Implementation plan (multi-PR; take L/XL, land coherent slices)

**Slice 1 — extend the existing native helpers to the HOST lane.** Un-gate
`NATIVE_ITER_HOF_METHODS` / `LAZY_ITER_METHODS` from `ctx.standalone` in
`closed-method-dispatch.ts` and make the WasmGC helper structs + GetIterator ladder
work when the receiver is a `$Object`/externref (host lane). This flips the
method-call-form tests (`x.map().take().toArray()`). Verify no host regression (the
methods previously no-op'd to `undefined`; ensure the native path now wins the
dispatch for iterator receivers without breaking Array/vec `.map`).

**Slice 2 — the `Iterator` global + `%Iterator.prototype%`.** Define `Iterator`
(abstract constructor: `new Iterator()` throws TypeError; `Iterator.prototype` is a
real object) and expose the helper methods as own properties of `Iterator.prototype`
as first-class function values (so `Iterator.prototype.take` is a function). Route a
bare `Iterator` identifier (host lane, unshadowed, not a user class) in
`identifiers.ts` before the null fallback.

**Slice 3 — generic applicability (`.call`).** `Iterator.prototype.take.call(obj, n)`
must apply to any object with `.next` (GetIteratorDirect, §27.1.4.x): the helper
reads `obj.next`, builds a helper-iterator that pulls from it. Plus spec edges:
RangeError on negative/NaN limit for take/drop (currently clamped, per
iter-lazy-native boundaries), IteratorClose on early return, `return`-method
propagation, helper-iterator `[Symbol.iterator]`/brand.

## Acceptance
- `built-ins/Iterator/prototype/{map,filter,take,drop,flatMap,reduce,find,some,every,
  forEach,toArray}/**` host-lane pass (target the ~84 fails; Slice 1 alone should
  flip the method-call-form majority).
- Standalone lane unchanged (already green via the native path).
- Zero regression on Array/vec `.map`/`.filter`/`.reduce` (which must keep eager
  semantics, not lazy iterator wrappers).

## Notes for the implementer
- Reuse `ensureNativeIterHof` / `ensureNativeLazyIter` — the stepper logic is done;
  the work is host-lane wiring + the `Iterator` global/prototype + generic `.call`.
- `#2903` (R3) is the standalone origin; this issue is its host-lane completion.
- Budget-fit: this is an XL big-rock — start early in a budget window.

## Investigation findings (2026-07-21, opus dev — verify-first, no code landed)

**Verify-first MEASURE (the issue's ~84 estimate is wrong).** Ran the real
`test262/built-ins/Iterator/prototype/**` set (357 files, 11 methods) through
`runTest262File` in both lanes:

| lane | pass | non-pass (fail+CE) |
| --- | --- | --- |
| **host (gc)** | **75** | **282** |
| **standalone** | **285** | **72** |

So the true host gap is ~210 (not 84). The native path (standalone) already
passes 285. Non-pass host tests split by call form:
- **86 pure instance-form** (`iter.map(f)` / `iter.some(cb)`, no `Iterator`
  reference) — the **only** bucket Slice 1 (native-helpers-to-host) can flip.
- **84** reference `Iterator.prototype` (Slice 2/3).
- **112** reference bare `Iterator` (Slice 2 — the global).
So Slice 1's realistic ceiling is **~86**, not the majority. The "X is not a
function" bucket (64) is 61/64 **first-class form** (`Iterator.prototype.X`),
NOT method-call form — it is Slice 2, not Slice 1.

**Slice 1 is NOT a small "un-gate" — it is blocked by deep standalone coupling
(the real root cause).** The plan's premise ("un-gate `NATIVE_ITER_HOF_METHODS`
from `ctx.standalone`") understates the work. Two hard blockers, confirmed
empirically:

1. **Dispatch routing gap.** The closed-method dispatcher (`__call_m_<name>_N`,
   which carries the standalone iterator arm) is only *invoked* under
   `(ctx.standalone || ctx.wasi)` — see `call-receiver-method.ts:2670`. In host
   mode `iter.map(f)` never reaches the dispatcher at all; it falls to the
   generic `__extern_method_call(recv, name, jsArray)` path
   (`call-receiver-method.ts:3108`), whose host mirror cannot drive an opaque
   WasmGC iterator externref → silent `undefined`. So Slice 1 needs a NEW
   host-lane call-site interception, not just an arm un-gate. (A working
   narrow-interception design was prototyped — host-only, eager helpers,
   receiver `ref.test $Object`/null → keep host path, else native — and it fired
   correctly. It is blocked by #2 below, not by routing.)

2. **The native iterator substrate transitively requires the STANDALONE object
   runtime, which is not host-safe.** `ensureNativeIterHof` →
   `ensureObjectRuntime` (for `__objvec_*` + `$Object` type + `__apply_closure`
   args). In host mode `ensureObjectRuntime` is effectively never exercised on
   `main` (host uses `env::__extern_*` imports instead — verified: host-mode
   `JSON.stringify`/loose-eq compile without ever pulling it). Forcing it into a
   host (`wasm:js-string`) module cascades standalone-only emissions:
   - `ensureObjectRuntime` → `ensureNativeStringHelpers` →
     `emitSelfHostedStringHelpers` emits `__str_trimStart` (a #3256 TS-lowered
     helper) which **hard-requires native-strings mode** → throws
     `stdlib-selfhost: __str_trimStart needs string.len ... not in
     native-strings mode`. (Guardable in ~1 line:
     `if (ctx.nativeStrings) emitSelfHostedStringHelpers(...)` at
     `native-strings.ts:224` — the Tier-1 direct-Wasm builders above it are
     host-safe. This unblocks the first throw but is not sufficient.)
   - Next, `ensureObjectRuntime` emits the **standalone-native**
     `__defineProperty_value` (object-runtime-descriptors.ts:160), whose body
     calls the standalone error-constructor graph (`__new_TypeError` via
     `emitWasiErrorConstructor`, `__object_is`) — NOT registered in host mode →
     `absoluteFuncIndex: unresolved call target (funcIdx=undefined)` inside
     `__defineProperty_value`. The header comment there confirms host mode is
     meant to use the `env::__defineProperty_value` **host import**, not the
     native version. This is whack-a-mole: the object runtime emits
     standalone-native versions of everything and references a whole
     standalone-only helper graph.

**Conclusion / re-scope.** Slice 1 as written ("un-gate to host") is INFEASIBLE
as a small change. Landing it needs ONE of these L/XL foundations first:
  - **(A)** Make `ensureObjectRuntime` (and its descriptor/error-constructor
    deps) host-string-safe / host-import-backed — a broad dual-backend change to
    a deep subsystem; or
  - **(B)** Reimplement the eager Iterator helpers host-native WITHOUT the
    standalone object runtime — e.g. an **AST/source-level desugaring** of
    `iter.toArray()`/`.some()`/`.find()`/… into equivalent `for-of` loops +
    host arrays + direct callback calls. NOTE: host-lane `for-of` on iterators
    already WORKS (verified: `for (const x of [1,2,3].values())` sums to 6), so
    (B) reuses proven host machinery and sidesteps the object-runtime coupling
    entirely. This looks like the cleanest genuine Slice 1, but it is an L
    implementation (loop IR synthesis, counter, early-exit, IteratorClose).

**Recommendation:** route to architect for a design decision between (A) and (B)
before the next dev attempt; deferred here because both exceed a 12%-budget
window and would strand. No code landed (a partial un-gate turns the current
silent-`undefined` into a hard compile error — a regression — so it must not
ship without the foundation). Measurement harness: `.tmp/measure-iter.mts`
(host vs standalone, per-method, JSON output).
