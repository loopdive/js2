---
id: 4640
title: "ES5 standalone: statements/expressions smalls round 3 — undefined()/null() TypeError identity, named-funcexpr scope, nested-loop labels, object-literal getters, boxed-primitive receivers (~52 rows)"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: misc
goal: standalone-gap
related: [4621, 4620, 4519, 4484]
loc-budget-allow:
  # D7 — `Date(...)` without `new` (§21.4.2.1). The `new`-form arms for every
  # builtin global live in this module and the without-`new` arm has to sit
  # beside `tryCompileErrorCtorCallWithoutNew`, which is the only other
  # called-as-a-function ctor arm; splitting one of a pair into a new leaf is
  # how the two drift. Most of the +82 is the header explaining why this is a
  # CRASH fix (illegal cast in `__date_parse`) rather than a cosmetic one.
  - src/codegen/expressions/new-builtin-globals.ts
  # D3 — the sloppy-implicit-global compound-assignment arm. The lowering lives
  # in the leaf `implicit-global-binding.ts`; what lands here is the dispatch
  # arm plus the comment recording WHY it must precede the string-concat lane
  # (that lane's local carrier is exactly what swallowed the appends).
  - src/codegen/expressions/operator-assignment.ts
  # D1 — the nullish-callee dispatch arm. The helper lives in
  # `stored-member-closure-call.ts` (the documented home of the graceful
  # `undefined` fallback this narrows); the +13 here is the call plus the
  # pointer to why the STATIC guard cannot answer it.
  - src/codegen/expressions/call-identifier.ts
  # The sloppy-implicit-global `typeof` arm, which has to be repeated in BOTH
  # of this module's typeof ladders — the general one and the
  # `typeof x <op> "literal"` comparison fast path, which never calls the
  # general one and is the spelling test262 uses. Splitting them out would put
  # one arm of a pair in another file, which is how the two ladders got out of
  # step in the first place.
  - src/codegen/typeof-delete.ts
func-budget-allow:
  # Both are ONE dispatch arm plus its rationale comment, placed at the exact
  # point in an existing ladder where the decision has to be made — the
  # lowerings themselves live in leaf modules
  # (`implicit-global-binding.ts`, `stored-member-closure-call.ts`).
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  # The same sloppy-implicit-global `typeof` arm, once per ladder. Both are a
  # guard + a four-instruction emit + the comment saying why the OTHER ladder
  # needs its twin.
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/typeof-delete.ts::compileTypeofExpression
origin: "2026-08-23 wave-3 residual map (196 true failures). Lane D (.tmp/lane-D-smalls.txt) + try/return/Date leftovers."
---

# #4640 — statements/expressions smalls round 3

## Problem (measured 2026-08-23 on branch tree) — bounded families

- **D1 — calling an undefined/null VALUE throws a real TypeError (~5)**:
  `var x = undefined; x()` — currently the thrown thing is
  `[object Object]` not `instanceof TypeError` (S11.2.3_A3_T4/T5), and
  `11.2.3-3_3/4`: argument evaluation ORDER — §13.3.6.1 evaluates the
  callee ref, then arguments, THEN throws on non-callable — `fooCalled`
  must be true. #4519's guard covered member GETs; this is the call-value
  twin.
- **D2 — named function EXPRESSION scope (~4)**: `S11.13.1_A6_T1/T2` —
  the funcexpr's own NAME binding must not leak/shadow the outer
  assignment target (`innerX`); `S13.2.2_A19_T8` twin in lane A.
  `8.12.5-3-b_1` — native-code render mismatch in descriptor get/set
  toString (cosmetic render, check against #4637-A4's render).
- **D3 — nested-loop deep var resolution (~3)**:
  `for/S12.6.3_A10_T1/A10.1_T1` — `index6/index8 is not defined` in
  6/8-deep nested loops writing through `eval`-free label bodies; and the
  for-head completion-value row. Smells like a per-depth local-allocation
  cap or shadow-name suffixing bug — reduce depth to find the cliff.
- **D4 — object-literal ACCESSORS at module scope (~3)**:
  `11.1.5-0-1/2` — a get accessor defined in an object literal answers
  null instead of running (module-init getter installation order);
  `S11.1.5_A2` — a wrapper-object property value loses identity.
- **D5 — boxed-primitive receiver own-property writes (~6)**:
  `(5).x = 5; (5).x` family (10.4.3-1-104/106) — sloppy-mode ToObject
  receiver semantics: write succeeds on the temp wrapper, read of the
  temp answers undefined BUT `(5).x === 5` in the SAME expression per
  test expectation — re-read the rows precisely; `typeof (5).x`; strict
  twins throw. #4620 family C named the boxed-receiver accessor path.
- **D6 — with/try/typeof/instanceof smalls (~10)**: with-scope writes
  (S12.10_A5_T5 array-valued twin), `try` catch-param property rows,
  `S12.14_A18_T6` valueOf-object identity across throw (#4621-H pinned),
  instanceof shifted-expression rows, `typeof` on `new`-ed results.
- **D7 — misc singles (~10)**: `S12.9_A5` (return without expression →
  undefined not 0), annexB catch-redeclared-var, comments compile rows,
  directive-prologue pair, identifier-resolution pair, Error pair,
  `Date/S15.9.2.1_A2` illegal cast in `__date_parse` (CRASH class —
  FIRST), JSON/Math singles, `function-code` S10.2.1 rows.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   every family live; D7's Date illegal-cast crash FIRST.
2. D1: emit a constructed TypeError instance (the #1380 pattern in
   identifiers.ts L1574 area does this for ReferenceError — mirror it at
   the call-value null/undefined guard), and move the throw AFTER
   argument evaluation per §13.3.6.1.
3. D2: the funcexpr name binding is an inner immutable binding — check
   how compileLiftedClosureBody scopes `arrow.name` and stop it aliasing
   the outer local.
4. D3: reduce depth-by-depth; find where deep nesting drops a
   declaration.
5. D4/D5/D6: per-row triage with WAT decode; decline
   representation-walled rows with named owners (#4638 vec/holes,
   #4637 fnctor edge, value-rep to-primitive carrier).
6. Verify: per-family scoped runs before/after (own runs); pins
   4621/4620/4519/4484 green; pins tests/issue-4640.test.ts; ≥25 of ~52
   flip OR every non-flipped row declined with a named owner; zero
   regressions.

## Results

**Branch `issue-4640`, based on the campaign tip `81445abf7`.** Every number
below is from a run executed on this branch, in this worktree, by the agent that
wrote this section. Base-copy A/B (`.tmp/base-*.ts` captured at the first edit of
each file), never `git stash`.

### Scoped standalone sweep — 930 → 940, **zero regressions**

970 ES≤5 files (the intersection of `.tmp/es5-files.txt` with the directories
this change-set can reach: `expressions/{call,new,assignment,compound-assignment,
postfix-*,prefix-*}`, `statements/{for,while,do-while,with,return,try,switch}`,
`types/`, `identifier-resolution/`, `global-code/`, `built-ins/Date/`).

| arm | pass | source |
| --- | --- | --- |
| before | 930 / 970 | base copies restored, `.tmp/sweep-before.txt` |
| after | 940 / 970 | this branch, `.tmp/sweep-after.txt` |

Ten flips, no row went the other way:

```
built-ins/Date/S15.9.2.1_A2.js                    (D7 — the CRASH)
language/expressions/call/S11.2.3_A3_T4.js        (D1)
language/expressions/call/S11.2.3_A3_T5.js        (D1)
language/expressions/new/S11.2.2_A3_T4.js         (D1)
language/expressions/new/S11.2.2_A3_T5.js         (D1)
language/statements/for/S12.6.3_A10_T1.js         (D3)
language/statements/for/S12.6.3_A10.1_T1.js       (D3)
language/identifier-resolution/S11.1.2_A1_T1.js   (D3, `this.y++`)
language/types/reference/S8.7.2_A3.js             (D3, `this.x++`)
language/types/reference/S8.7_A5_T2.js            (D3, `typeof`)
```

### Root causes — and three places the issue's map was wrong

**D7 — `Date(...)` without `new` had no arm at all.** §21.4.2.1 returns
ToDateString(now), a **String**, ignoring every argument; the `new` form is a
different clause, so it cannot delegate the way the Error-family arm does. The
call fell through to the generic builtin terminal and produced
`ref.null.extern`, while the checker typed the expression `string` (lib.es5's
`DateConstructor` call signature). Nothing downstream re-checked it, so
`Date.parse(Date())` handed a NULL externref to the native `__date_parse`, whose
first act is `any.convert_extern` + `ref.cast` — an **illegal-cast trap**. The
static type being right while the value was `null` is what made this invisible:
`typeof Date()` folds off the checker type, so the obvious probe agrees with the
spec while the emitted value does not.

**D1 — the map said the thrown thing was `[object Object]` instead of a
TypeError instance. It was not: nothing was thrown at all.** Measured on the
base branch, `try { var x = undefined; x(); } catch (e) {}` fell through with no
exception; the `[object Object]` in the failure text is the test's OWN
`Test262Error`, raised on the line after the call and rendered by its own catch.
`emitThrowTypeError` already mints a real `$Error_struct`. The missing throw is
the #4221 guard declining: #4616 treats a nullish initializer on a mutable
binding as committing nothing, which is correct for `let x = null; … x = fn;
x()` and wrong for a binding the module never re-targets. Narrowed the carve-out
with a whole-file re-target scan (over-approximating in the declining
direction). `new x` came along for free — same guard.

A pure runtime nullish check was tried first and **cannot** substitute:
`var x = undefined` lowers to an **f64 NaN local**, so the externref read at the
call site is a boxed NUMBER and neither `ref.is_null` nor `__extern_is_undefined`
answers true for it. The runtime arm is retained as a strict narrowing of the
graceful-`undefined` fallback for callees that really are nullish externrefs.

**D3 — there is no depth cliff.** The map read `index6`/`index8 is not defined`
as a per-depth local-allocation cap and suggested bisecting depth. Measured:
`x = 1; x++` fails at depth **zero**. Read-modify-write on a sloppy implicit
global was broken in four independent places, and the deepest loop body is
simply the first place any of them executes:

1. `tryEmitUnresolvableUpdateThrow` threw a STATIC ReferenceError for `x++`
   because a sloppy implicit global is unresolvable to the checker and
   perfectly resolvable at run time. It already declines for a `with` binding
   for exactly this reason; the implicit-global case was missing.
2. `x += rhs` had no implicit-global arm, so `compileCompoundAssignment` reached
   its genuinely-undeclared branch and threw the same ReferenceError.
3. Once (2) was fixed, `__str += "…"` still silently lost every append: it took
   the string-concat lane, whose `local.get`/`local.tee` carrier the
   global-object read never consults. The arm therefore has to sit ABOVE that
   lane, not next to the throw it replaces.
4. `this.y++` / `this.x += 1` never registered the name at all —
   `collectGlobalObjectPropertyNames` collected only `=` targets, though all
   three forms end in PutValue on the same Reference and so all three CREATE
   the property.

`+=` routes through `__any_add`, not ToNumber: §13.15.2 defers to §13.10.1, so
`__str += "a"` must concatenate. Every other compound operator ToNumbers both
operands by definition and reuses `emitCompoundOp`.

**D3 follow-on — `typeof` had the mirror-image bug.** `typeof x` on such a name
folded to the constant `"undefined"`: correct for a genuinely unresolvable
Reference, a static lie once the assignment has run. It needed the arm in BOTH
of `typeof-delete.ts`'s ladders — the general one and the
`typeof x <op> "literal"` comparison fast path, which never calls the general
one and is the spelling test262 actually uses.

### Files changed

| file | what |
| --- | --- |
| `src/codegen/expressions/new-builtin-globals.ts` | `tryCompileDateCallWithoutNew` (D7) |
| `src/codegen/expressions/calls.ts` | dispatch it beside the Error-ctor arm |
| `src/codegen/expressions/calls-guards.ts` | `nullishBindingIsRetargeted` — narrows the #4616 carve-out (D1) |
| `src/codegen/expressions/stored-member-closure-call.ts` | `tryEmitNullishIdentifierCalleeTypeError` (D1, runtime half) |
| `src/codegen/expressions/call-identifier.ts` | dispatch it before the graceful `undefined` fallback |
| `src/codegen/update-unresolvable-ref.ts` | decline for implicit globals (D3.1) |
| `src/codegen/expressions/implicit-global-binding.ts` | `tryEmitImplicitGlobalCompoundAssign` (D3.2/3.3) |
| `src/codegen/expressions/operator-assignment.ts` | dispatch it ABOVE the string-concat lane |
| `src/codegen/source-scan-predicates.ts` | collect `this.x++` / `this.x += v` targets (D3.4) |
| `src/codegen/typeof-delete.ts` | implicit-global `typeof`, both ladders |
| `src/codegen/global-environment.ts` | late-import index re-read — **hardening, not a measured fix**; investigated as a D3 cause and ruled out |

### Pins

- `tests/issue-4640.test.ts` — 19 tests, green under the DEFAULT (quickjs) tier
  and under `JS2WASM_EVAL_ENGINE=interpreter`. 7 `pinRow` for the flipped
  families, 12 `it.fails` for measured residuals, each carrying its owner.
- `tests/issue-4621.test.ts` 27/27 · `tests/issue-4620.test.ts` 11/11 ·
  `tests/issue-4519.test.ts` 16/16 · `tests/issue-4484.test.ts` 27/27 — all run
  on this branch, all green.

## Residuals — every non-flipped row, with an owner

The acceptance bar was "≥25 of ~52 flip **OR** every non-flip declined with a
named owner". **10 flipped, so this list is the binding half.** It covers all 55
rows of the assignment (`.tmp/lane-D-smalls.txt` + the three try/return/Date rows
of `.tmp/lane-leftover.txt`).

| rows | owner | why not here |
| --- | --- | --- |
| `call/11.2.3-3_3`, `-3_4`, `-3_8` | the #4519 member-guard line | Needs a runtime IsCallable test on a **member** callee, and §13.3.6.1 ordering (`o.bar.gar` must throw before the args run; measured `fooCalled === true`). Deliberately not attempted: the member-read lane answers `null` for shapes that are OUR gap as often as the program's, so throwing there converts compiler gaps into hard runtime failures. |
| `assignment/S11.13.1_A6_T1`, `_T2` | runtime-eval lane | NOT named-funcexpr scope (the issue's D2 reading). Both are `x = (eval("var x;"), 1)` — a direct eval creating a binding in the running function's VariableEnvironment mid-expression, with PutValue targeting the reference created BEFORE it. |
| `assignment/8.12.5-3-b_1` | dev-4637 (A4 render) | `function () { [native code] }` descriptor get/set render identity. |
| `assignment/S8.12.5_A2` | object-model / element-access lane | `RuntimeError: dereferencing a null pointer in __str_concat()` — a numeric key on an object literal. A crash, but in another lane's substrate. |
| `object/11.1.5-0-1`, `-0-2` | runtime-eval lane | The accessors are minted by `eval("o = {get foo(){…}}")` — this compiler never sees the object literal, so the family is not the object-literal lane's. |
| `object/S11.1.5_A2` | #4481 value-identity | Fails only on CHECK#2: `new Boolean(true)` through a literal property loses wrapper identity. |
| `function-code/10.4.3-1-103`, `-104`, `-106` | #4620 / #4491 | `Object.defineProperty(Object.prototype,"x",{get(){return this}})` then `(5).x` in strict mode — the getter must receive the UNBOXED primitive as `this`. #4620 named this family (primitive-`this`); the install route is #4491's defineProperty MOP. |
| `function-code/10.4.3-1-17-s`, `-83-s`, `-84-s` | runtime-eval lane | Bodies minted by `eval` / `new Function`. |
| `function-code/S10.2.1_A4_T1`, `_T2` | dev-4637 | `f1().constructor.prototype === Function.prototype` — the Function-instance surface. |
| `Error/length`, `Error/prototype/constructor/S15.11.4.1_A1_T2` | dev-4637 | `.length` on an error constructor; calling `Error.prototype.constructor`. |
| `addition/S11.6.1_A2.2_T3` | dev-4637 | `f1 + 1 === f1.toString() + 1` — `Function.prototype.toString` source text. |
| `instanceof/S11.8.6_A6_T4`, `S15.3.5.3_A3_T2` | dev-4637 | `[[HasInstance]]` on non-Function objects / joined functions. |
| `Array/S15.4.3_A1.1_T1`, `_T2`, `S15.4_A1.1_T9`, `_T10` | dev-4638 (vec/array substrate) | `Array.myproperty` static-property read is an outright standalone codegen error; the `_A1.1` pair is array-hole / index-domain. |
| `statements/return/S12.9_A5`, `types/undefined/S8.1_A2_T2`, `types/boolean/S8.3_A1_T1` | value-rep lane — **see the escalation below** | Mixed-return functions answer `0` where the spec says `undefined`; a hoisted `var` read before its declaration answers its wasm type's zero. |
| `for/head-init-expr-check-empty-inc-empty-completion` | core-semantics (completion values) | A `for` statement's completion value must stay `undefined` when the body never runs. |
| `try/12.14-7` | statements/try lane | A catch parameter must not be readable after the catch block; we leak it as a function-scoped local, so the read does not throw. |
| `try/S12.14_A18_T6` | #4621 (H, already pinned there) | valueOf-object identity across a throw. |
| `annexB/…/try/catch-redeclared-var-statement` | statements/try lane (Annex B B.3.5) | `catch (foo) { var foo = … }` must write the catch PARAMETER, not the outer var. |
| `with/S12.10_A5_T5`, `identifier-resolution/S10.2.2_A1_T3`, `types/reference/8.7.2-1-s` | runtime-eval lane | All three are `eval("with(…){…}")` / `eval("x = 1")` under strict. |
| `types/object/S8.6.2_A8` | #4491 object-model | `[[Prototype]]` of a non-extensible object must not be mutable. |
| `in/S11.8.7_A2.4_T1`, `instanceof/S11.8.6_A2.4_T1` | core-semantics | `var NUMBER = 0; (NUMBER = Number, "MAX_VALUE") in NUMBER` — the operand is re-bound by a comma expression the static typing does not follow. |
| `in/S8.12.6_A2_T2` | prototype-chain lane | `"phylum" in obj` after `Robin.prototype = __proto`. |
| `JSON/parse/S15.12.2_A1` | JSON / object-model | `JSON.parse('{"__proto__":[]}')` must create an ordinary own property. |
| `Number/15.7.4-1` | #4481 value-identity | `Object.prototype.toString` brand for a `Number` wrapper. |
| `directive-prologue/14.1-4-s`, `14.1-5-s` | #4620 (primitive-`this`) | `foo.call(undefined)` under a directive prologue. |

### ESCALATION — a wider bug found while measuring, not fixed here

`function f(c) { if (c) return; return 5; }` — **`f(true)` answers `0`, not
`undefined`.** Measured on this branch:

```
a:0            // x3++; return; return x3;   → 0, spec undefined
b:0/5          // if (c) return; return 5;   → 0 / 5, spec undefined / 5
c:true/undefined   // a genuinely void function is fine
```

The wasm return type is `f64` and a bare `return;` emits `f64.const 0`. This is
not one test262 row — it is every mixed-return function in every compiled
program, and the early-exit `if (!x) return;` shape is ubiquitous. Fixing it
means widening such functions to an externref return, which is a
value-representation change with real perf and call-site blast radius, so it
does not belong in a smalls issue. Pinned as `it.fails` in
`tests/issue-4640.test.ts` (`statements/return/S12.9_A5`); please file it against
the value-rep lane.
