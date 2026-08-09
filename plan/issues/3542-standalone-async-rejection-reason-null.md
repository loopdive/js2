---
id: 3542
title: "Standalone async-fn rejections lose the thrown value — reason is always NULL (unfinished #1326 Phase-1C payload wiring)"
status: done
assignee: ttraenkler/fable-3417
sprint: 75
priority: high
horizon: s
feasibility: medium
task_type: bugfix
area: codegen, standalone, async
language_feature: async-functions, promises
goal: standalone-mode
parents: [3178]
related: [3417, 3538, 1326, 2865, 3228]
created: 2026-07-23
completed: 2026-07-23
# (#3102) Intended growth: the fix replaces the catch_all arm INSIDE
# wrapAsyncCallInTryCatch, which lives in expressions.ts — net +14 lines,
# mostly the WHY comment. Extracting the wrapper is out of scope here.
loc-budget-allow:
  - src/codegen/expressions.ts
---

# #3542 — standalone async-fn rejection reason is always NULL

## Method note — the signature was manufactured DOWNSTREAM of the defect

The load-bearing lesson of this issue: **the corpus error text was produced
by the test harness REACTING to the bug, not by the bug itself.** The defect
was a null rejection reason; the "Cannot destructure 'null' or 'undefined'"
signature came from the test TEMPLATE's own rejection handler
(`({ constructor }) => …`) destructuring that null. Grepping the compiler for
the signature string finds the (correct!) RequireObjectCoercible throw
helper and sends you chasing a phantom destructuring bug. When triaging a
cluster, always probe what the HANDLER received before trusting the message
— a signature can be an echo. (Same family as the #3468 vacuous-pass and
#2860 `(start)`-throw-masking lessons: harness-reaction artifacts.)

## Problem (measured, verify-first)

Second head of the F2 newly-scored standalone async FAIL surface (#3417):
the ~130-row `Cannot destructure/access/convert` cluster (98 in
`language/statements/for-await-of` — the `async-func-dstr-*` template
family). The corpus message was a decoy: probing showed the async fn DOES
reject with a correct TypeError path, but the **rejection reason arriving at
the handler is `null`** — the thrown instance is dropped. The test template's
rejection handler `({ constructor }) => assert.sameValue(constructor,
TypeError)` then destructures NULL, and its OWN "Cannot destructure 'null' or
'undefined'" TypeError propagates to `$DONE` — manufacturing the corpus
message. Minimal bisection: `async function f(){ throw new TypeError(...) }`
and `await Promise.resolve(1); throw ...` both reject with NULL; direct
`Promise.reject(new TypeError())`, executor `rej(...)`, and late pending
rejections all preserve the reason.

## Root cause

`wrapAsyncCallInTryCatch` (`src/codegen/expressions.ts`), standalone arm — a
**documented, never-finished TODO** from #1326 Phase 1B: the call-site
wrapper caught a synchronously-unwinding async-body throw with a bare
`catch_all` (payload inaccessible) and minted the rejected `$Promise` with
`ref.null.extern` as the reason, with a comment saying "Phase 1C will wire
the catch-payload binding". Phase 1C never did. Every standalone async call
whose body unwinds synchronously (sync throw, AG0 sync-unwrapped await
continuation, sync-settling for-await drive — i.e. most of the corpus
shapes) rejected with NULL.

## Fix

Add a `catch $exn` arm (the native `__exn` tag, `ensureExnTag`) ahead of the
`catch_all`: its externref payload — the thrown JS value — becomes the
rejection reason (`$Promise.value`). `catch_all` remains as the reason-less
fallback for foreign, non-`__exn` exceptions only. One small arm; no new
imports, no host surface, #2961 gate untouched.

## Validation (measured)

- Permanent repro: `tests/issue-3542.test.ts` (4 cases — sync throw,
  throw-after-await, the for-await-dstr cluster shape, and the
  direct/executor no-regression control; all through the real standalone
  sink/drain channel).

- Bisection probes all flip: sync-throw / throw-after-await async fns reject
  with the real TypeError (`instanceof` + `.message` hold); for-await-dstr
  rejections carry the genuine IteratorBindingInitialization TypeError.
- Real corpus: **30/33 PASS** on a stride-4 sample of the 130-row cluster
  (runtime PASS via the #3469 channel). The 3 residuals are a distinct
  `language/arguments-object/*async-gen*` sub-family
  (`Cannot access property on null or undefined`) — separate root cause,
  left for the umbrella.
- Scoped suites green post-fix: async set (66 tests), Promise machinery
  (issue-1326/1326c/2623/2671×2/28/2903-finally — 58 tests). The single
  1326 host-lane WAT expectation failure is control-verified pre-existing on
  clean sources.

## Notes

- Sequenced after #3538 (same umbrella lane; measured on the combined tree).
- Follow-ups spotted while probing (not addressed): standalone
  `console.log(null-externref)` renders `[object Object]` instead of `null`;
  an uncaught trap inside a microtask job silently ends the drain (swallows
  subsequent jobs' output).
