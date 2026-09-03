---
id: 5285
title: "The module-init storage census cannot be measured — the diagnostic reads a fail-fast path, so every file reports exactly one blocker"
status: done
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3523, 3518, 2856]
loc-budget-allow:
  # 2026-09-03 (#5285, the survey itself): restated here as well as in #3523,
  # so the grant is not stranded if a later change-set touches only this file.
  # +106 `src/ir/integration.ts`, +44 `src/ir/module-bindings.ts`, +10 each
  # `src/codegen/context/types.ts` and `src/codegen/index.ts`, +3
  # `src/index.ts`. All additive and inert — the survey runs only under the
  # existing `JS2WASM_IR_SHAPE_DIAG=1` gate and 66/66 playground + dogfood
  # compiles are byte-identical on both lanes with the flag off. The survey
  # lives beside `buildModuleBindingsMap` because the reviewer's question is
  # "do these two ask `inspectDirectBinding` the same question, and does only
  # one of them stop?" (Implementation Plan, step 1).
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/index.ts
func-budget-allow:
  # 2026-09-03 (#5285): +24 lines in `compileIrPathFunctions` — the gated survey
  # call and the comment recording why it is not at the `buildModuleBindingsMap`
  # call site. The resolver and the module-init population are in scope only
  # inside this function.
  - src/ir/integration.ts::compileIrPathFunctions
---

## Problem

R4 slice selection is currently blind. The question it needs answered — *which
module-binding storage extensions unlock the most files, and in what order* —
has no instrument that can answer it, and the instrument that appears to answer
it returns a fixed shape regardless of the corpus.

`buildModuleBindingGlobals` (`src/ir/integration.ts:5839-5846`) walks a file's
top-level declarations in source order and **throws on the first one with no
supported storage**:

```ts
const inspected = resolveModuleBinding.inspectDirectBinding(d.name);
if (inspected.kind === "unsupported") {
  throw new IrUnsupportedError(
    "module-init-legacy-coupling",
    "build",
    `module-init: top-level binding '${name}' has no supported legacy storage representation`,
  );
}
```

The `JS2WASM_IR_SHAPE_DIAG` recorder sits on the `unsupported` return inside
`inspectDirectBinding`, so it fires **at most once per file**. A file with five
distinct blockers and a file with one are indistinguishable to it.

This is not hypothetical harm. On 2026-09-03 the 13-file dogfood census produced
by that instrument read "every file has exactly ONE blocking category, no file
mixes them," and the conclusion drawn was that per-category payoffs are
independent and additive. Both were wrong, and a best-set-of-size-N ranking and
a dispatch brief were built on them. `tests/dogfood/corpus/escapes-unicode.js`
refutes it in five lines:

```js
const a = "\u{1F600}é\n\t\\";   // line 1 — string, the only blocker recorded
…
const obj = { "b": 2 };          // line 5 — object literal, also unrepresentable
```

R4-M1 (PR #5511) then shipped the predicted string extension and measured the
corpus independently: `vardecl-module-storage-unrepresentable` **20 → 17 rows**,
moving `templates.js` (both lanes) and `regex.js` (standalone). `escapes-unicode.js`
did not move — the prediction failed on precisely the file the artifact
mis-described. Full retraction in
`plan/issues/3523-ir-r4-module-init-compile-once.md`.

**Why this blocks rather than annoys.** `<module-init>` is one unit per source
file and one unrepresentable declaration rejects the whole unit, so the only
thing that converts a storage extension into R9 progress is covering *every*
category a file carries. The per-category counts are therefore lower bounds, and
ranking extensions by them is ranking by an unknown.

## Acceptance criteria

1. A diagnostic mode reports **every** unrepresentable top-level declaration in
   a file, not the first — for each: file, binding name, declared type string,
   initializer `SyntaxKind`, and the refusing arm.
2. The production path is **byte-identical and fail-fast as today**. The
   diagnostic must not change when compilation stops, what it emits, or the
   `IrObservedOutcome` a normal run records. Prove it: sha256 over the
   playground + dogfood corpora on both lanes, diagnostic off, base vs new.
3. Re-run the 13-file dogfood census under the new mode and publish the **true**
   per-file category multiset in `#3523`, replacing the retracted table.
4. The census output states, per file, how many categories remain — so "files
   unlocked by covering set S" becomes computable rather than assumed.
5. A test that would have caught the original defect: a fixture with **two
   different** unrepresentable declarations asserts the diagnostic reports
   **both**. A first-blocker-only implementation fails it.

## Implementation Plan

**Shape: a separate non-throwing survey, not a change to the throwing loop.**
Do *not* make `buildModuleBindingGlobals` collect-and-then-throw. That function
is on the production path; widening it to keep walking after the first refusal
risks work after a known-unsupported binding and buys nothing, since production
correctly wants to stop. Add a survey that reuses the same resolver.

1. **New function beside it** in `src/ir/integration.ts` (adjacency matters —
   a reviewer must be able to see that the two ask `inspectDirectBinding` the
   same question):

   ```ts
   export interface IrModuleBindingRefusal {
     readonly name: string;
     readonly declaredType: string;
     readonly initializerKind: string | undefined;
   }
   function surveyModuleBindingRefusals(
     population: readonly ts.Statement[],
     resolveModuleBinding: IrModuleBindingResolver,
   ): readonly IrModuleBindingRefusal[];
   ```

   Same iteration as `buildModuleBindingGlobals`, but it **records and
   continues** instead of throwing, and never calls `resolveModuleBindingGlobal`
   (no ctx mutation, no global registration — the survey must be inert).

2. **Call it only under the existing env gate.** `JS2WASM_IR_SHAPE_DIAG=1`
   already exists as the opt-in reject-arm recorder (#2856 Step-1); extend it
   rather than adding a second flag. Gate at the call site, so a production run
   never enters the survey at all.

3. **Emit into the outcome record.** Attach the refusal list to the
   `<module-init>` unit's `IrObservedOutcome` under the diagnostic gate. This is
   what makes the census a single corpus run instead of a log scrape, and it is
   what a `check:ir-only` lane could later assert on.

4. **Non-BMP / escaped identifiers.** `escapes-unicode.js` carries a non-ASCII
   binding (`const id = café`). Record `d.name.text`, not source slices.

5. **Test** — `tests/issue-5285-module-init-refusal-survey.test.ts`: a fixture
   with a string binding *and* an object-literal binding *and* a bigint,
   asserting the survey returns all three in source order; plus the byte-identity
   check from criterion 2 with the flag off.

**Order-preservation constraint.** Refusals must come back in **source order**.
The census's value is partly "which blocker is first," since that is what every
historical measurement recorded — keeping the order lets old numbers be
reconciled with new ones instead of discarded.

**Sizing.** One file's worth of additive code plus a test; no existing behaviour
changes. `horizon: s`. The risk is not complexity, it is accidentally putting
the survey on the production path — which criterion 2 is designed to catch.

## Notes

The generalisable lesson, recorded because it cost a dispatch brief and a
retraction: **name the instrument and ask what answer it is incapable of
returning.** A fail-fast code path read as a survey reports "exactly one" every
time, and does so in the shape of a clean, surprising, actionable finding. The
tell was free — "no file mixes categories" across 13 independent real-world
files is far too tidy — and one `grep` of any file in the table would have shown
it.
