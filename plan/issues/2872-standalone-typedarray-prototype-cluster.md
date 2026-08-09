---
id: 2872
title: "Standalone: TypedArray.prototype.* cluster (294 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
updated: 2026-08-09
priority: high
task_type: bug
feasibility: hard
model: fable
area: codegen
es_edition: 2015
language_feature: typedarray-prototype-methods
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2651, 2885, 2876, 2893, 3054, 3057, 3058, 2375]
umbrella: 2860
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls-closures.ts
---

## 2026-08-09 ownership boundary — shared IR proto-member value reads

A fresh exact-ES2015 census identifies **125 standalone non-pass files** that
expose the shared `$NativeProto` value-read gap now recorded in #2375. The
safest first cohort is 48 host-pass/standalone-fail invalid-receiver files
(`this-is-not-object.js` plus `this-is-not-typedarray-instance.js` across 24
method directories). Their dynamic `%TypedArray%.prototype.<method>` read
lowers through IR `dyn.member_get`, whose `__dyn_member_get → __extern_get`
route does not recognize `$NativeProto`.

#2375 owns that shared IR/runtime producer. This issue continues to own the
method bodies and method-specific TypedArray semantics after lookup succeeds:
brand validation, detached/out-of-bounds checks, callback-time mutation,
result construction, and reflective accessor/descriptor layers. The 125 is an
exposure count, not a promised 125-pass slice.

## Slice 5 implementation plan (fable-dev-5, 2026-07-18, branch `issue-2872-scalar-hof-any-decline`, stacked on PR #3338)

Executes BOTH parts of the slice-5 root-cause map below (dev-4's takeover PR
#3338 banked the map; the stale `agent-a30d0acc00d3c78c5` claim-lock was
force-taken per the takeover already approved there). WHY each change is
where it is:

1. **Part 2 (load-bearing) — scalar-HOF any-receiver decline in
   `tryExternClassMethodOnAny` (calls-closures.ts).** The #3139 unconditional
   refusal list already declines find/findIndex/forEach/some/every/filter/map/
   reduce/reduceRight/indexOf/lastIndexOf — but NOT `findLast`/`findLastIndex`,
   so the first-match loop still binds `env::Uint8ClampedArray_findLast[Index]`
   (the measured host_import_leak ×33). Fix: a SHARED decline
   `if (noJsHost(ctx) && STANDALONE_TA_SCALAR_HOFS.has(methodName)) return null;`
   placed before the first-match loop. Uses the existing exported set from
   calls.ts (calls-closures.ts already imports from `./calls.js` — no new
   cycle). `noJsHost`-gated (join precedent, line ~1514) so the HOST lane keeps
   its extern binding byte-identical — zero host-lane risk, unlike widening the
   unconditional #3139 list. For the siblings the new line is unreachable
   (they return earlier) — it exists as the family-level standalone guarantee
   the map asked for. After the decline the standalone ladder bottoms out at
   the #2151 closed-method dispatcher whose #3098 HOF arm already serves
   findLast/findLastIndex via the native `__hof_findLast[Index]` backward
   loops (hof-native.ts NATIVE_HOF_EACH — verified present).
2. **Part 1 (fold-in) — findLast/findLastIndex join the #3058/#3162 dyn-view
   two-arm (array-methods.ts).** Add both to `DYN_VIEW_READ_METHODS` AND
   `FIND_METHODS`. The FIND_METHODS route sends the THEN arm through
   `ensureNativeArrayHof` (`__hof_findLast[Index]`, backward flag — already
   implemented), NOT the legacy `compileArrayFind` re-entry whose missing
   `__call_1_f64` registration was the (now-stale) exclusion note. Gc/host
   byte-identical by construction: the line-1135 gate `(!FIND_METHODS.has ||
   ctx.standalone)` keeps the two-arm standalone-only for FIND_METHODS
   members. Also prune the stale exclusion note.

Checklist (kept current — resume point if interrupted):

- [x] Root-cause map read (PR #3338); code paths verified on this base
- [x] Claim lock force-taken (stale 07-12 holder; takeover per #3338)
- [x] Part 2 decline in calls-closures.ts
- [x] Part 1 set additions in array-methods.ts
- [x] Part 3 (surfaced during verification, see below): `__hof_*` S1
      undefined-singleton producer fix in hof-native.ts
- [x] Probe: any-receiver harness shape — no `env::*_findLast*` import, correct
      values/order/thisArg/undefined-miss, standalone execute (suite 10/10)
- [x] Probe: plain-array any-receiver findLast unhijacked (guard)
- [x] Regression sweep: issue-2872×3 / #3058 / #3098 / #3162 / #1712×5 suites
      green (only 2 PRE-EXISTING env failures, verified identical on clean
      base: issue-2001-s2 reduce-hole, issue-1712-capture arity-0) +
      prove-emit-identity IDENTICAL 56/56 vs base (gc/host byte-inert)
- [x] Scoped test262 (standalone, `TypedArray/prototype/{findLast,findLastIndex}`,
      50 files): base 4 pass / 12 fail / 34 CE → branch **24 pass / 26 fail /
      0 CE** = **+20 pass, −34 CE, 0 regressions**
- [x] Collateral sweep (all 9 scalar-HOF dirs, 245 files, per-file diff):
      every flipped line is in findLast/findLastIndex; siblings
      (find/findIndex/forEach/some/every/reduce/reduceRight) ZERO flips
- [ ] PR open, CI started

### Part 3 (found during verification): `__hof_*` S1 undefined-producer gap

The slice-5 suite exposed a THIRD gap beyond the banked two: under the #2106
`undefinedSingleton` regime (default ON since 2026-07-04, 6f7f93c85) a null
externref is JS `null`, NOT `undefined` — but `ensureNativeArrayHof` still
emitted legacy `ref.null.extern` for its "returns undefined" results
(`find`/`findLast` miss, `forEach` result, reduce-of-empty). So
`a.findLast(missPred) === undefined` was FALSE (the value classified as
`null`: typeof "object", `=== null` true) — and this bug was LIVE on main for
the shipped #3162 `find`/`findIndex` (its own suite's miss test fails on a
clean checkout; invisible in CI because the `quality` gate runs only
CHANGED test files, and #3162's PR presumably predates/raced the flip's full
effect). Fix: `undefinedExternInstrs(ctx) ?? ref.null.extern` at the three
result sites in hof-native.ts (regime-off builds byte-identical). The
committed suite asserts miss `=== undefined`, falsiness, and `??` coalescing.

Remaining fails in the two dirs are the KNOWN follow-on buckets (not this
slice): the slice-6 cross-method `assert.throws` cluster (brand/detach/OOB
spec throws, ~150+ rows), reflective `name`/`length`/`prop-desc` (#2885-glue),
and resizable-buffer mid-iteration semantics.

Slice 6 (the ~150-row cross-method `assert.throws` shared-validation-prelude
cluster) remains the NEXT slice after this — not in this PR.

## Takeover + fresh 2026-07-18 re-measurement (fable-dev-4)

**Assignee cleared 2026-07-18** — was `ttraenkler/agent-a30d0acc00d3c78c5`,
stale since 07-11/07-12 (docs-only newest activity, 6 days dead, no open PR;
tech-lead approved the takeover after a coordination scan). The 4 prior branches
(`issue-2872-standalone-typedarray-hof`/`-proto`, `-real-clusters`,
`ta-proto-methods`) carry slices 1–4 that already MERGED to main per the
progress log below (`.fill`, `copyWithin`/`reverse`, `reduce`/`reduceRight` +
boolean-result boxing). This takeover grounds on landed main, not those branches.

**Fresh gap re-measure** (2026-07-18 promoted standalone baseline vs host, official
scope, `file|strict` match): `built-ins/TypedArray/prototype/*` = **690 gap rows**
(host pass ∧ standalone not-pass), up from the 294 original estimate — the metric
de-masked runtime failures as the carriers landed (this is the #2860 re-measure's
"assertion_fail now dominates" shift, localised to TA.prototype).

### Two coherent slices (per-method + failure-signature sub-bucketing)

The dominant failure across NEARLY EVERY method is **`assertion_fail` with an
`assert.throws` signature** — the method is implemented but a spec-mandated
throw is missing:

| method | gap | dominant category |
| ------ | --: | ----------------- |
| slice | 58 | assertion_fail 45 (assert.throws 17), type_error 11 |
| set | 53 | assertion_fail 46 (assert.throws 22) |
| map | 48 | assertion_fail 38 (assert.throws 17) |
| subarray | 46 | assertion_fail 38 (assert.throws 13) |
| filter | 43 | assertion_fail 35 (assert.throws 15) |
| fill | 27 | assertion_fail 25 (assert.throws 10) — *slice-1 landed the value path* |
| copyWithin | 22 | assertion_fail 20 — *slice-2 landed value path* |
| reduce/reduceRight | 44 | assertion_fail 34 — *slice-4 landed value path* |
| **findLast/findLastIndex** | **43** | **host_import_leak 33** (`env::Uint8ClampedArray_findLast[Index]`) + assertion_fail 10 |
| includes/indexOf/lastIndexOf | 60 | assertion_fail (assert.sameValue) |

**SLICE 5 — `findLast` / `findLastIndex` host-free (PRECISELY root-caused
2026-07-18; deeper than a clean "add to set" — NOT yet landed).** The dominant
failure is a genuine **host_import_leak** (`env::Uint8ClampedArray_findLast`
×17, `env::Uint8ClampedArray_findLastIndex` ×16). Traced end-to-end — it is a
**two-part** gap, not one:

1. **Direct-receiver path (FIXED by a 1-line-ish change, verified):** the
   `#3058` dyn-view two-arm set `DYN_VIEW_READ_METHODS` (array-methods.ts:829)
   + `FIND_METHODS` (:867) EXCLUDED findLast/findLastIndex behind a **stale**
   note ("legacy `compileArrayFind` re-entry misses `__call_1_f64` → CE"). The
   `#3098` `__hof` substrate ALREADY has the backward steppers (`__hof_findLast`
   /`__hof_findLastIndex`, `hof-native.ts:63-64,110` `backward` flag), exactly
   like the already-shipped find/findIndex. Adding findLast/findLastIndex to
   BOTH sets makes a **statically-typed** `new Uint8ClampedArray([…]).findLast(cb)`
   compile host-free + correct (probe-verified: values right, `typeof` of
   not-found = "undefined", reverse order correct, identical behaviour to the
   shipped `find`). This part is a safe, isolated win.

2. **`any`-receiver harness path (the ACTUAL test262 shape — STILL LEAKS after
   part 1):** test262's `testWithTypedArrayConstructors(TA => new TA(…).method)`
   wraps the receiver as `any`, producing the boxed `$__ta_dyn_view`. The
   two-arm THEN arm then handles it correctly, BUT the two-arm always ALSO
   compiles its **ELSE arm** (the "not a dyn-view at runtime" fallback), which
   re-dispatches via `compileExpression` →
   `compileReceiverMethodCall` → **`tryExternClassMethodOnAny`
   (calls-closures.ts:~1519 first-match loop)**. That loop greedily binds the
   first extern class declaring the method — a TypedArray view — to the per-ctor
   `env::Uint8ClampedArray_findLast` HOST import (addImport at
   calls-closures.ts:1550). Because the import is emitted at COMPILE time (both
   arms compile), the binary leaks even though the THEN arm would run. **Fix
   location: `tryExternClassMethodOnAny`** — it already has the exact precedent
   at line 1514 (`join` routes native under `noJsHost` instead of binding
   `env::Uint8ClampedArray_join`) and the `.slice`/`.replace` `continue`
   refusals (line 1543). Under `noJsHost`, a TA-view extern-class binding for a
   scalar-HOF method (the `STANDALONE_TA_SCALAR_HOFS` set in calls.ts:1514 —
   find/findIndex/findLast/findLastIndex/forEach/some/every/reduce/reduceRight)
   should be **declined** (`continue`) so the call falls through to the
   host-free generic path, exactly like `join`. This is a SHARED fix: it would
   also close the same latent any-receiver leak for the other scalar HOFs, so it
   warrants its own measure-first slice + a full any-receiver regression sweep
   (the dispatch is sensitive — the #1712 acorn `.replace` collision lived
   here). Both parts together are slice 5; part 2 is the load-bearing one for
   the test262 harness rows and is why this was reverted rather than shipped
   half-done (part 1 alone flips ~0 harness rows).

**SLICE 6+ (the BIG lever, NOT this PR — recommend a dedicated follow-on) —
the cross-method `assert.throws` cluster (~150+ rows).** slice/set/map/subarray/
filter/fill/copyWithin all share a missing spec-throw: calling the method with a
detached buffer, an out-of-bounds/invalid index arg, or a wrong receiver brand
must throw TypeError/RangeError but does not (the tests are
`assert.throws(TypeError, () => ta.method(bad))`). A SHARED validation-prelude
(detached-buffer guard + ToIntegerOrInfinity/range checks + brand check) emitted
once and reused across the dyn-view method arms would flip a large coherent
batch — but it needs its own measure-first slice (each method's exact throw
conditions differ) and touches the shared dyn-view method emitter, so it is a
separate PR from slice 5. Flagging it here as the highest-remaining-lever
follow-on for tech-lead scheduling.

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
