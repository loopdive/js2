---
id: 7459
title: "test262 worker: two remaining places score any throw of a runtime negative as a pass"
status: done
created: 2026-11-23
updated: 2026-11-26
completed: 2026-11-26
priority: medium
horizon: s
goal: ci-hardening
sprint: Backlog
related: [7354, 7453]
---

# #7459 — test262 worker: two remaining places score any throw of a runtime negative as a pass

## Problem

After #7354 slice X a runtime negative passes only when the thrown value's error kind was read. Two places still accept any throw: the exported-`test()` catch in `scripts/test262-worker.mjs` (about line 2907; it looks unreachable while the lanes send `originalHarness: true`, not proven) and `scripts/wasm-exec-worker.mjs` (the single-file fallback lane behind `tests/test262-vitest.test.ts`; no CI workflow uses it).

## Acceptance criteria

- Both call the one rule (`runtimeNegativeThrowAccepted`), or the unreachable one is deleted with the proof.
- `ORACLE_VERSION` bumped if any row can flip.

## Result (2026-11-26, with #7453)

- `runtimeNegativeThrowAccepted` lost its `originalHarness` parameter and with it the any-throw escape; every lane
  asks the same kind rule.
- The worker's exported-`test()` catch reads the value once and asks the rule (it is reachable: `compiler-pool.ts`
  defaults `originalHarness` to `false`, so it was not deleted).
- `scripts/wasm-exec-worker.mjs` drops its own reader (`extractWasmExceptionInfo`) for `readThrownValue` and asks the
  rule at instantiate, `__module_init` and `test()`; `tests/test262-vitest.test.ts` passes the expected type through
  `ExecPool.run`, and its fork compiler opts into the kind export. Probe through the worker on head: a matching
  TypeError passes; a RangeError, `throw "TypeError: x"` and `throw 1` now fail (all passed before).
- No CI lane runs either path, so no published row moves; the oracle bump is #7453's (17 → 18).
