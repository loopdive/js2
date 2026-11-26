---
id: 7487
title: "Prepared path: `Function(...)` / `new Function(...)` with all-literal arguments, on the literal dynamic-code source seam"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: ir-full-coverage
depends_on: [7363]
related: [7354, 7350, 7349, 2924]
---

# #7487: the `Function` constructor with all-literal arguments on the Prepared path

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, standalone), every call or `new` of the global
`Function` refuses. Measured on main `c3b7be667a` (2026-11-26), with the stand-in harness, over all 9,174 ES5 files
(8,717 positive). The global `Function` is the **first gap** of 334 files:

| first gap | where | files |
| --- | --- | ---: |
| `identifier "Function" is not in scope` (a value use) | test | 102 |
| `direct call to "Function" has no exact AST-site plan` | `harness:fnGlobalObject.js` | 89 |
| `direct call to "Function" has no exact AST-site plan` | test | 77 |
| `unknown class "Function"` (`new Function`) | test | 64 |
| `instanceof RHS class "Function" has no projected shape` | test | 2 |

The `Function` sites in those 334 files sort as follows:

| class | files | owner |
| --- | ---: | --- |
| only all-string-literal calls / `new` in the test | 97 | **this issue** |
| only `fnGlobalObject.js`'s `Function("return this;")()` | 89 | this issue, plus the global object (see Yield) |
| all-literal sites **and** a value use | 11 | this issue, plus #7350 |
| a computed argument (`new Function(src)`) | 35 | out of scope: needs a run-time compiler |
| value uses only (`Function.prototype.x`, `instanceof Function`, bare reads) | 102 | #7350 (built-in globals as values) |

The literal case needs no run-time compiler. CreateDynamicFunction (§20.2.1.1.1) assembles
`function anonymous(<params>\n) {\n<body>\n}` from the argument strings and evaluates it in the **global**
environment. When every argument is a literal, that text is known at compile time, exactly like literal `eval("T")`.

## Yield (measured, main `c3b7be667a`)

**Method.** I used a step-past rewrite in a scratch checkout. Each all-literal site was replaced by a reference to a
hoisted top-level `function __dynfn_N(<params>\n) {\n<body>\n}`; value uses and computed sites were left alone. I
then re-ran `scripts/ir-census/prepared-census.mts --tree` on the 197 rewritten files, with both harnesses. Without
the rewrite, all 197 pass 0.

| group | files | pass, stand-in | pass, real harness |
| --- | ---: | ---: | ---: |
| literal `Function(...)` calls | 64 | 25 | 20 |
| literal `new Function(...)` | 31 | 7 | 7 |
| both literal forms | 2 | 0 | 0 |
| literal + value use | 11 | 0 | 0 |
| `fnGlobalObject.js` only | 89 | 0 (see below) | 0 |
| **total** | 197 | **32** | **27** |

The rewrite is a bound, not the mechanism. It shares one function object across evaluations, and it makes the body
strict when the program is strict. So:

- 9 rows of the 165 that still fail are rewrite artifacts in the 16 strict programs: `Cannot assign to … in strict
  mode`, `Duplicate parameter name`, `Binding … in strict mode`. The mechanism compiles each body in its own
  strictness.
- The real-harness figure is the one CI measures.

What stands next behind the rewrite (stand-in):

| next gap | files |
| --- | ---: |
| `fnGlobalObject.js`: a direct call installs no receiver for its `this` | 88 |
| run-time abort (`unreachable`, an abort body) | 23 |
| `identifier … is not in scope` | 9 |
| `this` outside an instance method body | 9 |
| `instanceof RHS class "Function"` | 6 |

**`fnGlobalObject.js` (89 files): yield not measurable yet.** A sloppy function called directly must get the global
object as `this`. No construct can name the global object on this path today. I checked both stand-ins: top-level
`this` refuses (`'this' reference outside an instance method body`), and `globalThis` refuses (`identifier
"globalThis" is not in scope`). Those 89 files therefore need, in addition:

- the global object as a value (#7350 B2b, `js.object.global`);
- C2's known limit, the sloppy direct-call receiver (#7354 C2, "a direct call … installs no receiver for its
  `this`").

Their yield is re-measured once both land.

## Dependency

The arm is built on the **literal dynamic-code source seam of #7363 slice A, in its A1–A4 PR**, not on #7432. #7432
lands only the `src/frontend/eval` move and the dedupe; the seam (A1–A3) lands together with A4, and A4 waits on
#7350 B2b.

What the arm uses from that PR:

- `present()` (`src/test262/test262-prepared-entry.ts`) turns each qualifying literal site into a virtual script
  source, before checking;
- the relation travels `PipelineInput` → `IrProgramSourceInput`;
- `src/ir/eval-literal.ts` holds the site predicate and the receipt;
- the site's run-time identity test (global `eval` === %eval%, through `js.object.global`) comes with A4.

Agreed with S2, who owns #7363 slice A, on 2026-11-26. S2 reviews this plan.

## Implementation Plan

### Target structure

1. **One relation, two kinds.** Generalise slice A's `literalEvalSources: {call, source}[]` into literal
   dynamic-code sources, `{site, kind: "eval" | "function", source}`. It lives in the same module
   (`src/ir/eval-literal.ts`, renamed to `src/ir/literal-dynamic-code.ts` in the same PR when the name no longer
   fits), with the same receipt (`verifyLiteralEvalSources`, generalised), and enters through the same one place in
   `present()`. There is no second pipeline, no second predicate module and no second receipt.
2. **The site predicate.** It sits next to the eval predicate and has the same shape:
   - a call or `new` whose callee is the unshadowed global `Function`, resolved the way `resolvesToSourceBinding`
     resolves `eval`;
   - every argument is a string literal (`ts.isStringLiteralLike`), and zero arguments count;
   - a computed argument keeps today's named refusal.
   The text is CreateDynamicFunction's: parameters joined with `,`, body last.
3. **One §20.2.1.1.1 assembler.** `dynamicFunctionSource(paramString, bodyString)` moves from
   `src/interp/dynamic-function.ts` to a pure module beside slice A's eval sources under `src/frontend/eval/`. Three
   callers import it:
   - the interpreter (unchanged behaviour);
   - this arm;
   - the legacy fold `synthesizeStaticNewFunction` (`src/codegen/expressions/eval-inline.ts`).

   The legacy fold currently has its own template, which lacks the `\n` before `)`, so a trailing `//` comment in the
   parameter text swallows the `)`. That template is removed. The legacy fold keeps its synthesized name; the shared
   assembler takes the name as a parameter, defaulting to `anonymous`.
4. **The virtual source binds no global name.** A `function` kind source holds the assembled text as its single
   top-level `FunctionDeclaration`. Two places treat it as such:
   - the global-binding collection skips it, because CreateDynamicFunction creates no binding, so `typeof anonymous`
     stays `"undefined"` and several sites do not collide on `anonymous`;
   - the source's plan is "value": startup does not run the source; the site evaluates to a fresh closure of that
     declaration's unit, so each evaluation is a new object, `name` is `"anonymous"`, and the scope is global.
   The body's strictness comes from the body's own directive, not from the caller (§20.2.1.1.1). The unit is
   lowered with that strictness, through O3's `codeStrictness`.
5. **The site.** The site test is global `Function` === %Function%, through `js.object.global` and
   `js.value.strict_eq`, the same shape as A4's %eval% test:
   - equal: the site evaluates to the closure;
   - unequal: the site is an ordinary call or `new` of the value.
   `new` and a call give the same result, since CreateDynamicFunction ignores `new.target` for this kind.
6. **Static SyntaxError.** When the assembled text does not parse as one function declaration, the site throws a
   SyntaxError when run. This reuses slice A's static-SyntaxError arm (`foldedEvalStaticSyntaxError` /
   `parseEvalSource`), with no new error path.

### Out of scope

- Computed arguments (35 files): they need a run-time compiler, which nobody has scoped.
- `Function` as a value (102 files, plus the value half of the 11 mixed files): #7350.
- `fnGlobalObject.js`'s receiver: #7350 B2b and the sloppy direct-call `this` from #7354 C2.
- `GeneratorFunction` / `AsyncFunction`: separate kinds, and no ES5 file needs them.

### Acceptance

Correctness:

- Pin tests through the strict Prepared entry (standalone) on these programs, each compared with node:
  - `new Function("a", "b", "return a + b")(1, 2) === 3`;
  - `Function("return 1")() === 1`;
  - two evaluations of one site give different objects;
  - `.name === "anonymous"`;
  - `typeof anonymous === "undefined"` after a site runs;
  - a sloppy body inside a strict program, and a strict body (`"use strict"` in the body) inside a sloppy program;
  - a local `var Function` shadow stays an ordinary call;
  - a reassigned global `Function` takes the unequal arm;
  - unparsable text throws a catchable SyntaxError;
  - a computed argument still refuses by name.
- The census, re-run on the rewrite set (`--harness real`), passes at least the measured 27 files minus any whose
  next gap is a rewrite artifact. Each shortfall is named.
- JS-environment output stays byte-identical. The one shared-code change is the assembler move, and the legacy fold's
  text gains `\n` before `)`. I will compare bytes on a corpus of literal `new Function` programs before and after.

Code quality:

- One relation, one predicate module, one receipt, one assembler (net −1 template).
- No new entry in `present()` beyond the kind.
- No `loc-budget-allow` / `func-budget-allow` grants.
- An adversarial review with fresh context, given the diff and this plan, finds no duplication of slice A's eval arm.
