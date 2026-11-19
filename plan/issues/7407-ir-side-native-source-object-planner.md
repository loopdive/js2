---
id: 7407
title: "IR-side planner for native source-object call rows, so native-invocation-abi.ts holds one concern"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, backend
goal: ir-full-coverage
depends_on: [7354]
related: [7354, 3518]
origin: "2026-11-19 #7312 review (RV7312): the rebuttal on the native-invocation-abi.ts should-fix was accepted on condition that the split is filed"
---

# #7407: IR-side planner for native source-object call rows

## Problem

`src/backend/wasmgc/program/native-invocation-abi.ts` plans two families of
native call rows:

- the invocation substrate's rows (`nativeInvocationAbiBindings`);
- since #7354 O1, the realm-served `js.object.*` source-object rows
  (`planNativeSourceObjectSetup`).

Both build their rows through the shared `nativeCallAbiBindings`, and the row
type is `NativeCallAbiBinding`. The module header names both families. The
reviewer of #7312 asked for one concern per module. The two obvious fixes both
fail a gate, measured on `claude/7354-realm` 39b631a9c6:

- **Rename to a native-call ABI module** fails
  `check-compiler-boundaries --mode inventory` with
  `activation-demoted: backend-wasmgc`. The file is a layer entry, and the
  gate refuses to drop an entry that main's policy has.
- **Move the source-object rows to their own backend module** adds an
  ir→backend edge (26 → 27), the edge cd03504321 removed.

## Implementation Plan

Target structure:

- The served-contract list (which `js.object.*` features the realm serves, and
  under which key) is declared on the IR side, next to the contracts in
  `src/ir/runtime/ordinary-object-callables.ts` or in a sibling module under
  `src/ir/program/`.
  Today it is the key set of `ROWS` in
  `src/backend/wasmgc/resources/native-source-objects.ts`.
- An IR-side planner builds the source-object call rows from that list and from
  the program's `js.object.*` call sites. `program-physical-plan.ts` asks it,
  so `native-invocation-abi.ts` no longer plans source-object rows.
- `native-source-objects.ts` keeps only the backend half: each served
  contract's row (adapter body or bound realm function). Its key derivation
  reads the IR-side list, which removes the duplicate key logic.

Acceptance:

- Correctness: the #7354 O, O2 and O4 suites, the R provider census suite and
  the #3518 realm-source-integration suite pass unchanged. Ordinary-pipeline
  bytes are identical: 13 playground examples × default and standalone.
- Code quality:
  - `native-invocation-abi.ts` plans only invocation rows;
  - the served-contract list has one definition;
  - `check:import-cycles` and the boundaries inventory keep their counts (no
    new edges in either direction);
  - no grants.
