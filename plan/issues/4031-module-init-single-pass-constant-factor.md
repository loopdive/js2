---
horizon: l
id: 4031
title: "The one remaining module-init compile is 51% of the ESLint compile"
status: ready
created: 2026-08-01
updated: 2026-08-09
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
loc-budget-allow:
  - src/codegen/expressions/calls.ts
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

## 2026-08-09 progress

The first concrete attribution is a bundled-entry case rather than a uniformly
expensive statement list. The published TypeScript entry has only two top-level
statements: a small `var ts = {}` declaration and one 9.1 MB esbuild IIFE. Its
AST contains about 1.08 million nodes, 11,065 functions, and 9,101 arrows.

One safe constant factor is now removed: `compileIIFE` no longer walks the
complete IIFE twice to discover captures when the enclosing module initializer
has an empty local map. That is an exact no-capture proof and matters for
bundled npm packages whose entry point is one giant IIFE (TypeScript's
published `lib/typescript.js` is about one million AST nodes).

An attempted broader optimization used an unchanged inlinable-function
registry as proof that the second module-init compile was redundant. The proof
was insufficient: the merge-group Test262 run lost 116 host passes, fell 272
standalone host-free passes below the committed high-water mark, and grew
uncatchable trap categories. In a positive-control local A/B, restoring the
second pass flipped six representative `decodeURI`/`decodeURIComponent` files
from out-of-bounds traps back to pass with no losses (6 gained, 0 lost across
8 measured files). The second compile therefore remains conservative while
this issue stays open for a sounder proof.

The capture-scan skip is intentionally limited to an actually empty local map.
A function-local binding may shadow a registered top-level function, so the
presence of a same-named entry in `ctx.funcMap` is not proof that the binding
cannot be captured. Permanent coverage exercises that boundary. The full
TypeScript bundle remains a bounded compile frontier; the next measurement
must use the same supervised `compileProject` harness.

## Acceptance criteria

- Sub-phase attribution inside the module-init compile, recorded here.
- A measured reduction, or a recorded finding that the cost is inherent with the
  evidence for it.
- No behavioural change: the emitted initializer must stay identical, verified
  the way #4001 was (run the module, do not compare bytes).
