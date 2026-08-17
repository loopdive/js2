---
id: 4552
title: "Fable-lane architect review: the #3954 phase 2 dialect split was implemented by the Opus lane and has not been reviewed by its owning lane"
status: ready
sprint: current
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: s
feasibility: easy
model: fable
reasoning_effort: high
task_type: analysis
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3954
related: [1616, 2135, 2949, 3029, 3030, 3954, 4523, 4551]
# id 4552 was reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 in the same batch as 4551/4553, originally for a second-language
# proof that was dropped as duplicating #3954 phase 3. Reused here rather than
# allocating a fresh id, so the reservation does not become a permanent hole in
# the sequence. 4553 remains reserved and unused. Open-PR scan at file-creation
# time (GitHub MCP, gh CLI absent in this container): 4639, 4643, 4644 — none
# adds an issue file.
---

# #4552 — Fable-lane review of work the Opus lane did in Lane B's territory

## Why this exists

**`backend-agnostic-ir` is Lane B's goal** (`plan/method/lane-partition.md`:
Lane B = fable / porffor / symphony owns `backend-agnostic-ir`,
`ir-full-coverage`, the Porffor backend, `value-rep-substrate`, the standalone
gap). **#3954 phase 2 was nonetheless implemented by the Opus lane** on
2026-08-17, at the project lead's direction, in
[PR #4644](https://github.com/loopdive/js2wasm/pull/4644).

That was a deliberate cross-lane action, not an accident of routing, and it is
recorded here rather than left implicit. The lane partition exists because
duplicated and unreviewed work in shared territory has cost this project real
sessions (#3310/#3311/#3341/#3308 were re-implemented by both lanes on
2026-07-17). A cross-lane implementation that nobody from the owning lane ever
reads gets the cost without the check.

The reviewer this needs is the one who did **not** write it.

## What to review

PR #4644 on `claude/js-ir-generalization-9v7m8j`. All CI green,
`mergeable_state: clean`.

**This review is POST-MERGE, by project-lead decision (2026-08-17).** The PR was
held as a draft to gate on this review; the lead's call was to mark it ready
once it was a working checkpoint, which it is: the slice is self-contained,
behaviour-neutral by construction, and depends on neither #4551 nor phase 1.
Holding a green, finished checkpoint out of `main` to wait on a review costs
merge-conflict risk and blocks nothing else, so the review moves after the
merge rather than in front of it.

That changes the outcome options, not the questions. Everything below still
needs an owner's verdict — the difference is that "reject" now means a
follow-up or revert PR rather than closing an unmerged draft.

### 1. The boundary rule (the load-bearing decision)

`src/ir/dialect/js.ts` holds 23 ECMAScript instruction kinds; `src/ir/nodes.ts`
keeps the neutral core and remains the single core→dialect edge (it assembles
the `IrInstr` union and re-exports every dialect name).
`scripts/check-ir-dialect.mjs` enforces exactly two rules, and is in `quality`.

Questions worth an owner's judgement:

- Is **one dialect file** right, or should the dialect be split by family
  (`dyn`, `iter`, `gen`, `async`, `extern`) from the start? Splitting later is
  cheap; the import surface is what would churn.
- The union stays in `nodes.ts`. MLIR would put the op registry with the
  dialect. Is the union-in-core choice the one this codebase wants long-term,
  or a convenience that will need undoing?
- Should the gate also assert the **converse** — that no dialect declaration
  is referenced from core except through the union? R1/R2 as written do not.

### 2. The placements

The 23 moved: `dyn.*` (5), `iter.*` + `forof.iter` (6), `gen.*` (4),
`await`/`async.*` (3), `extern.*` incl. RegExp (5).

These were chosen as the **uncontested** set. If any one of them is arguably
neutral, say so — it is much cheaper to move now than after importers settle.
`extern.*` is the likeliest disagreement: it is arguably a *host*-boundary
concern rather than a language one, which is the same argument that kept
`coerce.to_externref` in core.

### 3. Sequencing — phase 2 before phase 1

#3954 orders the `TagDomain` seam (phase 1) before the dialect split (phase 2).
That order was **inverted** on a cost-of-delay argument: phase 2 is
O(instruction kinds), `IrInstr` arms went 51 → 78 in the three months to
2026-08-01, and `ir-full-coverage` is expected to add ~40 more, whereas phase
1's surface (58 `JsTag` references across 24 files) is not growing the same
way. See #4551 for the series.

The reviewer owns whether that inversion is right. A specific risk to weigh:
phase 1 may want `box`/`unbox`/`tag.test` placed differently than a
dialect-first world assumes, and those three are currently sitting in core.

### 4. Two corrections in the record

Both are places where the Opus lane's first reading was wrong and was
corrected; confirm the corrections rather than the originals.

- `IrInstr` has **78** arms and has not drifted. An earlier draft of #4551
  claimed 82 (it counted terminators and declaration kinds). #3954's original
  figure was right.
- `BackendEmitter` does **not** leak ECMAScript: 3 of 54 methods are JS-shaped
  (`emitPromise*`). An earlier claim of 12 was wrong —
  `emitToExternref`/`emitFromExternref` are host-boundary, `emitVecSetLength`
  is an ordinary length write, and the string primitives are parameterized by
  `IrStringEncoding`. #3954's "the backend half is the already-neutral half"
  holds.

## Outcome

One of:

- **Accept** → set this issue `done`. Nothing else to do; the code is already
  on `main`.
- **Accept with changes** → list them here; they land as a follow-up PR, on
  this branch name or one Lane B opens. Cheap while the dialect is one file
  and 23 kinds.
- **Reject the boundary or the sequencing** → say what should have landed
  first. The remedy is a revert PR (public `main` is append-only — fix
  forward, never rewrite), then re-plan under #3954's original phase order.
  The split is 23 declaration moves plus a gate, so a revert is mechanical.

The reviewer should also say whether the **schema** half is theirs or #3030's
(see "Two schema questions" below).

Also inherited: **#4551 is `status: blocked` on this same review.** It owns the
per-kind verdict for the families deliberately left in core (`vec.*`,
`class.*`, `object.*`, `string.*`, `box`/`unbox`/`tag.test`,
`forof.vec`/`forof.string`, `coerce.to_externref`). Unblocking or folding it
into #3954 is part of this review's outcome.

## Two schema questions with a clock on them

Surfaced while answering a follow-up on the MLIR shape; recorded here because
they expire in a way the in-tree questions do not.

`docs/ir/ir-module.schema.json` defines `instrKind` as a **closed enum of 60
entries, 19 of them JS ops**. An out-of-tree producer (#3954 phase 4, and
#3030's stated purpose) cannot emit an op outside that enum, so whether a
non-JS producer is possible at all is decided by the schema's namespace shape
— not by the in-tree union.

1. **Should `instrKind` become an open namespace?**
   `anyOf: [ {enum: [...60 known...]}, {type: "string", pattern:
   "^[a-z][a-z0-9]*\\.[a-z_][a-z0-9_]*$"} ]`. Known ops still validate against
   the enum, so docs and tooling keep the list; a foreign dialect can emit
   `py.getattr` without a spec revision. Op names are already `dialect.op`-shaped
   by convention, so only the closed-vs-open half is at stake.
2. **Should `IrInstr` gain an open arm in-tree?**
   `interface IrInstrForeign { kind: \`${string}.${string}\`; operands: IrValueId[] }`.
   **Measured, not assumed:** this KEEPS exhaustiveness over the closed arms —
   a new unhandled closed arm still fails to compile (`TS2322: Type
   'InstrForeign | InstrVecGet' is not assignable to type 'InstrForeign'`).
   The costs are elsewhere: a second, weaker instruction shape alongside the
   bespoke typed fields; a declared foreign behaviour in every pass (`effects.ts`
   conservative, `legality.ts` illegal-by-default); and #1924's re-derive
   guarantee weakening exactly where the op is least known.

Recommendation on the record, for the reviewer to accept or overrule: **do (1)
now, defer (2)**. (1) is one schema edit plus a version bump while consumer
count is plausibly zero — `IR_FORMAT_VERSION` is already at 5.1 with five bumps
behind it, and #3030 is still `status: ready`. (2) should wait for a producer
that actually needs it; the dialect split makes adding it later a contained
change rather than a refactor.

## Not in scope

Re-litigating #3954's four-phase design. The reviewer owns whether this slice
implements it faithfully and whether the phase inversion was sound — not
whether the tag-domain seam is the right idea.
