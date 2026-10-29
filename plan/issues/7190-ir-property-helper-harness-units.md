---
id: 7190
title: "IR: ship test262's propertyHelper.js harness units on the standalone lane"
status: in-progress
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/js2-17"
---

# IR: ship test262's propertyHelper.js harness units

## Problem

`summary.ir_only_pass` counts standalone test262 passes whose compile has no
legacy unit (`scripts/build-test262-report.mjs`, the `ir_legacy_units == 0`
filter). About 12 % of test262 includes `harness/propertyHelper.js`. Each of
its helpers is a separate unit, so one legacy helper keeps the whole file out
of the count.

The sta.js / assert.js rows are another lane's (#7106 and its PRs). This issue
covers only propertyHelper.js.

## Census on main (2026-10-29, `cb3ff519`)

Standalone, `built-ins/Boolean/prop-desc.js`, literal harness,
`JS2WASM_IR_SHAPE_DIAG=1`. 14 legacy units:

| unit | refusal |
| --- | --- |
| verifyNotWritable, verifyNotEnumerable, verifyNotConfigurable | `expr-module-value-not` on `!__getOwnPropertyDescriptor(obj, name).<attr>` |
| isEnumerable | `expr-module-value-logical` on `stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name)` |
| verifyEnumerable | `call-graph-closure` (calls isEnumerable) |
| verifyWritable | `call-graph-closure` (calls isWritable) |
| isWritable | `vardecl-module-binding-alias` on `__isArray(obj) && name === "length" ? … : …` |
| verifyProperty | `vardecl-module-binding-alias` on `var originalDesc = __getOwnPropertyDescriptor(obj, name)` |
| verifyPrimordialCallableProperty, verifyPrimordialAccessorProperty | `vardecl-module-binding-alias` on the `{ verifyProperty: … }` object literal |
| verifyCallableProperty | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` |
| verifyAccessorProperty | `param-type-unresolved(desc)` |
| verifyEqualTo | `abi-signature-parity`: IR's `(externref ×3) → ()` signature resolves to the structurally equal `$__closure_prop_set_type` index, legacy's to `verifyEqualTo_type` |
| `<module-init>` | `expr-ident-not-in-scope` on `Array` / `Object` (the alias initializers) |

**Found while implementing:** a helper whose call sites all pass string keys
(`verifyConfigurable(o, "c")`) gets a native-string `name` slot from legacy
(`inferImplicitAnyParamType`). The IR claimed it as a dynamic carrier, so the
claim ended at the parity guard — a claim-then-demote, already live on main
for `verifyConfigurable` and `verifyEnumerable`.

## Ranking (units unblocked per arm)

1. **`!` over a descriptor read** — verifyNotEnumerable, verifyNotConfigurable
   (2 now); verifyNotWritable moves to its isWritable callee.
2. **`&&` over exact booleans** — isEnumerable, verifyEnumerable (2).
3. **isWritable's alias conditional** — isWritable, verifyWritable,
   verifyNotWritable (3). Further blockers inside isWritable are not yet
   measured (`arguments.length`, a store in `try`).
4. **Call-site-narrowed string parameter** — every helper a test calls with
   string-only keys, verifyProperty among them (`verifyProperty(this,
   "Boolean", …)` in most files). Today that is a pre-claim refusal (this
   issue); the next step is to project legacy's string slot into the IR.
5. verifyProperty's descriptor `var` (1, but the most-called helper).
6. verifyPrimordial* object literal (2); verifyCallableProperty's logical value
   (1); verifyAccessorProperty's `desc` (1); verifyEqualTo's type identity (1);
   `<module-init>` (1).

## Implementation Plan

Slices 1 and 2 ship here, plus the pre-claim refusal from the finding above.

### Slice 2 — one module-influence predicate for `!` and `&&`/`||`

- **Module:** `src/ir/select.ts`, next to `trackedModuleInfluenceIsBoolean`.
- **Duplicate removed:** the `!` site tested
  `trackedModuleInfluenceIsBoolean(op) || declaredExpressionHasExactFamily(op,
  "boolean")` inline; the `&&`/`||` site tested only the first half. Both now
  call one helper, `moduleInfluenceIsExactBoolean`. S1g already certifies the
  isEnumerable expression as exactly boolean (its own comment cites it); the
  logical site simply did not ask.

### Slice 1 — `!` over a descriptor member read

- **Module:** `src/ir/uncurried-object-alias.ts`, the module that certifies
  the stored alias. The new predicate, `isStoredObjectDescriptorMemberRead`,
  reuses `isStoredObjectDescriptorAliasCall`, which moves there from
  `select.ts`. Both are questions about the alias, not about selection, and the
  move keeps `select.ts` under its size ceiling.
- **Selector:** the `!` site skips the module-value refusal for that operand.
  `!` is ToBoolean of any value, and the operand is a dynamic carrier, so
  there is no module storage slot to misread.
- **No lowering change:** from-ast already lowers `!dyn` through `dyn.truthy`,
  and the move-only scan already admits the read.

### Pre-claim refusal — legacy's narrowed string parameter

- **Module:** `src/codegen/fnctor-typed-instances.ts`, in the existing
  `dynamicCarrierDivergesFromLegacy` probe (#4612) that the selector consults
  before resolving a parameter as dynamic.
- **Arm:** `legacyParamSlotIsNativeString` answers true when legacy's
  registered slot is the native string type. The parameter then reports
  `param-dynamic-carrier-diverges-from-legacy`, before the claim.
- **Duplicate removed:** the slot lookup (`funcMap` → `mod.types` → param or
  result), written out twice (`legacyPositionCarriesFnctorInstance`,
  `legacyParamSlotIsExternref`), is one helper, `legacyFunctionSlot`. The
  #4612 adapter doc comment had drifted above the wrong function; it is back
  on `makeIrDynamicCarrierDivergenceProbe`.

### Acceptance criteria

- isEnumerable, verifyEnumerable, verifyNotEnumerable and
  verifyNotConfigurable ship IR bodies in a standalone compile of the literal
  harness when keys are mixed (symbol and string).
- With string-only keys, verifyNotEnumerable and verifyConfigurable are
  refused at `select`; neither appears in `irPostClaimErrors`.
- Each helper's passing and throwing paths (data, accessor, symbol-keyed,
  non-configurable and absent properties) pass standalone as in node, with the
  literal harness. The upstream harness self-tests for these helpers pass.
- Scoped standalone test262 A/B (`built-ins/Boolean`, `built-ins/Math`):
  0 pass→fail.
- Code quality: no new predicate that duplicates an existing one; each new
  arm sits beside the sibling it reuses; no function or file budget growth;
  `check:ir-fallbacks`, `check:host-import-policy` and the standalone-arms
  gate stay green. The arms are lane-neutral: default gc (native-first)
  claims the same units as standalone, through the same capabilities.

## Test plan

`tests/issue-7190-prophelper-not-and-logical.test.ts`: fixtures compiled with
the literal harness through `runTest262File` (standalone), cross-checked by
running the same assembled source in node; plus the ten upstream harness
self-tests for these helpers.

## Results (measured 2026-10-29)

Per-unit census, standalone, `built-ins/Boolean/prop-desc.js`:

| | legacy units |
| --- | --- |
| main | 14 |
| + slice 2 | 12 (isEnumerable, verifyEnumerable ship) |
| + slice 1 | 10 (verifyNotEnumerable, verifyNotConfigurable ship) |

`tests/issue-7190-*`: head 19/19; base fails exactly the two IR-unit checks,
all runtime checks pass on both.

Scoped standalone test262 A/B (`TEST262_TARGET=standalone`, one chunk per
directory, base = `origin/main` `cb3ff519`, head = this branch; each side with
its own compiler bundle):

| dir | files | pass base → head | pass→fail | Σ `ir_legacy_units` base → head | files with fewer / more legacy units |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Boolean` | 51 | 49 → 49 | 0 | 175 → 148 | 7 / 0 |
| `built-ins/Math` | 327 | 308 → 308 | 0 | 2012 → 1530 | 121 / 0 |

`ir_only_pass` stays 0 in both directories on both sides: ten propertyHelper
units are still legacy (see the ranking), so no file that includes
propertyHelper.js reaches zero yet.
