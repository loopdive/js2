---
id: 4010
title: "M2 — own properties on a non-$Object receiver live in TWO DISJOINT side tables that clobber each other; unify them"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# M2 — own properties on a non-$Object receiver live in TWO DISJOINT side tables that clobber each other; unify them

## Problem

Own properties written onto a **non-`$Object` receiver** live in per-type side
tables that the generic own-property natives do not all consult. Arrays carry
**two disjoint, identity-keyed side tables**, built by different issues, each
explicitly scoping the other OUT in its own header comment:

- `src/codegen/vec-props.ts` — #3537, the expando **"bag"**; scopes reflection out
- `src/codegen/vec-overlay.ts` — #3251, the descriptor **"companion"**; scopes
  `length` out

**Neither is aware of the other.** Measured:

```js
arr.q = 12;
Object.defineProperty(arr, "q", {writable: false});
arr.q   // => undefined
```

The descriptor op on one table clobbers the value held in the other.

`Date` / `RegExp` / `Error` have **no expando substrate at all** —
`d.enumerable = true; d.enumerable` does not even round-trip.

## Why this is the lever, not the symptoms

**~318 of the 347 files** in the #3991 population are blocked behind this.
Two issues already filed are **symptoms of it, not independent arms**:

- **#4006** — array `length`'s `writable` dropped on store
- **#4007** — array `length` absent from descriptor reflection in standalone

Do **not** fund those separately; fixing either in isolation patches a symptom of
a substrate defect. Whoever takes this cites them.

## What is NOT broken — do not re-litigate

- **`ToPropertyDescriptor` IS implemented** for dynamic descriptors, dynamically
  and proto-inclusively (#3246). The defects sit one level above it and one below.
- **The descriptor model is not broadly broken.** A 10-receiver × 5-column probe
  (50/50 correct on Node first) shows it **9/9 correct on the open `$Object`
  substrate**. Every remaining failure is a receiver-**representation**
  reachability problem, which is exactly what this issue is.

## ⚠ Two hazards, both measured the hard way

1. **Making a dead path live surfaces defects underneath it**, and some green
   files are green only because the dead path returned a plausible constant.
   `15.2.3.7-5-b-122` was **passing because the broken expansion defined
   `undefined`** — precisely what it asserts. Correct routing exposed a real
   `undefined→null` normalisation defect (`getField` normalises `undefined→null`
   for the absent get/set halves per #2106 S1; on `value` that is wrong, and
   `typeof null === "object"`).
2. **It was 1 file in 634 — a sampled at-risk set would have missed it.**
   Enumerate the complete at-risk population over all 43,106 official files; do
   not sample. That is what caught it.

Evidence table: `plan/issues/3991-dynamic-descriptor-static-expansion.md`.
