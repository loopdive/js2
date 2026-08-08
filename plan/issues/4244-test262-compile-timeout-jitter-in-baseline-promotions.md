---
id: 4244
title: "test262 baselines jitter ±20 tests per promotion — borderline 30s compile-timeouts flip both directions under CI shard load"
status: ready
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: infra
area: test-infrastructure
goal: test-infrastructure
related: [1522, 3467, 3898]
---

# Problem

Consecutive standalone baseline promotions on unchanged code report different
pass counts because tests near the 30-second compile ceiling flip between
`pass` and `compile_timeout` depending on shard load. Measured on 2026-08-08
between the post-#4234 promotion (sha `517d941a`, 14:02Z) and the next
promotion a few hours later:

- ES5 bucket: **20 pass→compile_timeout, 0 semantic failures**, while 10
  unrelated tests improved — a net −5 that rendered on the editions dashboard
  as an apparent 87.1 % → 86.9 % "regression" with no code cause.
- Across all editions, **69 files flipped involving timeouts in both
  directions** in that single promotion pair (list captured at analysis time;
  regenerate by diffing consecutive baseline JSONLs from
  `loopdive/js2wasm-baselines`).
- The baseline's `compile_timeout` count has bounced 15 → 21 → 26 across
  recent promotions.

The flip set is dominated by the known-heavy strict-rerun family
(`Object/defineProperty`, `defineProperties`, `create`,
`getOwnPropertyDescriptor` numbered batteries, `Function/prototype/bind`).

## Why it matters

- The landing page and editions dashboard show phantom ±0.2 pp swings, which
  read as regressions to anyone watching the number (this issue was filed
  after exactly that report).
- The #3467 per-SHA regression diff and the standalone floor/net guards
  (#1897/#2097) consume these baselines; borderline files contribute noise to
  every gate that diffs two runs, and each phantom flip costs triage time.

## Proposed fixes (any one suffices; first is cheapest)

1. **Timeout hysteresis in the runner** (`tests/test262-shared.ts` /
   `tests/test262-runner.ts`): when a test that PASSED in the fetched baseline
   hits the compile ceiling, retry it once sequentially (off the loaded
   worker) before recording `compile_timeout`. A single retry converts nearly
   all load-induced flips back to their true status while leaving genuine
   hangs (which reproduce when retried) unchanged.
2. **Raise the ceiling for a named heavy-family list** — a
   `SLOW_COMPILE_TESTS` set analogous to `HANGING_TESTS`, granting the known
   strict-rerun batteries 60–90 s. Bounded blast radius, but the list needs
   maintenance.
3. **Flip-accounting exclusion**: promotion-side, treat
   `pass ↔ compile_timeout` transitions as `stale` rather than regressions in
   the summary/diff layers (the per-test record keeps the truth). Cheapest,
   but hides real new hangs unless paired with a count ratchet.

Non-goal: raising the global 30 s ceiling for all tests — that inflates
wall-clock for genuinely-hanging compiles (`HANGING_TESTS` exists for a
reason) and masks real compile-performance regressions.

## Acceptance criteria

- Two consecutive promotions on identical code differ by 0
  `pass↔compile_timeout` flips in the ES5 bucket under normal CI load
  (verify by diffing the two JSONLs).
- Genuine hangs still get recorded (a test that times out on the sequential
  retry still reports `compile_timeout`).
- No change to the honest-oracle pass definition; only load-induced
  misclassification is removed.

## Permanent repro

Diff any two consecutive `test262-standalone-current.jsonl` promotions from
`loopdive/js2wasm-baselines` on unchanged code and count
`pass↔compile_timeout` flips (69 across all editions on the 2026-08-08 pair);
the runner behavior under load is exercised by `tests/test262-shared.ts` (the
compile-ceiling path). The heavy-family members appear in
`test262/test/built-ins/Object/defineProperty/` numbered batteries.
