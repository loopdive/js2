---
id: 4365
title: "test262: `$262.agent` is null — 112 Atomics agent tests fail on `.bind` (successor to #4020/#4170)"
status: ready
sprint: current
created: 2026-08-11
updated: 2026-08-11
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: test-runner
language_feature: test262-harness, atomics
goal: test-infrastructure
related: [1523, 1354, 3405, 4020, 4170]
origin: "2026-08-11 /harvest-errors of loopdive/js2wasm-baselines test262-current.jsonl (run 20260811-103533, gitHash 9268d5a5)"
---

# #4365 — `$262.agent` host object is absent, so every Atomics agent test dies at init

## TL;DR

**112 official failing tests** in the **default (JS-host)** lane fail with:

```
Cannot read properties of null (reading 'bind') [in __module_init()]
```

All 112 are in `built-ins/Atomics`. The failure is at **module init**, before
any test logic runs — the harness does something shaped like
`$262.agent.start.bind($262.agent)` and `$262.agent` is `null`.

## This is the successor to #4020 / #4170 — and evidence they are DONE

#4020 and #4170 are **duplicate issues** (identical title and body, both
`status: ready`, both filed by the 2026-08-01 harvest; #4020's body header even
reads `# #3973`, so this was a triple). Both describe a TS8010/8017
"can only be used in TypeScript files" rejection covering **112 Atomics** tests
plus 41 others.

That bucket is now **0 records** in the current baseline — the TypeScript-parse
rejection is fixed. #4020's own named sample,
`test262/test/built-ins/Atomics/notify/notify-zero.js`, now reads:

```
fail | runtime_error | Cannot read properties of null (reading 'bind') [in __module_init()]
```

Same 112 files, same count, next blocker. This satisfies #4020's own acceptance
criterion ("Whatever those tests then do … is recorded"), so **#4020 and #4170
should be closed** and the work continues here.

## Evidence

| Directory | Count |
|---|---|
| `built-ins/Atomics/waitAsync` | 53 |
| `built-ins/Atomics/wait` | 43 |
| `built-ins/Atomics/notify` | 16 |
| **Total** | **112** |

Samples:

- `test262/test/built-ins/Atomics/wait/negative-timeout-agent.js`
- `test262/test/built-ins/Atomics/waitAsync/poisoned-object-for-timeout-throws-agent.js`
- `test262/test/built-ins/Atomics/notify/count-defaults-to-infinity-undefined.js`

Cross-lane: **0** of the 112 pass in the standalone lane either — this is not a
host-only gap.

## Root cause

`$262.agent` is the test262 host hook for spawning **worker agents**
(`$262.agent.start`, `.broadcast`, `.getReport`, `.sleep`, `.monotonicNow`).
**#1523** (`status: done`) built the `$262` host object but evidently left
`agent` as `null` rather than implementing or omitting it — and the harness
dereferences it unconditionally at init.

## Scope decision needed

Two legitimate outcomes, and the cheap one should be evaluated first:

1. **Cheap (recommended first):** stop failing at *init*. A `null` `agent` that
   is dereferenced during module init turns a would-be `skip`/targeted failure
   into a hard crash for all 112. Making the harness degrade gracefully lets each
   test report its real status; some non-agent tests in these directories may
   then pass outright.
2. **Full:** implement `$262.agent` over real workers. That is a substantial
   piece of work and overlaps **#1354** (`spec-backlog-sharedarraybuffer-atomics`,
   `status: backlog`) and **#3405** (`jshost-atomics-i64-vec-bigint-bridge`,
   `status: ready`). Do not start it under this issue without a scoping decision.

## Acceptance criteria

- [ ] No test fails with `Cannot read properties of null (reading 'bind')` at
      `__module_init()`.
- [ ] Each of the 112 reports a status attributable to a real cause (pass, or a
      named Atomics/agent gap), not to harness init.
- [ ] #4020 and #4170 are closed as done, with one of them noted as the duplicate.
- [ ] The chosen scope (1 vs 2 above) is recorded here before implementation.
