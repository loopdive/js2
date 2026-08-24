---
id: 4667
title: "ES5 standalone: arguments and arrays share $Vec, so Array.isArray(arguments) answers true and arr[\"length\"] answers arr[0] — and the first fix REGRESSES 10.6-6-2 unless the second lands with it"
status: ready
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: arguments-object
goal: standalone-gap
related: [4658, 3251, 4622, 3537]
origin: "residuals R2 and R3 of #4658, both measured on BOTH arms by that lane and both unclaimed when it closed. Filed together because R2 carries a landing-order hazard that is expensive to rediscover and invisible from either row alone."
---

## Two rows, one shared representation

An arguments object and an Array both lower to `$Vec`, and the predicates that ask
"is this an Array?" cannot tell them apart.

### R2 — `Array.isArray(arguments)` answers `true`

An arguments object is an ordinary Object, not an Array exotic object (§10.4.4), so this
must be `false`. It answers `true` because `__is_vec` is the predicate behind
`Array.isArray` and both representations are `$Vec`.

### R3 — `arr["length"]` answers `arr[0]`

Found while building #4658's Array controls, and **measured identical on base
`74389b417` and on #4658's branch** (`RESULT: 1111`) — so it is pre-existing, not
introduced there. A computed string-keyed read of `"length"` is routed as an index.

## ⚠ Landing order is load-bearing — R2 alone REGRESSES a row #4658 just fixed

This is the reason the two are one issue.

test262's `propertyHelper.isWritable` branches on `__isArray(obj) && name === "length"`
to pick a **numeric** probe value instead of the string `"unlikelyValue"`. That branch is
the **only** reason `language/arguments-object/10.6-6-2.js`'s `writable` check passes
today — the harness takes the Array path *because* `Array.isArray(arguments)` wrongly
answers `true`.

Fix R2 in isolation and the harness switches to the **string** path, which needs
#4658's RESIDUAL 1 (`arguments.length = "abc"` must stick) — which is **not** fixed.
So `10.6-6-2` flips back to failing, silently trading one row for another.

**Therefore: R2 must not land without the string-write half.** Either land them together,
or land R3 first and leave R2 explicitly blocked on RESIDUAL 1 with this note attached.

## The dependency R2 inherits

#4658 RESIDUAL 1 is owned by the `[[ParameterMap]]` / descriptor-sidecar arguments
representation that **#3251 and #4622 both defer to**. Its two halves, quoted from
#4658's measurement:

- the WRITE goes through `__extern_set`'s vec `length` arm, which is ArraySetLength-lite —
  a non-numeric value is a silent no-op (a numeric write *does* stick, by **resizing the
  vec**, which is its own §10.4.4 divergence);
- a `.length` READ on a vec-typed receiver folds at compile time to a `struct.get` on the
  vec's length field, so there is nowhere for a non-numeric length to live.

#4658 deliberately did **not** half-fix this: storing the string in the #3537 bag and
teaching only the dynamic read to find it would leave the static fold answering the old
numeric value — two surfaces disagreeing about the same property, which is worse than the
current coherent miss. Absent-not-wrong. Respect that reasoning here.

## Implementation Plan

1. Read `plan/method/es5-standalone-agent-brief.md` fully — it is binding. Especially the
   counts rule, the three-rung reporter ladder, the contention trap, and the
   blast-radius table.
2. Read #4658's `## Residuals` section first. R1–R4 already carry `it.fails` pins plus
   positive controls in `tests/issue-4658.test.ts`, so a correct fix has something that
   flips — use them rather than writing new ones.
3. **Start with R3.** It is independent of the landing-order hazard and pre-existing, so
   it can ship alone. Establish where a computed `"length"` read is routed as an index and
   why the string key is not distinguished.
4. **Before touching R2, decide explicitly** whether you are also closing RESIDUAL 1. If
   not, do not change `Array.isArray` — record the measurement and stop. A row-neutral
   decline is a good outcome here; a silent one-for-one trade is not.
5. If you do take both: `10.6-6-2` is your canary. Run it on both arms and quote it by
   name in your report.

## Acceptance

- R3 fixed, with #4658's existing pin flipping.
- `language/arguments-object/10.6-6-2.js` measured on **both** arms and still passing —
  this is the gate, not a nice-to-have.
- If R2 is left for later, say so plainly with the measurement, and leave this issue's
  R2 half open rather than closing it as covered.
- Blast-radius sweep sized per the brief: `__is_vec` / `__isArray` sit under Array *and*
  arguments, so the sweep covers both directories, not just `language/arguments-object`.

## Routed in from #4668 (2026-08-24): three more rows, same representation question

The #4668 lane rooted the `language/` bucket while fixing §10.4.3 and recommended these
be handled by this issue's owner rather than its own. Agreed — they are `$Vec`
element-representation questions, which is this issue's subject:

| row | measured base behaviour |
| --- | --- |
| `language/statements/function/S13_A2_T2` | `(function(arg){return arg + arguments[1]})(1,"1")` must be `"11"`; base answers **`2`** — `arguments[1]` was read at the **first parameter's numeric representation**, so the string `"1"` became `1`. |
| `language/statements/function/S13_A15_T3` | a PARAMETER named `arguments` must shadow the arguments object; base returns the object. |
| `language/arguments-object/S10.6_A5_T4` | the string-write half already recorded as #4658 RESIDUAL 1. |

`S13_A2_T2` is the informative one: it shows the arguments object and the parameter share
a representation closely enough that a *type* leaks across the alias. Take it with R-P/R2
rather than separately.
