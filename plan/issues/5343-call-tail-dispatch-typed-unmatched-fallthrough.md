---
id: 5343
title: "call-tail-dispatch: a callee with a checker signature but no registered closure falls through to a silent `undefined`"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-06
completed: 2026-09-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Handed on by the #5335 fix, which routed *around* it rather than into it.

In `src/codegen/expressions/call-tail-dispatch.ts`, the "CallExpression as
callee" arm (`f()()`) calls `matchClosureInfoBySignature`, which iterates
`ctx.closureInfoByTypeIdx`. When no registered closure matches **and** the
checker *does* give the inner call a signature, the guard
`if (!callSigs || callSigs.length === 0)` skips the working dynamic-call
ladder too, and the arm falls through to a tail that emits `drop` +
`ref.null extern` — a **silent `undefined`**, not a trap.

The untyped twin is already repaired (`tryEmitInlineDynamicCall`, guarded by
`callSigs.length === 0`); the *typed-but-unmatched* case is not. #5335 made
module-init pass 2 run so the registry is populated there, but the same
fall-through is reachable by any **host callee**, any callee compiled in a
**later module**, and any signature the registry never sees.

This is the mechanism that printed `0` instead of `3` for `outer()()()`. It
is also the leading suspect for hono's `Cannot read properties of null
(reading 'split')` (#5338) and axios `buildURL`'s null access (#5341) — both
are "a compiled callee answered nothing to the host".

## Acceptance criteria

1. A miss in `matchClosureInfoBySignature` with a non-empty `callSigs` falls
   back to the dynamic-call ladder; the `drop` + `ref.null extern` tail is
   reachable only when there is genuinely nothing to call.
2. Regression test: a two-file untyped `.js` project where the inner callee
   is (a) a host function, (b) a function exported by a second module and
   called before that module's closures are lifted — both must return the
   real value. Fails on parent, passes with fix. Anti-vacuity control: the
   already-matched case still takes the fast `call_ref` arm (assert on WAT or
   on a counter).
3. `tests/issue-5335-module-init-pass2-closure-registry.test.ts` still
   11/11 and `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2` seam behaviour unchanged.
4. A/B at one HEAD, 17 suites, per test file; nothing regresses (anchors in
   #5338). If #5338/#5341 move, say so — that is the expected upside.
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Read `call-tail-dispatch.ts` around `matchClosureInfoBySignature` and the
   `callSigs` guard; read `tryEmitInlineDynamicCall` to see the repaired
   untyped path. The fix is to make the typed path share that fallback: on
   registry miss, emit the dynamic ladder regardless of `callSigs.length`.
2. Capture `.tmp/call-tail-dispatch.orig.ts` before editing.
3. Reproduce with the host-callee shape first (no module-init involvement):
   `const f = () => globalThis.Math.max; f()(1, 2)` or an imported host
   function returned from a compiled function. Confirm the `ref.null extern`
   tail in WAT. Then the second-module shape.
4. Implement: route the miss to the dynamic ladder. Keep the fast arm for
   registry hits. Do **not** widen `callSigs` handling elsewhere.
5. Regression test; run the #5335 test file; A/B.

## Dispatch

Model: **sonnet**. Mechanism, site, and fix direction are all established by
the #5335 agent's WAT analysis; the untyped twin shows the exact shape of the
repair. Well-specified, small blast radius.

## Test Results

**Fix**: `src/codegen/expressions/call-tail-dispatch.ts` — in the
"CallExpression as callee" arm, the dynamic-call-ladder fallback
(`tryEmitInlineDynamicCall`) is now unconditional at that point (previously
gated on `!callSigs || callSigs.length === 0`). Reaching that line already
means the exact-match arm above did not return, so it is always a registry
miss — whether from no checker signature at all, or a signature with no
matching registered closure. The fast `call_ref`/`return_call_ref` arm above
is untouched.

**Mechanism confirmed in WAT** (`.tmp/repro/host-callee.wat`, not committed):
pre-fix, `f()(1, 3)` for `function f() { return Math.max; }` compiled to
`<compile callee> drop <compile arg> drop <compile arg> drop ref.null extern
call $__unbox_number` — the callee and both arguments are evaluated for side
effects only, then discarded.

**Regression tests** — `tests/issue-5343.test.ts`, 3 cases:

1. **(a) host callee** — untyped `.js`, single file. `f()` returns `Math.max`
   (checker infers a real call signature from the return statement); an
   unrelated closure (`other`/`oc`) is present so `ctx.closureInfoByTypeIdx`
   is non-empty (otherwise `tryEmitInlineDynamicCall` declines outright with
   no dispatch arm to build in JS-host mode). `f()(1, 3)`:
   - Parent: `0` (FAIL). Fixed: `3` (PASS, `Math.max(1, 3)`).
2. **(b) callee exported by a second module, compiled after the call site** —
   untyped `.js`, three files, exploiting the entry-anchored DFS in
   `src/checker/index.ts` (dependency-first, cycle back-edges are no-ops,
   first-seen wins): `entry.js` → `moduleB.js` (defines `outer`, imports `run`
   from `moduleA.js`) → `moduleA.js` (imports `outer` from `moduleB.js`, a
   back-edge no-op since `moduleB` is already on the DFS stack; defines
   `run`). Resulting compile order `[moduleA, moduleB, entry]` — `run`'s body
   (`outer()()`) compiles BEFORE `outer`'s own body (which mints the returned
   closure). `outer()()`:
   - Parent: `0` (FAIL). Fixed: `3` (PASS, `1 + 2`).
3. **Anti-vacuity control** — a same-file, already-matched `outer()(n)` (outer
   declared above the call site, closure already registered): WAT is
   **byte-identical** before/after the fix (`diff -a`) and still contains
   `return_call_ref` — the fast exact-match arm is untouched.

Exact counts both ways (`node node_modules/vitest/vitest.mjs run
tests/issue-5343.test.ts`): **parent 1 passed / 2 failed; fixed 3 passed / 0
failed.** `tests/issue-5335-module-init-pass2-closure-registry.test.ts` stays
**11/11** with the fix applied.

**Ratchet gates**: `check-loc-budget` (net **-6** LOC in the changed file —
the fix also shrank the guard), `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:dogfood-validation`
(6/6 gated packages compile and validate) — all green, no allowances needed.

**A/B at one HEAD** (base `upstream/main` @ `68e1c0c2cb`), 17 dogfood suites,
one at a time:

| suite | result | anchor | match |
| --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | yes |
| three | 17/18 | 17/18 | yes |
| clsx | 32/32 | 32/32 | yes |
| cookie | 63740/63740 | 63740/63740 | yes |
| lodash | 53/62 | 53/62 | yes |
| redux | 61/82 | 61/82 (open regression, #5640) | yes, unaffected |
| axios | 200/231 | 200/231 | yes |
| stylelint | 108/108 | 108/108 | yes |
| tailwindcss | 13/13 | 13/13 | yes |
| jsdom | 6/6 | 6/6 | yes |
| styled-components | 9/9 | 9/9 | yes |
| uuid | 75/75 | 75/75 | yes |
| marked | 9/30 | 9/30 | yes |
| moment | 10/10 | 10/10 | yes |
| prettier | 101/151 | 101/151 | yes |
| jest | 329/356 | 329/356 | yes |
| hono | 244/324 | 244/324 | yes |

No regressions. No suite-level improvement observed either — hono's
`ipaddr.test.ts` stayed 4/16 and axios's `buildURL.test.js` stayed 14/20, so
the specific miss this PR closes is not exercised by these admitted test
files' currently-passing/failing boundary. The fix is validated by the
targeted regression tests above, not by a dogfood-suite delta.
