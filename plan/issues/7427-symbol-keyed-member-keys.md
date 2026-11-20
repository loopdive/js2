---
id: 7427
title: "A built-in member read through its TypeScript symbol is keyed by the escaped name (`__@iterator@<id>`), not the native-prototype key `@@<id>`"
status: in-progress
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
# (2026-11-19) The member key needs the checker to resolve `Symbol` in `[Symbol.iterator]` to the compiler
# library's binding (`memberKeyForProperty` takes a `ts.Symbol`, which the node-keyed oracle cannot express).
# One `ctx.checker` at the reflective-member site, replacing `sym.getName()`.
oracle-ratchet-allow:
  - src/codegen/expressions/calls.ts
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

**Open: bytes.** On the same 349 files, default + standalone, 30 of 681 rows differ between base and branch,
among them the `built-ins/Date/prototype/Symbol.toPrimitive` rows. Not yet explained. Before the PR opens:
diff one of those binaries (WAT) base vs branch, and decide whether it is site 1 (a member now resolving to
`@@3`) or the id-table fold.

## Suspended Work (2026-11-20, budget window closed)

- Branch `claude/7427-symbol-keyed-member-keys`, stacked on `claude/7410-well-known-symbol-names` at
  `805df5008c`, pushed; **no PR yet**. Before opening it, merge #7343's current head into this branch: RV7343
  changed `functionNameForKey` to take a `TypeOracle`, so `memberKeyForProperty` must follow, and the
  `calls.ts` oracle grant can then go too.
- Next steps, in order:
  1. Merge #7343's head and switch `memberKeyForProperty` to the oracle.
  2. Explain the 30 differing byte rows above.
  3. Open the PR with `hold`, base `claude/7410-well-known-symbol-names`, with the table above in the body.
  4. Message the lead.
- Scratch data (session scratchpad, not durable): the base and branch hash rows `bb.jsonl` / `bh.jsonl`; the
  file list is the 349-file set described above.
