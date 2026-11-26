---
id: 7495
title: "Symbol-keyed struct fields need a key space a string cannot spell, excluded from string-key enumeration"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7425]
---

# #7495: a key space for symbol-keyed struct fields

## Problem

The compiler spells a well-known-symbol property key as the string `@@<name>`
(or `@@<id>`), and in most places that spelling shares one namespace with
ordinary string keys. A user string key `"@@iterator"` and `Symbol.iterator`
therefore collide wherever the spelling is the key.

Measured on main `c3b7be66` (2026-11-26) by review RV7444 on PR #7444, on gc,
standalone and wasi:

- `({ "@@iterator": 5 })[Symbol.iterator]` reads 5 instead of `undefined`.
- `class C { ["@@iterator"]() {…} *[Symbol.iterator]() {…} }`: for-of throws.
- `Object.getOwnPropertySymbols` on an object literal returns 0.
- for-in over a literal with a symbol method lists an extra key.
- `Symbol.hasInstance` is ignored on a static class method and on an object
  literal (`1 instanceof H` is false).
- A class `get [Symbol.toStringTag]` accessor is ignored by
  `Object.prototype.toString`.

**The object-literal half of #7425 belongs here too.** `yield*` over an
object-literal iterator still throws. Its `[Symbol.iterator]()` method sits in
a struct field named with TypeScript's internal name `__@iterator@<n>`, and no
symbol-keyed read reaches that field. Naming the field `@@iterator` instead
(the first version of PR #7444) fixed `yield*` but made the field an
enumerable string key: `Object.keys({ a, [Symbol.iterator]() {} })` returned 2.

## Implementation Plan (outline — needs its own plan review)

**Target structure.**

- One representation for a symbol property key in a struct field and a class
  member: either a field flag (`symbol: <id>`) or a reserved spelling that
  `resolvePropertyNameText` and every string-key path cannot produce.
- One producer of that key from source: `wellKnownSymbolKeyOf` (`literals.ts`,
  added by #7425).
- One consumer predicate, "is this field a symbol key", used by every
  enumeration path.

**Steps.**

1. **Inventory.** Find every producer and consumer of the `@@` spelling and of
   the `__@<name>@<n>` checker names (about 20 sites). Producers include:
   - `resolveWellKnownSymbol` / `wellKnownSymbolKeyOf` (literal data props,
     computed keys);
   - the class member names in `classMethodNames`;
   - `ensureStructForType` (`prop.name`);
   - the native-proto `@@<id>` tables;
   - `generators-delegation-runtime`'s `"@@iterator"` getter name.

   Consumers include `carrier-bag-delete`, `date-carrier-dynamic-member`,
   `own-property-method-shadow`, `array-object-proto`, `native-proto` and
   `generators-native`'s `__@iterator` scan.
2. **Choose the representation.** Measure what each option costs on the
   enumeration paths: `Object.keys` / `entries` / `values`, for-in, spread,
   `hasOwn` / `hasOwnProperty`, `getOwnPropertyNames`, `JSON.stringify` and
   `__sget_*` export names.
3. **Name fields and members from the declaration, not the string.**
   - `ensureStructForType` and the literal compiler give one symbol-keyed
     field per member (today a function-expression property gets both
     `__@iterator@<n>` and `@@iterator`).
   - Class members carry the symbol identity. #7425 checks the declaration in
     `emitClassMemberKeyOperand`; this step generalizes that check.
4. **Reads.**
   - `o[Symbol.iterator]`, the delegation getter and `__extern_get` with a
     boxed well-known symbol reach the symbol field.
   - String-key reads (`o["@@iterator"]`, computed string reads) never reach
     it.
5. **Enumeration.** Every string-key enumeration path skips symbol fields, and
   `getOwnPropertySymbols` lists them.
6. **Pins.**
   - Object-literal `yield*` (values, `next(v)`, `return()`, `throw()`).
   - Each pre-existing item above.
   - RV7444's B1 and B2 rows, which #7425's test already pins on the class
     side.

**Acceptance (code quality).** A single key representation with a single
producer and a single "is symbol key" predicate. No path compares against a
hard-coded `"@@…"` string except where that predicate is defined.
