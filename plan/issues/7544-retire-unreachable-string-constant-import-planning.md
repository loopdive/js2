---
id: 7544
title: "`planProgramAbiStringConstantImport` and the host `string_constants` import path are unreachable"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: codegen
goal: core-semantics
related: [6979, 7473, 3520]
---

# #7544: retire the unreachable host string-constant import path

`planProgramAbiStringConstantImport` (`src/codegen/program-abi-import-planning.ts:941`) has one caller,
`src/codegen/registry/imports.ts:278`. That call sits after `if (ctx.nativeStrings) { …; return; }`, and since #6979
S7 every live target has `nativeStrings` on (`nativeStrings: false` is a compile error). So the host
`string_constants` / `string_constants16` global-import loop and its ABI planning never run.

Its only test was the `tests/issue-3520-imported-global-abi.test.ts` host case. Under #7473 that case now asserts the
#6979 refusal. Noted by RV-S25 on #7473 and confirmed by lane S25 (2026-11-26).

Backlog: per the project direction, deleting JS-host code needs its own reviewed change, not an opportunistic one.

## Acceptance criteria

- The loop and `planProgramAbiStringConstantImport` are deleted, together with everything only they use.
- gc, standalone and WASI output stay byte-identical on the playground corpus.
- `check:dead-exports` and the equivalence gate pass.
