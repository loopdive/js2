---
id: 3613
title: "Unit-test the test262 machinery: a harness truth table, a standing vacuity detector, a vacuous-verifier guard, and one shared thrown-payload renderer"
status: done
sprint: 77
priority: high
horizon: l
feasibility: hard
goal: core-semantics
assignee: ttraenkler/senior-dev-harness
created: 2026-07-25
completed: 2026-07-25
---

## Problem

The compiler is judged by a harness that nothing tested.

On 2026-07-25 two independent defects were found in that harness, both of which
made it report `pass` for programs that validated **nothing**:

- **#3592 RC2** — `__apply_closure` dispatched on the _dynamic_ argument count
  alone, so `assert.sameValue(a, b)` (2 args into 3 declared formals) silently
  never invoked the callee. **~5,000 standalone passes (18.4 % of that lane)**
  were vacuous, for months.
- **#3592 RC1** — a module whose body was a top-level `throw` emitted no
  `__module_init` at all, so the program exited 0 instead of throwing. This
  also **defeated throw-probe auditing**: an audit run on a pre-fix base
  reported a spurious "43/43 vacuous", because the probe itself was compiled
  away.

A vacuous pass is strictly worse than a failure: it inflates conformance **and**
hides the defect it was supposed to catch.

Both defects were invisible for the same structural reason. Every existing test
of the machinery was a **source-shape assertion**
(`expect(worker).toContain("const resultFn = …")`, cf.
`tests/issue-3227-s4.test.ts`). Those pin that a line of code exists. They
cannot tell you whether the oracle reaches the right verdict.

Three further instances of the same family surfaced while building this:

- **#3601 park** — `trapInnermostFrame` parsed only the local runner's frame
  grammar, so every CI trap row read as frameless and the gate concluded "0
  verified unmasked pre-existing traps". The frames were there all along. A
  100 %-unverifiable rate on a non-empty population is indistinguishable from a
  clean result, and nothing was watching for it.
- **Local-vs-CI render divergence** (found by the trap lane, routed here) — the
  local runner's `originalHarnessThrownText` never called `tryNativeExnRender`,
  so on the standalone lane every `Test262Error` surfaced locally as the opaque
  #2870 label while CI reported the real assertion text. Two copies of one
  policy, "kept in sync" by a comment.
  **State this correctly, because the weaker framing is what let it survive:
  this was a VERDICT divergence, not "local output is ugly".**
  `originalNegativeMatches` decides a runtime-negative verdict by searching the
  reported detail for `meta.negative.type`, and the opaque label contains no
  type name — so a standalone runtime-negative test that threw exactly the
  RIGHT error scored `fail` locally and `pass` in CI. Local pass/fail was
  therefore not fully trustworthy either, which is a much larger claim than a
  cosmetic one and is why it deserved a fix rather than a triage workaround.
- **#3615** (new, found by the truth table on its first run) — a property read
  in expression-statement position never invokes the accessor, so
  `var o = { get p() { throw new Test262Error("x"); } }; o.p;` scores a
  **vacuous pass**.

## What this issue delivers

### 1. `tests/test262-harness-truth-table.test.ts` — behavioural tests of the oracle

Synthetic, test262-shaped files driven through the **real** oracle
(`runTest262File`, the same `assembleOriginalHarness` assembly CI scores with),
asserting the **verdict** against a hand-derived ground truth. 49 entries across
both lanes, grouped by the mechanism each defends:

| group | defends                                                                       |
| ----- | ----------------------------------------------------------------------------- |
| A     | an under-applied harness call must NOT silently pass (#3592 RC2) — 7 entries  |
| B     | a top-level `throw` must be OBSERVED as throwing (#3592 RC1) — 3 entries      |
| C     | an assertion reached through indirection is still observed — 6 entries        |
| D     | a negative test passes only when rejected for the EXPECTED reason — 4 entries |
| E     | async completion is observed, not assumed — 4 entries                         |
| F     | KNOWN-VACUOUS: the #3615 accessor drop, pinned with controls — 5 entries      |

Anti-vacuity discipline applied to the file itself, because a test suite can be
vacuous too:

1. **Positive controls.** Genuinely-passing programs are in the table, so "all
   green" is not reachable by a harness that refuses to run.
2. **Negative controls.** Genuinely-failing programs whose failure is reached
   only by executing the body, so a harness that passes everything goes red.
3. **No silent skip.** Missing test262 inputs **hard-fail under CI** instead of
   skipping. A checker that verifies nothing must not look like one with
   nothing to verify.
4. **Known-wrong entries are `it.fails`.** They assert the TRUTH and are
   expected to fail today; fixing the defect turns the file RED and forces the
   debt to be retired here rather than rotting.
5. **Meta-guards** assert the table has ≥5 positive and ≥10 negative controls
   and that every entry states WHY its verdict is the ground truth.

### 2. `scripts/detect-vacuity.ts` — the standing detector

Appends a **conditional** throw to the end of a passing test's body:

```js
if (typeof Test262Error === "function") {
  throw new Test262Error("__JS2WASM_VACUITY_PROBE__");
}
```

A body that genuinely runs to completion must now be scored `fail`. One still
scored `pass` never reached the end of its body — that is the definition of
vacuous.

**Why conditional, not a bare `throw`** — this is load-bearing, not style.
#3592 RC1 dropped an unconditional top-level `throw` entirely, which is what
produced the spurious "43/43 vacuous". A throw nested inside an `if` is not a
top-level `ThrowStatement` and is structurally immune to that collector bug.
The guard `typeof Test262Error === "function"` is additionally true exactly
when the harness prefix ran — the precondition for the probe to mean anything.

**Controls are mandatory, and run first.** Nothing is reported until three
controls hold: a genuinely-passing test scores `pass`; a genuinely-failing one
scores `fail`; and that same passing test, **probed**, scores `fail`. Any
disagreement aborts with exit 3 and reports nothing. Control 3 is the one that
caught the bad methodology on 2026-07-25.

**Honest denominators.** Candidates are chosen from the baseline JSONL (which is
authoritative over any local run) but every candidate is **re-run unprobed**
first; a local disagreement is reported as `drifted`, never silently dropped.
Ineligible candidates (negative tests — the probe changes the program under
test; `raw` tests — no harness, so the probe cannot bite) are reported with
their reason, not hidden.

### 3. `scripts/lib/verifier-guard.mjs` — the vacuous-verifier guard, generalized

> When a checker returns "unverifiable" / zero for **100 % of a non-empty input
> population**, that is far more likely to be a broken checker than a uniformly
> clean population. Say so, LOUDLY, instead of returning a silent zero.

Wired into two places:

- **`scripts/diff-test262.ts`** — `evaluateDevacuificationAllowance` now counts
  how many trap candidates `trapInnermostFrame` could actually answer for. Zero
  of a non-empty population emits a loud banner into the gate's notes naming
  frame-grammar drift as the first thing to check. The excusal itself stays
  conservative (an unverifiable trap is still refused), so this is a
  diagnostic, not a gate relaxation.
- **`scripts/detect-vacuity.ts`** — on its own output, in two layers:
  (a) drew candidates but probed none ⇒ `PROBE INERT`, not "0 % vacuous";
  (b) probed files but flipped none ⇒ `PROBE INERT`, not "100 % vacuous".
  Layer (a) was added because the detector's **first standalone run found its
  own blind spot**: 12 of 12 draws were negative tests, and "0 vacuous of 0
  probed" reads exactly like a clean result.

### 4. `scripts/lib/wasm-exn-render.mjs` — ONE thrown-payload renderer

The local runner and the CI worker each carried their own copy of the
thrown-payload renderer. They drifted: the local original-harness path never
called `tryNativeExnRender`, so on the standalone lane every `Test262Error`
read as

```
uncaught Wasm-GC exception (non-stringifiable payload)
```

while CI reported the real assertion message.

**This was a VERDICT divergence, not only a message one.**
`originalNegativeMatches` decides a runtime-negative verdict by searching the
detail for `meta.negative.type`; the opaque label contains no type name, so a
standalone runtime-negative test that threw the _right_ error scored `fail`
locally and `pass` in CI. Measured and now pinned:
`D2-runtime-negative-genuine` on the standalone lane went `fail` → `pass`.

Both lanes now import the one implementation. The worker's behaviour is
byte-unchanged — the shared policy **is** the worker's existing policy; it is
the local lane that was missing a step. `tests/issue-3613-render-parity.test.ts`
asserts the two renderers produce the identical string for the identical thrown
payload, with a positive control (the native renderer produces the real text)
and a negative control (hiding the exports reproduces the opaque label).

`oracle-version-exempt:` no baseline row can reclassify — the committed rows are
produced exclusively by `scripts/test262-worker.mjs`, whose policy is unchanged.

### 5. `scripts/check-test-vacuity-shapes.ts` — OUR OWN tests can pass vacuously too

Not test262 — the tests we write to verify compiler fixes.

Several codegen paths are gated on the callee being a bare **identifier**
(`src/codegen/expressions/new-super.ts` opens with
`if (!ts.isIdentifier(calleeExpr)) return false;` in three places). A
TypeScript cast around the callee is a **type-level no-op that changes the
AST**, so it routes past the gate. Measured, standalone lane
(`.tmp/probe-castnew2.mts`, control = the identical program with the cast
removed):

| program                                     | rendered                         |
| ------------------------------------------- | -------------------------------- |
| `throw new TypeError("MARKER-77")`          | `TypeError: MARKER-77`           |
| `throw new (TypeError as any)("MARKER-77")` | `[object WebAssembly.Exception]` |

The second never mints an `$Error_struct` at all. A regression test written
that way exercises a **different code path than the fix it guards** — it looks
protected when it is not, so the defect can silently return. The
`assertion_fail` lane hit exactly this on 2026-07-25: 3 of 6 cases passed
vacuously, caught only because the author manually removed the fix and checked
the test actually went red.

This is the same failure shape as a vacuous test262 pass — an assertion that
runs but validates nothing — and worse in one respect: it is **invisible**,
because the cast looks like a no-op.

The gate is a **ratchet at zero**: the shape is currently absent (0 hits across
2,617 test files), so nothing has to be ground down. It flags only _type-level_
wrappers (`as T`, `<T>x`, `x!`, `satisfies T`) on the **callee** — a cast on an
argument (`new X(y as any)`) and a genuinely computed callee
(`new (getCtor())(…)`) are untouched, because only the type-level ones look
like no-ops. Deliberate exceptions opt out with
`// vacuity-shape-allow: <why>`. The fix is always to cast the **result**:
`new X(...) as T`.

The scanner carries the same discipline it enforces: scanning 0 files exits 2
rather than reporting a clean tree, and the unit test includes a **positive
control** (three synthetic hits) so a zero from the repo scan means clean
rather than broken.

## Measurements

| what                                                | result                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| harness truth table, both lanes                     | **49/49** as designed (3 `it.fails` known-wrong = #3615)                                         |
| machinery unit tests                                | **28/28**, hermetic                                                                              |
| render-parity tests                                 | **7/7**                                                                                          |
| vacuity detector, host lane (n=8 seed 20260725)     | controls OK; **0 vacuous of 6 probed**, 1 drifted, 1 ineligible — consistent with the audit's ≈0 |
| vacuity detector, standalone lane, FIRST run (n=12) | **0 probed of 12 drawn** — caught by the new guard as PROBE INERT, not reported as clean         |
| `new (X as any)(…)` scan                            | **0 hits / 2,617 test files** — a ratchet at zero                                                |

### The standalone PROBE INERT run was a real finding, not a detector bug

After the attempt-factor fix (draw up to 8x the requested sample until enough
files are actually probed), the standalone run drew **32 candidates and every
one was ineligible for the same reason: `negative test`**. The guard's hint
named the cause exactly — "a stale/partial JSONL can be dominated by negative
tests" — and it was right. The local
`.test262-cache/test262-standalone-current.jsonl` snapshot contains

```
rows 48,088  →  compile_error 43,469 | pass 4,508 | skip 108 | compile_timeout 3
```

i.e. a run in which the standalone lane was compile-erroring wholesale, so the
only things that "passed" were negative tests (everything fails to compile ⇒
every `negative: SyntaxError` scores pass). The real standalone floor is
~22,394. That is a **stale local cache**, not a repo artifact — CI fetches
fresh — but it is precisely the input that would have produced a confident
"standalone lane: 0 % vacuous, all clean" from a detector without the guard.
The summary now prints the ineligible-reason histogram so this diagnoses itself
in one line.

## Why the truth table is not in the required guard suite

`tests/guard-suite.json` entry criterion 2 is "needs NO test262 submodule or
other prepared harness inputs". The truth table needs the harness by
construction, and its 49 entries cost ~3.5 min under load — well past the
suite's ~2 min total budget. It runs on any PR that touches it (#3008) and
post-merge via `issue-tests.yml`. The **hermetic** half
(`tests/issue-3613-vacuity-machinery.test.ts`, 92 ms, no test262) IS added to
the guard suite, because editing `scripts/diff-test262.ts` or
`scripts/detect-vacuity.ts` alone does not trigger the #3008 per-PR gate — the
SCRIPT-vs-TEST gap that would leave the anti-vacuity guard itself unguarded.

## Acceptance criteria

- [x] An under-applied harness call must NOT silently pass — pinned in both lanes (group A)
- [x] A test whose assertion never executes must NOT pass — pinned through 5 indirection layers (group C) and the async channel (group E)
- [x] A negative test passes only when rejected for the expected reason — pinned incl. the #2920 compile-succeeded arm (group D)
- [x] A module that throws at top level is observed as throwing — pinned incl. the trailing-throw shape the detector depends on (group B)
- [x] A standing vacuity detector exists, uses a CONDITIONAL throw, and refuses to report without controls
- [x] A verifier returning "unverifiable" for 100 % of a non-empty population WARNS loudly instead of returning a silent zero — implemented, wired into the trap-frame verifier and the detector's own output
- [x] Local and CI paths render the same thrown value identically — one shared renderer + a parity test
- [x] A new vacuity class discovered is filed with controlled evidence — #3615
- [x] The vacuity class in OUR OWN regression tests (`new (X as any)(…)` defeating
      an identifier-gated codegen path) is detected and ratcheted at zero

## Follow-up

1. **#3615** — the accessor-in-statement-position drop. Pinned here as three
   `it.fails` entries; the codegen fix is not this issue's lane.
2. **Parse-negative coincidental passes (audit class P3, ~150–300 estimated).**
   The documented policy is "any static rejection satisfies SyntaxError"
   (`scripts/negative-verdict.mjs`), which makes a rejection for an _unrelated_
   reason score a conformance pass.

   > **The discriminator, stated plainly: a CAPABILITY REFUSAL is not evidence
   > of early-error detection; a STATIC/SYNTAX REJECTION is.**
   >
   > "Unsupported method call: `.foo()`", "…is unsupported", "Unsupported
   > expression in linear backend: …" all mean _we cannot compile this_. They do
   > NOT mean _this program is statically invalid_. A `negative: SyntaxError`
   > test rejected with one of those was not detected — it was merely refused,
   > and scoring it `pass` credits the compiler for a capability gap. Only
   > diagnostics that assert the program is ill-formed (TS parse diagnostics,
   > the ES early-error codes in `ES_EARLY_ERROR_CODES`) satisfy the
   > expectation.

   **Not landed here**: it is a verdict-logic
   change requiring an `ORACLE_VERSION` bump, a full-corpus measurement of the
   4,561 parse-negative passes (~2 CPU-hours; the passes carry no recorded
   diagnostic, so they must be re-run to classify), and a declared
   change-scoped allowance for the intentional de-inflation — i.e. its own
   landing, on the #3592 RC2 recipe.

   **Scoped measurement (N = 20, seed 20260725, compile-only,
   `.tmp/probe-parsenegative.mts`)** — cheap corroboration for whoever sizes it,
   NOT a corpus number:

   | rejection reason on a parse/early/resolution negative that scores `pass` | n      |
   | ------------------------------------------------------------------------ | ------ |
   | static/syntax rejection, severity `error` (genuine)                      | **18** |
   | genuine, but detected only as a **warning** (the #2912 lenient arm)      | **1**  |
   | coincidental (rejected for something other than the target construct)    | **1**  |

   1/20 = 5 % sits inside the audit's independently-derived 3–7 % band, so the
   ~150–300 corpus estimate holds.

   > **IMPORTANT — this measurement REFUTES the simple form of the fix sketched
   > above, including my own.** The one coincidental hit is
   > `dynamic-import/syntax/invalid/nested-async-arrow-function-await-typeof-import-source.js`,
   > rejected with `'source' is not a valid meta-property for keyword 'import'.
Did you mean 'meta'?`. That is a **TS parse diagnostic** — a genuine static
   > rejection by any vocabulary test — and it is STILL coincidental, because it
   > rejects an unsupported _proposal_ rather than the construct the test
   > targets. So a keyword regex over the diagnostic text
   > (`/unsupported|not supported|…/`) is **not a sufficient discriminator**:
   > it would miss this case entirely while risking false hits elsewhere.
   >
   > The real discriminator has to relate the rejection to the test's **target
   > construct** (e.g. does the diagnostic's source position fall inside the
   > syntax the test is about; does the test's `features:` list name a proposal
   > we do not implement). That is a design problem, not a regex — which is a
   > further reason this needs its own landing rather than a rider. The
   > capability-refusal rule above remains correct as far as it goes; it is just
   > not the whole discriminator.

   **Correction — my first reading of the third row was wrong, and verifying it
   changed the conclusion.** I initially recorded
   `language/expressions/logical-assignment/lgcl-and-eval-strict.js` as "no
   diagnostic at all" and flagged it as a probable defect in #2920's strict
   compile-succeeded arm. That was an artifact of my probe counting only
   `severity === "error"`. Measured (`.tmp/probe-evalstrict.mts`):

   | compiled as                      | errors | warnings                                                             |
   | -------------------------------- | ------ | -------------------------------------------------------------------- |
   | module goal (as the runner does) | 0      | `Invalid use of 'eval' in strict mode.` + `Cannot assign to 'eval'…` |
   | explicit `"use strict"` prefix   | 1      | same                                                                 |

   So the compiler **does** detect it, and the diagnostic names **exactly the
   early error the test targets** ("Invalid use of 'eval' in strict mode",
   against a test whose description is "SyntaxError is thrown if the identifier
   eval appear as the LeftHandSideExpression of a Logical Assignment
   operator"). The `pass` comes through #2912's **documented-lenient warning
   arm**, which is working as designed and reaching the RIGHT verdict for the
   RIGHT reason. **There is no defect here and no issue to file.** Controls:
   `eval = 20` and `arguments &&= 20` under an explicit `"use strict"` both
   raise a severity-`error` diagnostic naming the same construct.

   The one thing this DOES show is that any future tightening must treat the
   warning channel as first-class evidence — a discriminator that looked only at
   severity-`error` diagnostics would flip this genuine pass to a fail.

3. **Host `(0, eval)` fallback passes (audit class P4, ~75 estimated).** Bounded
   and low-severity; the honest fix is to mark a result whose validation went
   through the host `eval` fallback rather than compiled code, so the class is
   _countable_ instead of invisible. Same landing constraints as (2).
4. ~~**Wire the detector into a scheduled canary.**~~ **DONE** —
   `.github/workflows/vacuity-canary.yml`: weekly + `workflow_dispatch`, both
   lanes as a `fail-fast: false` matrix (a green host lane says nothing about
   standalone, which is where the entire ~5,000-test #3592 class lived), report
   uploaded as an artifact. Deliberately **advisory, not a required check**: it
   needs a network baseline fetch and real corpus compiles, and a flaky fetch
   must never gate a PR. The cheap hermetic half is a required check instead
   (guard suite). `pnpm run detect:vacuity` is the manual entry point.

   Exit codes are the interesting part, and each maps to a distinct action:
   `0` clean at the ceiling · `1` rate above the ceiling (real finding) ·
   `3` CONTROL FAILURE, no finding claimed · `4` PROBE INERT, **not** "clean".

   Building the canary surfaced a real bug in the detector: the standalone lane
   fetched the **gc** baseline, so on a fresh checkout (exactly the canary's
   environment) the standalone job would have died with "no baseline JSONL" —
   which on a scheduled run reads as infrastructure noise rather than as the
   missing measurement it is. Fixed to fetch the lane's own baseline.

   **This is the strongest single argument for the guard existing: the
   silent-zero shape appeared in the tool built to detect silent zeros, written
   by someone actively looking for it.** A missing standalone measurement would
   have presented as a red scheduled job that everyone learns to ignore, and the
   lane where the entire ~5,000-test #3592 class lived would have gone unsampled
   indefinitely. The failure mode does not require carelessness — it only
   requires that "nothing to report" and "could not report" look alike.

5. **#3619 — mechanise "the test must go red without the fix".** FILED. The
   syntax gate in (5) above catches ONE shape; the general class is "this
   regression test does not actually exercise the code under test", and it has
   no detector today beyond an agent remembering. #3619 specifies the two-
   checkout CI job: run a PR's NEW test files against the PR's **merge-base
   compiler** and require FAIL. No mutation operators to design — the mutant is
   `main`. Until it lands the norm stays manual: **remove the fix, confirm the
   test goes red, say so in the PR.**
6. **`.name` through a parameter is `undefined` on standalone (#3618)** —
   corrupts failure TEXT (924 heterogeneous rows collapsed onto one string
   during triage). Anything in this area that classifies by message text is
   unreliable until that lands; note its root cause is explicitly NOT
   "un-gate #3429".
