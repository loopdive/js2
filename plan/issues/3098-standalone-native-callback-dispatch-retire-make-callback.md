---
id: 3098
title: "Standalone native callback-dispatch substrate: retire `env.__make_callback` on the dynamic-receiver lane (top-3 host-import leak root)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3098
sprint: Backlog
model: fable
created: 2026-07-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: callbacks, higher-order-functions, dynamic-dispatch
goal: standalone-mode
umbrella: 2860
related: [2939, 3074, 3083, 3015, 3016, 2151, 2864, 2928, 3058, 1382]
origin: "2026-07-09 fable-arch hard-problems audit (domain 1/3) — __make_callback is the #2 leaked host import by file count (7,519 files in the 2026-06-26 standalone JSONL) and the E5/G3 prerequisite of the #2928 interpreter"
---

# #3098 — retire `env.__make_callback`: native callback dispatch for dynamic receivers

## Problem (verified against origin/main @ 928c85179, 2026-07-09)

A callback passed to a method on a **dynamic (`any`/externref) receiver** is
routed through the `env.__make_callback` host bridge instead of the native
closure-struct dispatch. Standalone (no host), the import leaks and the module
either fails the honest host-free metric or traps.

Probe (this audit, `compileSource(..., { target: "standalone", nativeStrings: true })`):

```ts
// typed receiver — NATIVE, host-free, correct:
const a: number[] = [1, 2, 3];
a.map((x: number) => x * 2)[2]; // = 6, no env imports

// any receiver — HOST BRIDGE, leaks + traps standalone:
const a: any = [1, 2, 3];
a.map((x: any) => x * 2)[2]; // TRAP, LEAK: __make_callback
const a: any = [1, 2, 3];
a.filter((x: any) => x > 1).length; // wrong (0), LEAK: __make_callback
```

Scale: `env.__make_callback` is the **#2 leaked import by file count** in the
last full standalone JSONL (7,519 files @ 2026-06-26, behind only
`__get_caught_exception`, whose #2962 fix has since landed). It appears in the
top-10 of every leak class (`iterator_protocol` 3,486, `dynamic_object_property`
622, `dynamic_code` 248). The number needs re-measuring on a fresh standalone
run, but the per-shape probe above proves the emission path is live today.

## Why this is a substrate root, not a per-method bug

`__make_callback(cbId, capsExternref) -> jsFunction` is the host-side
factory: the runtime looks up `exports.__cb_<id>` **by export name** and
returns a JS function wrapping it. Three consumer families emit it:

1. **Dynamic-receiver array/TypedArray HOFs** — `map`/`filter`/`forEach`/
   `reduce`/`reduceRight`/`find*`/`every`/`some`/`sort(cmp)` when the receiver
   is externref/`any` (the typed-receiver arms are already native). See the
   BANKED list in `src/codegen/array-methods.ts:2876` (#3058 dyn-view bucket)
   and `src/codegen/closures.ts:1225`.
2. **Async CPS step adapters** — `src/codegen/async-cps.ts:395-525`,
   `src/codegen/async-frame.ts:95-140` (`__cb_<id>` continuation wrappers,
   settle via `Promise_then2`). These retire with the #2864/#2867/#1042
   carrier convergence, NOT here — but the ABI decision below must not
   conflict with the `$AsyncFrame` step-adapter shape.
3. **Host-API callback args** (`addEventListener`, host `Promise_then2`,
   `JSON.stringify` replacer, …) — legitimately host-lane; stays.

This issue owns family 1 (and the generic "callback crossing a dynamic
dispatch boundary" mechanism); family 2 is the async carriers' job; family 3
is out of scope (host-lane by definition).

**The standalone-native ingredients already exist** — this is wiring, not
invention:

- Every compiled function expression/arrow already lowers to a **GC closure
  struct** (wrapper struct + funcref + captures) — the same value the Proxy
  trap dispatch invokes via `__apply_closure` (`object-runtime.ts`, #1100).
- `__apply_closure(closure, thisArg, argsVec) -> externref` exists standalone
  and is the ratified "reuse the closure→funcref bridge, don't invent a
  calling convention" mechanism (#1355 slices A–F all use it).
- The gc-lane twin of this bug was #2939/#3074 (closure candidate
  registration de-gated to both lanes, PR #2790 lineage): callbacks held in
  `any` containers now REGISTER; what standalone lacks is the **dispatch**
  arm that invokes them natively at a dynamic call boundary.
- #3016 (done) proved the pattern for `Function.prototype.call/apply`:
  route a func-expr VALUE to the closure struct, not `__make_callback`.
  #3015 (ready, low) is the same pattern for one predicate-method site.

## Design — one native dispatch arm at the callback-consuming boundary

### Invariant

> A callback value that is a **compiled closure** (its runtime rep passes
> `ref.test` against the closure-wrapper family) is invoked natively via
> `__apply_closure` — on every lane, at every dynamic dispatch boundary.
> Only a callback value that is a **genuine host function** (host-lane
> externref that is not a GC closure) routes to the host bridge; standalone,
> that residual arm is a catchable TypeError, never a silent no-op.

### Mechanism (mirror of the Proxy trap dispatch)

At each dynamic-receiver HOF lowering site that currently calls
`__make_callback`:

1. Compile the callback arg to its uniform externref rep (already done — the
   closure struct crosses as `extern.convert_any(closureStruct)`).
2. Replace the `__make_callback` call with a **`__invoke_cb_n(cb, this, a0..an) ->
externref`** family of native helpers (n = 1..4, arity-tolerant per the
   #2939 lesson: pass what the loop has; `__apply_closure` already handles
   the arity/coercion at the boundary; over-arity must NOT void-skip — that
   is the #1837/#3088 vacuity trap):
   - `any.convert_extern(cb)`, `ref.test` closure-wrapper → `__apply_closure`
     with a native argsVec.
   - else host lane → the existing host-callable invoke (`__call_1_f64`
     family / host `Function.call`) — byte-preserving for host callbacks.
   - else standalone → throw catchable `TypeError: not a function` (reuse the
     WASI error-ctor + exn tag pattern, `object-runtime.ts:7293`).
3. The element loop itself must be native for the dynamic receiver: reuse the
   receiver-classification ladder (#3031 Part 0) — `ref.test $Object` /
   vec-struct / `$ObjVec` arms read elements natively; the host-externref arm
   stays host-lane. #2151's any-receiver dispatch slices already classify the
   receiver at these sites; this issue adds the CALLBACK arm to the loops
   those slices select.

### Result-rep

`__apply_closure` returns externref. Each HOF coerces per its contract:
`filter`/`every`/`some`/`find*` via `__is_truthy` (i32); `map` stores the
externref result into the output vec's element rep (boxed-any element per
#2379 — do NOT unbox to f64, heterogeneous results are legal); `reduce`
threads the externref accumulator unchanged.

## Slices (each independently landable, merge_group-gated)

| #   | Slice                                                                                                                                                          | Scope                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| S1  | `__invoke_cb_n` helper family + the classifier arm (no call-site changes; byte-inert)                                                                          | `object-runtime.ts` (beside `__apply_closure`), reserve-then-fill per #1719; unit repros in `.tmp/` |
| S2  | Dynamic-receiver `map`/`filter`/`forEach` flip to S1                                                                                                           | `array-methods.ts` dynamic arms; the probe cases above flip pass + host-free                        |
| S3  | `reduce`/`reduceRight`/`find`/`findIndex`/`findLast*`/`every`/`some`                                                                                           | same mechanism, more sites; includes the #3058 BANKED TypedArray dyn-view callback methods          |
| S4  | `sort(cmp)` (comparator ABI: 2 args, f64-able result) + `Array.from(x, mapFn)`                                                                                 | `array-methods.ts`                                                                                  |
| S5  | Audit sweep: grep remaining `__make_callback` emission sites outside async (`closures.ts:1225-1306` guidance comment), route or defer each with a named reason | telemetry: standalone JSONL `__make_callback` count → the async-only residual                       |

**Sequencing / non-collision:** #2864/#2867 own the async `__cb_<id>` uses —
do not touch `async-cps.ts`/`async-frame.ts` here. #3087 (dynamic `new` on
gc lane) is adjacent but disjoint (construct, not call). #2151/#3053 own the
receiver classification — S2+ consume, never re-implement. Check #3015's
one-site slice before S3 (fold or supersede it explicitly).

## Edge cases

- **Arity tolerance** (#2939 keystone lesson): a 1-param callback invoked by
  a 3-arg loop (`value, index, array`) must receive value and ignore extras;
  a 3-param callback must receive all three (the #3088 lesson: never
  void-skip on over-arity — that produces vacuous passes).
- **`this` arg** (`map(cb, thisArg)`): thread as `__apply_closure`'s thisArg;
  absent → undefined singleton.
- **Callback mutates the array during iteration**: match the per-method spec
  (ES2025 §23.1.3.18 etc. — length snapshot for `map`/`forEach`, live reads);
  the native loop must read length ONCE where the spec says HowMany is fixed.
- **Sparse/holey receivers**: holes skip per spec on the `$Object`-backed
  array arm (reuse the `$Hole` mapping, not a fabricated `undefined` call).
- **Non-callable callback**: TypeError BEFORE the loop (§23.1.3.18 step 3),
  catchable, both lanes.
- **A host function stored into an `any` var, standalone**: impossible by
  construction (no host) — the TypeError arm is correct.

## Acceptance criteria

1. The three probe programs above run correct + host-free standalone
   (`a.map` → 6 with `a: any`; `filter` → 2; plus `forEach`/`reduce`
   equivalents), and identically on the gc lane.
2. Fresh standalone JSONL: `__make_callback` leak count drops to the
   async-carrier residual only (measure before/after; the 2026-06-26 count
   was 7,519 files).
3. No gc-lane regression on the hot typed-receiver HOF paths (byte-identical
   WAT for a typed `a.map` — the new arm is gated on the dynamic receiver
   classification).
4. Full merge_group + standalone floor (broad-impact: touches the HOF family
   — never a scoped sweep).

## Effort estimate

L (5 slices, each S–M; S1+S2 together are the keystone ~1 senior-dev budget
window; S3–S5 are mechanical from the S2 template). Fable for S1/S2 (ABI +
classifier design), Opus-executable for S3–S5.

## Implementation notes (fable-3098, 2026-07-09 — S1+S2+S3-array landed)

**Repro verified first** (origin/main @ 825ffba1cf8d3): all four probe shapes
(`any`-receiver `map`/`filter`/`forEach`/`reduce`) leaked `env.__make_callback`
and failed WebAssembly instantiation standalone; the typed control was
host-free. Probe: `.tmp/probe-3098-repro.mts`.

**Mechanism pinned (differs slightly from the spec's assumption).** The
`any`-receiver HOF call does NOT go through `array-methods.ts`'s dyn-view
lowering — it routes through the #2151 closed-method dispatcher
(`__call_m_map_1(recv, cbExternref)`), whose fill ladder had no array arm for
the HOF names, so a vec receiver fell to the open-`$Object` bottom arm
(`__extern_method_call` → null). Independently, the CALL SITE compiled the
inline arrow via `isHostCallbackArgument` → `compileArrowAsCallback` →
`__make_callback(cbId, caps)` — the leaked import. (The upfront
`state.callbackFound` import registration in declarations.ts is NOT the leak
root: `eliminateDeadImports` strips it when nothing calls it.)

**What landed (three coupled pieces, all `ctx.standalone`-gated):**

1. `object-runtime.ts` — `ensureNativeArrayHof(ctx, name)` emits
   `__hof_<name>` native loops for forEach/map/filter/find/findIndex/
   findLast/findLastIndex/every/some (`(recv, cb, thisArg) -> externref`) and
   reduce/reduceRight (`(recv, cb, init, hasInit: i32) -> externref`) over
   `__extern_length`/`__extern_get_idx`, invoking the callback via
   `__apply_closure(cb, thisArg, [v, boxNum(i), recv])` (4-arg
   `[acc, v, i, recv]` for reduce). Emitted at RESERVE time (append-only —
   the fill only READS funcMap, #1719). `map`/`filter` results are `$ObjVec`s
   (the established boxed-any dynamic-array carrier — #2379: no f64 unbox).
2. `closed-method-dispatch.ts` — reserve registers the helper + `$__vec_base`;
   the fill grows an arm testing `ref.test $__vec_base || ref.test $ObjVec`
   (the OR covers chained HOFs, whose receivers are `$ObjVec` results) routing
   to `__hof_<name>`. Sits UNDER the closed-struct arms, so a user
   object-literal `{ map(cb){…} }` still wins (regression-tested).
3. `expressions/calls.ts` — at the closed-dispatch call site, an inline
   arrow/function-expression arg to a `NATIVE_HOF_METHODS` name compiles via
   `compileArrowAsClosure` (GC closure struct as externref), not
   `__make_callback`. Identifier-held callbacks already crossed as closure
   structs (#2939/#3074 registration).

**Arity tolerance** is inherited from `__apply_closure` →
`__call_fn_method_N` (clamps to the closure's declared arity; verified: 1-, 2-
and 3-param callbacks all correct, `.tmp/probe-3098-extended.mts` 26/27).

**Validation:**

- `tests/issue-3098.test.ts` — 15 tests, all pass (host-free asserted via
  zero-import check + empty import object).
- Byte-identity: `prove-emit-identity` main-vs-branch — IDENTICAL, all 39
  (file,target) hashes across gc/standalone/wasi on the playground corpus.
- Cluster (runTest262File, standalone lane): `built-ins/Array/prototype/{map,
filter,forEach,reduce,every,some,find*}` (1,439 non-skip files) — ZERO
  regressions, zero flips. The sampled 81 "only-`__make_callback`" leak rows
  from the 2026-06-16 standalone JSONL also show 0 flips: each depends on an
  ADJACENT gap (see boundaries below). The value of this slice is the
  substrate — the probe shapes flip pass+host-free, and #3100/#2928 consume
  the same dispatch arm.

**Boundaries / residuals (named, for S4/S5 + adjacent owners):**

- **Typed `string[]` receivers of `find`/`filter`/`findIndex`/`findLast*`/
  `every`/`some`/`reduce*`/`forEach` still leak `__make_callback`** — the
  typed inline impls in `array-methods.ts:3350-3440` gate on
  `f64|i32|externref` element kinds; ref-element (native-string) vecs fall to
  the host-callback path (probe: `.tmp/probe-3098-typedstr.mts` — `str-find`/
  `str-filter` leak; `str-map` is native via the #2688-widened gate). Fixing
  this is typed-lane work (result-rep: typed callers expect a
  `$NativeString` ref back, not externref) — S5 candidate, separate PR.
  **→ RETIRED by #3126** (gates widened to ref/ref_null on the
  standalone/wasi lanes under a closure-provability check; the gc host lane
  deliberately keeps the `__make_callback` fallback — it is the only path
  that resolves host globals like `Temporal`/`TemporalHelpers` inside
  callback bodies; see #3126's merge-group reversal note).
- `sort(cmp)`, `flatMap`, `Array.from(x, mapFn)` — S4, not landed.
- TypedArray dyn-view callback methods (#3058 BANKED) — S3's other half, not
  landed (coordinate with #3058's two-arm).
- `reduce` of an empty array with no initial value returns `undefined`
  instead of the spec TypeError (§23.1.3.24 step 5) — same no-throw
  discipline as `__apply_closure` S1 (late error-machinery registration is
  the #1839 index-shift hazard). Upgrade together with `__apply_closure` S2.
- Non-callable callback: no before-loop TypeError (falls through to
  `__apply_closure`'s undefined sentinel) — same S2-upgrade bundle.
- wasi lane unchanged (the `__extern_get_idx` vec/array-like arms are
  standalone-only — `objArrayLikeArms`; same gate as the #2151 vararg
  dispatcher).
- **Discovered, pre-existing, NOT this issue:** `(any + any).length` on two
  `any`-held strings returns 0 standalone (no HOF involved; reproduced on
  pristine main — `.tmp/probe-3098-reduceright.mts` `any-concat.length`).
  Root of the one extended-probe mismatch (string reduceRight `.length`).
  Needs a PO issue (dynamic-add string-concat result rep).
- Family 2 (async `__cb_<id>` step adapters) untouched per the spec —
  #2864/#2867 own those; `async-cps.ts`/`async-frame.ts` not modified.
