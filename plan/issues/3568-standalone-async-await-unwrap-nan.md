---
id: 3568
title: "standalone/wasi: await of a sync-fulfilled local promise unwraps to NaN (async-carrier regression, #2865 guard red)"
status: ready
sprint: current
created: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: async-await, promise, standalone
es_edition: es2017
goal: standalone-gap
related: [2865, 2773, 3008]
origin: "2026-07-24 bounded standalone-test audit (dev-opus / #3565 lane): tests/issue-2865-standalone-async-await-unwrap.test.ts silently red on main — outside required checks (#3008)."
---

# #3568 — standalone `await` of a sync-fulfilled local promise unwraps to NaN

## Problem

`tests/issue-2865-standalone-async-await-unwrap.test.ts` (AG0 host-free await
unwrap, WASI) is **silently red on current main** (not PR-touched, not in the
required guard suite — #3008 gap). **2 of 7 subtests fail**: an `await` of a
sync-fulfilled local promise, and an `await` over an arithmetic expression, both
unwrap to **NaN** instead of the settled numeric value.

## Measured evidence (current main, WASI/standalone async lane)

- "await a sync-fulfilled local promise" → **expected NaN to be 7**.
- "await over an arithmetic expression passes through" → **expected NaN to be 9**.

Verified red on clean `origin/main` (ran the file against a fresh
`origin/main` worktree — 2 failed, 5 passed). NOT introduced by any in-flight
branch.

## Root cause (pointer, not yet fixed)

The awaited value unwraps to NaN — an **async-carrier / value-rep substrate**
issue (the settled value's numeric image is lost across the await resume). This
sits in the Fable-gated value-rep substrate (#2773) / the async drive layer; it
is not a contained fix and is out of scope for the guard-audit lane. Filed for
tracking so it is no longer invisible.

## Guard status

`tests/issue-2865-standalone-async-await-unwrap.test.ts` already detects this
post-merge but is unenforced. Cannot fold into the required suite (#3552) while
red. Fold once the substrate fix greens it.
