---
id: 5367
title: "`await Promise.all(...)` inline yields the wrong value (a default-initialised tuple / empty array)"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
language_feature: async, Promise.all
related: [5340, 5338, 1042, 1373b, 4110, 1727]
---

## Problem

Awaiting a `Promise.all(…)` **call expression directly** produces a value that
is not the resolved array. Binding the promise to a local first and awaiting
the local is correct. Measured on a clean detached worktree at upstream/main
`cbd2f11dff` (and on `a1469a5454`), JS-host GC lane (`target: "gc"`, `platform: "web"`), with and
without `experimentalIR` — both reproduce.

Four-line repro (`compileProject`, untyped `.js`):

```js
export async function run() {
  const r = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
  return 'INLINE len=' + String(r.length) + ' i0=' + String(r[0]) + ' json=' + JSON.stringify(r)
}

export async function probe() {
  const p = Promise.all([Promise.resolve(1), Promise.resolve(2)])
  const r = await p
  return 'VIA-LOCAL len=' + String(r.length) + ' i0=' + String(r[0]) + ' json=' + JSON.stringify(r)
}
```

```
RUN   => INLINE    len=NaN i0=NaN json={"_0":null,"_1":null}   ← wrong
PROBE => VIA-LOCAL len=2   i0=1   json=[1,2]                   ← correct
```

`{"_0":null,"_1":null}` is a **default-initialised wasm tuple struct** — the
static awaited type of `Promise.all([Promise<number>, Promise<number>])` is the
tuple `[number, number]`, and the resume binding appears to materialise that
type instead of carrying the host array through. When the argument is a
**variable** rather than an array literal (so the awaited type is `number[]`)
the same shape produces an **empty array** instead:

```
const ps = [7, 8].map((i) => fn(i))
const r  = await Promise.all(ps)     // len=0, json=[]
```

An explicit `const r: any = await Promise.all([…])` does **not** fix it (it
yields `{}`), so this is not purely a tuple-type materialisation.

Worse, in the array-of-pending-promises form the awaited continuations never
run at all: with `fn = async (i) => { seen.push('s'+i); await gate; seen.push('e'+i); return i }`,
`await Promise.all([fn(0), fn(1)])` returns `[]` and `seen` is `s0|s1` — the
`e0|e1` half never executes. So `Promise.all` is not merely returning the wrong
value, it is not waiting.

`await Promise.resolve(1)` is correct, and sequential `await a; await b` on the
same promises is correct — the defect is specific to the aggregator call in
await position.

## Impact

This is the sole remaining blocker for hono `src/utils/concurrent.test.ts`
(0/6 on main `cbd2f11dff`). All six of its tests end in
`const results = await Promise.all(resultPromises)`, and four of them then assert
on state the un-awaited continuations were meant to mutate. It surfaced while
investigating #5340, whose own root cause — tagged-template substitutions
dropped — #5338 fixed: with the `RangeError: Invalid array length` gone, every
one of the six now fails here instead.

Anything that fans out with `Promise.all` is affected, so the blast radius is
much wider than one hono file.

## Reproduction ladder (all measured, JS-host GC lane)

| shape | result | native |
| --- | --- | --- |
| `await Promise.resolve(1)` | `1` ✅ | `1` |
| `const p = Promise.all([…]); await p` | `[1,2]` ✅ | `[1,2]` |
| `await Promise.all([Promise.resolve(1), Promise.resolve(2)])` | `{_0:null,_1:null}` ❌ | `[1,2]` |
| `await Promise.all(psVariable)` | `[]` ❌ | `[1,2]` |
| `await Promise.all([7,8].map(fn))` | `[]`, continuations skipped ❌ | `[7,8]` |
| `const a = fn(7); const b = fn(8); await a; await b` | `7`, `8` ✅ | `7`, `8` |

## Where to look

- `src/codegen/expressions/call-namespace-static.ts` — the aggregator arm is
  reached (verified by instrumentation); it emits the `Promise_all(thisArg,
  iterable, directCall)` host import and returns `externref`. The host import
  itself (`src/runtime.ts` ~15638 `Promise.all.call(C, _toIterable(arr))`) is a
  faithful delegation, so the loss is on the consumer side.
- `src/codegen/async-cps.ts` / `src/codegen/async-ir-planning.ts` — the resume
  binding's wasm type and the coercion applied to the resumed externref.
  `isAmbientPromiseAll` (async-ir-planning ~490) is a *specialised* path for
  `await Promise.all(<identifier>)`; the array-literal form does not take it,
  and both forms are wrong, so the defect is likely in the shared resume-binding
  typing rather than in that specialisation.

## Acceptance criteria

1. The four-line repro above prints the same string for `run()` and `probe()`.
2. hono `src/utils/concurrent.test.ts` ≥ 5/6 (its `RangeError` blocker is
   already fixed on main by #5338).
3. Regression test under `tests/`, untyped `.js` two-file fixtures, failing on
   the parent and passing with the fix, pinning the resolved VALUES (not just
   `length`), with an anti-vacuity control on the via-local form that already
   works.
4. A/B at one HEAD over all 17 dogfood suites, per test file.
