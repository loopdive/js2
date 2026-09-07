---
id: 5340
title: "hono utils/concurrent: `RangeError: Invalid array length` on every test (0/6)"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-06
completed: 2026-09-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
language_feature: tagged-template, arguments
related: [5338, 5367]
---

## Problem

`src/utils/concurrent.test.ts` is **0/6**. All six fail with:

```
RangeError: Invalid array length
```

That is the host's `new Array(n)` / `arr.length = n` throwing on a length
that is negative, non-integer, or `NaN`. A compiled value that should have been
a small non-negative integer arrived at the host as something else. The
canonical js2wasm shape for this is a number crossing a boundary as the
**undefined sentinel** (`0x7FF00000DEADC0DE` in an `f64` slot) or as `NaN`
from an `externref → f64` unbox that was never given a bridge — the exact
mechanism #5328 fixed for a *return* site (`allowProvenNumberUnbox` gated
correctly for arguments, wrongly for results).

Measured on a clean detached worktree at main `c9a8b48616`.

## Evidence

- Six entries in `tests/dogfood/report/hono-upstream-suite.json` for this
  file, all with the `RangeError` first line and a non-null `wasmError`.
- hono's `src/utils/concurrent.ts` is small: it builds a bounded-concurrency
  runner (`new Array(concurrency)`-style pre-allocation and/or index arithmetic
  over a task list). The length operand is the suspect.

## Acceptance criteria

1. `src/utils/concurrent.test.ts` ≥ 5/6.
2. Regression test under `tests/`, failing on the parent, passing with the
   fix; untyped `.js` two-file fixtures; pins the numeric *value* reaching the
   host (e.g. `Array.isArray(new Array(n)) && new Array(n).length === n`);
   anti-vacuity control included.
3. A/B at one HEAD, 17 suites, per test file — hono improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Read `tests/dogfood/.hono-upstream-suite/src/utils/concurrent.ts` and find
   every `new Array(`, `.length =`, and `Array.from({ length })`. One of
   those receives the bad operand.
2. Reduce with a negative control (standalone `.mjs`,
   `compileAndRunUpstreamModule`, harness sanity-checked). The likely minimal
   shape: a function whose numeric parameter has a **default** or arrives via
   an **options object / destructuring** (`{ concurrency = 4 } = {}`), used
   as an array length. Ablate: default vs no default; destructured vs
   positional; called from the same module vs from the test file (host
   boundary).
3. Dump WAT for the failing and passing forms. Look specifically for:
   - `f64.const` of the undefined sentinel feeding `__box_number` or a host
     `new Array` import;
   - an `externref → f64` site whose unbox was skipped (`drop` +
     `f64.const NaN` in `type-coercion.ts` ~3125/~3137, or the terminal
     fallback ~4290);
   - a parameter default lowered via `pushParamSentinel` whose callee-side
     check never ran because the call crossed the host bridge (the
     `__call_*` wrappers do not re-run default resolution).
4. Fix at the producer. If it is the same gate #5328 touched
   (`src/codegen/expressions/call-identifier.ts`, `allowProvenNumberUnbox`),
   extend that fix rather than adding a parallel one.
5. Regression test, A/B.

## Dispatch

Model: **opus**. Small file, sharp symptom, but the fix likely lands in
`call-identifier.ts` / `type-coercion.ts`, both of which have bitten this
effort with "looks equivalent, isn't" hazards.

## Resolution

**Fixed by #5338, not by this issue's own PR.** The two issues were filed from
different symptoms of one defect and worked in parallel; #5338 landed first
(`src/codegen/tagged-template-arguments.ts` + `src/codegen/template-raw-dynamic.ts`,
merged into main before `cbd2f11dff`). What this issue contributes is the
diagnosis chain that connects the two, a value-level regression guard #5338's
own test deliberately does not cover, and the identification of the residual.

### The spec's mechanism was a hypothesis, and it was wrong

The plan expected a number crossing a host boundary as the undefined sentinel or
an unbridged `externref → f64` unbox, and pointed at `allowProvenNumberUnbox`
(`call-identifier.ts`, #5328) and `type-coercion.ts`. None of that is involved.
`concurrent.ts` contains no `new Array(`, `.length =` or `Array.from({length})`
at all — the length operand lives in the *test* file, and two of the six failing
tests pass a **literal** `10` to `new Array`, which no value-corruption story
explains.

### Root cause (the same one #5338 fixed)

`compileTaggedTemplateExpression` marshalled at most one positional slot per
DECLARED parameter and dropped every substitution past that, in four of its five
lowering arms. The dogfood shim's table tag is the shape that breaks:

```js
function __upstreamEach(cases) {                                  // ONE parameter
  const values = Array.prototype.slice.call(arguments, 1);        // reads the rest
  const tableRows = Array.isArray(cases) && cases.raw && values.length > 0 ? … : null;
```

Measured inside the compiled module on the pre-fix parent: `arguments.length ===
1`, `values.length === 0`, and `cases.raw` absent. So `tableRows` was `null`,
`sourceCases` fell back to the **template strings array**, and the test body was
invoked with `strings[0]` — the raw 25-character table header — instead of its
row object. `Object.keys(row)` returned `[0,1,…,24]` (a string's indices) in
Wasm versus `[concurrency,count]` natively; `row.count` was `undefined`; and
`new Array(undefined)` reaches the host as `new Array(NaN)`, which is
`RangeError: Invalid array length`.

The literal-`10` tests failed for the same reason one level up: the whole row
object was wrong, so the body diverged before the literal ever mattered. That is
the observation that rules out every value-corruption explanation, and it is
worth recording — it is what makes the tagged-template diagnosis the only one
consistent with the evidence.

Both halves of the harness gate had to be fixed, and #5338 fixed both: the
missing substitutions (`__argc`/`__extras_argv`, the protocol an ordinary
over-arity call already uses) **and** `cases.raw`, which fell through to
`__extern_get` and answered `undefined` for any tag whose strings parameter
lowered to `externref`.

### Verified on main `cbd2f11dff`

| file | pre-#5338 (`a1469a5454`) | main `cbd2f11dff` |
| --- | --- | --- |
| `src/utils/ipaddr.test.ts` | 4/16 | **13/16** |
| `src/utils/concurrent.test.ts` | 0/6 | 0/6 (different failure) |
| hono total | 220/324 | **229/324** |

`RangeError: Invalid array length` is gone from all six concurrent tests; the
per-test `wasmError` is now an ordinary assertion mismatch.

### Residual — acceptance criterion 1 is NOT met

`src/utils/concurrent.test.ts` is still **0/6**, blocked by an **independent**
defect filed as **#5367**: `await Promise.all(…)` on a call expression yields a
default-initialised tuple / empty array instead of the resolved values, and does
not wait for the pending promises. All six of these tests end in
`const results = await Promise.all(resultPromises)`; four then assert on state
the un-awaited continuations were meant to mutate.

Four-line repro, re-verified on `cbd2f11dff`:

```js
export async function run() {
  const r = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
  return 'INLINE len=' + String(r.length) + ' json=' + JSON.stringify(r)
}
export async function probe() {
  const p = Promise.all([Promise.resolve(1), Promise.resolve(2)])
  const r = await p
  return 'VIA-LOCAL len=' + String(r.length) + ' json=' + JSON.stringify(r)
}
// INLINE    len=NaN json={"_0":null,"_1":null}   ← wrong
// VIA-LOCAL len=2   json=[1,2]                   ← correct
```

Binding the promise to a local first is correct, which is why this was invisible
until the tagged-template defect was cleared. Full reproduction ladder in #5367.

### What this PR adds

`tests/issue-5340-tagged-template-extra-substitutions.test.ts` — the **value**
guard that complements #5338's **arity** guard. #5338's regression test uses
STRING substitutions on purpose (its own comment: "an untyped parameter lowers
to f64 in this lane"), so the numeric round-trip — the thing that actually
produced `RangeError: Invalid array length` — is unpinned by it. This test pins
`new Array(n).fill(0).length === n` for a number that crossed the surplus path,
in untyped `.js` two-file fixtures, with an anti-vacuity control on the plain
over-arity CALL and an in-arity control. Measured: 2 of 3 cases fail on the
pre-#5338 parent, all 3 pass from #5338 onward.

### Superseded work

An independent fix for the same root cause was implemented on
`issue-5340-hono-concurrent-array-length` before #5338 was visible
(`src/codegen/tagged-template-extras.ts`, same `__argc`/`__extras_argv`
mechanism, same four arms) and measured green: 17-suite A/B at one HEAD, 16 of
17 suites per-file identical, hono 220→229 with 9 flips all `failed → passed`.
It was **discarded in favour of #5338's**, which is strictly better: it also
fixes `strings.raw`, and it guards `userParamCount < 1`, which the superseded
version did not — a zero-parameter tag with substitutions would have indexed
`substitutions[-1]` there.

The duplication is the known blind spot in `pre-dispatch-gate.mjs`: the two
issues overlap by *idiom*, not by id, neither cites the other, and #5338 was
in flight without a claim visible to this lane at dispatch time.
