---
id: 3358
title: "codegen: relocate TypedArray.prototype.set bounds check out of array-methods.ts (validated design, #3202 took the allowance route instead)"
status: done
assignee: dev-refactor
completed: 2026-07-17
sprint: current
created: 2026-07-17
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: refactor
area: codegen
language_feature: typed-array
goal: maintainability
related: [3202, 3102, 3131]
---

# #3358 — relocate the #3202 TypedArray.set bounds check into its own module

## Problem

`src/codegen/array-methods.ts` is an already-over-threshold god-file
(8,023 LOC at the time of writing — see `plan/log/compiler-consolidation-plan.md`
and the LOC-regrowth ratchet, #3102/#3131). PR #3202 (`TypedArray.prototype.set`
OOB throws a catchable RangeError instead of an uncatchable Wasm trap) needed to
add ~29 net LOC of bounds-check logic to `compileTypedArraySet` in that file,
which trips the ratchet: _any_ growth of a file already over the 1,500-LOC
threshold fails `pnpm run check:loc-budget` unless the change-set grants itself
a `loc-budget-allow:` frontmatter escape hatch (the gate's own message text:
"Add code to the subsystem module, not the barrel/driver" — the allowance is
documented as the fallback, not the preferred path).

#3202 landed via the allowance route (`loc-budget-allow: [src/codegen/array-methods.ts]`
in its own issue file), which is a legitimate, sanctioned way to unblock a PR —
but it permanently books the +29 LOC onto the god-file with no future pressure
to shrink it back out. The relocated design below was fully built and verified
against the #3202 branch before the PR's own author landed the allowance
version first (a live two-lane collision, not a defect in either approach);
capturing it here so the code-health delta isn't lost.

## Validated design (built + measured 2026-07-17, not merged)

Extract the bounds-check emission out of `compileTypedArraySet` into a new,
small, single-purpose module `src/codegen/typed-array-set-bounds.ts`:

```ts
export function emitTypedArraySetBoundsCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTypeIdx: number,
  dstVec: number,
  offsetTmp: number,
  srcLen: number,
): void {
  // allocLocal for dstLen, struct.get field 0 off dstVec, then emit
  // `offset < 0 || offset + srcLen > dstLen` -> buildThrowJsErrorInstrs(RangeError)
}
```

`compileTypedArraySet` (array-methods.ts) then adds exactly **one call site**
after `offsetTmp` is computed:

```ts
emitTypedArraySetBoundsCheck(ctx, fctx, vecTypeIdx, dstVec, offsetTmp, srcLen);
```

To land array-methods.ts at **net 0 LOC growth** (not just "smaller growth"),
the single import + call-site line pair was offset by combining two adjacent
pre-existing single-instruction `fctx.body.push({...})` calls elsewhere inside
`compileTypedArraySet` into their already-idiomatic multi-arg form (a pattern
already used elsewhere in the file), which prettier keeps on one line under
`printWidth: 120`:

- `fctx.body.push({ op: "struct.get", ... fieldIdx: 1 }); fctx.body.push({ op: "local.set", index: dstData });`
  → single-line combined call.
- Inside the element-wise-copy branch: `fctx.body.push({ op: "i32.const", value: 0 }); fctx.body.push({ op: "local.set", index: iTmp });`
  → single-line combined call.

Measured result: `array-methods.ts` 8023 → 8023 (net 0), `wc -l` verified, and
`pnpm run check:loc-budget` reported `OK — no unallowed growth`. Typecheck
clean, `npx biome lint` clean on both files, and `tests/issue-3202.test.ts`
(8/8) passed unmodified against this version — byte-for-byte the same runtime
behavior as the allowance version, since this is a pure code-motion refactor
(no test can distinguish the two; the difference is file-health, not behavior).

## Scope for whoever picks this up

1. Recreate `src/codegen/typed-array-set-bounds.ts` per the design above (or
   re-derive it fresh from current `array-methods.ts` — #3202 has since
   merged, so the merge base has moved; re-diff against current main rather
   than assuming the old #3202 branch state still applies).
2. Confirm `git log origin/main --grep="#3202"` shows the allowance-route
   fix already merged — this issue is a **pure follow-up refactor** on top of
   that landed state, not a re-implementation of the bounds check itself.
3. Remove the `loc-budget-allow: [src/codegen/array-methods.ts]` grant from
   #3202's issue file frontmatter once array-methods.ts net-shrinks back to
   (or below) its pre-#3202 size — the LOC-regrowth ratchet banks shrinkage
   automatically (#3102/#3131), so this closes the loop the allowance opened.
4. Verify `pnpm run check:loc-budget`, typecheck, lint, and
   `tests/issue-3202.test.ts` all stay green.

## Why this is `Backlog`/`low`/`s`, not current-sprint

Purely a code-health nit — no user-visible behavior changes, no test can
distinguish before/after, and #3202's own functional fix is already merged
and green via the sanctioned allowance path. Cheap to pick up opportunistically
whenever `array-methods.ts` is next being touched anyway.

## Resolution (2026-07-17)

Shipped. The bounds-check emission was extracted from `compileTypedArraySet`
(`src/codegen/array-methods.ts`) into a new single-purpose module
`src/codegen/typed-array-set-bounds.ts` exporting
`emitTypedArraySetBoundsCheck(ctx, fctx, offsetTmp, srcLen, dstLen)`.
`compileTypedArraySet` now emits the check via one call site. The three operands
(`offsetTmp`/`srcLen`/`dstLen`) are the pre-existing locals, so the emitted
instruction sequence is unchanged.

- `array-methods.ts`: 8234 → 8216 LOC (−18); `check:loc-budget` OK.
- The `loc-budget-allow: [src/codegen/array-methods.ts]` grant in #3202's
  frontmatter is retired (its +LOC was exactly this bounds check).
- Proof: `scripts/prove-emit-identity.mjs check` → IDENTICAL across all 56
  (file,target) emits; `tsc --noEmit` clean; `tests/issue-3202.test.ts` 8/8
  pass unmodified (pure code motion, byte-identical runtime behavior).
