---
id: 4768
title: "Compiled generators are buffer-backed: one host-side next() runs the whole body (elision + every iterator-step row)"
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
loc-budget-allow:
  - src/codegen/destructuring-params.ts
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/destructuring-params.ts::destructureParamArray
  - src/codegen/generators-native.ts::hostLaneGeneratorUsesAreSafe
---

# #4768 — compiled generators run to completion on first host-side next()


> **Root cause CONFIRMED** (see the section below), and the fix is **bounded**:
> the native suspend/resume generator lowering already exists and already
> handles this generator shape — one use-site gate (`f(g())`, a plain call
> argument) routes it to the eager buffer instead. Everything below the
> root-cause sections is the reduction trail — eight superseded hypotheses, kept
> only so they are not retried.

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

## CONFIRMED from emitted code — two materialisers, one unbounded

Compiling the real row through the runner's own `wrapTest` (the only way to
compile it — see the TypeScript note below) and reading the WAT shows the module
imports **both** helpers and calls **both**:

```
__array_from_iter_n_strict  (import 16)  — 1 call site
    local.get 1 / f64.const 1 / call 16          ← BOUNDED, correct: 1 step for `[,]`

__array_from_iter           (import 18)  — 1 call site
    local.get 6 / ref.is_null / (if (then
    local.get 1 /              call 18            ← UNBOUNDED, full drain
```

So the bounded path exists and computes the right budget (`f64.const 1` for
`[,]`), and a **second, unbounded fallback** is emitted alongside it behind a
`ref.is_null` guard on a different local. A full drain of a 2-yield generator is
2 steps, which is exactly the observed `Expected SameValue(«1», «0»)`.

**Finding and bounding that second emitter is the fix.** Candidates ruled out:

- `buildTupleFromIterableFallback` (`type-coercion.ts:1201`) — bounding it (host
  lane to `__array_from_iter_n`, native lane to `tupleFields.length` instead of
  `-1`) left the emitted WAT byte-identical for this row and all 20 rows still
  failing, so this row does not take that path. Reverted, unshipped. It is
  probably still worth bounding on its own merits — a tuple has fixed arity, so
  the unbounded drain there is observably wrong too — but it needs its own
  measurement.
- `nested-declarations.ts:2912` — the spread-arguments path; `f(g())` has no
  spread.

### The unbounded emitter — FOUND

`buildVecFromExternref` (`src/codegen/type-coercion.ts:823` and `:837`):

```ts
ensureLateImport(ctx, strictIterator ? "__array_from_iter_strict" : "__array_from_iter", …)
…
const iterIdx = useNativeMaterializer
  ? ctx.funcMap.get("__array_from_iter_n")        // native lane: BOUNDED
  : useNativeObjVec
    ? undefined
    : ctx.funcMap.get(strictIterator ? "__array_from_iter_strict" : "__array_from_iter");
                                                   // host lane: UNBOUNDED
```

The host lane calls the unbounded helper; only the native lane got the bounded
one. That is the `call 18` in the emitted WAT.

**Why it has no bound to pass, and why this is a design change not a one-liner.**
`buildVecFromExternref` builds a vec of *unknown* length from an iterable, so it
takes no step-count parameter — and it reaches the module through
`reserveVecFieldMaterializers` (`member-set-dispatch.ts:543`), which registers a
**shared, pre-registered materializer function** at module-generation time. A
single shared function body cannot carry a per-call-site §8.5.3 budget as
things stand.

So the row emits both paths — the bounded destructuring call (`call 16`,
`f64.const 1`) and this shared unbounded materializer (`call 18`) — behind
different `ref.is_null` guards, and the unbounded one wins.

The fix is one of:

1. Give the registered materializer a step-budget parameter and thread the
   pattern's `patternIteratorStepCount` through every caller, passing `-1`
   (unbounded) only for rest/spread.
2. Make the destructuring path never fall through to the shared materializer —
   i.e. ensure the bounded arm's guard covers the iterable case that currently
   reaches `call 18`.

Option 2 is smaller if the guard condition turns out to be the only reason the
unbounded arm is reached; option 1 is the one that fixes every other caller too.
Either needs a before/after run of the 20 rows plus the wider `dstr` families.

### The emitted chain is THREE tiers, and tier 3 may never run

Reading the full WAT region, all three arms are guarded on the *same* local
being null, so they are mutually exclusive:

```
   …build vec fast path…            local.set 6      ← tier 1
   local.get 6 / ref.is_null / (if (then
       local.get 1 / f64.const 1 / call 16           ← tier 2  BOUNDED (correct budget)
       …                            local.set 6
   local.get 6 / ref.is_null / (if (then
       local.get 1 /              call 18            ← tier 3  UNBOUNDED
       …                            local.set 6
```

For a generator, tier 2 (`__array_from_iter_n_strict(gen, 1)`) should return a
one-element array, so **tier 3 probably never executes** and the unbounded
`call 18` may be a red herring for this row. The extra IteratorStep then has to
come from tier 1 partially consuming before failing, or from the whole chain
running twice. That is the next thing to measure — instrument which tier sets
local 6.

## ROOT CAUSE — compiled generators are BUFFER-BACKED, not lazy

`src/runtime/iterator-polyfills.ts:278` — `Generator.prototype.next`:

```ts
// (#3032) Lazy generator: run the deferred body now (first resume).
if (state.materialize) state.materialize();
if (state.index < state.buf.length) {
  return { value: state.buf[state.index++], done: false };
}
```

The first `next()` calls `state.materialize()`, which runs the **entire
generator body to completion** into `state.buf`. Every later `next()` just reads
the buffer. "Lazy" here means the body is deferred until the first resume — not
that resumption is incremental.

**This explains every measurement in this issue, and they now compose:**

| observation | explained by |
| --- | --- |
| `[,]` observes 2 steps on a 2-yield generator | one `next()` runs the whole body |
| `y1,AFTER,fin` instead of `y1,fin` | the body runs to completion, `finally` included |
| the drain calls `next()` exactly once (`DI nextCalls=1`) | correct — one call is enough to run everything |
| every budget measured correct (materialiser once, `limit=1`) | correct — the budget was never the problem |
| an infinite generator reaches 1,000,001 | `materialize()` hits its runaway cap |
| a plain parameter (`plain(g())`) drains | any host-side `next()` triggers it |
| `.return()` before any `next()` is clean | `return` drops the thunk without materialising |

So this is **not** a destructuring bug, not a budgeting bug, and not an
aliasing bug. Array-pattern elision is simply the family that makes it
observable, because §8.5.3 pins the exact IteratorStep count.

### How the buffer is produced

`src/runtime.ts:15673` — `st.materialize`:

```ts
setEager(1);                 // exports.__gen_set_eager
inner = callFn0(thunk);      // run the compiled generator body to completion
setEager(0);
const innerSt = _GeneratorState.get(inner);
st.buf = innerSt.buf;        // adopt the fully-populated buffer
```

The compiled body is invoked once, in **eager mode**, and yields are collected
into `buf`. The in-tree name for this is "the buffer lowering" (see the #3032
comment just above: *"the eager-at-creation side effects of the buffer
lowering"*). #3032 deferred the body from creation-time to first-resume, which
fixed `var it = g()` observing side effects — but a resume still runs
**everything**.

`__gen_set_eager` is **not** an incremental-vs-eager switch — settled by reading
`ensureGenEagerFlag` (`closures.ts:1868`). It is lazy-CREATION vs
run-the-whole-body: flag `0` makes `function*(){…}` return a lazy thunk instead
of running at creation (#3032); flag `1` makes the re-invoked closure "take the
historical eager-buffer path, **byte-for-byte**". There is no incremental mode
behind it, so nothing can be driven incrementally through that flag.

### NOT a design change — the state machine already exists, and this row is one gate away

This was written up as "a coroutine rewrite, not a patch". That was wrong, and
the correction is the actionable part of this issue.

A real suspend/resume native generator lowering **already ships**:
`src/codegen/generators-native.ts` — a WasmGC state struct plus a resume
function, no buffer. Since **#3032 W6** it is the host-lane lowering for free
`function*` declarations. `isNativeGeneratorCandidate` decides who gets it, and
`generators-native.ts:2051` says outright that generator EXPRESSIONS and METHODS
keeping the eager path are "separate W6 slices" — planned work, not a missing
mechanism.

The elision rows use a **free declaration**, so they clear that gate. What
rejects them is the use-site safety walk, `hostLaneGeneratorUsesAreSafe`
(`generators-native.ts:1772`). The fixture's last line is the whole problem:

```js
function* g() { first += 1; yield; second += 1; }
f = ([,]) => { assert.sameValue(first, 1); assert.sameValue(second, 0); };
f(g());          // ← generator flows into an ORDINARY CALL ARGUMENT
```

`useIsSafe` allowlists exactly: `.next()/.throw()/.return()` member calls,
`for…of`, spread, `Array.from`, and parenthesised forms of those. A plain call
argument is none of them, so the walk returns false and `g` falls back to the
eager buffer — where one host-side `next()` runs the body to completion and
`second` is 1 where §8.5.3 requires 0. That single rejection is the whole bug on
this family.

The rejection is *correct as written*: the native factory returns a raw WasmGC
state struct and an ordinary parameter is externref, so passing it across a call
boundary loses the type — the same reason `viaBinding` iteration consumers are
rejected (see the #3468 note in that walk).

So the fix is a bounded W6-style slice, not a rewrite: **carry the state-struct
type across a call boundary when the callee is statically known** — here `f(g())`
where `f`'s parameter is destructured. Escape into an *unknown* callee must keep
the eager path.

Scope note: the failing rows are host-lane. A generator driven from **compiled**
code was measured correct (`var it = g(); it.next()` → `first=1 second=0`) —
that is this same native machine, which is why it is already incremental there.

### Superseded: LOCALISED — one host-side `next()` resumes the generator TWICE

The `finally` probe separates a `return()` from a `next()` — only a `next()`
resumes past the yield:

```js
function* g() { try { log.push("y1"); yield 1; log.push("AFTER"); yield 2; } finally { log.push("fin"); } }
function f([,]) { return 1; }
f(g());

  expected  y1,fin              (one next, then IteratorClose → return → finally)
  actual    y1,AFTER,fin        ← the body resumed past the yield
```

And the drain that drives it calls `next()` exactly **once**:

```
DI nextCalls=1 out=1 limit=1
```

So a **single host-side `it.next()` on a compiled generator resumes it twice**
and then completes it. That is the extra IteratorStep, and it is not a
budgeting bug anywhere in the destructuring chain — every budget measured
correct.

Crucially this is **boundary-specific**: the same generator driven from compiled
code is correct —

```js
var it = g(); it.next();     first=1 second=0     ✓
it.return(42);               first=1 second=0 done=true val=42   ✓
```

— so the fault is in the host-facing `next()` wrapper for a wasm generator
(the `_resolveIterProp` / `__call_fn_*` path that JS uses to drive a compiled
iterator), not in the generator lowering itself.

**This supersedes every earlier hypothesis in this issue** (eager drain on
alias, an unbounded materialiser tier, IteratorClose calling the wrong method,
generator-method prologue timing). All are measured-and-discarded; the sections
below are kept only so they are not retried.

Start here: find where JS-side code invokes a compiled generator's `next` and
determine why one invocation produces two resumes.

### The measurement that does NOT compose — SUPERSEDED, kept for the exclusions

Instrumenting the actual failing row end to end gives three facts that cannot
all be true together. Resolving that contradiction is the task:

1. **The materialiser runs exactly ONCE**, with the right budget:
   `TIER name=__array_from_iter_n_strict limit=1` — a single occurrence.
   Tier 3 (the unbounded `call 18`) never executes.
2. **`_drainIterable` is the branch taken** (`DI limit=1 strict=true`), and it
   does *not* hit the `Array.from` fallback. Its loop is provably one step:
   `while (out.length < limit) { r = it.next(); if (r?.done) break; out.push(r.value) }`
   with `limit === 1`.
3. **`_stepClosureIterator` is never called** — no `_walkWasmIterator` path.

One call, budget 1, a one-step loop — yet the row observes **two** IteratorSteps
(`second === 1` where the spec requires `0`).

So the second step happens **outside every path instrumented above**. Do not
re-instrument those three; they are covered.

Remaining candidates are on the compiled side. Note the receiver here is itself
a **generator method** (`*method([,])`), so its parameter prologue runs at
[[Call]] while the body runs at the first `.next()` — destructuring executing
twice, or at the wrong time, would produce exactly this.

Cheapest next probe: bind the same generator to a plain function parameter
versus a generator-method parameter and compare step counts. That separates
"destructuring runs twice" from "destructuring runs at the wrong time".

### Also ruled out: IteratorClose

§8.5.3 does call IteratorClose when a pattern stops early, and
`_stepClosureIterator` passes `closeOnStop: true`, so a `.return()` that wrongly
resumed the generator body would explain the extra step exactly. It does not —
`.return()` is correct:

```
var it = g(); it.next();      first=1 second=0
it.return(42);                first=1 second=0  done=true  val=42
```

The body is not resumed. So the extra step is not the close.

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

Steps 2–3 of the original plan chased the alias/1e6 hypothesis and are
**retracted** — see the retraction trail below. The plan now follows the
confirmed gate.

1. **Reproduce first.** `scripts/run-test262-paths.mts --isolate` on
   `.tmp/all-elision.txt` (the 375 rows; regenerate with `grep elision` over the
   ES2015 path list). Isolation is mandatory — the `*-array-prototype.js`
   variants poison the realm, and an in-process run reports garbage for
   everything after the first one.
2. **Confirm the routing on the real row.** Compile
   `language/expressions/arrow-function/dstr/ary-ptrn-elision.js` through the
   runner's `wrapTest` and check whether `g` took the native or the eager path
   (the eager path imports the `__gen_*` family; the native path emits a state
   struct). Expect eager, rejected by `hostLaneGeneratorUsesAreSafe` at the
   `f(g())` argument position. If it is rejected somewhere else instead, stop
   and re-derive — do not build on this plan.
3. **Extend `useIsSafe` to the statically-known-callee argument position.** A
   generator call as an argument is safe only when the callee resolves to a
   local function whose corresponding parameter is consumed natively (an array
   binding pattern here). Everything else — unknown callee, reassignable
   binding, callee that stores the parameter — must keep the eager path. This is
   the same shape as the existing `bindingHasGeneratorInitializer` carve-out,
   and it is where the risk in this issue lives: the walk is a **safety** walk,
   and widening it wrongly silently drops values rather than erroring.
4. **Thread the state-struct type through that parameter.** The callee's param
   is externref today, which is exactly why the walk rejects the position; the
   native destructuring drain (`tryCompileNativeGeneratorForOf` /
   `emitNativeGeneratorToVec`) needs the struct ValType at the use site.
5. **Guard the zero case explicitly.** `function f([]) {}` must consume **no**
   iterator steps (§8.5.3 `ArrayBindingPattern : [ ]` returns NormalCompletion
   without an IteratorStep). Cheapest single assertion that proves the fix.
6. Add permanent equivalence coverage counting `next()` calls for `[]`, `[,]`,
   `[, ,]`, `[a]`, `[a, b]`, `[[]]`, and a plain parameter.

## Acceptance criteria

- [x] `plain(g())` on an infinite generator consumes **0** steps
- [x] `[]` → 0 steps · `[,]` → 1 · `[, ,]` → 2 · `[a]` → 1 · `[a, b]` → 2
- [x] The 20 `*ary-ptrn-elision.js` rows pass
- [ ] No regression across the ES2015 `dstr` families, measured with `--isolate`
- [x] No regression in the `GeneratorPrototype/*` families — widening
      `useIsSafe` is precisely what #3468 and the `result-prototype.js`
      regression note in that walk were caused by

## Measured implementation evidence

The bounded native state carrier is implemented on
`codex/4768-generator-call-boundary` (PR #5044). Measurements below use the
pinned `test262` fixture at `b363f29d3c43c626dc852744ad64a0b48a003693` and
were run on 2026-08-27. The exact selected-row host A/B uses the plan
checkpoint `2390d0175` as its baseline:

- Host baseline: **0/20 pass** (`{ fail: 20 }`); after: **20/20 pass**
  (`{ pass: 20 }`).
- Standalone after: **20/20 pass** (`{ pass: 20 }`).
- Permanent focused coverage in
  `tests/issue-4768-generator-call-boundary.test.ts`: **10/10 tests**. It
  covers an infinite unused plain argument (0 steps), `[]` (0), `[,]` (1),
  `[, ,]` (2), `[a]` (1), `[a,b]` (2), nested `[[]]` (1), plus unknown and
  reassignable callees remaining on the conservative eager path (2 steps).
- Matching same-base controls: the 11 `ary-ptrn-empty.js` rows are **11/11
  pass** before and after; the 11 `ary-ptrn-elem-id-iter-complete.js` rows are
  **8 pass / 3 fail** before and after, with identical row verdicts. The three
  existing statement-form failures are unchanged and are not introduced by
  this call-boundary lane.
- GeneratorPrototype host controls: **5 pass / 1 fail** before and after,
  with byte-identical JSONL verdicts. The lone existing failure is
  `built-ins/GeneratorPrototype/next/from-state-executing.js` (expected
  `TypeError` not thrown); `next/result-prototype.js` passes in both runs.
  The standalone result-prototype probe still has the pre-existing
  `null`-versus-object failure and is outside this host-lane change.
- Existing native-generator regression suites (11 focused files, including
  #2169, #2172, #2571, #2581, #2864, #3032, and #4922): **92/92 tests pass**.
  Changed-file Biome lint and Prettier checks pass; the changed-file filtered
  TypeScript check reports no errors (the repository-wide check retains
  unrelated baseline diagnostics).

Commands and JSONL artifacts:

```text
node --import tsx scripts/harness-flip-probe.ts --files .tmp/4768-selected-all.txt --target host --timeout 120000 --out .tmp/4768-host-after-final.jsonl
node --import tsx scripts/harness-flip-probe.ts --files .tmp/4768-selected-all.txt --target standalone --timeout 120000 --out .tmp/4768-standalone-after-final.jsonl
node_modules/.bin/vitest run tests/issue-4768-generator-call-boundary.test.ts
node_modules/.bin/vitest run tests/issue-2169-destructure-native-generator.test.ts tests/issue-2169-arrayfrom-native-generator.test.ts tests/issue-2169-spread-native-generator.test.ts tests/issue-2172-nested-native-generator.test.ts tests/issue-1665-standalone-generator-forof.test.ts tests/issue-3032-lazy-generator-expressions.test.ts tests/issue-3032-w4-method-generators.test.ts tests/issue-2571-native-method-generators.test.ts tests/issue-2581-objlit-method-generators.test.ts tests/issue-2864-s2-generator-arguments.test.ts tests/issue-4922-generator-arguments.test.ts
```

The full 375-row ES2015 `dstr` sweep described in the original reduction was
not rerun; that criterion intentionally remains unchecked. The exact 20-row
scope, focused ordinary-call semantics, and same-base GeneratorPrototype
regression proof are complete. Keep PR #5044 draft until current-main
integration, required CI, and mergeability are verified by the handoff owner.
## Notes

Infinite generators are currently unusable as arguments in compiled code — the
call hangs for a million steps and then silently truncates. That is a
correctness and a performance bug independent of test262.
