---
id: 7201
title: "wasi: JSON.stringify / Object.entries / hasOwnProperty on any class instance return null or nothing"
status: done
completed: 2026-10-31
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7158]
# 2026-10-31: the four closed-struct finalize fills were gated `ctx.standalone`
# alone, so wasi (the other no-host target) never got them. The fix widens each
# gate to the existing `noJsHost(ctx)` predicate (= standalone || wasi). A
# mode-neutral rewrite would drop the gate entirely and change the host-lane gc
# output, which must stay byte-identical; `hostFreeEnvironment` is NOT a
# substitute (gc native-first sets ctx.standalone with environment
# "javascript", so it changed gc bytes). Net: ctx.standalone -5, noJsHost +4.
standalone-arms-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-enumeration.ts
---

# #7201 — wasi class-instance enumeration is broken even with one class

Found while implementing #7158 and confirmed by the PR #6996 review (finding 5).
It is unrelated to twin layouts and is present on main.

```js
class A { a = 1 }
console.log(JSON.stringify(new A()));                 // node: {"a":1}  wasi: null
console.log(JSON.stringify(Object.entries(new A()))); // wasi: wrong
console.log((new A() as any).hasOwnProperty("a"));    // wasi: wrong
```

for-in, `Object.getOwnPropertyNames` and `Object.assign` from a class instance
also return null or nothing on wasi. gc native-first and standalone are correct.

## Plan

1. Diff the wasi lowering of the closed-struct enumeration consumers against
   standalone and find where class structs drop out.
2. Tests: wasi rows for every consumer in
   `tests/equivalence/issue-7158-twin-struct-layouts.test.ts`, against node.

## Resolution (2026-10-31)

**Cause.** The finalize-time fills that give the dynamic object helpers their
closed-struct arms were gated on `ctx.standalone`, which wasi leaves false:

| Fill / registration | Consumer it serves |
| --- | --- |
| `fillClosedStructExternGetArms` (`object-runtime.ts`) | `__extern_get`: every read of a class field or object-literal field through `any`, and the JSON / Object.assign value reads |
| `fillClosedStructHasOwnArms` | `hasOwnProperty` / `Object.hasOwn` |
| `fillClosedStructOwnPropertyNamesArms` | `Object.getOwnPropertyNames` (for…in reads the same names) |
| `__object_assign_closed_struct_source` classifier (`object-runtime-enumeration.ts`) and its Object.assign copy arm | `JSON.stringify` object walk, `Object.assign` from an instance |

`fillClosedStructEnumerationArms` (Object.keys) was already ungated, which is
why `Object.keys` alone worked on wasi. Each gate now reads `noJsHost(ctx)`.
No shared classifier contract, `ref.test` legality, type API or category
inventory changed: wasi now builds the same arms standalone already builds.

**Array-like objects (#7167 review) — partly the same cause.**
`({ length: 2 } as any).length` and `o[0]` were `undefined` on wasi because the
object literal is a closed struct and `__extern_get` had no arms. Fixed here.
`Array.prototype.sort.call(arrayLike)` / `join.call(...)` still throw on wasi:
a DIFFERENT cause. The `Array.prototype.X.call` lowering takes a host path on
wasi (`__proto_method_call`, `__js_array_new`, `__get_builtin`, rejected by the
no-host allowlist), while standalone has a native protocall path. Not fixed.

**Not wasi gaps, left as found (fail on every lane, base and head):**
- `JSON.stringify` of a tuple / `Object.entries(...)` result answers `[null]`
  (`JSON.stringify([["a", 1]] as [string, number][])` too). So the issue's
  `JSON.stringify(Object.entries(new A()))` row is still wrong everywhere;
  `Object.entries(new A())` itself is right on wasi.
- `JSON.stringify(new Map())` → `null`, `Object.keys(ClassCtor)` misses statics,
  `JSON.stringify(new A(1, "q"))` for parameter properties → `{}`.

**Pre-existing wasi-only gap, unchanged:** `Object.entries({ a: 1 })` (an object
literal) traps with a null dereference on wasi.

Tests: `tests/equivalence/issue-7201-wasi-class-enumeration.test.ts` (15 rows,
gc + standalone + wasi vs node); every `issue-7158` row now also runs on wasi.
