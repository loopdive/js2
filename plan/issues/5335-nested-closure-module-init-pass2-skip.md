---
id: 5335
title: "REGRESSION on main: module-init pass-2 skip silently miscompiles nested closures (outer()()() → 0)"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
assignee: ttraenkler/claude-senior-dev
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

---

## Resolution (2026-09-05)

Fixed. Two things filed above turned out to be wrong, and both changed the fix.

### 1. The named root cause was the wrong mechanism

The report said pass 2 *re-lifts* the closure and that the re-lifting "never
happens". It does not. Reading the emitted WAT both ways (`--wat`, with
`JS2WASM_IR_INLINE=0` so the inliner does not obscure the call), pass 1's kept
body for `console.log(outer()()())` ends:

```wat
call 9            ;; $outer
drop              ;; its result, thrown away
ref.null extern
drop
ref.null extern
call 1            ;; __unbox_number  -> 0
call 0            ;; console_log_number
```

Each `()` on a non-identifier callee lowered to `drop; ref.null extern`. Pass 2
emits the real `ref.test` / `call_ref` closure dispatch instead.

The actual mechanism is a **third** between-pass registry the gate did not
model. `src/codegen/expressions/call-tail-dispatch.ts`'s "Handle
CallExpression as callee" arm calls `matchClosureInfoBySignature`, which
iterates **`ctx.closureInfoByTypeIdx`**. That map is filled by lifting closures
out of the top-level function **bodies**, which are compiled *between* the two
passes. At pass 1 it is empty, nothing matches, and — because the checker DOES
give the inner call a signature — the `if (!callSigs || callSigs.length === 0)`
guard skips the working dynamic-call ladder too, so the arm falls through to a
tail that evaluates both calls and answers `undefined`.

That distinction matters: mechanisms 1 and 2 produce **different bytes with
equal runtime values**. Mechanism 3 produces a **wrong answer**. A gate whose
stated contract is byte identity was never going to catch it.

Corroboration that this was already known elsewhere in the same subsystem:
`declarations/module-init-closure-prelift.ts` documents the identical failure
in its own refusal list — *"a nested closure that escapes its parent's lifted
body … where a between-pass `mk()()` answered `0` instead of `5`"*. The hazard
was understood on the pass-1-skip route and simply not carried over to the
pass-2 one.

### 2. The blast radius was larger than filed

Measured on the parent commit, not argued:

| shape | filed as | actually printed |
| --- | --- | --- |
| `outer()()()` two-level | broken (`0`) | `0` |
| `mk()()` one-level | *"a control that already worked"* | **`0`** |
| `mk()()` one-level, arrow | not considered | **`0`** |
| `a()()` where `a` → `b` → closure (2 hops) | not considered | **`0`** |
| 3 hops | not considered | **`0`** |
| `var m = outer(); var i = m(); i()` | — | `3` (correct) |
| `mk().v()` | — | `5` (correct) |

Nesting depth is irrelevant; the one-level case is the common one. And the
two- and three-hop rows are the decisive ones: the **direct** callee is
syntactically closure-free there, so the issue's fix direction 2 ("refuse on
any call to a local function whose body is not proven closure-free") answers
the one-hop case and still miscompiles the rest.

### 3. Which direction was taken, and what was given up

Neither 1, 2, nor 3. Direction 1 (transitive closure reachability) is the
honest *syntactic* answer, but it needs a whole-program call graph with a
conservative verdict on recursion, indirect calls, dynamic dispatch and host
calls — a large amount of machinery to approximate a fact the compiler can look
up. Direction 3 (revert to gap-1a) throws away a measured-safe optimisation.

Instead the gate stops predicting the cause and **observes the effect**:

* `markModuleInitClosureRegistry(ctx)` records `ctx.closureInfoByTypeIdx.size`
  when pass 1 returns;
* `moduleInitPass2IsSkippable(ctx, mark)` skips pass 2 only when the syntactic
  predicate still holds **and** that size is unchanged — i.e. compiling the
  function bodies in between did not register a closure.

Two integer reads. It needs no judgement about what a call does (the founding
principle of this gate), and it cannot be defeated by transitivity, recursion,
indirect calls or a host callee. `undefined` mark (pass 1 did not run) means
*no skip* — fail closed.

The mark is taken **after** pass 1, not before: the question is what the
between-pass work changed, and a population that lifts its own closures is
already refused syntactically. Measured, that choice keeps 97 corpus fast-path
hits instead of 96.

**Applied to both halves of the predicate, not just gap-1b.** A call-free
population provably cannot read the registry, so exempting gap-1a would be
sound — but it would be *argued* rather than measured, and this gate has now
been wrong once for exactly that reason.

**What was given up — quantified.** The fast path was narrowed, not deleted:

| corpus | skip fired before | after | retained |
| --- | --- | --- | --- |
| `tests/differential/corpus` (120 programs) | 105 | 97 | 92.4 % |
| lodash `.npm-compat` package sources (1048 modules, 651 module-init populations) | 579 | 526 | 90.8 % |

Both withdrawal sets are almost entirely closure-lifting modules — precisely
the population at risk. The cost of a withdrawal is one extra module-init
compile.

**What this does NOT claim:** that `closureInfoByTypeIdx` is the only
between-pass state a kept pass-1 body can read wrongly. It is the only one
measured to produce a wrong *answer*. A future mechanism-4 belongs in the same
mark.

### 4. Evidence

* `tests/issue-5335-module-init-pass2-closure-registry.test.ts` — 11
  assertions, every one pinning a **value**. **6 fail on the parent commit**,
  all 11 pass with the fix. Sources are untyped `.js` on purpose: annotating
  them routes the call through a different dispatcher arm and the whole file
  then passes identically with the fix reverted.
* The suite's own anti-vacuity control — *"a module that lifts no closures
  still skips pass 2"*, asserting `pass1=1, pass2=0` — passes **both** ways, so
  the file cannot go green by disabling the optimisation.
* `scripts/diff-test.ts`: **114 → 115 match** (of 120). `closures/06-nested.js`
  flips `mismatch → match`; no other file moves. The 2 remaining mismatches
  (`generators/06-closure-state.js`, `object/06-delete.js`) and 3 runtime
  errors are pre-existing and unchanged.
* `tests/issue-3523-module-init-single-pass.test.ts` — 15/15 pass, including
  `pass1=1, pass2=0` for every shape the slice admits and the closure-admit
  mutation pin. That seam now also bypasses the registry conjunct; it exists to
  widen admission until the build changes, and a second refusal standing behind
  it would make the mutation invisible.

### 5. Two findings handed on rather than fixed here

* **A latent codegen fall-through, independent of this gate.** In
  `call-tail-dispatch.ts`, when the inner call HAS a checker call signature but
  no registered closure matches it, the arm falls through to a tail that
  silently answers `undefined`. The untyped twin of that case was already
  repaired (`tryEmitInlineDynamicCall`, guarded by
  `callSigs.length === 0`); the typed-but-unmatched case was not. Forcing pass
  2 avoids reaching it here, but any other route that misses the registry — a
  host callee, a closure minted in a module compiled later — lands in the same
  place. Deserves its own issue: a miss should fall back to the dynamic ladder,
  not to `ref.null extern`.
* **A stale pin in `tests/issue-3523-module-init-discovery-static.test.ts`**
  ("(g) WHY it is off"). It asserts two files fail under the `gap-6a` opt-in
  seam; `decodeURI/S15.1.3.1_A1.2_T1.js` now **passes** under it. Verified
  pre-existing: the assertion fails identically with this change reverted. The
  test's own comment anticipates it — *"If a later change makes either of these
  pass under the seam, that is a real result — re-measure the full corpus
  before flipping the default."* Not touched here; it belongs to the #3523
  lane, and it does not gate CI (the test262 submodule is absent there, so the
  case returns early).

### 6. Follow-ups from the report that remain open

Unchanged and still worth their own tasks: promote `Differential test` to a
required check, and refresh `benchmarks/results/diff-test-baseline.json` on
merge to main. The stale baseline (2026-07-19) is what misattributed this
regression to PR #5620. With this fix `closures/06-nested.js` matches the
baseline's recorded `3` again, so that particular misattribution stops — but
the staleness that caused it does not.
