---
id: 7508
title: "Prepared path crashes on a local export of a name that is not a top-level var or function"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
goal: backend-agnostic-ir
related: [7500, 7488, 7354]
---

# Prepared path crashes on an unresolved local export

## Problem

On the Prepared whole-program path, a local `export { x }` clause whose `x` is not a top-level `var`/`let`/`const`
identifier or a function declaration makes `compile()` throw: `buildIrModuleInitPlan` records an
`unresolved-export-target` gap, which reaches the final validation (`startup source … retains unresolved
binding/export gaps`). Found by the plan review of #7500 (PRV-7500), 2026-11-26.

## Repros (PR 7458 head `f0de1a53`; still throwing with #7500's first, class-only plan applied)

| Program | Prepared |
| --- | --- |
| `import { a } from './m'; export { a };` | crash |
| `import * as m from './m'; export { m };` | crash |
| `export { zz };` (undeclared: a module early error) | crash |
| `declare function f(): void; export { f };` (.ts) | crash |
| `type T = number; export { T };` (.ts) | crash |
| `import x = require('m'); export { x };` (.ts) | crash |

The open question was the owner: these programs have no unit, so a refusal could not be located through
`preparedIrProgramOwner`; it needed a source-level owner or a change to the failure contract.

## Resolution

Covered by the generic rule from [#7500](7500-prepared-path-export-class-crash.md): an unresolved local export
specifier is refused at select as `export-target-unsupported`, located at the specifier through a source-level owner
(`PreparedIrProgramFailure.unitId` is nullable). The six programs above are pinned in `tests/issue-7500-prepared-export-refusals.test.ts`.
