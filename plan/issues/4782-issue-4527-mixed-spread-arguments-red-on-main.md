---
id: 4782
title: "tests/issue-4527-call-dyn-bridge.test.ts mixed-spread row is red on main and nothing gates it"
status: ready
sprint: current
created: 2026-08-27
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: spread
related: [4527, 4775, 4780]
# (2026-08-27) **Id renumbered from 4779.** Open PR #5073 (codex lane) also adds
# an issue file under id 4779 — a different one, slug
# `es2015-bigint-tostring-symbol-radix-standalone` — and the required
# `check:issue-ids:against-open-prs` gate correctly failed PR #5076 on the
# collision. (Written without the `plan/issues/<id>-<slug>.md` path shape on
# purpose: the #1616 link gate resolves that shape anywhere under `plan/` and
# would fail `quality` on a file this branch does not carry.) The ref tie-break actually favoured THIS side (our 4779 reservation
# was recorded at 16:12:58Z on `origin/issue-assignments`; #5073's file carries
# no reservation at all, and its PR opened at 16:27:21Z), but that lane is
# unreachable and PR #5076 carries a 28.5x perf fix, so we yielded the id rather
# than block on a lane that cannot answer.
#
# The 4779 reservation could NOT be withdrawn: `claim-issue.mjs --release`
# operates on live CLAIMS only, and answers "not currently claimed — nothing to
# release" for a `status=reserved` record, which then survives unchanged
# (re-read after the attempt: still `RESERVED … 16:12:58Z`). So a yielded id
# leaves a permanent reservation record behind. Harmless here — it only keeps
# `--allocate` from re-handing out 4779, and #5073's file lands on `main` under
# that id regardless, after which `check:issue-ids:against-main` is the arbiter
# — but worth knowing before anyone plans a yield expecting a clean withdrawal.
#
# (2026-08-27) Reserved with `--allow-unscanned` — no `gh` in this container, so
# `claim-issue.mjs`'s open-PR scan degrades unconditionally. The scan was run
# directly against the REST API with curl instead: the 9 open PRs on
# loopdive/js2 (#5063, #5067, #5069, #5070, #5072, #5073, #5074, #5075, #5076)
# add or modify issue files {1691, 3481, 3525, 4775, 4777, 4778, 4779, 4780,
# 4781}. 4782 collides with none of them.
---

# #4782 — the `#4527` mixed-spread row is red on main

## Problem

`tests/issue-4527-call-dyn-bridge.test.ts` fails 1 of its 33 tests on
`origin/main` @ `2a7548ca81`:

```
issue #4527: cross-module dynamic callback invocation
  > routes mixed spreads to arguments for zero-formal class methods
AssertionError: expected 46 to be 52
```

The fixture calls a zero-formal class method with a mixed argument list —
literal, inline spread, spread of a local, and a trailing comma — and reads the
result back through `arguments`:

```js
class C {
  method() {
    return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
  }
}
export function t() {
  const tail = [2, 3];
  return C.prototype.method(42, ...[1], ...tail,);
}
```

Correct is `4 + 42 + 1 + 2 + 3 = 52`. Main returns **46**, which decomposes as
`4 + 42 + 0 + 0 + 0` — so `arguments.length` is right and `arguments[0]` is
right, but **every spread-sourced element reads as 0**. The spread contributes
to the count and not to the values.

## Provenance

Found incidentally while triaging
[#4775](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4775-numeric-return-twin-suite-red-on-main),
which ran this suite as part of validating a fix against the test surface of
`ad543a660e`. **Verified pre-existing on an unmodified working tree** (`git
status` clean at `2a7548ca81`) — it is not collateral from that work.

## Why nobody noticed

Same structural gap #4775 documents: this file lives under `tests/`, not
`tests/equivalence/`, so `equivalence-gate` does not run it, and no other
required check does either. The suite is 32/33 green, so a casual run reads as
healthy.

## Acceptance criteria

- The row passes, with the spread-sourced elements reaching `arguments`.
- The verdict says whether this ever worked (bisect, as #4775 did) or whether
  the row was aspirational when `#4527` landed — those need opposite fixes and
  the difference is cheap to establish.
- If a value is wrong rather than a shape, do NOT re-pin the wrong value
  (#4743/#4747 precedent).
