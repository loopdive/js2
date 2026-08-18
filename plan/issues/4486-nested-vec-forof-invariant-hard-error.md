---
id: 4486
title: "Identifier-head for-of over string[][] hard-fails: prepared-vector registry answers invariant instead of unsupported"
status: done
completed: 2026-08-15
assignee: ttraenkler/opus-4486
sprint: 78
created: 2026-08-15
updated: 2026-08-18
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

---

## Resolution (2026-08-15)

### The change

One arm, in `src/ir/prepared-vector-support.ts` (the element-kind allowlist
inside `prepareIrVectorSupport`'s `layoutFor` callback):

```
- throw new Error(`prepared vec element ${…} is not supported`);
+ throw new IrUnsupportedError(
+   "type-resolution-unsupported", "resolve",
+   `prepared vec element ${…} is not supported`);
```

`classifyIrFailure` maps a plain `Error` to the untyped
`unexpected-internal-throw` **invariant**, and an invariant is a hard compile
error — so a unit whose legacy body had *already* been emitted
(`legacyBodyEmitted: true`) took the whole program down with it.

**Code choice** — `type-resolution-unsupported` at stage `resolve`, i.e. the
exact code + stage the sibling nestings already use (`resolvePositionType`'s
`array element TypeNode … could not be lowered to a primitive ValType`, via
`src/codegen/index.ts` ~L2801). Checked against the alternatives:

- It is the **#1921 contract** code and is listed under NEVER PROMOTE in the
  `STRICT_IR_POSTCLAIM_CODES` comment, so it cannot later be ratcheted into a
  hard error by mistake.
- `resolve` is deliberately **out** of `isStrictIrPostClaimStage`, so this adds
  no row to `POSTCLAIM` in `scripts/gen-ir-adoption.mjs` and the generator's
  strict cross-check is unaffected (verified: `check:ir-fallbacks` post-claim
  buckets stay empty).
- `late-preparation-unsupported` was the runner-up (this *is* late
  preparation), but it names a dependency/sealing failure elsewhere in the
  file set; using the sibling's code keeps "one gap, one verdict".

This is a capability gap **by construction**: the allowlist (f64 / i32 /
externref) is a property of the backend's physical vec layouts, not a promise
the selector or the builder made. Same class as #3565 / #3784 / #4035.

### Why only `string[][]` (and friends) hit it

`string[]` resolves to a physical `ref_null $vec_externref` — a `val` — so
`resolvePositionType` accepts `string[][]` and the unit **is** claimed; the
logical type is then `vec<vec<externref>>`, refused here. `number[][]` /
`boolean[][]` never get that far: their inner array stays an `irVec`, which
`resolvePositionType` rejects one layer earlier and demotes softly. Two
nestings, two verdicts, one underlying gap.

### Sibling-arm sweep

**Element/carrier kinds** — 15 probe shapes through production `compile()`,
A/B against the unmodified file. **6 hard-failed before, 0 after**, and the
casualty set was wider than the issue title suggests:

| shape | before | after |
| --- | --- | --- |
| `string[][]`, `Array<string[]>`, `string[][][]`, `any[][]`, `unknown[][]` | `invariant/unexpected-internal-throw@resolve`, **no binary** | `unsupported/type-resolution-unsupported@resolve` |
| `Uint8Array[]` (element `vec<f64>`, *not* a nested plain array) | same hard error | same clean demote |
| `number[][]`, `boolean[][]`, `{v:number}[][]`, `bigint[]`, `(()=>number)[]` | already soft | unchanged |
| `string[]`, `(string\|number)[]`, `Map<string,number>[]` | `emitted` | unchanged — the fix does not widen the refusal |

`Uint8Array[]` matters: the defect was never specific to `vec<externref>`, so
the fix is at the allowlist rather than at a `vec<externref>` special case.

**Other throws in the registry** (`prepared-vector-support.ts`,
`vec-layout.ts`) — audited, and the allowlist is the **only** capability-gap
arm. The rest are genuine invariants and were left alone:

- `prepared async vector … lost its physical layout`, `no physical vector
  layout for …`, `async vector owner … has no prepared runtime attachment`,
  `non-vector async layout key …`, `… carries divergent prepared layouts`,
  `IR vec type already carries a different prepared layout`, `IR async vec type
  has no prepared backend layout evidence` — each fires only *after* the
  element passed the allowlist, i.e. on a builder↔registry desync.
- `no sealed extern materializer for …` was the one judgement call.
  `buildVecFromExternMaterializer` returns `undefined` on
  `ctx.indexSpaceFrozen` — which *would* be a late-preparation capability gap —
  but the freeze (`src/codegen/index.ts` L5747 / L8135) happens well after
  `prepareVectors`, so the only reachable cause is a missing `getVecInfo`, a
  desync. Left as an invariant; recorded here rather than changed blind.

### Test Results

- `tests/issue-4486.test.ts` (new) — 16 tests. **A**: nine carrier shapes all
  withdraw as `unsupported/type-resolution-unsupported@resolve` with
  `irBodyEmitted: false, legacyBodyEmitted: true`; a flat `string[]` still
  **emits** (the fix must not widen the refusal). **B**: five programs are
  compiled, instantiated and run in-process against the node answer (row
  count 3, summed inner lengths 6, two-level concat `"abcde"`, `rows[1][0]`
  `"c"`, empty outer 0). **4 of those 5 did not compile at all before.**
- `tests/issue-4470.test.ts` section C — the KNOWN-DEFECT pin flipped to the
  clean demote; file header corrected. `irBodyEmitted: false` is now the
  assertion that flips when #4470 adopts nested-vec carriers.
- `pnpm run check:ir-fallbacks` — **OK**. No unintended, post-claim or
  module-level growth; post-claim buckets still empty (this demote is at
  `resolve`, which is not a post-claim bucket).
- `pnpm run check:ir-only` — **READY**. Host lane **37/37** emitted, 0
  invariants; standalone lane 19 emitted / 18 unsupported, all `select`-stage
  — unchanged.
- Pre-existing reds on this base, identical with and without the change
  (A/B'd, **not** caused by it): `issue-3529-dataflow-outcomes` (3),
  `issue-3521-prepared-free-function-routing` (1), `issue-1923` (1).

### Out of scope (found while probing, filed as observations only)

Richer probe programs still hard-fail, for defects of the **same class** but
in different files — a claimed unit throwing a plain `Error` at `build`:

- `ir/from-ast: mixed-type array literal not in #1804 scope` — a nested array
  literal (`[["a","b"],["c"]]`) in a claimed function.
- `ir/from-ast: direct call to "f" has no exact AST-site plan`.

Neither is in the vector registry; both reproduce identically on unmodified
main.
