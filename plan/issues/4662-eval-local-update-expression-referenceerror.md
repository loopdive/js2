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

## Measured rule (dev-4653, v3 — TWO earlier versions of this rule were wrong)

> Inside eval'd / `Function`-minted code, an **update expression (`++`/`--`)**
> throws `ReferenceError: <name> is not defined` for any name whose binding
> lives in a **FUNCTION variable environment** — the enclosing function's
> locals **or parameters**, a `Function` mint's own parameters, or an
> eval-local `var` when the eval runs inside a function. It works for names
> bound in the **module/global** environment. Plain reads and compound
> assignment (`x = x + 1`) work in every case.

**The axis is where the name is BOUND** — not the surrounding syntax, not the
nesting depth, not local-vs-outer as a lexical notion.

```js
function h(){ var d = 0; eval("d++;"); return d; }      // THROW `d`  enclosing-fn local
var mint = new Function("p","p++; return p;"); mint(1)  // THROW `p`  AT MODULE TOP LEVEL
new Function("p", "return p;")(7)                       // 7   the parameter IS bound
new Function("p", "p = p + 1; return p;")(1)            // 2   compound assignment fine
```

The second line is the decisive one: **no enclosing function exists there and
it still throws**, because a `Function` parameter is always bound in a function
environment. Full 19-row environment × operator table in
`plan/issues/4653-es5-function-declaration-semantics.md` residual **R**, with
both superseded versions kept and labelled. Probes `.tmp/probes/ev{1..6}.js`.

## Readings this kills — check yours against them before hypothesising

1. **`for` vs `while` is irrelevant**, and so is the loop: bare
   `eval("var i = 0; i++; i")` throws with no loop anywhere.
2. **"Local vs outer" is the wrong frame** (v2's error). It happens to describe
   some rows because the "outer" variables probed were all module-level. An
   enclosing function's own local is *outer* to the eval and still throws.
3. **The enclosing-function gate is FALSE** (v2's error). A top-level
   `Function` mint with a parameter throws with no enclosing function at all.
4. **The mint DOES bind its parameters** (v1's error) — the read-only case
   answers `7`.
5. Consequence for a fixer: the superseded wording **excluded the most common
   real shape** — a plain local of the function containing the eval — and
   pointed at the wrong seam.

## Provenance

Standalone lane, dev-4653's probes. The earlier cross-tree thread is **closed**:
dev-4515's repro is vindicated. Its error text named `n4515` while its quoted
source said `n`, and that mismatch revealed the probe wraps in
`export function test(){ var n4515 = 0; … }` — the enclosing-function-local
cell. It throws on both lanes' trees. The earlier "does not reproduce here" was
measuring a module-level `var`, a different cell entirely.

## The lesson from how BOTH earlier rules failed

> **A table is only evidence for the axes it varies; the axis you did not vary
> is where the wrong rule hides.**

v1 varied only the operator. v2 varied operator × surrounding-syntax ×
top-level-vs-in-a-function — a three-axis table that never varied **where the
name is bound**, because every probe wrapped its subject in the same helper and
every "outer" variable chosen was module-level. Both refuting probes were two
lines. Note also that v2's control was *labelled* "outer binding" when it was
really "module-environment binding"; the mislabel is precisely what produced the
wrong rule, so name controls by the axis they actually hold.

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
