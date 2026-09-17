---
id: 6497
title: "`[7, undefined]` element read-back answers `typeof \"number\"` — an explicit `undefined` in an f64 vec loses its identity on INDEX read"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: core-semantics
related: [6492, 2864, 3315]
---

# #6497 — an explicit `undefined` array element reads back as a number

Found while working #6492 round 5/6. **Not a linked-lane bug** — it reproduces
IDENTICALLY in both test262 lanes, which is exactly why it is filed separately:
it is an ordinary compiler defect that the parity work kept tripping over.

```js
var a = [7, undefined, ];
a.length;        // 2      correct
typeof a[1];     // "number"   ← should be "undefined"
```

Measured 2026-09-17 with the real runner in BOTH lanes, and again through the
in-process linked lane after #6492 round 6 landed: still `"number"`.

## What is (and is not) already fixed

The array is lowered to an f64 vec and the `undefined` element is stored as the
`UNDEF_F64_BITS` sentinel — that part is right, and the DESTRUCTURING read-back
resurrects it correctly:

```js
var [p, q, r] = a;
typeof q;        // "undefined"   correct (the `undefSentinel`-branded coercion)
```

So the sentinel survives the store; what is missing is the same
sentinel-aware unboxing on the **index read** path. #6492 round 6 fixed the
*producer* of the canonical `undefined` at the branded coercion site
(`coerceType`'s `from.undefSentinel === true` arm calls
`ensureCanonicalUndefinedExtern`), but an `a[1]` read does not carry the brand
and takes the generic `f64 → externref` box, which — deliberately, per #3315 —
does NOT resurrect the sentinel, because an arbitrary computed f64 carrying
those bits is a genuine NaN number.

That is the crux: the fix cannot be "resurrect the sentinel in the generic
box". It has to be the #3315 rule applied one site further out — the vec
element read must know it is reading a SLOT (which can hold `undefined`), not a
computed number. `src/codegen/vec-access-exports.ts` already does this for the
sparse-hole sentinel (`__get_undefined` vs `ref.null.extern` there); the
explicit-`undefined` sentinel needs the same treatment.

## Why it matters beyond the one expression

Any read-back of an explicitly-`undefined` element answers a NUMBER, so
`assert.sameValue(a[1], undefined)`, `a.indexOf(undefined)`, `JSON.stringify`,
spread and every HOF callback see `NaN`-the-number instead of `undefined`.

## Acceptance

- [ ] `typeof [7, undefined][1] === "undefined"` and `[7, undefined][1] === undefined`.
- [ ] A computed NaN is still a NUMBER (`typeof (0/0) === "number"`,
      `typeof Math.abs(0/0) === "number"`) — the #3315 regression this must not
      reintroduce, including the self-hosted Math family whose NaN fast path
      returns the INPUT bits unchanged.
- [ ] Sparse holes keep their existing behaviour (`1 in [1, , 3]` false).
- [ ] Measured on both test262 lanes; a scoped honest slice shows no losses.
