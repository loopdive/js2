---
id: 7492
title: "Prepared path: unannotated nested function declarations as placed dynamic closures; statement shapes before and at a function tail"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354, 7349, 7372, 7462]
# 2026-11-26: +2 lines. The void-result join is one condition of the callable signature join in checkAbiExports;
# it has no other home, and the file has no unit it could move to.
loc-budget-allow:
  - src/compiler/ir-program-presentation.ts
---

# #7492 — Prepared path: nested function declarations and statement shapes at a function tail

## Problem

Lane S9's census of ES5 on the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, main `6694a8b8`) counted
777 files that compile and then trap with `unreachable`. Two of its clusters are this issue:

- **Nested function without annotations (39 files).** from-ast's `lowerNestedFunctionDeclaration` lifts a nested
  declaration only with annotated parameters and result, so on JavaScript every nested declaration refuses, and its
  enclosing function gets the abort body (#7354 U). Lane S19 reports that every Annex B function-code file (157) and
  the direct-eval `func-*` files (144) put their block function inside a function or an IIFE, so they cannot pass
  before this works either.
- **Statement shape before or at a function tail (37 files).** `lowerStatementListPrefix` refuses a `Block` and a
  `return` that is not the last statement ("unexpected statement before tail"). `lowerTail` refuses a variable
  statement, a labelled statement, `for-in`, `for-of`, `with`, an empty statement and a function declaration in last
  position ("unsupported tail statement").

`#7349` S3 names the same mechanism for the ordinary pipeline, as one row of its slice table with no design. Its
claim (ttraenkler/senior-dev, 2026-11-15) is untouched by this issue. This issue is the Prepared path's.

## Measured

Census: `scripts/ir-census/prepared-census.mts --harness real` plus a trap-frame join (the abort row whose Wasm
name is the trap's top frame, and the list of all abort rows per file, the same data as open PR #7436). Run on main
`c3b7be66`, 2026-11-26, over 9,174 ES5 files (457 negative skipped). Totals: pass 1,346, fail 777, compile error
6,587, crash 2, timeout 5.

The trap, by the abort that owns it:

| abort detail (trap frame) | files |
|---|---:|
| nested func must have a return type annotation | 31 |
| nested func params must be Identifier-named with annotations | 8 |
| unexpected statement before tail (got Block) | 15 |
| unexpected statement before tail (got ReturnStatement) | 3 |
| unsupported tail statement FirstStatement (a `var`) | 12 |
| unsupported tail statement LabeledStatement | 4 |
| unsupported tail statement With / ForOf / ForIn / FunctionDeclaration | 1 each |
| compile error: unsupported tail statement EmptyStatement (module-init closures) | 4 |

The 39 nested-function files, by what else their test body uses: plain 18, `this` 9, `with` 8, `eval` 4.

## Implementation Plan

### Target structure

1. **One closure path for a nested declaration.** On the native dynamic lane, a function declaration directly in a
   function body (`ts.isBlock(parent) && ts.isFunctionLike(parent.parent)`), whose name nothing else writes
   (`preparedBindingRewritten`), unannotated, with plain identifier parameters, gets the all-dynamic closure
   signature that function expressions already get (`sourceDynamicClosureSignature` in
   `src/ir/source-dynamic-contracts.ts`, now asked with the checker). from-ast lowers it with the existing
   `lowerClosureExpressionWithSignature` / `liftClosureBody` and binds the name as a `local` holding the closure. Its
   own name inside its body is the closure's `__self`, as for a named function expression. Calls through the name
   are the existing closure calls.
2. **Placement, in its own module `src/ir/hoisted-closures.ts`.** FunctionDeclarationInstantiation (§10.2.11 step
   36) makes the function object before the body's first statement. A closure snapshots its immutable captures when
   it is made, and the `var`s above the first use are initialised by then, so the closure is made just before the
   first statement that names it, or the first hoisted declaration that names it. The binding is never written, so
   the later creation is not observable. `placeHoistedClosures` is a pure AST function. from-ast's
   `lowerFunctionBody` (the three body entries: top-level unit, nested lift, closure lift) computes it, and
   `lowerStatementList` makes the placed closures before each statement.
3. **One body-statement dispatcher.** `lowerStatementListPrefix` keeps only what is particular to a statement list:
   a `return` ends the list (the rest is unreachable, and its declarations were placed where they are named), nested
   declarations, inert classes, statement-position calls and the early-return `if`. Every other statement goes to
   `lowerStmt`, whose arms it duplicated line for line (variable statements, assignments, loops, `with`, `for-in`,
   `for-of`, `switch`, `throw`, `try`, `if`/`else`). `lowerStmt` gains the empty statement.
4. **One fall-out rule.** `lowerTail` lowers any other statement with `lowerStmt` and then the implicit return:
   `fallOutReturn` (empty for void, the carrier's `undefined` for a dynamic result, refused before lowering for a
   typed result). The `if`-without-`else` tail's private copy of that return becomes a call to it. A statement list
   ends at its last statement that is not a hoisted declaration.
5. **Provenance.** `sourceFunctionCallee` (a call whose result has the callee's contract) no longer answers for a
   declaration nested in a function. That declaration is a closure of its function, so a call of it carries the
   dynamic value.
6. **Presentation join.** A non-exported function whose checker result is void and whose prepared result is the
   carrier (`return f()` of a closure) joins (`src/compiler/ir-program-presentation.ts`). Before, the program was
   refused as "callable slots disagree". That was already the case on main for `var h = function(){}; function g(){
   return h(); }`.

### What it reuses, what it removes

- Reuses the dynamic closure signature, the closure lowering and lift, `__self`, the closure call path, the
  `#7104` implicit dynamic return, and `lowerStmt`.
- Removes: the duplicated non-tail statement arms in `lowerStatementListPrefix` (about 90 lines), and the
  `if`-tail's private implicit return. from-ast.ts shrinks.

### Not in scope (named, refused or aborting as today)

- Block-level (Annex B) declarations: S19 (#7372 slice 2). It reuses `IrClosureSource` and the creation, and adds a
  writable block binding.
- A captured local written after the closure is made (`k = k + 1` inside the closure): the closure environment's
  presentation refusal ("nondefaultable reference widening"), the same as for function expressions today (#7462).
- `this`, `arguments`, `typeof`, `.length` and `===` on the closure value, and mutual recursion between sibling
  declarations: each a named abort.
- A declaration that captures a `var` declared after its first use: a named abort ("declared after the closure is
  created").

### Acceptance criteria

1. Census as above, on the PR head against main: files gained > 0, files lost 0. Every gained file passes on
   standalone (the Prepared path has no legacy units).
2. A probe matrix against node, covering captures, recursion, use before the declaration, a declaration after
   `return`, a duplicate declaration, nested nesting, an IIFE, and the refused shapes: no wrong value. Every gap is a
   named refusal or abort.
3. Ordinary pipeline and JS-environment bytes are identical on the `scripts/byte-diff-corpus.mts` sample corpus.
4. Quality: one closure creation path. `lowerStatementListPrefix` has no arm that `lowerStmt` also has.
   from-ast.ts does not grow. The new module stays below 100 lines.
5. Pin tests in `tests/issue-7492-prepared-nested-function-declarations.test.ts` that fail on main.
