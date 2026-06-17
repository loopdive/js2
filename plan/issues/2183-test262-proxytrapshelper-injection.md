---
id: 2183
title: "test262 runner: inject proxyTrapsHelper.js (allowProxyTraps) so Proxy trap tests construct a real handler"
status: done
assignee: se2
created: 2026-06-16
updated: 2026-06-16
completed: 2026-06-16
priority: high
feasibility: easy
task_type: test-infra
area: test262
language_feature: proxy
goal: spec-completeness
sprint: 62
related: [2180, 1466]
---

# #2183 — test262 runner: inject `proxyTrapsHelper.js` (`allowProxyTraps`)

## Problem

The test262 runner (`tests/test262-runner.ts`) hand-injects each
`includes:`-referenced harness helper it supports (propertyHelper,
isConstructor, fnGlobalObject, nativeFunctionMatcher, …) into the compiled
preamble. **`proxyTrapsHelper.js` was never injected.**

That helper defines `allowProxyTraps(overrides)`, used by the
`built-ins/Proxy/*/call-*-prototype*.js` family (and ~22 more tests across
`built-ins/Reflect`, `Array`, etc.). With the helper missing, `allowProxyTraps`
was an undefined identifier; calling it yielded `null`, so
`new Proxy(target, allowProxyTraps({...}))` received a **null handler**. After
#2180 that correctly throws a construction `TypeError`, so every such test
failed at construction (`Cannot create Proxy with a non-object as handler`) —
masking whatever the test actually exercised.

This is a **test-harness completeness gap, not a compiler defect** — the
compiler already compiles the helper's object-literal-returning function
correctly (verified in isolation).

## Fix

Inject `allowProxyTraps` into the preamble, gated on
`includes.includes("proxyTrapsHelper.js")` (same pattern as the other helpers).
It returns a handler whose every trap defaults to a `Test262Error`-throwing
stub (so a test asserting "trap T must not fire" fails loudly if it does) and
is overridable via the argument — mirroring the upstream helper verbatim.

## Result

`allowProxyTraps`-using tests: **0 → 6 pass** of 27 (19 fail + 8 CE → 13 fail +
8 CE), **zero regressions** (the change is gated on the include, so tests that
don't use the helper are untouched; CE count unchanged). The 3 newly-passing
`built-ins/Proxy` cases compose with #2180's trap-discovery fix. The remaining
fails have separate root causes (numeric-index trap-receiver identity,
extern-class proxy targets) tracked elsewhere.

## Files
- `tests/test262-runner.ts` — `needsProxyTraps` flag + preamble injection +
  cache-key / `buildPreamble` signature wiring.
- `tests/issue-2183.test.ts` — asserts the 3 `built-ins/Proxy` cases that flip
  to pass.
