---
id: 2374
title: "standalone: String/Number/Boolean.prototype.<method> built-in static-property value reads refuse (~67 tests) — register $NativeProto glue (S4 wrapper protos)"
status: done
assignee: ttraenkler/sdev-harvest2
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
language_feature: builtins, reflection
goal: standalone-mode
related: [2193, 2175, 1907, 1888]
origin: "2026-06-19 — standalone failure-bucket re-harvest (biggest clean, non-representation-gated bucket)"
---

## Problem

In `--target standalone`, reading a `String.prototype.<method>` (or
`Number.prototype.<method>` / `Boolean.prototype.<method>`) as a **value**
— not invoking it — refuses at compile time:

```
Codegen error: String.prototype built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b). Add a native built-in
method closure for this pair.
```

This is the single biggest clean standalone-CE cluster in the re-harvest
(194 String + ~93 Number + ~13 Boolean host-pass/standalone-CE entries). It
fires on idioms like:

```js
var search = String.prototype.search;        // value read of the method
String.prototype.toUpperCase.length;          // arity meta read
String.prototype.trim.hasOwnProperty("name"); // reflective read
Number.prototype.toFixed.length;
```

These all route through `property-access.ts`
`reportUnsupportedStandaloneBuiltinValueRead` because the `$NativeProto`
glue is only wired for Array/Object/RegExp (#2193 / #2175). String/Number/
Boolean brands are **pre-reserved** in `native-proto.ts`
`BUILTIN_BRAND_TABLE` (BASE+20/21/22) but never get a registered member-CSV
glue, so `tryEnsureNativeProtoBrand` returns `undefined` and the read
refuses.

## Root cause

`tryEnsureNativeProtoBrand` (`src/codegen/property-access.ts`) only handles
`RegExp` / `Array` / `Object` explicitly; every other builtin (including the
reserved S4 wrapper-proto brands) falls through to the generic
`getBuiltinBrand` path, which returns the brand only if glue was *already*
registered. Nothing registers String/Number/Boolean proto glue, so the
value read is refused.

## Fix (additive — exact #2193 pattern)

`src/codegen/array-object-proto.ts`:
- Add `STRING_PROTO_METHODS` / `NUMBER_PROTO_METHODS` / `BOOLEAN_PROTO_METHODS`
  member lists (ES2024 §22.1.3 / §21.1.3 / §20.3.3; String includes Annex-B
  `substr`).
- Add spec arities (`fn.length`) for the String/Number members that differ
  from the default 1 to `PROTO_METHOD_LENGTH`.
- Add `ensureStringNativeProtoGlue` / `ensureNumberNativeProtoGlue` /
  `ensureBooleanNativeProtoGlue` — same body as `ensureArrayNativeProtoGlue`
  (idempotent `registerNativeProtoBuiltin(makeGlue(...))`).

`src/codegen/property-access.ts`:
- Import the three new ensure-fns; wire three `if (builtinName === ...)`
  branches into `tryEnsureNativeProtoBrand`.

`emitLazyNativeProtoGet` builds the `$NativeProto` struct purely from the
glue's member CSV + name, so registering glue makes the proto-object value
read (and reference identity) resolve host-free immediately. Reflective
member-CLOSURE bodies still degrade to a catchable TypeError
(`emitProtoMemberBodyRefusal`) until per-member native bodies land — the
value-read object itself needs only the member set.

No new host import; dual-mode (host/WASI) output is untouched (the
`__get_builtin` host path is unaffected; this only changes the standalone
refusal branch).

## Measured flips (patched standalone runner, real test262 harness)

| set | before | after |
|-----|--------|-------|
| built-ins/String/prototype CE (328) | 0 pass | 56 pass |
| built-ins/Number/prototype (93) | 0 pass | 11 pass |
| built-ins/Boolean/prototype (13) | 0 pass | 5 pass |
| **regression check**: 68 currently-passing String/Number/Boolean tests | 68 pass | 68 pass (0 regressions) |
| **sibling tests**: #2193 + #2175 native-proto | pass | 12/12 pass |

= **72 confirmed flips, 0 regressions.** (The corrected zero-arity `.length`
folds — `toUpperCase`/`trim`/`valueOf`/… → 0 — flipped 5 more String tests
over the initial 51.)

The remaining non-flips changed character from a hard compile refusal to a
catchable runtime `Cannot convert object to primitive value` (a
`$NativeProto` object hitting `+` string concat in test error paths) — that
is the separate #1917 ToPrimitive lane, out of scope here.

## Test

`tests/issue-2374.test.ts` — compiles `String.prototype.search` /
`String.prototype.trim.length` / `Number.prototype.toFixed.length` /
`Boolean.prototype.valueOf` value reads in `--target standalone` and asserts
they no longer refuse.
