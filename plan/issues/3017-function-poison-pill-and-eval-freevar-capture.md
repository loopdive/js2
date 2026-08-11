---
id: 3017
title: "Function .caller/.arguments poison-pill throw + free-variable capture in Function/eval shim child module"
status: in-progress
sprint: Backlog
created: 2026-07-03
updated: 2026-08-11
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: codegen
language_feature: eval
goal: correctness
parent: 2960
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/function-poison-pill.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/property-access.ts
  - src/codegen/registry/imports.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/expressions/calls.ts::compileIIFE
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
  - src/codegen/expressions/new-super.ts::compileNewFunctionExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/function-poison-pill.ts::finalizeFunctionPoisonPillCalls
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/property-access.ts::compileElementAccess
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
---

## Problem

The diagnostic work on #2960 / PR #2548 (dynamic `eval` / `new Function`
diagnostics) established that 3 apparent test262 regressions were coincidental
"pass" losses — those tests were only passing because they leaned on OTHER
pre-existing bugs, not because the compiler implemented the feature under test.
Removing the coincidental support surfaced TWO real, distinct, currently
unimplemented spec-semantics gaps. This issue documents both so they can be
scheduled deliberately.

Neither gap was introduced by #2548; both are pre-existing feature holes that
the sharper diagnostics simply made visible.

---

### Gap 1 — Function `.caller` / `.arguments` poison-pill accessors do not throw

Per ES spec, reading (or writing) the `caller` or `arguments` own property of a
strict-mode function must throw a `TypeError` — the so-called "poison pill"
accessor pair (`%ThrowTypeError%`). This applies to any function that is strict,
including every function created via the `Function` constructor and any function
with an explicit `"use strict"` directive.

Currently the compiler returns `undefined` for `.caller` / `.arguments` on a
real callable instead of throwing.

**Repro:**

```js
var foo = new Function("'use strict';");
foo.caller; // spec: throws TypeError; actual: returns undefined
foo.arguments; // spec: throws TypeError; actual: returns undefined
```

**test262 files:**

- `test/language/statements/function/13.2-5-s.js`
- `test/language/statements/function/13.2-13-s.js`

**Direction (not a spec):** the function object's property lookup path needs a
poison-pill accessor for `caller`/`arguments` on strict functions that throws
`TypeError` on get/set rather than resolving to `undefined`. Scope: which
functions count as "strict" (Function-constructor-created, `"use strict"`
bodies, modules) and whether the throw is on the own-property or via the
prototype accessor pair.

---

### Gap 2 — Free-variable capture in the meta-circular `eval` / `Function` shim child module

When `Function("return f();")()` is invoked and `f` is a free variable resolved
from the enclosing lexical scope, the current meta-circular shim compiles the
Function body into a child module that does NOT have access to that free
variable. The result is a spurious `"null is not a function"` runtime error
instead of either correctly resolving `f` or throwing the spec-correct
`ReferenceError` when `f` is genuinely unbound.

**Repro:**

```js
(function () {
  "use strict";
  Function("return f();")(); // actual: "null is not a function" runtime error
})();
```

Note that per spec, functions created by the `Function` constructor are created
in the **global** scope, NOT the caller's scope — so `f` here (a local of the
IIFE) is genuinely NOT visible to the Function body, and the spec-correct
outcome is a `ReferenceError` for an unresolved `f` at call time. The bug is
that the shim produces a different, misleading error (`"null is not a
function"`) rather than the correct `ReferenceError` (or correct resolution when
`f` IS a global). Getting the scoping and the error shape right is the work.

**test262 file:**

- `test/built-ins/Function/15.3.5.4_2-77gs.js`

**Direction (not a spec):** the child-module code path for the eval/Function
shim needs a defined story for free-variable resolution — resolve against the
global environment (spec-correct for the `Function` constructor), and surface a
proper `ReferenceError` for a truly unbound identifier rather than a
downstream null-call error.

---

## Acceptance criteria

1. `new Function("'use strict';").caller` and `.arguments` throw `TypeError`
   (and the two `13.2-*-s.js` test262 files pass).
2. `(function(){"use strict"; Function("return f();")();})()` produces the
   spec-correct `ReferenceError` (unbound global `f`), not a
   `"null is not a function"` error (and `15.3.5.4_2-77gs.js` passes).
3. No net test262 regression relative to the post-#2548 baseline.

## 2026-07-28 implementation status

Gap 1 is now implemented for statically known source functions and for a
sloppy function reading its own legacy `caller` property:

- strict source functions throw `TypeError` for `caller` / `arguments` reads
  and writes through dot or literal-bracket syntax;
- writes preserve receiver → computed key → RHS → poison-setter evaluation
  order;
- a sloppy self-`caller` read snapshots the immediate source caller's
  strictness at activation entry, so a strict direct caller throws while a
  strict grandparent behind a sloppy immediate caller does not;
- the strictness hand-off global, activation local, and call-site markers are
  emitted lazily only when a source function actually observes its own
  `caller`.

Same-base local A/B against `origin/main@108c41ecf166b1` for the complete
97-file `built-ins/Function/15.3.5.4_2-*` family:

- host: 21/97 → 77/97 (56 exact FAIL → PASS);
- standalone: 20/97 → 80/97 (60 exact FAIL → PASS);
- zero PASS → FAIL regressions and zero residual failure-signature changes;
- the 19 strict-grandparent / sloppy-immediate controls (`75gs`–`93gs`)
  remain green in both lanes.

The two `language/statements/function/13.2-*-s.js` rows remain 2/2 in host.
Their standalone runs remain blocked before behavior by the pre-existing
`js2wasm:runtime-eval` import, identically in both A/B arms.

The residual `15.3.5.4_2-*` failures are routes that do not yet identify a
source activation (dynamic `eval` / `Function` constructor, selected
constructor/accessor/bound-function paths). They are not hidden by an
unconditional throw.

Gap 2 (global-environment resolution for free variables in the eval/Function
shim child module) is intentionally unchanged and remains open. Accordingly,
this combined tracking issue stays `in-progress`; the Gap 1 source-function
slice is independently landable.

## 2026-08-11 standalone follow-up

The remaining ordinary-source activation routes now preserve strict caller
state when their source function boundary does not coincide with a normal Wasm
function body:

- inlined function-expression IIFEs record their own strictness on the nested
  instruction region, and the final call-site pass honors that override instead
  of inheriting the containing Wasm function's strictness;
- synthesized declaration- and expression-based constructor bodies are
  registered as source activations before prologue/body emission;
- parenthesized anonymous constructors (`new (function () { ... })()`) now run
  through the existing source-body constructor lowering instead of collapsing
  to a null placeholder without executing the body.

Fresh maintained standalone measurement used the full runtime-eval interpreter
and official scope. For the complete 97-file
`built-ins/Function/15.3.5.4_2-*` family:

- before (`20260811-214733`, `origin/main@6c1117f8767e9b`): **83/97 pass**,
  14 fail, 0 compile errors;
- after (`20260811-221556`): **92/97 pass**, 5 fail, 0 compile errors;
- exact FAIL → PASS rows: `6gs`, `16gs`, `18gs`, `19gs`, `20gs`, `38gs`,
  `41gs`, `44gs`, and `47gs` (9 total);
- the five unchanged residuals are dynamic `Function` constructor calls
  (`8gs`, `10gs`, `95gs`), getter-accessor activation (`96gs`), and bound-call
  forwarding (`97gs`).

All nine flips belong to the freshly harvested 98-row ES5 Function-object
standalone root-cause bucket, reducing that assigned residue to **89**. The
separate 73-row ES5 `with` residue is unchanged; its dominant 39-row compiler
gate requires closure capture of an object environment and is tracked by
#4206/#4264 rather than this bounded Function activation slice.

## Notes

- Origin: diagnostic follow-up from #2960 / PR #2548.
- The two gaps are independent in mechanism (function-object property semantics
  vs. eval/Function shim scoping) but share an origin and both touch the
  dynamic-`Function` story, so they are filed together. A dev may split them
  into two PRs if that keeps each change small; treat the acceptance criteria as
  independently landable.
- **Gap 2's normative design is now specified** (architect, 2026-07-04) in
  `docs/architecture/runtime-eval-interpreter.md` **§14** (unified name
  resolution, consumer 2): the shim child module compiles free identifiers
  with _eval-code linkage_ against a global-environment handle passed from the
  parent module (its globalThis `$Object`), with a root-miss →
  `ReferenceError`. Implementing that section satisfies acceptance criterion 2
  AND fixes the deeper sharing bug (eval'd `var x` landing in the child's
  globals, invisible to the parent). Gap 2 is independent of the #2928
  interpreter and schedulable anytime.
