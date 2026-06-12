---
id: 2008
title: "tagged templates broken: cooked elements read as undefined, .raw access traps, String.raw throws (template object unusable)"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: template-literals
goal: core-semantics
related: [363, 141, 1445]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2008 — template object struct unreadable by element/property access

## Problem

```ts
function tag2(strings: TemplateStringsArray, ...vals: any[]): string {
  return "s0=" + strings[0] + ",s1=" + strings[1];
}
tag2`a${1}b`        // wasm: "s0=undefined,s1=undefined"   node: "s0=a,s1=b"
String.raw`a${1}b`  // wasm: TypeError: Cannot convert undefined or null to object
                    // node: "a1b"
```

Observed: `strings.length` → 2 (correct); `strings[0]` → undefined;
`strings.raw[0]` → `RuntimeError: illegal cast`; `[...strings]` → `[]`.
Substitution values arrive correctly.

## Root cause

`src/codegen/string-ops.ts:463-572` (`compileTaggedTemplateExpression`)
builds a 3-field template vec `{length, data, raw}`; indexed element
access / `.raw` property access / host marshaling of that struct read the
wrong representation (length survives, elements don't), so the template
object is unusable. Regression/incompleteness of #363 + #141 (both done).

## Fix direction

Make the template object an ordinary string vec with a parallel `raw` vec
(matching how arrays are read), or teach element/property access to
recognize the template struct. Cover host marshaling for String.raw.

## Acceptance criteria

- Both repros match Node; `strings.raw[i]`, `strings.length`, spread work
- Substitution values unchanged

## Dupe check

#109/#141/#363 done; #1445 (in-review) covers String.raw *argument
coercion*, not total breakage. New.

## Resolution (2026-06-12)

Root cause was a missing parameter-type mapping: `resolveWasmType`
(`src/codegen/index.ts`) had no case for `TemplateStringsArray`, so the tag
function's `strings` parameter resolved to a plain `externref`. Indexed
element access / `.length` / `.raw` / spread then operated on an opaque
externref instead of the template vec struct that
`compileTaggedTemplateExpression` actually builds.

Two changes:

1. **`src/codegen/index.ts`** — `resolveWasmType` now maps a
   `TemplateStringsArray`-symboled type to
   `{ kind: "ref_null", typeIdx: templateVecTypeIdx }` (the
   `{ length, data, raw }` struct), checked *before* the `Array`/`ReadonlyArray`
   branch (it extends `ReadonlyArray<string>`). Element access reads `data`
   (field 1), `.length` field 0, `.raw` field 2 — all via the existing vec /
   template-vec paths. The call-site coercion to externref no longer fires
   because `paramType0` is now the struct ref.

2. **`src/codegen/string-ops.ts`** — `String.raw` is detected
   (`isStringRawTag`) and lowered in-module (`compileStringRaw`) from the
   compile-time-known raw parts interleaved with stringified substitutions,
   instead of routing the WasmGC template struct through the `__tagged_template`
   host bridge (which can't index a struct from JS → the
   "Cannot convert undefined or null to object" trap). This "compiles away" and
   works without a JS runtime.

### Test Results

New `tests/issue-2008.test.ts` — 7 cases, all pass: `strings[0]`/`strings[1]`,
`strings.length`, `strings.raw[i]`, substitution values, `String.raw` with /
without substitutions, and raw backslash-escape preservation — all match Node.

Existing tagged-template tests unregressed (`tests/issue-836.test.ts` 5/5,
`tests/issue-927-safe.test.ts` 8/8, `tests/issue-1473.test.ts`). `tsc --noEmit`,
`biome lint`, `prettier --check` clean; `check:ir-fallbacks` OK.

### Residual (out of scope, pre-existing)

In `--nativeStrings`/WASI mode the template object *construction* itself fails
validation (`array.new_fixed expected externref, found struct.new of type
(ref ...)`) because the data array is declared with externref elements while
native strings are `ref $AnyString`. Confirmed identical on clean `main` — a
separate nativeStrings template-construction bug, not this issue (which is the
JS-host read path). Filing/fixing that is follow-up work.
