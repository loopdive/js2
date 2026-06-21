---
id: 2376
title: "standalone: Date.prototype.<method> built-in static-property value reads refuse (~82 tests) — register $NativeProto glue (S5)"
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
language_feature: builtins, reflection, date
goal: standalone-mode
related: [2374, 2375, 2193, 2175, 1907, 1888]
origin: "2026-06-19 — extending the #2374 value-read glue to the next builtin proto (Date)"
---

## Problem

In `--target standalone`, reading a `Date.prototype.<method>` (or bare
`Date.prototype`) as a **value** — not invoking it — refuses at compile time:

```
Codegen error: Date.prototype built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

This is the next-biggest clean, non-representation-gated standalone-CE cluster
after #2374 (203 host-pass/standalone-CE in `built-ins/Date/prototype`, of
which 49/50 sampled are this exact static-read refusal). It fires on idioms
like:

```js
Date.prototype.setUTCFullYear.length;   // arity meta read (=> 3)
var f = Date.prototype.getFullYear;     // method value read
Date.prototype.toISOString.call(...);   // captured-method invocation
```

## Root cause

`tryEnsureNativeProtoBrand` (`property-access.ts`) wired the `$NativeProto`
glue only for String/Number/Boolean (#2374) / Array/Object (#2193) / RegExp
(#2175). The Date brand is **pre-reserved** in `native-proto.ts`
`BUILTIN_BRAND_TABLE` (BASE+31) but never got a registered member-CSV glue, so
the value read falls through to `reportUnsupportedStandaloneBuiltinValueRead`.

## Fix (additive — exact #2374 pattern)

- `array-object-proto.ts`: add `DATE_PROTO_METHODS` (ES2024 §21.4.4 — all the
  get*/set*/to* methods), spec arities for the differing members
  (`setFullYear`/`setUTCFullYear` 3, `setHours`/`setUTCHours` 4, the 0-arity
  getters/conversions), and `ensureDateNativeProtoGlue` (same body as
  `ensureStringNativeProtoGlue`).
- `property-access.ts`: wire one `if (builtinName === "Date")` branch into
  `tryEnsureNativeProtoBrand`.

Pure additive, **no new host import**; dual-mode (host/WASI) output untouched.
Unlike the TypedArray concrete-view brands (see **#2375**, which trap at module
init), the Date brand carries no vec/runtime entanglement, so the proto-object
materialization is clean (verified: 0 init-traps). Reflective member-CLOSURE
bodies still degrade to a catchable TypeError (PR-A scope, parity with
String/Array) until per-member native bodies land.

## Measured flips (patched standalone runner, real test262 harness)

| set | before | after |
|-----|--------|-------|
| built-ins/Date/prototype CE (203) | 0 pass | 82 pass |
| regression check: 58 currently-passing Date tests | 58 pass | 58 pass (0 regressions) |

= **82 confirmed flips, 0 regressions.** WAT byte-identical on a green
Date-method program (`new Date` + getFullYear/getMonth/getDate/setFullYear →
17726 bytes, identical with vs without the glue), confirming purely additive.

The remaining non-flips are clean runtime asserts and the separate
`Symbol.toPrimitive` well-known-symbol value-read sub-cluster (out of scope —
that is the WKS value-read lane, not Date proto).

## Test

`tests/issue-2376-date-proto-value-read.test.ts` — 8 cases: proto-object read,
`.length` arity folds (setUTCFullYear=3, getTime=0, setHours=4), reference
identity, compile-no-refusal of the bare method-value read, and no-regression
guards (instance Date methods + the #2374 String path).
