---
id: 4160
title: "Per-call \"clean elements\" protector cell for Array.prototype traversal — make prototype-chain index inheritance correct without taxing the dense loop (~297 ES5+untagged)"
status: ready
sprint: current
created: 2026-08-05
updated: 2026-08-12
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: arrays, prototype-chain
goal: builtin-methods
related: [3185, 3251, 2670, 2001, 4159]
depends_on: [4159]
origin: "plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md — design review of the fast-path question"
# (#3102 LOC ratchet) Slice-1-read growth lives where the seams are, not where
# the logic is: the store itself is a NEW module (proto-index-store.ts, under
# budget by construction). What grows the god-files is only integration that
# has exactly one legal home — object-runtime.ts: the reserve hook + the
# registration-time terminal-miss consults inside the `__extern_get` /
# `__extern_has` bodies it owns, plus the fillExternGetIdxVecArms /
# fillExternArrayLikeStructArms miss-point swaps (those fills live there);
# index.ts: the two finalize-order call sites for fillProtoIndexStore (the
# finalize sequence is index.ts's); context/types.ts: four ctx field
# declarations (reserve latch, fill latch, two companion global indices).
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - src/codegen/vec-overlay.ts
# (#1917/#2108 coercion-sites gate) proto-index-store.ts's `__protoidx_norm_key`
# DELEGATES to the engine's own helpers by funcMap name (number_toString /
# __str_to_number / __unbox_number — the same trio __to_property_key composes);
# it hand-rolls no ToString/ToNumber matrix. The gate counts the references.
# The CanonicalNumericIndexString round-trip (ToString(StringToNumber(k)) == k,
# §7.1.4 canonical-integer-index gate) has no single engine entry point today;
# if one lands, this helper is a one-call rewrite.
coercion-sites-allow:
  - src/codegen/proto-index-store.ts
# (#3400 func ratchet) This slice's whole shape is "emit extra arms under a
# compile-time flag", so the emitters that host those arms grow. Each entry is
# the irreducible cost of a chokepoint the spec named, not logic that could
# live in the new subsystem module (proto-index-store.ts owns everything that
# CAN be factored out — the store, the key gate, and the consult builders; what
# remains at each site is the splice itself):
#   - ensureNativeArrayHof (+103, the largest): the per-iteration HasProperty
#     gate plus the reduce first-present seed scan are inline loop-body emission
#     for 7 methods. Splitting a 435-line emitter is a real refactor and belongs
#     with #3182/#3105, not smuggled into a behavioural slice.
#   - buildObjectEnumerationHelpers / ensureObjectRuntime / generateModule /
#     generateMultiModule: reserve + fill wiring for the new helpers.
#   - fillExternArrayLikeStructArms crosses 300 for the first time (+10) — it is
#     the closed-struct field-ladder miss point, one of the read chokepoints.
func-budget-allow:
  - src/codegen/hof-native.ts::ensureNativeArrayHof
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime.ts::fillExternArrayLikeStructArms
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
---

# #4160 — "clean elements" protector cell for Array.prototype traversal

## Status (2026-08-06) — partially landed, UNOWNED, claimable

Back to `ready`. The frontmatter said `in-progress` / `assignee:
ttraenkler/sendev-4160-read`, but that agent no longer exists and its work
merged; the claim on `origin/issue-assignments` was **released** on 2026-08-06
so the remainder can be picked up. Nobody is working on this right now.

## Follow-up (2026-08-12) — typed `filter` live-delete route

The own-array descriptor dependency has now landed far enough to expose a
smaller coherent Test262 slice. A fresh standalone <=ES5 census (oracle v13,
48,735 baseline rows, 8,680 in goal scope) measured two `filter` rows whose
remaining failure was the same shared index MOP gap:

- `15.4.4.20-9-b-13.js`
- `15.4.4.20-9-6.js`

Both delete an own array index during iteration while the same index exists on
`Array.prototype`. The typed filter loop stayed on its dense route because
`overlayRouteActive` did not include `protoIndexDirty`; once routed, the
`FLAG_DELETED_INDEX` overlay tombstone answered `undefined` / absent directly,
incorrectly terminating the required prototype walk.

The follow-up adds `protoIndexDirty` to the existing typed-lane route and makes
the canonical `__extern_get_idx` / `__extern_has_idx` overlay prologues continue
through the #4160 prototype-index companions after a deleted-own hit. The same
helpers are emitted once in a hybrid prepared-IR module; there is no parallel
IR-only implementation. Exact focused A/B is **0/7 -> 2/7**, with the two rows
above flipping fail->pass and no pass->fail transition.
The full 242-file `Array.prototype.filter` directory, run locally through the
same instrument on exact `origin/main` `81ff7c4` and this rebased branch, moved
from `{pass:162, fail:77, compile_error:3}` to
`{pass:164, fail:75, compile_error:3}`; those same two rows were the only
transitions.

The other five measured rows are explicitly not claimed here. Two borrowed
array-like rows require a different object-carrier model; two sparse numeric
array rows collapse holes and `undefined` into the same f64 sentinel; and one
row needs a filter result carrier capable of preserving an inherited string.
Those are distinct roots, not safe extensions of this route patch.

**Landed** (merged to main):

- **Slice 1** — the widened pre-scan (`protoIndexDirty` over `Object.prototype`
  as well as `Array.prototype`, plus `dynamicCodeDirty`). PR #4128. Details in
  `## Slice 1 — LANDED 2026-08-05`.
- **Slice 2, standalone read side** — `src/codegen/proto-index-store.ts` and its
  consult hooks; the per-iteration `HasProperty` gate on the seven visiting
  HOFs. PR #4129. Details and boundaries in `## Implementation notes — S1+S2
  read side`.

**Remaining** — three independent pieces, none of them started:

1. **Write side / `#4159` dependency.** The typed-lane write half is blocked on
   #3251 S2; see #4159.
2. **The JS-host lane.** Everything landed is gated `ctx.standalone &&
   ctx.protoIndexDirty`. The host lane is untouched, so the "on both lanes"
   acceptance criterion is not met.
3. **Slice 3, `LengthOfArrayLike` as a real `[[Get]]`** (`15.4.4.19-2-9`).
   Independent of the flag, much smaller, can land in parallel.

**Do not re-derive a target count from the ~297 figure.** The measured scoped
A/B for the read side was **+0**, because the own-accessor-descriptor path fails
first — see `### Sizing correction`. Re-measure only after the #3251/#2668/#4161
own-descriptor family lands. The acceptance criterion "≥ 200 of the ~297 pass"
below is stale for the same reason.

## Problem

`Array.prototype` iteration methods read a **dense snapshot** of the receiver
instead of performing the spec's per-index `HasProperty` + `Get`, which must walk
the **prototype chain**. So a test that installs an index-keyed property on
`Object.prototype` / `Array.prototype` and then iterates never sees it.

The canonical case, `built-ins/Array/prototype/forEach/15.4.4.18-7-b-12.js` —
the single largest failure signature in the ES5+untagged standalone scope
(135 files share its assertion):

```js
var obj = { 0: 0, 1: 111, length: 10 };
Object.defineProperty(obj, "0", {
  get: function () { delete obj[1]; return 0; },
  configurable: true,
});
Object.prototype[1] = 1;              // <- the inherited index
Array.prototype.forEach.call(obj, callbackfn);
assert(testResult, 'testResult !== true');   // callback must see (1, idx 1)
```

Note the receiver: **a plain object with a `length`**, not an array.

## Why this needs its own issue rather than living inside #3251

#3251's overlay is a per-`$Vec` companion table. It is the right substrate for
**own** descriptors on **arrays**, and it works — the dynamic lane reads accessor
indices correctly today. But it cannot fix this cluster, for two independent
reasons:

1. **The mutation is not on the receiver.** `Object.prototype[1] = 1` touches a
   different object entirely. No amount of per-receiver companion storage sees it.
2. **The dominant receiver is not a `$Vec`.** It is an ordinary array-like object
   reached through `.call`. The overlay's `ref.test $__vec_base` arm never fires.

#3251 does record "Prototype-chain index inheritance" as a host-lane consumer of
the overlay (see its #3201 measurement section). That note is what this issue
promotes to its own tracked mechanism — filing it under an epic whose substrate
structurally cannot address it is how a cluster stays open while looking owned.

## Measurement

**~297 files** in the ES5 + untagged standalone scope carry the characteristic
signatures (`testResult !== true` 135, `newArr.length` 45, `testResult[i]` 40,
`accessed !== true` 39, `result !== true` 24, `callCnt` 11).

By method: `reduceRight` 68 · `reduce` 62 · `forEach` 59 · `map` 49 ·
`filter` 47 · `every` 7 · `some` 5.

**187 of 297 (63 %) also fail on the JS-host lane** — this is not standalone
work. Baselines fetched 2026-08-04, `oracle_version` 12, lane `honest`, baseline
SHA `d3d7ec4c`. Source:
`plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md`.

The signature overlap with #3185 is deliberate: this is a **mechanism slice of
that umbrella**, not a separate population. Do not add the two.

## The design constraint this issue exists to satisfy

The obvious fix — per-index `HasProperty` + prototype walk on every element —
would make the dense loop dramatically slower, which is unacceptable and is why
the current snapshot exists. The point of this issue is that **you do not have to
pay per element.**

## Proposed direction: EXTEND the protector that already exists

**Correction to this issue's first draft.** It claimed "there is no
protector/invalidation concept in the tree today", based on a grep for
`protector|invalidat`. That grep missed it because of naming: the concept exists
as **`ctx.arrayProtoIndexDirty`** (#2001 S2, `src/codegen/array-holes.ts`), and
it is better than the runtime cell originally proposed here — it is a
**compile-time** flag set by the `scanForArrayHoles` AST pre-pass, so when clear
there is no runtime check to pay at all. Do not build a `(mut i32)` global; extend
this.

What exists today (`isArrayProtoIndexWrite`, array-holes.ts ~L107):

- Detects `Object.defineProperty` / `defineProperties` / `Reflect.defineProperty`
  targeting `Array.prototype`, and `Array.prototype[i] = …` for any index
  expression (need not be literal). Name writes (`Array.prototype.foo = …`) are
  correctly ignored — they cannot make an integer index inherited.
- Deliberate static over-approximation: a module that dirties `Array.prototype`
  indices anywhere loses the optimisation everywhere.
- Set in a **pre-pass**, not lazily per-site — its own comment explains why:
  function compilation order is not source order, so a lazy flag desyncs reads in
  one function against stores in another. Preserve that property.

Two gaps, which are the actual work:

1. **`Object.prototype` is not covered.** `isArrayPrototypeExpr` matches only
   `Array.prototype`. The dominant failing test (`15.4.4.18-7-b-12`, 135 files)
   writes `Object.prototype[1] = 1`. Widening the predicate is small and
   self-contained.
2. **There is no consumer that makes the semantics CORRECT — only one that makes
   them less wrong.** The single use (`array-methods.ts:5591`,
   `ctx.usesArrayHoles && !ctx.arrayProtoIndexDirty && …`) *disables* the HOF
   hole-visit-skip when the flag is dirty. It falls back to visiting with
   `undefined`; it never walks the prototype chain to find the inherited value.
   That is why these 297 files still fail with the flag doing its job.

So the design is: widen the flag, then add the missing **generic arm** —
per-index `HasProperty` + `Get` through the prototype chain, emitted only when
the flag is dirty. Programs that never touch a prototype index keep today's
emission **byte-identical**, with no runtime guard, which is a stronger
no-regression guarantee than any benchmark.

## Slice 1 — LANDED 2026-08-05

`protoIndexDirty` (renamed from `arrayProtoIndexDirty`) now matches
`Object.prototype` as well as `Array.prototype`, and a new `dynamicCodeDirty`
predicate forces it when the module contains `eval` / `Function` / `new
Function` — closing the hole where static eval inlining (#1163) splices
statements in *after* this pre-pass has run. Byte-identity verified by A/B
against main's compiler over 14 compilations (7 programs x both lanes): all
hashes identical.

**One latent bug found and fixed while doing it.** The #2001 predicate matched
only a bare `PropertyAccessExpression`, so `(Array.prototype as any)[0] = 1` —
which is how you write it in **TypeScript**, the language this compiler actually
consumes — did not set the flag. test262's plain-JS corpus has no cast, which is
why it went unnoticed. `unwrapExpr` now strips parens and the type-only
assertion forms.

**Behaviour change to be aware of:** widening the flag also widens its one
existing consumer, `shouldHoleSkip`. A module writing `Object.prototype[i]` or
using `eval` now loses the HOF hole-visit-skip and falls back to
visit-with-`undefined`. For an inherited *value* that is still not spec-correct
(the callback should see the inherited value, not `undefined`) — but the visit
COUNT becomes right, and the fallback is the prerequisite for slice 2, which
makes the value right too. Verified against main: the hole/peephole test set has
an identical pass/fail split before and after.

## Slices (suggested)

1. ~~**Widen the pre-scan to `Object.prototype`.**~~ **DONE** — Generalise `isArrayPrototypeExpr`
   to `isArrayOrObjectPrototypeExpr`, rename the flag to `protoIndexDirty` (keep
   an alias if that churns too many sites), and unit-test that
   `Object.prototype[1] = 1`, `Object.defineProperty(Object.prototype, "1", …)`
   and the `Array.prototype` shapes all set it while `Object.prototype.foo = …`
   does not. **No emission change** — pure substrate.
2. **One consumer, one method** (`forEach` — 59 files, simplest semantics): when
   `protoIndexDirty`, emit a generic loop doing per-index `HasProperty` + `Get`
   through the prototype chain instead of the dense read. Assert with a WAT diff
   that the flag-clear path is byte-identical to today.
3. **`LengthOfArrayLike` as a real `[[Get]]`** — an accessor `length` must be
   invoked, once, before the loop (`15.4.4.19-2-9`). Independent of the flag and
   much smaller; can land in parallel.
4. Fan out to `reduce`/`reduceRight`/`map`/`filter`/`every`/`some`.

**Shared with #4159.** That issue needs the same kind of pre-scan flag
(`vecAccessorDescriptorDirty`, for accessor descriptors on any receiver) and
its Work Item A adds one to the same `scanForArrayHoles` walk. Land the pre-scan
extension once and consume it from both; do not add two competing walks.

### Why not a runtime protector cell

A `(mut i32)` global checked once per HOF call would also be cheap, and it is
what V8/SpiderMonkey do — but they need runtime invalidation because they JIT a
long-running process. This compiler emits a whole module ahead of time and
already knows the answer statically. A runtime cell would add a load and a branch
for zero information gain. Prefer the compile-time flag; reach for a runtime cell
only if `eval`/`Function` can introduce a prototype-index write the pre-scan
cannot see — which is a real case worth checking, and would make the cell a
narrow addition for the dynamic-code lane only.

## Explicitly NOT in scope

- **Per-step `length` re-reads.** The spec fixes `len` once (§23.1.3.15 step 2 and
  analogues) and `src/codegen/hof-native.ts` already does that correctly. An
  earlier revision of the source analysis got this wrong; see the correction
  section there. `15.4.4.19-8-b-15` passes in a real engine because the loop runs
  to the ORIGINAL bound and the now-out-of-range index resolves through
  `Array.prototype["2"]` — a prototype lookup, which is what slice 2 adds.
- Own-descriptor storage on `$Vec` receivers — that is #3251.
- Typed-lane accessor coherence — that is #4159.
- Hole materialisation (`new Array(2)[0]` reading `null` rather than `undefined`)
  — adjacent, tracked at #2001 and in #3251's measurement section.

## Acceptance criteria

- `Array.prototype.forEach.call(arrayLike, cb)` visits an index inherited from
  `Object.prototype`, on both lanes.
- A getter that deletes a later index mid-iteration causes the prototype's index
  to be visited instead (`15.4.4.18-7-b-12`).
- WAT diff proves the flag-clear emission is byte-identical to today's (this is
  the no-regression guarantee; a benchmark is a weaker substitute).
- The pre-scan flag is set by `Object.prototype[0] = v`, by an index accessor
  define on either prototype, and by the existing `Array.prototype` shapes —
  each with a test — and is NOT set by `Object.prototype.foo = v`.
- ≥ 200 of the ~297 pass; standalone floor NET ≥ 0.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate` (record reads
  `status=reserved` on `origin/issue-assignments`). The allocator's open-PR scan
  degraded (`gh` unavailable in this container), so `--allow-unscanned` was used
  after scanning the open-PR set through the GitHub API: two open PRs
  (#4106, #4123), highest issue id introduced is 4154. The required
  `check:issue-ids:against-main` gate remains the backstop.
- The counts here come from the published baselines. Unlike #4159, **no local
  repro was run for this issue** — the mechanism is read from the test bodies
  (quoted above) plus `src/codegen/hof-native.ts`. Reproducing
  `15.4.4.18-7-b-12` is the first step for whoever picks it up.

## Architect review (fable, 2026-08-05) — two corrections to the design above

Full spec lives in #4159 under `## Architect Spec (fable)`; it covers both
issues. Two findings change this issue's plan materially:

**1. The generic arm does NOT belong in `__hof_*`.** Measured: an
`Array.prototype.forEach.call(obj, fn)` with an inline callback does not reach
`hof-native.ts` at all — it compiles through `compileArrayLikeBorrow`
(`src/codegen/array-prototype-borrow.ts:339-489`), an inline per-call-site loop
that ALREADY gates each iteration on `__extern_has_idx`
(`array-prototype-borrow.ts:607`, "spec HasProperty used to skip holes"). Slice 2
above ("one consumer, one method") is therefore aimed at the wrong layer.

The correct target is the two MOP chokepoints — **`__extern_has_idx` and
`__extern_get_idx`** — which today answer **own-only**. Fix the fallback there
and every consumer inherits it at once: the borrow loops, the `__hof_*` steppers'
Gets, and plain dynamic `o[i]`.

**2. Slice 1 must CREATE a store, not just widen a scan.** This issue assumed the
runtime substrate existed and only the compile-time flag needed widening. It does
not. Measured: `Object.prototype[1] = 111` followed by `({length:3})[1]` **misses
entirely** — the write lands nowhere in standalone. So the work is a new
proto-index store (two `(ref null $Object)` companions for `%Object.prototype%`
and `%Array.prototype%`, suggested module `src/codegen/proto-index-store.ts`)
plus write arms on `__extern_set` / the define natives, mirroring the host lane's
existing `_protoIndexHas` / `_protoIndexGet` (`src/runtime.ts:372-417`).

That also reframes this issue's size: it is substrate creation, not an
extension — re-check the `horizon: l` estimate before scheduling.

**Also confirmed:** the `arrayProtoIndexDirty` reading in the section above is
correct — one consumer (`array-methods.ts:5590-5592`), disables the hole-skip,
no prototype walk downstream.

**New: the eval hole is real and already bites the EXISTING flag on main.**
Static eval inlining (#1163, `expressions/eval-inline.ts`) splices eval'd
statements in during **body compilation**, after the pre-scan has run — so
`eval('Array.prototype[0] = 1')` never sets `arrayProtoIndexDirty` today. The
spec's fix is a `dynamicCodeDirty` predicate (any `eval` / `Function` callee)
that ORs into both flags; a lazy set at splice time would reintroduce the
compilation-order desync the pre-pass exists to avoid. Still no runtime cell
needed.

**Host half stays open.** Why 63 % of this cluster fails on host *despite*
`_protoIndexHas` / `_protoIndexGet` existing there is unexplained. A host-lane
probe is the first task for whoever picks that half up — do not assume the
standalone mechanism transfers.

**Sequencing.** Shared slice **S0** (the pre-scan flags, jointly with #4159's
Work Item A) lands once and first. This issue's S1/S2 then run in parallel with
#4159's S3.

## Implementation notes — S1+S2 read side (sendev-4160-read, 2026-08-05)

Implements #4159 architect-spec §(c) items 1-4 (item 5, LengthOfArrayLike,
deliberately untouched). New module `src/codegen/proto-index-store.ts`; consult
hooks in `object-runtime.ts` / `object-runtime-enumeration.ts` / `hof-native.ts`;
finalize wiring in `index.ts`. Everything gated `ctx.standalone &&
ctx.protoIndexDirty`.

**WHY the shape differs from a literal reading of the spec — three findings:**

1. **"Final arms in `__extern_get_idx`/`__extern_has_idx`" cannot work as
   literally specced for `$Object` receivers.** Measured (P3 WAT): the
   `$Object` arm of `__extern_get_idx` DELEGATES to `__extern_get(v,
   ToString(i))` and returns its result — a final arm after it never runs. The
   own-absent miss is only precisely knowable inside `__extern_get`'s
   proto-walk (an own entry HOLDING undefined must still shadow the chain), so
   the consult lives at the TERMINAL miss of `__extern_get` / `__extern_has`
   (registration-time, flag known from the pre-scan), and at the OOB/ladder
   miss points of the vec + closed-struct arms (finalize, same gate). Same
   semantics as the spec intended, different insertion points.
2. **Write arms are substitution-by-RECURSION, not re-implementation** (the
   #4161 `closureBagSubstitutionArm` idea): the prepended `$NativeProto` brand
   arm re-targets `__extern_set` / `__defineProperty_value` / `_accessor` at
   the companion `$Object` and calls ITSELF — accessor-set gate, #2042-S4
   preflight, flag translation and frozen checks all apply to the companion
   for free, and the define arms still return the ORIGINAL receiver.
   `__extern_set_strict` needs no arm (its non-`$Object` head already
   delegates to `__extern_set`).
3. **Integer-index-only participation is enforced at the WRITE, not the
   read.** `__protoidx_norm_key` admits only canonical non-negative-integer
   keys ("01"/" 1"/""/1.5/2^53 all refused, matching host `_protoIndexHas`'s
   `Number.isInteger && >= 0` plus CanonicalNumericIndexString for strings),
   so the companions' key space is integer-only by construction and reads can
   consult unconditionally. Symbol/object keys fall through untouched — an
   object key is NOT ToPrimitive'd in the gate, so a user `toString` never
   runs twice.

**`__hof_*` gate (spec item 4):** per-iteration `__extern_has_idx` gate on
forEach/map/filter/some/every/reduce/reduceRight (NOT the find* family —
§23.1.3 visits every index there); map pushes undefined for an absent index to
keep result alignment (the dense `$ObjVec` carrier cannot hold a hole); reduce
no-init additionally scans for the FIRST PRESENT element as the seed
(§23.1.3.24 step 8.b), keeping the documented return-undefined boundary for
"no present element" instead of the spec TypeError.

**Bonus beyond the letter of the spec:** direct read-back on the proto objects
themselves (`Object.prototype[1]` after the write) via a `$NativeProto` brand
arm on `__extern_get_idx`/`__extern_has_idx` — a store you cannot read back
from its own carrier is a debugging trap.

**Verified:** P3 → 111 (was NaN), P2 → sum 113/visits 3 (was 2/2);
defineProperty + OOB-array + `in` + non-integer-refusal + dirty-dense-HOF
probes green (`tests/issue-4160-proto-index-store.test.ts`); byte-identity
A/B vs main over 9 flag-clear programs × {standalone, gc} — all 18 sha256
identical; scoped standalone test262 A/B over
`built-ins/Array/prototype/{forEach,map,filter,some,every,reduce,reduceRight}`
(results in the PR description).

### Sizing correction (measured 2026-08-05, scoped A/B) — the ~297 figure conflates TWO mechanisms

The scoped standalone test262 A/B over `built-ins/Array/prototype/{forEach,
map,filter,some,every,reduce,reduceRight}` (1,605 files, both sides run with
the same instrument) came back **byte-identical: {pass 879, fail 721,
compile_error 5} on BOTH main and this branch — zero transitions**. The
instrument is not blind: swapping main's compiler files in flips this issue's
own acceptance test from 8/8 to 5-failed, so the A/B can see compiler changes.
The zero is real.

Root cause (project-lead triage, confirmed): the ~297-file estimate came from
signature-based clustering, which lumped **own-accessor-descriptor** tests
together with **prototype-chain-inheritance** tests because they share
assertion text. The canonical `15.4.4.18-7-b-12` needs an own accessor on
`obj["0"]` (whose getter deletes `obj[1]`) to run BEFORE the inherited index
can matter, and e.g. `every/15.4.4.16-7-c-i-9.js` is "own accessor property on
an Array-like object" — no prototype involved at all. Both pre-scan flags DO
fire on the real test sources; the blocker is that the own-descriptor path
(closed-struct/`$Object` accessor descriptors — #2668 / #3251 / #4161 scope)
fails first, so the prototype-chain mechanism never gets to matter.

**Real dependency order:** own-accessor descriptors on array-like receivers
land FIRST; only then can the prototype-chain half of this cluster be scored.
This slice is therefore **capability, not conformance**: the mechanism is
proven by its acceptance tests (P2/P3 + 9 more in
`tests/issue-4160-proto-index-store.test.ts`), and its test262 yield is gated
behind the own-descriptor work. Do NOT re-derive a target count for this issue
from the old cluster; re-measure after #3251-family lands.

**Known boundaries (recorded in the module header too):**
- `Object.defineProperties(Object.prototype, {...})` (plural) not armed.
- Companion setter invoked with the companion as `this` (write side only; the
  Get side binds the spec receiver).
- In-bounds vec holes still answer present (dense carriers; #2001/#3185).
- `$ObjVec` OOB and unrecognized-receiver misses in `__extern_get_idx` do not
  consult (enumeration-result arrays; out of the measured cluster).
- The `__hof_*` route only serves vec/`$ObjVec` receivers today (measured:
  plain-`$Object`/closed-struct `obj.forEach(...)` member calls miss on main
  independently of this change — the test262 `.call` shapes go through
  `compileArrayLikeBorrow`, which is covered).
