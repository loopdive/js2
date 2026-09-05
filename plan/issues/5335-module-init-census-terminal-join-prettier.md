---
id: 5335
title: "P1 — prettier: multi-prepared-module-init-census terminal-join rejects 13/16 modules"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`prettier` is at **2/151** on `main`. Filed separately from #5333 because it is a
**different defect with a different failure mode**, found while bisecting that one.

- #5333 is an **invalid-Wasm** regression from PR #5390 — modules build and are then
  rejected by `WebAssembly.compile`. Fixing it restores moment 0/10 → 10/10 but leaves
  prettier at 2/151.
- This issue is a hard **codegen error**: 13 of prettier's 16 modules never produce a
  binary at all.

```
Codegen error: multi-prepared-module-init-census:terminal-join: executable source
ir-source:v1:0000000000000000:source:tests%2Fdogfood%2F.npm-upstream-suites%2Fprettier%2Fsrc%2Fcommon%2Fast-path.js
lost its exact module-init terminal
```

Measured on `b67ab1fc0e` + the #5333 fix, `node --import tsx tests/dogfood/prettier-upstream-suite.mjs`:

```
compile.validated 3 of 16 · 2/151 admitted original tests pass in Wasm
13x  Codegen error: multi-prepared-module-init-census:terminal-join: … lost its exact module-init terminal
 3x  ok
```

Affected sources: `src/common/ast-path.js`, `src/document/*`, `src/utils/*`.

## Suspect

`944643dcde` — PR #5598 `feat(ir): retain ordered multi-source module-init census`, which
adds `src/codegen/multi-prepared-module-init-census.ts`, the file that raises this exact
message. **Not yet confirmed by measurement** — the #5333 bisect used moment, where this
error never appears, so the prettier lane was never bisected on its own. A second agent
independently attributed prettier's drop to #5598 before #5333 was isolated.

## Next step

Bisect `prettier`'s `compile.errors` (not `compile.validated`) across
`4946cf70fe..b67ab1fc0e`. Use `470ceba797` (#5390 landed, #5598 not yet) as the decisive
point: if `terminal-join` already appears there, #5598 is not the cause.

Reference before-numbers: prettier was **61/151** at `4946cf70fe`, and is expected to
reach ~101/151 once #5606 is in (it landed in `6d0ae7531d`).
