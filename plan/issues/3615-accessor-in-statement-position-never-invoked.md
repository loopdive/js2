---
id: 3615
title: "Silent wrong answer: a top-level bare property read is dropped from `__module_init`, so the accessor never runs — a vacuous pass"
status: done
sprint: 77
priority: high
horizon: m
feasibility: hard
goal: core-semantics
assignee: ttraenkler/senior-dev-harness
created: 2026-07-25
completed: 2026-07-25
# The fix is ONE arm in the collectDeclarations allow-list; the file is a
# god-file under the #3102/#3131 LOC ratchet (2535 -> 2569, +34, ~90% of it the
# explanatory comment). The arm belongs next to its five siblings — moving it
# out would separate the allow-list from its own documentation, and #3623
# replaces the whole construct.
loc-budget-allow:
  - src/codegen/declarations.ts
# Same growth seen at FUNCTION granularity (#3400 / R-FUNC): collectDeclarations
# 1324 -> 1381 (+57). Two contributions, both inside the allow-list block:
# #3615's property/element-read arm (~34 lines) and #3623's non-silent
# fall-through recorder (~29 lines, whose LOGIC already lives in the new
# src/codegen/module-init-collection.ts — only the 2-line call site and its
# rationale land here). ~46 of the 57 lines are the explanatory comments; the
# executable growth is ~11 lines. Splitting is not the remedy: the arms only
# mean anything ADJACENT to the five siblings they extend, and #3623 is the
# work that replaces the whole allow-list construct.
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
# ONE host-lane fail -> fail flavour change to a trap category, caused by a
# statement finally running and reaching a PRE-EXISTING defect. Baseline row is
# `fail` (never `pass`), so it is a reclassification, not a regression — and the
# claim is machine-checked against the live baseline row.
trap-growth-allow:
  count: 1
  reason: "#3615: `instance.accessor;` (a bare top-level read) now executes and invokes the getter, which reaches a PRE-EXISTING `arguments`-in-accessor lowering defect. Baseline row is `fail` (error_category `other`), so this is a fail->fail flavour change, not a regression. PROVEN pre-existing by a control that #3615 does not touch: replacing the bare read with a CONSUMED read (`var __v = instance.accessor;` — a VariableStatement, always collected) reproduces the IDENTICAL `illegal cast [in __module_init()]` with the fix DISABLED. See '## Pre-existing, not introduced' below."
  tests:
    - test/language/statements/class/static-init-arguments-methods.js
---

## Problem

```js
var o = {
  get p() {
    throw new Test262Error("accessor must run");
  },
};
o.p; // the accessor is NEVER invoked
```

The program above **ran to completion and scored `pass`** through the real
test262 oracle, in **both** lanes. Per §13.3.2.1 the MemberExpression evaluates
to a Reference and §6.2.5.5 `GetValue` calls `[[Get]]`, which invokes the getter
and throws a `TypeError` on a nullish base. Dropping it is a spec violation, and
in the conformance number it is a **vacuous pass** — a test whose entire point is
"reading this property must throw/observe" scored a pass without doing anything.

Found by the first run of the #3613 harness truth table.

## Root cause — an ALLOW-LIST, not the property-read lowering

**The issue's original "Where to look" was wrong and cost the first agent time;
recorded here so nobody re-derives it.** The property-read lowering is fine.

`collectDeclarations` (`src/codegen/declarations.ts`) builds
`ctx.moduleInitStatements` from an **allow-list** of expression-statement
shapes — call, `new`, `++`/`--`, `delete` (#2992), assignment (+ many special
cases), `throw` (#3592 RC1). A bare `PropertyAccessExpression` /
`ElementAccessExpression` matched **no arm**, so the whole statement never
reached `__module_init` and the read simply never happened.

Measured A/B, hit-counter control (not exception machinery):

| read site                              | pre-fix | post-fix |
| -------------------------------------- | ------- | -------- |
| inside a function body                 | hit=1   | hit=1    |
| inside a top-level `try`/block         | hit=1   | hit=1    |
| inside a function VALUE via a callback | hit=1   | hit=1    |
| **immediate module top level**         | **0**   | **1**    |

Only the top-level collection dropped it — a collection gap, identical in class
to #2992 (`delete`) and #3592 RC1 (`throw`), in the same allow-list. **#3623
generalises the fix so there is no seventh instance.**

## The fix

One arm in the `ts.isExpressionStatement(stmt)` branch, after the
`isDeleteExpression` arm:

```ts
if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
  ctx.moduleInitStatements.push(stmt);
  continue;
}
```

The enclosing loop already unwraps parentheses and `void`, so `void o.p;` and
`(o.p);` ride along. Kept **unconditional**, matching the #2992/#3592 arms:
whether the base is nullish and whether the property is an accessor are runtime
facts (the receiver is routinely `any`), so any static narrowing reintroduces
the same silent drop for whatever it mispredicts.

## Two premises that did NOT survive measurement

**(a) The "false FAILs" direction does not exist.** Both the issue and the
dispatch brief predicted `assert.throws(TypeError, function () { obj.prop; })`
was broken and was "probably the larger direction". **It was never broken** —
the read is inside a function body, which always worked (row 1 above, with the
fix disabled). There is exactly ONE direction: vacuous passes removed.

**(b) The population is 39 files, not "pervasive".** `built-ins/**/prop-desc.js`
and the `return-abrupt-from-*` family — named in the original issue as the
expected bulk — do **not** match: they use `verifyProperty(...)` /
`assert.throws(...)`, which are CALL statements and were always collected.

## Population — re-derived independently (39, not 34)

An exhaustive parse-only scan of all 53,033 `test262/test/**` + `harness/*`
files, modelling **exactly** the predicate the fix uses (unwrap parens/`void`,
then `isPropertyAccessExpression || isElementAccessExpression`):

**39 files**, 46 statements (24 property, 16 element, 6 private-name).

The handoff's scan reported 35 and **missed 4 `PrivateIdentifier` member reads**
(`this.#x;` — still a `PropertyAccessExpression`). My own first pass reported 41
and included **2 false positives**: `await [];` parses as `await[]` — an
ElementAccess — when the file is read as a _script_ rather than a module. Both
corrections were caught by a positive control on the scanner
(`.tmp/scan-3615-final.mts`); the count is load-bearing because it decides
exhaustive-vs-sample.

## Measured reach — EXHAUSTIVE A/B, both lanes, CI-equivalent path

n = 39 (the complete exposed population, not a sample). One process, one runner
(`assembleOriginalHarness` → `CompilerPool(2, "unified")` →
`scripts/test262-worker.mjs`), only a temporary codegen switch toggled. **The
switch is NOT in the committed code.**

| lane           | pass OFF | pass ON | fail→pass | pass→fail |  CE |
| -------------- | -------: | ------: | --------: | --------: | --: |
| **standalone** |       14 |      13 |         4 |         5 |   2 |
| **host**       |       13 |      14 |         5 |         4 |   1 |

Joined against the **authoritative baseline JSONL** (which overrides any local
run), the picture is much better than the raw counts suggest, because most of
the pass→fail flips are on rows CI does not score:

| lane           | gated gains | gated regressions | **net** |
| -------------- | ----------: | ----------------: | ------: |
| **host**       |          +5 |                −1 |  **+4** |
| **standalone** |          +4 |                −1 |  **+3** |

- **4 (standalone) / 3 (host) of the pass→fail flips are `baseline=skip`** —
  `language/import/import-defer/**`, a proposal outside the gated corpus. My A/B
  runs them directly; CI skips them. They do not touch any gate. (They are still
  honest de-inflation: they "passed" only because `ns.foo;` was dropped, so the
  missing `import defer` support was never observed.)
- **Exactly ONE gated regression, in each lane**, the same file:
  `language/expressions/optional-chaining/short-circuiting.js`.
- Gains are all `baseline=fail` → genuine.

**Net is positive in both lanes**, so the #3457 ratio gate waives to a warning
and the net gate passes.

## Pre-existing, not introduced — both regressions proven

Same discriminator as #3592 §2: run the identical work on a path the fix does
**not** touch, with the fix **disabled**. Identical failure ⇒ pre-existing.

**1. `optional-chaining/short-circuiting.js`** — the test asserts `x === 1`
after `a?.[++x]` and `a?.b.c(++x).d;` on `a === undefined` (both must
short-circuit). With the fix **DISABLED**, inside a **function body**:

| expression (inside a function, fix OFF) | result                        |
| --------------------------------------- | ----------------------------- |
| `a?.b.c;`                               | correct (short-circuits, x=1) |
| `const v = a?.b.c;`                     | correct (short-circuits, x=1) |
| **`a?.[++x];`**                         | **x=2 — `++x` WAS evaluated** |
| **`a?.b.c(++x).d;`**                    | **threw**                     |

Our optional-chaining short-circuit is broken for **element access** and for
**call chains**, independent of #3615. The vacuous pass hid it. Filed as **#3624**.

**2. `class/static-init-arguments-methods.js`** (host, fail→trap) — control
faithful to the real file: replace the bare `instance.accessor;` with a
**consumed** read `var __v = instance.accessor;` (a `VariableStatement`, always
collected, a path #3615 does not touch), fix **DISABLED**:

| variant (fix OFF)               | result                                                   |
| ------------------------------- | -------------------------------------------------------- |
| as-written (bare read, dropped) | `Expected argument [null] shouldn't be primitive`        |
| **CONTROL: consumed read**      | **`illegal cast [in __module_init()]` — IDENTICAL trap** |
| bare read deleted entirely      | `Expected argument [null] shouldn't be primitive`        |

The trap reproduces with the fix disabled, so it is a pre-existing
`arguments`-in-accessor lowering defect merely unmasked. Declared via the named,
machine-checked `trap-growth-allow` in this file's frontmatter (baseline row is
`fail`, so the gate can verify the reclassification claim).

**On the one gated pass→fail:** `regressions-allow` is **rebase-mode only**
(`evaluateRebaseGate`), so it is not the applicable mechanism on an ordinary PR
— declaring it would be theatre, not a machine check. It is instead named here
with its pre-existing proof, and it passes the ordinary gates on net-positive
grounds (#3457), not by being absorbed silently.

## Tests

`tests/issue-3615.test.ts` — 13 cases, **all passing** (written by the previous
agent, never executed until now): all five accessor forms at top level
(object-literal getter, element access, `void`, class accessor,
`Object.defineProperty`), a nullish-base TypeError, plus controls for the
positions that were never affected (callback, nested block, consumed read,
call statement, method call) and a plain data-property read that must stay a
no-op rather than becoming a trap.

`tests/test262-harness-truth-table.test.ts` F1–F3 are **retired from the
`it.fails` known-wrong tier** to ordinary assertions in this same PR — the
ratchet firing exactly as designed.

## Acceptance criteria

- [x] A bare top-level read invokes the accessor (hit counter 0 → 1)
- [x] All five accessor forms observed as `fail` (the throw propagates)
- [x] Consumed reads, callbacks and nested blocks unchanged (no regression)
- [x] Population re-derived independently and exhaustively (39 files)
- [x] Exhaustive A/B over the full population, both lanes, CI-equivalent path
- [x] Every pass→fail classified against the authoritative baseline
- [x] Both gated regressions PROVEN pre-existing with fix-disabled controls
- [x] The trap reclassification declared via named `trap-growth-allow`
- [x] `tests/issue-3615.test.ts` executed — 13/13
- [x] Truth-table F1–F3 retired
- [x] Follow-ups filed: #3624 (optional-chaining short-circuit), #3623 (the
      allow-list generalisation that stops the seventh instance)
