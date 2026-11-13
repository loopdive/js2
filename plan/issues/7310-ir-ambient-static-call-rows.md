---
id: 7310
title: "IR: ambient builtin static-call rows beyond gOPD / JSON.parse — measured, 0 passing files flip"
status: blocked
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7267, 7294, 7276, 7128, 7305]
assignee: "ttraenkler/c-r11"
---

# #7310 — ambient static-call rows in #7267's admission

## Problem

The `<module-init>` single-lever census
(`plan/log/ir-module-init-single-lever-census.md`) ranked "ambient builtin
static calls beyond gOPD / `JSON.parse`" first among unowned single levers:
8 of 9 files pass on standalone.

The plan was to add each call as a row in #7267's shared ambient-call
admission (`src/ir/ambient-global-function-call.ts`; its member-call form
is in PR #7118), but only where legacy already lowers the call through a
named helper the IR can call.

## Measurement (main `cc27f70d`, wrapped standalone, all-rejects diag)

Method: for each passing file, replace the static call with a constant, or
with a call to a trivial local function, and re-check `<module-init>`. This
shows whether the call is the only obstacle, and whether its arguments
would lower if the call were a row.

| file (passes) | call | with the call stubbed | arguments the row would need | flips? |
| --- | --- | --- | --- | --- |
| `Object/freeze/15.2.3.9-1-4.js` | `Object.freeze("abc")` | — | — | no: legacy compiles freeze away and records `ctx.frozenVars` integrity state (`call-builtin-static.ts` ~L1914). There is no helper to call. |
| `Date/UTC/return-value.js` | `Date.UTC(…)` | — | — | no: legacy inlines it (`call-namespace-static.ts` ~L3689). There is no helper. |
| `Object/isSealed/15.2.3.11-4-27.js` | `Object.isSealed(JSON)` | 0 legacy units with a constant | `JSON` as a bare value: `expr-ident-not-in-scope`. A dynamic argument also costs the call graph (`call-graph-closure`). | no |
| `NativeErrors/URIError/instance-proto.js` | `Object.getPrototypeOf(new URIError)` | still legacy: `URIError` as a value (`URIError.prototype`) | `new URIError`, `URIError.prototype` | no |
| `Reflect/defineProperty/target-is-symbol-throws.js` | `Reflect.defineProperty(Symbol(1), 'p', {})` | 0 legacy units | `Symbol(1)` (no symbol value kind); `{}` (`objectlit-empty`, #7128) | no |
| `Reflect/setPrototypeOf/target-is-not-object-throws.js` | `Reflect.setPrototypeOf(x, {})` ×4 | still legacy: `objectlit-empty` ×4 | `{}` (#7128) | no |
| `RegExp/escape/non-string-inputs.js` | `RegExp.escape(…)` and `typeof RegExp.escape` | still legacy: `{}`, `null` in closures | `{}`, `null`, a member read of a function value | no |
| `Object/create/15.2.3.5-4-154.js` | `Object.create({}, {…})` | — | — | owned by #7276 (PR #7142) |

The ninth file, `Object.isExtensible(Promise.allKeyed)`, fails on
standalone.

**Passing files that would flip: 0** (the stop condition is fewer than 3).
No code.

## Why

The census groups a file by the static call's refusal, but each top-level
statement reports only its **first** refusal. In every file the arguments
are refusals of their own, hidden behind the call:
- `{}` (#7128);
- a builtin as a bare value (`JSON`, `URIError`; #7294 / function values
  #7305);
- `Symbol(…)`.

So a row admission does not move these files on its own.

## What would move them

1. `{}` as a dynamic object argument (#7128). That unblocks the
   `Reflect.setPrototypeOf` and `Reflect.defineProperty` shapes. It is also
   their gating dependency: a `Reflect.*` row is only worth adding after it.
2. Builtin constructors and namespaces as values (`JSON`, `URIError`,
   `URIError.prototype`).
3. Only then the rows, if legacy has a named runtime helper per call. Legacy
   lowers `isSealed`, `getPrototypeOf` and `Reflect.*` in
   `call-builtin-static.ts`; whether each one is a single named helper call
   has not been checked, because no file reaches that point.

## Lesson for the census

A "single-lever" ranking should also stub the lever and re-check the unit,
because refusals nested inside the lever's own arguments are invisible to
the per-statement diagnostic. The census log carries this caveat.
