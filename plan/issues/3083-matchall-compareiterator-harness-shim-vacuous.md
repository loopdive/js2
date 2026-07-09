---
id: 3083
title: "test262 matchAll/RegExpStringIterator 'assert is not defined' cluster (13) — compareIterator/matchValidator harness shim is a #2939 vacuity trap, do NOT land it"
status: wont-fix
sprint: Backlog
priority: low
horizon: s
feasibility: hard
reasoning_effort: max
task_type: research
area: test262-harness
language_feature: regexp, matchAll, closures, dynamic-dispatch, test262-harness
model: fable
related: [2939, 2940]
created: 2026-07-07
origin: "2026-07-07 dev-A2 harvest of .test262-cache 'assert is not defined' cluster; verified vacuous via negative control on main f426ef61."
---

# #3083 — matchAll `assert.compareIterator` shim is a #2939 vacuity trap (don't re-chase)

## TL;DR / verdict

13 test262 files (`built-ins/RegExp/prototype/Symbol.matchAll/*`,
`built-ins/RegExpStringIteratorPrototype/next/*`, `built-ins/String/prototype/matchAll/*`,
`RegExp/named-groups/duplicate-names-matchall.js`) currently fail the runner
with **`assert is not defined`**. Root cause: they use the
`compareIterator.js` + `regExpUtils.js` harness helpers — `assert.compareIterator(iter, [validators])`
and `matchValidator(entries, index, input)` — which `tests/test262-runner.ts`
does not shim (it shims `assert.compareArray`/`deepEqual` but not
`compareIterator`), so the un-rewritten `assert.compareIterator` reads a
non-existent `assert` object.

**Adding the shim is a trap: it produces VACUOUS passes, not honest ones.**
Measured — do NOT land a `compareIterator`/`matchValidator` runner shim until
#2939 lands.

## What was tried + measured (verify-first)

Implemented the faithful runner shim (`assert.compareIterator` →
`assert_compareIterator`; `matchValidator` returning a validator closure), gated
+ cache-keyed like the existing helpers. Result via `runTest262File` on main
`f426ef61`:

- **7 / 13 flip to "pass"**, 1 hits a real species-constructor gap
  (`callCount` mismatch), 5 throw a separate `pattern.exec is not a function`
  bug (custom-`exec`/subclass — out of scope here).
- **Negative control (the honesty gate):** sabotaged `matchValidator` to assert
  a deliberately WRONG `match.index` (`expectedIndex + 1000`). **All 7 still
  passed.** ⇒ the per-value validators **never dispatch** — the pass only checks
  that the iterator yields the expected *count* and terminates, not the match
  entries/index/input.

## Root cause

`assert_compareIterator` does `validators[i](step.value)` where `validators` is
an `any[]` of **compiled closures**. Dispatching a closure held in an
`any`-typed array element is the **#2939** dynamic-closure-dispatch gap (the
same substrate that makes the #2940 TypedArray harness-wrapper cluster vacuous):
the call is dropped, so the closure body (which holds the real assertions) never
runs. `matchValidator`'s returned closure is likewise never invoked.

## Decision

`wont-fix` as an Opus/harness task. The shim is **correct code** but yields
dishonest metric inflation on the current compiler, so it must **not** be added
until #2939 (arity/type-tolerant dynamic dispatch of an `any`-typed closure)
lands — at which point the same shim flips these to honest passes. Tracked here
so the "assert is not defined" cluster is not re-harvested as low-hanging fruit.

- **Blocked on:** #2939 (dynamic closure-array dispatch).
- **Sibling:** #2940 (identical vacuity root cause, TypedArray harness wrapper).
- **Also note:** 5 of the 13 additionally need the `pattern.exec is not a
  function` custom-exec path; those stay failing independently of the shim.
