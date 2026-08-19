---
id: 4551
title: "Settle the neutral/ECMAScript split per IR instruction kind, so #3954's dialect boundary is drawn on evidence rather than an approximate count"
status: done
created: 2026-08-17
updated: 2026-08-19
completed: 2026-08-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: analysis
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: current
parent: 3954
horizon: m
model: fable
related: [1713, 1851, 1852, 2949, 3029, 3030, 3954, 4523]
# id 4551 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI absent in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the only open PRs were
# 4639 (ci/npm-compat-refresh, artifact-only) and 4643 (#4539 linear link
# topology), neither of which adds an issue file. Ids 4552/4553 were reserved
# in the same batch for a second-language proof that was dropped as duplicating
# #3954 phase 3; 4552 was later reused for the Fable-lane review issue, 4553
# remains reserved and unused.
---
# #4551 — A per-kind neutrality verdict for #3954 phase 2

**Review gate:** the deliverable landed on 2026-08-19 (see Outcome), so this
issue is `done`. The **Fable-lane architect review** it was blocked on is not
waived — it moved to a post-merge review, folded into **#4552** along with
#3954 phase 1, on the same project-lead call that un-drafted PR #4644. What
that review can still change is the verdicts and the enforcement shape, not
whether this work happens.

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

**The 78 is exact and has not drifted** — measured across `origin/main`
history, the `IrInstr` union has had 78 arms on 2026-08-01, 2026-08-10 and
2026-08-18 alike. An earlier draft of this issue claimed it had drifted to 82;
that was a **counting error**, and reproducing it is the cheapest available
illustration of why this issue exists. Grepping `readonly kind:` in
`src/ir/nodes.ts` yields **85**, which is 78 union arms **+ 3 declaration kinds
(`func`/`global`/`type`) + 4 terminators (`br`/`br_if`/`return`/`unreachable`,
which are `IrBranch`/terminator members, not `IrInstr` arms)**. Two plausible
denominators, no tool to settle which is meant.

That is the actual problem, and it is worse than a stale number:

1. **The population itself is not mechanically defined.** Two counts of the
   same thing, made hours apart in one session, disagreed by four — because
   "instruction kind" is currently a grep, not a definition. Any per-kind
   boundary needs the denominator pinned first.
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

### Cost of delay, measured

`IrInstr` union arms across `origin/main`:

| date | arms |
| --- | --- |
| 2026-05-01 | 51 |
| 2026-06-01 | 57 |
| 2026-07-01 | 58 |
| 2026-07-15 | 71 |
| 2026-08-01 | 78 |
| 2026-08-18 | 78 |

**+53 % in three months, then flat for 17 days.** Phase 2's work is O(kinds),
so its cost tracks this curve directly — and the growth is lumpy (+13 in the
first half of July alone), which means "it has been quiet lately" is not
evidence of anything at 17 days' resolution.

Phase 1's surface is much smaller and is not growing the same way: **58
`JsTag.` member reads in 7 files** today. (An earlier revision of this line said
"across 24 files" — that conflated the member-read count with the number of
files merely *mentioning* `JsTag`, several of which are `src/checker/oracle.ts`'s
**unrelated same-named type**, a `"number" | "string" | …` string union. Measured
during #3954 phase 1.) That asymmetry is worth knowing when
sequencing — deferring the tag seam is cheap; deferring the dialect split is
what compounds, particularly against `ir-full-coverage`, which #3954 expects to
add roughly 40 more kinds.

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

- The population is pinned by a stated rule (which of `IrInstr` arms,
  terminators and declaration kinds are in scope), not by a grep.
- Every kind in that population carries a verdict (`neutral` / `js` /
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
  before #3954 was found; 4552 was reused for #4552 (the Fable-lane review),
  4553 is still unused.

## Status update (2026-08-17)

**#3954 phase 2's first slice has landed**, sequenced ahead of the
`ir-full-coverage` push by project-lead decision on the cost-of-delay series
above. `src/ir/dialect/js.ts` now holds the 23 **uncontested** ECMAScript kinds
(`dyn.*`, `iter.*` + `forof.iter`, `gen.*`, `await`/`async.*`, `extern.*`),
behind `scripts/check-ir-dialect.mjs`.

That makes this issue's deliverable **narrower and more urgent, not obsolete**:
the contested families are exactly what is left, and every one of them is
sitting in core by default until this verdict exists.

Still unplaced, in rough order of how much the answer matters:

| family | why it is contested |
| --- | --- |
| `vec.*` (5) | array holes live in `src/codegen/array-holes.ts`, above the IR — the IR op may be a plain typed-array access |
| `class.*` (8) | single-inheritance prototype flavour, but shared with Java/Kotlin/Dart |
| `string.*` (6) | already parameterized by `IrStringEncoding`; the residual JS shape is the operation set, not the encoding |
| `object.*` (3) | open-map semantics vs a declared record layout |
| `box`/`unbox`/`tag.test` (3) | belongs with phase 1's `TagDomain`, not with the dialect split |
| `forof.vec`, `forof.string` (2) | JS statement forms over otherwise-neutral aggregates |
| `coerce.to_externref` (1) | host-boundary concern rather than a language one |

The default is now explicit and safe — unresolved means core — so nothing is
mis-placed while this is open. What it costs is that the dialect is smaller
than it should be.

## Outcome (2026-08-19)

`scripts/check-ir-kind-neutrality.mjs` + `scripts/ir-kind-neutrality-baseline.json`,
wired into `quality` as `check:ir-kind-neutrality`.

Population pinned at **82** = 78 `IrInstr` arms + 4 `IrTerminator` arms, derived
from a stated rule; the disputed 85 is reconciled and asserted every run as
82 in-scope + 3 symbolic-reference kinds (`IrFuncRef`/`IrGlobalRef`/`IrTypeRef` —
**references, not declarations**, one correction to the prose above).

Verdicts: **53 neutral · 26 js · 3 unresolved**, each with a `{file, quote}`
citation the gate re-verifies (a rotted citation fails rather than reporting a
stale answer).

- Settled: `vec.*` neutral (holes are refused by the IR, and `src/codegen/array-holes.ts`
  has no importer under `src/ir/` — asserted as an absence check); `object.*`
  neutral (declared record layout; the open-map half is `dyn.member_*`, already
  in the dialect); `class.*` all 8 neutral (nominal, closed-world, tag-based
  `instanceof`, allocate-then-init — not ECMAScript's `[[Construct]]`);
  `coerce.to_externref` neutral; `box`/`unbox`/`tag.test` neutral with the
  residual owned by phase 1's `TagDomain`, as this issue anticipated.
- `string.*` splits 3 neutral / 2 js / 1 unresolved — confirming the operation
  set, not the encoding, is where the JS shape is.
- `forof.vec` neutral, `forof.string` js (they are not the same call).
- Phase 2's remaining move list is exactly **3**: `string.char_at`,
  `string.char_code_at`, `forof.string`.
- The 3 unresolved are `binary`, `intrinsic`, `string.len`; `binary` and
  `intrinsic` are a shape this issue's contested list did not anticipate — a
  neutral interface over an ECMAScript-tainted payload vocabulary, where the
  unit of the fix is the enum rather than the declaration.
