---
id: 7620
title: "Module semantics gaps (parent): `export * as ns`, block-scoped shadowing, cyclic-import TDZ"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7470, 7558]
---

# #7620 — module semantics gaps (parent)

RV-PR7558, the review of PR #7558 (#7470), found three wrong answers in multi-file `compileMulti` graphs. None is
caused by #7558: each reproduces identically on main.

PRV-7620 reviewed the first plan (12bc6f2064) and returned a plan blocker with 21 findings. Following the lead's
decision, this issue is now a parent: one child issue per PR. The children hold the measured rows, the causes, the
plans and their acceptance criteria.

The reviewer confirmed three parts of the first plan as sound:

- gap 1's cause and its reuse (#7625);
- C's reuse of the first-call rule (#7626);
- the slice order. With B's new #7558 dependency it is now B-1 → A → C → B-2/B-3 → A2.

## Children

| child | gap | summary | depends on | status |
| --- | --- | --- | --- | --- |
| [#7624](7624-block-class-hides-module-let-global.md) (B) | gap 2 + R3 | Block-scoped `let`/`const`/`class`/`function` leak out of their block. Fixed with declaration-keyed block slots. | #7558 (for the block-class part only) | ready |
| [#7625](7625-named-import-of-module-namespace-reads-null.md) (A) | gap 1 | A named import of a module namespace reads null; namespace identity. | #7558 (same file) | ready |
| [#7626](7626-cyclic-import-tdz-read-does-not-throw.md) (C) | gap 3 | A cyclic-import read before initialization does not throw. | #7558 (`moduleBindingOf(…).tdz`) | ready |
| [#7627](7627-namespace-read-of-reassigned-function.md) (A2) | N0 / N(a) / N(b) | `d.f()` after `f` is reassigned returns the original body. | #7530, #7625 | **blocked** on #7530; re-planned after #7530's plan is approved |
| [#7622](7622-ir-identity-context-gated-on-experimental-ir.md) (R1) | — | The IR identity context is built only with `experimentalIR`/`trackIrOutcomes`, so IR-off namespace calls throw. | — | ready |
| [#7623](7623-namespace-member-call-non-exact-graph-edge.md) (R2) | — | IR-on compile error "non-exact graph edge" for `d.f()` when dep exports only functions. | — | ready |

## Order

1. **#7624 step B-1** (block `let`/`const`, plus the Annex B helper extraction). Optional: it can land first, from
   main, because #7558 does not touch those functions.
2. **#7622** (R1), before any child's IR-off namespace pins are expected green.
3. **#7625** (A), on #7558's head or after #7558 lands.
4. **#7626** (C), after #7558 lands.
5. **#7624 steps B-2/B-3** (block function, block class). B-3 changes #7558's `isClassOfScope`, so it waits for
   #7558.
6. **#7627** (A2), after #7530 lands and its re-plan is approved.

#7623 (R2) is independent of all of these.

## Cross-child measurements

**Bases.** Every child was measured on 2026-11-28, with node v22.23.5, on two bases:

- `ada18e6bb6`: head of PR #7558, branch `claude/7470-module-bindings`;
- `01c9284f78`: origin/main.

The probes are in `.tmp/p7620/` in the c8-7620 worktree. Every row answers identically on both bases.

**101 vs 131 (review finding 19).**

- The hoisted-function TDZ row gives 101 with `y = r() + 10` (this plan's probe) and 131 with `y = r() + 13` (the
  reviewer's reading of the draft text). Node gives 41 for both.
- Both are correct. The draft's text did not state the constant.
- Both rows are pinned in #7626.

**test262 verdicts (review findings 2, 19).** Scoped runs only, no full test262.

- **Settings.** `runTest262File` (`tests/test262-runner.ts:4580`) on main `01c9284f78`, 2026-11-28. The standalone
  lane uses `target: "standalone"`, the gc lane uses the default target. Both use the ordinary pipeline with
  `experimentalIR` on (the default).
- **`TEST262_COMPILER_PATH=ir` is not feasible.** `benchmarks/results/test262-standalone-ir-status.json` reports
  `state: "unavailable"` ("IR-only Test262 compilation is unavailable: public compile/compileMulti still use direct
  generators").
- **Comparison column.** The last column is the CI standalone baseline (`js2wasm-baselines`,
  `test262-standalone-current.jsonl`, stamped 27.11.2026 03:47, honest lane). It was fetched on 2026-11-28; the
  baseline row carries no head sha.

| file (`language/module-code/`) | standalone, `runTest262File` | gc, `runTest262File` | CI standalone baseline |
| --- | --- | --- | --- |
| `export-star-as-dflt.js` | CE | CE | fail |
| `eval-rqstd-once.js` | fail | fail | pass |
| `early-dup-export-star-as-dflt.js` | pass | pass | pass |
| `ambiguous-export-bindings/namespace-unambiguous-if-import-star-as-and-export.js` | pass | pass | pass |
| `ambiguous-export-bindings/namespace-unambiguous-if-export-star-as-from-and-import-star-as-and-export.js` | pass | pass | pass |
| `ambiguous-export-bindings/namespace-unambiguous-if-export-star-as-from.js` | pass | pass | pass |
| `parse-err-semi-name-space-export.js` | pass | pass | pass |
| `early-dup-export-as-star-as.js` | pass | pass | pass |
| `instn-iee-err-circular-as.js` | fail | fail | CE |
| `instn-iee-err-circular.js` | fail | fail | CE |
| `instn-iee-iee-cycle.js` | pass | pass | pass |
| `instn-iee-star-cycle.js` | fail | fail | pass |
| `instn-named-iee-cycle.js` | fail | fail | pass |
| `instn-named-star-cycle.js` | fail | fail | pass |
| `instn-star-iee-cycle.js` | fail | fail | pass |
| `instn-star-iee-multi-cycle-same-name.js` | fail | fail | pass |
| `instn-star-iee-single-cycle-same-name.js` | fail | fail | pass |
| `instn-star-props-circular.js` | fail | fail | pass |
| `instn-star-star-cycle.js` | fail | fail | pass |
| the other 65 `instn-*` files | 46 fail, 8 CE, 11 pass | 61 fail, 4 pass | 27 fail, 16 CE, 22 pass |
| **all 84** | 57 fail, 9 CE, 18 pass | 72 fail, 1 CE, 11 pass | 28 fail, 18 CE, 38 pass |

**`runTest262File` is not CI-faithful for module code.** It agrees with the CI baseline on 39 of 84 files.

- Its errors show why: `ReferenceError: ns is not defined` on fixture-importing files, which suggests fixture modules
  are not linked; `This statement should not be evaluated.` on negative resolution tests; and `JS2WASM_EVAL_ENGINE=quickjs
  but the quickjs provider is not built` on the gc lane.
- So the table is the requested measurement, but each child's before/after must use the CI lane:
  `TEST262_PATH_FILTER_FILE` with `pnpm run test:262` and `TEST262_TARGET=standalone`. The baseline column is the
  right "before".

## Cross-child acceptance

- Every child meets its own acceptance criteria: a red → green pin, a code-quality bullet, and a byte gate.
- **No child edits** `source-binding-projection.ts` or `module-binding-table.ts`, or #7530's regions
  (`registerModuleGlobal`'s tail, `registerLiveFunctionGlobal`, `registerReassignedFunctionGlobals`,
  `module-init-prologue.ts`'s seed loop).
- **No test262 regression** across children. After the last child, the scoped CI-lane run over
  `language/module-code|language/import|language/export|language/block-scope|language/statements/switch` has no pass
  → fail against the baseline column above, on standalone. The completed ES5 edition stays at its floor.
- `tests/issue-7470-same-named-module-bindings.test.ts` stays green after every child.
