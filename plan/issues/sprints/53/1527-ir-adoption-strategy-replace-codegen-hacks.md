---
id: 1527
sprint: 53
title: "IR adoption strategy: replace codegen hacks, preserve linear/GC backend split"
status: ready
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen, ir
goal: compiler-architecture
related: [1098, 1131, 1376, 1526]
---

# #1527 — IR adoption strategy: replace codegen hacks, preserve linear/GC backend split

## Problem

The project carries **three live code-generation paths**:

| Path                  | Role                                                        |
|-----------------------|-------------------------------------------------------------|
| `src/codegen/`        | Legacy direct AST→Wasm path. Default fallback.              |
| `src/codegen-linear/` | **Backend choice**: linear memory lowering (e.g. WASI).     |
| `src/ir/`             | **Orthogonal layer**: typed IR built from the AST that the  |
|                       | backends can lower from. Currently `experimentalIR: true`   |
|                       | by default (`src/compiler.ts:350`).                         |

A prior framing called these "three competing paths". That framing is
wrong:

- **Linear memory and WasmGC are alternatives**, not one superseding the
  other. Both will remain — the choice depends on the target (WASI vs
  browser, perf vs interop, etc.).
- **IR is orthogonal** to that choice. Its purpose is to replace the
  accumulated direct-codegen hacks (155+ workarounds per #1098) with a
  principled typed representation that **either** backend can lower.

The current state mixes the two axes. `from-ast.ts` (4,227 LOC) is doing
AST→IR for some node kinds; legacy codegen handles the rest; the linear
backend handles only `target: "linear"` end-to-end. IR-path failures are
silently demoted to warnings (`src/compiler.ts:889–896`) so test262
doesn't break — meaning real bugs in the default path are masked by the
fallback.

## Acceptance criteria

1. **Architecture doc** at `docs/architecture/codegen-axes.md`:
   - Axis 1: lowering target (linear memory vs WasmGC). Both stay.
   - Axis 2: front-end (direct codegen vs IR). IR replaces direct.
   - Phasing plan: which AST node kinds the IR currently owns; which
     are next; which are deferred because they would force a premature
     backend decision.
2. **IR adoption table** in the doc (or `plan/log/ir-adoption.md`):
   for each AST node kind, list status (`ir-owned`, `direct-only`,
   `mixed`, `deferred`) and the reason. Generated from a tiny inspector
   over `src/ir/from-ast.ts` if feasible; otherwise hand-maintained.
3. **IR fallback warning ratchet**: the existing IR fallback gate
   (#1376) already enforces a baseline. Tighten the policy so any node
   kind newly adopted by IR cannot regress to the warning channel —
   either it works through IR or the PR is rejected. (See #1530 for the
   broader phase-out.)
4. **Decoupling test**: a unit test that exercises a small program
   end-to-end through (IR → linear backend) and (IR → WasmGC backend)
   and asserts byte-equivalent (or at least semantics-equivalent)
   output for the common cases. This guards the orthogonality claim.
5. **No hidden backend bias in IR**: review `src/ir/` for any decision
   that picks WasmGC over linear (or vice versa) and either lift the
   choice to a backend trait or document it explicitly.

## Implementation notes

- This is a planning + small-refactor issue. The big work of moving
  more AST kinds through IR continues issue-by-issue (#1370-series,
  etc.) — this issue documents the rules under which they happen.
- The architecture doc must be terse — anyone touching codegen should
  be able to read it in 10 minutes and know which axis their change
  touches.
- Coordinate with #1530 (IR fallback phase-out priority) — that issue
  drives the timeline; this one defines the rules.
