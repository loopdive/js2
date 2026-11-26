---
id: 7427
title: "A built-in member read through its TypeScript symbol is keyed by the escaped name (`__@iterator@<id>`), not the native-prototype key `@@<id>`"
status: done
completed: 2026-11-26
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
related: [7410, 7350]
---

# #7427 — A built-in member read through its TypeScript symbol is keyed by the escaped name

## Problem

Found by the #7410 sweep. TypeScript names a `[Symbol.iterator]` member `__@iterator@<id>`, with an id from its
process-global symbol counter (#7410). The native-prototype tables key the same member `@@1`
(`WELL_KNOWN_SYMBOL_IDS`, `src/runtime/contracts/well-known-symbols.ts`).

The reflective built-in member call (`expressions/calls.ts`, `let member = sym?.getName()`) used the escaped
name as the member key. So `String.prototype[Symbol.iterator].call(…)` missed the table's `@@1` member, and the
program got the refusal TypeError, whose message read
`String.prototype.__@iterator@84 is not yet implemented in --target standalone`. That message is visible to
the program, and it changes with compile order.

## Implementation Plan (2026-11-19)

- **Where it lives.** `memberKeyForProperty(checker, property)` in `src/checker/well-known-symbol-keys.ts`, next to
  #7410's `functionNameForKey`. Both go through one private `keyOfProperty`: a string key keeps its name; a
  well-known key, whose declarations all spell `Symbol.<name>` on the library's `Symbol`, is spelled per caller
  (`[Symbol.iterator]` for a function name, `@@1` for a member key); any other symbol key answers undefined.
- **Uses.** The reflective member site calls it in place of `sym.getName()`. Undefined falls through, as a
  missing member did before.
- **Reuses / removes.** The `@@<id>` ids come from `WELL_KNOWN_SYMBOL_IDS`; no new map. Codegen kept two more
  copies of that table (`literals.ts`, `builtin-value-read.ts`; one had already drifted once, #3573). Both are
  removed: `getWellKnownSymbolId` and `resolveWellKnownSymbol` read the shared table. The copies used `in` / `[]`
  on a plain object, so `Symbol.toString` or `Symbol.constructor` resolved to `Object.prototype` members. The
  shared lookup uses `Object.hasOwn`.
- **Quality acceptance.** One helper for every place a TypeScript property symbol becomes an observable key; no
  second lookup path; one well-known-symbol table.

## Not in this issue: struct fields copied to a dynamic object

The #7410 sweep found a second site, `materializeStructAsDynamicObject` (`literals.ts`), where a struct field
named from a TypeScript symbol (`__@match@158`) becomes a string-keyed own property. This is not a
`sym.getName()` member-key read: it is how well-known keys are represented in structs and dynamic objects, and
the codebase has three spellings for it:

- object-literal structs use the string `@@match` (`resolveWellKnownSymbol`), which the ToPrimitive dispatch
  relies on (`__call_@@toPrimitive`);
- structs derived from a TypeScript type use the escaped `__@match@<id>`;
- `obj[Symbol.match] = v` uses the real boxed symbol (`i32.const 7`, then `__box_symbol`).

Making materialization use the real symbol changes that representation, so it needs its own design.

## Measured (2026-11-19, base = #7410 head `805df5008c`)

Standalone test262 before and after, 349 files: every `X.prototype[Symbol.y].call/apply` file, plus every
`prototype/Symbol.*` directory.

| | pass | fail | skip |
| --- | ---: | ---: | ---: |
| base | 281 | 51 | 17 |
| this branch | 281 | 51 | 17 |

- 0 verdict changes.
- 7 failures are infrastructure on both sides: the QuickJS eval provider is not built in the container.
- `String.prototype[Symbol.iterator].call("ab")` now reaches the native `@@1` body: its refusal string is gone
  from the binary. It still throws later, in that body (separate, not investigated).

**Bytes.** On the 349 files above (default + standalone), 30 of 681 rows differ between base and branch, all
from site 1: 13 `built-ins/Date/prototype/Symbol.toPrimitive` files and 2 `String/prototype/Symbol.iterator`
files, × 2 targets. The id-table fold adds no byte change.

- On base, `Date.prototype[Symbol.toPrimitive]` is keyed `__@toPrimitive@<id>`, which misses the native
  table's `@@3` member. The reflective call then falls through to a dynamic `.call` on `undefined`, and the
  binary carries the TypeError string `Cannot read properties of undefined (reading 'call')`.
- On the branch, the member resolves to the native Date `@@3` closure, so that path and its string are gone.
- The String files lose the refusal naming `__@iterator@<id>`.
- All 15 files pass on both sides; no verdict changes.

**Re-measured on current main `313281866f` (2026-11-26), after merging main.** The same 349 files on
standalone give 281 pass / 51 fail / 17 skip on main and on the branch, with 0 verdict changes. The byte cause
above was re-checked on this base: a WAT diff of `Date/prototype/Symbol.toPrimitive/hint-default-first-non-callable.js`
shows the same `.call`-on-undefined TypeError string present on main and gone on the branch.
