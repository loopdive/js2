---
id: 5351
title: "standalone/wasi: a lib.dom ambient `declare function` shadows the script's own top-level binding and leaks an env:: import (env::toString, env::blur, …)"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: medium
horizon: s
feasibility: easy
model: sonnet
reasoning_effort: high
task_type: bug
area: codegen
language_feature: globals
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [2961, 3561, 2175, 4444]
---

## Problem

24 ES2015 standalone rows fail with `standalone target emitted host imports:
env::toString (#2961)`. They are not an `Object.prototype.toString` gap. The
compiler loads the full default lib (no `lib:` in the three
`ts.CompilerOptions` literals at `src/checker/index.ts:921/1143/1348`), and
`node_modules/typescript/lib/lib.dom.d.ts:38831` declares
`declare function toString(): string;`. A script that binds
`var toString = Object.prototype.toString;` at top level and then USES
`toString.call(x)` has that use resolved by TypeScript to the ambient lib
declaration, not to the script's own binding. `collectReferencedGlobalNames`
(`src/codegen/extern-declarations.ts:622-661`, decision at L651
`if (decls && decls.some(isAmbientGlobalDecl))`) therefore records `toString`
as lib-referenced and `collectExternDeclarations` (L715-817 →
`registerAmbientParseImport`) registers `env::toString`. Renaming the binding
(`var ts2 = …`) gives `imports: []`; `blur`, `focus` (other lib.dom `declare
function`s) reproduce identically (`env::blur`, `env::focus`). Measured
2026-09-05 (scratch `.tmp/w5/tostring/`, batch harness `batch.mts`): the 24
rows are 24/24 `LEAK :: env::toString` on base; with a one-line shadow guard
they are 24/24 `CLEAN`, and the real runner flips 6 to pass and unmasks 18
(their next blocker is `Function.prototype.call` in standalone, #2175, 9 rows;
a null receiver defect in 8 Temporal `branding.js` rows; Array-method
genericity, 1).

Only reachable under `ctx.wasi || ctx.standalone` (`src/codegen/index.ts:5343`
passes `libRefs: undefined` otherwise), so the host lane cannot move.

## Implementation Plan (2026-09-05, Fable lane; Sonnet-high implements)

1. In `collectReferencedGlobalNames` (`extern-declarations.ts:622`), before
   the walk, collect the names the user source files bind at top level:
   `ts.isVariableStatement` declarations with an identifier name, plus
   non-`declare` `FunctionDeclaration` / `ClassDeclaration` names (the function
   already receives `userFiles`; `hasDeclareModifier` is already imported). Add
   `&& !userBound.has(node.text)` to the L651 condition. That is the whole
   change. `.some → .every` does NOT work (measured): TypeScript does not merge
   the script `var` with the ambient declaration, so the use-site symbol carries
   only the lib declaration; the check must be by NAME against the user's own
   top-level bindings. Do not fix it in `collectExternDeclarations`'s loop
   (L715-830) — by then the name is already in `libReferencedNames`.
2. Pin: `tests/issue-5351-lib-dom-shadow.test.ts` — for `toString`, `blur`,
   `focus` and one name that is NOT shadowed (`parseInt`), compile on standalone
   and wasi and assert `result.imports` equals the base's for the unshadowed
   case and `[]` for the shadowed ones; run the six flipped rows through
   `run-test262-paths.mts --isolate --standalone` and assert pass.
3. Corpus A/B (required, the risk is here): `libReferencedNames` also gates
   `collectDeclaredGlobals` (`index.ts:5358`), and ~60 lib.dom `declare
   function` names are in scope (`blur`, `focus`, `stop`, `close`, `open`,
   `print`, `scroll`, …). Compile every `playground/examples/**/*.ts` and every
   test262 ES2015 row body that top-level-binds one of those names (grep the
   corpus for `^\s*(var|let|const|function|class)\s+(<name>)\b`) on standalone
   and wasi before/after and diff the import TABLES; the only allowed change is
   the removal of an `env::<name>` import for a name the source itself binds.
   Also confirm `check-issue-spec-coverage` and the #2961/#3561 leak-scan
   guard tests (`tests/*2961*`, `tests/*3561*`) stay green.

Known sharp edge (record in the test's comment, do not fix here): the checker
still types the shadowed binding with the LIB type (`() => string`); codegen
tolerates it for these 24 bodies (all compile clean), but a binding whose lib
type differs in arity from the user's value could mis-lower a call. The deeper
fix — `lib: ["lib.es2022.d.ts"]` in `src/checker/index.ts`, which also corrects
the resolution (measured 24/24 CLEAN) — removes the DOM global surface for
every compile and is a separate, wider issue.

## Acceptance criteria

- The 6 rows pass: `BigInt/prototype/toString/thisbigintvalue-not-valid-throws.js`,
  `Error/prototype/toString/called-as-function.js`,
  `RegExp/prototype/toString/called-as-function.js`,
  `String/prototype/toString/{non-generic,string-object,string-primitive}.js`;
  the other 18 move from `compile_error` to a real assertion (list each with
  its new error in the implementation section).
- Import tables byte-identical across the corpus A/B except the shadowed
  names; host lane untouched by construction (state the gate).
- Gates green bare and with `LOC_GATE_BASE=origin/main`.

## Lane protocol

Fresh worktree of the session branch; one commit for the fix + pin, one for
the corpus A/B record; `Model: Claude Sonnet 5 High`; never push/PR/enqueue;
append `## 2026-09-05 implementation (Sonnet)` with the measurements.
