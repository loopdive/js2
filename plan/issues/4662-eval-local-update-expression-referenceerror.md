---
id: 4662
title: "runtime-eval: `++`/`--` on a name LOCAL to eval'd or Function-minted code throws ReferenceError — but only when the eval/mint sits inside an enclosing function; plain reads and `x = x + 1` are fine"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime-eval
es_edition: 5
language_feature: eval
goal: standalone-gap
related: [4653, 4515, 4642, 4647]
origin: "dev-4515 flagged an eval-scope symptom; dev-4653 ran the discriminator neither lane had and falsified BOTH narrowings, including its own prior write-up. Filed by the lead — neither lane owns runtime-eval substrate and neither started on it."
---

# #4662 — update expression on an eval-local name throws ReferenceError

## Measured rule (dev-4653, standalone lane, reduced probes)

An update expression (`++` / `--`) on a name **local to the eval'd or minted
code** — an eval-local `var`, or a `Function` parameter — throws
`ReferenceError: <name> is not defined`, **and only when the eval/mint sits
inside an enclosing function.** Module top level is fine.

```js
new Function("p", "return p;")(7)             // -> 7   the parameter IS bound
new Function("p", "p = p + 1; return p;")(1)  // -> 2   compound assignment fine
new Function("p", "p++; return p;")(1)        // -> THROW `p is not defined`
eval("var i = 0; i++; i")   inside a function // -> THROW `i`  (no loop involved)
eval("var i = 0; i++; i")   at top level      // -> 1
```

## Three intuitions this kills — read before hypothesising

1. **`for` vs `while` is irrelevant.** `for (q = 0; q < 3; q++)` throws too.
2. **The loop is irrelevant.** The bare `eval("var i = 0; i++; i")` throws with
   no loop anywhere.
3. **Outer-vs-local is INVERTED from the first reading.** `++` on an **outer**
   binding works; `++` on a **local** one throws. The originally-reported repro
   (`var n = 0; eval("while (n<3) { n++; }")`) is the *outer* case and does
   **not** reproduce on dev-4653's base.
4. **The enclosing-function context is the confound.** A top-level survey cannot
   see this defect at all, which is why it first looked like a loop-test rule.

## Provenance and its limits (third-arm rule)

- The rule above is dev-4653's measurement on base `c42bdbe3e` + its own commits,
  **standalone lane only**.
- dev-4515 was on `8794ab2c9` + its own commit. Neither lane can speak for the
  other's tree, so "does not reproduce" is recorded as *does not reproduce
  here*, not as a claim about the other arm. Re-establish the rule on current
  campaign HEAD before building on it.
- Probes: `.tmp/probes/ev{1,2,3,4}.js` in dev-4653's worktree; the full
  discriminator table is in `plan/issues/4653-es5-function-declaration-semantics.md`
  under residual **R**.

## A correction this issue exists because of

dev-4653's first write-up recorded residual R as *"the minted function does not
bind its declared parameters"* — an inference restated as a measurement, and
**false**: the read-only case answers `7`. The refuting probe cost one run. The
brief names this as the campaign's most-repeated documented defect; it is worth
re-reading before the first hypothesis here hardens into a claim.

## Known conformance rows

`language/statements/function/S13.2.2_A8_T3.js`
(`Function.call(this, "arg", "return ++arg;")` inside a function expression) is
this root. `language/expressions/assignment/S11.13.1_A6_T{1,2}` are **plausibly**
the same and must be verified, not assumed.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully.
   Load-bearing here: methodology 1–7, the **contention trap** (a
   `compilation timeout` is a measurement failure, not a status — re-run every
   apparent flip and regression serially), the **pool-suite false green**
   (`skipped` is not `passed`; read counts, never exit codes), the stale
   `compiler-bundle.mjs` trap (rebuild bundle + adapter on BOTH arms — this is
   eval territory), the `test262/` symlink-farm + **GITLINK hazard**.
2. Re-establish the discriminator table on current campaign HEAD first, in
   both tiers (quickjs and `JS2WASM_EVAL_ENGINE=interpreter`). The
   enclosing-function axis is the one to keep in every probe — dropping it hides
   the defect entirely.
3. Then find why an update expression resolves its operand differently from a
   read or a compound assignment in minted code. The asymmetry is the lead:
   `p` reads fine and `p = p + 1` writes fine, so the binding exists — it is the
   update expression's own reference resolution that misses it.
4. Absent-not-wrong: if some shape cannot be resolved faithfully, decline rather
   than answer wrongly.

## Acceptance

Scoped standalone sweep over `language/expressions/assignment`,
`language/statements/function` and the eval-dependent `built-ins/Function` rows
before AND after from your own runs, apparent flips/regressions serially
re-verified; per-file flip list; **zero regressions**.
`tests/issue-4662.test.ts` pinning each fixed shape in BOTH tiers, every pin
EXECUTING the update expression — and carrying **positive controls** the way
dev-4653's corrected pins do (parameter binding; outer-`++` in a loop), so the
suite claims "`++` on a local" rather than "eval scope is broken" and a fix that
widens the wrong thing cannot read as green. Verified failing on base by revert.
Record `## Root cause` / `## Fix` / `## Test Results` / `## Residuals` here.
