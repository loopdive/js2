---
id: 1910a
title: "standalone boxed primitive-wrapper ToPrimitive (new Number/String/Boolean)"
status: done
sprint: 63
created: 2026-06-17
updated: 2026-06-17
completed: 2026-06-17
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, type-coercion, object-runtime
language_feature: to-primitive, wrapper-objects, abstract-operations
goal: standalone-mode
related: [1910, 1472, 1900, 1806, 2042]
parent: 1910
test262_bucket: object-to-primitive
assignee: ttraenkler/sdev-standalone
---

# #1910 S2 — Standalone boxed primitive-wrapper ToPrimitive

Sub-issue of #1910 (ToPrimitive family), slice **S2** of the #1472 standalone
dynamic-object/Reflect decomposition (arch spec in
`plan/issues/1472-no-js-host-object-property-ops.md`, "## Implementation Plan —
S2"). The single biggest pass-rate lever in the four #1472 buckets
(~600–750 `object-to-primitive` rows).

## Problem (root cause)

`new Number(x)` / `new String(x)` / `new Boolean(x)` produce wrapper OBJECTS
(`typeof === "object"`). In `--target standalone` the call sites
(`src/codegen/expressions/new-super.ts`, `calls.ts`) lowered them to
`ensureLateImport(ctx, "__new_Number"|"__new_String"|"__new_Boolean", …)` — a
JS-host import with **no standalone fallback** and **not** in
`STANDALONE_REFUSED_IMPORT`. So the binary leaked `env::__new_Number` and failed
at instantiation:

```
TypeError: WebAssembly.instantiate(): Import #0 "env": module is not an object or function
```

It never even reached `__to_primitive` — construction itself was unsatisfiable.
Even once constructed, the native `__to_primitive` (object-runtime.ts) handles
plain `$Object` (`"[object Object]"`) but a wrapper has an internal
`[[NumberData]]`/`[[StringData]]`/`[[BooleanData]]` slot whose intrinsic
`valueOf`/`toString` must return that primitive; standalone ships no
`Number.prototype.valueOf`, so it fell through every arm to `throwTypeError`.

## Fix (representation: Option 1 — `$Object` + internal slot)

The architect offered two reps. I chose **Option 1** (slot in a `$Object`), NOT
Option 2 (dedicated `$BoxedPrimitive` brand), because:

- The `$Object` struct is **closed/final** — an earlier #1100/#2009 attempt to
  open it for `$Proxy` subtyping triggered WasmGC iso-recursive canonicalization
  bugs. A separate brand struct would NOT pass `ref.test $Object`, so a wrapper
  could not reuse the existing `__extern_get`/`__obj_find` machinery for member
  access (`w.toString`, `w.x = 5`, future indexed reads). Keeping the wrapper a
  `$Object` preserves all of that for free — verified: `new Number(1)` works as a
  property bag (`w.x = 5; w.x === 5`) and the internal slot survives.
- Minimal blast radius: three new native constructors + one slot-read at the top
  of `__to_primitive`. No new types, no struct-layout change, no index-shift.

### Changes

1. **`src/codegen/object-runtime.ts`**
   - `FLAG_INTERNAL = 0x10` (`$PropEntry.flags`, was free) + exported
     `WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]"` (spec internal-slot spelling,
     non-enumerable so enumeration never sees it).
   - `__new_Number(f64)` / `__new_String(externref)` / `__new_Boolean(f64)` →
     `externref`: build a `$Object`, insert the (already-boxed) primitive under
     `WRAPPER_PRIMITIVE_KEY` via `__obj_insert(o, key, value, FLAG_INTERNAL, 0)`.
     Number boxes the f64 via `__box_number`; Boolean computes ToBoolean
     `(x != 0) & (x == x)` then `__box_boolean`; String stores the externref
     directly. Added all three to `OBJECT_RUNTIME_HELPER_NAMES`, so the existing
     `ensureLateImport` routing (`late-imports.ts` L361) maps the call sites to
     the native funcs under `ctx.standalone` with **zero call-site edits**.
   - `__to_primitive`: after confirming `ref.test $Object`, `__obj_find(o,
     WRAPPER_PRIMITIVE_KEY)` and, when a `FLAG_INTERNAL` entry exists, return
     `extern.convert_any(entry.value)` FIRST (§7.1.1.1 — the intrinsic
     valueOf/toString resolve to the internal slot). Returning the raw primitive
     is hint-agnostic-correct: the slot value is already a primitive, and the
     caller applies the final ToNumber/ToString per its own hint. Plain objects
     lack the slot → null → fall through to OrdinaryToPrimitive (unchanged).

2. **`src/codegen/native-strings.ts`** (`ensureAnyToStringHelper`)
   - The generic externref→`$AnyValue` boxing tags EVERY externref as tag-5
     (string) — see `value-tags.ts:185`, deliberately kept for the #1888
     comparator. So a wrapper `$Object` reaches `__any_to_string`'s tag-5 arm,
     where the raw `ref.cast $AnyString` TRAPPED ("illegal cast"). Now the tag-5
     arm tests `ref.test $AnyString` first; for a non-string externref it routes
     through `recoverNonStringExtern`: if `ref.test $Object`, reduce via
     `__to_primitive` (registered BEFORE this helper bakes — no intervening
     shift), then stringify the recovered boxed primitive
     (`$AnyString`/`$__box_number_struct`/`$__box_boolean_struct`). Converts a
     hard Wasm trap into correct/lenient behaviour.

## Validation

- `tests/issue-1910-s2.test.ts` (10 tests, all green): no `__new_*` host import
  leak; `new Number(1) % "1" === 0`; ToNumber over Number/String wrappers via
  `-`/`*`/`%`; the full §11.13.2_A4.3 modulo-assignment matrix (8/8, the cited
  `compound-assignment/S11.13.2_A4.3_T2.2.js`); `String(new Number(n))` decimal;
  `String(new String(s))`; internal slot non-enumerable (`Object.keys(w)` empty);
  `typeof w === "object"`; wrapper-in-`__any_to_string` no longer traps.
- No regressions: `tests/issue-1472.test.ts` (52 pass / same 8 pre-existing
  fails on clean main); gc-mode coercion equivalence — `object-to-primitive`,
  `tostring-valueof`, `string-arithmetic-coercion`, `comparison-coercion`,
  `compound-assignment-coercion`, `symbol-toPrimitive`, `issue-1134-string-number`
  (55/55), plus `string-methods`, `template-literals-extended`,
  `template-literal-type-coercion`, `json-stringify`, `bigint-string-coercion`,
  `number-statics` (77/77); `native-strings*` (105/106, the 1 fail pre-existing
  and Symbol-message-only); `issue-1900` (4/5, the 1 fail pre-existing, Symbol
  message reference, unrelated). `tsc --noEmit` clean, `biome lint` clean,
  prettier clean.

## Known-pre-existing, OUT OF S2 scope (separate bugs)

- **`__any_add` any+any string concat** returns an EMPTY string for every
  any+any concat (e.g. `("a" as any) + ("b" as any)` length 0 on clean main).
  S2 only stops the wrapper-in-that-path TRAP; it does not fix the concat itself.
- **`__unbox_number`(boolean)** — `(true as any) + 0` → NaN/null on clean main
  (ToNumber of a boxed boolean unsupported). Affects `new Boolean(x)` in
  arithmetic; the wrapper construction + slot are correct, the downstream
  numeric coercion of a boolean is the gap. Not in the S2 acceptance signatures.
