---
id: 2014
title: "numeric-key element access on any-typed object returns undefined though the property exists (o[2] vs o['2'])"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: host-interop
language_feature: objects
goal: core-semantics
related: [1971, 140]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2014 — __extern_get_idx struct fallback misses object-literal numeric fields

## Problem

```ts
const o: any = { 2: "two" }; const i = 2;
o[2] + "," + o[i] + "," + o["2"]
// wasm: "undefined,undefined,two"   node: "two,two,two"
```

Spec: numeric and string keys are the same property (§6.1.7 ToPropertyKey).

## Root cause

`src/runtime.ts:5217` — `__extern_get_idx`'s WasmGC-struct fallback relies
on `__sget_<name>` getter exports that aren't emitted for object-literal
numeric fields; the string-key path goes through `__extern_get`/`_safeGet`
field-name lookup, which works. Numeric keys route to the idx import,
string keys to the working one.

## Fix direction

In `__extern_get_idx`, fall back to the field-name lookup with
`String(idx)` for struct receivers (or emit `__sget_<n>` exports for
numeric fields).

## Acceptance criteria

- All three accesses return "two"; array indexing unchanged

## Dupe check

#140 (done, computed property names); #1971 item 1 covers computed-key
*creation*. New.

## Investigation (2026-06-11, dev-spec-b2) — harder than rated; runtime line ref is stale

The issue's `src/runtime.ts:5217` line ref is stale (that's Temporal code now).
`__extern_get`'s `__sget_<key>` fallback is at ~`runtime.ts:6093` and IS
string-only, but **fixing it there does NOT fix the repro** — and the
`__sget_` fallback is never even reached for the working `o["2"]` either.

Traced behaviour (all three accesses have `objType === externref` and
`compileElementAccessBody` emits a `__extern_get` call):
- `o["2"]` → `__extern_get(struct, "2")` → returns "two" via the handler's TOP
  guard (`getPrototypeOf(obj) !== null && "2" in Object(obj)` → `obj["2"]`).
- `o[2]` / `o[i]` → key boxes as a JS **number** 2. **`__extern_get` is never
  called with the struct receiver** for the numeric key (instrumenting the
  handler's top guard logged nothing for `number:2`). Yet `_safeGet` DOES see
  `number:2` — but with `_isWasmStruct(obj) === false`, i.e. a *different*,
  non-struct receiver.

So the numeric-key path transforms the receiver before the host call (a numeric
element-access fast path appears to box/convert the any-struct receiver to a
non-struct value, so the struct field is unreachable). The string-key path
keeps the struct receiver and resolves via the host `in`/`obj[key]` guard.

Root cause is therefore in the **numeric element-access codegen routing**
(`compileElementAccessBody` / a numeric-index fast path), NOT a one-line
runtime `__sget_` tweak. Needs a codegen-side investigation of how `o[<number>]`
on an externref/any receiver differs from `o[<string>]`. **Recommend treating
as medium-hard codegen, not an easy runtime patch.**

(Note: the paired #2010 is essentially fixed upstream — only `{ x, ...null }`
with a *leading shorthand* + error-typed spread still drops `x`, because that
shape routes to `compileObjectLiteralForStruct` via inferred-type, not the
externref fallback. See #2010 file.)
