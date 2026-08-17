---
id: 4551
title: "Settle the neutral/ECMAScript split per IR instruction kind, so #3954's dialect boundary is drawn on evidence rather than an approximate count"
status: blocked
created: 2026-08-17
updated: 2026-08-17
priority: medium
feasibility: medium
reasoning_effort: high
task_type: analysis
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: Backlog
parent: 3954
blocked_by: fable-architect-review
horizon: m
model: fable
related: [1713, 1851, 1852, 2949, 3029, 3030, 3954, 4523]
# id 4551 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI absent in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the only open PRs were
# 4639 (ci/npm-compat-refresh, artifact-only) and 4643 (#4539 linear link
# topology), neither of which adds an issue file. Ids 4552/4553 were reserved
# in the same batch and deliberately NOT used — the work they were drafted for
# duplicates #3954 phases 2 and 3.
---
# #4551 — A per-kind neutrality verdict for #3954 phase 2

**Review gate:** needs an architect review from the **Fable lane** (Lane B owns
`backend-agnostic-ir`, `plan/method/lane-partition.md`) before dispatch.
`status: blocked` until then. It may well be folded into #3954 outright rather
than run separately; that is the reviewer's call.

**This is a sub-issue of #3954** ("Name the IR's ambient ECMAScript
assumptions: factor the JS value model behind a tag-domain seam"), not a rival
plan. #3954 owns the design — the `TagDomain` seam (phase 1), the MLIR-style
dialect split of `nodes.ts` (phase 2), the synthetic-tag-domain falsification
test (phase 3), and the out-of-tree producer (phase 4). Everything below feeds
phase 2 and changes nothing about that design.

## Problem

#3954 phase 2 splits `src/ir/nodes.ts` into a neutral core and a `js` dialect,
"enforced as a dependency-lint rule rather than a convention". That split needs
a **per-kind verdict**: for each instruction kind, neutral or JS?

No such verdict exists. What exists is an approximate count, recorded in #3954
on 2026-08-01:

> `IrInstr` kinds: **78** · language-neutral **~40** · encode ECMAScript **~35**

Two problems with using that as the input to a dependency-lint boundary:

1. **It has already drifted.** Measured on `main` at 2026-08-17: **82**
   instruction kinds (excluding the `func`/`global`/`type` declaration
   members). Four kinds in sixteen days, with nothing counting them.
2. **The middle of the distribution is unresolved, and it is where the
   boundary actually falls.** A first re-classification attempt on 2026-08-17
   produced 31 neutral / 25 "neutral name, JS-defined spec" / 26 JS-only — but
   **the middle tier did not survive spot-checking**, and that is the finding
   worth recording:

   - `vec.*` was assumed to carry JS array holes and index coercion. It does
     not appear to: `src/codegen/array-holes.ts` sits in the legacy codegen
     path, *above* the IR. `vec.*` may be a plain typed-array op — neutral.
   - `string.*` was assumed to bake in UTF-16. It does not:
     `StringBackendEmitter` is parameterized by `IrStringEncoding`
     (`ascii | utf8-guaranteed | wtf16`), which is the very precedent #3954
     cites for the shape phase 1 should take. The residual JS shape is in the
     *operation set* (`char-code-at` is a UTF-16 code unit; `iterator-char-at`
     exists separately for code points), not in the encoding.
   - `class.*` (`super_init`, `super_call`, `instanceof`) is single-inheritance
     prototype-flavoured, but shared with Java/Kotlin/Dart. Unresolved.

   Each of those took a few minutes to check and two of three reversed the
   initial reading. Nobody can currently answer "is this kind neutral?" without
   re-deriving it from scratch, and a boundary drawn from an unverified
   classification will put kinds on the wrong side of a lint rule that is then
   expensive to move.

### One correction to the record, in the other direction

The same pass tested whether the **backend** contract leaks ECMAScript, on the
hypothesis that `BackendEmitter` would turn out to be JS-shaped. It does not,
and #3954's characterization of the backend half as "the already-neutral half
of the pipeline" holds: of the 54 methods across `BackendEmitter` +
`StringBackendEmitter`, **3** are JS-shaped (`emitPromiseNew`,
`emitPromiseStateGet`, `emitPromiseValueGet`). The candidates that looked
JS-specific by name are not: `emitToExternref`/`emitFromExternref` are a
*host*-boundary concern rather than a language one, `emitVecSetLength` is an
ordinary resizable-array length write, and the six string primitives are
encoding-parameterized as above.

Recorded here so the hypothesis is not re-run: the leak is on the producer
side, which is exactly where #3954 puts it.

## Scope

Measurement and enforcement only. **No source change, zero conformance delta.**

1. `scripts/check-ir-kind-neutrality.mjs`, modelled on
   `scripts/check-ir-fallbacks.mjs`: parse the `IrInstr` union from
   `src/ir/nodes.ts`, classify each kind against a declared table, report
   counts per verdict.
2. A **per-kind verdict table** with one line of evidence each — the file/line
   where the JS semantics actually live, or the reason none does. Kinds that
   cannot be settled cheaply get an explicit `unresolved` verdict rather than a
   guess; an honest unresolved count is the useful output, a confident wrong
   split is not.
3. `scripts/ir-kind-neutrality-baseline.json`, the standard ratchet shape
   (committed baseline, growth fails, `--update-on-decrease` banks
   improvements), wired into `quality`.
4. An **unclassified kind is a hard failure**, per `R-LOUD` in
   `target-architecture.md`. A new node kind must state its verdict. This is
   the same defect `effects.ts` was created to fix: two tables that defaulted a
   new kind with opposite polarities, and nobody noticed.

## Acceptance criteria

- Every one of the 82 kinds carries a verdict (`neutral` / `js` /
  `unresolved`) with cited evidence.
- Adding a kind without a verdict fails `quality`, naming the kind.
- The `unresolved` set is small enough to be phase 2's actual agenda, and each
  entry states what would settle it.
- No change under `src/`; no test262 or equivalence delta.

## Explicitly not in scope

- The `TagDomain` seam — that is #3954 phase 1.
- Moving any declaration between files — that is #3954 phase 2, which this
  issue exists to inform.
- A second front-end. #3954 phase 3 argues the seam should be falsified with a
  synthetic non-JS tag domain through `backend/bytecode-vm.ts` rather than by
  writing a producer, and that argument is better than the alternative: it is
  cheaper, it fails faster, and it does not create a language nobody owns. Two
  issue ids (4552/4553) were reserved on 2026-08-17 for a second-language proof
  before #3954 was found; they were deliberately left unused.
