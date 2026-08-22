---
id: 4613
title: "5 stale assertions in #2949's own suites fail on current main (bucket expectations moved by later work)"
status: ready
sprint: current
created: 2026-08-21
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: tests
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [2949, 4730, 3520]
origin: "#2949 census re-measurement (PR #4730): 5 assertions across issue-2949-slice3b-any-dynamic and issue-2949-slice2-dynamic-producers fail with byte-identical messages on main and on the PR branch"
# id 4613 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs 4732/4733 introduce no issue files
# with ids near 4613.
---

# #4613 — re-ground the 5 rotted #2949 suite assertions

## Problem

`tests/issue-2949-slice3b-any-dynamic.test.ts` and
`tests/issue-2949-slice2-dynamic-producers.test.ts` carry **5 assertions
that fail on current main**, byte-identically with and without any recent
change — bucket expectations that other landed work moved (e.g. a case now
reporting `call-resolution-unsupported` where the test pins
`param-type-not-resolvable`). Rotted assertions mask real regressions in
exactly the suites meant to defend #2949's claims — same pathology as the
17 red #3520 census files (PR #4733's de-pinning rationale applies).

## Implementation Plan (Fable, 2026-08-21)

Per the #4733 pattern: for each of the 5, decide whether the moved bucket
is (a) correct evolution — re-ground the assertion on the invariant it
defends (claimed vs not-claimed; the family's terminal outcome class)
rather than the literal bucket string; or (b) a real regression — file it.
Do NOT blanket-update strings to whatever main currently reports without
the (a)/(b) verdict per assertion; that would launder a regression. Record
the per-assertion verdict in this file.

## Acceptance criteria

- [ ] All #2949 suites green on main.
- [ ] Per-assertion verdict table recorded here (evolved vs regression).
- [ ] Assertions re-grounded on invariants, not fresh literals, wherever
      the bucket move was legitimate evolution.
