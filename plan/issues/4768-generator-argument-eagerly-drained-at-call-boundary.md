---
id: 4768
title: "Aliasing a generator to a second binding eagerly drains it to the 1e6 cap (breaks infinite generators; 375+ ES2015 rows)"
status: ready
created: 2026-08-27
updated: 2026-08-27
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: current
horizon: l
---

# #4768 — aliasing a generator drains it

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

## The trigger, measured — aliasing, not the call

A generator is perfectly lazy until it is bound to a **second** name:

| source | iterator steps |
| --- | ---: |
| `var it = g();` | **0** ✓ |
| `var it = g(); it.next();` | **1** ✓ |
| `var it = g(); var u = it;` | **1,000,001** ✗ |

A parameter is an alias, which is why *every* call drains — `plain(g())` binds
the generator to `x`. The call boundary is a symptom of the aliasing rule, not
the rule itself.

## What this is NOT — two attributions measured and discarded

Recorded so the next attempt does not repeat them:

- **`_drainClosureIterableToArray` (`runtime.ts:2964`)** is the only 1e6 site in
  the runtime, and an earlier draft of this issue blamed it. Instrumented with a
  stack dump, it is **never reached** for `plain(g())`.
- **`_stepClosureIterator`** is not reached either (same method). Its cap is
  `1 << 16`, not 1e6, so it could not have produced 1,000,001 regardless.

So the drain is not in either runtime drainer. It happens on the compiled side,
at whatever lowering handles binding a generator value to a new name. The 1e6
constant should be located there rather than assumed to be the runtime's.

## Implementation Plan

1. **Reproduce first.** `scripts/run-test262-paths.mts --isolate` on
   `.tmp/all-elision.txt` (the 375 rows; regenerate with
   `grep elision` over the ES2015 path list). Isolation is mandatory — the
   `*-array-prototype.js` variants poison the realm, and an in-process run
   reports garbage for everything after the first one.
2. **Find the 1e6 on the COMPILED side.** Both runtime drainers are ruled out by
   instrumentation (see above), so start from the lowering for `var u = it`
   where `it` holds a generator — the minimal three-line reproduction — rather
   than from the argument path. `plain(x)` never reads `x`, so nothing about the
   callee can justify materialising.
3. **Make laziness the default for an alias.** Binding a generator to a new name
   must copy the reference, not materialise. Only a consumer that genuinely
   needs an array (destructuring with a known step count, spread, rest) should
   materialise, and then with its bound. Note `it.next()` already stays lazy, so
   a lazy path exists — the question is why the alias does not take it.
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
