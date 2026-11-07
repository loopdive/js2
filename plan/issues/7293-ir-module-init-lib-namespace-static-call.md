---
id: 7293
title: "IR module-init: static calls on unshadowed lib namespace globals (`Object.keys(o)`, `JSON.stringify(v)`, …)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7253, 7267, 7275, 7276, 7128, 7278, 7292]
assignee: "ttraenkler/c-lane-opus"
---

# #7293 — IR module-init: static calls on unshadowed lib namespace globals

## Problem

`expr-ident-not-in-scope:Identifier «Object»` (and `String`, `Date`, `JSON`,
`Reflect`, …) refuses test module-inits that call a static method on an
unshadowed lib namespace global.

## Outcome (2026-11-07): measured, bounded yield ≤ 1 file, no code

Static `<Namespace>.<method>(…)` calls are a small part of this refusal. Almost
every sole-blocker file reads a **built-in object as a value**
(`String.prototype.trim`, `Object.getOwnPropertyDescriptor(Date.prototype,
"m")`, `Object.isSealed(JSON)`). That is #7275 / #7276's provider question,
not a static call. Per the dispatch rule, this issue stops at measurement with
a docs-only PR.

## Measurement (main `c03f7d0e`, 2026-11-07)

Census: wrapped stride-40 standalone,
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`, the run shared
with #7292.

- **117** files whose only legacy unit is `<module-init>` carry an
  `expr-ident-not-in-scope` part on a lib namespace (`Object`, `String`,
  `Date`, `Array`, `JSON`, `Number`, `Reflect`, `RegExp`, `Set`, `Map`,
  `Promise`). In **28** of them every statement-level part is such a name.
- **Unmask:** a throw-away probe admitted the 11 names at the
  `expr-ident-not-in-scope` arm. **19** of the 28 then pass selection and stop
  only at from-ast ("identifier … is not in scope"), so a lowering for their
  exact shapes is all they lack. The other 9 have a further selection refusal
  (`{}`, `new WeakMap`, `new URIError`, closure shapes, `null` closure
  values).

The 19, by what they would need:

| Shape | Files | Owner |
| --- | ---: | --- |
| a built-in prototype member READ as a value (`String.prototype.trim`, `.slice`, `.toLowerCase`, `.trimLeft`/`.trimStart`, `Date.prototype.toISOString`, `Date.prototype.hasOwnProperty`, `Number.prototype.hasOwnProperty`) | 7 | #7275 (built-in objects as values) |
| `Object.getOwnPropertyDescriptor(<Builtin>.prototype, "m")` | 4 | #7276 / #7128 (descriptor objects) |
| a built-in namespace as a value (`Object.isSealed(JSON)`, `Object.isExtensible(Promise.allKeyed)`) | 2 | #7275 |
| a static's own property (`Object.isFrozen.length`), a borrowed call (`Array.from.call(…)`), calling `Object.prototype()` (TypeError) | 3 | #7275 |
| `JSON.parse("…")` | 1 | #7267 (ambient call rows, PR #7118) |
| **`Date.UTC(y, m, …)`, number operands** | 1 | this issue |
| **`Object.freeze("abc")`, primitive operand** | 1 | this issue |

### Why the two in-scope files were not admitted

- **`Date.UTC(…)`** (`built-ins/Date/UTC/return-value.js`). Legacy lowers it
  **inline** in `src/codegen/expressions/call-namespace-static.ts`: about 80
  instructions for MakeFullYear, MakeDay month roll, MakeTime, the TimeClip
  clamp and a NaN accumulator, around the `ensureDateDaysFromCivilHelper`
  function.
  - An IR arm would either duplicate that algorithm in IR, a copy-paste the
    IR quality rule forbids, or factor it into a shared compiler-support
    function, which changes legacy's gc output bytes for every `Date.UTC`
    call. Neither is a bounded admission.
  - The clean route is a native `Date.UTC` helper that both paths call, landed
    as its own reviewed change with the gc byte change measured. After that,
    an IR arm in `src/ir/ambient-global-function-call.ts` is one table entry.
- **`Object.freeze("abc")`** (`built-ins/Object/freeze/15.2.3.9-1-4.js`).
  ES2015+ returns a primitive operand unchanged.
  - Legacy's lowering (`call-builtin-static.ts`) also records compile-time
    integrity state: `frozenVars` / `sealedVars` for an identifier argument,
    or for the declared variable when the call is a `var` initializer. Later
    member writes consult that state.
  - An IR identity fold would skip the recording, so it is sound only for a
    literal operand that is not a declaration initializer. That is a one-user
    special case (one file in the sample), so it is not added.

**Bounded zero-legacy yield: ≤ 1 file** (the freeze fold), and that one is a
narrow special case. **0** with the IR quality rule applied.

## Implementation Plan (for later)

1. **Native `Date.UTC` provider first**, as its own change: extract the inline
   legacy sequence into one compiler-support function, measure the gc byte
   delta, and land it reviewed. Then add a `Date.UTC` entry to the
   `ambient-global-function-call.ts` table: number operands only, 1–7
   arguments, lib-only `Date` (a script `var Date` / `function Date` refuses
   through `scriptDeclaresName`).
2. The namespace-as-value and prototype-member-read rows (13 of 19) need
   #7275's built-in-object value kind. Re-run this census when it lands; most
   of these files then reduce to their next refusal.
3. `Object.freeze/seal/preventExtensions`: admit only once the IR records the
   same integrity state legacy's write path consults. No identity fold before
   that.

## Acceptance criteria

- [x] Sole-blocker files measured, unmasked and classified by shape and owner.
- [x] The bounded in-scope yield stated (≤ 1, 0 under the quality rule), with the reason for each.
- [x] The route for the two in-scope shapes recorded.
