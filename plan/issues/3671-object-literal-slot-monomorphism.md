---
id: 3671
title: Non-empty object literal slots are still monomorphic (residual of #3669)
status: ready
sprint: current
priority: medium
horizon: m
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [3669, 2773, 2760]
created: 2026-07-26
---

# #3671 — non-empty object literal slots are still monomorphic

## Problem

#3669 fixed property-slot monomorphism for the `var o = {}` +
sibling-assignment widening pre-pass
(`src/codegen/declarations/object-shape-widening.ts`). A **non-empty** object
literal takes a different path and is still first-write-wins:

```js
var L = { p: 1 };
L.p = "s";
L.p === "s"; // false  -- still BROKEN
```

Compare, now fixed by #3669:

```js
var o = {};
o.p = 1;
o.p = "s";
o.p === "s"; // true
```

## Why it was scoped out of #3669

`collectEmptyObjectWidening` explicitly skips literals with properties
(`if (decl.initializer.properties.length > 0) continue;`), so the field type for
`{p: 1}` comes from the literal's own shape inference, not from the pre-pass
#3669 repaired. Extending #3669's widening there would change the field
representation for **every** object literal that later receives a cross-kind
write — a materially broader blast radius than the empty-literal path, and the
kind of widening the #3669 regression sentinels exist to catch.

Per the tech lead's standing condition on #3669 ("stop and say so rather than
pushing into the substrate"), this was split out rather than folded in.

## Guard already in place

`tests/issue-3669.test.ts` carries:

```ts
it.fails("KNOWN GAP (#3671): a non-empty object literal's slot is still monomorphic", ...)
```

`it.fails` records a known-failing expectation — it does **not** assert the
broken behaviour is correct. Vitest **errors when it starts passing**, so
whoever closes this issue is told to delete that block rather than finding it by
accident.

## Acceptance

- `literal-num>str` reports `ok` in
  `scripts/fixtures/issue-3669-monomorphism/transitions.js`.
- The `it.fails` block in `tests/issue-3669.test.ts` is **removed** (it will
  error otherwise).
- All #3669 regression sentinels and both invariants still hold: `undefined`
  writes always work, and reference-seeded slots never corrupt.
- Flip count measured with `scripts/harness-flip-probe.ts` (#3668),
  local-vs-local. **Zero is a publishable result** — #3669 itself measured zero
  flips on its 40-file sample.
