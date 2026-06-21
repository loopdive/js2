---
id: 2377
title: "standalone: Error/Map/Set.prototype.<method> built-in static-property value reads refuse (~47 tests) — register $NativeProto glue (S6)"
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
related: [2376, 2375, 2374, 2193, 2175, 1907, 1888]
origin: "2026-06-19 — extending the #2374/#2376 value-read glue; measure-first across Error/Map/Set/Promise, took the three clean ones"
---

## Problem

In `--target standalone`, reading an `Error.prototype.<method>` /
`Map.prototype.<method>` / `Set.prototype.<method>` (or the bare proto) as a
**value** refuses at compile time:

```
Codegen error: <Builtin>.prototype built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

## Root cause

`tryEnsureNativeProtoBrand` (`property-access.ts`) wired the `$NativeProto`
glue only for String/Number/Boolean (#2374) / Date (#2376) / Array/Object
(#2193) / RegExp (#2175). The Error/Map/Set brands are **pre-reserved** in
`native-proto.ts` `BUILTIN_BRAND_TABLE` (BASE+33/25/26) but never got a
registered member-CSV glue.

## Fix (additive — exact #2374/#2376 pattern)

- `array-object-proto.ts`: add `ERROR_PROTO_METHODS` (ES2024 §20.5.3),
  `MAP_PROTO_METHODS` (§24.1.3), `SET_PROTO_METHODS` (§24.2.3 + set-method
  proposal), `set: 2` arity, and `ensure{Error,Map,Set}NativeProtoGlue`.
- `property-access.ts`: wire three `if (builtinName === ...)` branches.

Pure additive, **no new host import**; dual-mode output unchanged. WAT
byte-identical on a green Set program (17832 bytes, identical with vs without
the glue).

## Measure-first across the candidate brands (the gate matters)

All four S6 candidate protos were wired and measured before committing:

| brand | flips | passing-sample regression | verdict |
|-------|-------|---------------------------|---------|
| Set | 27 (of 157 CE) | 20/20 clean | **take** |
| Map | 16 (of 82 CE) | 22/22 clean | **take** |
| Error | 4 (of 14 CE) | 3/3 clean | **take** |
| Promise | 11 (of 30 CE) | **runtime null-pointer deref in a passing test** | **DROP** |

**Promise excluded**: its proto glue introduced a runtime null-pointer
dereference in a previously-passing Promise test — the async-capability
runtime state collides with the value-read materialization (the Promise analog
of the TypedArray module-init trap in **#2375**). Deferred to a dedicated
investigation in the async lane (#1042/#1326).

= **47 confirmed flips (Set 27 + Map 16 + Error 4), 0 regressions, 0 traps.**

## Test

`tests/issue-2377-error-map-set-proto-value-read.test.ts` — 9 cases: proto
reads, `.length` arity folds (Map.set=2, Set.add=1), reference identity,
compile-no-refusal, and no-regression guards (instance Set methods + the #2376
Date path).
