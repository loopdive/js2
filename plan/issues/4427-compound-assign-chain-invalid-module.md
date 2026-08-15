---
id: 4427
title: "Compound `+=` chain with boolean RHS emits a non-validating module (any.convert_extern fed a (ref null $AnyString) if)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: compound-assignment
goal: standalone-gap
related: [4426, 3989, 1999]
origin: "2026-08-15 ES5-standalone session — found while fixing S11.13.2_A4.4_T1.4; reproduces at merge-base 63785cb (pre-existing, NOT introduced by #4426)."
---

# #4427 — compound `+=` chain with boolean RHS emits a non-validating module

## Problem

Two `+=` statements on the same var, where at least one RHS is a boolean,
produce a module that FAILS `WebAssembly.validate`:

```js
var x;
x = true;  x += "1";   // CHECK#1 of S11.13.2_A4.4_T2.7
x = "1";   x += true;  // CHECK#2  → module invalid
```

V8: `any.convert_extern[0] expected type externref, found if of type
(ref null $AnyString) @… in __module_init`. Verified combinations (probe
`.tmp/probe-t27d.mjs`, session 2026-08-15): `p12` (`+= "1"` then `+= true`)
and `p24` (`+= true` then `+= new Boolean(true)`) invalid; every
single-statement variant validates. Reproduces at merge-base `63785cb`.

Additionally, sibling WRONG-VALUE bugs in the same family (same test files,
`fail` not CE): `x = 1; x += "1"` → `2` (numeric lane chosen over concat,
S11.13.2_A4.4_T2.6 CHECK#2); `x = undefined; x += "1"` → `undefined`
(T2.8); `x = null; x += "1"` → `null` (T2.9). Fixing the lane choice for a
union-typed `x` whose runtime value is non-string is in scope if it falls
out of the same dispatch; otherwise file the residual.

test262 (ES5 standalone): S11.13.2_A4.4_T2.6–T2.9, plus the
`expressions/addition/S11.6.1_A2.2_*` non-CE siblings.

## Implementation Plan

1. Reproduce: `npx tsx .tmp/probe-t27d.mjs` (copy from the main checkout's
   `.tmp/`, or re-create: compile the two-statement pairs above with
   `{ target: "standalone", allowJs: true, skipSemanticDiagnostics: true,
   deferTopLevelInit: true, hostBridge: "always" }` and print
   `WebAssembly.validate`). Emit WAT (`emitWat: true`) and find the `if`
   whose result is `(ref null $AnyString)` feeding `any.convert_extern`.
2. The suspect emitters, all in
   `src/codegen/expressions/operator-assignment.ts`
   `compileNativeStringCompoundAssignment` (~line 1277):
   - the boolean-RHS arm (`emitBoolToString` → `any.convert_extern` +
     `ref.cast $AnyString`),
   - the (#3989) `bridgeSlot` store-back (`emitAnyStrToExternrefSlot`) — the
     documented hazard is exactly "a `ref $AnyString` result lands in an
     externref slot"; a UNION-typed `x` (boolean|string) stores as externref,
     so a second `+=` on the same slot exercises the bridge in both
     directions.
   - the #4426 wrapper-miss arm added 2026-08-15 (an `if` with
     `(ref null $AnyString)` result) — check whether the invalid `if` is the
     PRE-EXISTING guarded arm elsewhere or this one composed with the bridge.
3. Likely fix shape: whichever arm leaves `(ref null $AnyString)` on the
   stack for an externref-slot store-back must `extern.convert_any` first
   (or the `if` blockType must be externref in the bridge-slot case). Keep
   the non-bridge path byte-identical.
4. The wrong-lane siblings (T2.6/T2.8/T2.9): the `+=` lane choice for a
   union-typed LHS is made in `compileOperatorAssignment` (~line 1695:
   `isStr` = `isStringType(leftTsType)` or `hasStringAssignment`) and the
   #2058/#4137 any-compound-add recovery (~line 1730). `x = 1; x += "1"`
   with `x` union-typed picks the numeric path; the §13.15.3-correct
   dispatcher for "either side may be a runtime string" is
   `compileAnyCompoundAdd` / `emitAnyAddFromExternTemps`
   (`binary-ops.ts:2420`) — widen the eligibility test to unions of
   string|non-string, not only `any`/`unknown`, if measurement confirms.
5. Verify: the four probe pairs validate AND run correctly; runner flips for
   S11.13.2_A4.4_T2.6–T2.9 (use the single-test driver pattern:
   `runTest262File(path, category, 15000, "standalone")` from
   `tests/test262-runner.js`); `npm test -- tests/equivalence/string-*` and
   `tests/issue-3989*` (if present) green.

## Acceptance criteria

- `p12`/`p24` probe modules validate and produce `"1true"`/`"1true"`.
- S11.13.2_A4.4_T2.7 flips CE→pass standalone; T2.6/T2.8/T2.9 pass or the
  residual is filed with the exact failing lane documented.
- No regression in the scoped standalone filter
  `language/expressions/compound-assignment|language/expressions/addition`.
