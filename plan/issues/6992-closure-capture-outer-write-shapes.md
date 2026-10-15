---
id: 6992
title: "codegen+ir: outer-write detection for closure captures only recognises `x = …`, compound assignment and `++/--` — writes via destructuring, `for (x of …)`, `for (x in …)` and `var` redeclaration leave the capture by-value, so the closure reads a stale snapshot (legacy `planClosureCaptures.collectOuterWrites` and the IR twin `ir/closure-captures.ts`)"
status: ready
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
