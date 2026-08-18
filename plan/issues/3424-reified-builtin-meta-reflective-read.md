---
id: 3424
title: "Reified builtin-value `.name`/`.length` reflective reads mis-dispatch when statics share a wrapper signature"
status: done
completed: 2026-07-28
sprint: 78
created: 2026-07-18
updated: 2026-08-18
assignee: ttraenkler/codex-es5-regexp-meta-canonicalization
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: builtins
goal: standalone-mode
related: [2963, 2933, 2896, 2984]
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
origin: "Surfaced during #2963 Tier 2a (Number.is* first-class values) by opus-dev-b, 2026-07-18"
---

# #3424 — reified builtin-value reflective `.name`/`.length` mis-dispatch across shared wrapper signatures

## Problem

Reading `.name` / `.length` off a **reified builtin static value**
(`const f: any = Number.isInteger; f.name`) mis-resolves in `--target
standalone` when **two or more statics that share the same wrapper
signature** are co-extracted in the same module. Only the **first**
registered meta closure for a given signature answers its `.name`
correctly; every subsequent one returns the wrong string (or `0`
against a string literal compare).

This is **pre-existing** (predates #2963 Phase 2) and orthogonal to the
value-body work — it lives in the reflective-read dispatch over the
builtin-fn meta subtypes, not in any closure body. #2963 Tier 2a merely
made it easier to hit by adding four more `[externref] -> i32` statics
(`Number.is*`) that share `Array.isArray`'s wrapper signature.

## Reproduction (all on `main`, `--target standalone`)

```ts
// Two externref->externref statics co-extracted — the SECOND .name is wrong:
export function a(): number {
  const g: any = Object.keys;
  return g.name === "keys" ? 1 : 0;
} // => 1
export function b(): number {
  const f: any = Reflect.ownKeys;
  return f.name === "ownKeys" ? 1 : 0;
} // => 0  (BUG)
```

```ts
// Both in one function — first ok, second wrong:
export function t(): number {
  const g: any = Object.keys; // g.name === "keys"    ✓
  const f: any = Reflect.ownKeys; // f.name === "ownKeys" ✗
  return (g.name === "keys" ? 1 : 0) * 10 + (f.name === "ownKeys" ? 1 : 0);
} // => 10  (want 11)
```

After #2963 Tier 2a the same shows for the `[externref] -> i32` family,
e.g. `Array.isArray` + `Number.isSafeInteger`, or any two `Number.is*`.

Additionally: **`.length` reads `0` for EVERY wired reified static**
(Math.max, Array.isArray, Reflect.get, Number.is\* — verified), even in a
single-value module where `.name` is correct. So `.length` reflective
reads on reified builtin values are broadly unimplemented in standalone,
distinct from the multi-value `.name` collision above.

## Root-cause hypothesis

The per-`(builtin, method)` meta type is a distinct **subtype of the
shared wrapper struct** (`ensureBuiltinFnMetaType`, `builtin-fn-meta.ts`
— cache key `static:<Builtin>.<method>`, correct). The value is a
module-level singleton (`pushBuiltinFnSingletonValueInstrs`). The
**runtime `.name` reader** appears to dispatch on the wrapper BASE type
(or `ref.test`s the registered meta subtypes in registration order and
stops at the first that a sibling also satisfies), so it returns the
first-registered sibling's metadata rather than the value's own exact
subtype. `.length` returns `0` because the reflective length read isn't
wired to the meta subtype's `length` field at all in standalone.

## Acceptance criteria

- `f.name` correct for EVERY reified static regardless of how many
  same-signature statics are co-extracted (multi-value modules).
- `f.length` returns the spec arity (`STANDALONE_STATIC_METHOD_META` /
  `BUILTIN_STATIC_METHOD_ARITY`) for every wired reified static.
- Test: multi-value module extracting ≥3 same-signature statics, asserting
  each `.name`/`.length`.
- Byte-inert on host/gc lanes (standalone-gated); emit-identity corpus
  IDENTICAL.

## Notes

Investigate the property-access reflective-read path for builtin-fn meta
values (`property-access.ts`, `builtin-fn-meta.ts` `builtinFnMetaByTypeIdx`)
— specifically how the exact meta subtype of an `any`-typed reified value
is recovered at runtime (a chain of `ref.test`s against every registered
meta subtype, most-derived first, is the sound shape).

## Resolution (2026-07-28)

PR #3646 had already fixed the shared-wrapper `.name` collision by adding an
immutable exact builtin-function identity to every metadata closure. A fresh
current-main audit therefore narrowed the remaining gap to `.length`: the
standalone `any`/`unknown` property-access path bypassed
`__builtinfn_get_meta` and always called the array-like `__extern_length`
helper, which returns `0` for closure values.

The standalone-only numeric length reader now:

1. guards the reified value against the common closure-wrapper root;
2. asks the finalize-filled `__builtinfn_get_meta(value, "length")` helper for
   the exact identity's spec arity;
3. preserves the prior `0` result for a plain user closure or a deleted
   builtin `length`; and
4. keeps the native-string and generic array/object fallbacks unchanged.

Regression coverage co-extracts six builtins across two shared wrapper
signatures, including four `[externref] -> i32` values, and asserts every
`.name`, every `.length`, deletion semantics, and zero host imports.

The fixed RegExp getter matrix remains 30/34. Its four current-main failures
(`dotAll`/`unicodeSets`/`hasIndices` own-property descriptors and the
`unicodeSets` boolean value) are distinct descriptor/value roots and are not
claimed by this metadata canonicalization slice.
