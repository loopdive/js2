---
id: 5320
title: A mutable capture's ref cell minted inside a conditional arm silently drops writes and reads null on every other path
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# The mechanism is a ~6-line stack-neutral repair inserted at each site whose
# null guard it completes; those sites live inside these already-oversized
# files, and moving the CALLS out would not move the lines. The repair itself
# is a NEW module (closures/conditional-capture-box.ts), not more god-file.
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/unary-updates.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/unary-updates.ts::compilePrefixUpdate
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
---

## Problem

Boxing a mutable closure capture is **two events emitted in two different
places**:

- the `struct.new` that FILLS the ref cell goes to the **closure's construction
  site**, and
- `fctx.localMap.set(name, boxLocal)` re-aims the **name for the whole rest of
  the function**.

When the construction site sits in one arm of an `if` (or any block a path can
skip) the two stop agreeing: every later read/write of that name addresses a
cell the skipping path never created. The access sites do null-guard the cell —
but they read the guard as *"the value is absent"*, so a **write silently
no-ops** and a **read yields the value type's default** (`null` / `NaN`).

Minimal repro (untyped `.js`; a `: any` annotation routes to a different arm and
hides it):

```js
function f(c) { let r; if (c) { const g = () => { r = 2; }; g(); } else { r = 7; } return r; }
f(false)   // native 7, wasm null
```

The emitted WAT names the defect exactly. `struct.new $cell / local.tee 5`
appears **only inside the then-arm**, and the else-arm's `r = 7` compiles to

```wat
local.get 5
ref.is_null
(if (then                                   ;; cell missing → write DROPPED
   ) (else local.get 5 local.get 11 struct.set 7 0))
```

with the return reading `(if (result externref) (then ref.null extern) …)`.

It is a **silent-wrongness** class, not a trap: nothing fails, the answer is
just wrong. Measured cost on the npm dogfood corpus: **9 axios tests and 7
marked tests** (see Evidence).

### Not "cell allocation placement", and not fixed by an initializer

An earlier diagnosis pinned this on where the cell is allocated and claimed a
`= 0` initializer rescues it. Both are false:

| variant | before |
| --- | --- |
| `let r;` closure arm FIRST | `null` (native `7`) |
| `let r = 0;` closure arm SECOND | `NaN` (native `7`) |
| object-valued, closure arm SECOND, any of `= null` / `= 0` / `= {k:0}` | `null` |
| f64, closure arm SECOND | `NaN` (native `7`) |

The one shape that already worked (`let r = 0` with the closure arm first) works
only because `canBoxBindingInDominatingParent` (closures/arrow-phases.ts) fires
there and hoists an unconditional `local.get / struct.new / local.set` ahead of
the `if`. **Arm order and value type are not the invariant.**

## Root cause

`canBoxBindingInDominatingParent` establishes dominance by MOVING the
`struct.new` to a point that dominates the region. It can only do that when it
can prove two things:

1. the binding already holds its correct value at the hoist point, and
2. no already-emitted code in the region writes the raw slot behind the cell's
   back.

Proof 1 fails for an uninitialized `let` (there is no initializer to point at).
Proof 2 fails whenever a **sibling arm assigns before the closure-bearing arm**
— those writes were already emitted against the raw slot, so hoisting the box
ahead of the `if` would make them invisible. So the mechanism correctly declines
both of the shapes above, and widening its allow-list cannot cover them: they
are exactly the cases where its proof obligations are unmeetable.

## Fix — the general invariant

A **null cell does not mean the value is absent**. It means the cell was never
minted, so the binding's storage is still the **orphaned pre-box slot** the cell
would have been minted from. Stated as one rule:

> the cell, once minted, is the binding's storage; until then the pre-box slot
> is, and the cell is seeded from that slot on first use.

`src/codegen/closures/conditional-capture-box.ts` implements exactly that:
`emitConditionalCaptureBoxRepair` emits a stack-neutral
`if (box == null) box = struct.new(preBoxSlot)` immediately before the frame's
own null-guarded `struct.get` / `struct.set`. `FunctionContext.boxedCaptures`
gained `rawLocalIdx` to carry the pre-box slot, recorded **only** at the
construction sites that mint a NULLABLE cell from a raw slot in this same frame.

Why this is general rather than another special case:

- **No dominance proof is required.** Writes emitted before the cell existed
  went to the pre-box slot, which is precisely what the repair reads back. That
  disposes of proof obligation 2, which is what blocked the arm-swapped shapes.
- **No initializer is required.** The pre-box slot holds whatever the binding
  holds, initializer or not. That disposes of obligation 1.
- **Value type is irrelevant** — the cell's field type IS the pre-box slot's
  type by construction, so f64 / externref / GC-ref captures are one code path.
- **Multiple construction sites converge on one cell**, because the repair
  `local.set`s the same box local that a later site would reuse.

The eager-dominating box stays: when it CAN prove dominance it produces a
non-nullable `(ref $cell)` local and strictly better code, and the repair
declines those by type (`ref` vs `ref null`). The two mechanisms compose —
dominating materialisation where provable, lazy materialisation everywhere else.

This is also the value-cell twin of two repairs that already existed but only
covered closure-to-closure handoff, never the frame's own reads and writes:
`pushBoxedTdzFlagRef` (closures/capture-source-slot.ts) for the TDZ flag, and
`pushCaptureCell` (closures/arrow-phases.ts) for a sibling closure's capture
prepend. Both carry the same rationale in their comments — "that site does NOT
dominate its siblings".

### Sites touched

Recording (`rawLocalIdx`):

- `closures/arrow-phases.ts` `emitClosureConstruction` — native closure struct.
- `closures.ts` host-callback creation site — the `needsThis` /
  `deferredInvocation` rebind.

Repair (`emitConditionalCaptureBoxRepair`):

- `expressions/identifiers.ts` — boxed read.
- `expressions/assignment.ts` — `=`, the post-RHS re-resolve, and the
  destructuring/for-of write.
- `expressions/operator-assignment.ts` — compound assignment (both paths).
- `expressions/unary-updates.ts` — `++x`, `--x`, postfix.

### Deliberately NOT covered

- Sites that mint a **non-nullable** `(ref $cell)` box (`emitEagerCaptureBoxes`,
  the call-site capture prepend in `call-identifier.ts`, the inline-IIFE prepend
  in `calls.ts`). A non-nullable local cannot be observed unmaterialized, and
  the repair skips them by type.
- A raw-slot write **emitted before** the cell existed but **executed after** it
  on a later loop iteration. That is a distinct pre-existing hazard of late
  boxing inside a loop; the repair neither introduces nor worsens it (both
  before and after, such a write lands on the orphaned slot).
- `sharedRefCells` reuse across arms in the host-callback path pushes a sibling
  arm's cell local unguarded. Pre-existing, out of scope.

## Acceptance criteria

- `tests/issue-5320-conditional-arm-capture-box.test.ts` passes: the base
  repro, the arm-swapped variant, object/string/f64 variants, switch and
  try/catch arms, and controls that already worked.
- No npm dogfood suite regresses; axios and moment improve.

## Evidence

`tests/issue-5320-conditional-arm-capture-box.test.ts`, same file run both ways
at one HEAD: **16/23 → 23/23**. The 7 that flip are the shapes listed in the
table above plus the `switch` arm, the `+=`-through-a-string-capture arm, and
the two-frames-same-name case.

npm dogfood A/B at one HEAD (`upstream/main` @ `bfe0158e49`), 17 packages, one
suite at a time, compared per test file:

| package | before | after |
| --- | --- | --- |
| axios | 191/231 | **200/231** (`core/AxiosError.test.js` 15/28 → 24/28) |
| marked | 2/30 | **9/30** (`unit/Hooks.test.js` 2/30 → 9/30) |
| clsx · cookie · hono · jest · jsdom · lodash · moment · prettier · redux · styled-components · stylelint · tailwindcss · three · uuid · webpack | unchanged | unchanged |

No package regressed on any test file. Every suite printed the same structure on
both sides (same per-file line count, `admitted` headline present except for
`uuid`/`hono`, which have none and were scored per file).

The closure/capture/scope/equivalence slice of the vitest suite (97 files, 674
tests) has the **identical 19-test failure set** before and after.

### What this did NOT fix

moment stays at **4/10**. All six of its failures are one trap —
`RuntimeError: dereferencing a null pointer` inside `prepareConfig` — and they
are NOT this defect. `prepareConfig`'s frame declares the SAME ~30
`__boxed_<name>` cell locals **twice** (two allocation rounds interleaved with
body temporaries), so the binding has two cell slots and one of them is always
null: a cell-IDENTITY split, not an unmaterialized cell. The repair correctly
declines it — seeding slot B from the pre-box slot would hand back a stale value
instead of the value living in slot A. Worth its own issue; the lead is the
duplicate `allocLocal(fctx, "__boxed_" + name, …)` inside a heavily inlined
lifted frame (`__inl83_*` locals), most likely a `boxedCaptures` save/restore
boundary dropping the first entry.

Two further sites were implemented, measured to change nothing on this corpus,
and **deliberately reverted**: the two capture-forwarding prepends in
`expressions/call-identifier.ts`. They are the same defect class in its
*trapping* manifestation (`ref.as_non_null` on an unmaterialized cell), but
repairing there converts a trap into a possibly-wrong value, which deserves its
own issue and its own evidence rather than riding along unmeasured.

## Budget

New file `src/codegen/closures/conditional-capture-box.ts` (~75 lines, mostly
the rationale above) plus ~35 net lines across seven existing files, six of
which are already over their LOC ceiling — hence the `loc-budget-allow` /
`func-budget-allow` grants in this file's frontmatter.

The mechanism cannot be expressed smaller. The repair has to be emitted at each
access site because that is exactly where the null guard it completes already
lives; the only alternative — rewriting already-emitted raw-slot accesses in
sibling instruction buffers so the cell can be hoisted to a dominating point —
is strictly larger, needs a new cross-statement channel for pending arm buffers,
and would still not handle a loop's back edge.

