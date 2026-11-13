---
id: 6992
title: "codegen+ir: outer-write detection for closure captures only recognises `x = …`, compound assignment and `++/--` — writes via destructuring, `for (x of …)`, `for (x in …)` and `var` redeclaration leave the capture by-value, so the closure reads a stale snapshot (legacy `planClosureCaptures.collectOuterWrites` and the IR twin `ir/closure-captures.ts`)"
status: done
completed: 2026-10-15
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: closures, capture-boxing, destructuring
goal: core-semantics
related: [6991, 6960, 6480, 6872]
# 2026-10-15 (#6992): the write-detection fix is net-negative across the scans,
# but the lowerings that the detection now routes to a ref cell must STORE
# through it. That adds one import line in assignment.ts. It adds one guard plus
# its import in generators-native-consumer.ts: a boxed for-of head leaves the
# native-generator fast path. It adds the for-of / for-in boxed-head arms in
# loops.ts. Each one sits at the lowering it fixes.
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/statements/loops.ts
---

# Outer-write detection misses non-assignment write forms

Found by the 2026-10-15 audit (scoping lane). Same result on `standalone` and `gc`.

## Repro (node → wasm)

| Program | node | wasm |
|---|---|---|
| `var v = 1; const f = () => v; var v = 2; return f()` | 2 | 1 |
| `let a = 1; const f = () => a; [a] = [2]; return f()` | 2 | 1 |
| `let a = 1; const f = () => a; ({a} = {a: 2}); return f()` | 2 | 1 |
| `let a = 1, b = 2; const f = () => a*10+b; [a, b] = [b, a]; return f()` | 21 | 12 |
| `let a = 1; const f = () => a; for (a of [5]) {} return f()` | 5 | 1 |
| `let k = 0; const f = () => k; for (k in {zz: 1}) {} return f()` | "zz" | 0 |

`??=`, `||=`, `**=`, `<<=`, writes through nested `function`, catch destructuring and `switch` are already handled.

## Root cause

- `src/codegen/closures/arrow-phases.ts:763-787` — `collectOuterWrites` inside `planClosureCaptures` recognises only `BinaryExpression` with `EqualsToken` whose `left` is an identifier, prefix/postfix unary on an identifier, and the `PlusEqualsToken..CaretEqualsToken` range. Destructuring targets (`ArrayLiteralExpression` / `ObjectLiteralExpression` on the left of `=`), `ForOfStatement.initializer` / `ForInStatement.initializer` that is an expression (not a `VariableDeclarationList`), and a second `var` declarator for the same name are not writes.
- IR twin: `src/ir/closure-captures.ts:6-45` `collectOuterWrites` and `src/ir/from-ast.ts:16466` `analyseCaptures` use the identical identifier-only detection. The selector currently rejects these bodies, so it is latent there — fix both in the same PR so the two lanes keep the same contract.

## Implementation Plan

1. Extract ONE shared pure helper, e.g. `src/codegen/analysis/binding-writes.ts` → `forEachWrittenBindingName(node, cb)` (or `collectWrittenIdentifiers(root, skip?)`) that reports every identifier an AST subtree WRITES: `=`/compound/logical-assignment to an identifier; destructuring assignment targets (recurse into array/object patterns, including defaults `[a = 1]`, rest `...a`, nested, and `ObjectLiteralExpression` shorthand/property assignments); `++`/`--`; `for-in`/`for-of` initializer expressions (identifier or pattern); `VariableDeclaration` with an initializer whose name is already declared (var redeclaration — report as a write when a declaration of the same name exists earlier in the function; simplest: treat every `var` declarator with initializer as a write). Keep the existing `writesCapturedBinding` declaration check (arrow-phases.ts:758) as the filter on top of the names.
2. Make `arrow-phases.ts` `collectOuterWrites` and `src/ir/closure-captures.ts` `collectOuterWrites` both call the helper. The IR file must stay layer-clean: check `scripts/check-ir-layering.mjs` / `ir-layering-baseline.json` for whether `src/ir` may import from `src/codegen/analysis`; if not, put the helper under `src/shared/` (there is precedent: `src/shared/contracts`).
3. Check `src/codegen/closures.ts:1876` `closureProvablyAfterLetDecl` and `statements/loops.ts` `findNamesWrittenInLoop` for the same identifier-only pattern and route them through the helper too (they decide boxing; same bug class).
4. Tests: the six repros; also a negative control that an unrelated destructuring (`[x] = [1]` where `x` is not captured) does not start boxing (assert via WAT absence of `__boxed_x` or just behaviour + no perf regression claim).

## Acceptance

- All repros match node on standalone and gc.
- Existing `closure*`/`destructur*` equivalence files pass.
- `check:ir-layering` and `check:dead-exports` pass.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6992-closure-capture-outer-write-shapes.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-15)

**The fix has two halves.** Fixing detection alone was not enough. Once a capture is correctly detected as written, it becomes a ref cell, and every lowering that writes the binding must store through that cell. The destructuring, for-of and for-in lowerings did not. They resolved `localMap[name]`, which is now the cell local, and coerced the value into it as if it were the binding's own slot. The result was `ref.null` stored into the cell local: the write was lost, and later reads trapped (`illegal cast`) or read null. Shipping detection without the write-through half would have turned wrong values into traps.

**Detection: one shared contract** (`src/shared/binding-writes.ts`, below both `src/ir` and `src/codegen`. Placed under `src/ir/analysis` it added two codegen-to-ir edges to the import-cycle ratchet's two-way codegen/ir pair, so it lives in `src/shared`):
- `isLexicalBindingWrite(id)` covers:
  - every assignment operator, including `??=`, `||=` and `**=`
  - `++` and `--`
  - destructuring targets: array and object literals, shorthand, property value, `[a = 1]` default, rest/spread
  - for-in and for-of heads
  - parenthesized and type-only wrappers (`as`, `!`, `satisfies`, `<T>`)
- This is the predicate `src/ir/closure-captures.ts` already used privately for `collectTransitiveClosureCaptures`. It moved here and was extended with the type-wrapper arms.
- `varDeclaratorWrittenNames(node)` returns the names a `var` declarator with an initializer assigns. A re-declaration (`var v = 1; … var v = 2`, or a parameter re-declared by `var`) is a write to the existing binding.

**Who uses it:**
- Legacy outer scan: `closures/outer-write-index.ts` `writeTargetsByName` (main's #6988 per-body index, read by `arrow-phases.ts`) indexes with both helpers. A `var` declarator counts unless it IS the captured binding's own declaration (`id.parent !== capturedDeclaration`, identity via `referencedBindingDeclaration`), so the common `var x = 1; … () => x` stays by-value. The index used to count every prefix/postfix unary operand (`!x`, `-x`) as a write; it now counts only `++`/`--`.
- Legacy inner scan, `closures.ts` `collectWrittenIdentifiers`: used by arrow capture planning and by the nested-declaration, literal, object-ops, new-super, IIFE-inline and declaration-write analyses. It now catches destructuring and for-in/for-of writes inside a closure body, so `() => { [a] = [9]; }` mutates the outer `a`.
- IR outer scan, `src/ir/closure-captures.ts` `collectOuterWrites`: name-based like before. A `var` declarator counts as a write when the name was already declared earlier in source order (outer parameters included).
- IR inner scan, `src/ir/from-ast.ts` `analyseCaptures`: the inner `written` set uses `isLexicalBindingWrite`.
- Loop pre-box, `src/ir/analysis/loop-shape.ts` `findNamesWrittenInLoop`: the assignment, update and for-in/of arms are now the shared predicate. That is more precise than the old target-subtree walk, which also counted property keys and the right side of a default. The declaration arm is unchanged.
- `closures.ts` `closureProvablyAfterLetDecl` (plan step 3): checked. It is a TDZ / position test with no write detection, so there was nothing to route.

**Write-through:**
- `identifier-assignment.ts` `emitResolvedIdentifierWriteFromStack`: the shared identifier writer behind the destructuring lowerings (42 call sites). It now stores through the cell when the target local is a boxed capture's cell. The store is null-guarded, after the conditional-box repair, exactly like the boxed `x = v` path.
- `identifierLocalValueType` gives destructuring defaults their value type instead of the cell's struct type. Ten sites in `assignment.ts` use it.
- for-of: `forOfIdentifierHeadLocal` gives a boxed head a scratch value local, and `tryEmitForOfIdentifierWrite` stores it through the cell. This covers the string, array, direct-iterator, iterator and `keys()` lowerings. The native-generator fast path declines a boxed head and falls back to the generic path.
- for-in: `forInIdentifierHeadLocal` plus a boxed-head arm in `emitForInHeadWrite` covers all three lowerings (array, static unroll, dynamic).

**Tests:** `tests/equivalence/issue-6992-outer-write-shapes.test.ts` has 24 cases on gc and standalone:
- the six repros
- rename+default, nested and rest targets
- parameter re-declared by `var`, and a parameter written by destructuring
- writes inside the closure (destructuring, for-of, for-in)
- for-of over a string, over `keys()`, and with a destructuring head
- loop bodies that read the boxed head
- for-in over an array
- `var` re-declared inside a loop
- the negative control (uncaptured target)

Every case except the negative control and "destructuring before the closure exists" fails on base.

**Left out, measured, out of scope (adjacent notes, not code):**
- Closures BUILT INSIDE a for-of loop whose head is an outer binding. Same result on base and here:
  - `let a = 0; for (a of [1, 2, 3]) fs.push(() => a); fs[0]() * 10 + a`: node 33, wasm 13.
  - for-in/for-of head names are excluded from the #6960 loop pre-box (`findForInOfHeadNames`). Each iteration's closure therefore gets a fresh cell from the construction site.
  - This is the #6960 per-loop-kind family, not write detection.
- gc-lane rest destructuring with no closure at all:
  - `let a = 1; let r: number[] = []; [[a], ...r] = [[4], 1, 2]; return a + r.length`: gc wasm null, node 6. It passes on standalone.
  - Same on base. It is unrelated to capture boxing.
- `ir-layering` reports 87 import lines against a baseline of 90 ("improved"). The baseline was not touched: main is its only writer.


## Merge-group regression fix (2026-10-18)

The merge-group run parked this PR: ES5 `language/arguments-object/10.6-6-3.js` and `10.6-6-4.js` went pass → fail on standalone (`illegal cast in __closure_47`).

- **Shape:** `var arguments = undefined; (function () { arguments.length })();`
- **Why:** a nested function expression's `arguments` is its own implicit binding. The planner cannot find its declaration (`referencedBindingDeclaration` returns `undefined`), and an unknown identity counted every same-spelled write. Once `var` declarators became write targets, the outer `var arguments = undefined` counted as a write. The inner `arguments` was then lowered through a ref cell.
- **Fix:** in `capturedBindingWriteTest` (`closure-binding-identity.ts`), a `var` declarator is a write only when it re-declares a KNOWN captured declaration. It is never the binding's own declarator, and it never counts when the declaration is unknown. That is the pre-#6992 answer for the unknown case. Explicit `x = …` writes are unaffected. The own-declarator check moved out of `arrow-phases.ts` into this helper.
- **IR side:** `collectOuterWrites` (`src/ir/closure-captures.ts`) counts a declarator only when the name was already declared, so a first `var arguments` is not a write there. Nothing changed.
- **Left out (pre-existing, same at 61a64992bc without this fix):** an ARROW that reads an outer `var arguments` does not see a later `arguments = 5` (it returns 1, sloppy JS returns 5). This fix does not cause it, and its cause has not been investigated.
