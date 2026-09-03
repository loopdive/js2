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
