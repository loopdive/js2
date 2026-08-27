---
id: 4775
title: "tests/issue-3754-numeric-return-twin.test.ts is 9/10 RED on main and nothing gates it"
status: ready
sprint: current
created: 2026-08-27
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: testing
related: [3754, 3753, 4406, 4405]
# (2026-08-27) Reserved with `--allow-unscanned` — no `gh` in this container, so
# `claim-issue.mjs`'s open-PR scan degrades unconditionally. The scan was run
# directly against the REST API with curl instead: 5 open PRs on loopdive/js2
# touch issue ids {2949, 4406, 4768, 4770, 4771, 4773}. 4775 is not among them.
---

# #4775 — the numeric-return-twin suite is red on main, unnoticed

## Problem

`tests/issue-3754-numeric-return-twin.test.ts` fails **9 of its 10 tests** on
`origin/main` @ `7e0b03ebb7`. Every failure is the same shape:

```
AssertionError: expected '' to be 'externref'   (and 'f64', and 'i32')
  at trampolineResultType("__dc_P_inc_0_g")
```

The helper returns `''` when the module has no function of that name — so the
`__dc_P_inc_0_g` direct-call trampoline that file was written to observe is no
longer emitted for its `methodAxis` shape. The one passing test is the
value-level one ("a dynamic call still reaches the same value through the
shim"), which does not read the WAT.

Found while implementing
[#4406](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4406-return-type-unboxing-abi)
Phase 0+1 (PR #5061). **Verified pre-existing**: every source file that PR
touches was reverted to `HEAD` and the suite re-run — the same 9 failures.

## Why nobody noticed

The file is not in a required check. The required six are `cheap gate`,
`quality`, `merge shard reports`, `check for test262 regressions`,
`equivalence-gate` and `cla-check`; this file lives under `tests/`, not
`tests/equivalence/`, so `equivalence-gate` does not run it, and the general
`npm test` lane does not gate. A shape-assertion suite that silently stopped
observing its subject is exactly the failure family #4157 entry 22 names: a
green (here: unwatched) run over a path that no longer exists proves nothing.

## The question this issue has to answer first

**Is the mechanism regressed, or is the test stale?** Both are plausible and
they need opposite fixes:

- *Stale test* — the direct-call admission rules moved (arity padding,
  receiver-flow proof, the `no-write-once-verdict` decline) and the file's
  `methodAxis` shape no longer reserves a trampoline. Then the fix is to
  re-derive the shape, not to relax the assertions: #3754's whole point is
  that the trampoline's result must FOLLOW the twin's, and an assertion
  loosened to keep the file green would prove nothing.
- *Regressed mechanism* — a devirtualization that used to happen no longer
  does, which would be a silent perf regression on the `method` axis #3754 was
  measured against (6.21× node at the time).

The instrument that distinguishes them already exists:
`JS2WASM_DIRECT_CALLS_DEBUG=1` prints `sites / trampolines / twinFills /
genericFills / legacyFills` plus a decline histogram. On the acorn lane today
that reads `sites=3976 trampolines=545 twinFills=516 genericFills=29
legacyFills=0`, so the machinery is alive at scale — which makes "the test's
own shape stopped qualifying" the more likely of the two. Run it on the file's
`methodAxis` source and read the decline reason.

`JS2WASM_RET_UNBOX_STATS=1` (added by #4406 Phase 0) prints the per-name
`twin=` / `tramp=` table for the same program and is the quicker read.

## Acceptance criteria

- The suite is green on main, with each assertion still pinning what its name
  claims (the trampoline result follows the twin; the negative cases still keep
  the boxed ABI).
- The issue records WHICH of the two causes it was, with the decline reason or
  the mechanism delta quoted.
- If the file's shape had to change, say what changed about admission and when
  — a shape that silently stopped qualifying once will do it again.
- Consider whether this suite (and its siblings under `tests/issue-37*.test.ts`)
  belong in a gating lane. A shape suite nobody runs is a comment.
