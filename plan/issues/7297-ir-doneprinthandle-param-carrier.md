---
id: 7297
title: "IR: doneprintHandle pair ($DONE / __consolePrintHandle__) param-dynamic-carrier refusal — measured, carrier covered by #7277"
status: blocked
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7277, 7270, 7260, 7119, 4612]
assignee: "ttraenkler/c-lane-opus"
---

# #7297 — the doneprintHandle pair's `param-dynamic-carrier-diverges-from-legacy`

## Problem

`param-dynamic-carrier-diverges-from-legacy` is the largest refusal family on
the wrapped stride-40 standalone ledger. It is raised by
`dynamicCarrierDivergesFromLegacy` (`makeIrDynamicCarrierDivergenceProbe`,
`src/codegen/fnctor-typed-instances.ts`). Units refused for it (main
b83a8ee0):

| unit | files | refused parameter |
| --- | --- | --- |
| `__consolePrintHandle__` | 139 | `msg` |
| `$DONE` | 139 | `msg` (its callee's: call-graph closure) |
| `verifyPrimordialCallableProperty` | 126 | `options` |
| `verifyPrimordialAccessorProperty` | 126 | `desc` |
| `verifyEqualTo` | 125 (+5 on `name`) | `value` |

## Measurement (2026-11-07)

**Legacy's slots**, dumped from `legacyParamSlot` on
`built-ins/Array/fromAsync/asyncitems-string.js` and
`built-ins/Array/prototype/fill/prop-desc.js` (standalone):

| parameter | legacy slot | why the probe declines |
| --- | --- | --- |
| `__consolePrintHandle__(msg)` | `(ref $AnyString)`, **non-null**. Every call site passes a string. | Off the fast lane only `ref_null $AnyString` reconciles with the externref carrier (#7119). |
| `$DONE(error)` | `externref` | It doesn't: `$DONE`'s own parameter is fine. It falls only because it calls `__consolePrintHandle__`. |
| `verifyEqualTo(obj, name, value)` `value` | `f64` | A scalar slot never matches the dynamic carrier (#7260). |
| `verifyPrimordialAccessorProperty(…, desc)` | `(ref $struct83)`, non-null, from the call-site object literal | not a string slot |
| `verifyPrimordialCallableProperty(…, options)` | `(ref null $struct81)`, from the call-site object literal | not a string slot |

So the pair and the trio need **different carriers**: a refined string slot
for the pair; an `f64` slot and two object-literal struct slots for the trio.

**Stacked on #7277** (PR #7143, branch `issue-7277-ir-param-legacy-refined-slot`
@ 0914898f, which adopts legacy's call-site-evidenced string/f64 slot), on a
10-file sample of the 139 async files:

- the `msg` carrier refusal is **gone in 10/10**, so #7277 already covers the
  pair's carrier. No further carrier predicate is needed.
- the pair's next refusals, 10/10:
  - `__consolePrintHandle__`: **`external-call`**. `print(msg)` calls the
    harness's `var print = function (value) { console.log(value); }`, a call
    through a script-var function value whose `<module-init>` is
    legacy-owned. This is callable-planning territory, not a carrier
    question.
  - `$DONE`: **`move-only[concrete]`** on
    `'Test262:AsyncTestFailure:' + error.name + ': ' + error.message`: property
    reads on the dynamic `error` inside a string concat.
- the trio is **still refused for the carrier** on #7277 (10/10 sampled),
  because their slots are f64 / struct rather than the call-site string #7277
  adopts.

**Zero-legacy delta on the stride: 0.** No `$DONE` file has only the pair as
legacy units. Every one also has a legacy `<module-init>` (3–24 legacy units
per file; the commonest extra refusals are `objectlit-empty`, `Promise` as an
identifier, `vardecl-module-storage-unrepresentable` and async/generator
closures). Clearing the pair would move units, not files.

## Conclusion — stopped at measurement (per the brief)

- **Carrier:** covered by #7277 for the pair. Nothing to add to the probe or
  the slot projection, which is R7's module this session.
- **What actually blocks the pair after #7277** is outside the carrier
  question:
  1. a call through the `print` script-var function value (callable planning);
  2. dynamic property reads in a string concat in `$DONE` (the move-only
     concrete scan).
- **The trio** needs its own carrier adoption (struct slots from call-site
  object literals, and an f64 slot). That is a different predicate from the
  pair's and belongs with R7's slot projection.

No code change on this id.
