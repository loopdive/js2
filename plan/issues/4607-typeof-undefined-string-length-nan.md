---
id: 4607
title: "(typeof u).length answers NaN instead of 9 for an undefined variable"
status: done
completed: 2026-08-21
sprint: current
created: 2026-08-21
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: typeof
goal: core-semantics
related: [4121]
# The `.length` arm gains a host-mode guarded read: recognizing `typeof`'s
# string-literal-union type newly routes a JS-host `externref` string into that
# arm, where the existing `externref → $AnyString` coercion is a checked cast
# that yields `ref.null` on a miss — an unconditional `struct.get` on it traps.
# The guard belongs at the read site (it is the site that knows which lane it is
# in and which receiver it just compiled); +22 lines.
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
origin: "#4121 slice 2 (PR #4720) negative-test writing; reproduces at the branch base and with every JS2WASM_NUMERIC_* kill switch off — pre-existing, unrelated to that slice"
# id 4607 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: the only open PR was 4720, which introduces
# no new issue files.
---

# #4607 — `.length` on a `typeof` result is `NaN` for `undefined`

## Problem

```js
var u;
console.log((typeof u).length);
```

| engine | `typeof u` | `.length` |
| --- | --- | ---: |
| node | `"undefined"` | 9 |
| js2 | — | **NaN** |

No call and no boolean is involved — the `typeof` result (a string) fed
directly into `.length` produces `NaN`, which suggests the member access is
lowered against a non-string carrier for the `typeof`-of-undefined case
(the other `typeof` results may or may not share the defect; the fix should
census all of them).

Found while writing negative tests for #4121 slice 2 (PR #4720). Reproduces
identically at that branch's base commit and with `JS2WASM_NUMERIC_RETURNS=0`
and `JS2WASM_NUMERIC_ADMISSION=0` — pre-existing and independent of that work.

## Root cause

`isStringType` — `src/checker/type-mapper.ts:380` — matched only the `String`
and `StringLiteral` type flags, never a **union** of string literals. TS types
`typeof x` as exactly that shape: the 8-member union
`"string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"`
(flags `Union`, no `String`/`StringLiteral` bit at the top level). So the
predicate answered `false` for **every** `typeof` result.

The consequence is at `src/codegen/property-access-dispatch.ts:3393`, whose
`.length` arm is gated on `isStringType(objType) || receiverIsNativeStringValType(...)`
— both false here, so the read fell through to
`finalizeStructAndDynamicMemberGet` → the generic `__get_member_length`
dispatcher. That dispatcher's ladder reads field 0 of the registered **vec**
struct types; a `$AnyString` matches none of them, so it fell to
`__extern_get(recv, "length")` → `undefined` → `__unbox_number` → **NaN**.

Two details the repro table did not capture:

- The defect is **standalone / `nativeStrings` only**. In JS-host mode a string
  is an `externref` and the host answers `.length`, so plain host mode already
  printed `9`; the reported repro was produced with the standalone harness
  (`target: "standalone"`, as in `tests/issue-4121-interprocedural-proofs.test.ts`).
- `.length` was not the only casualty of the same predicate:
  `(typeof u).charAt(0)` and `(typeof u).toUpperCase()` **trapped**
  ("dereferencing a null pointer") in standalone. Both are fixed by the same
  change.

### Fix

`isStringType` now also accepts a union whose constituents are **all**
string/string-literal types (`isStringLiteralUnion`, same file). This does not
create a type/carrier disagreement: `mapTsTypeToWasm` already lowers such a
union to `externref` — the identical ValType it gives a plain `string` — via
its "all constituents map to the same kind" arm.

One follow-on guard was needed at the `.length` arm
(`src/codegen/property-access-dispatch.ts`): in **JS-host + `nativeStrings`** the
`typeof` result is a real JS string `externref` (the `__typeof` host import),
and the arm's `externref → $AnyString` coercion is a *checked* cast that yields
`ref.null` on a miss, so the unconditional `struct.get` **trapped**. That arm now
reads a host-mode `externref` receiver through a runtime `ref.test $AnyString`:
GC string → the native `len` field, host string → the `__extern_length` import.
Standalone/WASI cannot produce a host string there, so its #1797 coercion path
is untouched.

### Not in scope (pre-existing, unrelated)

JS-host **plus** `--nativeStrings` cannot print a string at all — `console.log("x")`
logs `""` on `main` today, for a plain literal as much as for a `typeof` result.
That combination stays broken; this issue only removes the `.length` trap in it.

## Acceptance criteria

- [x] The repro prints `9` (matching node) in JS-host mode. (It already did in
      host mode; the standalone lane that actually reproduced now answers `9` too.)
- [x] A regression test covers `.length` on `typeof` of: an undeclared-value
      `var`, a number, a string, a boolean, an object, a function — all
      matching node. — `tests/issue-4607-typeof-string-carrier.test.ts`
      (18 tests, both lanes, plus the charAt/toUpperCase/slice/concat
      consumers and the typeof-comparison fold).
- [x] Root cause recorded here (where the `typeof` result loses its string
      carrier before the member access).
- [x] No equivalence regressions.
