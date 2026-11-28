---
id: 7432
title: "One representation for well-known symbol keys"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: design
area: codegen
goal: ir-full-coverage
related: [7410, 7427, 7429, 7406]
---

# #7432 — One representation for well-known symbol keys

## Problem

The compiler spells a property keyed by a well-known symbol (`[Symbol.match]`) in four ways, and the places that
meet disagree. Found by the #7410 sweep. #7427 fixes the member-key read only and leaves the representation
as it is.

| spelling | made by | read by |
| --- | --- | --- |
| `@@match` (string) | object-literal structs: `resolveWellKnownSymbol` (`codegen/literals.ts`) | struct field lookups; `${struct}_@@iterator` method names (`iterator-native.ts`); call dispatch on `"@@iterator"` (`call-tail-dispatch.ts`); the ToPrimitive driver `__call_@@toPrimitive` (`codegen/index.ts`, `methodSuffix = "@@toPrimitive"`); the JS host's `_hasOwnStructField(raw, "@@toPrimitive")` (`runtime/host-to-primitive.ts`) |
| `__@match@<id>` (string) | structs built from a TypeScript type: `ensureStructForType` and `objectIrTypeFromTsType` (`codegen/index.ts`, `name: prop.name`) | the same field lookups by `prop.name`; the field sort by name |
| `@@<id>` (string, e.g. `@@7`) | native-prototype member tables (`array-object-proto.ts`, `builtin-value-read.ts`) | reflective built-in member reads (#7427) |
| the boxed symbol (`i32.const 7`, then `__box_symbol`) | `obj[Symbol.match] = v` and `obj[Symbol.match]` on a dynamic object | `__extern_set` / `__extern_get` |

Where two spellings meet, the program sees a wrong answer:

- **Materialize** (`materializeStructAsDynamicObject`, `literals.ts`): copying a struct into a dynamic object
  calls `__extern_set(obj, field.name, v)`, so a `[Symbol.match]` field becomes the STRING-keyed property
  `"@@match"` or `"__@match@158"`. The symbol-keyed property is lost, and a junk string key appears. The second
  spelling also carries TypeScript's process-global id, so the output depends on compile order (#7410).
  - Seen in `built-ins/String/prototype/replaceAll/searchValue-replacer-call-abrupt.js`.
- **Dynamic read of a struct field** (#7429): `(o as any)[Symbol.iterator]` on `{ [Symbol.iterator]() {} }` reads
  the boxed symbol from a struct whose field is the string `@@iterator`, and answers `undefined`. The same
  happens for `toStringTag`, `split` and `match`, on default and standalone. `toPrimitive` has its own dispatch
  and works.

## Target

1. **At the dynamic boundary, the real symbol.** Whenever a well-known key crosses into a dynamic object
   (`__extern_set` / `__extern_get` / materialize / spread), the key is the boxed symbol, as
   `obj[Symbol.x] = v` already does.
2. **Inside the compiler, one canonical static key**, made by one helper from `WELL_KNOWN_SYMBOL_IDS` and used for
   struct fields, method helper names and dispatch. A TypeScript property symbol reaches it through
   `src/checker/well-known-symbol-keys.ts` (#7410/#7427), never through `prop.name`.
   - Proposed spelling: `@@<name>`, the one most consumers already use.
   - The native-prototype tables' `@@<id>` stays as their table key, but it is derived from the same helper.

## Migration order (gc bytes identical where the program is right today)

1. **Canonical key for TypeScript-derived structs.** `ensureStructForType` and `objectIrTypeFromTsType` name a
   well-known field `@@<name>` through the helper, and every lookup by `prop.name` goes through the same
   helper.
   - **Byte risk:** the field sort compares names, and `@@` (0x40) sorts before uppercase letters and `_`,
     while `__@` sorts after them. A shape mixing a well-known key with such names would reorder. Either keep
     the sort key as before (sort by the old spelling, emit the new one), or measure and accept the layout
     change in a reviewed diff.
2. **Materialize with the real symbol.** A canonical well-known field is copied with the boxed symbol as its
   key. The output changes only for programs that are wrong today (the string keys above).
3. **Dynamic read of a canonical field.** `o[Symbol.x]` on a known struct with a canonical `@@x` field resolves
   to that field (fixes #7429), or the struct materializes with step 2's keys.
4. **ToPrimitive and the host lane.** `__call_@@toPrimitive` and `_hasOwnStructField(raw, "@@toPrimitive")` keep
   reading the canonical static key; nothing changes for them once steps 1–3 hold. The JS-host lane stays
   byte-identical except where step 2 changes a wrong answer.

## Rows to measure before and after (standalone)

- `built-ins/String/prototype/replaceAll/searchValue-replacer-call-abrupt.js`, and the `String/prototype`
  `Symbol.iterator` rows from the #7410 sweep.
- The #7429 shapes: object-literal methods keyed by `Symbol.iterator` / `toStringTag` / `split` / `match`, read
  through `any`.
- A sweep over test262 files with a `[Symbol.x]` key in an object literal or class, compared before and after.
  The #7410 sweep is the template: binaries scanned for `__@` strings, plus verdicts.

## Related, not folded in

- [#7406](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7406-boolean-or-undefined-cannot-tell-false-from-undefined),
  an open representation decision.
- S3's value-rep line.

This issue decides only how well-known keys are spelled and where the real symbol appears.

## Acceptance

- One helper makes every static well-known key; no `__@x@<id>` field, and no hand-spelled `"@@x"` outside it.
- Materialize, spread and dynamic reads use the boxed symbol; the rows above match node on standalone.
- gc output byte-identical on a corpus without symbol-keyed structs; every other byte change named in the PR.
