---
id: 7641
title: "Runtime-eval root tests whose expectations predate later merges (Acorn export list, #4406, #4438, #7363 A4)"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: test
area: runtime-eval
goal: runtime-eval
related: [2928, 4406, 4438, 6979, 7363, 7503, 7609]
---

# #7641: four runtime-eval tests fail on main because the code moved under them

Found while checking the pre-existing failures for #7632 (PR #7572). Measured on main (e17578f7 and ea628a78).

**Why they rot.** These root tests run only when a PR changes them (the pre-push changed-root-tests hook), so a PR
that breaks one without touching it stays green.

| Test | What fails | Cause | Owner |
| ---- | ---------- | ----- | ----- |
| `tests/issue-2928-runtime-acorn.test.ts` | the provider's export list | The provider now also exports `__runtime_script_eval` (the global-script entry, #4784 / #7106 A2). Run alone, the probe builds (7.15 MB, no errors). Under the parallel 37-file sweep it failed earlier, on `success: false`: probably the provider build under load (unverified). | #2928 |
| `tests/issue-4406-runtime-eval-host-leak.test.ts` | the JS target imports `js2wasm:runtime-eval` and not `env.__extern_eval` | The JS target compiles eval with the native core since #6979 S7 removed host-assisted eval, so the host-seam expectation is obsolete. Note: `plan/issues/4406-*` is about the return-type unboxing ABI, so the test's originating issue should be confirmed. | #4406 / #6979 |
| `tests/issue-4438-runtime-eval-construct.test.ts` › "REFUSES in the JS-host lane" | gc output now contains `$__construct_runtime_eval` | Same cause: the JS target uses the native runtime-eval construct driver, not the host construct bridge. | #4438 |
| `tests/issue-7363-eval-a4.test.ts` › "script-level this has no value" | the refusal "'this' reference outside an instance method body (<module-init>)" is gone | #7609 A1 (0aba960d, 2026-11-27) lowers script-level `this` to the global object on the Prepared path. | #7363, #7609 |

## #7363 A4 is more than a stale pin

The A4 test says: "if either label goes away, `pristineBuiltinGlobal` first needs #7503's escape check". #7503 is
still `backlog`. Since #7609, the global object is an identity-only object on the Prepared path: an own query that
misses aborts. Probes on main, all with a later `Function("return 1")()` that must answer 5 if the write had taken
effect:

| Write to the global `Function` | Result |
| ------------------------------ | ------ |
| `this.Function = …`, with or without `eval("1")` first | refused at select: "the global Function is not pristine (#7487)" |
| `var g = this; g.Function = …` | refused at select: "not pristine" |
| `var g = this; g[k] = …` (computed key) | refused at select: "dyn.member_set with a computed key has no Prepared intrinsic" |
| `function set(o) { o.Function = …; } set(this);` | compiles, then aborts at run time (`unreachable`) |

No probe produced a wrong answer. Today the abort and the select refusals stand in for #7503's check. The owners of
#7363 and #7609 decide:
- whether the A4 pin moves to the new boundary (the abort);
- whether #7503 becomes a precondition of #7609's unsealing slice (slice C).

## Acceptance

- Each of the four tests passes against current behaviour, updated by the owning issue's lane.
- For #7363 A4, the pin names the guard that replaced the label, and #7503's status is decided.
