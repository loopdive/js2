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

## Implementation notes (2026-10-15) — NOT shipped; larger than its plan

Tried and measured on `origin/main` 3032e7c2 (with #6995 applied); reverted.
The repros still reproduce on standalone. `tests/equivalence/issue-6996-await-settled-ordering.test.ts`
records them: the gc-lane cases pass, the standalone cases are `it.fails`
(they start "failing" the moment this lands — flip them to `it`).

### What changed on main since the plan was written

#6982 (merged 2026-10-15) already applied this fix — but only for a
JavaScript environment (`!hostFreeEnvironment(ctx)`): `asyncFnNeedsDrive`
skips the all-static decline and driven frames use `alwaysAsyncAwait`
(`emitAsyncLane`), and all-settled closures take the drive lane. Host-free
targets (`--target standalone` / wasi) deliberately keep the synchronous fast
path; #6982's notes record that making it regime-wide broke 30 standalone/WASI
tests whose drain contract relies on it.

### The experiment

Make both #6982 conditions regime-wide (drop `hostFreeEnvironment` from the
`asyncFnNeedsDrive` decline and from `emitAsyncLane`'s `alwaysAsyncAwait`):

- All four repros + the chain test match node on standalone; the #6995 struct
  repro also passes (its body becomes driven).
- 69 related unit/equivalence files: **25 tests go pass → fail** —
  `issue-2865-standalone-async-await-unwrap` (6), `issue-2906-async-multiawait`
  (4), `issue-6428-standalone-async-value-sink` (4), `issue-2906-gap3-tryfinally`
  (3), `issue-2906-3b-forawait` (3), `issue-2895-async-frame` (2),
  `issue-2906-3a-while-await` (1), `issue-1672-async-gen-method-trampoline` (1),
  `issue-3527-async-replay-oracle` (1). They call an export and read the result
  synchronously, or sink the call through `as number` without a drain — the
  "synchronous fast path" contract (#2895/#2906 slice names say so verbatim).
- test262 stride (317 files, see #6995): 238 → 237 pass, i.e. no measurable
  conformance gain on that slice.

### What a real fix needs (scope for whoever picks this up)

1. Decide the host-free drain contract: either every embedder drains
   (`__drain_microtasks`) before reading an async result, or the async
   value-sink (#6428) learns to drain. Re-pin the ~25 tests accordingly.
2. Parked closures / methods awaiting a newly-driven helper read a PENDING
   `$Promise` on the pass-through (#6780 step 4 measured 9 → 2 and 8 → NaN):
   the closure park must be lifted first, or those callers regress.
3. The return-adoption two-tick delay (`return Promise.resolve(1)`) is a
   different mechanism (scheduler, both lanes) — left as noted.
