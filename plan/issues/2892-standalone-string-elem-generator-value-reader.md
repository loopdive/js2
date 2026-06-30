---
id: 2892
title: "Standalone: string-ELEM native generator `.next().value as string` mis-types the result value (typeIdx mismatch) — fails wasm validation"
status: ready
created: 2026-06-30
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: Backlog
horizon: m
related: [2864, 2171]
umbrella: 2860
---

# Standalone: string-elem generator result `.value` read fails wasm validation

## Problem

A native generator whose yields are all **strings** (the #2171 native-string
carrier) compiles, but reading its result `.value` as a string in
`--target standalone` fails wasm validation:

```
WebAssembly.compile(): Compiling function #N:"test" failed:
type error in fallthru[0] (expected (ref null 40), got (ref null 35))
```

### Reproduction (current main, surfaced during #2864 F1b)

```ts
function* g() {
  yield "aa";
  yield "bbb";
}
export function test(): number {
  let it = g();
  let a = (it.next().value as string).length;
  let b = (it.next().value as string).length;
  return a + b;
}
```

Compiles with **zero host imports** but throws `CompileError` at instantiate —
the produced result-struct `value` field type (`ref null 35`) does not match the
type the consumer reads it back at (`ref null 40`). Both are native-string-ish
vec/array refs, but at different type indices.

This is **independent of spills** — it reproduces with a zero-spill string
generator (`yield "aa"; yield "bbb"`), so it is NOT the #2864 F1b spill-typing
path. It is in the #2171 string-carrier open result reader
(`tryCompileNativeGeneratorResultProperty` / `ensureNativeGeneratorResultType`),
where the `value` field's native-string ref typeIdx is minted differently from
the typeIdx the `.value` extraction coerces to.

## Root cause (suspected)

The string-elem generator's result struct `value` field is registered at one
native-string array/vec typeIdx, while the `.value` property read resolves the
expected string type to a _different_ registered native-string typeIdx (e.g. the
`$AnyString` ref vs a `__vec_<elem>` ref, or two separately-registered array
types for the same element). The two must resolve to the **same** reserved
typeIdx (reserve-once, like the F1 result-struct singleton per elem type).

## Where to look

- `src/codegen/generators-native.ts`:
  - `ensureNativeGeneratorResultType` (per-elem result struct minting),
  - `tryCompileNativeGeneratorResultProperty` (the open `.value`/`.done` reader),
  - `defaultElemValueInstr` / `genCarrierFieldType` for the string carrier.
- Cross-check against the native-string type registration
  (`native-strings.ts` `nativeStringType`, `getOrRegisterArrayType` /
  `getOrRegisterVecType`) — the result `value` field and the consumer read must
  share one reserved typeIdx.

## Test plan

Standalone CE/validation-fail → pass:

- `function* g(){ yield "a"; yield "b" }` read via `.next().value` (length / `===`).
- string-elem generator consumed via `for-of` (verify it already works — the
  for-of reader may use a different path than `.next().value`).
- `test/language/statements/generators/**` string-yield cases.

gc (JS-host) mode unchanged. Full `merge_group`.

## Notes

Surfaced while implementing #2864 F1b (typed spills). F1b deliberately scoped
AROUND this: F1b enables string LOCAL spills in _numeric_-elem generators (which
work), and string-elem generators with spills inherit this pre-existing reader
bug regardless of spilling.
