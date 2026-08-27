---
id: 4768
title: "A generator passed as a function argument is eagerly drained to the 1e6 cap (breaks infinite generators; 375+ ES2015 rows)"
status: ready
created: 2026-08-27
updated: 2026-08-27
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: generators
goal: spec-completeness
sprint: current
horizon: l
---

# #4768 — a generator argument is drained at the call boundary

## Problem

Passing a compiled generator to **any** function eagerly runs it to exhaustion —
or, for an infinite generator, to the 1,000,000-step defensive cap. No
destructuring is required; an ordinary parameter is enough.

Measured 2026-08-27 through the runner's own `runTest262File` (submodule pinned
at `b363f29d3c43c626dc852744ad64a0b48a003693`), with
`scripts/run-test262-paths.mts --isolate`:

```js
var n = 0;
function* g() { while (true) { n++; yield n; } }

function plain(x) { return 1; }
plain(g());          // n === 1000001   ← must be 0; `x` is never even read
function f([,]) {}
f(g());              // a further 1000001 steps
```

Per-pattern, every shape drains identically — including `[]`, which §8.5.3
requires to consume **zero** IteratorSteps:

```
[,]=1000001  [,,]=1000001  [a]=1000001  [a,b]=1000001  []=1000001  [[]]=1000001
```

## Why this looks like a destructuring bug and is not

The visible symptom is the array-binding-pattern **elision** family. `[,]` must
call `next()` exactly once; test262 asserts it via a generator that finishes
after two steps, so "drain to completion" reads as "one step too many":

```
language/expressions/class/dstr/gen-meth-ary-ptrn-elision.js
  assert.sameValue(second, 0)  →  Expected SameValue(«1», «0»)
```

All 20 `*ary-ptrn-elision.js` rows across every function form (generators,
methods, object methods, async generators, defaults) fail with this identical
message. **375 ES2015 rows mention elision**, and the true blast radius is
larger — every `dstr` row whose fixture iterator has observable side effects,
plus `iter-close` / `iter-step` families.

The destructuring machinery itself is **correct**, which is why the bug hid:

- `patternIteratorStepCount` returns the right count (TS gives `[,]` exactly one
  `OmittedExpression` element — verified against the parser).
- That count reaches the runtime intact: tracing shows
  `__array_from_iter_n_strict limit=1`.
- `_drainIterable`'s loop is bounded (`while (out.length < limit)`).
- `_stepClosureIterator` honours its `limit` too, and its cap is `1 << 16`, not
  1e6.

None of those produce 1,000,001. The drain happens **before** any of them.

## Where the 1e6 comes from

`_drainClosureIterableToArray` (`src/runtime.ts:2964`) is the only 1e6 site:

```ts
return _stepClosureIterator(iterator, exports, { cap: 1_000_000, nullOnMalformedNext: true });
```

It takes **no `limit` argument at all** — it is an unbounded drainer whose
comment assumes "the test262 cases that reach here yield a single value". It is
reached from `_materializeIterable` (`src/runtime.ts:3017`) when the value's
`[Symbol.iterator]` is a wasm closure struct, which is exactly what a compiled
generator is.

So an argument-position generator is materialised through the unbounded path,
and the carefully bounded destructuring path downstream then slices an
already-exhausted array. The bound is applied one layer too late.

## Implementation Plan

1. **Reproduce first.** `scripts/run-test262-paths.mts --isolate` on
   `.tmp/all-elision.txt` (the 375 rows; regenerate with
   `grep elision` over the ES2015 path list). Isolation is mandatory — the
   `*-array-prototype.js` variants poison the realm, and an in-process run
   reports garbage for everything after the first one.
2. **Find the caller that materialises an argument.** The drain is upstream of
   `__array_from_iter_n`; trace `_materializeIterable`'s callers
   (`src/runtime.ts:578`, `:691`, `:10023`) and the argument-marshalling path
   for a wasm-struct value reaching a JS-host boundary. The question to answer
   is why an ordinary parameter materialises its argument at all — `plain(x)`
   never reads `x`.
3. **Make laziness the default at that boundary.** A generator argument should
   stay a live iterator; only a consumer that genuinely needs an array
   (destructuring with a known step count, spread, rest) should materialise, and
   then with its bound. Threading a `limit` into
   `_drainClosureIterableToArray` is the smaller change but only papers over
   step 2 if the eager call itself is unnecessary.
4. **Guard the zero case explicitly.** `function f([]) {}` must consume **no**
   iterator steps (§8.5.3 `ArrayBindingPattern : [ ]` returns
   NormalCompletion without an IteratorStep). It currently drains. This is the
   cheapest single assertion that proves the fix.
5. Add permanent equivalence coverage counting `next()` calls for `[]`, `[,]`,
   `[, ,]`, `[a]`, `[a, b]`, `[[]]`, and a plain parameter — the exact table
   above, which is currently 1000001 across the board.

## Acceptance criteria

- [ ] `plain(g())` on an infinite generator consumes **0** steps
- [ ] `[]` → 0 steps · `[,]` → 1 · `[, ,]` → 2 · `[a]` → 1 · `[a, b]` → 2
- [ ] The 20 `*ary-ptrn-elision.js` rows pass
- [ ] No regression across the ES2015 `dstr` families, measured with `--isolate`

## Notes

Infinite generators are currently unusable as arguments in compiled code — the
call hangs for a million steps and then silently truncates. That is a
correctness and a performance bug independent of test262.
