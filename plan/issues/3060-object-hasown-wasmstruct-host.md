---
id: 3060
title: "Object.hasOwn(structLiteral, key) returns false in host mode — __object_hasOwn host import skips wasm-struct marshalling (~24 default-lane fails)"
status: done
created: 2026-07-06
updated: 2026-07-06
completed: 2026-07-06
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: object-hasown
es_edition: 2022
goal: spec-completeness
sprint: current
horizon: s
test262_category: built-ins/Object/hasOwn
test262_fail: 24
related: [965, 2130]
---

# #3060 — Object.hasOwn returns false for statically-shaped objects (host mode)

## Source

Default (JS-host) lane test262 harvest, 2026-07-06
(`.test262-cache/test262-current.jsonl`). All ~24 `built-ins/Object/hasOwn`
fails share assert #1: `Object.hasOwn(o, "foo")` returns `false` for an object
whose property demonstrably exists.

## Root cause

`Object.hasOwn(obj, key)` compiles (in host mode) to the host import
`__object_hasOwn` (`src/runtime.ts` ~L10702), which did:

```js
return (Object.hasOwn ? Object.hasOwn(obj, key) : ...) ? 1 : 0;
```

i.e. it called `Object.hasOwn` on the **raw** value. When `obj` is a WasmGC
struct (a statically-shaped object literal like `{ foo: 42 }`, or a `{}` given
an accessor via `Object.defineProperty`), the struct's fields/sidecar/descriptor
data are invisible to native `Object.hasOwn` → always `false`.

By contrast the method-call path `o.hasOwnProperty(key)` dispatches to the
`__hasOwnProperty` host import, which routes a wasm struct through
`_wasmStructHasOwn(obj, key, exports)` (the shared own-property predicate:
tombstone + sidecar + descriptor + class methods + struct shape) and a plain JS
object through `Object.prototype.hasOwnProperty.call`. That is why
`o.hasOwnProperty("foo")` and `"foo" in o` succeed on the same literal while
`Object.hasOwn(o, "foo")` did not.

`Object.hasOwn(O, P)` is spec-equivalent to
`HasOwnProperty(ToObject(O), ToPropertyKey(P))` — identical to
`Object.prototype.hasOwnProperty.call(O, P)` — so the two host imports must use
the same presence predicate.

## Fix

Rewrite the `__object_hasOwn` host import to mirror `__hasOwnProperty`:
ToPropertyKey the key, then arguments-object arm → non-struct
`hasOwnProperty.call` arm → wasm-struct `_wasmStructHasOwn` arm. Host-import
only; the standalone native `emitHasOwn` `$Object` body is untouched (no
standalone regression risk).

## Acceptance

- `built-ins/Object/hasOwn` `hasown_own_*` cluster passes.
- No regressions in `Object.prototype.hasOwnProperty` / `in` behaviour.

## Result (2026-07-06, dev-cycleA)

`built-ins/Object/hasOwn` local suite: **56/62 pass** (was ~38). The entire
`hasown_own_*` target cluster (24 fails) is fixed. `hasown_inherited_exists.js`
still passes — own-only semantics intact (no prototype-walk regression).

**Residual (6, distinct sub-issues — NOT this fix's scope):**

- ~~`toobject_null.js` / `toobject_undefined.js` / `toobject_before_topropertykey.js`~~
  **FIXED (2026-07-06, ratio-gate follow-up).** These were **not** pre-existing
  fails — they *passed* on the pre-#3060 body (which delegated to native
  `Object.hasOwn`, and that throws TypeError on a null/undefined receiver). The
  struct-routing rewrite guarded the null receiver with `if (obj == null) return 0`,
  which **regressed** all three (pass→fail assertion_fail) and tripped the
  merge_group regression-ratio gate (3 regressions / 21 improvements = 14.3% ≥ 10%).
  Fix: replace the `return 0` with `throw new TypeError(...)`, implementing ES2022
  step 1 `ToObject(O)` (§20.1.2.13.1) — placed *before* `_toPropertyKey(key)` so
  ToObject throws prior to ToPropertyKey (the ordering `toobject_before_topropertykey`
  asserts). A host-import throw surfaces as a catchable `TypeError` for
  `assert.throws` exactly as the original native `Object.hasOwn` did. Verified: 3
  host tests now pass; 125-file host+standalone sweep over `Object/hasOwn/**` +
  `Object/prototype/hasOwnProperty/**` shows 0 pass→fail flips; all 21 improvements
  retained. Standalone lane unaffected (does not use the `__object_hasOwn` host
  import; those 3 were already `fail` in the standalone baseline, unchanged).
- `symbol_property_toString.js` / `symbol_property_valueOf.js` /
  `symbol_property_toPrimitive.js` — a shared `_toPropertyKey` gap: a key object
  whose `toString`/`valueOf` returns a **Symbol** isn't coerced per ToPrimitive
  order. The same residual fails on the `Object.prototype.hasOwnProperty` method
  path (`__hasOwnProperty`), so it is a `_toPropertyKey` issue, not `hasOwn`.
