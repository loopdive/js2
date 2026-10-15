---
id: 6996
title: "standalone async: `await <settled>` (`await null`, `await Promise.resolve()`, `await asyncFn()` that returned synchronously) runs the continuation synchronously — `1,3,2` instead of `1,2,3`; #6780 removed the all-static decline from the host gate only, `asyncFnNeedsDrive` still has it"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: async-await, microtasks
goal: standalone-gap
related: [6780, 6995, 2906]
---

# `await <settled>` does not yield a microtask turn on standalone

Found by the 2026-10-15 audit. Standalone/wasi only; #6780 fixed the host lane (its tests use the host helper).

## Repro (node → wasm, standalone)

```js
async function a(){ console.log(1); await null; console.log(3); } a(); console.log(2);   // node 1,2,3  wasm 1,3,2
```
Same for `await Promise.resolve()`, `await inner()` with `async function inner(){ return 1 }`. Chain test: node `a1,t1,x1,a2,t2,t3`, wasm `a1,a2,t1,x1,t2,t3`. Also reorders results across sibling calls.

Related (low): `async function a(){ return Promise.resolve(1); }` resolves two ticks early on BOTH lanes (spec: thenable adoption costs two extra jobs). Fix here only if the same mechanism; otherwise note.

## Root cause

- `src/codegen/async-frame.ts:994` — `if (!anyRealSuspension) return false; // fully await-elidable → sync + resolved promise`. The all-static decline that #6780 removed from `asyncFnNeedsHostDrive` is still in the standalone/wasi gate, so the body is compiled as a synchronous function returning a resolved promise; the continuation after `await` runs before the caller's next statement.

## Implementation Plan

1. Read #6780's fix for the host gate and apply the same rule to `asyncFnNeedsDrive`: a body with at least one `await` is never fully elidable for ORDERING purposes; the first await must schedule the continuation as a microtask even when the operand is settled. Concretely: treat a statically-settled await as a suspension point whose resume is enqueued immediately (a "yield-to-microtask" state) rather than removing it.
2. If the drive layer's linear planner (`planLinearAwaits`) cannot represent a settled-await state cheaply, the fallback must be a real frame suspension, not synchronous execution; coordinate with #6995 so a decline here does not fall into the silent pass-through lane.
3. Return-promise adoption (two extra ticks) only if it is the same scheduler path (`async-scheduler.ts`); else leave and note.
4. Tests: the three repros + the chain test, asserting the exact interleaving via a logged sequence; run on standalone AND gc to prove gc stays correct.

## Acceptance

- Interleavings match node on standalone; gc unchanged.
- `tests/equivalence/*async*` and `issue-6780*` pass.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6996-standalone-await-settled-sync-continuation.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
