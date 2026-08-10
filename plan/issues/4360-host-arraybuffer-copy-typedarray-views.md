---
id: 4360
title: "host dynamic closure bind: copying bytes between host ArrayBuffers through host TypedArray views still fails (the one live residual of #3416)"
status: ready
sprint: current
created: 2026-08-10
updated: 2026-08-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: correctness
related: [3416, 3435, 4333]
---

# The one live residual of #3416

Salvaged from #4333, which was closed as too stale to merge (5,098 commits
behind, real `src/codegen/**` conflicts). Four of that branch's five bugs are
**already fixed on main**; this is the only one that still reproduces, so it is
carried forward rather than lost with the PR.

## Evidence

#4333's five test files, run unmodified against current `main`:

| issue | result on main | verdict |
| --- | --- | --- |
| 3412 script top-level function redeclaration | 7/7 pass | fixed |
| 3413 i32 loop counter dynamic bound validation | 3/3 pass | fixed |
| 3414 top-level TypedArray constructor global | 2 pass, 1 fail (ENOENT — scratch clone had no `test262` submodule) | no live failure |
| 3415 sandbox realm runtime errors | 1 pass, 1 fail (same ENOENT) | no live failure |
| **3416 host dynamic closure bind** | 3 pass, **1 real assertion failure** | **still reproduces** |

The failing case:

```
× #3416 host dynamic closure bind > copies bytes between host ArrayBuffers through host TypedArray views
```

roughly, from `tests/issue-3416.test.ts` on branch `codex/strict-harness-regressions`:

```js
const source = new sandbox.Uint8Array([1, 2, 3, 4]).buffer;
const dest   = new sandbox.ArrayBuffer(4, { maxByteLength: 8 });
expect(instance.exports.test(dest, source)).toBe(1234);
```

The second 3416 failure in that file is the same ENOENT submodule artefact, not
a defect.

## Relationship to #3435

#4333's triage suspected all of #3416 was superseded by #3435 (`new TA()` on a
JSDoc `Function`-typed callback param falling to the `__new_TA` extern import).
That is **half right**: #3435 is `status: done` and does account for three of
3416's five cases now passing — but not this one.

Worth knowing for whoever picks this up: #4333's own #3416 fix routed through
`checker.getTypeAtLocation` directly, the anti-pattern that trips the
oracle-ratchet gate. #3435 solved adjacent ground correctly via `ctx.oracle`.
A fix here should follow #3435's approach, not #4333's.

## Suggested first step

Lift the single failing case out of
`codex/strict-harness-regressions:tests/issue-3416.test.ts` into a fresh
`tests/` file against current main, confirm it still fails, then fix. The rest
of that branch — the five issue files, the `src/` diff, the
`scripts/test262-sandbox.mjs` extraction — is not worth carrying: written
against a 2026-07-03 tree, and the test262 runner has been restructured since.
