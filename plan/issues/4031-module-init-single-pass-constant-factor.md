---
horizon: l
id: 4031
title: "The one remaining module-init compile is 51% of the ESLint compile"
status: ready
created: 2026-08-01
updated: 2026-08-01
assignee: unassigned
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler, codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
es_edition: n/a
related: [3672, 4001]
---

# #4031 — the surviving graph-initializer compile dominates the ESLint compile

## Problem

#4001 removed the quadratic: the accumulated `__module_init` is now compiled
twice per graph instead of `2n` times. What remains is a **constant-factor**
problem, and it is the single largest phase left.

Measured on ESLint `linter.js` (146 sources, `--target gc`, `platform: node`,
solo run, `JS2WASM_COMPILE_PROFILE=1`):

| phase | self | share |
| --- | --- | --- |
| `module-init-pass1` | 119.79 s | **51.0 %** |
| `bodies/code-path-analysis/code-path-state.js` | 21.96 s | 9.3 % |
| `bodies/@eslint-community/eslint-utils/index.mjs` | 18.25 s | 7.8 % |
| `bodies/languages/js/source-code/source-code.js` | 13.58 s | 5.7 % |
| `analyze` (TypeScript parse/bind/check) | 4.37 s | 1.8 % |

801 module-init statements in ~120 s is roughly **150 ms per statement**, which
is far out of line with the per-source body phases and suggests the cost is not
inherent to the statement count.

## Caveat on the numbers

This is measured on a compile that still **aborts at a frontier error** (#4027 /
#4028), so it is a budget on a partial compile. The share may move once those
land and more of the graph is actually lowered. Re-measure before optimising —
do not treat 51 % as a fixed target.

## Investigation

- Profile *within* `compileModuleInitBody` — is the cost per statement, or
  concentrated in a few statements (e.g. one enormous CJS bundle's top level)?
- The per-file profiler already shows `eslint-scope.cjs` owning the whole
  pass-1 cost, since pass 1 runs on the first source; attribute inside it.
- Determine whether pass 1's *result* is needed at all, or only its side effects
  on `closureMap` — if the latter, a cheaper discovery walk may replace a full
  statement compile.

## Acceptance criteria

- Sub-phase attribution inside the module-init compile, recorded here.
- A measured reduction, or a recorded finding that the cost is inherent with the
  evidence for it.
- No behavioural change: the emitted initializer must stay identical, verified
  the way #4001 was (run the module, do not compare bytes).
