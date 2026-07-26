---
id: 1769
title: "generalize nullable primitive union lowering and narrowing"
status: done
created: 2026-06-01
updated: 2026-07-26
completed: 2026-06-02
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: type-system
language_feature: type-narrowing
goal: platform
sprint: 58
es_edition: n/a
related: [389, 1765]
origin: "Follow-up to narrow #1765 nullable number typed-array byte-write fix"
---

# #1769 - generalize nullable primitive union lowering and narrowing

## Problem

The narrow #1765 fix intentionally targets one guest271314 GitHub #389 shape:
`number | null` locals used as append-byte sentinels, guarded by a direct or
const-aliased `!== null` check before a `Uint8Array` byte assignment.

That patch is useful but deliberately local. It should not become a pile of
one-off special cases for every nullable primitive position. The compiler needs
a coherent representation and narrowing rule for nullable primitive unions so
ordinary TypeScript control-flow works across reads, writes, calls, returns,
and aliasing.

## Narrow slice already covered by #1765

```ts
let append: number | null = null;
const hasAppend = append !== null;
if (hasAppend) {
  output[cursor] = append;
}
```

#1765 covers this shape by preserving the nullable local sentinel and proving
the RHS non-null for a typed-array byte write. The generalized issue should
absorb that lesson without baking typed-array assignment into the core model.

## Generalization targets

- Represent nullable primitive locals without erasing the null/undefined
  sentinel (`number | null`, `number | undefined`, `boolean | null`, and mixed
  `T | null | undefined` forms).
- Propagate non-null facts through direct guards, boolean guard aliases,
  negated guards, early returns/continues/breaks, loop bodies, and nested
  control-flow.
- Reuse the same proof for expression contexts beyond byte assignment:
  arithmetic, comparisons, function arguments, returns, object/array writes,
  and local reassignments.
- Preserve diagnostic integrity: downgrade TypeScript assignability diagnostics
  only when the compiler has an explicit non-null proof for the concrete use.
- Avoid forcing every primitive into boxed storage. Compile away nullable
  representation when TypeScript proves the value is never observed as
  nullable, and only use a sentinel-preserving representation for live nullable
  values.

## Design constraints

- Keep the core rule representation-driven: codegen should ask whether a value
  is proven non-null in the current flow environment, not whether it is being
  assigned to a specific builtin container.
- Cover locals first; parameters, closure/ref-cell captures, fields, and array
  elements can be staged if the issue needs subtasks.
- Do not invent a broad dynamic tagged-union runtime if the same behavior can
  be compiled away from TypeScript control-flow facts.
- Treat #1765 as a regression seed, not as the full architecture.

## Acceptance

- A test matrix documents nullable primitive behavior for direct guards,
  aliases, negation, early exits, and loop-carried updates.
- `number | null` and `number | undefined` values preserve their sentinel until
  a non-null proof exists, then unbox/coerce correctly in non-null branches.
- Non-null proofs work for at least typed-array writes, arithmetic, function
  calls, and returns.
- Negative tests show unguarded nullable primitive use still reports a useful
  diagnostic or lowers through an intentional nullable representation rather
  than silently erasing the sentinel.
- The #1765 minimal repro remains covered by the generalized mechanism.

## Notes

This is deliberately larger than the #389 production blocker. It is a follow-up
architecture issue to prevent nullable primitive support from accreting as
site-specific patches.

## Implementation Summary

### What was done

- Generalized nullable primitive detection from the #1765 `number | null`
  special case to homogeneous nullable primitive unions (`number`, `boolean`,
  `string`, `bigint` with `null` and/or `undefined` sentinels).
- Updated local/module-global preallocation so nullable primitive locals keep an
  `externref` sentinel-preserving representation instead of erasing to `f64` or
  `i32`.
- Generalized non-null guard facts for direct guards and const boolean aliases,
  including negated aliases and strict-vs-loose nullish comparisons.
- Added precise nullish proof tracking so `T | null | undefined` only gets a
  non-null proof from guards that exclude all nullish constituents (`!= null`,
  or equivalent TypeScript control-flow), while partial strict checks remain
  diagnostically hard.
- Reworked nullable primitive identifier reads so proven non-null values unbox by
  primitive kind across expression contexts, not just typed-array byte writes.
- Generalized the diagnostic downgrade path to guarded nullable primitive uses
  only when the non-null primitive type is assignable to the concrete target.
- Extended the focused issue matrix to cover string and bigint nullable
  primitive sentinels in addition to number/boolean/nullish-flow cases.

### What worked

- The existing `externref` boxed union path was enough for preserving nullable
  primitive sentinels; no tagged-union runtime was needed.
- TypeScript's own control-flow facts still handle early-return and
  early-continue narrowing once storage preserves the sentinel.

### Files changed

- `src/checker/type-mapper.ts`
- `src/compiler.ts`
- `src/codegen/context/types.ts`
- `src/codegen/expressions.ts`
- `src/codegen/expressions/identifiers.ts`
- `src/codegen/index.ts`
- `src/codegen/statements/control-flow.ts`
- `src/codegen/statements/shared.ts`
- `src/codegen/statements/variables.ts`
- `tests/issue-1769.test.ts`
- `plan/issues/1769-generalize-nullable-primitive-unions.md`
- `plan/issues/backlog/backlog.md`
- `plan/issues/sprints/58.md`
- `plan/log/issues-log.md`

### Tests

- `npm test -- tests/issue-1769.test.ts`
- `npm test -- tests/issue-1765.test.ts`
- `npm test -- tests/equivalence/null-narrowing.test.ts`
- `npm test -- tests/union-narrowing.test.ts`
- `pnpm exec tsc --noEmit --pretty false`

`npm test -- tests/null-narrowing.test.ts tests/union-narrowing.test.ts` was also
tried, but `tests/null-narrowing.test.ts` imports a missing `./helpers.js` in
this workspace; the equivalent runnable coverage is
`tests/equivalence/null-narrowing.test.ts`.

### Final verification

Codex reviewed the dirty branch state on 2026-06-02 and reran the scoped
validation above, including the 7-case #1769 issue suite, adjacent
#1765/null-narrowing/union-narrowing regression files, and `tsc --noEmit`. All
commands passed; no additional code changes were needed after review.

## Follow-up completion 2026-07-26 — function return carriers

The full compiled-Acorn/Test262 differential (#1712/#3666) found one missed
position from the original generalized acceptance: `resolveWasmType` still
collapsed a nullable primitive **function return** to its inner scalar even
though local/global allocation preserved the externref sentinel.

Acorn's untyped `readInt`/`readHexChar` return `number | null`. A failed read
returned `null` inside the callee, but its Wasm signature was `f64`, so the
boundary turned the sentinel into numeric zero before the caller's
`value == null` test. That made invalid radix and character escapes parse as
valid input.

Nullable primitive unions now resolve to the same externref carrier at general
type/signature boundaries as at local allocation. A JS-inference regression in
`tests/issue-1769.test.ts` checks both the null and numeric return arms. The real
pinned Acorn gate confirms invalid template, radix, and string escapes now
produce the same syntax rejections as node-acorn.
