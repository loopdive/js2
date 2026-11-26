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
