---
id: 6802
title: "codegen: read-only / copying Array methods (at, indexOf, includes, lastIndexOf, with, toSpliced, join, concat) snapshot the receiver before evaluating their arguments — same defect #6787 fixed for the in-place methods"
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
language_feature: arrays
goal: core-semantics
related: [6787, 4564]
requested_by: ttraenkler/claude-review
origin: "measured by the #6787 implementation (2026-10-01) and left out of its in-place scope"
---

# #6802 — argument evaluation order for the non-mutating Array fast paths

## Problem

#6787 added `callArgsNeedEarlyEvaluation` / `planCallArgs`
(`src/codegen/array-method-arg-order.ts`) and applied it to `push`, `unshift`,
`splice`, `fill`, `copyWithin` and the IR `tryLowerVecPush`. The read-only and
copying fast paths still read `length` / the backing before the arguments run:

```ts
const a = [1, 2, 3]; const r1 = a.at((a.push(4), -1));
const b = [1, 2, 3]; const r2 = b.indexOf((b.push(9), 9));
const c = [1, 2, 3]; const r3 = c.join((c.push(5), "-"));
```

| lane | `[r1, r2, r3]` |
|---|---|
| wasm (JS host, 2026-10-01, `9d977a7e`) | `[3, -1, "1-2-3"]` |
| JS | `[4, 3, "1-2-3-5"]` |

dev-6787 also measured `includes` → `false`, `lastIndexOf` → `-1`, and
`with` / `toSpliced` / `concat` dropping the element the argument pushed.
`slice` is already correct.

## Correction

Apply `planCallArgs` to each of these lowerings: evaluate every effectful
argument into a local first, then snapshot the receiver / `length`. Keep the
pure-argument shape byte-identical (the #6787 WAT-shape test pattern in
`tests/issue-6787-push-arg-order.test.ts` shows how to assert that).

Out of scope, as in #6787: coercion-time mutation (a `valueOf` that grows the
receiver during ToIntegerOrInfinity) needs a live-backing re-read, not an
argument-order change.

## Acceptance

- The probe matches JS on the JS-host lane and on `target: "standalone"`.
- `tests/equivalence/array-push-reentrancy.test.ts` gains one row per method
  (eight rows); pure-argument WAT shape unchanged for each.
