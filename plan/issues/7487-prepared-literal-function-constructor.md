---
id: 7487
title: "Prepared path: `Function(...)` / `new Function(...)` with all-literal arguments, on the literal dynamic-code source seam"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-27
completed: 2026-11-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: ir-full-coverage
depends_on: [7363, 7350, 7354]
related: [7349, 2924]
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

The `Function` sites in those files sort as follows (per file:
`plan/log/7487-function-ctor-yield/first-gap-function.tsv`):

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

**Method.** The tool is `plan/log/7487-function-ctor-yield/step-past.mjs`; the exact commands are in that folder's
`README.md`, and the 197-file list is `files.txt`.

1. Each all-literal site becomes a reference to a hoisted top-level `function __dynfn_N(<params>\n) {\n<body>\n}`,
   in a scratch tree whose `test262/` the tool builds itself from real copies.
2. Value uses and computed sites are left alone.
3. `scripts/ir-census/prepared-census.mts --tree` runs on those files with both harnesses, and once without the
   rewrite.

| group | files | pass now (real) | pass, stand-in | pass, real harness |
| --- | ---: | ---: | ---: | ---: |
| literal `Function(...)` calls | 64 | 0 | 25 | 20 |
| literal `new Function(...)` | 31 | 0 | 7 | 7 |
| both literal forms | 2 | 0 | 0 | 0 |
| literal + value use | 11 | 0 | 0 | 0 |
| `fnGlobalObject.js` only (refuse by item 8's name until B2b + C2) | 89 | 0 | 0 | 0 |
| **total** | 197 | 0 | **32** | **27** |

**The rewrite is a bound, not the mechanism.** It differs from CreateDynamicFunction in four ways:

- one function object is shared across evaluations;
- the body is strict when the program is (`onlyStrict`, 16 files);
- `toString`, `name` and `length` read the hoisted declaration;
- RV7432's B1/B2 effects are absent from the rewrite but present in the mechanism until the A1–A4 fixes land (see
  P3, P4).

Consequences:

- The 9 rows that fail only in the 16 strict programs are counted **unknown**, not as failures. They are `Cannot
  assign to … in strict mode` ×4, `Duplicate parameter name` ×3 and `Binding … in strict mode` ×2.
- The yield is **re-measured with this tool after the A1–A4 B1/B2 fixes land**, and again after this arm. The arm
  then replaces the rewrite.

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
"globalThis" is not in scope`). Those 89 files therefore need:

- the global object as a value (#7350 B2b, `js.object.global`);
- the sloppy direct-call receiver (#7354 C2's known limit).

Both are listed in `depends_on`.

## Dependency

The arm is built on the **literal dynamic-code source seam of #7363 slice A, in its A1–A4 PR**, not on #7432. #7432
lands only the `src/frontend/eval` move and the dedupe; the seam (A1–A3) lands together with A4. A4 was narrowed on
2026-11-26 (a7 `67e4115a`) to a static proof instead of a run-time identity test, so it no longer waits on #7350 B2b.
The plan below is concrete about this arm, but its seam-facing details are checked against A1–A4's design
once that design is concrete. The plan review waits for that (lead, 2026-11-26).

The arm needs three things, in this order:

1. #7439, the `src/frontend/eval` move;
2. the A1–A4 PR, on branch `claude/prepared-eval-a7`, carrying RV7432's B1 fix (diagnostics in a virtual source
   refuse the site) and B2 fix (write analyses walk virtual sources);
3. A4's code: the pristine proof as a resolver capability, and `withLiteralEvalSources`' all-or-nothing fallback.
   The arm reuses both.

The arm stacks on **A4's implementation PR**, not on a7's current head: on a7 `67e4115a`, A4-narrowed is still plan
only (`withLiteralEvalSources`' fallback, `ownThisEscapes` / `ambientThisMayBeGlobal` and the `DeleteExpression` row
are not in `src`). Steps that need none of them (the early-error split, the relation kind, the predicate, the virtual
source) may start on a7.

**Landed early, separately.** One CreateDynamicFunction text assembler, `functionSourceText(name, params, body)`, in
the import-free leaf `src/interp/function-source-text.ts`. It is listed in the provider's `INTERP_FILES`, the
interpreter and the legacy literal fold share it, and the legacy fold's template, which had no newline before `)`, is
removed. The same leaf holds the separate-goal span check, `fitsFunctionSourceText`, which both routes use (RV7441's
blocker). That is PR #7441, which addresses review P1.

**Follow-up (lead, 2026-11-26).** Move the shared span check (`fitsFunctionSourceText`) and the assembler to a neutral
leaf outside `src/interp`, so codegen no longer imports from the interpreter. The runtime-eval provider build keeps
concatenating it.

## Implementation Plan

### Target structure

1. **One relation, two kinds.** Slice A's literal-source relation becomes `{site, kind: "eval" | "function",
   source}`:
   - one site-predicate module: `src/ir/eval-literal.ts`, renamed to `src/ir/literal-dynamic-code.ts` when the
     `function` kind enters;
   - one receipt: `verifyLiteralEvalSources`, generalised to the kind;
   - one entry in `present()`.

   There is no second pipeline. Everything in items 3–6 lives in the `function` arm of those same three places.
2. **The site predicate.** It sits next to the eval predicate and has the same shape:
   - a call or `new` whose callee is the unshadowed global `Function`, resolved as `resolvesToSourceBinding` resolves
     `eval`;
   - every argument is `ts.isStringLiteralLike`, and zero arguments count;
   - a computed argument keeps today's named refusal.
3. **Parsing (P2).** CreateDynamicFunction parses the parameters and the body as **separate goals** before the whole
   text (§20.2.1.1.1: `ParseText(P, FormalParameters)`, `ParseText(body, FunctionBody)`). This arm uses the one
   check #7441 put in the shared leaf, not a second one:
   - **The span check.** `fitsFunctionSourceText(text, name, P, statements, bodyStart, bodyEnd)`
     (`src/interp/function-source-text.ts`): the assembled text parses as exactly **one** declaration whose body
     opens at the `{` the assembler wrote and closes at the text's end. The interpreter and the legacy fold already
     use it. As in node, these fail, pinned in `tests/issue-7487-function-source-text.test.ts`:
     - `Function("a) { if (1 //", "return 7 }")`;
     - `Function("/*", "*/){")`;
     - the injections `Function("}; function x(){")` and `Function("a){};(function(", "")`;
     - a `)` in the parameters.
   - **No early-error pass on a parameter wrapper.** Early errors run only on the assembled declaration. An arrow
     wrapper `(<P>) => 0` would wrongly reject sloppy duplicate parameters (`Function("a,a", "return a")` is valid).
   - **HTML-like comments.** A piece containing `<!--` or a line-leading `-->` (Annex B.1.1) refuses by name
     (`dynamic function source uses an HTML-like comment`), since TS's parser does not implement them (TS1109).
   - **Early errors, decided per rule.** The covered set is slice A's, split rather than copied:
     `foldedEvalEarlyError` becomes a text-level `staticEarlyError(source, goal)` in
     `src/frontend/eval/early-errors.ts`, built on `claude/prepared-eval-a7`, plus the eval-site wrapper
     (`foldedEvalStaticSyntaxError`, which keeps the `CallExpression` and the eval caller's capabilities). Eval
     output and the existing issue-3632 and eval early-error tests stay unchanged (S2's condition).

     | rule | covered by | at the site |
     | --- | --- | --- |
     | strict legacy octal literal or escape | TS parse diagnostic (TS1121) | throws SyntaxError |
     | strict `eval` / `arguments` as a parameter name | `staticEarlyError` (today's `foldedEvalEarlyError`) | throws SyntaxError |
     | a strict body (`"use strict"`) with non-simple parameters | not covered | refuses by name: `dynamic function early error not covered: use-strict-non-simple-params` |
     | a duplicate label | not covered | refuses by name: `… not covered: duplicate-label` |
     | strict `with` | not covered | refuses by name: `… not covered: strict-with` |

     A rule moves to "throws" only when `staticEarlyError` covers it for eval too, in its own change.
   - **A text that passes** becomes the virtual source. A covered failure throws a catchable SyntaxError at the site
     when the site runs, through slice A's static-SyntaxError lowering reached via the text-level function.
4. **The virtual source and its name (P3).** The `function` source holds one top-level `FunctionDeclaration` named
   with a **unique synthesized name**, `__js2wasm_dynamic_function_<siteIndex>`, built by `functionSourceText`.
   - **No collision.** The name is never `anonymous`, so the checker never binds a global `anonymous` that a caller's
     `typeof anonymous`, a user `var anonymous` (TS2300) or another site could collide with.
   - **The prefix is reserved.** A program whose own source holds an identifier starting with
     `__js2wasm_dynamic_function_` refuses by name (`identifier uses the reserved dynamic-function prefix`). Then no
     user binding can share a synthesized name.
   - **The global-binding collection skips the declaration.** CreateDynamicFunction creates no binding. Because the
     synthesized name is never written by user code, no entry read resolves to it by symbol. Two sites are two
     distinct names, so neither can raise a duplicate-declaration diagnostic that, after RV7432's B1 fix, would
     refuse the other's site.
   - **The observable name is `"anonymous"`.** SetFunctionName gives it, so `emitFunctionObjectInit` (item 5) takes
     the name as an argument instead of deriving it from the declaration.
   - **`toString`** returns the exact assembled text with `anonymous`, i.e. `functionSourceText("anonymous", P,
     body)`, which the arm records as the function's source text. Until `Function.prototype.toString` exists on this
     path, it refuses by name (see Gaps).
   - **Cross-source type checking.** RV7432's B1 checker effects, such as a body's `x = "s"` against a caller's
     `var x = 1` (TS2322), are not specific to this kind. This arm takes the B1 remedy A1–A4 adopts for every virtual
     source and adds nothing of its own.
5. **The value at the site (P5).**
   - **The unit.** The declaration's unit is an ordinary source function unit. There is **no new invocation kind**:
     a `function` source is declaration-only, so its module-init is already non-executable (A1's verifier: kind
     `"none"` exactly when not executable) and startup runs nothing. The relation's `kind` alone decides what the site
     does.
   - **The site.** It lowers through the closure-literal path of #7354 F1b in `src/ir/function-object-lowering.ts`:
     - `builder.emitClosureNew(<the unit's ref>, <signature>, [], [])` with no captures, since the scope is global;
     - then `emitFunctionObjectInit(builder, closure, declaration, "anonymous")`, gaining an optional `name`
       parameter (the only change to that module).

     Each evaluation is therefore a fresh object with its own `length` (§15.1.5 count, so default and rest
     parameters stop it), its own `name`, and MakeConstructor's own `prototype`.
   - **No new closure path.** This is the same sequence a function expression uses.
   - **Strictness.** The unit's strictness is the body's own directive, given through O3's `codeStrictness`, never
     the caller's.
6. **Writes in the body (P4).** RV7432 B2 applies unchanged:
   - writes in a virtual source are invisible to `identifierWrites`, F1b, Fa and the homes analysis;
   - a `function` source's body runs at each call, not at the site.

   This arm takes the B2 fix A1–A4 adopts: those analyses walk virtual sources. Because this kind's source is a
   function declaration, its body is analysed as call-time code, the case they already model for any declaration.
   Nothing kind-specific is added.
7. **Claim only what lowered.** As A4 does, the arm claims a site only after its function unit has lowered, and never
   claims a site and then withdraws it. S2's B1 tolerates TS2304, but tolerating a diagnostic is not lowering it. A
   body that **reads** an undeclared global (not `typeof`) fails lowering ("identifier not in scope") until something
   gives that name a home, so its site keeps a named refusal. Checked on main `c3b7be667a`: `typeof <undeclared>` does
   lower, at top level and inside a function, so the `typeof anonymous` rows stay JS-answer rows. The re-measure on a7
   shows how many of the 27 such reads cost.
8. **The site's proof (A4 narrowed).** No run-time identity test. As A4 does for `eval`, the arm asks the existing
   static proof that the global `Function` is %Function% at every site: `pristineBuiltinGlobal("Function")`
   (`src/ir/builtin-global-binding.ts`, #7354 O1), through the resolver capability `isPristineBuiltinGlobal`,
   over every source including the virtual ones. It also asks A4's `ambientThisMayBeGlobal` flag, which says no
   sloppy function's own `this` escapes as the global object.
   - Pristine: the site evaluates to item 5's closure.
   - Not pristine: the site refuses at select, by name: `Function literal: the global Function is not pristine
     (#7487)`.
   - The proof's soundness boundary is A4's and #7503's, and a dynamic-function body is one of its sources, so a body
     that writes `Function` or `eval` falls under the same write check.
   - **`ambientThisMayBeGlobal` walks the function-kind virtual sources too**, and their `ambientThisStrict` is the
     body's own directive, never the caller's. A dynamic body is a sloppy-by-default function-like, so
     `Function("return this;")` (`fnGlobalObject.js`) is exactly an escape: the flag keeps those programs refusing,
     by this item's name, until #7350 B2b and #7354 C2 give a sloppy direct call the global object.

### Gaps: each gets a JS answer or a named refusal, and an acceptance row

| gap | answer here |
| --- | --- |
| sloppy body's `this` | the global object, once #7350 B2b and #7354 C2's direct-call receiver land; until then a body whose own `this` escapes makes `ambientThisMayBeGlobal` true, and the site refuses by item 8's name |
| `toString()` | the exact assembled text with `anonymous` (item 4); a named refusal until `Function.prototype.toString` exists on this path |
| constructing the result (`new (Function("this.a = 1"))()`) | C2's constructor path: every function value here is a constructor |
| `length` with default / rest parameters | the §15.1.5 count from `emitFunctionObjectInit` (`Function("a", "b = 1", "...c", "")` → 1) |
| a non-pristine global `Function` | the site refuses at select by name (item 8); no generic arm
| `%Function%` itself as a value | #7350 |

### Out of scope

- Computed arguments (35 files): they need a run-time compiler, which nobody has scoped.
- `Function` as a value (102 files, plus the value half of the 11 mixed files): #7350.
- `GeneratorFunction` / `AsyncFunction`: separate kinds, and no ES5 file needs them.

### Acceptance

Correctness, with pin tests through the strict Prepared entry (standalone), each row compared with node or checked
for the named refusal:

- `new Function("a", "b", "return a + b")(1, 2) === 3`, and `Function("return 1")() === 1`;
- two evaluations of one site give different objects; `.name === "anonymous"`;
- `typeof anonymous === "undefined"` after a site runs; a user `var anonymous = 1` beside a site compiles; two sites
  in one program both compile; a user identifier with the reserved prefix refuses by name;
- inside the body, `Function("return typeof anonymous")() === "undefined"`. **This row depends on the shape of
  A1–A4's B1 remedy.** With the synthesized name, `anonymous` is unresolved in the virtual file, and checkJs reports
  TS2304 (measured by PRV-7487). If the remedy were "any diagnostic in a virtual source refuses the site", this row,
  and every test262 body that reads an undeclared global, would refuse. So the remedy must not count unresolved-name
  diagnostics (agreed with S2 before A1–A4 lands); otherwise this row becomes a named refusal;
- `length`: `Function("a", "b = 1", "...c", "").length === 1`;
- `new (Function("this.a = 1"))().a === 1`;
- a sloppy body inside a strict program, and a strict body inside a sloppy program;
- P2's rows:
  - `Function("a) { if (1 //", "return 7 }")`, `Function("/*", "*/){")` and the injections
    `Function("}; function x(){")` and `Function("a){};(function(", "")` throw SyntaxError;
  - `Function("a,a", "return a")(1, 2) === 2` (sloppy duplicate parameters are valid);
  - an HTML-like comment refuses by name;
  - `Function("'use strict'; 010")` and `Function("eval", "'use strict'")` throw SyntaxError (covered);
  - `Function("a = 1", "'use strict'")`, `Function("l: l: ;")` and `Function("'use strict'; with (o) {}")` refuse
    by name (not covered; see the table in item 3);
- a write in the body to a caller-visible global is seen by the caller (B2);
- a local `var Function` shadow stays an ordinary call;
- a reassigned global `Function` (`Function = f`, `var Function`, `globalThis.Function = f`) and `delete Function`
  (A4's shared `DeleteExpression` row) refuse the site by name;
- a program with `Function("return this")` plus an eval site, or a second `Function` site, refuses by item 8's
  name (the body's own `this` escapes);
- a computed argument still refuses by name;
- sloppy `this` and `toString()`: their named refusals until #7350 and #7354 C2 provide them, then node's answer.

Yield: the tool re-run on `files.txt` passes at least the measured 27 (real harness). Each shortfall is named; the 9
unknown strict rows are reported separately.

Code quality:

- One relation, one predicate module, one receipt, one assembler, one early-error set (split, not copied), one
  closure path.
- No new entry in `present()` beyond the kind.
- No `loc-budget-allow` / `func-budget-allow` grants.
- An adversarial review with fresh context, given the diff and this plan, finds no duplication of slice A's eval arm.

## Result (2026-11-27)

Implemented on `claude/7487-function-literal`, stacked on #7363 A1–A4 (PR #7502, head `7886d976`), with main merged.
Pins: `tests/issue-7487-prepared-literal-function.test.ts` and `tests/issue-7487-function-source-text.test.ts`.

### What landed

- **One relation, two kinds.** `src/ir/eval-literal.ts` became `src/ir/literal-dynamic-code.ts`: one relation
  `{site, kind: "eval" | "function", source}`, one receipt and one admission point,
  `literalDynamicCodeSiteRefusal(receipt, contracts)`, called once in `prepareIrProgramSources`. Both kinds use the
  existing code `literal-eval-site-unsupported`, so eval's codes and labels are byte-identical.
- **The text rules are in the frontend.** `staticEarlyError`, `hasScriptOnlyEarlyError` and `bindsOrEvaluates`
  moved out of the IR module into `src/frontend/eval/`. The pass-through wrapper `foldedEvalEarlyError` is deleted.
- **Both arms only emit.** `lowerLiteralDynamicCodeSite` (`src/ir/literal-dynamic-code-lowering.ts`) dispatches both
  arms. The Function arm makes a fresh "anonymous" function object through F1b's shared
  `emitFunctionDeclarationObject`, which `emitFunctionDeclarationValues` now uses too.
- **Shared checks.** The separate-goal check is `fitsFunctionSourceText` (#7441), and HTML-like comments use S2's
  `hasHtmlLikeComment`, for both kinds. Sloppy duplicate parameters no longer leak TS2300 warnings.

### Yield (measured)

On the 197 step-past files (`plan/log/7487-function-ctor-yield/files.txt`, real harness, census entry), measured at
`cbf90122` and identical file by file at `c01fcc38`: **34 pass, 10 fail, 153 compile errors**. Main passes 0 of them.
The 89 `fnGlobalObject.js` files refuse by item 8's name ("the global Function is not pristine") until #7350 B2b and
#7354 C2 give a sloppy direct call the global object. (An earlier figure here, 27, was a count at `a39d8da4`.)

**The 10 failures are run-time aborts this arm does not introduce.** Each test reaches code that was already
unlowerable once its `Function` site compiles:

| files | trap | under the `"refuse"` policy |
| --- | --- | --- |
| 13.2-5-s, 13.2-9-s, 13.2-13-s, 13.2-17-s | the census entry's abort-body policy (#7354 U): an unlowerable body becomes `unreachable` when run, by design of the measuring entry | refuses by name: `unsupported tail statement FirstStatement` |
| 13.2-14-s, 13.2-18-s | a site-naming run-time abort (#7486): `member write 'arguments' of a function needs a sloppy function's own arguments object` | still traps |
| S15.3.4.4_A2_T2 | the same kind: `member read 'call' of a function needs Function.prototype's properties` | still traps |
| S15.3.4.4_A1_T1, S15.3.4.3_A1_T1 | the same kind: `new with a 'prototype' that is a function, not an ordinary object` | still traps |
| S15.5.4.11_A1_T5 | the same kind: `member read 'replace' of a string needs String.prototype's properties` | still traps |

The six site-naming aborts are the dynamic-value legalization's run-time aborts, which a program reaches without any
`Function` site, under `"refuse"` too. For example:

- `function k(){return 1} var g = k; g.call();`
- `function C(){} C.prototype = function(){}; new C();`
- `var zz; var f = function(){ this.zz = 1 }; f(); zz;`, which traps exactly like `var zz; Function("this.zz = 1")(); zz`.

So "every gap keeps a named refusal" holds at select, but not at run time for those shapes.

### Acceptance, row by row

Measured with the `"refuse"` policy and `skipSemanticDiagnostics` (the test262 lane).

| row | result |
| --- | --- |
| call, `new`, `a,a`, fresh object per evaluation, `.name === "anonymous"` | node's answer |
| `typeof anonymous` outside and inside the body, a user `var anonymous`, two sites | node's answer |
| a sloppy body in a strict program, and a strict body in a sloppy program | node's answer |
| `var C = Function("this.a = 1"); new C().a` | node's answer |
| a reassigned global (`Function = f`, `globalThis.Function = f`, `delete Function`); `Function("return this")` with a second site | refuses: `Function literal: the global Function is not pristine (#7487)` |
| `Function("return this")` beside an eval site | refuses: `eval literal: the global eval is not pristine (#7363 A4)` |
| the reserved prefix beside a site | refuses: `identifier uses the reserved dynamic-function prefix` |
| a computed argument; a top-level `var Function` | keep today's refusal (no site) |

### Amended rows: deferred, with their owners

The rows below cannot meet the plan's answer yet. Each refuses at select, or, for the shapes in the yield table above,
aborts at run time through an existing run-time abort; none answers wrongly.

| row | plan | today | waits on |
| --- | --- | --- | --- |
| the separate-goal rejects (`a) { if (1 //`, `/*`…, injections); strict octal; strict `eval` parameter | throws SyntaxError | no source; today's refusal `direct call to "Function" has no exact AST-site plan` | slice A's static-SyntaxError site arm (#7363, not built) |
| `use strict` + non-simple params, `l: l:`, strict `with`, HTML-like comment | named refusal | the same generic refusal: the compile's gates drop the text, exactly as for eval (the named walk was deleted in review as dead) | the same arm; one label for both kinds |
| a body write to a caller global | the caller sees it | no source (RV7432 B2(b): a text that writes is no site) | #7363's write analyses over virtual sources |
| `Function("a", "b = 1", "...c", "").length === 1` | 1 | refuses: `rest/default/optional param not in Phase 1 IR scope` | IR default/rest parameters |
| `new (Function("this.a = 1"))()` | `a === 1` | refuses: `only direct constructor names supported in slice 4` | C2's direct-construct path |
| `toString()` | the assembled text | refuses: `needs Function.prototype's properties`, or traps through a `var` like every F1b value | #7350 (Function.prototype) |
| sloppy `this` (the 89 files) | the global object | refuses by item 8's name | #7350 B2b + #7354 C2 |

Known gap (RV-PR7556): bodies that are valid only in sloppy code, such as `Function("return 010")`, `Function("-->x")`
and `Function("", "-->x")`, make no source (a TS parse diagnostic, or the conservative HTML-like-comment check), so the
site keeps today's generic refusal `direct call to "Function" has no exact AST-site plan`.

The follow-up to move `function-source-text.ts` to a neutral leaf (lead, 2026-11-26) is still open.

