---
id: 1910c
slug: string-wrapper-index
title: "standalone String-wrapper s[0] / .length null-deref"
status: done
sprint: Backlog
parent: 1910
assignee: sdev-boxrep
feasibility: medium
completed: 2026-06-19
---

## Problem

In `--target standalone`, String-wrapper objects (`new String("abc")`)
null-deref on the String-exotic own properties:

- `new String("abc").length` → **dereferencing a null pointer** (spec: `3`)
- `new String("abc")[0]` → null-deref / wrong (spec: `"a"`)

## Root cause

`new String(x)` builds a `$Object` wrapper carrying its `[[StringData]]` native
string in the reserved `WRAPPER_PRIMITIVE_KEY` FLAG_INTERNAL slot (#1910 S2). The
String-exotic own properties `.length` (§22.1.4.1) and integer-indexed reads
`w[i]` (§10.4.3 CanonicalNumericIndexString) are NOT routed to the underlying
string — they hit the generic `$Object` property/index path, which finds no
`length`/integer entry and null-derefs. The primitive-string `.length` arm gates
on `isStringType` (primitive), so the String-*wrapper* type fell through.

## Fix (`src/codegen/property-access.ts`, standalone + nativeStrings only)

1. **`.length`** — in `compilePropertyAccess`, before the primitive-string
   `.length` arm: when `isStringWrapperType(objType) && propName === "length"`,
   recover the slot string via `__to_primitive(recv, "string")` (reads the slot
   first, §7.1.1.1), coerce to `$AnyString`, read `len` (field 0).

2. **`w[i]`** — in `compileElementAccess`, before the generic compile: when the
   receiver's static type is a String-wrapper and the index is provably numeric
   (`isNumericIndexExpression`), recover the slot string via `__to_primitive`,
   `__str_flatten` → `$NativeString`, then reuse the existing native
   `__str_charAt(flat, i)` helper (out-of-range → "", §22.1.3.1-style).

Both additive and standalone-gated; host mode keeps its own String-exotic
indexer/length reader.

## Scope

`.length` + integer-index read only, per the architect scope. String-exotic
own-property *enumeration* (`Object.keys(new String("ab"))`, `in`, for-in over
indices) is a separate, larger tail and deliberately out of this slice.

## Acceptance (all passing)

- `new String("abc").length === 3`, `new String("xy").length === 2`,
  `new String("").length === 0`
- `new String("abc")[0] === "a"`, `new String("abc")[2] === "c"`
- indexed char feeds a typed string method: `s[0].charCodeAt(0) === 97`

Regression: `tests/issue-1910-string-wrapper-index.test.ts` (6 cases). Related
string/wrapper/coercion suites still green; typecheck clean.

## Note on the `(s[0] as any).charCodeAt(0)` shape

An `as any` cast on the indexed result routes the method call through the
dynamic any-dispatch path (a separate concern from indexed access). The indexed
read itself returns the correct char — verified with a typed
`const c: string = s[0]; c.charCodeAt(0)`. The any-dispatch method-call gap is
not part of R4.
