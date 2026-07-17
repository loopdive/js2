---
id: 2872
title: "Standalone: TypedArray.prototype.* cluster (294 host-pass/standalone-fail, de-masked from #2862)"
status: in-progress
assignee: ttraenkler/agent-a30d0acc00d3c78c5
created: 2026-06-30
updated: 2026-07-12
priority: high
task_type: bug
feasibility: hard
model: fable
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2651, 2885, 2876, 2893, 3054, 3057, 3058]
umbrella: 2860
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls-closures.ts
---

## Progress (2026-07-12, fable) — Slice 4: dyn-view reduce/reduceRight + boolean-result boxing (REUSE-first)

The #3140 `Function.prototype.bind`-on-closure blocker the earlier slices
flagged as THE cluster unblock is now **DONE** (PR #2884), so the
`testWithTypedArrayConstructors` harness reaches the method bodies.

Per the standing no-bloat directive, this slice adds **zero new per-method TA
handlers** — it extends the existing #3058 dyn-view two-arm
(`emitDynViewMethodTwoArm`, which materializes a `$__ta_dyn_view` → `$__vec_f64`
and re-enters the ORDINARY native array-HOF impl):

1. `reduce` / `reduceRight` added to `DYN_VIEW_READ_METHODS` (array-methods.ts) —
   they return a scalar accumulator with Array-identical semantics, so the
   materialize-and-reuse path is correct verbatim.
2. **Boolean-result boxing fix** (shared): the two-arm's `coerceArmToExternref`
   boxed a boolean method's raw i32 as a NUMBER, so `includes(x) === true`/
   `=== false` failed (truthiness worked, which masked it) — a LATENT #3058 bug
   for `includes` (already in the read set). New `BOOLEAN_RESULT_METHODS` set +
   a `boolResult` param route boolean methods through `__box_boolean`. One fix
   lights up `includes` (+6) and pre-wires a future `every`/`some`.

**Measured (real runner, standalone, `built-ins/TypedArray{,Constructors}/prototype`
reduce+reduceRight+includes+callback family, 441 files, vs main):
+8 fail→pass, ZERO regressions, ZERO CEs.** (reduce +1, reduceRight +1,
includes +6.)

- `prove-emit-identity`: IDENTICAL 39/39 (gc/wasi/standalone corpus byte-inert).
- 402-file broad standalone stride: zero flips (no collateral — the shared
  two-arm coercion change is inert outside dyn-view receivers).
- `tests/issue-2872-ta-dynview-reduce-includes.test.ts` 9/9; all prior
  #2872/TypedArray/array-method suites green (114 tests).

**Deferred (measured but NOT shipped — would regress/CE):**
`find`/`findIndex` (+13 pass but the materialized `find` impl emits invalid wasm
on `predicate-call-changes-value` — arm type mismatch), `findLast`/
`findLastIndex` (array impl misses a `__call_1_f64` registration on this path →
CE), `every`/`some`/`forEach` (detached-buffer tests regress — materialization
snapshots before a mid-callback detach). Each needs targeted work: the `find`
arm-result type fix, the `findLast` `__call_1_f64` wiring, and detached-aware
materialization. `map`/`filter` (new same-kind TA result), `sort`/`toSorted`
(numeric default comparator), `with`/`toReversed` (new TAs) still need a
TA-result builder.

> **UNBLOCKED 2026-07-11 (fable-harvest3):** the #2893 brand dependency landed
> on main 2026-07-01 (PR #2395 merged — the "CONFIRMED BLOCKED" note below is
> stale). Slice 1 (general dynamic construction + dyn-view `.fill`) is
> implemented — see `## Progress (2026-07-11)` at the bottom; the issue stays
> open for the follow-on slices listed there.

## Progress (2026-07-11, fable-sub1) — Slice 2: dyn-view `copyWithin` + `reverse`

Per-method dyn-view arms, the follow-on the slice-1 note flagged
(`copyWithin`/`reverse` — the `__ta_dyn_fill` two-arm template). Both operate
on a runtime `$__ta_dyn_view` receiver (the
`testWithTypedArrayConstructors(TA => new TA(…).copyWithin(…)/.reverse())`
harness shape).

**Landed (branch `issue-2872-ta-proto-methods`):**

1. `ensureTaDynCopyWithinHelper` (dataview-native.ts) — §23.2.3.5. `to`/`from`/
   `final` relative indices clamped `[0,len]`, `count = min(final-from,
   len-to)`, one `array.copy` of `count*elemSize` bytes (memmove-correct for
   overlap, so no direction split). No per-element decode/encode — raw bytes
   move verbatim, element-kind-agnostic.
2. `ensureTaDynReverseHelper` (dataview-native.ts) — §23.2.3.21. In-place
   `elemSize`-byte-block swap over `[0, floor(len/2))` through a scratch byte.
3. Shared preamble/relative-index helpers (`pushTaDynMethodPreamble`,
   `pushTaDynRelativeIndex`) — independent clones of the slice-1 fill internals
   so **fill's emitted bytes are untouched** (`prove-emit-identity` IDENTICAL).
4. All three helpers carry the SAME `(recv, v1, v2, v3, argc)` signature
   (reverse's trailing slots unused) so ONE calls.ts dispatcher two-arm serves
   them; the slice-1 fill emit path is byte-identical (same helper funcIdx).
5. `copyWithin`/`reverse` added to the any-receiver extern-class ambiguity
   refusal (calls-closures.ts) — first-match bound `ta.reverse()` to
   `Uint8ClampedArray_reverse` (a host import → standalone instantiate trap);
   now they resolve by runtime shape like `fill`.

**Measured (real runner, standalone lane, vs baseline):**

| tree | Δ |
| ---- | - |
| `TypedArray{,Constructors}/prototype/{copyWithin,reverse}` (89) | **+5 pass / 0 regressions** |

The +5 are the non-harness copyWithin tests (`detached-buffer`,
`return-abrupt-from-{start,end,target}`, `return-this`). The bulk of the 75
remaining fails are **harness-blocked on `.bind`** (#3140): every
`testWithTypedArrayConstructors` test runs `argFactory.bind(undefined,
constructor)` — a closure `.bind` that returns a non-callable standalone — so
it throws at the harness before reaching the method. This slice is the
prerequisite method work; the reachable yield jumps once #3140 lands (the arms
already run correctly under the callback harness, proven by the unit suite).

- `tests/issue-2872-copywithin-reverse.test.ts` 12/12 (mutation on every kind,
  negative/relative clamps, explicit-end window, multi-byte element moves,
  returns-this via content-aliasing since dyn-view strict-eq is deferred #2580
  M2, plain-array non-hijack GUARD, static-lane control); slice-1 suite 13/13.
- `prove-emit-identity`: IDENTICAL (39/39) — host/gc byte-inert, corpus has no
  dyn-view copyWithin/reverse.
- loc-budget: dataview-native.ts (+453) / calls.ts (+10) covered by the
  `loc-budget-allow` frontmatter above.

**Remaining follow-ons:** `.bind`-on-closure (#3140, THE cluster unblock);
per-method arms for `set`/`subarray`/`sort`/`join`/`slice`/`with`; `.buffer`
identity on dyn views; iterable ctor arg; dyn-view strict-eq (#2580 M2).

## Measure-first verdict (2026-07-01, sdev-tail) — CONFIRMED BLOCKED, brand not on main

Do **not** dispatch the residual TypedArray.prototype *method* native-body work
yet. The dependency #2893 (distinct %TypedArray% view brand) is **NOT on main** —
its implementation lives in **OPEN PR #2395** (`feat(#2901,#2893): standalone
%TypedArray% intrinsic ctor chain + integer-view accessor getters`, by
sr-typedarray). Only the #2893 *docs/spec* PR (#2376) merged; the brand runtime
has not. Marked `status: blocked` to stop it being pulled off the `current`
TaskList before the brand lands.

**Measured** on current main (leak-probe over `built-ins/TypedArray/prototype/fill`,
51 files): the method leaks that remain are **not** brand-independent. `.fill()`
on a **statically-typed** concrete TA (`Int8Array` etc.) already lowers host-free
(20/51 host-free). The residual leaks are on an **`any`/opaque-externref** receiver
(the `testWithTypedArrayConstructors(TA => …)` callback form): `.fill` there
dispatches through the generic extern-method resolver and leaks
`CanvasRenderingContext2D_fill` (a name-collision host import) — 12/51. A native
body for that path needs a **runtime brand** to classify an opaque externref as a
TA view vs a plain `number[]` (TA views share the `$Vec` type with plain arrays,
no tag — the exact #2893 gap). So the method work is **brand-gated too**, not just
the reflective getter/descriptor subset. Building it now (branching off main
without the brand) risks the plain-array-vs-view mis-dispatch regression this
umbrella already warns about.

**Unblock condition:** PR #2395 (#2893 brand) merges to main. Then predecessor-stack
the method native bodies on that landed work (or branch fresh from the post-#2395
main). Until then this stays `blocked`.

> **Blocked on #2893** (distinct %TypedArray% view brand). Traced 2026-06-30: the
> #2885 gOPD synthesis + #2876 reflective `.call` machinery light up the reflective
> accessor subset for free once the §23.2.3 getter bodies exist — but those bodies
> need a runtime brand to classify an opaque `externref` as a view vs a plain array
> (TA views share `$Vec` types with `number[]`, no tag — see #2893). The "just needs
> per-cluster glue" framing was optimistic; the glue is gated on that representation
> change. The `verifyProperty`/`*.name` subset also needs lever-2 + mutable
> descriptor semantics.

> **Unblocked machinery (#2885 + #2876, both merged):** the reflective-accessor
> subset (`verifyProperty` / `prop-desc` over `%TypedArray%.prototype` accessor
> members — `byteLength`, `byteOffset`, `length`, `buffer`, `@@toStringTag`) now
> has its shared lever: gOPD builtin-proto accessor descriptor SYNTHESIS (#2885)
> and the brand-agnostic reflective `.call`/`.apply` recovery of a
> descriptor-retrieved getter (#2876, `emitReflectiveNativeProtoClosureCall` +
> the `gOPD(...).get.call(R)` data-flow trace in `calls.ts`). The remaining
> TypedArray work is the **per-cluster glue**: wire the `%TypedArray%`/view
> getter `emitMemberBody` arms + their proto-identity opt-in; the gOPD +
> reflective-call surfaces then apply for free. (NB: the view brands carry
> vec/runtime entanglement — see #2375.)

# Standalone: TypedArray.prototype.\* failures (de-masked)

## Problem

The single largest concrete standalone cluster surfaced by the #2870 de-mask:
~**294** `built-ins/TypedArray/prototype/**` tests are host-pass but
standalone-fail (previously mis-recorded under the phantom "Cannot convert object
to primitive value" signature, #2862). Plus ~39 `TypedArrayConstructors/**`.

## Representative repros

- `test/built-ins/TypedArray/prototype/fill/length.js` — `verifyProperty`
  /`propertyHelper` over `%TypedArray%.prototype.fill` (arity/name + descriptor).
- `test/built-ins/TypedArray/prototype/toLocaleString/prop-desc.js`.

These hit `propertyHelper.js`/`verifyProperty` reflective descriptor reads over
TypedArray prototype members and throw a Wasm exception in standalone.

## Root cause (to triage)

Likely a mix of: (a) `%TypedArray%.prototype` member descriptor reflection not
materialised standalone (overlaps the native-proto glue work #2651/#2861), and
(b) `ToIndex`/`ToNumber` coercion of object args (`fill(value,start,end)` with
object bounds). Triage per sub-path with `runTest262File(file,cat,undefined,"standalone")`,
group by the exact assertion that throws.

## Test plan

`test/built-ins/TypedArray/prototype/**` standalone fail → pass; full
`merge_group` + standalone high-water. `ctx.standalone` only.

(Large — split into sub-tasks per failing member family if the root causes
diverge.)

## Progress (2026-07-11, fable-harvest3) — Slice 1: dynamic construction + `.fill`

**Root cause pinned (verify-first, current main):** the cluster is NOT
primarily a method-body gap — it's a **construction** gap. Every harness test
runs `testWithTypedArrayConstructors(function (TA) { new TA(…) … })` with an
`any`-typed ctor param, and standalone dynamic `new TA(…)` supported ONLY the
`(buffer[,off[,len]])` form (#3054 D, gated on a statically buffer-typed first
arg). The dominant forms — `new TA(n)`, `new TA([…])`, `new TA(arrayLike)`,
`new TA(otherTA)`, `new TA()` — all compiled to `ref.null.extern`, so every
downstream read returned 0/undefined and assert #1 failed. Traced via WAT dump:
the callback body literally began `ref.null extern; local.tee $a`.

**Landed in this slice (PR #2881, branch `issue-2872-standalone-typedarray-proto`;
the issue intentionally does NOT carry `pr:` frontmatter — it stays open as the
cluster tracker, this PR is slice 1):**

1. `emitTaDynCtorConstructFromLocals` (dataview-native.ts) — runtime
   `ref.test $__ta_ctor`-gated construct from pre-evaluated externref arg
   locals, arg-shape dispatch: byte-vec buffer (incl. resizable subtype) /
   `$__ta_dyn_view` copy / registered plain-vec copy (f64·i32·externref) /
   array-like `$Object` (`__extern_length` + `__extern_get_idx` walk) /
   ToIndex count form (fresh zeroed buffer, RangeError on negative). Wired as
   (a) the dynamic-new no-match base inside `emitDynamicNewFallback`
   (class-bearing modules) and (b) the class-free direct path — both
   noJsHost-only; a non-TA runtime callee still yields null-extern
   (byte-identical to before, user classes never hijacked).
2. `__ta_dyn_fill` native helper (§23.2.3.8) + a runtime two-arm at the
   any-receiver dispatcher call site in calls.ts — value ToNumber'd on the
   RUNTIME kind (Uint8Clamped clamp included), relative start/end clamped,
   returns `this`.
3. `.fill` added to the extern-class ambiguity refusals (calls-closures.ts) —
   first-match binding hijacked any-receiver `.fill` to
   `CanvasRenderingContext2D_fill` (the leak this issue's 2026-07-01 probe
   measured).
4. `moduleUsesDynTaView` pre-scan generalized to the count/array/zero-arg
   shapes (any/unknown-typed callee only; still standalone/wasi-lane only —
   host lane byte-identical). This also lights up the existing #3057 element
   codec + #3058 read-method two-arms for these modules — a large share of the
   measured yield came from that.
5. 0-arg `indexOf`/`lastIndexOf`/`includes` skip the #3058 two-arm (the static
   impls hard-error "requires 1 argument" → CE).

**Measured (local full-dir scans, `runTest262File(..., "standalone")`, vs same
scan on main @ ec5958aff018a):**

| tree | main | branch | flips |
| ---- | ---- | ------ | ----- |
| built-ins/TypedArray/prototype (1,396) | 139 pass / 9 CE | 195 pass / 9 CE | **+60 / −4** |
| built-ins/TypedArrayConstructors (736) | 125 pass / 65 CE | 130 pass / 65 CE | **+13 / −8** |

Net **+65 honest pass**. The 12 pass→fail flips are de-masked VACUOUS passes
(both sides of `assert.sameValue` were null before construction worked —
`copyWithin/return-this.js`, `internals/DefineOwnProperty/*` etc.), not
behavior regressions.

**Follow-on slices (why the remaining ~1,000 fails stay):**

- **`Function.prototype.bind` on closures is broken standalone** — returns a
  non-callable. The MODERN harness (`testWithAllTypedArrayConstructors`) binds
  every arg factory (`argFactory.bind(undefined, constructor)`), so every
  `makeCtorArg`-style test fails at the harness level regardless of TA
  support. Biggest single blocker; deserves its own issue+fix (filed as a
  follow-up — see PR notes).
- Per-method dyn-view arms: `copyWithin`/`reverse`/`sort`/`set`/`subarray`/
  `join`… (the `__ta_dyn_fill` helper + dispatcher two-arm is the template).
- `.buffer` accessor identity on `$__ta_dyn_view` (needed by `makeArrayBuffer`).
- Iterable ctor arg (`new TA(iterable)`) — needs Symbol.iterator dispatch.
- Strict-eq identity for dyn views: `dv === dv` is FALSE (the $AnyValue tag-5
  arm answers 0 for non-strings; the general identity arm is deliberately
  deferred to #2580 M2 — see the −162 dstr note in any-helpers.ts). Tests pass
  today via the harness `isSameValue` NaN-fallback; a narrow
  `$__ta_dyn_view`-only `ref.eq` arm is a candidate follow-up.
