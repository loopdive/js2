---
id: 4768
title: "Compiled generators are buffer-backed: one host-side next() runs the whole body (elision + every iterator-step row)"
status: in-progress
assignee: ttraenkler/codex-4768-es6-step-errors
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
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
---

# #4768 — compiled generators run to completion on first host-side next()

## Post-merge audit: the #5044 standalone regression

**Status: reproduced as a real source regression; bounded repair implemented on
the follow-up checkpoint branch.** This remains owned by #4768; no separate
issue is needed.

The merge-group run for PR #5044 was
[`33066137515`](https://github.com/loopdive/js2/actions/runs/33066137515), with
candidate merge `c5dc152fc5d7d16512983eab09cf75740070fbd0` and pre-PR parent
`0d25094e953381672e1b161cc5c4337234b6cad6`. The standalone guard job was
`merge shard reports` (`98501096552`). Its exact baseline/current comparison
was 48,735 rows:

```
                 baseline   candidate   delta
pass                33,107      32,962    -145
fail                10,210      10,355    +145
compile_error         5,291       5,291       0
compile_timeout          13          13       0
skip                    114         114       0
```

The baseline was the `js2wasm-baselines` `main` snapshot checked out by the
run (commit `2e011fe83a0f244ca82af4c456f8f82a3e05485b2`); the standalone JSONL
SHA-256 is
`278931e96d230cdbb92afc8ac54a2e1d73bf7dba6b6d348239cbb23089f22e57`.
`diff-test262.ts` reports **145 pass→fail**, **0 improvements**, **0
wasm-identical noise**, **0 timeout transitions**, and all 145 rows have a
changed wasm hash. The exact regression bucket signature is
`c12d78255ab4839c` with categories `assertion_fail: 96`, `other: 42`, and
`type_error: 7`; the four filename families are `rest-ary-elision: 86`,
`rest-id-elision-next-err: 26`, `rest-ary-empty: 26`, and
`elem-ary-rest-iter: 7`.

All 145 rows are `scope=standard` and `scope_official=true`. The maintained
edition classifier places 77 in ES2015, 40 in ES2018 (async iteration), and 28
in ES2022 (private class methods). The host artifact shares 36 of the 145
failures (35 `other`, one `runtime_error`); the other 109 are standalone-only.
That is a source/target interaction, not baseline drift or report arithmetic:
the failed job ran both lanes, the row set is unchanged, and every regression
is a real pass→fail with a changed binary.

### Smallest reproduction and cause

Using the maintained `harness-flip-probe.ts`, the pinned QuickJS-ng artifact
(`954dc53628e36891f93c359aa60895c2ae3dac6b`), wasi-libc
(`8d8348ec24253d0638a693b8af82445c13d92d32`), clang 18.1.3, and at most two
workers:

```
language/expressions/generators/dstr/ary-ptrn-rest-ary-elision.js
merge parent 0d25094e: pass (deterministic)
merged #5044 c5dc152f: fail (deterministic)
```

The failure is `Expected SameValue(«0», «1»)`: #5044's new standalone recovery
branch calls `patternIteratorStepCount`, whose `-1` sentinel means “unbounded
rest”, and passes that value to `emitNativeGeneratorToVec` as a step limit.
The materializer checks `len >= stepLimit` before its first resume, so `0 >= -1`
stops the generator without resuming it. Nested patterns such as `[[...x]]`
reach the same condition through the recursive destructurer. The host-only
known-call safety gate's rest rejection does not protect standalone, where the
recovery loop was unconditional.

### Bounded repair and evidence

The follow-up checkpoint skips the native state-recovery arm when the current
binding pattern has an unbounded/rest step count, preserving the pre-#5044
tuple/host fallback until a rest-aware state carrier exists. Finite patterns
(`[]`, `[,]`, `[a,b]`, and nested finite patterns) remain on the #5044 bounded
path. A standalone unit control for `function consume([...[,]]) {}` was added
to `tests/issue-4768-generator-call-boundary.test.ts`.

Measured after the repair on branch `codex/audit-5044-regressions`:

- the exact three-family sample (elision, iterator-throw, nested-rest) is 3/3
  pass, matching the pre-#5044 parent;
- the official ES2015 regression slice is **77/77 pass**;
- all 145 inherited regression paths are **145/145 pass**, run as 50/50 +
  50/50 + 45/45 with the assembled-harness controls green;
- the adjacent native-generator/destructuring suites are **92/92 pass**;
- TypeScript 7 typecheck, Prettier, and Biome changed-file checks pass.

### Handoff / investigation plan

1. Review and merge the bounded rest guard in the follow-up PR from
   `codex/audit-5044-regressions`.
2. Re-run the merge-group standalone guard after that PR lands and verify the
   145-row cohort has no pass→fail transitions.
3. Keep the original full 375-row ES2015 `dstr` sweep acceptance item below
   open; the 77-row official-edition regression cohort is complete, but that
   broader historical sweep was not claimed by this audit.

## Residual follow-up: abrupt iterator-step cohort (2026-08-27)

The first implementation for this issue landed in upstream `main`, but its
acceptance record left the abrupt-completion family unmeasured. This follow-up
owns exactly the 40 official ES2015 rows whose path ends in
`dstr/*ary-ptrn-elision-step-err.js` (the complete list is below). These rows
exercise the same array-pattern IteratorStep boundary with a throwing
generator, while avoiding the active yield-star delegation work in #1691 and
the function `name`/`length` work in #4770.

The authoritative source is a fresh fetch of both JSONL lanes from
`loopdive/js2wasm-baselines` `main` on 2026-08-27, classified with
`scripts/generate-editions.ts` against the pinned test262 checkout. The full
official ES2015 population is **11,704 rows**:

| lane | pass | fail | compile error | compile timeout | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| host | 9,565 | 2,083 | 55 | 1 | 11,704 |
| standalone (host-free) | 8,568 | 2,625 | 510 | 1 | 11,704 |

The selected cohort is **host 40/40 pass, standalone 0/40 pass**. Every
standalone failure is a reached `assertion_fail` from the abrupt iterator-step
fixture; no row is a skip or an unmeasured compile failure. The exact local
baseline was rerun through `scripts/harness-flip-probe.ts` with both positive
controls reporting the expected pass and fail directions, the pinned QuickJS
artifact `/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, and at most two
workers.

Exact cohort paths:

```text
language/expressions/arrow-function/dstr/ary-ptrn-elision-step-err.js
language/expressions/arrow-function/dstr/dflt-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/gen-meth-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/gen-meth-dflt-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/gen-meth-static-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/gen-meth-static-dflt-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/meth-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/meth-dflt-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/meth-static-ary-ptrn-elision-step-err.js
language/expressions/class/dstr/meth-static-dflt-ary-ptrn-elision-step-err.js
language/expressions/function/dstr/ary-ptrn-elision-step-err.js
language/expressions/function/dstr/dflt-ary-ptrn-elision-step-err.js
language/expressions/generators/dstr/ary-ptrn-elision-step-err.js
language/expressions/generators/dstr/dflt-ary-ptrn-elision-step-err.js
language/expressions/object/dstr/gen-meth-ary-ptrn-elision-step-err.js
language/expressions/object/dstr/gen-meth-dflt-ary-ptrn-elision-step-err.js
language/expressions/object/dstr/meth-ary-ptrn-elision-step-err.js
language/expressions/object/dstr/meth-dflt-ary-ptrn-elision-step-err.js
language/statements/class/dstr/gen-meth-ary-ptrn-elision-step-err.js
language/statements/class/dstr/gen-meth-dflt-ary-ptrn-elision-step-err.js
language/statements/class/dstr/gen-meth-static-ary-ptrn-elision-step-err.js
language/statements/class/dstr/gen-meth-static-dflt-ary-ptrn-elision-step-err.js
language/statements/class/dstr/meth-ary-ptrn-elision-step-err.js
language/statements/class/dstr/meth-dflt-ary-ptrn-elision-step-err.js
language/statements/class/dstr/meth-static-ary-ptrn-elision-step-err.js
language/statements/class/dstr/meth-static-dflt-ary-ptrn-elision-step-err.js
language/statements/const/dstr/ary-ptrn-elision-step-err.js
language/statements/for-of/dstr/const-ary-ptrn-elision-step-err.js
language/statements/for-of/dstr/let-ary-ptrn-elision-step-err.js
language/statements/for-of/dstr/var-ary-ptrn-elision-step-err.js
language/statements/for/dstr/const-ary-ptrn-elision-step-err.js
language/statements/for/dstr/let-ary-ptrn-elision-step-err.js
language/statements/for/dstr/var-ary-ptrn-elision-step-err.js
language/statements/function/dstr/ary-ptrn-elision-step-err.js
language/statements/function/dstr/dflt-ary-ptrn-elision-step-err.js
language/statements/generators/dstr/ary-ptrn-elision-step-err.js
language/statements/generators/dstr/dflt-ary-ptrn-elision-step-err.js
language/statements/let/dstr/ary-ptrn-elision-step-err.js
language/statements/try/dstr/ary-ptrn-elision-step-err.js
language/statements/variable/dstr/ary-ptrn-elision-step-err.js
```

Plan: first reproduce these 40 rows on both targets; then trace why the
standalone generator path fails to propagate a throwing `next()` through the
bounded destructuring call; make the narrowest native-generator boundary fix
that preserves unknown/reassignable callees on the conservative path; and
rerun the exact 40-row A/B plus native-generator and iterator-close controls.
The issue is complete only when both lanes pass all 40 rows, the full focused
regression set is unchanged, and the current-main CI/mergeability gates are
green.


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

## Residual follow-up result — abrupt iterator-step completion (2026-08-27)

The remaining ES2015 `dstr/*ary-ptrn-elision-step-err.js` failures were traced
to the standalone/WASI native generator resume boundary. The bounded native
destructuring path correctly performed the required `IteratorStep`, but an
exception raised by the generator body escaped the resume trampoline without
advancing its state to `done`. A later `.next()` therefore re-entered the
throwing state and surfaced the same exception again. The host lane already
used its established exception path and was not changed.

The follow-up implementation in `src/codegen/generators-native.ts` wraps only
the standalone/WASI native resume trampoline in the existing target-specific
exception scaffold. On an escaping `__exn`, it writes `STATE_FIELD = doneState`
and rethrows the original payload; the normal result is carried through the
wrapper unchanged. Existing explicit return/throw/yield* paths and the host
lowering remain untouched.

Evidence was collected from the dedicated branch with the pinned QuickJS
artifact `/private/tmp/js2-quickjs-artifact-2e2d7736713beeda` (libquickjs SHA-256
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`, QuickJS
0.16.1), using the assembled harness, structural pass/fail controls, and two
lane processes at most:

- The exact 40-row cohort (`.tmp/4768-step-err-es2015.txt`, SHA-256
  `17be685df22453c486af7ec1fb2155df960ae3ecb7472dc2b718b5ddd19f6ec2`) moved
  from standalone **0/40 pass** (`fail: 40`) to **40/40 pass** (`pass: 40`).
  The local A/B partition is 40 fail→pass, 0 pass→fail, 0 other changes.
- Host stayed **40/40 pass** before and after; the host A/B partition is 40
  unchanged, 0 lost. The before/after host artifact SHA-256 is
  `fd0979b6de3197a235de5409f148c2a50235be248f694286b5f60eceae276f0a`.
- Standalone artifact SHA-256 changed from
  `eba6364bc08d4f05922fa80f6af62c8433186d9aab6f3aaaadfc108343f3d1e7` to
  `f80a8b8bfd00ebca6eaba93f04cbc229caf712a4cb8ab046453fdc5f69a99e43`.
- Focused #4768 coverage is **12/12 pass**, including a direct abrupt-step
  regression that catches the first `next()` error and verifies the following
  `next()` returns `{ done: true }` without rethrowing.
- Adjacent native-generator and IteratorClose controls are green: **43/43**
  (#4718, #3023, #3040, #3100 S5), **23/23** (#1665, #2169, #2170, #2035),
  **24/24** (#3164, #3271, #3302; three expected skips), and **51/51**
  (#2864 carrier, #2941, #2169 destructure/spread).

### Handoff

The implementation and test evidence are on branch
`codex/4768-es6-step-errors`, with upstream PR **#5060** kept draft and on
hold while current-main integration, required CI, and mergeability are
checked. The queue entry remains null until those gates are green; only then
should the hold be removed and the PR marked ready.

Current-main integration was completed at merge checkpoint `daea8728a` after
upstream main advanced through PRs #5048, #5058, and #5059. The exact rerun on
that checkpoint remained host **40/40 pass** and standalone **40/40 pass**;
the refreshed artifacts are `.tmp/4768-host-current-main.jsonl` (SHA-256
`fd0979b6de3197a235de5409f148c2a50235be248f694286b5f60eceae276f0a`) and
`.tmp/4768-standalone-current-main.jsonl` (SHA-256
`f80a8b8bfd00ebca6eaba93f04cbc229caf712a4cb8ab046453fdc5f69a99e43`).
Focused #4768 coverage also remained **12/12 pass**. The remaining landing
gates are the normal push hooks and refreshed required upstream CI.
