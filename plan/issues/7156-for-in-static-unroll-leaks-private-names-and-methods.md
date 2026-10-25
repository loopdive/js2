---
id: 7156
title: "Native-first and standalone: static for-in unroll over a class instance enumerates private names and prototype methods"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: statements
goal: correctness
parent: 6979
related: [7149, 4138, 4561, 7148]
---

# #7156 — `for (k in instance)` lists `#x` and methods on the no-host lanes

Found while implementing #7149 (PR #6912). Pre-existing on `origin/main`, on gc
native-first and standalone (host-assisted is correct):

```js
class C { #x = 1; y = 2; m() {} }
const keys: string[] = [];
for (const k in new C()) keys.push(k);
console.log(keys.join());   // "#x,y,m"   (node: "y")
```

## Cause (as diagnosed; verify before fixing)

`emitForInStaticUnroll` (`src/codegen/statements/for-in-static-unroll.ts`,
#4561) unrolls the loop over `ctx.checker.getTypeAtLocation(expr).getProperties()`.
The checker's property list for a class type includes private names and
prototype methods; the unroll materialises each `prop.name` as a key without
filtering by own-enumerable-ness. The same unroll also lists `z` first for
`for (k in {...a, z})` (#7148 "left out"), because TypeScript's spread type
orders the literal's own keys first.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the program above plus a subclass (`class D extends C { w = 3 }`),
   a getter-only class, and a class with a static field, on gc native-first and
   standalone; confirm host-assisted prints the node output.
2. In the static unroll, filter the checker properties before emitting:
   skip symbols whose declaration is a `PrivateIdentifier` name, methods /
   accessors (declarations that are `MethodDeclaration` /
   `GetAccessor` / `SetAccessor`), and `static` members. Route the query
   through `ctx.oracle` (the oracle-ratchet gate rejects new raw `checker.*`
   calls; the existing `getTypeAtLocation` at line ~86 is already granted — do
   not add another). Prefer extending the oracle with a
   `ownEnumerableInstanceProps(type)` helper over inline filtering so
   `Object.keys` static paths can reuse it.
3. For the ordering half: when the receiver type is a spread literal
   (`{...a, z}`), do NOT unroll statically — fall through to the dynamic
   for-in over the `$Object` (which #7148 made insertion-ordered). State the
   byte delta for programs that previously unrolled.
4. Tests: `tests/issue-7156-for-in-class-instance.test.ts` with the programs
   from step 1 and `for (k in {...a, z})`, gc native-first and standalone vs
   node.

Acceptance: `for…in` over a class instance lists only public own instance
fields in declaration order on gc native-first and standalone; host-assisted gc
bytes unchanged; equivalence gate reports no new regressions.
