---
id: 3113
title: "Fix IR->codegen reverse layering: move shared vocabulary (js-tag) below IR; contain the bridge to ir/integration.ts"
status: done
sprint: current
created: 2026-07-09
updated: 2026-08-21
completed: 2026-08-21
priority: medium
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
related: [1172, 2855, 2949]
---

# #3113 — IR↔codegen layering: shared vocabulary below IR

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

The intended layering is `emit` ← `ir` ← `codegen` (codegen consumes IR, IR
consumes nothing above it). Current main has **6 files in `src/ir/` importing
from `src/codegen/` (25 import lines)**:

| IR file                 | imports from codegen                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir/integration.ts`     | **17 modules** — any-helpers, dyn-read, shared, async-scheduler, index, value-tags, coercion-engine, js-tag, vec-elem-set, class-member-keys, native-strings, registry/imports, registry/types, context/types, ir-tail-call, fmod, func-space |
| `ir/from-ast.ts`        | fmod, statements/control-flow, statements/loops, js-tag                                                                                                                                                                                       |
| `ir/nodes.ts`           | js-tag                                                                                                                                                                                                                                        |
| `ir/verify.ts`          | js-tag                                                                                                                                                                                                                                        |
| `ir/builder.ts`         | js-tag                                                                                                                                                                                                                                        |
| `ir/backend/handles.ts` | (codegen types)                                                                                                                                                                                                                               |

Two distinct problems:

1. **`js-tag.ts` is mis-homed.** It is shared _vocabulary_ (JS type-tag
   constants used by boxing/refinement) consumed by IR core files
   (`nodes/verify/builder/from-ast`) — i.e. it sits BELOW the IR, but lives
   in `src/codegen/`. Same likely true of `fmod`'s interface and the
   `func-space` chokepoint types.
2. **`ir/integration.ts` (2,610 LOC) is the IR→codegen bridge but lives on
   the IR side**, which makes `import "src/ir"` transitively pull 17 codegen
   modules — the exact inversion #1172 Slice E flagged (then 2 imports; now
   17 — it is getting worse ~9× in 10 weeks).

This matters MORE as #2855 (IR front-end migration) proceeds: the IR is
supposed to become the primary front-end, and a front-end that imports the
legacy path's internals can never let that path be deleted.

## Fix (mechanical first, boundary second)

1. **Move `src/codegen/js-tag.ts` → `src/ir/js-tag.ts`** (or `src/shared/`
   if emit/ also needs it). Keep a re-export at the old path for one cycle.
   Fixes 4 of the 6 inverted files in one pure-motion commit.
2. **Move `ir/integration.ts` → `src/codegen/ir-bridge.ts`** (#1172 Slice E,
   re-grounded). It is codegen machinery (it registers codegen helpers for
   IR-lowered bodies); its 17 codegen imports become same-layer imports.
   Update the importer(s) (`src/codegen/index.ts` + any tests).
3. **`from-ast.ts`'s imports of `statements/control-flow`/`statements/loops`**
   need case-by-case review (they may be borrowing legacy lowering helpers —
   each is either (a) shared vocabulary to move down, or (b) a bridge call to
   route through the bridge module). Deliverable: zero `../codegen/` imports
   in `src/ir/` outside a single documented exception list.
4. Add a cheap CI guard (grep-based, in the `quality` job or a unit test):
   `src/ir/**` must not import `src/codegen/**` — the list above regrew 9×
   since April precisely because nothing enforces the boundary.

## Safety story

Steps 1–2 are pure file motion + import-path rewrites — byte-identity
provable (`prove-emit-identity check` IDENTICAL) and `tsc --noEmit`-verified.
Step 3 is review-then-move, one import per commit, same proof. No emission
logic changes anywhere.

## Coordination

- #2855/#2856 (IR migration) actively edits `from-ast.ts`/`integration.ts` —
  land steps 1–2 at a quiet moment for those files (small diffs, so conflicts
  are cheap; the import-path rewrite is mechanical for any in-flight branch).
- #2949 boxing slices introduced several of the newer bridge imports
  (value-tags, coercion-engine) — the bridge move keeps their call graph
  intact, only the file's home changes.

## Estimated LOC delta

≈ 0 (motion). Value is the enforced boundary (step 4) + un-tangling `import
"src/ir"` for future consumers (bytecode backend, linear-IR lowering).

## Acceptance criteria

1. `grep -rn 'from "\.\./codegen' src/ir/` → empty (or the documented
   exception list, target ≤ 2 lines).
2. CI guard in place and failing on a synthetic violation.
3. `prove-emit-identity check` IDENTICAL; `tsc --noEmit` clean; no test262
   regression.

## Progress — slice 1 (js-tag relocation) shipped 2026-07-17

Problem 1 (js-tag mis-homed) is resolved. `js-tag.ts` — the dependency-free
shared-vocabulary leaf (the `JsTag` enum + `jsTagUnboxKind`) — was moved from
`src/codegen/js-tag.ts` to `src/ir/js-tag.ts`, below the codegen layer. Import
paths updated in all consumers: `ir/nodes.ts`, `ir/verify.ts`, `ir/builder.ts`,
`ir/from-ast.ts`, `ir/integration.ts`, `ir/backend/handles.ts` (now import
in-layer), `codegen/value-tags.ts` (imports down-stack via `../ir/js-tag.js`,
re-export preserved), and the 7 `issue-2949-*` test files.

Effect on the inversion: `ir/nodes.ts`, `ir/verify.ts`, and `ir/builder.ts` had
js-tag as their ONLY codegen import — they now have ZERO codegen imports.
`ir/from-ast.ts` and `ir/integration.ts` each drop one codegen import.

The move is pure relocation (js-tag has zero imports, no logic change): proven
byte-identical via `scripts/prove-emit-identity.mjs check` — all 56
(file,target) emits match baseline. tsc clean; the `issue-2949-*` suites pass.

**Remaining — slice 2 (the substantive part):** Problem 2, containing the
2,610-LOC `ir/integration.ts` IR→codegen bridge so `import "src/ir"` stops
transitively pulling ~17 codegen modules (move the bridge to the codegen side /
behind a narrow interface). That is a larger, design-sensitive change and is
left open under this issue.

## Implementation Plan (Fable, 2026-08-21)

**Re-measured on `bc588f2f3` + the #4558/#4521 branch:** the inversion has
kept regrowing since slice 1 — now **20 files under `src/ir/` import from
`../codegen`, ~100 import lines** (was 6 files / 25 lines when this issue was
filed), and `ir/integration.ts` is **7,335 LOC** (was 2,610). Top offenders:
`integration.ts` 42 lines, `from-ast.ts` 7, `number-to-string-provider.ts` 6,
`prepared-vector-support.ts` / `prepared-closure-support.ts` /
`backend/linear-integration.ts` 5 each. Consequences for sequencing:

- The original step 2 (move `integration.ts` to the codegen side) is now MORE
  disruptive and collides with the in-flight R1–R4 branches (#3520–#3523),
  which edit that file heavily. **Do not do it in this dispatch.**
- The guard (original step 4) is the urgent part — the boundary regrew 4×
  since this issue was FILED because nothing enforces it. AC 1's "grep empty"
  is not reachable today; the guard must be a **ratchet**, not an emptiness
  check.

**S1 — the layering ratchet (this dispatch, Opus):**

1. `scripts/check-ir-layering.mjs`: walk `src/ir/**/*.ts`, count import lines
   whose specifier resolves into `src/codegen/` (match `from "../codegen` and
   `from "../../codegen`; ignore type-only? NO — count `import type` too, the
   boundary is about the dependency graph). Output per-file counts.
2. Baseline `scripts/ir-layering-baseline.json` seeded at the measured
   current truth (per-file map + total). Gate semantics cloned from
   `scripts/check-linear-ir.ts`: any per-file increase OR any NEW file with
   codegen imports fails; decreases pass with a hint to `--update`;
   `--update` refreshes.
3. Wire as `"check:ir-layering"` in package.json and add to the `quality` CI
   job exactly where `check:ir-fallbacks` is invoked (find it in
   `.github/workflows/` and mirror the invocation).
4. Prove the gate fires: a unit test (`tests/issue-3113-ir-layering-gate.test.ts`)
   that runs the script against a synthetic tree (tmp dir with a violating
   file) and asserts failure, plus asserts the committed baseline matches the
   script's live measurement (so the baseline cannot drift silently).

**S2 — `from-ast.ts` import review (same dispatch, only if S1 lands clean):**
classify each of its 7 codegen imports as (a) shared vocabulary → move the
module (or the needed part) below IR like js-tag was, or (b) a bridge call →
leave, listed in the baseline. Move ONLY category (a), one import per commit,
each proven byte-identical via `node scripts/prove-emit-identity.mjs check`
(all 56 emits IDENTICAL) + ts7 typecheck. If a candidate is not a
dependency-free leaf, do not move it — record why in this file instead.

**S3 — deferred, do NOT attempt now:** the `integration.ts` bridge move.
Blocked on #3520/#3521 landing (active edits). The ratchet from S1 protects
the boundary meanwhile.

**Validation bar for the PR:** `check:ir-layering` green + fires on synthetic
violation; `prove-emit-identity` IDENTICAL if any file moved; ts7 typecheck;
`check:ir-fallbacks` / `check:ir-only` / `check:linear-ir` unchanged; LOC
budget (new script file is fine; touching `src/codegen/index.ts` needs care).

**Amended AC (supersedes AC 1–2 above):** the enforced state is "committed
baseline, no growth, ratchet-to-zero direction"; AC 3 unchanged.

## Outcome — S1 + S2 shipped 2026-08-21

Both slices landed as planned. **S3 (the `integration.ts` bridge move) remains
deferred** — see "Follow-up still owed" below.

### S1 — the layering ratchet (shipped)

`scripts/check-ir-layering.mjs` + `scripts/ir-layering-baseline.json`, wired as
`check:ir-layering` in package.json and into the `quality` CI job immediately
before `check:ir-fallbacks`. Gate semantics cloned from `check-linear-ir.ts`:
per-file increase **or** a NEW file with codegen imports fails; decreases pass
with a hint to bank via `--update`.

`tests/issue-3113-ir-layering-gate.test.ts` (8 tests) proves the gate fires on
a synthetic tree (growth, new file, `import type`), does **not** fire on
`codegen-linear`, and that the committed baseline equals live measurement so it
cannot drift silently.

**Measured seed: 96 import lines / 20 files — not the 100 / 20 the plan above
records.** The plan's figure came from a `from "../codegen` prefix grep, which
also matches `../../codegen-linear/…`. `src/codegen-linear/` is a sibling
*backend*, not the WasmGC codegen layer this issue is about, so those 4 lines
are not part of the inversion. The script therefore **resolves** specifiers
instead of prefix-matching, and reports the codegen-linear count as a separate
informational line so the exclusion is visible rather than silent. Four of the
five lines attributed to `ir/backend/linear-integration.ts` were this artifact;
its real debt is 1 line.

`import type` **is** counted: the boundary is about the dependency graph, and a
type-only edge still constrains what may move. Dynamic `import("…")` and
`export … from "…"` are counted for the same reason (and to close the obvious
bypasses); neither occurs in `src/ir/` today.

### S2 — `from-ast.ts` codegen-import classification

Criterion for category (a), per the plan and the slice-1 precedent: the module
must be a **dependency-free leaf** with respect to the ir↔codegen boundary — no
codegen imports, no `CodegenContext`, no codegen state.

| # | codegen import                       | LOC   | own deps                                       | class                  | action     |
| - | ------------------------------------ | ----- | ---------------------------------------------- | ---------------------- | ---------- |
| 1 | `regexp-runtime-contract.js`         | 9     | **none**                                       | (a) shared vocabulary  | **MOVED**  |
| 2 | `async-static.js`                    | 160   | `src/ts-api.js` only                           | (a) shared vocabulary  | **MOVED**  |
| 3 | `analysis/remainder-fast-path.js`    | 109   | `ts-api` + `codegen/analysis/static-numeric-range.js` | (b) near-leaf   | left       |
| 4 | `ir-native-map.js`                   | 138   | 5 codegen (CodegenContext, func-space, …)      | (b) bridge             | left       |
| 5 | `dyn-ops.js`                         | 589   | 11 codegen (CodegenContext, func-space, regex/…) | (b) bridge           | left       |
| 6 | `statements/loop-analysis.js`        | 654   | `codegen/closures.js`, `statements/tdz.js`     | (b) bridge             | left       |
| 7 | `statements/control-flow.js`         | 1,789 | ~15 codegen (CodegenContext, coercion-engine, …) | (b) bridge           | left       |

Notes on the three judgement calls:

- **#3 `remainder-fast-path` is the near miss.** It touches no codegen state —
  `ts-api` plus one sibling, `analysis/static-numeric-range.js`. But it is not
  dependency-free: moving it alone re-creates the upward import from its new
  home, and moving both is a 2-module change the plan explicitly scopes out
  ("If a candidate is not a dependency-free leaf, do not move it"). It is the
  obvious first candidate for a follow-up that moves the `analysis/` pair
  together.

  > **Correction (2026-08-21).** Row 3's "own deps" cell records
  > `remainder-fast-path`'s deps but **not `static-numeric-range`'s**, and that
  > omission makes the follow-up it recommends unreachable:
  > `static-numeric-range.ts:4` imports `../statements/loop-analysis.js` —
  > row **6** of this very table, classified `(b) bridge, left`. So the *pair*
  > is not a leaf either, and no relocation-only move set clears the edge. The
  > dep predates this PR (added by `8e77e6740`, 2026-08-09, an ancestor of it);
  > it is a measurement gap, not drift. Moving the pair anyway scores 92 → 90
  > but trips the ratchet's own `NEW file with codegen imports` FAIL and leaves
  > the IR's transitive reach into codegen unchanged. Full measurement and the
  > two routes that would actually work: `4601-ir-integration-bridge-containment.md`,
  > "Progress log".
- **#6 `loop-analysis`** is pure AST analysis (`from-ast.ts` already documents
  it as "no codegen state") and reads like vocabulary, but it imports
  `codegen/closures.js` and `statements/tdz.js`, so it is not a leaf either.
- **#5 and #7** are the real bridge calls: both take `CodegenContext` and emit.
  They belong behind the bridge, which is S3's problem, not S2's.

`select.ts`'s single codegen import was `async-static.js` (the same leaf as
#2), so moving it cleared that file entirely — 20 files → 19.

### Result

| | files | import lines |
| - | - | - |
| seeded baseline | 20 | 96 |
| after `regexp-runtime-contract` | 20 | 94 |
| after `async-static` | **19** | **92** |

Both moves are pure relocation, proven byte-identical with
`node scripts/prove-emit-identity.mjs check` → **IDENTICAL, all 60
(file,target) emits** (the corpus is 60 now, not the 56 the plan cites), ts7
typecheck clean, `check:ir-fallbacks` / `check:ir-only` / `check:ir-dialect` /
`check:jstag-seam` / `check:dead-exports` / `check:host-import-policy` all
green, LOC + func budgets OK.

**Pre-existing failures confirmed NOT caused by this work** (each reproduced on
unmodified `origin/main` @ `ba151267f` in a scratch worktree):

- `tests/issue-2175-regexp-proto-readers.test.ts` — 3 failing tests.
- `pnpm run check:linear-ir` — FAIL, identical three lines (`compiled 8 → 6`,
  `illegal:instr-vec.set_length 0 → 2`, `select:string-builder-candidate
  0 → 2`). It is a **local dev tool, not wired into any workflow**. Its
  baseline was deliberately **not** refreshed here: banking another lane's
  regression into an unrelated PR would hide it. Worth its own issue.

### Follow-up still owed

**S3 — containing `ir/integration.ts` (7,335 LOC, 42 of the remaining 92 import
lines) — was deliberately not attempted**, per the plan: it collides with the
in-flight #3520–#3523 branches that edit that file heavily. That is Problem 2 in
this issue's original statement and it is still open; the ratchet now stops the
boundary regrowing while it waits. This issue is closed against its **amended**
AC (ratchet in place, no growth, direction set); S3 needs a fresh issue once
#3520/#3521 land.
