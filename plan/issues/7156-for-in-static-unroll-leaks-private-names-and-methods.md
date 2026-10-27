---
id: 7156
title: "Native-first and standalone: static for-in unroll over a class instance enumerates private names and prototype methods"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-27
completed: 2026-10-27
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

## Resolution (2026-10-27)

Diagnosis confirmed on gc native-first, standalone and wasi: `new C()` with
`#x = 1; y = 2; m() {}` enumerated `#x,y,m`; a subclass listed its own members
before the base's (`w,n,#x,y,m`, node `y,w`); `{...a, z}` gave `z,x,y`.

Fix: the static unroll now takes its key list from a new oracle query,
`ctx.oracle.forInStaticKeysOf(expr)` (`src/checker/oracle.ts`; the in-house
backend answers `undefined` and the unroll falls back to the checker's raw
property list, so no new raw checker call in `src/codegen/`).

- A class instance gets the new key list only when its whole class chain is
  SIMPLE (review rounds 1–2, PR #6940): one plain class declaration per level
  (no interface/namespace merge), a chain that ends at no base (not a builtin,
  mixin or other non-class), and every member a plain field, parameter
  property, method, accessor, auto-`accessor`, static member or `#private`
  name, with a literal (or string-literal-typed `const`) computed key at most;
  no name is a field in one class and a method/accessor in another, and every
  checker property is explained by those members. Then the keys are the own
  fields — parameter properties, then fields, base class first, a redeclared
  field keeping the base position — and names come from the checker's
  symbols, so `["k1"] = 1` / `[K] = 1` keep their position.
- Any class chain that is not simple (a `declare` or `abstract` field, an
  interface merge, a base field under a derived method/getter or the reverse,
  a JS `this.x = …` assignment, an `Error` base, …) keeps exactly the checker's
  key list and order, as before #7156; those programs compile byte-identically
  to the base. So no class receiver is worse than before.
- An object literal with a spread (directly, or through a `const`) is ordered
  as it is built, left to right. Deviation from plan step 3: instead of
  falling through to the dynamic `$Object` for-in, the unroll keeps the static
  path with the correct order — same bytes, only the key order changes. The
  AST order is used only when it names exactly the checker's key set.
- Every other receiver keeps the checker's order, so its bytes are unchanged
  (87 of 99 sampled lane/program compiles byte-identical, including all 8
  not-simple class programs; the 12 that differ are simple-class / spread
  programs).

Tests: `tests/equivalence/issue-7156-for-in-class-instance.test.ts` (gc
native-first, standalone, wasi vs node).

Left out:

- `o[k]` read back inside the loop on **wasi** returns `undefined` for a struct
  receiver, plain object literals included (pre-existing, not #7156); the
  value-read row runs on gc and standalone only.
- Integer-like keys (`{ b: 1, 1: 2 }`) are not reordered ascending; unchanged.
- `Object.keys` static paths were not moved onto the new query (they already
  print `y` for the issue's class).
- Not-simple class chains keep the old order and key set, which can still
  differ from node: a `declare` field (listed even when never assigned, and in
  checker order), interface-merged members (listed even when never assigned),
  an `abstract` field, a base field shadowed by a derived method/getter or a
  base method by a derived field (key set right, order the checker's), a JS
  method that assigns `this.z`, a `Symbol`-keyed computed field (leaks as
  `__@s@NNN`), non-literal computed keys (`let K`, template keys) missing.
- Pre-existing on base and head, unchanged (review round 1 NITs): integer-like
  keys in a spread literal; a spread whose source has an optional key that is
  absent at runtime (`x?`) or a spread parameter, which use the declared order
  and set rather than the runtime one; keys added later or `delete`d (the
  unroll is static); a mixin's added field; `{...arr, z}` lists every
  `Array.prototype` member; on wasi, interface/union/`this` receivers and
  `{...anyValue}` / `{..."ab"}` read empty or wrong.
