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

## Confirmed repro (2026-08-05) — and a CORRECTION to the framing above

This issue was filed from baseline signatures alone. Now measured on this tree
(`--target standalone`, deps installed). Encoding: **0 = nothing thrown (bug)**,
**1 = threw, but not an instance of the expected constructor**, **2 = correct**.

```
A  delete base.prop      base = local  const base: any = undefined   -> 2  CORRECT
B  read   base.prop      base = local                                -> 0  BUG
C  write  base.prop = 1  base = local                                -> 0  BUG
D  read   base.prop      base = local  const base: any = null        -> 1  BUG (wrong ctor)
F  delete base.prop      base = MODULE-SCOPE var, read in a closure  -> 0  BUG
G  control: throw new TypeError("x"); e instanceof TypeError         -> 2  CORRECT
```

**The `delete` example quoted above is the wrong canonical case, and this issue
originally led with it.** `delete base.prop` on an undefined base *does* throw a
proper `TypeError` when the base is a local in the same function (A). It only
fails when the base is a module-scope binding reached from a **closure** (F) —
which is exactly the shape
`language/expressions/delete/member-identifier-reference-undefined.js` uses, so
the test still fails, but not for the reason this issue first gave.

What the probes actually establish:

1. **Plain member READ and WRITE on an undefined base never throw at all** (B, C)
   — broader than `delete` and not called out in the original framing. This is
   the primary defect.
2. **`delete` is scope-sensitive** (A vs F). A same-function local is handled;
   a closure-captured module-scope binding is not. That points at the
   *reference-resolution* path for captured bindings, not at `delete` semantics —
   a much sharper lead than "the Reference layer never throws".
3. **A `null` base throws the wrong thing** (D) — something is raised, but it is
   not an instance of `TypeError`. That is the error-constructor identity
   sub-shape listed in the table below, and it is implicated in the base-coercion
   path too, not only in the 4 files attributed to it.
4. **The `instanceof` machinery itself is fine** (G), so D is a real
   wrong-constructor bug and not an artifact of how the probe tests it.

Probe artifact, not a finding: the closure-plus-helper variant (E) failed to
instantiate with a missing `env` host import rather than returning a verdict, so
it is excluded.

**Consequences for whoever picks this up.** Lead with B/C, not with `delete`.
Treat A-vs-F as the diagnostic that localises the bug — the same syntactic
operation succeeds or fails purely on how its base binding is stored, which
should point straight at the closure/module-binding read path. And do not assume
the 138-file count partitions the way the sub-shape table below suggests; that
table was derived from error text, and D shows at least one row bleeding into
another mechanism.

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
- **Superseded 2026-08-05.** This bullet said no repro had been run and named
  `delete base.prop` as the first thing to reproduce. That has now been done, and
  it partly refuted the framing — see the confirmed-repro section above. The
  counts still come from the published baselines and have not been
  re-partitioned against the corrected mechanism.
