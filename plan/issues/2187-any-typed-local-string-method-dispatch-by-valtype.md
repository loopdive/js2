---
id: 2187
title: "standalone: string methods on an any-typed local with a native-string ValType take the generic externref path (v.length → 0)"
status: done
sprint: 64
created: 2026-06-17
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
related: [2171, 2072, 2157]
origin: "2026-06-17 — residual found while closing #2171 SF-4 (string-yield generators)"
---

# #2187 — string method on `any`-typed local with a string-ref ValType

## Problem

When a local's **TS static type is `any`** but its **Wasm ValType is the native
`$AnyString` ref**, a string method/property on it takes the generic
externref/`any` property path instead of the native-string fast-path, returning
wrong results. Surfaced via #2171 string-yield generators in standalone (no lib
types → the for-of loop var infers `any`):

```ts
function* g(){ yield "a"; yield "b"; }
export function test(): number {
  let n = 0; for (const v of g()) n += v.length; return n;  // standalone: 0   expected: 2
}
```

Counts and concatenation are correct (`s += v` → `"ab"`); only a per-element
string method/property (`v.length`, `v.charCodeAt(0)`, …) on the `any`-typed
loop var is wrong. `String(o.a)`-style concat works because the concat path keys
off the operand ValType, not the TS type.

## Root cause

`compilePropertyAccess` (`src/codegen/property-access.ts`) gates the native
`.length` fast-path on `isStringType(tsObjType)` (the **TS static type**, ~line
1418). For an `any`-typed receiver whose *local ValType* is `(ref null
$AnyString)`, this is false, so the read falls to the generic
`extern.convert_any` + null-check + `__extern_get` path (which the WAT shows
throwing/returning 0). The single-yield case happens to hit a different
`.length` arm that consults the local ValType, so it returns the right value —
the divergence is exactly "TS type vs local ValType" disagreement.

## Fix direction

When the receiver is an identifier whose local/param **ValType is a native
string ref** (or, more generally, a concrete non-`any` Wasm representation),
route string property/method access by the **local ValType**, not the TS static
type — so `any`-typed-but-string-ref locals use the native `$AnyString` path.
Coordinate with the #2072 value-rep family (the general "compiled value has a
concrete representation even though TS says `any`" problem). Likely a shared
helper `receiverNativeStringValType(ctx, fctx, expr)` consulted before the
`isStringType(tsObjType)` gate, applied to `.length` and the string-method
dispatch sites.

## Acceptance criteria

- `for (const v of g()) n += v.length` (string generator, standalone) → correct
  sum; `v.charCodeAt(0)` correct.
- No regression on TS-typed `string` receivers or on numeric generators.
- JS-host mode unaffected.

## Notes

Split from #2171 (string-yield generators, SF-4 of #2157 — landed in
`c3eb18936`). #2171's own acceptance (iterate + concat) is met; this is the
per-element string-method residual.

## Implementation (sdev-strdispatch, 2026-06-21)

Generalizes the #2077/#2192 caught-Error precedent to *any* `any`/`unknown`
receiver whose runtime value may be a native `$AnyString`. Native-string mode
(`ctx.nativeStrings && ctx.anyStrTypeIdx >= 0`, i.e. standalone/WASI) only —
host/gc mode is untouched. Probe on `origin/main` `075d90ee5` confirmed the bug
is in the consumer **dispatch gate** (`isStringType(<TS type>)`), not the
dynamic value reader.

Two distinct receiver shapes needed two distinct fixes (the spec's single "add
a guarded arm before L3754" missed that the bug splits by how the receiver
compiles):

1. **`.length` on an externref `any` value** (`o.v.length`, nested `o.a.b`,
   `Object.values(o)[0]`, `Object.entries(o)[0][1]`, `catch(e:any).message`).
   These already flowed through the existing **#1472 Phase B Blocker B Slice 2**
   arm in `property-access.ts` (`compilePropertyAccess`, the `propName ===
   "length"` / `ctx.standalone && isAnyOrUnknown` branch), which called
   `__extern_length` (→ 0 for a bare string). Fix: wrap that call in a runtime
   `ref.test $AnyString` guard (`emitGuardedNativeStringLength`) — a string hit
   reads `$AnyString.len` (field 0, valid for FlatString **and** ConsString, no
   flatten); a miss falls to the unchanged `__extern_length` array/$ObjVec
   reader. The receiver externref is saved to a temp so both arms reuse it
   (single eval).

2. **`.length` on a typed `$AnyString` local with TS type `any`** (the
   string-yield generator loop var `for (const v of g())`, which the backend
   compiles to a `(ref null $AnyString)` local even though TS infers `any` with
   no lib types). The generic multi-struct `.length` dispatch only tests **vec**
   types, never `$AnyString`, so it fell to 0. Fix: in the local-ValType `.length`
   arm, recognize the native-string family (`isNativeStringFamilyTypeIdx` —
   `$AnyString`/`$NativeString`/`$ConsString`) and read field 0 directly.

3. **Native string methods on an externref `any` value** (`o.v.charCodeAt(0)`,
   `o.v.slice(1)`, `o.v.indexOf(...)`). New `compileGuardedNativeStringMethodCall`
   in `string-ops.ts`: evaluate the receiver once → externref temp, `ref.test
   $AnyString`; the then-arm casts to `$AnyString` and runs the normal native
   method lowering via a new `receiverOverride` callback threaded into
   `compileNativeStringMethodCall` (so the receiver is **not** re-compiled — no
   double side effects); the else-arm emits the method's spec default for its
   result ValType. Wired at the calls.ts string-method dispatch site, OR'd via a
   new `receiverMayBeNativeStringAtRuntime` predicate, scoped to STRING_METHODS
   names **plus `charCodeAt`** (which has a dedicated arm but is absent from the
   STRING_METHODS table — otherwise it leaked to the generic `__call_m_<name>`
   dispatcher and returned 0). `concat` deliberately excluded (collides with
   `Array.prototype.concat` on an `any` array; out of #2187 scope).
   `collectStringMethodImports` (index.ts) extended to register the native
   helpers for `any`-receiver string-method calls so the guard's then-arm has a
   funcMap target.

Edge cases honored: boxed `String` wrapper stays on its #1910-R4 path (it is a
`$Object`, `ref.test $AnyString` misses); `any` holding an array keeps
array-length via the else-arm; null/undefined receiver → `ref.test` false → no
deref; an `any` holding a number → no spurious string length.

**Out of scope (unchanged, pre-existing on main):** an `any` (not `any[]`)
holding an **array** calling a string-named array method (`.indexOf`/`.slice`)
still returns 0 — these already returned 0 on `origin/main` and route through
the any-receiver array-method dispatch slice, not this read-side fix.

Changed files: `src/codegen/property-access.ts`,
`src/codegen/expressions/calls.ts`, `src/codegen/string-ops.ts`,
`src/codegen/index.ts`. Tests: `tests/issue-2187.test.ts` (12 cases incl. all
ACs + non-regression guards + host-mode parity).
