---
id: 6985
title: "lodash-es: wasm-opt -O4 times out in coalesce-locals on `__runtime_eval_pull_globals` (regime and host lanes)"
status: done
assignee: ttraenkler/opus-6985-lodash
created: 2026-10-14
updated: 2026-10-15
completed: 2026-10-15
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

## Implementation notes (2026-10-15, upstream main `c7ea9e6d31`)

### Measured before the fix — the premise was half right

All numbers on one macOS box, Binaryen 132 (`node_modules/.bin/wasm-opt`),
`-O4 --skip-pass=flatten` with the shipped feature flags. The 1,060 s figure
from #6983 was measured on another machine and base; on this one the same pipeline is ~600 s,
which is exactly the budget, so the lane flips between `measured` and
`optimization-error` with machine load.

Unoptimized lodash-es `js-host-native` binary (6,794,457 B):

| function | body bytes | locals |
| --- | ---: | ---: |
| `__runtime_eval_pull_globals` | 546,226 | **8,989** |
| `__call_fn_method_8` | 83,368 | 1,348 |
| `__call_fn_method_7` | 81,802 | 1,324 |
| `mergeData` | 208,286 | 1,317 |

The standalone binary (`runtimeEvalProvider: false`) has **no** pull helper at
all; its largest are `__call_fn_method_8` (193,378 B / 3,688 locals) and
`_7`/`_6`/`_5`.

`BINARYEN_PASS_DEBUG=1` per-pass timing of the host binary: total 722 s
(with per-pass validation), of which **`inlining-optimizing` 486 s** and the
top-level `coalesce-locals` 67 s. Nested passes inside `inlining-optimizing`
are not itemized by Binaryen — that is where the "590 s + 169 s
coalesce-locals" of the #6983 profile lives. Plain run (no debug): **606 s**.

Isolating `inlining-optimizing` (run the -O4 prefix up to `dae-optimizing`,
then the pass alone, `-g` both sides) showed the real hotspot: Binaryen's
one-caller rule (`-ocimfs`, unlimited by default) inlines **every
`__module_init_chunk_*`** back into `__module_init`, producing one 985,368 B
function that the post-inlining pipeline then re-optimizes serially.
`inlining-optimizing` alone: **402 s**; with the chunks marked no-inline:
**72 s**.

### What changed

1. **Emitter (`src/codegen/expressions/runtime-eval-provider.ts`).** The pull
   helper inlined, per script-global binding, the realm read (which the
   native-first regime expands into an inline property fast path, ~170 WAT
   lines), the provider-carrier decode, the interpreted-callable adapter and
   the externref→typed coercion. These are now shared out-of-line helpers:
   `__runtime_eval_pull_read(realm, key)` (read + decode),
   `__runtime_eval_pull_value(v)` (decode only, for the lexical-cell loop) and
   one `__runtime_eval_pull_coerce_<type>` per distinct target type. The pull
   body is a flat `local.get; key; call; [call]; global.set` per name.
   The read helper carries the decode INLINE rather than calling the value
   helper: a 4-instruction `get; call; call` body is cheaper than its call
   site under the in-tree inliner's "specialised" rule (`ir-inline.ts`), which
   then copied it back into every name (measured: 1,631 locals left).
   lodash-es: `__runtime_eval_pull_globals` 546,226 B / 8,989 locals →
   **10,597 B / 1 local**; top-level `coalesce-locals` drops out of the
   per-pass top list.
2. **Optimizer (`src/optimize.ts`).** `--no-full-inline
   --pass-arg=no-full-inline@__module_init_chunk_*` before `-O<level>`. This
   is the boundary the in-tree inliner already draws
   (`moduleInitInlineBoundary`). `no-full-inline` rather than `no-inline`
   because each Binaryen no-inline pass takes ONE pattern and `no-inline` is
   already the cold-constructor hint (`inline-hints.ts`); verified both
   patterns are honoured together. It is not an omitted pass, so
   `optimizationOmittedPasses` is unchanged (still `["flatten"]`).
   `scripts/compiler-extension-boundaries.json` re-pins the `optimize.ts`
   blob digest (`optional-binaryen-provider-v1`), as every `optimize.ts`
   edit does.

### After

| lane | base: status / compile (incl. wasm-opt) | after: status / compile | after: ratio (wasm µs / node µs) |
| --- | --- | --- | --- |
| `js-host-native` | measured, **544 s** (56 s under budget; 606 s plain `-O4` in isolation) | measured, **149 s** (165 s lane wall) | 0.0214 (57.0 / 1.22) |
| `standalone` | measured, 177 s | measured, **158 s** (173 s lane wall) | 0.0547 (9.54 / 0.52) |

Plain `-O4` minus flatten, host binary, emitter change only: 606 s → 530 s.
Both lanes run with `JS2WASM_EVAL_ENGINE=interpreter` after
`build:compiler-bundle` + `build-runtime-eval-provider.mjs --refusal-only`
(the refusal provider key changes with the compiler bundle, so it must be
rebuilt after every source edit or the host lane fails at instantiate with
`module="js2wasm:runtime-eval": module is not an object`). Ratios are a
single local run; node timings drift run to run, so no perf claim is made.

### Validation

- `tests/issue-6985-lodash-es-o4.test.ts`: pull locals ≤ 4 and constant from
  20 to 400 globals on native-first and standalone (base: 2,008 locals at
  400), the read helper is not inlined back, `-O4` keeps every module-init
  chunk (base: 0 of 11 left), and a program without runtime eval emits no
  pull helpers. Fails on base, passes after.
- Byte identity: the 13 playground examples × {host, native-first,
  standalone} (32 compiled; 7 DOM examples are rejected by native-first on
  both sides) are identical base vs after, unoptimized AND at `optimize: 4`.
- Equivalence gate (`scripts/equivalence-gate.mjs` run from a `.tmp` copy that adds `--configLoader runner`, because this sandbox cannot write `node_modules/.vite-temp`): "✓ No new equivalence regressions."
  (22 failing = 22 known, 1,748 passing).
- Pre-existing, unchanged by this PR (fail identically on base):
  `issue-2928-direct-eval-state-pool` (2 tests), `issue-4922-runtime-eval-
  object-callable` (1 test).

### Left out

- `__runtime_eval_push_globals` still allocates one short-lived local per
  name (1,187 for lodash-es); its live ranges are one instruction long and it
  no longer shows in the timing, so it was not touched.
- The `__call_fn_method_N` family (up to 3,688 locals in the standalone
  binary) is the next largest local count; standalone `-O4` is ~160 s, so it
  is not on the budget's critical path today.
