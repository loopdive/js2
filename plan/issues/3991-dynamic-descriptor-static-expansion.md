---
id: 3991
title: "Object.defineProperties/create static expansion silently defines `undefined` for a non-literal descriptor"
sprint: 78
status: done
completed: 2026-08-01
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/L-descriptor
goal: standalone-gap
area: codegen/object-ops
---

## Problem

`compileObjectDefineProperties`' **static expansion** claims descriptor-map
entries it cannot actually handle, and for those it defines the property with an
**undefined value and default attributes** — silently, with no refusal that
anything downstream (root-cause classifier, standalone floor, trap ratchet) can
observe.

The classic test262 shape it breaks:

```js
var descObj = new Number(-9);        // or [], new Date(0), a user ctor
descObj.get = function() { return "Number"; };
Object.defineProperties(obj, { property: descObj });
assert.sameValue(obj.property, "Number");   // got: undefined
```

### Root cause

`isStaticDescWellFormed` (`src/codegen/object-ops.ts`) returned **`true`** for a
non-object-literal descriptor expression, on this reasoning:

> Identifier / call / property-access / etc — runtime-resolved but legitimately
> may be a valid object (as in `{property: Math}` or `{property: descObj}`).
> Expand statically; `Object.defineProperty` will handle validation at runtime
> via its own path.

**That last sentence is false**, and it is false for exactly the reason #3984
documented in the same function: the expansion loop does **not** delegate to
`compileObjectDefineProperty`. It parses the descriptor's fields itself, and
every one of those parsers sits inside

```ts
if (ts.isObjectLiteralExpression(descExpr)) { … }
```

So for a non-literal descriptor it parsed **nothing**: `valueExpr` stayed
`undefined`, every attribute stayed `undefined`, and the property was defined
with an undefined value.

This is the **third instance of one recurring defect class** in this subsystem:
a static fast path that *claims* a case it cannot handle, and degrades to a
silent wrong answer rather than a refusal (#3983 aliased strict `[[Set]]` onto
the sloppy helper; #3984 left `maybeEmitVecLengthDefine` with one call site).

### Why routing to the dynamic path is the fix, not a fallback

The dynamic `__defineProperties` native already implements
ToPropertyDescriptor (§6.2.5.6) **correctly over an arbitrary object** —
#3246 widened it past its old `ref.test $Object` gate specifically so
function / array / wrapper descriptors work — and it reads the fields with the
accessor-aware, proto-walking `__extern_get`. It is the only path that
implements the spec algorithm. **The whole fix is deleting the wrong fast-path
claim**; no new special case is added.

`{property: Math}` (the case the old comment cited) is handled correctly by the
native too: `Math` has no `value`/`get`/`set`/`writable`/… own properties, so
ToPropertyDescriptor yields an empty descriptor and CompletePropertyDescriptor
fills in `undefined` + all-false — which is what the spec requires, and what the
static path only reached by accident.

## Measurement

**Baseline provenance** — `loopdive/js2wasm-baselines@d8c30f3b7d`
(2026-08-01T17:14:04Z), cut from js2 `main@bc54c09da`; rows timestamped 19:0x
local. Goal scope = test262 frontmatter carrying `es5id:` **or** none of
`es5id`/`es6id`/`esid`.

Instrument validated **in both directions before any claim**:

| check | expected | got |
| --- | --- | --- |
| official rows / pass | 43,106 / 25,755 (59.7%) | ✅ exact |
| goal scope run / pass | 8,545 / 6,176 (72.3%) | ✅ exact |
| corpus files that failed to open | 0 | ✅ 0 |
| 41 known-**passing** area files reproduce locally | 41 | ✅ 41 |
| 20 known-**failing** area files reproduce locally | 20 | ✅ 20 |
| full 812-file area sweep vs baseline | ≈812 fail | ✅ 811 fail, 1 baseline flake |

### Population / reachable / flips — reported separately

- **Population (mechanism, by reading bodies):** 347 of the 812 goal-scope
  descriptor-area failures pass a **non-literal descriptor** (42.7% of the
  area; 14.7% of the entire 2,369-file goal gap).
- **Reachable:** of those, only the sub-population whose *descriptor object's*
  own properties are visible to `__hasOwnProperty`/`__extern_get` can flip. A
  receiver-substrate probe (below) shows that is true for plain objects,
  `new Number`/`new String`, user-ctor instances and `Object.create` results,
  and **false** for arrays, functions, `Date`, `RegExp` and `Error` — a
  **separate, still-unowned mechanism (M2)**.
- **Measured flips: +29 / −0**, each re-run **solo** (29/29) to exclude the
  `compile_timeout` contention flakes that manufactured 5 phantom flips
  elsewhere on 2026-08-01.

**File count is not a flip ceiling: 347 population → 29 flips (8.4%).** The gap
is M2, not this fix.

### Regression evidence — a COMPLETE at-risk population, not a sample

This change is inert unless a source reaches the changed predicate, so the
at-risk set was **enumerated statically over all 43,106 official files** rather
than sampled:

- precise trigger shape (`defineProperties`/`create` with an object-literal map
  having ≥1 non-literal value): **302 files, 113 currently passing**
- deliberately **over-inclusive superset** (any mention of a 2-arg
  `Object.defineProperties(`/`Object.create(`, which also covers the
  #3782/#3957 identifier-expansion route): **1,144 files, 634 currently
  passing**

**Positive control on the enumerator: 29/29 of the measured flips fall inside
it** — so it does not under-match, and the 634 is quotable as a *population*
rather than a sample. Files outside it compile byte-identically and cannot move.

### The one regression the routing exposed — and why it existed

Re-running the **complete** at-risk population (not a sample) returned
**633/634**, with `built-ins/Object/defineProperties/15.2.3.7-5-b-122` failing.

That file had been **passing for the wrong reason**. Its descriptor object's
`value` is a **setter-only accessor**, so ToPropertyDescriptor must read
`[[Get]]` as `undefined` — and the old static path defined `undefined` because
it parsed no descriptor fields *at all*, which happens to be what the test
asserts. Routing to the real ToPropertyDescriptor made the read actually happen,
and it came back **`null`**.

Root cause: `__defineProperties`' `getField` appends `__nullish_to_null`. That
normalization is correct for the **absent `get`/`set` halves**, which is what it
was added for (#2106 S1 — keep the appliers' legacy null convention). It is
wrong for `value`: it conflates two distinct JS values, `undefined` becomes
`null`, and `typeof null` is `"object"` — precisely the observed
`Expected SameValue («"object"», «"undefined"»)`.

Absence needs no null convention on this path: the read only runs inside the
`hasField("value")` branch, and the accumulator reset already defaults `L_VALUE`
to the undefined singleton. `getField` therefore grows a `nullishToNull` opt-out
and the `value` read passes `false`. `get`/`set` and the boolean attributes are
untouched.

**Deliberately scoped to the PLURAL native**, the one this change newly
exercises. `__defineProperty_desc` carries the same normalization at its own
`getField("value")` — a real defect too, but files may likewise be passing for
the wrong reason there, so it needs its own measurement and is left as a
follow-up rather than changed blind.

**This is the lesson generalised:** a fix that makes a previously-dead code path
live will surface latent defects *underneath* it, and some currently-green files
are green only because the dead path returned a plausible constant. That is why
the verification set has to be the population you are protecting, not just the
one you are repairing.

### Kill-switch (attribution)

Reverting only this change (file-copy A/B — never `git stash`, per the shared
`refs/stash` hazard) returns all 29 flips to failing. Two pre-existing test
failures in `tests/issue-2680.test.ts` were checked against base and are
**identical with and without this change** (5 failed on both) — they belong to
#2680's proto-walk mechanism, not here.

## What this does NOT fix (M2 — separate, unowned)

A matched receiver-substrate probe (10 receiver kinds × 5 columns, every case
validated against node first — 50/50 correct on a real engine) shows the
descriptor model is **complete and correct on the open `$Object` substrate**
(9/9) and broken on every exotic representation:

| descriptor-object kind | expando read-back | `hasOwnProperty` sees it | `dP-s(o,{p:d})` after this fix |
| --- | --- | --- | --- |
| `{}` / `new Object()` / user ctor / `Object.create({})` | ✅ | ✅ | ✅ fixed |
| `new Number` / `new String` | ✅ | ✅ | ✅ fixed |
| `[]` | compile error | ❌ | ❌ |
| `function(){}` | ✅ | ❌ | ❌ |
| `new Date` / `new RegExp` / `new Error` | ❌ | ❌ | ❌ |

**M2 = own properties written onto a non-`$Object` receiver are stored in
per-type side tables that the generic own-property natives do not all consult.**
Arrays alone carry **two disjoint identity-keyed side tables** built by
different issues, neither aware of the other:

- `src/codegen/vec-props.ts` (#3537) — the "bag" for named expandos written by
  assignment; its own header scopes reflection over the bag **out**.
- `src/codegen/vec-overlay.ts` (#3251) — the descriptor "companion"; its own
  header scopes `"length"` **out**.

Measured consequence: `arr.q = 12; Object.defineProperty(arr, "q", {writable:false})`
makes `arr.q` become **`undefined`** — the descriptor op on one table clobbers
the value in the other. `Date`/`RegExp`/`Error` have no expando substrate at
all: `d.enumerable = true; d.enumerable` does not even round-trip.

Unifying those substrates is the next arm of this program and is where the
remaining ~318 files of the 347 live.

## Claims REFUTED during this work

1. **"function receivers are ~186 files."** A first-pass regex counted any file
   containing `var f = function(){}` — which is nearly every test262 file, since
   they all define helper functions. Classifying by the *receiver of the
   descriptor operation* gives **10**. Sizing off the earlier number would have
   funded the wrong arm ~19×.
2. **"The gap is that ToPropertyDescriptor is not implemented for dynamic
   descriptors."** It **is** implemented (#3246), dynamically and
   proto-inclusively. The defect is one level up (this issue: a static path that
   never reaches it) and one level down (M2: the descriptor object's own
   properties are invisible).
3. **The stale-baseline populations.** The dispatch numbers (796-file lever,
   2,541 gap) came from a 03:15 cache and were ~16h behind main. Re-derived on
   the fresh baseline: **739-file area, 2,369 gap**. The area's *share* of the
   gap was unchanged (31.3% → 31.2%), so the ranking held — but every absolute
   number moved.

## Acceptance criteria

- [x] Non-literal descriptor values route to the dynamic ToPropertyDescriptor path
- [x] +29 / −0 measured on the standalone lane, all flips confirmed solo
- [x] Complete at-risk population enumerated and re-run, not sampled
- [x] Attribution proven by kill-switch removal
