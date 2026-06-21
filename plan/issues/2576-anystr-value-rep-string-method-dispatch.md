---
id: 2576
title: "standalone: string .length / methods on an opaque-externref any value (object prop, generator yield, indexed element) return 0 — value-rep extension of #2187"
status: done
sprint: 64
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
assignee: sdev-strdispatch
priority: low
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: strings
goal: standalone-mode
related: [2187, 2072, 2157, 2171, 1472]
origin: "2026-06-21 — extends #2187 (sd-3, PR #1845) which fixed only the bare-identifier-with-$AnyString-local case"
---

# #2576 — value-rep extension of #2187: string `.length` / methods on an opaque-externref `any` value

## Problem

#2187 (PR #1845, sd-3, merged) fixed the case where a receiver is a **bare
identifier whose compiled local ValType is a native string ref** (the
string-yield generator loop var) via `receiverIsNativeStringValType`. But it
explicitly deferred the broader **value-rep** cluster (the #2072 family): an
`any`/`unknown` receiver whose value is a native `$AnyString` at runtime but
which compiles to an **opaque externref** — so no local ValType reveals it. On
`upstream/main` `43a510a70` (post-#2187) these still returned 0 in standalone:

```ts
const o: any = { v: "hi" };
o.v.length; // 0, expect 2
const o: any = { v: "hi" };
o.v.charCodeAt(0); // 0, expect 104
const o: any = { v: "hello" };
o.v.slice(1).length; // 0, expect 4
const o: any = { v: "hello" };
o.v.indexOf("l"); // 0, expect 2
try {
  throw new Error("oops");
} catch (e: any) {
  e.message.length;
} // 0, expect 4
const o: any = { a: { b: "hi" } };
o.a.b.length; // 0, expect 2
const o: any = { a: "xx", b: "yy" };
(Object.values(o)[0] as any).length; // 0, expect 2
const o: any = { k: "hi" };
(Object.entries(o)[0][1] as any).length; // 0, expect 2
```

`String(o.v)`-style concat already works because it keys off the operand
ValType, not the TS type — proof the value IS a real native string.

## Root cause

Same as #2187 — the consumer **dispatch gate** (`isStringType(<TS type>)`).
#2187's `receiverIsNativeStringValType` only fires for a bare identifier whose
_compiled local ValType_ is the string ref; an object-property read, indexed
element read, catch-binding read, or nested read all produce an **opaque
externref** value (the dynamic `__extern_get`/`__extern_get_idx`/Error reader),
so the predicate misses and `.length`/methods fall to `__extern_length` /
`__extern_get` → 0. The value can only be recognised **at runtime** (`ref.test
$AnyString`).

## Fix

A runtime `ref.test $AnyString` guard at the externref-`any` dispatch sites
(native-string mode only; host/gc untouched), layered ON TOP of #2187's static
arm (which stays for the local-ValType case):

1. **`.length`** — augment the #1472 Phase B Blocker B Slice 2 arm
   (`property-access.ts`, the `propName === "length"` / `ctx.standalone &&
isAnyOrUnknown` branch): `emitGuardedNativeStringLength` saves the externref,
   `ref.test $AnyString` → hit reads `$AnyString.len` (field 0); miss falls to
   the unchanged `__extern_length` array/$ObjVec reader (single eval).
2. **native methods** — `compileGuardedNativeStringMethodCall` (`string-ops.ts`):
   evaluate the receiver once → externref temp, `ref.test $AnyString` → hit casts
   to `$AnyString` and runs the native method via a new `receiverOverride`
   callback on `compileNativeStringMethodCall` (no re-compile, no double side
   effects); miss → the method's spec default for its result ValType. Wired at
   the calls.ts string-method dispatch site via a new
   `receiverMayBeNativeStringAtRuntime` predicate, scoped to STRING_METHODS names
   plus `charCodeAt` (which has a dedicated arm but is absent from the table —
   otherwise it leaked to the generic `__call_m_<name>` dispatcher and returned
   0). `concat` excluded (collides with `Array.prototype.concat` on an `any`
   array).
3. **`collectStringMethodImports`** (index.ts) — register the native helpers for
   `any`-receiver string-method calls so the guard's then-arm has a funcMap
   target.

## Acceptance criteria

- `o.v.length` → 2; `o.v.charCodeAt(0)` → 104; `o.v.slice(1).length` → 4;
  `o.v.indexOf("l")` → 2.
- `catch(e:any){ e.message.length / .charCodeAt(0) }` → 4 / 111.
- nested `o.a.b.length` → 2; `Object.values(o)[0].length` /
  `Object.entries(o)[0][1].length` → 2.
- No regression: `Object.values(o).length` (vec) → 2; `new String("hi").length`
  → 2; an `any` holding a number `.length` → 0; statically string-typed
  receivers unchanged; host/gc mode unchanged.

## Out of scope (verified, unchanged)

- An `any` (not `any[]`) holding an **array** calling a string-named array method
  (`.indexOf`/`.slice`) still returns 0 — already 0 on `main`, routes through the
  any-receiver array-method dispatch slice, not this read-side fix.
- The **two-yield** string generator (`yield "a"; yield "b"`) `v.length` still
  returns 0 — that is the #2040 generator-state value-binding residual (the
  second yield's value isn't bound), NOT a string-dispatch bug. Single-yield
  generators (the #2187 origin) work.

## Implementation (sdev-strdispatch, 2026-06-21)

Built on top of sd-3's landed #2187 (kept `receiverIsNativeStringValType`; this
adds the complementary opaque-externref coverage it deferred). Changed files:
`src/codegen/property-access.ts`, `src/codegen/expressions/calls.ts`,
`src/codegen/string-ops.ts`, `src/codegen/index.ts`. Tests:
`tests/issue-2576.test.ts` (12 cases: all ACs + non-regression guards +
host-mode parity).
