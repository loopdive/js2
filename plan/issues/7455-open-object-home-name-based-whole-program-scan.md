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

## Implementation Plan (covers #7455 and #7457; rev 2, 2026-11-26, main 41f0654e8c)

Revision 2 answers plan review PRV-7455 on b62216ed (blockers 1–3, findings 4–7).

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

- **New module `src/shared/binding-write-index.ts`, with one exported query:**
  `bindingWrites(checker, files, symbol): readonly IdentifierWrite[]`.
  - It returns the identifier writes in `files` whose target resolves to `symbol`.
  - Each file's index is built once and cached per `(checker, file)` in a `WeakMap`.
  - The build is one `ts.forEachChild` walk calling `identifierWritesOf(node)`, the one write-form enumerator.
  - A target resolves through `getSymbolAtLocation`, or through `getShorthandAssignmentValueSymbol` for a
    shorthand. That symbol is then de-aliased by the one `deAliasedSymbol(checker, symbol)` helper, which moves
    here from `imported-functions.ts`.
  - A target whose resolution throws or yields no symbol is skipped, as the planner's `try`/`catch` does today
    (finding 5). The `try`/`catch` stays in the index.
  - No other field. Callers that care about `with` or `eval` already ask `hasDynamicScope` /
    `sourceRunsDynamicCode` (finding 6).
- **Which files a query covers (finding 7), one rule stated at the query:** the caller passes them.
  - The planner passes its `sourceFiles`, as today.
  - Script-var callers pass the declaring file in PR 1. That is today's scope, so PR 1 stays byte-identical.
  - PR 3 widens the script-var callers to every script of the program, because scripts share the global
    object (§9.1.1.4). A write in another script then refuses. Each changed admission is listed as a fix.
- **De-aliasing is a no-op for a script binding (finding 5).** A `var` or function declaration's symbol has no
  `SymbolFlags.Alias`, so `deAliasedSymbol` returns it unchanged. Only import bindings are aliases. The PR 1
  byte check confirms it.
- **`module-binding-script-var.ts`.**
  - `identifierWrites` becomes `bindingWrites(checker, [file], symbol)`.
  - `scriptVarWrites` and `preparedBindingRewritten` keep their signatures and semantics.
  - `identifierWritesCache` and its walk go.
- **`imported-functions.ts` (#7457).**
  - `reassigned` becomes: `bindingWrites(checker, sourceFiles, target)` has a write other than the function's
    own declaration.
  - `scanWrites`, `scanAssignmentTargetWrites`, `scanBindingNameWrites` and the local `deAlias` are deleted:
    about 100 lines, one duplicate enumerator.
- **`dynamic-home-open-object.ts` (#7455).** `everyUseIsServed` splits into two named predicates:
  1. **Binding question**, `scriptVarHoldsItsInitializer(checker, decl)` in `module-binding-script-var.ts`,
     next to `scriptVarWrites`. On the ordinary pipeline, true when **all** of:
     - **One binding site for the name in the file (blockers 1–3).** Counted by name through the file's
       existing spelling index (`spellingsOf`, the same module) and `isBindingSiteName`. The count is not
       `symbol.declarations`: a `.js` expando (`o.p = 1`) adds a declaration there (blocker 3).

       A name count is what refuses the routes the checker does not bind to the script var. Each adds a
       second binding site of the name:
       - a parameter initializer writing a body `var` of the same name (blocker 1, §10.2.11);
       - an Annex B block function (blocker 2, §B.3.3);
       - a catch parameter re-declared by `var` (§B.3.5).

       Today's name-based scan refuses them for the same reason.
     - **No write except the declaration's own initializer:** `bindingWrites`, by checker identity. Once the
       single-binding-site rule holds, every resolved write of the name is a write of this symbol, so this
       matches today's name-based write test. A write the checker cannot bind sits inside `with`, which the
       next condition refuses.
     - **No `with` and no dynamic code:** `sourceRunsDynamicCode`, which keeps today's refusal of every `eval`
       spelling. An indirect `(0, eval)("o = 1")` writes a script `var`.
     - **The global object does not escape:** `sourceMayWriteGlobalObject`.
     - **No member of the name is written:** `sourceWritesMemberNamed` (`this.o = v` writes the script `var`).
  2. **Realm question**, `objectPrototypeStaysRealms(file)`, defined as
     `!sourceMayPatchPrototype(file, "Object") && !sourceNamesReflectiveRoute(file)`. It lives in
     `intrinsic-prototype-writes.ts`, next to its two parts.

  `everyUseIsServed` becomes the conjunction of 1, 2 and the existing served-uses scan.
  `bindingIsUniqueAndNeverWritten` keeps its codegen callers (6 legacy sites). Folding them is a separate
  issue. Its IR caller goes.
- **Checker access.** `src/ir` callers already hold a checker. The oracle ratchet covers `src/codegen` only,
  which this change does not touch.

### Order: three PRs, each byte-checked

1. **Index plus the `module-binding-script-var.ts` switch, with today's scope.**
   - Expected: byte-identical everywhere.
2. **#7457, the planner fold.**
   - **Before** the old scanner is deleted, a throwaway differential computes the old `reassigned` set and the
     index-derived set over the equivalence corpus and the shared sample. It lists every symbol where they
     differ.
   - Its output is recorded in the PR body, with each difference classified (finding 4). One is known by
     reading: `identifierWritesOf` counts a top-level `var f = 1` that merges with `function f(){}`, and the
     planner does not.
   - A write the planner missed is a fix: a cached funcref for a rewritten binding is wrong. Anything else
     stops the slice.
   - What gets committed is per-form behaviour tests, not a self-comparison: var merge, destructuring default,
     `for (f in o)` head, shorthand target, aliased import.
3. **#7455, the predicate split plus the scope widening.**
   - The admission set is **measured** before and after: the carriers `isReference` admits over the
     equivalence corpus, the playground examples and the shared sample. The plan makes no prediction of its
     direction (blocker 3).
   - Each changed admission is listed in the PR body and classified as a fix (refusal of a real write route)
     or a regression (must be zero).
   - Committed kill tests, one program per route, each refused: a parameter initializer, an Annex B block
     function, a catch-param `var`, `with`, direct `eval`, indirect `eval`, `this.o = v`, and a write in
     another script.

### Acceptance criteria

1. **Correctness.**
   - The PR 2 per-form tests and the PR 3 route kill tests are committed.
   - The PR 2 differential and the PR 3 admission diff are in their PR bodies, each difference classified.
2. **Byte identity.**
   - Prepared path: identical output sha1 before and after each slice on two inputs:
     - the shared 411-row Prepared sample, `plan/samples/7354-o411.txt` with its tally script (branch
       `claude/7354-o411-sample` 155b06691f; no second sample);
     - the full-prelude program. On main 41f0654e8c it gives source sha1 c70fb78b → output 8708895d with
       `FN_STANDIN_C1=1`, and 6ea9a0d0 → 932570e5 without.
   - Ordinary pipeline: the `tests/equivalence/` corpus and the playground examples emit identical bytes in
     PR 1. In PRs 2 and 3, only listed and classified differences.
3. **Compile time.**
   - Full prelude: median of 5 runs not slower than main's (3.6–4.2 s on a 4-core box; both measured on the
     same box, same session).
   - Counted with a temporary probe: the binding-write walk runs once per source file per compile, instead
     of once per queried name.
4. **Code quality.**
   - One write-form enumerator (`identifierWritesOf`).
   - One de-alias helper.
   - One write query, `bindingWrites`.
   - The two #7455 questions are separate named predicates.
   - Net LOC negative.
   - No new module-level mutable state besides the index's `WeakMap` cache.
5. **Gates.** loc, func, coercion, oracle, dead-exports, import-cycles, and the compiler-boundaries inventory.
   The new module is classified like `binding-writes.ts`, its enumerator, and its three callers:
   `mixed-needs-split`, destination `ir-core`. It reads TypeScript checker symbols, so it cannot be a
   clean layer of its own. Also run loc and func with `LOC_GATE_BASE=$(git rev-parse origin/main)`.
