---
id: 6674
title: "standalone Object.prototype.toString refused RegExp/Date/class/Symbol/BigInt/Map/Set/Promise/Proxy receivers (moment standalone-dynamic module-init blocker)"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-25
completed: 2026-09-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [2501, 4119, 4491, 5148, 5406, 6484, 6671, 6678]
---

# #6674 — standalone `Object.prototype.toString` refused the nominal carriers

## Problem

moment's npm-compat `standalone-dynamic` perf lane compiled and then died in
module-init:

```
TypeError: Object.prototype.toString is not yet implemented in --target standalone
```

moment's `isFunction` / `isObject` / `isArray` / `isDate` / `isNumber` ask
`Object.prototype.toString.call(input)` of an `any` receiver, and its locale
`set(config)` loop feeds every config value through `isFunction` — including
RegExp literals (`dayOfMonthOrdinalParse`, `meridiemParse`). The runtime
§20.1.3.6 classifier (`object-proto-tostring.ts`, #4119/#4491) had no arm for
the standalone RegExp carrier, so the receiver fell through to its loud
refusal.

Probe on the parent (`d76cdfc9b4`), 24 receivers through an `any` parameter,
`--target standalone`: 11 wrong.

| receiver | parent |
| --- | --- |
| `/a/`, `new Date(0)`, `new K()` (class instance) | threw the refusal |
| `Symbol()`, `10n`, `new Map`, `new Set`, `Promise.resolve()` | threw the refusal |
| `Math`, `JSON`, `o` with `o[Symbol.toStringTag] = "Zed"` | `[object Object]` (step 15 ignored) |

`new Date(0)` threw although a Date arm existed: it was gated on the
`ctor:Date` builtin global, which `new Date(…)` does not publish.

## Implementation Plan (executed)

1. **New module `src/codegen/object-proto-tostring-carriers.ts`**, classified
   in `scripts/compiler-boundaries.json`.
2. **FINALIZE splice** `fillObjectProtoToStringCarrierArms`, called at the end of
   `fillIterRecObjectProtoToStringArms` (both finalize pipelines, no
   `index.ts` growth). It inserts arms ahead of the refusal/decline tail of all
   three classifier consumers (`__opts_classify`,
   `__object_proto_to_string_runtime`, the reflective
   `__proto_method_<Object>_toString`), because these carriers register lazily
   and may not exist yet when a classifier body is baked (same reason as the
   #6484 IterRec splice):
   - builtinTag carriers: `__Date` → Date, `__StandaloneRegExp` → RegExp,
     `$Error_struct` → Error, `WrapperString/Number/Boolean` structs;
   - prototype-tag carriers (tag = the intrinsic prototype's `@@toStringTag`):
     `$Symbol`, BigInt box, `$Promise`, WeakRef, DisposableStack, and `$Map`
     split by its immutable kind into Map / Set / WeakMap / WeakSet;
   - `$Proxy` (NOT a `$Object` subtype): §7.2.2 IsArray via the existing
     `__extern_is_array` (unwraps, throws TypeError when revoked) → Array;
     callable → Function; else Object;
   - step-13 default `[object Object]` for any other `typeof "object"`,
     non-`$Object` carrier (class instances, object-literal structs), with an
     explicit DECLINE list (`__IterRec`, `$LazyIterHelper`, `__proxy_revoker`,
     `Hole`, `$NativeProto`, `__GenState_*`, `$AsyncFrame_*`) so a carrier whose
     tag is not the default keeps the loud refusal — the #5406 link-terminal
     precedent.
3. **Step-15 consult** `emitObjectProtoToStringSymbolTagConsult`: the two runtime
   consumers call the existing `__opts_symbol_tag` (#5148, a real `[[Get]]` of
   `@@toStringTag`) first for every non-null/undefined receiver, only when the
   module already has the `$Symbol` carrier. `__opts_classify` is left alone —
   the fold already consults before calling it.
4. **Fold**: `resolveObjectToStringTag` answers `BigInt` for a BigInt-typed
   receiver in standalone (host still defers).
5. **Link boundary (#5406)**: the step-13 default arm is NOT spliced into a
   linked CONSUMER (a module with the peer `__js2wasm_link_to_string_tag`
   consult): a non-`$Object` carrier the peer declined is one of the peer's
   exotics, which no local type test can name, so the default would mis-tag it
   (measured: a provider `new Date()` / `new Map()` answered `[object Object]`
   with the first cut). Instead the PROVIDER's terminal
   (`link-boundary-tostring.ts`) runs the same specific-tag arms
   (`buildTaggedCarrierArms`) ahead of its decline list, so a provider Date /
   Map now answers `[object Date]` / `[object Map]` across the boundary.

No host import added; JS-host codegen untouched (every new path is gated on
`ctx.standalone`). The npm-compat harness change this branch first carried
(checksum-phase throws rendered as `[object WebAssembly.Exception]`) landed on
main independently while this branch was open, so it was dropped at the merge.

## Resolution

Measured 2026-09-25 on the branch merged with main `1b733c858e` (parent = that
main, via file-copy A/B of the touched `src/codegen` files).

- Probe: 24/24 receivers correct (parent 13/24); proxy rows `{}`/`[]`/function/
  proxy-of-proxy/`get` trap answer Object/Array/Function/Array/`[object Trap]`,
  a revoked proxy throws TypeError.
- `tests/issue-6674-standalone-object-tostring-carriers.test.ts`: 3 tests, all 3
  fail on the parent, all 3 pass with the fix; each asserts its CHECKED count.
- Pins that asserted the old refusal were updated to the spec tag (each fails
  on the fix before the edit, so the change is observed, not assumed):
  `issue-4119` "loud stays loud" (Date / RegExp / class instance now answer
  their tag), `issue-4491-wave7` two `it.fails` residuals (Date instance, Math
  through a dynamic receiver) now pass, `issue-5406` provider Date / Map now
  answer `[object Date]` / `[object Map]` instead of refusing. The wave-7
  control "a plain object through a dynamic receiver" fails on the parent and
  passes with the fix.
- Related vitest files (45 files touching the classifier, `@@toStringTag`,
  wrappers, link boundary): no other test changes status between parent and
  fix. Pre-existing failures on BOTH (`es5-standalone-callable-tostring`,
  `es5-standalone-wrapper-prototype`, `issue-4076` ×8 (`__to_property_key`
  native-first binding), `issue-4465` R3, `issue-4481` ×2, `issue-4485` ×2,
  `issue-4492-wave5` ×5, `issue-5226`, `issue-5373`) are unchanged.
- Scoped standalone test262 (`runTest262File(…, "standalone")`, parent vs fix):
  - `built-ins/Object/prototype/toString` (41): **23 → 25 pass**
    (`proxy-array.js`, `Object.prototype.toString.call-bigint.js`), 0 pass→fail.
  - every test262 file under `built-ins/`, `language/`, `annexB/` mentioning
    `prototype.toString` / `toStringTag` / `getClass` (807, incl. 183 Temporal):
    **393 → 395 pass**, the same two flips, 0 pass→fail.
  - Why so few flips for 11 fixed receivers: most test262 rows that reach these
    carriers take the #2501 compile-time fold (static receiver type), not the
    `any`-receiver runtime classifier this issue fixes; the npm lanes are the
    `any` shape.
- moment standalone-dynamic lane: `runtime-error` (module-init)
  `TypeError: Object.prototype.toString is not yet implemented in --target
  standalone` → `result-mismatch` `checksum mismatch: Wasm 12, Node 10` (every
  moment is `"Invalid date"`: a Date stored in an object property loses its
  methods on read-back) — filed as #6678.
- JS-host moment upstream suite: 10/10 (unchanged).

## Residuals

- A class instance whose `@@toStringTag` is a class ACCESSOR answers
  `[object Object]` (the standalone `__extern_get` does not see the accessor);
  it threw on the parent. Same named residual as #5406.
- A user `delete` / overwrite of `Map.prototype[@@toStringTag]` (and Set,
  WeakMap, WeakSet, Promise, Symbol, BigInt) is not observed: `__extern_get`
  does not reach those intrinsic prototypes, so the arms answer the unmodified
  prototype's tag (`symbol-tag-*-builtin.js` rows fail as before).
- `async function` answers `[object Function]` (spec `AsyncFunction`),
  generator functions `Function` (spec `GeneratorFunction`), a typed array via
  an `any` receiver `[object Array]` — all pre-existing.
