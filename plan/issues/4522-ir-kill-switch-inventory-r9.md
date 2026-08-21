---
id: 4522
title: "Inventory and retirement plan for the 13 JS2WASM_IR_* env kill-switches — R9 requires them gone, nobody owns the list"
status: done
sprint: current
created: 2026-08-16
updated: 2026-08-21
completed: 2026-08-21
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: ir, tooling
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
related: [3518, 3792]
origin: "tech-lead IR design review 2026-08-16"
---

# #4522 — kill-switch inventory for the R9 flip

## Problem

R9 of #3518 requires all IR/legacy escape hatches and compile-twice switches
removed "from public options, env handling, tests, scripts, and
documentation". Measured 2026-08-16: **13 distinct `JS2WASM_IR_*` env vars**
(~57 references) exist under `src/`:

`JS2WASM_IR_INLINE` (15) · `JS2WASM_IR_FIRST` (10) · `JS2WASM_IR_SHAPE_DIAG`
(7) · `JS2WASM_IR_I…` (4) · `JS2WASM_IR_POSTCLAIM_LOG` (3) ·
`JS2WASM_IR_OWNERSHIP` (3) · `JS2WASM_IR_OBJECT_SHAPES` (3) ·
`JS2WASM_IR_GVN` (3) · `JS2WASM_IR_ESCAPE` (3) · `JS2WASM_IR_ASYNC` (3) ·
`JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` (2) · `JS2WASM_IR_STRING_BUILDER` (2) ·
`JS2WASM_IR_GVN_DEBUG` (1)

These are not one category, and R9 must not delete them uniformly:
diagnostics (`*_DIAG`, `*_LOG`, `*_DEBUG`) and self-checks
(`VERIFY_DOMINANCE_NAIVE` cross-checks the fast dominance algorithm against
the naive one) are healthy and should SURVIVE; feature kill-switches
(`IR_FIRST`, `IR_STRING_BUILDER`, pass toggles) are the R9 debt. Nobody owns
the classification today, and rediscovering it at flip time is exactly the
kind of last-minute audit R9 should not depend on.

## Acceptance criteria

- [x] A table in this issue (or `plan/log/ir-adoption.md`) classifying every
      `JS2WASM_IR_*` var: keep-as-diagnostic / keep-as-self-check /
      retire-at-R9 (with the retiring issue or R-slice named) /
      retire-now-already-dead.
- [x] Any var classified retire-now is actually removed in the same PR, with
      grep-zero evidence. *(Vacuous: no var classified retire-now — every
      reader is live; see the table.)*
- [x] A one-line guard is added to the R9 acceptance checklist in #3518
      pointing at this inventory, so the flip consumes it rather than
      re-auditing.

## The inventory (measured 2026-08-21)

**14 vars now, not 13** — `JS2WASM_IR_CUTOVER_AUDIT` was added after this
issue was filed; the truncated `JS2WASM_IR_I…` in the problem statement is
`JS2WASM_IR_I32_DOMAIN`. The classification key: a var is **R9 debt exactly
when flipping it selects the legacy/direct path or a legacy representation**
("IR/legacy escape hatches and compile-twice switches", #3518 R9). A toggle
over an IR-internal pass, experiment, or log never resurrects the direct
front-end and survives the flip — the problem statement's blanket "pass
toggles are the R9 debt" is corrected accordingly, per-var below.

| Var | Default | What flipping does | Classification | Retired by |
| --- | --- | --- | --- | --- |
| `JS2WASM_IR_FIRST` | on | `=0` disables IR-first legacy-body skipping — forces compile-twice | **retire-at-R9** (named in the R9 row of #3518 itself) | R9 |
| `JS2WASM_IR_STRING_BUILDER` | on | `=0` forces builder loops to legacy (`string-builder-candidate`) | **retire-at-R9** — legacy escape hatch; its always-deferred sibling arm (`containsCountedLiteralStringAppend`, the #1004 repeat-fold) is a selector gap #3518's coverage closure must own, not an env var | R9 |
| `JS2WASM_IR_ASYNC` | on | `=0` clears `supportsAsyncIr` — async bodies route to legacy | **retire-at-R9** | R7 (#3527/#1373b) then R9 |
| `JS2WASM_IR_OBJECT_SHAPES` | on | `=0` reverts to the legacy boxed-externref object representation | **retire-at-R9** — legacy-representation escape hatch | R9 |
| `JS2WASM_IR_INLINE` | on | `=0`/tuned sets control the IR-level inliner (#4157) | keep-as-tuning — IR pass config, no legacy involvement (a `-O`-style knob) | — |
| `JS2WASM_IR_GVN` | off | `1` enables the GVN pass; `poison` runs the liveness self-check | keep-as-experiment + self-check — IR pass, no legacy; its owner decides the default flip | — |
| `JS2WASM_IR_GVN_DEBUG` | off | debug prints for GVN | keep-as-diagnostic | — |
| `JS2WASM_IR_I32_DOMAIN` | off | `=1` opts in to the experimental i32 domain propagation | keep-as-experiment — pre-default gate on IR-internal analysis, no legacy | — |
| `JS2WASM_IR_OWNERSHIP` | off | `=1` runs the gated annotation-only ownership analysis | keep-as-diagnostic/experiment | — |
| `JS2WASM_IR_ESCAPE` | off | `=1` runs the gated annotation-only escape classification | keep-as-diagnostic/experiment | — |
| `JS2WASM_IR_SHAPE_DIAG` | off | `=1` records per-shape rejection attribution | keep-as-diagnostic | — |
| `JS2WASM_IR_POSTCLAIM_LOG` | off | `=<path>` appends post-claim JSONL records | keep-as-diagnostic | — |
| `JS2WASM_IR_CUTOVER_AUDIT` | off | `=<path>` appends cutover-invocation audit records | keep-as-diagnostic — explicitly serves the R9/R10 audits | — |
| `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` | off | `=1` cross-checks fast dominance against the naive algorithm | keep-as-self-check | — |

Nothing is retire-now-already-dead: every var has a live reader under `src/`
(verified by the per-var grep above the table's compilation, 2026-08-21).

The four retire-at-R9 vars are exactly the ones whose removal is already part
of R9's own acceptance text ("hybrid demotion, `experimentalIR: false`,
`JS2WASM_IR_FIRST`, `disableIrFirst`, skip allowlists, and compile-twice
switches are gone") — this table makes the "compile-twice switches" set
concrete: `JS2WASM_IR_FIRST`, `JS2WASM_IR_STRING_BUILDER`,
`JS2WASM_IR_ASYNC`, `JS2WASM_IR_OBJECT_SHAPES`.
