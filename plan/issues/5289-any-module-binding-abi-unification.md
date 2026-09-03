---
id: 5289
title: "R4's largest slice is blocked on one ABI question: `$AnyValue` in fast mode vs `externref` in compatibility"
status: done
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
# 2026-09-03 (#5289) — the admission arm plus the rationale that keeps it
# honest. `module-bindings.ts` +45: the `isModuleDynamicStorageType` predicate
# (3 lines of code) and the admission arm (3 lines of code); the remainder is
# the comment recording WHICH function on each side of the boundary picks the
# carrier, because the measured trap this issue documents is that the axis is
# `fast`, not `target`, and a reader who re-derives it gets the wrong answer.
# `integration.ts` +14: comment only — the `dynamic` arm's code is unchanged,
# and the added text is the four-cell measurement that makes the neighbouring
# storage-agreement check legible as a real test rather than a restatement.
loc-budget-allow:
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
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

1. ~~**Establish what each lane actually allocates today**~~ — **DONE, see the
   measurement section below.** Read it before anything else; it changes what
   step 2 is choosing between, and it contains a trap worth not repeating.
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


## 2026-09-03 — step 1 measured, and the blocker is REAL

Run before dispatch so the lane does not repeat it. `let g: any = 1` read from
an exported function; the `(global $__mod_g …)` line out of the emitted WAT.
Probe: `.tmp/any-fast-probe.mts`.

| target | mode | carrier |
| --- | --- | --- |
| `gc` | compatibility | `(mut externref)` |
| `gc` | **fast** | `(mut (ref null 34))` |
| `standalone` | compatibility | `(mut externref)` |
| `standalone` | **fast** | `(mut (ref null 45))` |

**The split is on the fast/compatibility axis, exactly as `#4208`'s comment
says — not on target.** Both targets agree with each other in each mode. So the
comment is current, not stale, and the blocker this issue describes is real.

### The trap, recorded because I walked into it

My first probe compiled `target: "gc"` and `target: "standalone"` with default
options, saw `(mut externref)` twice, and pointed at the conclusion *"the two
lanes agree, the ABI blocker is stale"* — which would have unblocked R4's
largest slice on a false premise. It was wrong because **`fast` is a separate
flag from `target`**: `integration.ts:2301` sets
`numberStorage: ctx.fast ? "i32" : "f64"`, and `#4208`'s "fast mode" means that
flag, not a target. Default options are the *compatibility* side of both
targets — two cells of the four, both from the same side of the split being
measured.

**So the step-1 instruction as originally written was itself the trap** ("read
what each lane allocates … on both lanes"). It is four cells, not two:
`{gc, standalone} × {compatibility, fast}`. Any future measurement of a carrier
question in this area must name which axis it varied, because "both lanes" is
ambiguous between the two and the ambiguity resolves toward the wrong answer.

### What this settles for step 2

**Not `deferrable`.** The R4-M1 shape needs two spellings of one fact that a
resolver can choose between by naming the active one. These are not that:
`externref` is opaque and host-shaped, the fast carrier is a typed struct ref,
and a resolver serving both cannot name "the active carrier" without the
storage-agreement check losing its meaning — which is criterion 3.

The live question is therefore **`unifiable` vs `irreducible`**, and that is the
issue's real work. Two sub-questions a lane should answer first, in this order:

1. **What is the fast carrier?** The type indices differ per target (34 vs 45),
   which is ordinary per-module numbering, but whether both resolve to the same
   *named* type (`$AnyValue`) is unverified — read the type section, do not
   assume from the index.
2. **Can compatibility adopt it, or fast adopt `externref`?** Either direction
   is a Program-ABI change needing its own byte-neutrality argument, and the
   answer decides whether this is a slice or a design record.


## Sub-question 1 attempted and NOT answered — plus the instrument that lied twice

I tried to settle "is the fast carrier `$AnyValue` on both targets" and **could
not**. Recording the failure because the instrument's failure mode is the point.

The probe walked `(type …)` forms in the emitted WAT with a regex and indexed
them positionally. For `standalone` it reported the global's carrier as
`(func (param externref) (result i64))` — **a function type, which cannot be a
global's carrier.** Positional counting does not map to wasm type indices;
`rec` groups shift the numbering. The result was not an error, it was a
confident wrong type.

What survives from that run, because it needs no indexing:

- `$AnyValue` is **named somewhere** in both fast-mode modules.
- That is NOT evidence the module global's carrier *is* `$AnyValue`.

So sub-question 1 stands open, and this issue's own instruction — *"read the
type section, do not assume from the index"* — is exactly what the probe
violated. Answering it needs rec-group-aware parsing or a real wasm type-index
read, not a regex.

### The pattern, since it happened twice within the hour

| # | instrument | plausible wrong answer it gave | what caught it |
| --- | --- | --- | --- |
| 1 | vary `target`, default options | "both lanes agree at `externref`, blocker is stale" | checking what `fast` actually means (`ctx.fast`, not target) |
| 2 | positional `(type …)` walk | a `func` type as a global's carrier | a func type in a global slot is impossible on its face |

Both returned **real values from the wrong space** rather than failing. Neither
announced a problem. The first would have unblocked R4's largest slice on a
false premise; the second would have put a fabricated type name into this
issue's decisive question.

**The rule this yields, for anyone measuring carriers here:** a measurement of
this kind needs a *falsifiable sanity check built into the probe* — something
the wrong answer cannot satisfy. "Is the result even the right KIND of thing"
would have caught #2 automatically (a global's carrier is never a `func`), and
"which axis did I vary, and is it the axis the claim is about" would have
caught #1. Neither costs anything; both were skipped because the output looked
like data.


## Sub-question 1 ANSWERED — from the source, not a probe

`src/codegen/index.ts`, inside `resolveWasmType`:

```ts
// any/unknown -> ref_null $AnyValue (boxed any) when available.
if (ctx.fast && tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
  ensureAnyValueType(ctx);
```

- **The fast carrier for `any` IS `$AnyValue`, on both targets.**
  `ensureAnyValueType(ctx)` is one per-module allocator, so the differing WAT
  indices (34 gc / 45 standalone) are per-module numbering, nothing more.
- **The branch is gated on `ctx.fast` alone — no target term.** That confirms
  the four-cell measurement from an unrelated direction: same axis, same
  conclusion, two methods that share no machinery.
- Compatibility falls through to `externref`.

**Why this reading is trustworthy where the probe was not**, which is the part
worth carrying forward: it is a *single conditional naming both the flag and
the type*, not a value recovered through an index space I had to reconstruct.
The failure mode that produced two wrong answers earlier — a real value from
the wrong space — has no room to occur in a direct read of the deciding
branch. **Prefer the deciding line of source over an artifact of the output
whenever the question is "what does the compiler decide".** The artifact is
downstream of exactly the reconstruction that can go wrong.

### What it narrows for step 2

The two carriers are `(ref null $AnyValue)` versus `externref` — they differ by
**the presence of a tagged box, not by spelling**. That is `unifiable`-shaped,
not `irreducible`: compatibility adopting `$AnyValue` is a real option, since
the type already exists and `src/codegen/any-helpers.ts` carries the full
box/unbox surface (`ensureAnyValueType` has 6+ call sites there).

**Still the lane's decision, and still not free.** Either direction is a
Program-ABI change and owes its own byte-neutrality argument under criterion 2.
But the space is now one plausible direction plus its cost, rather than three
open options — and `irreducible` should not be adopted without arguing against
this specific finding.


## 2026-09-03 — ANSWERED: the shape is `deferrable`, and the deferral already existed

**Step 2's answer is `deferrable` — the R4-M1 shape after all.** The issue's own
step-2 note above ("Not `deferrable`") is the one thing here that was wrong, and
it is worth saying plainly because the reasoning was almost right.

`src/codegen/any-helpers.ts` already carries the deferral hook, in five lines:

```ts
export function resolveIrDynamicCarrierType(ctx: CodegenContext): ValType {
  if (!ctx.fast) return { kind: "externref" };
  ensureAnyValueType(ctx);
  return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
}
```

and `resolveModuleBindingGlobal`'s `dynamic` arm was **already calling it**. So
the carrier question was never open: `resolveWasmType`'s `Any | Unknown` branch
(which allocates the legacy `__mod_*` slot) and `resolveIrDynamicCarrierType`
(which resolves the IR one) are the same function of the same flag, written
twice on opposite sides of the boundary.

**Measured, all four cells** (2026-09-03, this branch, printed from inside
`resolveModuleBindingGlobal` on the real `GlobalDef` object — no WAT parsing, no
index reconstruction, so the failure mode that produced two wrong answers
earlier in this issue has no room to occur):

| cell | legacy allocated | IR resolved | agree |
| --- | --- | --- | :-: |
| gc/compat | `externref` | `externref` | ✅ |
| gc/fast | `ref_null 34` | `ref_null 34` | ✅ |
| standalone/compat | `externref` | `externref` | ✅ |
| standalone/fast | `ref_null 45` | `ref_null 45` | ✅ |

Same *index*, not merely the same kind. The four-cell `(global $__mod_a …)`
table from the section above reproduces exactly on this branch, which is the
independent cross-check.

### Where the argument above went wrong, since the reasoning generalises

The step-2 note rejected `deferrable` on the grounds that "a resolver serving
both cannot name the active carrier without the storage-agreement check losing
its meaning". That inference does not hold, and the `string` arm is the standing
counter-example: naming the ACTIVE lane's carrier is what makes the check
meaningful, because the other side of the comparison is not a restatement — it
is `global.type`, read off the object legacy actually allocated. The check loses
its meaning only if it is widened to accept BOTH carriers, which is criterion 3
and which this change does not do.

The deeper miss: the step-2 note reasoned about the carriers from their
*descriptions* ("`externref` is opaque and host-shaped, the fast carrier is a
typed struct ref") rather than from the two functions that choose them. Both
descriptions are true and the conclusion drawn from them is false — the
carriers differ exactly as much as the two string carriers do, and by the same
mechanism. **A carrier question is settled by the code that picks the carrier,
not by how different the two carriers look.** That is the same rule this issue
already recorded one section earlier ("prefer the deciding line of source over
an artifact of the output"), applied one level up: to the *reasoning about* the
carriers, not just to measuring them.

### What was actually blocking compatibility — it is not the ABI

With the arm in, the compatibility lane clears storage and demotes with a
DIFFERENT, nameable code (measured, `JS2WASM_IR_SHAPE_DIAG=1`):

```
implicit-support-reference-unavailable:
  IR dynamic carrier resolves backend type/helper support
  without a symbolic Program ABI ref
```

So compatibility's residual blocker is a **Program-ABI symbolization gap on the
externref dynamic support surface** (`__box_number` / `__unbox_number` are
resolved implicitly, not through a symbolic ref) — downstream of storage, and a
separate slice. The fast lane, whose `$AnyValue` + `__any_box_*` surface IS
symbolically planned, needs nothing further: it reaches `emitted`.

**This is the thing the original framing got backwards.** "The two lanes
disagree about what the value is" named an ABI split that measurement does not
support; the real gap is that one lane's support surface is not yet symbolic.
Ranking R4 work on the old framing would have sized an ABI unification that was
not needed and missed a symbolization slice that is.

## What landed

`any`/`unknown` `let`/`const` module bindings resolve to `{ kind: "dynamic" }`.
Three files: the predicate + admission arm (`src/ir/module-bindings.ts`), the
`dynamic` arm's rationale (`src/ir/integration.ts`), the kind's documentation
(`src/ir/module-binding-value-kinds.ts`). Module `var` is excluded by
construction, on the same measured grounds as R4-M1's string arm.

`isIrModuleReferenceValueKind` was **not** widened, per the plan. The hazard it
guards — a scalar arm claiming an unproven shape — is already stopped for
`dynamic` at the site that matters: `moduleScalarExpressionFamily`
(`src/ir/select.ts`) returns `undefined` for a dynamic binding instead of
resurrecting the initializer's static family. That is the "test the kind at the
site" discipline the plan asks for, already applied.

### Criterion 4 — re-run survey (measured, this branch vs its merge base)

Dogfood corpus, 20 files x 4 cells. `any`-typed `no-value-kind` refusals:
**28 → 0 in every cell.** Seven files lose ALL storage refusals in the
compatibility lanes — three more than the four predicted:

| file | loses all storage refusals | then lands on (measured) |
| --- | :-: | --- |
| `members-calls.js` | all 4 cells | `body-shape-rejected` |
| `objects.js` | all 4 cells | `body-shape-rejected` |
| `optional-nullish.js` | all 4 cells | `body-shape-rejected` |
| `new-target.js` | all 4 cells | `body-shape-rejected` |
| `templates.js` | all 4 cells | `template-substitution-unsupported` |
| `sequence-misc.js` | compat only | `body-shape-rejected` (fast keeps `comma`, a literal-typed `const`) |
| `operators.js` | compat only | `operand-coercion-unsupported` |

**Losing the refusal was necessary and NOT sufficient for any dogfood file** —
criterion 4's second half, answered explicitly: none reaches `emitted`; each
lands on an independent non-storage blocker, named above. The win is real but
it is measured on the storage axis, not yet on emitted units in this corpus.

Where the whole file's blocker IS the `any` binding, the fast lane does reach
`emitted` — measured on six focused fixtures (`any`/`unknown`, `let`/`const`,
initialized and reassigned): `irBodyEmitted false → true` in `gc/fast` and
`standalone/fast`, `late-preparation-unsupported` in both compatibility lanes.

### Criterion 2 — byte neutrality with the arm inactive

Per-row sha256, every cohort compiled in all four cells on this branch and on
its merge base, compared row by row:

| cohort | rows | identical | moved |
| --- | --: | --: | --: |
| dogfood corpus (20 files x 4 cells) | 80 | **80** | 0 |
| playground examples (13 files x 4 cells) | 52 | **52** | 0 |
| focused controls `no_any` / `var_any` | 8 | **8** | 0 |

**132/132 reachable rows plus 8/8 controls, zero movement.** The one playground
row that fails to compile (`dom/calendar.ts` in `standalone/fast`: "standalone
DOM callback dispatcher was not reserved before component sealing") fails
IDENTICALLY on the merge base — pre-existing, not touched here.

Every `any` fixture moves, which is the intended flip; values re-checked and
unchanged where runnable (`1`, `2`, `42`, `2`).

One honest cost, measured: in the COMPATIBILITY lane a module that admits an
`any` binding now moves bytes without gaining an emitted unit — preparation
proceeds further, then demotes on the symbolization gap above. In `gc/compat`
the binary is the **same length** (295→295, 244→244, 268→268, 421→421 across
four fixtures) with type-section indices renumbered and the printed code
identical; `standalone/compat` shows small deltas (0 to +14 bytes). The modules
validate, instantiate and return identical values. This is a deliberate choice,
and the alternative was considered: gating the arm to fast mode would remove the
churn, but it would make the census report 28 `any` STORAGE refusals in the
compatibility lane that are not storage refusals — corrupting the exact
instrument R4 ranks on, and disguising a shape/symbolization gap as a storage
gap, which is the failure mode #5285 exists to prevent. One line reverses it if
a reviewer disagrees.

### Criterion 5 — the anti-unification test

`tests/issue-5289-any-module-binding-abi.test.ts` asserts the two carriers stay
DISTINCT (`(mut externref)` vs `(mut (ref null N))`, and `not.toBe` between
them), mirroring R4-M1's assertion that the two string carriers differ, plus a
four-cell control that both targets make the same choice in each mode — so a
future two-cell measurement cannot re-walk the `target`-vs-`fast` trap.

**Non-vacuity (demonstrated):** the file is 27/27 green on this branch and
**6 failing on the base tree** (`AssertionError: expected [ 'a' ] to not include
'a'` — the storage refusal this slice removes).

### Suite results

- **Equivalence, 8 shards by name** (`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`): all
  eight exit 0, "No new equivalence regressions". 1,718 passing; 24 failing,
  which is exactly the 24 known-failure entries in
  `scripts/equivalence-baseline.json` — **zero name-set diff**.
- **`tests/issue-4520-abi-carrier-differential.test.ts`: 9 of 44 fail, and they
  fail IDENTICALLY on the merge base** — same nine test names, same 9-failed /
  35-passed split (`destructured-param`, `nested-array-param`,
  `unannotated-return`, `object-literal-type-param` in both `standalone` and
  `wasi`, plus the `IrType`-family row-table check). Pre-existing, proven by
  running the gate on both trees; none concerns module bindings. Not introduced
  here and not fixed here.
- `check:ir-dialect`, `check:ir-fallbacks`, `check:linear-ir`: OK.
- LOC / func / coercion / oracle-ratchet / dead-exports: OK, including the CI
  base simulation (`LOC_GATE_BASE=origin/main`).

## Follow-up this issue names but does not do

Symbolize the compatibility dynamic support surface (`__box_number` /
`__unbox_number` and the externref dynamic carrier) as Program-ABI refs, so the
compatibility lane's `<module-init>` can complete preparation. That is the whole
remaining distance between "storage clear in both lanes" and "emitted in both
lanes", and it is the slice the old ABI-unification framing hid.
