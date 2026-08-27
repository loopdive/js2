---
id: 4768
title: "Array binding-pattern elision consumes too many iterator steps (20 rows confirmed; mechanism UNCONFIRMED)"
status: ready
created: 2026-08-27
updated: 2026-08-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: current
horizon: l
---

# #4768 — elision consumes too many iterator steps


> **Status of the mechanism: UNCONFIRMED.** The FAILING ROWS are real and
> reproducible through the runner. The explanation below — that aliasing a
> generator drains it — is **not** supported by the emitted code, and a later
> check contradicts it. Read "What is confirmed" before acting on any of it.

## What is confirmed

- **20 rows fail, identically.** Every `*ary-ptrn-elision.js` across every
  function form (generators, methods, object methods, async generators,
  defaults) reports `Expected SameValue(«1», «0»)` — an initializer observed
  once when the spec says zero. Reproduced with
  `scripts/run-test262-paths.mts --isolate` at the pinned submodule SHA. This is
  the runner's own verdict, not a hand-rolled probe.
- **375 ES2015 rows mention elision**; the blast radius is at least the 20.
- The destructuring step-count machinery is correct: `patternIteratorStepCount`
  returns 1 for `[,]` (checked against the TS parser) and that count reaches the
  runtime intact (traced: `limit=1`).

## What is NOT confirmed — and the evidence against it

The step-count tables below were produced by test262-shaped probes that count a
module variable incremented inside a generator body. They consistently showed
1,000,001 steps on alias. But compiling the same shapes and reading the EMITTED
WAT shows **no drain at all**:

```
module scope   var a = fin(); var a2 = a;   → global.get 4; local.tee 2; global.set 5
inside fn      same                          → no drain markers
passed to fn   plain(fin())                  → no drain markers
```

Scanned for `__array_from_iter`, `__iterator_next`, `__extern_length` and the
literal `1000000`: none present in any of the three. Combined with the four
JS-side drainers already excluded by instrumentation, there is no identified
mechanism that could produce 1,000,001 — which means the probe's counter is
likely measuring something other than iterator steps.

**But note exactly what that evidence does and does not cover.** All three
shapes above are plain ALIASES; none contains a destructuring pattern. An
attempt to read the emitted code for the actual elision shapes
(`function f([,]) {}` called with `g()`) produced **nothing**, because the
compile fails before emit:

```
error L3  Argument of type 'Generator<1 | 2, void, unknown>' is not assignable
          to parameter of type '[any?]'.
success: false   bytes: 0   watLen: 0
```

TypeScript rejects a Generator against a tuple-typed binding pattern, so a
`.ts` probe cannot exercise this at all — while the test262 rows, being plain
JS with no annotations, compile and run fine under the runner. **So the WAT
evidence refutes the alias/drain story but says nothing either way about the
elision path.** Probe it as JS (the runner's own `wrapTest`), never as
annotated TypeScript.

**Do not build on the mechanism sections below without first re-deriving the
count from the emitted code.** They are retained only to save the next reader
from repeating the same four exclusions.

## Original problem statement (mechanism unconfirmed)

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
- **`_arrayFromIter`** — not reached for the bare alias (`var a = fin(); var a2 = a;`).
- **`__extern_length`** — contains no drain; it reads an own `length` (or 0).

**Every JS-side drainer is excluded by instrumentation.** The drain is therefore
emitted Wasm: codegen produces a loop that runs the iterator to completion when
a generator is bound to a new name, and 1e6 is a cap in that emitted loop, not
in `runtime.ts`.

Two further measurements pin its shape:

- It drains to **natural completion**, not blindly to the cap:
  `function* fin() { for (var i=0;i<3;i++) { n++; yield i; } }` then
  `var a = fin(); var a2 = a;` gives `n === 3`. The 1e6 only appears for an
  infinite generator, as the runaway guard.
- `buildVecFromExternref` IS reached, but at module-generation time via
  `reserveVecFieldMaterializers` (`member-set-dispatch.ts:543`) — that registers
  materializer functions, so it identifies the family of lowering to look at,
  not the executing call.

Start from `emitStandaloneIterableMaterialize` / the native `__iterator` /
`__iterator_next` drive loop and the vec-materializer emitters, and find the cap
constant there.

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
