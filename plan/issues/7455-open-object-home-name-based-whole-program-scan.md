---
id: 7455
title: "Ordinary pipeline: `everyUseIsServed` is a third name-based whole-program scan of script-binding writes"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: medium
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7455 — Ordinary pipeline: `everyUseIsServed` is a third name-based whole-program scan of script-binding writes

## Problem

`everyUseIsServed` in `src/ir/dynamic-home-open-object.ts` (about lines 85-115) decides whether an open-object home is safe with `bindingIsUniqueAndNeverWritten` + `sourceWritesMemberNamed` + a reflective-route scan. Slice H2 of #7354 deleted the same kind of scan on the Prepared path, where every other route refuses at its own site. On the ordinary pipeline that argument does not hold (`eval`, `with` and the global object are live), so it was not folded. It also asks a second question: whether `Object.prototype` stays the realm's own.

## Acceptance criteria

- The two questions are separate predicates.
- The binding-write question uses the one writes query in `src/ir/module-binding-script-var.ts`.
- Ordinary-pipeline output is byte-identical on the equivalence corpus, or every difference is a fix.

## Implementation Plan (covers #7455 and #7457; 2026-11-26, main 41f0654e8c)

One idea: **one binding-write index per source file**, built in one walk and
keyed by checker identity. The three scans that answer "is this binding
written" today each walk the whole file on their own:

| scan | file | keyed by | walks |
|---|---|---|---|
| `identifierWrites` (behind `preparedBindingRewritten`, `scriptVarWrites`) | `src/ir/module-binding-script-var.ts` | checker symbol | the whole file, once per queried name |
| `reassigned` (`scanWrites`, `scanAssignmentTargetWrites`, `scanBindingNameWrites`) | `src/ir/imported-functions.ts` ~L360–455 | de-aliased symbol | every program file, once per resolver |
| `bindingIsUniqueAndNeverWritten` | `src/shared/binding-writes.ts` L517 | name text | the whole file, once per carrier declaration |

The first two enumerate write forms separately:
- `identifierWritesOf`, the shared enumerator in `binding-writes.ts`;
- a private re-implementation in `imported-functions.ts`.

After #7354 H2 the Prepared path's soundness depends on the two agreeing (#7457).

### Target structure

- **New module `src/shared/binding-write-index.ts`.** `bindingWriteIndex(checker, sourceFile)` is cached per
  `(checker, sourceFile)` in a `WeakMap`. One `ts.forEachChild` walk calls `identifierWritesOf(node)` at each
  node, the one write-form enumerator, and records:
  - `writesOf(symbol)`: the `IdentifierWrite`s of a binding, keyed by the **de-aliased** symbol. A shorthand
    target resolves through `getShorthandAssignmentValueSymbol`, as `identifierWrites` does today. De-aliasing
    moves here from `imported-functions.ts` as the one `deAliasedSymbol(checker, symbol)` helper.
  - `unresolvedWrites`: the writes whose target has no symbol (inside `with`).

  The module answers only "which writes reach this binding". Route questions (global object, dynamic code,
  `with` / direct `eval`) stay with the existing predicates in `intrinsic-prototype-writes.ts` and
  `binding-writes.ts`. Callers combine the two.
- **`module-binding-script-var.ts`.**
  - `identifierWrites` becomes `bindingWriteIndex(checker, file).writesOf(symbol)`.
  - `scriptVarWrites` and `preparedBindingRewritten` keep their signatures and semantics.
  - `identifierWritesCache` and its walk go.
- **`imported-functions.ts` (#7457).**
  - `reassigned` becomes: the target's de-aliased symbol has a write in the index of one of the resolver's
    `sourceFiles`, other than its own declaration.
  - `scanWrites`, `scanAssignmentTargetWrites`, `scanBindingNameWrites` and the local `deAlias` are deleted:
    about 100 lines, one duplicate enumerator.
- **`dynamic-home-open-object.ts` (#7455).** `everyUseIsServed` splits into two named predicates, each in one
  place:
  1. **Binding question**, `scriptVarHoldsItsInitializer(checker, decl)` in `module-binding-script-var.ts`,
     next to `scriptVarWrites`. On the ordinary pipeline, true when:
     - the symbol has exactly one declaration (this replaces the name-count `bindings === 1`);
     - the index has no write but the declaration's own initializer;
     - there is no `with` and no dynamic code: `sourceRunsDynamicCode`, which keeps today's refusal of every
       `eval` spelling, because an indirect `(0, eval)("o = 1")` writes a script `var`;
     - the global object does not escape (`sourceMayWriteGlobalObject`);
     - no member of the name is written (`sourceWritesMemberNamed`; `this.o = v` writes the script `var`).
  2. **Realm question**, `objectPrototypeStaysRealms(file)`, defined as
     `!sourceMayPatchPrototype(file, "Object") && !sourceNamesReflectiveRoute(file)`. It lives in
     `intrinsic-prototype-writes.ts`, next to its two parts.

  `everyUseIsServed` becomes the conjunction of 1, 2 and the existing served-uses scan.
  `bindingIsUniqueAndNeverWritten` keeps its codegen callers (6 legacy sites). Folding them is a separate
  issue, not this change. With this change its IR caller goes.
- **Checker access.** The index takes the checker it is given. `src/ir` callers already hold one
  (`module-binding-script-var.ts` takes `checker`; `makeIrImportedFunctionResolver` has it). The oracle ratchet
  covers `src/codegen` only, which this change does not touch.

### Order: three PRs, each byte-checked

1. **Index plus the `module-binding-script-var.ts` switch.**
   - Expected: byte-identical everywhere. Same enumerator, same symbol rule; only the walk is shared.
2. **#7457, the planner fold.** Before switching, a differential test computes the old `reassigned` set and
   the index-derived set over the equivalence corpus and the test262 ES5 files (Prepared and ordinary), and
   lists every symbol where they differ. Known difference by reading:
   - `identifierWritesOf` counts a top-level `var f = 1` that merges with `function f(){}` (`varDeclaratorWrites`);
   - the planner sees only for-in/for-of head declarators.

   Each difference is classified. A write the planner missed is a fix: a cached funcref for a rewritten
   binding is wrong. Anything else stops the slice. The differential's list goes into the PR body.
3. **#7455, the predicate split.** The binding predicate is symbol-based where the old one was name-based. A
   same-named local elsewhere in the file no longer refuses, so admissions can only grow, and each new one is
   listed. The dynamic-code, global-object and member-write refusals are kept as they are, so no admission
   grows through `eval`, `with` or the global object.

### Acceptance criteria

1. **Correctness.**
   - The differential test for slice 2 is committed: `tests/issue-7457-binding-write-agreement.test.ts`.
   - It asserts that both analyses agree on the corpus, after the fold, by construction.
   - It includes a program per known difference form: `var f = 1` merging, a destructuring default, a
     `for (f in o)` head, a shorthand target, an aliased import.
2. **Byte identity.**
   - Prepared path: the test262 ES5 sample used by the IR census gives identical output sha1 before and after
     each slice, and so does the full-prelude program. On main 41f0654e8c the full prelude is source sha1
     c70fb78b → output 8708895d with `FN_STANDIN_C1=1`, and 6ea9a0d0 → 932570e5 without.
   - Ordinary pipeline: the `tests/equivalence/` corpus and the playground examples emit identical bytes.
     Every listed difference from slices 2 and 3 must be a classified fix, with a test.
3. **Compile time.**
   - Full prelude: median of 5 runs not slower than main's (3.6–4.2 s on a 4-core box; measure both on the
     same box, same session).
   - Counted with a temporary probe: the binding-write walk runs once per source file per compile, instead
     of once per queried name.
4. **Code quality.**
   - One write-form enumerator (`identifierWritesOf`).
   - One de-alias helper.
   - The two #7455 questions are separate named predicates.
   - Net LOC negative: the planner's private scanner and the `identifierWrites` walk go.
   - No new module-level mutable state besides the index's `WeakMap` cache.
5. **Gates.** loc, func, coercion, oracle, dead-exports, import-cycles, and the compiler-boundaries inventory.
   The new module is classified like `binding-writes.ts`, its enumerator, and its three callers:
   `mixed-needs-split`, destination `ir-core`. It reads TypeScript checker symbols, so it cannot be a
   clean layer of its own. Also run loc and func with `LOC_GATE_BASE=$(git rev-parse origin/main)`.
