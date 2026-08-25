---
id: 4721
title: "ES2015 Proxy get with undefined/null trap forwards the receiver"
status: in-progress
created: 2026-08-25
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: Proxy
goal: es2015-test262
related: [3127, 1355, 2616, 2618]
assignee: ttraenkler/codex
---

# #4721 — ES2015 Proxy `get` trap-absent receiver forwarding

## Scope

Fix the bounded ES2015 Test262 residual
`test/built-ins/Proxy/get/trap-is-undefined-receiver.js`, where a `get: null`
handler and a handler with no `get` property must forward the original
receiver through the target's `[[Get]]`. Keep nearby controls limited to the
trap distinctions and call shape needed to prove the fix: missing,
`undefined`, `null`, non-callable, nested Proxy forwarding, and explicit trap
receiver forwarding.

## Live baseline (upstream/main `483b862ed5`, 2026-08-25)

Runs used `scripts/harness-flip-probe.ts`, which executes the authentic
assembled Test262 harness and first proves a must-pass and must-fail control.
The scoped eight-file matrix was run independently for each compiler lane;
counts include all eight rows and therefore have no silent-empty result.

| lane | controls | pass | fail | total |
| --- | --- | ---: | ---: | ---: |
| host | must-pass=pass, must-fail=fail | 2 | 6 | 8 |
| standalone | must-pass=pass, must-fail=fail | 1 | 7 | 8 |

The exact residual fails in both lanes:

- host: `TypeError: Cannot access property on null or undefined` at the first
  `assert.sameValue(p.attr, p)`.
- standalone: `Expected SameValue(«undefined», «null») ...` at the same
  assertion.

The explicit trap controls pass on host and standalone:
`get/call-parameters.js` is 2/2, proving the trap call path and explicit
receiver argument are present on both lanes. The non-callable control passes on
host but fails standalone (no TypeError), so the implementation must preserve
the existing host behavior while making standalone `GetMethod` distinguish
missing/`undefined`/`null` from a present non-callable value.

Full scoped rows are recorded in the uncommitted probe artifacts
`.tmp/issue-4721-baseline-host.jsonl` and
`.tmp/issue-4721-baseline-standalone.jsonl` while implementation is in flight.

## Implementation plan

1. Trace `__reflect_get_receiver`/host Proxy bridge forwarding and the
   standalone `__proxy_get_dispatch` path to identify where a null or absent
   `get` trap loses the receiver or is treated as an ordinary object read.
2. Make the narrowest shared change that passes the exact receiver test and
   keeps a present non-callable trap throwing `TypeError`; do not broaden to
   other Proxy MOPs or descriptor/array infrastructure.
3. Add focused regression coverage under `tests/issue-4721.test.ts` for host
   and standalone compilation, including missing/`undefined`/`null`,
   non-callable, nested receiver forwarding, and explicit trap receiver
   forwarding.
4. Re-run exact Test262 controls on both lanes, then TS5, TS7, typecheck,
   lint, format, and prepush checks. Keep compiler source changes at or below
   180 LOC.

## Test Results

Pending implementation.
