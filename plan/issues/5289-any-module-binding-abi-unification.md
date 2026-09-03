---
id: 5289
title: "R4's largest slice is blocked on one ABI question: `$AnyValue` in fast mode vs `externref` in compatibility"
status: ready
created: 2026-09-03
updated: 2026-09-03
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3523, 3518, 5285, 4208]
---

## Problem

The #5285 survey (PR #5515) settled R4's slice order with a real instrument for
the first time. The answer is unambiguous:

| category | refused decls | files touched | files it actually **unlocks** |
| --- | --: | --: | --: |
| **`any`** | **27 of 57** | **9 of 15** | **4** |
| `function` | 9 | 2 | 2 |
| `ambient/import` | 6 | 2 | 0 — both also refuse on `vardecl-modifier` |
| everything else | ≤3 each | ≤1 each | 0 |
| `string` | 0 | 0 | 0 — R4-M1 landed it |

**`any` is the slice**, by every measure, on both lanes. And it is the one R4
cannot start, for a reason that is not a missing predicate.

### It is not a missing value kind

`IrModuleBindingValueKind` **already has** `{ kind: "dynamic" }`
(`src/ir/module-binding-value-kinds.ts:15`). Exactly one arm ever produces it —
`src/ir/module-bindings.ts:2011-2013`:

```ts
let valueKind =
  options.numberStorage === "f64" && updateRetypesModuleBinding(checker, declaration)
    ? ({ kind: "dynamic" } as const)
    : scalarKind(declaredType, options);
```

a binding whose `++`/`--` retypes it, and nothing else. The comment directly
above states the blocker in the code's own words:

> #4208 S2 — … Fast mode has a `$AnyValue` dynamic carrier while compatibility
> allocation currently widens these globals to externref, so it stays on direct
> codegen **until that ABI is unified**.

### Why this is not shaped like R4-M1

R4-M1 (string, PR #5511) worked because a backend-agnostic marker already
existed and the two backends disagreed *cleanly*: `IrType.string` defers to
`IrLowerResolver.resolveString`, so one new kind could name the **active**
backend's carrier and let the existing storage-agreement check arbitrate.
Measured: `(mut externref)` on the host lane, `(mut (ref null $AnyString))` on
`nativeStrings` — two spellings of one source fact.

**Dynamic has no such deferral.** Fast mode carries `(ref null $AnyValue)` with
`__any_box_*` (`src/ir/builder.ts:458`); compatibility widens to `externref`.
Those are not two spellings of one fact — they are different carriers with
different boxing, and the resolver cannot name "the active one" because the two
lanes disagree about what the value *is*, not merely how it is spelled.

That is why this is a **separate issue at `horizon: l`, not an R4 storage
slice**. A lane briefed to "add an `any` arm" will reach the same comment and
either stall or, worse, resolve a slot it cannot honour — which
`resolveModuleBindingGlobal`'s storage-agreement check would then report as a
hard `IrInvariantError` rather than a demote.

## Acceptance criteria

1. A module binding whose declared type is `any` resolves to a single value
   kind that both lanes can honour — or the issue concludes, with measurements,
   that they cannot be unified and records what the alternative is.
2. **Byte neutrality with the arm inactive.** Every playground + dogfood file,
   both lanes, sha256-identical to the base tree before any `any` binding is
   admitted. R4-M1's 66/66 is the precedent and the bar.
3. The storage-agreement check in `resolveModuleBindingGlobal` stays a **real**
   test: a lane whose slot disagrees must fail loudly, never be reinterpreted.
   Widening the check to accept both carriers is the failure mode to avoid.
4. Re-run the #5285 survey and show the four predicted files
   (`members-calls.js`, `objects.js`, `optional-nullish.js`, `sequence-misc.js`)
   losing their storage refusals. **Losing the refusal is necessary, not
   sufficient** — check whether each then reaches `emitted` or lands on an
   independent non-storage blocker, and report which.
5. A test that fails if the two carriers are ever silently unified, mirroring
   R4-M1's assertion that the host and native string carriers **differ**.

## Implementation Plan

**Answer the ABI question before writing any resolver code.** The first
deliverable is a measurement, not a patch:

1. **Establish what each lane actually allocates today** for an `any` module
   global that is read from a function — compile it and read the
   `(global $__mod_… )` line out of the emitted WAT on both lanes, exactly as
   R4-M1 did for strings. Do not infer this from `#4208`'s comment; that comment
   is the hypothesis, not the measurement, and it predates R4-M1.
2. **Decide which of three shapes applies**, and say which in the issue before
   implementing:
   - *deferrable* — the carriers differ only in spelling and an
     `IrLowerResolver`-style hook can name the active one (the R4-M1 shape);
   - *unifiable* — one lane can adopt the other's carrier at acceptable cost,
     which is a Program-ABI change and needs its own byte-neutrality argument;
   - *irreducible* — they genuinely differ, and the honest outcome is a design
     record plus a narrower slice (e.g. `any` bindings that are never written,
     where the carrier question may not arise).
3. Only then touch `scalarKind` / the admission arm.

**Do not widen `isIrModuleReferenceValueKind` reflexively.** R4-M1's note on the
`string` arm applies here with more force: a dynamic carrier is reference-shaped
on both lanes, so it belongs in the conservative extern discipline, and a site
that later earns a proven dynamic lowering should test the kind at that site.

**Sizing.** `horizon: l`, `feasibility: hard`, `reasoning_effort: max` — the
work is an ABI decision with a Program-ABI invariant behind it, and the
implementation is small once the decision is made. The risk is starting at step
3.

## Notes

Two things this issue exists to prevent, both nearly happened on 2026-09-03:

- **Dispatching `any` as an R4 storage slice.** The ranking says it is the
  biggest win, and the ranking is right; the sizing is what is wrong. The check
  that catches it is two greps — *does the target kind already exist, and what
  does its admission arm's comment say* — and it separates a slice from a
  stalled lane.
- **Ranking by "storage cleared" instead of "unlocked".** #5285's table
  distinguishes them, and `ambient/import` is the proof: it clears two files'
  storage and unlocks zero, because both also refuse on `vardecl-modifier`.
  Any future R4 ranking must carry that second column.
