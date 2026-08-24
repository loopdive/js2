---
id: 4622
title: "standalone: `delete arguments.length` crashes the COMPILER — arguments-object descriptor surface prerequisite"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-23
updated: 2026-08-23
# The implementation lives in `arguments-object-mop.ts` (+154 lines, the module
# that already owns every "ordinary Object vs opaque $Vec" reconciliation).
# What lands in the driver is only the dispatch that routes a delete shape to
# it: one `if` plus the comment explaining WHY the arm must precede both the
# struct-field arms and the generic `__delete_property` arm. That is the
# minimum a new delete shape can cost the driver — the alternative (a lookaside
# table of shapes) would be more driver code, not less.
loc-budget-allow:
  - src/codegen/typeof-delete.ts
func-budget-allow:
  - src/codegen/typeof-delete.ts::compileDeleteExpression
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: arguments-object
goal: standalone-gap
related: [4620, 3251]
origin: "dev-4620 family-B triage (2026-08-22): the crash blocks the whole arguments-object descriptor family from even being measured."
---

# #4622 — `delete arguments.length` compiler crash

## Problem (measured by dev-4620, 2026-08-22)

Compiling a function containing `delete arguments.length` (or `delete
arguments[<k>]` shapes reached by the #4620 family-B rows) crashes the
compiler itself — not a wrong answer, not a runtime trap: compilation
throws. This is a crash-class defect (highest tier per the campaign brief)
and it walls off the arguments-object descriptor rows behind it, because a
test that deletes then re-reads can't even be bucketed.

Context from #4620's family-B record (see that issue's Results): the
arguments object is an opaque `$Vec` copy of the parameters
(`arguments-object-mop.ts` header), so member-delete lowering on it has no
descriptor store to hit; the crash is in the lowering path, before any
runtime semantics question arises.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Reproduce
   first with a minimal `.tmp/` probe: `function f(){ delete
   arguments.length; return 1; }` — record the exact throw site and stack.
2. Bisect the lowering: member-delete on an `arguments` receiver — find
   where the delete path assumes a `$Object`/struct receiver and meets the
   `$Vec` copy. Likely `property-access.ts` delete arm or
   `arguments-object-mop.ts` interplay.
3. Minimum correct fix: `delete arguments.length` must compile and answer
   per §10.4.4 ordinary-object semantics for the copy we have (own
   `length` is deletable → `true`, subsequent `arguments.length` reads
   fall through per the current representation). Do NOT attempt the full
   `[[ParameterMap]]` write-through here (that is #3251-class,
   representation work) — the deliverable is: no compiler crash, spec-true
   where the representation permits, honest `it.fails` pins where it does
   not.
4. Sweep the `built-ins/Function/arguments*` + `language/arguments-object`
   ES≤5 rows before/after (own runs, serial for timing-adjacent rows).
5. Pins: tests/issue-4622.test.ts — crash-gone positives + residual pins
   with owners (#3251 for write-through).

## Results (dev-4622, 2026-08-23 — every number below is from my own runs)

### Correction to the issue's premise: `compile()` never threw

Step 1 of the plan says to record the throw site. There is none. On the campaign
branch tip (`9d9291db7`), `compile()` returns `success: true` and a module that
passes `WebAssembly.validate` for **every** shape in this family — 25 variants
probed across both option sets (`target: "standalone"` with
`deferTopLevelInit`/`hostBridge`, and the plain gc default): `delete
arguments.length`, `["length"]`, `.callee`, `.foo`, `arguments[0]`, computed
keys, strict and sloppy, statement and expression position. None threw at
compile time.

What #4620 measured is real, but it is a **runtime** throw, and the reason it
read as a compiler crash is exact: the module throws a `WebAssembly.Exception`
whose JS-side `.message` is `undefined`, so a probe that printed
`(e as Error).message` printed nothing. That is the "throws with an empty
message" in #4620's family-B note. Catching it inside the compiled module
identifies it precisely — it is a **TypeError**, from `emitStrictDeleteCheck`.

This matters beyond bookkeeping: "the compiler crashes" and "the compiled
program throws a spec-wrong TypeError" have disjoint fix sites, and the plan's
step 2 ("find where the delete path assumes a `$Object`/struct receiver and
meets the `$Vec` copy") sends you looking for a lowering bug that is not there.

### Root cause

`arguments` is an opaque `$Vec`, so `delete arguments.length` falls past the
struct-field arms into the generic `__delete_property` arm of
`compileDeleteExpression`. `__delete_property`'s vec arm
(`buildVecDeletePrologue`, `vec-bag-seed.ts`) asks **`__vec_gopd`** for the
descriptor and refuses the delete when `configurable` is false. `__vec_gopd`
answers with **Array** rules, where `length` is non-configurable — correct for
`[1, 2]`, wrong for an arguments object, whose `length` is
`{writable: true, enumerable: false, configurable: true}` in BOTH
CreateMappedArgumentsObject and CreateUnmappedArgumentsObject (§10.4.4). So:

| lane | before | spec |
| --- | --- | --- |
| sloppy | `false` | `true` |
| strict | **TypeError thrown** (`emitStrictDeleteCheck`, §13.5.1.2 step 6.b) | `true` |

`__vec_gopd` is shared with real arrays and there is no runtime brand separating
an arguments vec from one — that is #4620's own family-B finding
(`Array.isArray(arguments)` answers `true`). So the fix cannot live in the
runtime descriptor layer without the representation work; it has to be
syntactic.

### Fix

`emitArgumentsOrdinaryNamedDelete` in `src/codegen/arguments-object-mop.ts`,
dispatched from `compileDeleteExpression` **ahead of** both the struct-field
arms and the generic arm. It fires only for the compiler-materialized
`arguments` local of *this* function (`isArgumentsObjectIdentifier`) with a
**static** `length` key (property access or a string-literal element access),
and emits `i32.const 1` typed `{kind: "i32", boolean: true}` — a boolean, not
the number 1, per the #4231 note in the same driver.

Two deliberate exclusions, both measured rather than assumed:

- **`callee` is NOT in the deletable set.** Its answer SPLITS — mapped ⇒ a
  configurable data property (`true`), unmapped ⇒ the `%ThrowTypeError%`
  accessor with `configurable: false` (`false` ⇒ TypeError in strict). Both
  halves are **already correct** on this branch (the `arguments-callee-poison*`
  lane owns them): `__probe4622__/{sloppy,strict}-delete-callee.js` both PASS on
  the base sources. Adding `callee` would replace a correct split answer with a
  flat `true` and regress the strict half.
- **`argumentsObjectMayBeReconfigured` declines whenever the object is
  reachable as a value** — any `arguments` reference that is not the base of a
  member expression, plus `with` and direct `eval`. §10.4.4's attribute table
  describes a FRESH arguments object;
  `Object.defineProperty(arguments, "length", {configurable: false})` and
  `Object.seal(arguments)` legitimately flip the answer to `false`, and with no
  runtime brand codegen cannot ask. This is the absent-not-wrong boundary: on
  decline the generic path keeps its own answer. Verified — after
  `defineProperty(configurable:false)`, after `Object.seal`, and after
  `var esc = arguments`, the delete still refuses (and the first two refusals
  are the SPEC-CORRECT answers, not merely conservative ones).

One diagnostic worth recording, because it cost time and looks like a
regression: in strict code, `delete arguments.length` in a function that ALSO
calls `Object.prototype.hasOwnProperty.call(arguments, …)` still throws
TypeError. That is not a bug and not new — the `.call` passes `arguments` as a
value, so the guard declines and the pre-existing answer stands. It is
order-independent (it throws with the `hasOwnProperty` placed BEFORE the
delete) and disappears when the delete sits in a never-taken branch, which is
what identifies it as the decline rather than a post-delete read failure.

### Test Results

Scoped standalone sweep, **75 ES≤5 rows**, before AND after, both mine:
`language/arguments-object/**` plus every row under
`language/statements/function`, `language/expressions/delete` and
`built-ins/Function` that mentions `delete arguments` or `arguments.length`.

| | pass | fail |
| --- | --- | --- |
| before (`9d9291db7`) | 70 | 5 |
| after | **71** | 4 |

Flip list — one row, one direction, **zero regressions**:

- `language/arguments-object/S10.6_A5_T3` FAIL → **PASS**
  (`function f1(){ return (delete arguments.length); }`, asserted in both goals).

Still failing after (all four also failed before, unchanged):
`10.6-13-a-1` (escaped `callee`), `10.6-6-2` + `10.6-7-1` (length descriptor
configurable — see residuals), `S10.6_A5_T4` (`arguments.length = <string>`
write-through).

Purpose-built probes under `test262/test/__probe4622__/` (11 files), sloppy and
strict, before → after:

| probe | before | after |
| --- | --- | --- |
| `sloppy-delete-length` | FAIL (`=> false`) | **PASS** |
| `strict-delete-length` | FAIL (**TypeError thrown**) | **PASS** |
| `sloppy-delete-length-bracket` | FAIL (`=> false`) | **PASS** |
| `sloppy-delete-callee` | PASS | PASS |
| `strict-delete-callee` | PASS | PASS |
| `sloppy-array-length-delete` (control) | PASS | PASS |
| `sloppy-delete-index` (control) | PASS | PASS |
| `sloppy-delete-length-then-read` | FAIL | FAIL (residual R1) |
| `sloppy-delete-length-hasown` | FAIL | FAIL (residual R1) |
| `sloppy-delete-length-desc` | FAIL | FAIL (residual R2) |
| `sloppy-delete-length-alias` | FAIL | FAIL (residual R3) |

Pins:

- `tests/issue-4622.test.ts` (new, 16 cases incl. 3 `it.fails`) — green, and
  green again under `JS2WASM_EVAL_ENGINE=interpreter` (no case mints from a
  body string, so no tier arm is needed; run anyway per the brief).
- Neighbouring suites run WITH the fix, then A/B'd on the base copies. Nine
  failures total, **all nine identical on base** — pre-existing on this branch,
  none caused here: `issue-1511` (3), `issue-2703` (1), `issue-2726` (3),
  `issue-2726-inherited-delete-noop` (1),
  `issue-2726-sloppy-unresolvable-delete` (1).
- Green with no failures: `issue-2667` (8), `issue-4555-typeof-arguments` (40),
  `issue-3251` + `-s2` + `-s3` + `issue-4620` (50 together),
  `issue-4491-*` (2 files), `issue-2726-mapped-args-delete`,
  `issue-2726-configurable-global-delete`,
  `issue-2726-global-environment-delete`.
- Scoped equivalence, per-file (never one invocation — OOM):
  `arguments-object`, `delete-operator`, `delete-sentinel`,
  `hasownproperty-call`, `issue-2119-module-strict-arguments`,
  `define-property-typeerror`, `object-define-property{,-extended,-return}`,
  `arguments-nested-and-loops`. Two failures, **both identical on base**:
  `arguments-nested-and-loops > for-loop with function declaration in body`
  (the one #4620 also recorded as pre-existing) and
  `delete-sentinel > delete string property makes it undefined`.

Gates: `check:loc-budget` and `check:func-budget` pass with the two allowances
granted in this file's frontmatter; `check:oracle-ratchet` (+0 / +0),
`check:pushraw` (+0), dead-export gate all OK; `tsc --noEmit` reports nothing in
either changed file.

### Residuals (measured here, NOT fixed)

- **R1 — the deleted property SURVIVES.** `arguments.length` folds to the vec's
  length field, and `hasOwnProperty` / `in` go through the shared vec helpers;
  neither has anywhere to record a deleted named key, so both still report the
  pre-delete state. This is what keeps `10.6-6-2` failing even now: its
  `verifyProperty` deletes and then asserts the property is gone. Needs the
  descriptor-sidecar / `[[ParameterMap]]` representation. **Owner: #3251.**
- **R2 — `getOwnPropertyDescriptor(arguments, "length").configurable` is
  `false`**, because `__vec_gopd` (`vec-overlay.ts`) answers with Array rules.
  This is the direct cause of `10.6-6-2` and `10.6-7-1`. Splitting it needs the
  runtime brand distinguishing the arguments vec from an array.
  **Owner: #4620 family B / the vec-overlay + gOPD lane** (adjacent to
  dev-4624's `object-runtime.ts` work; deliberately not touched from this lane).
- **R3 — an ESCAPED alias** (`var a = arguments; delete a.length`) is declined
  by design; a syntactic arm cannot follow the value. Same brand dependency as
  R2. **Owner: #4620 family B.**
- **R4 — `arguments.length = <string>`** (`S10.6_A5_T4`) is dropped; the vec's
  length field is an `i32`. Numeric assignment works. **Owner: #3251.**

All four are pinned: R1/R2/R3 as `it.fails` in `tests/issue-4622.test.ts`; R4
is a live test262 row (`S10.6_A5_T4`).
