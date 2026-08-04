---
id: 4158
title: "Reference-layer abrupt completions never fire — GetValue/PutValue/ToObject on an undefined or unresolvable base returns null instead of throwing (138 ES5+untagged)"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: references
goal: es5
related: [2668, 3185, 4008, 3406]
origin: "plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md, cluster B1 residual"
---

# #4158 — Reference-layer abrupt completions never fire

## Problem

The spec's Reference Record operations are *throwing* operations. `GetValue`,
`PutValue`, `ToObject(ref.[[Base]])` and `RequireObjectCoercible` each raise
`TypeError` or `ReferenceError` when the base is `undefined`/`null` or the
reference is unresolvable. js2wasm resolves these to `null`/`undefined` and keeps
going, so the program produces a value where the spec demands an abrupt
completion.

The canonical case — `language/expressions/delete/member-identifier-reference-undefined.js`:

```js
var base = undefined;
assert.throws(TypeError, function () {
  delete base.prop; // 12.5.3.2 step 5.b: ToObject(ref.[[Base]]) must throw
});
```

No exception is raised, so the `assert.throws` fails.

## Measurement

**138 files** in the ES5 + untagged standalone scope
(`plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md`; baselines
fetched 2026-08-04, `oracle_version` 12, lane `honest`, baseline SHA
`d3d7ec4c`). 46 are `ES5`-tagged, 92 untagged.

**95 of 138 (69 %) also fail on the JS-host lane** — this is a front-end
reference-semantics gap, not a standalone-substrate one. Only 43 are
standalone-only.

Sub-shapes:

| Shape | Files | Example |
| --- | ---: | --- |
| `TypeError` expected, nothing thrown | 75 | `language/expressions/delete/member-identifier-reference-undefined.js` |
| `ReferenceError` expected, nothing thrown (PutValue on unresolvable) | 18 | `language/expressions/prefix-decrement/operator-prefix-decrement-x-calls-putvalue-lhs-newvalue--1.js` |
| Module binding created but not initialized (TDZ ReferenceError) | 10 | `language/module-code/instn-local-bndng-export-let.js` |
| Abrupt `valueOf`/`toString` during coercion swallowed | 11 | `built-ins/Date/S15.9.3.1_A4_T6.js`, `built-ins/JSON/parse/reviver-get-name-err.js` |
| Error-constructor identity: thrown value is not an instance of the expected intrinsic | 4 | `language/expressions/assignment/target-member-computed-reference-undefined.js` |

Area spread (top): `language/expressions/assignment` 16 ·
`built-ins/String/prototype` 9 · `language/statements/function` 9 ·
`built-ins/Boolean/prototype` 7 · `built-ins/Function/prototype` 5 ·
`language/statements/class` 5 · `language/module-code/namespace` 4 ·
`language/expressions/delete` 4 · `language/expressions/new` 4 ·
`built-ins/JSON/stringify` 4.

## Scope — what this issue is NOT

The full "assert.throws saw no exception" cluster in that analysis is 310 files.
**172 of them are already owned** and are deliberately excluded here:

- 113 in `built-ins/Array/prototype` → **#3185** (the throw is the array
  method's own step-order validation).
- 59 in `built-ins/Object/*` → **#2668** (illegal descriptor reconfiguration must
  throw `TypeError`) and **#4008** (`ToPropertyDescriptor` argument validation).

This issue is the **138-file remainder**, whose common mechanism is the Reference
layer itself rather than any one built-in. Do not re-file the owned 172 here, and
do not size this issue at 310.

## Likely root cause

Member access and assignment lower to a direct field/slot read-or-write with a
null guard that yields `null` on miss, rather than to the spec's
`GetValue`/`PutValue` with their abrupt exits. Adjacent evidence: **#3406**
(dynamic any-callee with zero closure candidates silently returns `null` instead
of invoking or throwing) is the same failure shape one layer up — a missing
abrupt completion rendered as a null value.

Two arms to check:

1. **Base-not-object-coercible** — `undefined.p`, `null.p`, `delete base.p`,
   `base.p = v`, `base.p++` must all raise `TypeError` before the property
   operation. Includes the `RequireObjectCoercible` receiver checks on
   `String.prototype`/`Boolean.prototype` methods.
2. **Unresolvable reference in strict code** — `PutValue` on an undeclared name
   must raise `ReferenceError`, and a TDZ binding read must raise
   `ReferenceError` rather than yielding `undefined`.

## Acceptance criteria

- `delete base.prop` / `base.prop` / `base.prop = v` with `base` `undefined` or
  `null` throw a catchable `TypeError` on both lanes.
- Strict-mode `PutValue` to an unresolvable reference throws a catchable
  `ReferenceError`.
- The thrown value is an instance of the corresponding global intrinsic, so
  `assert.throws(TypeError, …)` and `e instanceof TypeError` both hold.
- ≥ 100 of the 138 files pass; no regression in the 172 files owned by
  #3185/#2668/#4008.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate` (record
  `#4158 … status=reserved`, read from `origin/issue-assignments`). The
  allocator's open-PR scan degraded (`gh` is unavailable in this container), so
  `--allow-unscanned` was used *after* scanning the open-PR set manually through
  the GitHub API: two open PRs (#4106, #4123); the highest issue id introduced by
  either is 4154. The required `check:issue-ids:against-main` gate remains the
  backstop.
- No compiler was built or run for this issue. The counts come from the published
  baselines and the causal claim is read from the test bodies plus the failure
  shapes — it has **not** been confirmed by a local repro. First step for whoever
  picks this up: reproduce `delete base.prop` on `undefined` and confirm the
  lowering.
