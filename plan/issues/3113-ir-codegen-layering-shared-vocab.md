---
id: 3113
title: "Fix IR->codegen reverse layering: move shared vocabulary (js-tag) below IR; contain the bridge to ir/integration.ts"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
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
