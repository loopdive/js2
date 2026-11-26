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
| `fnGlobalObject.js` only | 89 | 0 | 0 | 0 |
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
lands only the `src/frontend/eval` move and the dedupe; the seam (A1–A3) lands together with A4, and A4 waits on
#7350 B2b. The plan below is concrete about this arm, but its seam-facing details are checked against A1–A4's design
once that design is concrete. The plan review waits for that (lead, 2026-11-26).

The arm needs three things, in this order:

1. #7439, the `src/frontend/eval` move;
2. the A1–A4 PR, on branch `claude/prepared-eval-a7`, carrying RV7432's B1 fix (diagnostics in a virtual source
   refuse the site) and B2 fix (write analyses walk virtual sources);
3. S5's #7350 B2b on main, which A4 waits for.

The arm stacks on `claude/prepared-eval-a7` once S2 reports its head.

**Landed early, separately.** One CreateDynamicFunction text assembler, `functionSourceText(name, params, body)`, in
the import-free leaf `src/interp/function-source-text.ts`. It is listed in the provider's `INTERP_FILES`, the
interpreter and the legacy literal fold share it, and the legacy fold's template, which had no newline before `)`, is
removed. That is PR #7441, which addresses review P1.

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
   text (§20.2.1.1.1: `ParseText(P, FormalParameters)`, `ParseText(body, FunctionBody)`), so this arm does the same:
   - **Each piece in its own wrapper.** The parameter text is checked as `(<P>\n) => 0`, and the body as
     `function f() {\n<body>\n}`. Each must parse as exactly that wrapper, with the piece's end where the wrapper put
     it, and the assembled text must parse as exactly **one** `FunctionDeclaration` whose parameter-list and body spans
     equal the two inputs. Three examples, as in node:
     - `Function("/*", "*/){")` fails at the parameter piece;
     - the injections `Function("}; function x(){")` (body) and `Function("a){};(function(", "")` (params) fail;
     - they never become two declarations.
   - **HTML-like comments.** A piece containing `<!--` or a line-leading `-->` (Annex B.1.1) refuses by name
     (`dynamic function source uses an HTML-like comment`), since TS's parser does not implement them (TS1109).
   - **Early errors TS's parser misses.** These refuse by name (`dynamic function early error not covered: <rule>`):
     a strict body with non-simple parameters (default, rest, pattern), a duplicate label, strict `with`, strict
     legacy octal literals and escapes, and `eval`/`arguments` as strict parameter names. The covered set is the
     shared one, not a second copy:
     - slice A's `foldedEvalEarlyError` is split into a text-level `staticEarlyError(source, goal)` and the
       eval-site wrapper (`foldedEvalStaticSyntaxError`, which needs a `CallExpression` and the eval caller's
       capabilities, so P2's signature mismatch disappears);
     - this arm calls the text-level part only.
   - **A text that parses and passes the early-error set** becomes the virtual source. A text that fails throws a
     catchable SyntaxError at the site when the site runs: the same static-SyntaxError lowering slice A uses for a
     literal eval, reached through the text-level function.
4. **The virtual source and its name (P3).** The `function` source holds one top-level `FunctionDeclaration` named
   with a **unique synthesized name**, `__js2wasm_dynamic_function_<siteIndex>`, built by `functionSourceText`.
   - **No collision.** The name is never `anonymous`, so the checker never binds a global `anonymous` that a caller's
     `typeof anonymous`, a user `var anonymous` (TS2300) or another site could collide with.
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
7. **The site's identity test.** The site tests global `Function` === %Function% through `js.object.global` and
   `js.value.strict_eq`, the A4 shape for %eval%:
   - equal: the site evaluates to item 5's closure;
   - unequal: the site is a generic call or construct of the value, through C2's `lowerDynamicConstruct` / the
     dynamic call path.

### Gaps: each gets a JS answer or a named refusal, and an acceptance row

| gap | answer here |
| --- | --- |
| sloppy body's `this` | the global object, once #7350 B2b and #7354 C2's direct-call receiver land; until then C2's named refusal (`a direct call … installs no receiver for its 'this'`) |
| `toString()` | the exact assembled text with `anonymous` (item 4); a named refusal until `Function.prototype.toString` exists on this path |
| constructing the result (`new (Function("this.a = 1"))()`) | C2's constructor path: every function value here is a constructor |
| `length` with default / rest parameters | the §15.1.5 count from `emitFunctionObjectInit` (`Function("a", "b = 1", "...c", "")` → 1) |
| generic construct in the unequal arm | C2's `lowerDynamicConstruct`, or its named refusal |
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
- `typeof anonymous === "undefined"` both after a site runs **and inside the body**
  (`Function("return typeof anonymous")() === "undefined"`); a user `var anonymous = 1` beside a site compiles; two
  sites in one program both compile;
- `length`: `Function("a", "b = 1", "...c", "").length === 1`;
- `new (Function("this.a = 1"))().a === 1`;
- a sloppy body inside a strict program, and a strict body inside a sloppy program;
- P2's rows:
  - `Function("/*", "*/){")` throws SyntaxError;
  - the injections `Function("}; function x(){")` and `Function("a){};(function(", "")` throw SyntaxError;
  - an HTML-like comment refuses by name;
  - `Function("a = 1", "'use strict'")` throws SyntaxError;
  - `Function("l: l: ;")` throws SyntaxError;
- a write in the body to a caller-visible global is seen by the caller (B2);
- a local `var Function` shadow stays an ordinary call;
- a reassigned global `Function` takes the generic arm;
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
