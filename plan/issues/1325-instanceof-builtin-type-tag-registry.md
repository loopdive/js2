---
id: 1325
title: "instanceof against built-in types: compile-time type-tag registry eliminates JS host for common cases"
status: ready
created: 2026-05-07
updated: 2026-07-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: instanceof
goal: standalone-mode
sprint: Backlog
# (#1325 Date/RegExp slice) the Date/RegExp cases land in
# `nativeBuiltinInstanceOfTypeIdxs`, which lives in the instanceof god-file;
# +17 LOC for the two switch cases + imports is the fix itself, not barrel spill.
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
---
# #1325 — instanceof built-in type-tag registry

## Problem

`x instanceof Array`, `x instanceof Error`, `x instanceof RangeError` etc. currently
fall back to JS host for any `externref` value (the compiler can't check prototype chain
without a JS host). This breaks standalone mode for any program using `instanceof` on
built-in types.

For *local classes* (user-defined TypeScript classes), `instanceof` is already pure Wasm
— it reads the `__tag` i32 field and compares against a tag set. The same approach can
be extended to built-in types.

## Strategy

1. Extend the **type-tag enum** in `src/ir/lower.ts` / `src/ir/nodes.ts` to include entries
   for built-in types: `TAG_ARRAY`, `TAG_ERROR`, `TAG_RANGE_ERROR`, `TAG_TYPE_ERROR`,
   `TAG_SYNTAX_ERROR`, `TAG_URI_ERROR`, `TAG_EVAL_ERROR`, `TAG_REF_ERROR`, `TAG_MAP`,
   `TAG_SET`, `TAG_DATE`, `TAG_REG_EXP`, etc.
2. At construction time (when the IR emits `new Array(...)`, `new Error(...)`, etc.),
   tag the resulting struct/externref with the appropriate type tag.
3. For `x instanceof BuiltIn`, emit a pure Wasm tag comparison instead of a JS host call:
   - If `x` is a WasmGC struct, check `struct.get $__tag == TAG_BUILTIN`
   - If `x` is an externref (from JS host), keep the JS fallback
4. For `Error` subclasses: since thrown exceptions are already boxed into `__exn_tag`-tagged
   externrefs, annotate the exception struct with the Error subclass tag at throw time.

## Coverage

This handles the most common `instanceof` patterns in library code:
- `if (x instanceof Array)` — check for array-typed args
- `if (err instanceof TypeError)` — error type narrowing in catch
- `if (x instanceof Map)` — built-in collection type checking

For user-defined classes and prototype-manipulated objects, the existing JS fallback remains.

## Acceptance criteria

1. `[] instanceof Array` → `true` in standalone mode (no JS host call)
2. `new TypeError("x") instanceof Error` → `true`, `instanceof TypeError` → `true`
3. `{} instanceof Array` → `false`
4. Test262: `test/built-ins/*/Symbol.hasInstance/` — no regressions

## Files

- `src/ir/nodes.ts` / `src/ir/lower.ts` — extend type-tag enum with built-in entries
- `src/ir/lower.ts` — tag at construction sites, emit tag-test at instanceof sites
- `src/runtime.ts` — keep JS fallback for externref values only
- `tests/issue-1325.test.ts`

## Phase 1 implementation (2026-05-08)

Phase 1 lays the groundwork by adding the registry and the static-elimination
fast paths. It does not yet write tags into WasmGC structs (Phase 2).

### What landed

- `src/codegen/builtin-tags.ts` — new module with:
  - `BUILTIN_TYPE_TAGS` — reserved negative-integer tag values for Array,
    Function, Object, Error and the *Error subclasses, Map, Set, WeakMap,
    WeakSet, Date, RegExp, Promise, ArrayBuffer, SharedArrayBuffer, DataView.
    Negative so they can never collide with user class tags (which start at 0
    via `ctx.classTagCounter`).
  - `isBuiltinTypeName`, `getBuiltinParent`, `isBuiltinSubtype` — registry
    lookup helpers, including the *Error → Error parent chain.

- `src/codegen/expressions/identifiers.ts` — `compileHostInstanceOf` now
  attempts a `tryStaticInstanceOf` short-circuit before falling through to
  the `__instanceof` host import:
  - LHS TS symbol resolves to a known **user class** + RHS is a built-in
    → emit `i32.const 0` (a struct can never be a JS built-in).
  - LHS TS symbol resolves to a built-in `Child` and RHS is `Parent` →
    emit `i32.const 1` if `isBuiltinSubtype(Child, Parent)`, else `false`.
  - LHS TS type is `number` / `boolean` → emit `false` (primitives are
    never `instanceof` of an object constructor).
  - Fallback to the existing host-import path otherwise.
- Stack-level fast path also added: when LHS compiled value is `i32` /
  `f64`, drop and emit `i32.const 0` (saves boxing + a host call).

### Tests (`tests/issue-1325.test.ts`, 13 cases)

Registry unit tests:
- All built-in names recognised
- Tag values are negative
- *Error → Error parent chain encoded
- `isBuiltinSubtype` hierarchy reasoning + unknown-name guards

End-to-end behavioural tests:
- `123 instanceof Array` → `false` (numeric primitive LHS)
- `(userClassInstance) instanceof Array` → `false`
- `(userClassInstance) instanceof Error` → `false`
- User-class hierarchy `instanceof` regression check (Dog/Animal)
- `new TypeError() instanceof Error` → `true`
- `[] instanceof Array` → `true` (host-fallback regression)
- `{} instanceof Array` → `false` (host-fallback regression)

### Out of scope for Phase 1 (deferred to a follow-up)

- Tagging WasmGC wrapper structs at construction time. This requires either
  switching to WasmGC structs for Error/Array/Map (a large refactor), or
  introducing a `$ThrownException` wrapper struct for the throw/catch path
  so `catch (e) { e instanceof TypeError }` works without a JS host.
- Integration with the IR `__tag` field in `src/ir/lower.ts` /
  `src/ir/nodes.ts`. The Phase-1 registry is consumed by the codegen
  short-circuit only; IR-level wiring will follow once a tagged-struct
  representation lands.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).

## Progress (2026-07-24, dev-std-3) — headline cases verified done + Date/RegExp slice landed

**Verify-first re-measure against current main (the #2148 note vindicated).** The
headline acceptance criteria are ALREADY MET on main — all host-free, no
`__instanceof` import:

- `[] instanceof Array`, `{} instanceof Array === false`
- `new TypeError() instanceof Error` / `instanceof TypeError`
- `catch (e) { e instanceof TypeError }`, `new Error() instanceof Error`
- `new Map()/Set()/WeakMap()/WeakSet() instanceof <same>`

The mechanism for a **dynamic (`any`-typed / opaque function-param) LHS** in
standalone is `nativeBuiltinInstanceOfTypeIdxs` (`expressions/identifiers.ts`,
#2916): it maps a builtin ctor name → the WasmGC struct type idx of its native
representation and `emitNativeInstanceOfMembership` answers via `ref.test`
(host-free). A statically-typed LHS is already covered by `tryStaticInstanceOf`.

**This slice adds `Date` and `RegExp`** to that map — both lower to distinct
WasmGC structs standalone (`$__Date`, one i64 field; `$__StandaloneRegExp`), so
`ref.test` against their (idempotent, type-only registered) struct type answers
`x instanceof Date` / `x instanceof RegExp` host-free even for a dynamic LHS.
Measured flips (fail→pass, all host-free, zero false positives — negatives like
`{} instanceof Date`, `Date instanceof RegExp`, `123 instanceof Date` stay
`false`):

- `const d: any = new Date(); d instanceof Date` — was `0`, now `1`
- `function f(d:any){return d instanceof Date} f(new Date())` — was `0`, now `1`
  (cross-function opaque param; the runtime `ref.test` path)
- `const r: any = /a/ | new RegExp("a"); r instanceof RegExp` — was `0`, now `1`
- opaque-param RegExp — was `0`, now `1`

Host/gc mode is untouched (the branch is `noJsHost`-gated → byte-identical).
Tests: `tests/issue-1325.test.ts` (new standalone describe block, 11 cases).

## Progress (2026-07-24, dev-std-3, slice 2) — Promise landed; per-rep map measured

`Promise` added to `nativeBuiltinInstanceOfTypeIdxs` via
`getOrRegisterPromiseType` (the distinct `$Promise` struct — state/value/
callbacks; exported, idempotent, type-only). Flips `p instanceof Promise` 0→1
host-free for a dynamic LHS (`Promise.resolve(1)`, `new Promise(...)`,
cross-function opaque param); 5 negatives stay false (no false positives:
`{} instanceof Promise`, `Date instanceof Promise`, `123`, `Promise instanceof
Date`, `[]`). `noJsHost`-gated → host/gc byte-identical. Tests:
`tests/issue-1325.test.ts` (+6 Promise cases, 30 total).

**Measured per-rep map for the rest (verify-first, 2026-07-24) — the remaining
types are NOT contained `ref.test` slices; they are value-rep substrate:**

| type | rep | verdict |
| --- | --- | --- |
| `Date` | distinct `$__Date` struct | ✅ landed (#3547) |
| `RegExp` | distinct `$__StandaloneRegExp` struct | ✅ landed (#3547) |
| `Promise` | distinct `$Promise` struct | ✅ landed (this slice) |
| `ArrayBuffer` | **byte `$Vec`** (shared with plain arrays / DataView — `dataview-native.ts:17,3422`) | ❌ substrate — `ref.test $Vec` false-positives on arrays/DataView; needs a brand field |
| `DataView` | **byte `$Vec`** (same pun) | ❌ substrate — same shared-`$Vec` imprecision |
| `Int8Array`…`BigUint64Array` | **shared `$__ta_view`** (length/buf/byteOffset, NO kind field) | ❌ substrate — one struct for all TA kinds; `int8 instanceof Uint8Array` can't be distinguished until a kind brand lands (#2893/#2872) |
| `Map`/`Set`/`WeakMap`/`WeakSet` (opaque LHS) | shared `$Map` backing | ❌ substrate — pass only via static-type path; runtime `ref.test $Map` is cross-collection imprecise |
| `Object` (universal) | any GC struct incl. native strings | ❌ needs struct-minus-string-minus-boxed discriminator (Slice-A #2916 deferral) |
| `Function` (closure LHS) | closure struct | ❌ currently **traps** — needs a guarded cast |

**Conclusion:** every distinct-struct builtin (Date/RegExp/Promise) is now
host-free; the residual is uniformly blocked on a **per-rep brand** for
struct-sharing families (ArrayBuffer/DataView/TypedArray/Map-Set) — value-rep
substrate, not a dev-sized `nativeBuiltinInstanceOfTypeIdxs` case. Route the
brand work with #2893/#2872 (TypedArray) and the collection value-rep track.
