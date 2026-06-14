---
id: 2007
title: "array operand in string concatenation traps 'illegal cast' — '+' never routes vecs through ToPrimitive/join"
status: done
completed: 2026-06-14
sprint: 63
created: 2026-06-10
updated: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1969, 1997, 1988]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2007 — struct-ref concat path can't handle WasmGC vec refs

## Problem

```ts
const arr = [1, 2];
"a=" + arr   // wasm: RuntimeError: illegal cast   node: "a=1,2"
```

## Root cause

`src/codegen/string-ops.ts:1503-1508` — struct-ref operands route through
`coerceType(..., externref, "string")`, but the ToPrimitive dispatch path
doesn't handle WasmGC array/$Vec refs (unguarded `ref.cast` in
`src/codegen/type-coercion.ts`), so arrays never reach
Array.prototype.toString/join.

## Fix direction

Detect vec refs in the concat coercion and emit the join path (ties into
#1997 array toString and #1996 host bridge vec recognition).

## Acceptance criteria

- Repro returns "a=1,2"; nested arrays follow join semantics

## Dupe check

#1090/#1806 cover "cannot convert object to primitive" for plain structs;
#1969 is concat-the-method, not `+`. New.

## Resolution (2026-06-14, dev-a)

**js-host mode was already fixed** (by #2022 `+` ToPrimitive ordering + #1997
Array.join element coercion). The remaining gap was **standalone / native-strings
mode**, where `"" + [1,2]` returned `"[object Object]"` (length 15): the
`$__any_to_string` walker tested `$AnyString` → `$AnyValue` (tag) → else
`"[object Object]"`, and a vec ref matched neither.

### Fix (final — inline lowering, after a CI-caught rework)

The first attempt mutated the shared `$__any_to_string` helper for ALL callers
(`patchAnyToStringVecArm`) and emitted cached `__vec_join_*` helpers that baked
cross-function call indices. Both interacted badly with the `addUnionImports`
late index shift (CLAUDE.md hazard): a shift between baking a `call funcIdx` and
attaching a not-yet-pushed helper body left the index stale →
**standalone net −7755 (`wasm_compile +7755`)** in CI (PR #1448 first push). It
was reverted to:

`src/codegen/native-strings.ts`:
- `tryCompileNativeVecConcatOperand(ctx, fctx, vecValType)` — the call-site
  entry, now emits the Array.prototype.join lowering **inline into `fctx.body`**
  (the proven `compileArrayJoinNative` pattern). `number_toString` /
  `__str_concat` indices live in the current function body, which the late
  shift always walks — so no stale index. Numeric elements →
  `number_toString`; native-string elements → passthrough; nested-vec elements
  → the cached per-vec join helper (`[[1,2],[3]]` → `"1,2,3"`).
- `ensureNativeVecJoinHelper(...)` — retained ONLY for nested-vec element
  recursion (closure-free literal context, where its indices are consistent).
- It **bails to `$__any_to_string`** (the baseline `"[object Object]"`) when
  `fctx.emittedClosureArrayMethod` is set (a `map`/`filter`/… already lowered in
  this function) — that case hits a **pre-existing** array-join/closure index
  hazard (`a.join(",")` fails it on baseline too) and is out of scope; bailing
  keeps the baseline result so there is no regression.

`src/codegen/array-methods.ts`: `compileArrayMethodCall` sets
`fctx.emittedClosureArrayMethod = true` for the closure-allocating methods.

`src/codegen/context/types.ts`: new `emittedClosureArrayMethod?: boolean` flag.

`src/codegen/string-ops.ts`: `compileNativeConcatOperand` (standalone `+`) and
`compileNativeTemplateExpression` (template span) try the inline vec path before
the `tryStructToString` / `$__any_to_string` fallthrough.

### Test results (standalone)

`tests/issue-2007.test.ts` — 10/10 pass: `"" + [1,2]` → `"1,2"`,
`"a=" + [1,2]` → `"a=1,2"`, floats, `string[]`, single, empty `→ ""`, nested
`[[1,2],[3]]` → `"1,2,3"`, template `` `v=${[1,2,3]}` `` → `"v=1,2,3"`, zero host
imports, and "array concat coexists with a closure array method (valid
module)". No regressions: `issue-2074` (12), `issue-2022` (7),
`issue-1539-standalone-array-coercion` (3), `native-strings-roundtrip` (7) all
pass; broad standalone `__any_to_string`/concat sample (objects, `any` concat,
templates, `String()`, `===`, loop `+=`) all emit valid modules.
