---
id: 4433
title: Top-level expression statements are dropped whole — operand side effects and operator TypeErrors eliminated
status: in-progress
assignee: ttraenkler/claude-es5-standalone
sprint: current
goal: standalone-gap
es_edition: 5
task_type: bug
priority: high
horizon: m
# Both the predicate and the shared exit live in the subsystem module
# (module-init-collection.ts). The collector keeps only two call sites and the
# comment explaining why the DEFAULT changed rather than gaining a ninth
# allow-list arm (#3623's whole point) — a net +3 lines.
loc-budget-allow:
  - src/codegen/declarations.ts
---

## Problem

A bare expression statement at **module top level** whose expression is not on
`collectDeclarations`' allow-list is dropped **whole** — its operands are never
evaluated, so calls, getters and the operator's own TypeError all disappear. The
program produces a silent wrong answer and any test covering the statement is a
**vacuous pass**.

Found during #2916 verification. Reproduces with a **builtin** RHS on base
`identifiers.ts`, so it is not specific to the #2916 native-instanceof helper.

```js
var hit = 0;
function a() { hit = hit + 1; return 1; }
function b() { hit = hit + 10; return 2; }

a() + b();              // hit stays 0 — NEITHER call ran
a() instanceof Object;  // hit stays 0 — the call never ran
```

The identical statements inside a function body have always worked
(`compileStatement`'s `ExpressionStatement` arm compiles then `drop`s). This is a
**collection** gap, not a lowering gap — the eighth instance of the defect family
already catalogued in `src/codegen/module-init-collection.ts` (#1268, #2671,
#2992, #3366, #3468, #3592, #3615, #4181).

It is the **second, independent** blocker for test262
`language/expressions/instanceof/S15.3.5.3_A2_T2.js`, `_T5.js`, `_T6.js`: each
spells the operator as a bare statement inside a `try` and expects its TypeError.
If the statement is dropped, no tri-state answer can ever throw. Anyone
attributing those three to the #2916 closure-RHS prototype gap alone fixes the
wrong thing.

## Elimination site

`src/codegen/declarations.ts`, the top-level `ExpressionStatement` arm of
`collectDeclarations` (~L2170–L2520). It is an **allow-list**: `new`/call,
`++`/`--`, `delete`, property/element read, and assignment operators with a
recognised target are pushed into `ctx.moduleInitStatements`; **everything else
falls off the end and is dropped**. Two exits reach the drop:

- L2269 — a non-assignment `BinaryExpression` `continue`s out (`a() + b()`,
  `a() instanceof Object`, `a(), b()`, comparisons, `&&`/`||`/`??`).
- L2510 — the terminal fall-through (conditional, array/object literal, template,
  `typeof`, `as`/`!` casts).

`classifyTopLevelExpressionStatement` (#3623) already classifies every statement
totally into `keep` / `inert` / `unhandled` and **records** the `unhandled` drops
in `ctx.droppedModuleInitShapes` — but recording was all it did. #3623
deliberately left "should `unhandled` be compiled?" to a separate measured
landing. This issue is that landing, restricted to the statements that
**provably can run user code**.

## Blast radius (measured on this branch, before the fix)

`.tmp/probe5.mts` — same statement at top level vs. inside a function; `want` is
the correct hit count, `*` marks a wrong answer.

| statement               | want | top level | in function |
| ----------------------- | ---- | --------- | ----------- |
| `a();`                  | 1    | 1         | 1           |
| `a() + b();`            | 11   | **0**     | 11          |
| `a() - b();`            | 11   | **0**     | 11          |
| `a() * b();`            | 11   | **0**     | 11          |
| `a() < b();`            | 11   | **0**     | 11          |
| `a() == b();`           | 11   | **0**     | 11          |
| `a() && b();`           | 11   | **0**     | 11          |
| `a(), b();`             | 11   | **0**     | 11          |
| `a() instanceof Object;`| 1    | **0**     | 1           |
| `a() ? b() : b();`      | 11   | **0**     | 11          |
| `[a(), b()];`           | 11   | **0**     | 11          |
| `({p: a()});`           | 1    | **0**     | 1           |
| `a() + 1;` / `1 + a();` | 1    | **0**     | 1           |
| `typeof a();`           | 1    | **0**     | **0**       |
| `-a();` `!a();` `void a();` `(a());` | 1 | 1 | 1 |

So the operator is irrelevant: **every** non-assignment binary operator, the
conditional operator, array/object literals and parenthesised compositions lose
their operands' effects at top level. `instanceof` is one member of the family —
independently confirmed from the #2916 lane, where a bare
`lhs() instanceof Object;` (a **builtin** RHS, which never reaches that issue's
dynamic-RHS substrate) also evaluated neither operand.

`typeof a();` is the one shape wrong in **both** positions — a second, distinct
elimination site (below).

Corpus scale (`.tmp/measure-shapes.mts` over all of `test262/test/language` +
`built-ins`, 47,819 files): 153,978 top-level expression statements, of which
**18,770 classify `unhandled`** across **642 files**. The bulk are bare
`Identifier` (9,242) and `PrivateIdentifier` (8,935) atoms from negative
*syntax* fixtures, which run no user code and are deliberately left alone. The
compositional shapes this issue collects are the remaining ~590:
`BinaryExpression(Comma)` 141, `TaggedTemplateExpression` 85,
`ObjectLiteralExpression` 69, `AwaitExpression` 67, `In` 28, `TypeOf` 27,
arithmetic/comparison operators ~110, `ArrayLiteralExpression` 10,
`instanceof` 8, `ConditionalExpression` 4, casts 5.

## Fix

Keep the allow-list's `keep` arms exactly as they are and change only the
**default**. A dropped statement is now re-examined: if its expression tree
**provably can run user code** — it contains a call, `new`, tagged template,
`delete`, `++`/`--`, an assignment, or a property/element read, not counting
nodes inside an un-invoked function/arrow body — it is collected into
`__module_init` and lowered by the ordinary compile-then-`drop` path.

Statements that are *not* provably effectful keep today's behaviour and stay
recorded in `ctx.droppedModuleInitShapes`. That is deliberate: a blanket flip
would also collect the 18k bare-`Identifier`/`PrivateIdentifier` atoms out of
negative syntax fixtures, whose correct behaviour is a ReferenceError this
compiler does not model — turning silent passes into compile errors, which is a
worse trade than the honest residual. The direction is monotone: this only ever
*adds* statements, never removes one.

Second site, statement position only: a bare `typeof <expr>;` where `<expr>` is
not an identifier reference now compiles the **operand** and drops it. The
`typeof` result is unused in statement position, and `compileTypeofExpression`
const-folds on the static TS type without ever emitting the operand. A bare
identifier operand keeps the current path — §13.5.3 requires `typeof undeclared`
NOT to throw.

### Changed files

- `src/codegen/module-init-collection.ts` — `expressionRunsUserCode` (the
  predicate) and `collectOrRecordUnnamedExpressionStatement` (the shared exit).
- `src/codegen/declarations.ts` — the two inline drops become two calls to that
  exit; net +3 lines in the collector.
- `src/codegen/statements.ts` — `bareTypeofStatementOperand`, and the
  `ExpressionStatement` arm extracted to `compileExpressionStatement` so the
  dispatcher stays under its function budget.
- `tests/issue-4433.test.ts` — 22 pinned cases.

## Verification

### Probes (`.tmp/probe5.mts`, `.tmp/probe6.mts`)

All 19 shapes in the blast-radius table above are correct at top level and
inside a function after the fix (before: 14 of 19 wrong at top level, 1 wrong in
both positions). The elisions that must survive are separately pinned and hold:
short-circuit `&&`/`||` still skip the RHS, a conditional evaluates only the
taken arm, an un-invoked `(function () { … });` still runs no body, and
`typeof zzzUndeclared;` still does not throw. The operator's own TypeError now
propagates out of a bare statement (`f() instanceof 42;` → caught, was silently
nothing).

### test262 — the affected population, in full

`.tmp/find-affected.mts` walks all 47,533 files of `test/language` +
`test/built-ins` for statements whose collection this change flips. Under the
final predicate that is **83 files: 25 with an ordinary frontmatter, 58 with a
`negative:` one.** Both groups were run before and after (`.tmp/run-batch.mts`,
standalone lane).

**Group 1 — the 25.** Measured as part of a **79-file superset**: that list was
built with the predicate's first cut, before `TaggedTemplateExpression` and bare
`await` were removed, so it strictly contains the final 25 plus every file the
narrowing dropped. Running the superset is what produced the evidence for the
narrowing itself, so it is reported as run:

| | pass | fail | compile_error | skip |
| --- | --- | --- | --- | --- |
| before | 30 | 46 | 2 | 1 |
| after | 31 | 45 | 2 | 1 |

**Net +1 (+2 / −1).**

- `language/expressions/comma/S11.14_A3.js` fail → **pass**
- `language/module-code/top-level-await/void-await-expr.js` fail → **pass**
- `language/module-code/top-level-await/await-expr-regexp.js` pass → **fail**
  — see the residual below; its previous pass was vacuous.

The single `skip` is `language/import/import-defer/…`, which `shouldSkip` skips
**unconditionally** — verified in `tests/test262-runner.ts`, not assumed from a
local run (see the correction below for why that distinction is load-bearing).

**Group 2 — the 58 `negative:` files.** `pass 50 / fail 7 / compile_error 1`
before, **identical** after: **no status change on any of the 58.** That is the
expected direction — the change can only add evaluation, and a negative test is
scored on whether an error is raised — but it is now measured rather than
assumed.

**Both groups, in the JS-host / GC lane.** Neither changed site is target-gated —
`collectOrRecordUnnamedExpressionStatement` and `compileExpressionStatement` run
for every target — so the standalone runs above measure the behaviour but not
the other lane's outcome. All 83 re-run with no `target` argument:

| | pass | fail | compile_error | skip |
| --- | --- | --- | --- | --- |
| before | 55 | 26 | 1 | 1 |
| after | 57 | 24 | 1 | 1 |

**Net +2 (+3 / −1)** — and the second lane is not a formality: it converts a
file the standalone lane never shows, `built-ins/Proxy/has/call-object-create.js`
(fail → pass), on top of the same `comma/S11.14_A3.js` and `void-await-expr.js`.
The one regression is the same `await-expr-regexp.js` misparse in both lanes.

Combined: **standalone +1, host/GC +2, no lane negative.**

The `typeof` site is measured separately because it also fires inside function
bodies, which the top-level scan cannot see: `.tmp/find-typeof-affected.mts`
finds **3** affected files in the same corpus, and all three are byte-identical
in status before and after (`pass`, `compile_error`, `pass`).

#### Correction — this section originally claimed an exhaustiveness it did not have

The first version of `find-affected.mts` carried `if (/negative:/.test(src))
continue;`, and this section read "every non-negative file … **79 files** …
exhaustive over the affected population". The filter was never justified: it was
added to keep the 18k bare-`Identifier` / `PrivateIdentifier` atoms of the
negative corpus out of the population, but those are excluded by
`expressionRunsUserCode` anyway, so the filter did nothing except hide **58
genuinely affected files** — 70% of the real population — behind a sentence that
said "exhaustive".

Caught by the #2916 lane's third instrument trap on that issue (a local `skip`
read as evidence that CI skips the file), which prompted this audit rather than
reporting it. The shared shape across all four incidents — two of theirs, my
`top-level-await` one, this one — is a **claim about what the harness does,
believed instead of measured**. A population filter is exactly such a claim, and
the word "exhaustive" is what makes it dangerous: it tells the next reader not to
re-check. The conclusion did not move; the warrant for it did.

**A third check, on the denominator itself — which lane makes these statements
top-level.** `find-affected.mts` classifies the top-level statements of the
**raw** `.js` file, but the runner's legacy wrapper lane emits a test body
**inside `export function test() { try { … } }`**. If that were the lane doing
the compiling, the raw-file scan would be measuring statements the collector
never sees, and "83 affected files" would be a scan artifact rather than a
population. Verified rather than argued, in two steps:

1. Feeding `S11.14_A3.js` through `wrapTest` gives a module whose top-level
   statement kinds are `{VariableStatement: 4, ClassDeclaration: 1,
   FunctionDeclaration: 5}` — **zero** top-level ExpressionStatements. So the
   wrapper lane alone cannot explain the conversion.
2. Instrumenting the collect path and running that file through the runner
   prints the collected statement as
   `[…]/test262/test/language/expressions/comma/S11.14_A3.js "x = 1, y = 2, z = 3;"`
   — the **raw** test path. The runner's original-harness lane compiles the file
   as a real module, so its top-level statements genuinely are top-level.

The scan is therefore the right proxy **for the lane that does the compiling**,
and the conversions run through the collector rather than the `typeof` site —
confirmed by reverting each half independently: with only the collector fix all
three conversions hold; with only the `typeof` fix none do. Worth stating
because the wrapper is the more visible of the two lanes, and reading it alone
would say this fix cannot affect test262 at all.

**A second, independent narrowing in the same section: the lane.** Every corpus
run here passed `"standalone"` to `runTest262File`, chosen by habit because the
issue arrived from a standalone-lane investigation — but neither changed site is
target-gated, so half the story was a lane the numbers never touched. Prompted by
the #2916 lane's own audit of the identical defect (`noJsHost` is
`ctx.wasi || ctx.standalone` — two targets, one measured). Adding the host/GC
lane above did not merely confirm the standalone result: it converted a file the
standalone lane cannot show at all. **A narrowed population hides evidence for
the conclusion as readily as against it**, which is why "the conclusion didn't
change" is not a reason to skip the check.

### Suites

Green: `tests/issue-4433.test.ts` (22), `tests/es5-standalone-instanceof.test.ts`,
`tests/issue-4427-compound-assign-chain.test.ts`, and the whole
collector-family set — `issue-3623-module-init-collection`, `issue-3615`,
`issue-3592-toplevel-throw`, `issue-3956-global-object-binding-aliasing`,
`issue-2992`, `issue-3468-closure-own-props`, `issue-1789-standalone-module-init`
(169 tests, 10 files).

Equivalence spot-check, 12 files touching statements / `typeof` / operators
(137 tests): all green. `tests/equivalence/logical-conditional-identity.test.ts`
has 3 failures (`isNaN(void x)` — `Argument of type 'undefined' is not
assignable to parameter of type 'number'`); **pre-existing**, reproduced
identically on the base tree.

Gates: `typecheck` clean, `prettier --check` clean, `check:oracle-ratchet` OK
(+0 `getTypeAtLocation`, +0 `ctx.checker`), `check:stack-balance` OK,
`check:loc-budget` OK via this file's `loc-budget-allow`. `check:godfiles` fails
identically on the base tree (pre-existing branch drift in `object-runtime.ts` /
`index.ts`); nothing from this change appears in its output.

## Correction to the #2916 note — the three S15.3.5.3 tests were NEVER blocked by this

`plan/issues/2916-…md` records this defect as "a *second* reason
`S15.3.5.3_A2_T2/T5/T6` cannot pass … each spells the operator as a bare
statement inside a `try`". **That attribution is wrong**, and the reason is the
`try`: `collectDeclarations` keeps a top-level `TryStatement` **wholesale**
(the control-flow arm), so its body is lowered by the ordinary in-function path
that has always compiled operands. The bare statement inside a `try` was never
eliminated.

Measured both ways with the exact T2 shape instrumented (`.tmp/probe7.mts` —
`mark() instanceof FACTORY` inside the same `try`, `log` distinguishing "never
evaluated" / "ran, answered false" / "ran, threw"):

| tree | log | meaning |
| --- | --- | --- |
| base | 101 | LHS ran; `instanceof` answered `false` instead of throwing |
| fixed | 101 | identical |

**Independently reproduced on the #2916 lane's own tree** (a different worktree,
counting appended markers rather than a bit-encoded log), which states the
mechanism more sharply than the prose above — one bare `lhs() instanceof rhs()`,
three contexts:

| context | operands evaluated |
| --- | --- |
| bare statement at module top level | **0** |
| the same statement inside a top-level `try` | 2 |
| the same statement inside a function | 2 |

The `try` is the entire difference, and it is why the top-level measurement does
not generalise to the S15.3.5.3 shape. Correction applied on that side in commit
`4170f94` (branch `worktree-agent-ad38d38be0d655887`), which keeps the original
claim visible as an explicit correction rather than deleting it.

All three tests are therefore blocked by the #2916 closure-RHS prototype
residual **alone**, and they do not move here — `_T2` and `_T6` fail with the
same `#1.1: O is not an object, throw a TypeError exception` before and after;
`_T5` fails on an unrelated missing local quickjs eval provider artifact. The
correction matters because the note tells the next reader to fix two things when
there is only one.

## Residuals (deliberate, measured)

1. **`TaggedTemplateExpression` is not treated as effectful when nested.** It
   genuinely invokes its tag, but collecting it changed the status of **zero**
   of the 77 top-level tagged-template statements in the corpus and cost three
   files: the runner compiles a `top-level-await` body **synchronously**
   (#1612), so `await` parses as an ordinary identifier and ``await `` ;``
   becomes a tagged template whose tag does not exist. Revisit once TLA is
   compiled asynchronously.
2. **Bare `AwaitExpression` / `YieldExpression` are not effectful on their own**
   (a call inside one still is). Same root cause.
3. **`await-expr-regexp.js` regresses honestly.** Under the same misparse
   `await /x.y/g;` is a division chain over undeclared bindings; it is now
   evaluated and fails, where before the statement did nothing and the test
   passed vacuously. Fixing it belongs to TLA support, not here.
4. **Bare `Identifier` / `PrivateIdentifier` / `MetaProperty` statements are
   still dropped** (18k statements, 642 files, overwhelmingly negative syntax
   fixtures). Their correct behaviour is a ReferenceError / TDZ error the
   compiler does not model.
5. **`typeof` still const-folds away a side-effecting operand in VALUE
   position** — `var t = typeof f();` does not run `f()`. Only statement
   position is fixed here, because there the result is discarded and the
   evaluation reduces to operand-then-drop. The value-position fix needs
   `compileTypeofExpression` to evaluate into a temp and type the temp, which is
   a different change with its own blast radius.
