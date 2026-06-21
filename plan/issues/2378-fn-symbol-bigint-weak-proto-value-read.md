---
id: 2378
title: "standalone: Function/Symbol/BigInt/WeakMap/WeakSet.prototype value reads refuse (~33 tests) — register $NativeProto glue (S7)"
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
related: [2377, 2376, 2375, 2374, 2193, 2175, 1907, 1888]
origin: "2026-06-19 — final clean tranche of the value-read glue lever; measure-first across the 6 remaining brands"
---

## Problem

In `--target standalone`, reading `Function.prototype.<method>` /
`Symbol.prototype.<method>` / `BigInt.prototype.<method>` /
`WeakMap.prototype.<method>` / `WeakSet.prototype.<method>` (or the bare proto)
as a **value** refuses at compile time (#1907 / #1888 S6-b).

## Root cause

`tryEnsureNativeProtoBrand` (`property-access.ts`) had no `$NativeProto` glue
for these five brands. Their brands are pre-reserved in `native-proto.ts`
`BUILTIN_BRAND_TABLE` (Function BASE+19, BigInt +23, Symbol +24, WeakMap +27,
WeakSet +28) but never got a registered member-CSV glue.

## Fix (additive — exact #2374/#2376/#2377 pattern)

- `array-object-proto.ts`: add `FUNCTION/SYMBOL/BIGINT/WEAKMAP/WEAKSET_PROTO_METHODS`
  (ES2024 §20.2.3/§20.4.3/§21.2.3/§24.3.3/§24.4.3), `Function.apply` arity 2,
  and `ensure{Function,Symbol,BigInt,WeakMap,WeakSet}NativeProtoGlue`.
- `property-access.ts`: wire five `if (builtinName === ...)` branches.

Pure additive, **no new host import**; dual-mode output unchanged. WAT
byte-identical on a green `Function.call` program (16286 bytes).

## Measure-first across the candidate brands

| brand | flips | passing-sample regression | verdict |
|-------|-------|---------------------------|---------|
| Function | 10 (of 63 CE) | 26/26 clean | take |
| WeakMap | 9 (of 70 CE) | 15/15 clean | take |
| WeakSet | 7 (of 49 CE) | 11/11 clean | take |
| Symbol | 4 (of 17 CE) | 9/9 clean | take |
| BigInt | 3 (of 11 CE) | 7/7 clean | take |
| ArrayBuffer / SharedArrayBuffer / DataView | — | — | **defer** |

**ArrayBuffer / SharedArrayBuffer / DataView excluded**: these carry the same
buffer/vec-runtime state as the TypedArray views (see **#2375**), which traps
the `$NativeProto` value-read materialization at module init. Not the additive
pattern — left for the buffer-runtime owner.

= **33 confirmed flips (Function 10 + WeakMap 9 + WeakSet 7 + Symbol 4 +
BigInt 3), 0 regressions, 0 traps.**

This **exhausts the clean additive value-read lever**: every remaining proto
brand is either already done (String/Number/Boolean/Date/Array/Object/RegExp/
Error/Map/Set + these five) or runtime-state-entangled (Promise → async lane;
ArrayBuffer/SharedArrayBuffer/DataView/TypedArray → buffer-runtime, #2375).

## Test

`tests/issue-2378-fn-symbol-bigint-weak-proto-value-read.test.ts` — 10 cases:
proto reads, `Function.apply.length`=2 arity fold, reference identity,
compile-no-refusal, and no-regression guards (instance Function.call + the
#2377 Set path).
