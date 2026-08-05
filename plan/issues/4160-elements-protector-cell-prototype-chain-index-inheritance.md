---
id: 4160
title: "Per-call \"clean elements\" protector cell for Array.prototype traversal — make prototype-chain index inheritance correct without taxing the dense loop (~297 ES5+untagged)"
status: ready
sprint: current
created: 2026-08-05
updated: 2026-08-05
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
---

# #4160 — "clean elements" protector cell for Array.prototype traversal

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

## Slices (suggested)

1. **Widen the pre-scan to `Object.prototype`.** Generalise `isArrayPrototypeExpr`
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
