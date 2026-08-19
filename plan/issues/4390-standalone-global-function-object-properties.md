---
id: 4390
title: "Standalone global object omits ES5 function-valued own properties"
status: done
assignee: ttraenkler/codex-es5-global-function-descriptors
sprint: 78
created: 2026-08-12
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: global-object, property-descriptors, function-objects
goal: es5
related: [1462, 2896, 2996, 3053, 4205, 4230]
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
coercion-sites-allow:
  - src/codegen/standalone-global-functions.ts
---
# #4390 — Standalone global function object properties

## Problem

The native standalone realm object is a real, identity-stable `$Object`, but it
starts empty. In ES5 Script code this makes both sides of the descriptor value
check collapse to `undefined`:

```js
var global = this;
var desc = Object.getOwnPropertyDescriptor(global, "parseInt");
desc.value === global.parseInt; // vacuously true: undefined === undefined
desc.writable;                  // undefined, expected true
```

All seven ES5 Test262 files
`built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-{5..11}.js`
therefore fail on `desc.writable`. The missing property is the root cause, not
descriptor-field materialisation: the native `__getOwnPropertyDescriptor`
already returns correct fields for genuine `$Object` entries.

## Scope

Install genuine, identity-stable callable values for the seven assigned ES5
global function properties on the native realm object:

- `parseInt`, `parseFloat`
- `isNaN`, `isFinite`
- `decodeURI`, `decodeURIComponent`, `encodeURIComponent`

Each property is an own data property with attributes
`{ writable: true, enumerable: false, configurable: true }`. The value must be a
real callable closure, not a null/undefined carrier that makes identity checks
pass accidentally. Direct global calls and reads through `globalThis` must
share the same native implementation and singleton identity.

## IR ownership

The values live on the native realm `$Object` and are read by the shared
`__extern_get` / `__getOwnPropertyDescriptor` runtime. Prepared IR
`dyn.member_get` lowers through `__dyn_member_get` to the same runtime read, so
the regression suite must prove an IR-emitted function observes the seeded
function value rather than adding a legacy-only AST fold.

## Acceptance criteria

- [x] All seven assigned standalone Test262 files flip fail → pass.
- [x] The descriptor value is callable and identity-stable across descriptor,
      `globalThis.<name>`, and repeated dynamic reads.
- [x] The descriptor attributes are `writable:true`, `enumerable:false`, and
      `configurable:true`.
- [x] Different global functions have distinct identities.
- [x] A prepared-IR function is recorded as emitted and reads the same property
      through `dyn.member_get` / `__dyn_member_get`.
- [x] A paired standalone A/B includes both verdict controls and reports all
      seven rows on both commits.

## Verification

At exact base `a28c6bfcb3df2e61dcfd63a7baddfb0d5d33c711`, the assembled
standalone harness reported all seven assigned files failing. The candidate
reported all seven passing: **7 fail → pass, 0 pass → fail**. Seven already
passing `Object.getOwnPropertyDescriptor` controls remained **7/7 pass** on
both revisions, and the probe's synthetic must-pass/must-fail verdict controls
were correct on every run.

The focused Vitest suite passes 9/9 tests. It rejects the historical
undefined-identity tautology by requiring each descriptor value to be callable,
invoking all seven functions, checking stable and distinct identities, and
checking all three descriptor attributes. Its IR proof records
`readGlobalFunction` as emitted and observes `__dyn_member_get`, `__extern_get`,
and the native global-function closure in WAT.

Final local gates: `typecheck`, `check:ir-fallbacks`, `check:stack-balance`,
`check:loc-budget`, `check:func-budget`, and `check:oracle-ratchet` pass.
