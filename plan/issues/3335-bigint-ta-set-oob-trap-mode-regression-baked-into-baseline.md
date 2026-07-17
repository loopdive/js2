---
id: 3335
title: "Six TypedArray/set/BigInt failures worsened catchable-error → uncatchable oob trap on main; scheduled baseline refresh baked the worse mode in"
status: done
completed: 2026-07-17
assignee: ttraenkler/opus-3335
sprint: current
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
created: 2026-07-17
related: [3189, 3198, 3177, 3087, 1349]
# (#3335) Intentional growth of two god-files: the latent-bug fixes live in the
# host-marshalling runtime and the dynamic-call codegen — both pre-existing
# over-threshold files with no smaller home. Grant this change-set's growth.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/calls.ts
---

# #3335 — BigInt TA `set` failure-mode regression (catchable → oob trap) + baseline-refresh process gap

## Problem (two parts)

**Part 1 — the regression.** A merge on main between `deee48c` and `956e09b9ec`
(2026-07-17, roughly 01:00–04:00Z window) changed the failure MODE of six
`test/built-ins/TypedArray/prototype/set/BigInt/*` files from a catchable
JS error ("undefined is not a constructor") to an **uncatchable Wasm
`offset is out of bounds` trap**. Pass-count was unchanged (fail→fail), so no
regression gate flagged it — only the #3189 oob-trap ratchet moved (45→51, +6).

**Task:** bisect for the culprit and restore a catchable failure mode.

## Part 2 — the process gap

The scheduled baseline refresh captured the worse mode into
`js2wasm-baselines`, silently RAISING the #3189 ratchet floor from 45 to 51.

**Task:** make the scheduled/promote baseline refresh refuse (or loudly flag)
an INCREASE in the oob-trap count relative to the previous baseline.

## Root cause (verified 2026-07-17, fable-oob)

**There is no culprit merge.** The window `deee48c..956e09b9ec` contains ONE
code merge (dc8df9fe87, PR #3197) touching only two `plan/issues/*.md` files —
zero compiler change. The two baselines were written by different pipelines
minutes apart on identical code, and the six files flip **nondeterministically
per run**:

- **Trap mode (pristine realm — the "true" behavior):** the runner's #3087
  BigInt harness shim `__ta_makeCtorArgBigIntCompat` deliberately maps
  array args → `null` (to preserve the pre-#3087 pass set pending #1349
  BigInt i64 rep). `new BigInt64Array(null)` builds a LENGTH-0 view (legal
  JS), and the six set-path tests then hit the host RangeError
  `offset is out of bounds` from `.set(src, 0)` on the empty view. This is a
  **catchable host RangeError**, but `classifyError`'s `/out of bounds/i`
  bins it as an uncatchable oob trap, and `test262-poison-error.mjs` matches
  it too (poison retry / worker recycle — the baseline entries carry
  `retried: true`).
- **"Catchable" mode (contaminated realm):** when an earlier test in the same
  fork worker clobbers `globalThis.BigInt64Array`, the harness ctor lookup
  yields undefined → `__construct_closure` throws "undefined is not a
  constructor". Which mode a run records depends on chunk composition /
  realm-recycle timing → the 45↔51 baseline flap; PRs #3177/#3198 parked as
  collateral.

Two REAL latent bugs found while tracing (both fixed here):

1. **`tryEmitInlineDynamicCall` silently dropped host-function callees**
   (`src/codegen/expressions/calls.ts`): the dynamic any-callee dispatch had
   only closure-struct arms with a bare `ref.null.extern` default, so calling
   e.g. a `Function.prototype.bind` result received through an any-typed
   closure param produced `null` instead of invoking (repro: harness
   `argFactory.bind(undefined, ctor)` shape). Fixed: host-lane default arm
   now dispatches through `__call_function` (args array via
   `__js_array_new`/`__js_array_push`), which also throws the spec TypeError
   for non-callables instead of silently yielding `undefined`.
2. **Dynamic host-construct args crossed as opaque structs**
   (`src/runtime.ts`): `__construct`/`__construct_closure`/`__reflect_construct`
   only marshalled compiled-ArrayBuffer vec structs (#3097). A compiled ARRAY
   vec struct stayed opaque → host TypedArray ctors built length-0 views.
   Fixed: `_marshalHostConstructArg` also materializes readable vec structs to
   real host Arrays (`_materializeIterable`), and — refuse-loudly — throws a
   catchable TypeError when a host %TypedArray% ctor receives an opaque
   compiled value none of the probes can decode.

## Fix

- **Failure-mode fix (the six files):** the #3087 shim now maps arrays →
  `x.length` instead of `null` (`tests/test262-runner.ts`), building a
  CORRECT-LENGTH zero-filled view. The set-path files now fail with a
  catchable "Cannot convert 42 to a BigInt" TypeError (deterministic,
  realm-independent). Verified via the real fork-worker chunk path over the
  whole `TypedArray/prototype/set/BigInt` dir: **statuses byte-identical to
  the baseline (22 pass / 27 fail, zero flips), oob-classified errors 6 → 0,
  poison-classified errors (incl. "Invalid typed array length") → 0.**
  Ratchet returns 51 → 45 (the +6 all sat in this dir).
- **Part 2 gate:** new `scripts/check-baseline-trap-growth.ts` — diffs the
  candidate baseline jsonl against the previous one with the #3189
  `evaluateTrapCategoryGrowth` logic and REFUSES the baselines-repo push when
  any trap category grew. Wired into both writers:
  `test262-sharded.yml` promote-baseline and `refresh-baseline.yml` (scheduled;
  FORCED/emergency refresh bypasses by design). Override for intentional
  reclassifications: repo Actions variable `BASELINE_TRAP_GROWTH_ALLOW`
  (per-category tolerance, one cycle, then reset to 0) — mirrors
  `TRAP_RATCHET_TOLERANCE`.

## Notes / follow-ups

- The six files can only genuinely PASS after #1349 (BigInt i64 value rep) —
  element values are still zeros / f64-lowered numbers.
- `classifyError` still bins host RangeError "offset is out of bounds" as a
  wasm oob trap by message; distinguishing `WebAssembly.RuntimeError` from
  host `RangeError` at record time would be a verdict-logic change requiring
  an ORACLE_VERSION bump — deliberately NOT done here.
- Resolution note for #3198/#3177 (parked as collateral): the +6/same-six
  signature was this flap, not a regression in those PRs.

## Test Results

- `.tmp` probe (fork-worker chunk path, `TEST262_PATH_FILTER=TypedArray/prototype/set/BigInt`):
  22 pass / 27 fail — identical file-level statuses to baselines@f4d1367;
  oob-classified 6 → 0; poison-classified 0.
- Minimal repros: bound-fn-via-any-param call returns its arg (was null);
  wrapped `array-arg-set-values.js` now throws catchable
  "Cannot convert 42 to a BigInt" in the pristine-realm mode.
