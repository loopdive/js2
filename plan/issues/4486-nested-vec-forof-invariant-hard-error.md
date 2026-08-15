---
id: 4486
title: "Identifier-head for-of over string[][] hard-fails: prepared-vector registry answers invariant instead of unsupported"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: statements
goal: ir-full-coverage
related: [4470, 3583]
origin: "2026-08-15 #4470 measurement (dev-4470) — found on unmodified main while probing for-of head shapes"
---

# #4486 — nested-vec for-of: claimed unit hard-fails instead of demoting

## Problem

On unmodified main (`3faec1ae`-era), with zero changes applied:

```ts
function f(rows: string[][]): number {
  let n = 0;
  for (const r of rows) { n = n + 1; }
  return n;
}
```

does not compile (`success: false`). The unit is CLAIMED by the selector,
then the prepared-vector registry refuses the `vec<vec<externref>>` element
as an **`invariant`** (`prepared vec element vec<externref> is not
supported`, `invariant@resolve`) rather than an `unsupported` — so the
function hard-fails instead of demoting to the perfectly good legacy body.
Same shape as the adjacent `.length`-on-externref hard error.

By contrast `number[][]` / `Array<Array<number>>` / tuple-typed nestings
take the soft `unsupported@resolve` path and demote cleanly — the
inconsistency is specific to the `vec<externref>` element arm in
`src/ir/prepared-vector-support.ts` (~L70) / `resolvePositionType`
(`src/codegen/index.ts` ~L989).

Pinned as a KNOWN DEFECT in `tests/issue-4470.test.ts` section C (landed
via PR #4590), so the repro cannot go stale.

## Acceptance criteria

1. The repro compiles again: the registry's `vec<externref>`-element
   refusal becomes a typed `unsupported` demote (matching the sibling
   nestings), NOT an invariant — a capability gap by construction, never a
   producer-promise violation (same reasoning as the #4578 string-arm fix).
2. The #4470 section-C pin flips from KNOWN-DEFECT to positive.
3. `check:ir-fallbacks` no growth beyond the (typed) bucket this moves
   into; host lane 37/37 unchanged.

## Note

This is the demote-vs-invariant classification bug only. Actually ADOPTING
nested-vec carriers (so these claims lower instead of demoting) is #4470's
blocked scope — carrier first, head second, per the unblock spec there.
