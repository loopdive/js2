---
id: 5335
title: "REGRESSION on main: module-init pass-2 skip silently miscompiles nested closures (outer()()() → 0)"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Symptom — a silent wrong answer, live on `main`

`tests/differential/corpus/closures/06-nested.js` compiles cleanly, validates, runs
without a trap, and prints the **wrong number**:

```js
function outer() {
  let a = 1;
  return function () {
    let b = 2;
    return function () {
      return a + b;
    };
  };
}
console.log(outer()()());
```

| engine | output |
| --- | --- |
| V8 (`node`) | `3` |
| js2wasm on `main` (`eb97d2e817`) | **`0`** |

No compile error, no diagnostic, `WebAssembly.validate` → `true`. This is the worst
failure shape we ship: a program that looks like it worked.

## Bisect — PR #5450, `e7b0668b0d`

Binary search over the 2717 first-parent commits from the diff-test baseline
(`0b1a2cca8f`, 2026-07-19) to `main` (`3879df539c`), one compile-and-run per point:

| commit | output |
| --- | --- |
| `aaebad2ae1` — PR #5449 (parent) | **`3`** |
| **`e7b0668b0d` — PR #5450** `perf(codegen): skip module-init pass 2 for closure-free call-bearing populations (#3523 gap-1b)`, 2026-09-02 | **`0`** |

Both endpoints re-probed individually to rule out flake.

**Confirmed by the PR's own env seam on current `main`** — this is the decisive test, and
also the immediate workaround:

```
$ node --import tsx <probe> closures/06-nested.js                         → "0"
$ JS2WASM_TEST_FORCE_MODULE_INIT_PASS2=1 node --import tsx <probe> …      → "3"
```

## Root cause — the closure ingredient is judged syntactically on the population

`src/codegen/declarations/module-init-pass2-stable.ts` skips the second module-init
compile when the population lacks *either* ingredient that could make pass 2 differ: a
**call** (to consult the inlinable-function registry) or a **closure** (to re-lift).
`moduleInitPopulationIsPass2Stable` walks `ctx.moduleInitStatements` /
`ctx.staticInitExprs` and classifies each node with `ingredientOf`, treating only a
literal `ArrowFunction` / `FunctionExpression` / `ClassExpression` **appearing in that
syntax tree** as a closure.

The module-init population here is one statement: `console.log(outer()()())`. That is
call-bearing and **syntactically** closure-free — the closures live inside `outer`, a
separately-compiled top-level function. So `sawClosure` stays `false`, the predicate
returns `true`, pass 2 is skipped, and the closure re-lifting that pass 2 would have
performed never happens. `a + b` then reads `0`.

The gap is that "mints no closure" is evaluated on the population's own syntax, **not
transitively through the functions the population calls**. `outer()()()` mints two
closures at run time; the scan cannot see them.

The PR's evidence table records `call-bearing, closure-free → 52/52 shape×lane
byte-identical`. This shape is call-bearing and *syntactically* closure-free but not
*semantically* so, and it was not among the 52.

## Fix direction (not attempted here)

Either:

1. **Make the closure ingredient transitive** — a call whose callee (or anything
   reachable from it) mints a closure counts as closure-bearing. Needs the call graph
   the population can reach, so it is the more expensive but honest predicate; or
2. **Refuse on any call to a local function whose body is not proven closure-free**,
   which is the conservative reading of the same idea and cheap to compute; or
3. Revert the gap-1b widening back to gap-1a's `call-free` predicate, keeping the
   measured-safe half.

Whichever lands must add `closures/06-nested.js`'s shape as a unit regression test, not
just leave it to the differential corpus — see below.

## Why nothing caught it

The corpus file **already exists** and the `Differential test` workflow **has been red on
every PR since 2026-09-02** — but `Differential test` is **not** a required check
(`gh api repos/loopdive/js2/rules/branches/main` lists exactly six: `cheap gate
(main-ancestor + lint)`, `merge shard reports`, `quality`, `equivalence-gate`, `check for
test262 regressions`, `cla-check`). So it failed silently for three days while PRs merged.

Worse, its delta gate reports the regression against **whichever PR is currently in the
merge queue**, because `benchmarks/results/diff-test-baseline.json` was last refreshed on
**2026-07-19** (`0b1a2cca8f`) and still records this file as `match` with output `3`. That
misattributes a pre-existing main regression to an innocent PR — it did exactly that to
PR #5620 (the #5333 P0 fix), whose merge-group run reported
`closures/06-nested.js: match → mismatch` although the file fails identically with that
PR's change reverted, and on clean `main` with the PR absent.

Two follow-ups worth their own tasks:

- **Promote `Differential test` to a required check** (or at least make a red one visible),
  otherwise the next silent miscompile lands the same way.
- **Refresh `diff-test-baseline.json` on merge to main.** The gate's own comment says a
  workflow does this; it has not run since 2026-07-19, and the staleness is what turns a
  real finding into a misattributed one.

## Blast radius — not yet quantified

Only this one corpus file regressed among 120, but the trigger is generic: any
module-level call into a function that returns or captures through a closure. The dogfood
`moment` lane is unaffected (10/10 with #5333 fixed). Worth a targeted sweep once the fix
lands.
