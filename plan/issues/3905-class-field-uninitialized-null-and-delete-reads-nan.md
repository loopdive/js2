---
id: 3905
title: "class instance fields: an uninitialized field reads null instead of undefined, and a deleted field still reads (as NaN) — both lanes"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: class-elements
goal: core-semantics
related: [3647, 1364, 1591, 1334]
origin: "UNMASKED by #3647 (PR #3892): fixing prototype-method enumerability let verifyProperty reach instance-field keys it had never reached"
---

# #3905 — class instance field residuals: uninitialized reads `null`; deleted still reads as `NaN`

## Provenance — an exposed cohort, not a new regression

#3647 corrected `propertyIsEnumerable` for class **prototype** methods. That let
`propertyHelper.js`'s `verifyProperty` proceed past `m` to keys it had never
reached, and the `class/elements` rows then failed on **later** assertions:

```
obj['b'] descriptor should be writable          (same-line-gen-computed-names.js)
obj['a'] descriptor value should be undefined   (same-line-gen-literal-names.js)
```

Per the #3468 F1 landing recipe an exposed cohort gets its own tracker rather
than being banked, or read as a shortfall of the fix that revealed it.

## The failure messages point somewhere other than where they read

Narrowed in three steps — `runTest262File`, **both lanes**, controls passing:

1. A **plain** class field (`class C { b = 42 }`) is **fully correct in both
   lanes**: `hasOwnProperty`, `propertyIsEnumerable`, and all four descriptor
   attributes (`value`, `writable`, `enumerable`, `configurable`).
2. A **computed-name** field (`var x = "b"; class C { [x] = 42 }`) is **also
   fully correct on the descriptor read path**, both lanes — including the
   numeric-key form `[10] = "meep"`.
3. So this is **not descriptor fidelity**. `verifyProperty` reports on state it
   has **mutated**, and isolating the mutations produces two distinct defects.

Step 2 matters for scoping: a fix aimed at "computed-name field descriptors"
would be aimed at something that already works.

## Measured — exact values

Probe class (the shape from `same-line-gen-computed-names.js`):

```js
var x = "b";
class C { [x] = 42; ["not initialized"]; *m() { return 42; } }
```

```
uninit{type=object, isNull=true}
delete{before=42, ret=true, after=NaN, afterType=number,
       hasOwn=false (host) / hasOwn=true (standalone)}
```

### Residual A — an uninitialized class field reads `null`, not `undefined`

`class C { ["not initialized"]; }` → `typeof c["not initialized"]` is
`"object"` and `=== null` is `true`. **Both lanes.** A FieldDefinition with no
Initializer must be created with value `undefined` (§10.2 / ClassFieldDefinition
→ `InitializeInstanceElements`). This is a **null/undefined conflation**, not a
descriptor bug, and it is the `obj['a'] descriptor value should be undefined`
failure.

### Residual B — after `delete c.b`, the field still reads, as `NaN`

`delete c.b` returns `true`, but the subsequent read yields **`NaN`** — a
**number**, not `undefined`. The physical `f64` struct field is still read
through after deletion.

**The lanes diverge on the tombstone**, which is what makes this two problems
rather than one:

| lane       | `delete` returns | subsequent read | `hasOwnProperty` after |
| ---------- | ---------------- | --------------- | ---------------------- |
| host       | `true`           | `NaN`           | `false` (correct)      |
| standalone | `true`           | `NaN`           | **`true`** (wrong)     |

Host honours the tombstone for **presence** but not for the **value read**;
standalone honours it for neither.

## Why this is not #3647, #1364 or #1591

- **#3647** (done, PR #3892) is the **host-side `_wrapForHost` proxy**
  `getOwnPropertyDescriptor` trap with receiver `C.prototype`. This is the
  **instance** — a different receiver, a different path — and it reproduces in
  **both** lanes.
- **#1364** and **#1591** are both `done`; they covered prototype-method
  descriptor fidelity and struct↔host own-property reconciliation. Neither
  covers an uninitialized field's value nor the post-delete read.

## Acceptance criteria

- `class C { ["k"]; }` → `new C()["k"] === undefined`, and `typeof` is
  `"undefined"` not `"object"` — **both lanes**.
- After `delete c.b`: `c.b === undefined` — not `NaN`, not the prior value —
  **both lanes**.
- After `delete c.b`: `Object.prototype.hasOwnProperty.call(c, "b") === false`
  in **standalone** as well as host.
- Assert the lanes **together in one test** so a host-only or standalone-only
  fix cannot pass. #3647's lesson was that a lane-blind fix regresses the lane
  that was already right; here **neither** lane is right, which is a different
  hazard needing the same discipline.
- Carry controls that must hold under any spec version (an initialized field
  reads its value; an untouched field stays own + enumerable), so a fix that
  simply makes every read `undefined` cannot pass vacuously.
- Re-run `same-line-gen-computed-names.js` and `same-line-gen-literal-names.js`
  (both the `statements` and `expressions` variants) — they are the first-party
  demonstration that the semantics are achievable end to end.

## Notes for the implementer

The `NaN` is the tell: an `f64` struct field whose "absent" state is the numeric
NaN sentinel, surfaced to JS as a number instead of being intercepted on the
**read** path by the delete tombstone. Compare where the tombstone is consulted
for presence (`_wasmStructDeletedKeys` — host clearly reads it for
`hasOwnProperty`) against where the field value is fetched. Residual A is the
same species of question one step earlier: which sentinel represents "field
declared, never initialized". The two may share a single sentinel decision.

Do **not** size this from the `class/elements` row count: those rows sit behind
other assertions too, so the count is a **ceiling, not a yield**.

## Reproduction

`.tmp/3647/probe-field.js`, `probe-field2.js`, `probe-field3.js`,
`probe-field4.js` (driver `.tmp/3647/run.mts`, which calls `runTest262File` for
host and standalone in turn). `probe-field4.js` prints the exact values quoted
above through a `Test262Error` message channel.
