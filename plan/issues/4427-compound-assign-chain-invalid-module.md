---
id: 4427
title: "Compound `+=` chain with boolean RHS emits a non-validating module (any.convert_extern fed a (ref null $AnyString) if)"
status: done
completed: 2026-08-15
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
# The lane decision + operand bridging moved OUT to the new subsystem module
# src/codegen/string-compound-lane.ts; what stays in the driver is the hoisted
# left/right checker types (shared with the #2058 block below it, net zero raw
# checker sites) and the three-line call into that module. +2 file lines /
# +6 function lines is the irreducible residue of that call.
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
func-budget-allow:
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
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

## Resolution (2026-08-15)

Two INDEPENDENT defects, both in the standalone (nativeStrings) `+=` lowering.
The plan's suspicion that the #3989 bridge-slot store-back or the #4426
wrapper-miss arm produced the bad `if` was wrong on both counts — the culprit
is older and simpler.

### 1. Invalid module — `emitBoolToString` is DUAL-LANE, its callers were not

Minimal repro is a SINGLE statement, not a chain: `var x = "1"; x += true;`.

```wat
i32.const 1
(if (result (ref null 6))          ;; 6 = $AnyString — emitBoolToString, native lane
  (then global.get 44) (else global.get 45))
any.convert_extern                 ;; ← operand must be externref. INVALID.
ref.cast (ref 6)
```

`emitBoolToString` (string-ops.ts:1618) returns an **externref** string-constant
global in the JS-host lane but a native `$AnyString` when
`ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0`. Both native-string coercion
sites — `compileNativeStringCompoundAssignment`'s boolean-RHS arm and
`compileAndCoerceToAnyStr` (the #1210 builder path) — appended the host lane's
`any.convert_extern` + `ref.cast` **unconditionally**, ignoring the ValType
`emitBoolToString` returns. The comment at the first site even asserted the
wrong half ("emitBoolToString returns externref").

Fixed by `emitBoolToAnyStr` (new module `src/codegen/string-compound-lane.ts`),
which branches on the reported type: externref keeps the host tail; the native
lane emits `ref.as_non_null`, correct for both shapes that lane can produce
(`ref.as_non_null` accepts a non-null operand). The `p12`/`p24` chains were
never a separate bug — they simply contained this statement.

### 2. Wrong lane — the concat gate only ever looked at the LHS

The sibling wrong-value bugs turned out to be ONE bug, and it did fall out of
the same dispatch. §13.15.3 defers to §13.5.3, whose step 3 concatenates as
soon as **either** operand's ToPrimitive is a String. The gate in
`compileCompoundAssignment` tested `isStringType(leftTsType)` and then, only
for an `any` LHS, `hasStringAssignment`. With the checker narrowing `x` to
`number` immediately after `x = 1`, `x += "1"` failed both tests and fell
through to the f64 lane, which ToNumber-coerced the string: `2`, not `"11"`.
Same mechanism for the `undefined` / `null` LHS rows.

`rhsStringForcesConcatLane` adds the missing half: a statically String-typed
RHS (string primitive, string literal, or a `String` WRAPPER object — all
ToPrimitive to a string) settles the lane on its own.

**Deliberately restricted to the case the concat lane can SERVE**, via
`slotNeedsExternrefBridge` (no JS host + externref slot):

- Its inbound half `emitExternrefSlotToAnyStr` (#3472) runs the §7.1.17
  ToString walker on the loaded value, which is what makes a number / boolean /
  `undefined` / `null` / wrapper in the slot stringify instead of trap.
- An f64/i32 slot cannot hold the concat result at all, so it keeps the
  numeric lane.
- The JS-host lane's `compileStringCompoundAssignment` loads the slot RAW into
  js-string concat — no ToString on the LHS — so it keeps the numeric lane too.
  Widening this rule to the host lane is a separate change and would need its
  own LHS ToString.

### Residual (out of scope, not fixed)

- **JS-host lane**: `x = 1; x += "1"` with a JS host still takes the numeric
  lane, per the gate above. Only the standalone/WASI native-string lane is
  fixed here. Not observable in the ES5-standalone conformance target.
- `tests/issue-1999.test.ts` "captured string += inside an async function
  appends" times out at 35 s. **Pre-existing** — verified failing identically
  with both source files reverted to the merge-base. Untouched by this issue.

## Test Results (2026-08-15)

Scoped standalone run,
`language/expressions/compound-assignment` + `language/expressions/addition`
(502 files, `.tmp/run-dir.mts`, before/after on the same tree):

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| before | 463 | 28 | 11 |
| after | **467** | 24 | 11 |

Per-file delta: **+4, zero regressions.**

```
FAIL -> PASS  S11.13.2_A4.4_T2.6.js
FAIL -> PASS  S11.13.2_A4.4_T2.7.js
FAIL -> PASS  S11.13.2_A4.4_T2.8.js
FAIL -> PASS  S11.13.2_A4.4_T2.9.js
```

Probes (`.tmp/p4427.mts`) — `p1`/`p2`/`p12`/`p24` all `validate true`; before,
`p2` (the single statement), `p12` and `p24` each failed with
`any.convert_extern[0] expected type externref, found if of type (ref null 6)`.

Suites: `tests/issue-4427-compound-assign-chain.test.ts` 8/8 new · the eight
string/compound `tests/equivalence/*` suites 55/55 · `tests/issue-3989-*`,
`tests/issue-3472-*`, `tests/issue-2058-*`, `tests/compound-assignment-*` green
· `npm run typecheck`, `biome lint` on the changed files, `check:oracle-ratchet`
(net −1 `getTypeAtLocation`, −1 `ctx.checker`) all clean.
