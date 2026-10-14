---
id: 6985
title: "lodash-es: wasm-opt -O4 times out in coalesce-locals on `__runtime_eval_pull_globals` (regime and host lanes)"
status: ready
created: 2026-10-14
updated: 2026-10-14
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: optimizer, codegen
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 5385
related: [6983, 6708, 4586]
---

# #6985 — lodash-es `-O4` timeout in `coalesce-locals`

Found while fixing #6983 (npm-compat parity of the native regime). The
lodash-es `js-host-native` perf lane reports `optimization-error`: `wasm-opt
-O4` with `flatten` omitted (#4586) exceeds the 600 s budget. It is **not** a
regime regression — the host-assisted lane already fails at run time — but it
blocks a `measured` row on every lane that reaches `-O4`.

## Measured (2026-10-14, #6983 agent, upstream main `dd15b6d00c`)

- With the #6983 return-tail funnel applied, lodash-es `-O4` still takes
  **1,060 s**; the time is in `coalesce-locals` (590 s + 169 s across its two
  invocations), not in `code-folding` (prettier's case, fixed by #6983).
- The dominant function is `__runtime_eval_pull_globals`: one huge function
  with a local count and live-range structure that makes Binaryen's
  interference-graph construction quadratic.
- prettier's `-O4` dropped from 832 s to 154 s with the funnel, so the two
  packages have different root causes.

## Plan

1. Measure first: dump the lodash-es regime binary (`DUMP_BIN=` path in
   `scripts/lib/npm-compat-perf.mjs`), run `wasm-opt --coalesce-locals` on it
   alone with `--pass-arg` timing, and record the local count / size of
   `__runtime_eval_pull_globals` and the next three largest functions.
2. Shrink the generator: `__runtime_eval_pull_globals` is emitted by the
   runtime-eval linking path (`src/runtime-eval.ts` / the eval provider
   bridge); split it per module-global chunk (e.g. 256 globals per helper) or
   emit a table-driven loop instead of one straight-line function, so no
   single function carries thousands of locals.
3. If the emitter cannot be split cheaply, bound the optimizer instead:
   `src/optimize.ts` already omits `flatten` for these binaries; add a
   per-function size guard that runs `coalesce-locals` with
   `--pass-arg=coalesce-locals-max-locals=<N>` or skips it for functions
   above the threshold, and record the omitted pass in
   `optimizationOmittedPasses` the way `flatten` is recorded today.
4. Acceptance: lodash-es `js-host-native` and `standalone` lanes reach
   `measured` under the 600 s budget in a local `--only lodash-es --perf-only`
   run; standalone binaries of the 13 playground examples stay byte-identical
   unless the emitter change is deliberate (then the equivalence gate must
   say "No new equivalence regressions"); a focused test asserts the emitted
   `__runtime_eval_pull_globals` family stays below the chosen local bound.
