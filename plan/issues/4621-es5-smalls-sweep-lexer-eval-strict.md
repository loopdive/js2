---
id: 4621
title: "ES5 standalone: smalls sweep — regexp-literal lexing code-units, strict eval/arguments-assignment TypeErrors, switch(null), with-scope writes, comment compile-timeouts, Math_random host-import CE (~35 rows)"
status: done
completed: 2026-08-25
assignee: ttraenkler/dev-4621
sprint: current
created: 2026-08-16
updated: 2026-08-25
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: misc
goal: standalone-gap
related: [4426, 4484, 4485]
origin: "2026-08-16 residual map at 97.26%. Long-tail buckets grouped into bounded slices."
loc-budget-allow:
  # Six families, six arms, each of which must sit inside an existing ORDERED
  # dispatch. Arm ORDER is the load-bearing property in every one of these
  # files, so an arm cannot be lifted into a subsystem module without lifting
  # the ordering decision with it — which is the bug class this campaign keeps
  # re-fixing, not a refactor it wants. Each entry is majority COMMENT: the
  # measured reason is longer than the emitted code.
  #
  #  - early-errors/node-checks.ts +37: two `on([...])` registrations plus the
  #    `nodeIsParserSynthesizedMissing` predicate. This file IS the early-error
  #    registry — a check that lives anywhere else is a check `runNodeChecks`
  #    never runs. Real code is ~12 lines; the rest explains why TS code 1109 is
  #    tolerated in compiler.ts and why re-raising exactly two parser-recovered
  #    zero-width shapes is sound.
  #  - statements/control-flow.ts +33: the NULL arm of `emitSwitchStrictEq`. It
  #    wraps the existing tag cascade (now a named `taggedCascade` array) in one
  #    `if`, ~11 instructions. It cannot move: the cascade closes over `lTmp`/
  #    `rTmp` and over the `refArm`/`identityArm` locals allocated in this
  #    function, and the arm must precede the tag dispatch.
  #  - native-strings.ts +31: the `ref.is_null → "null"` arm at the top of
  #    `__any_to_string`'s body. Five instructions. The helper is built here and
  #    cached under `nativeStrHelpers`; the arm has to be the FIRST test, ahead
  #    of the `$AnyString` / `$AnyValue` shape tests, so it is structurally part
  #    of this builder.
  #  - expressions/assignment.ts +30: the §19.1.1-19.1.3 bare-identifier arm.
  #    The predicate and the name table live in the subsystem module
  #    (`builtin-nonwritable-write.ts`, where #4484 C already put its twin);
  #    what stays here is the ~8-line call site plus the note on why it must sit
  #    above the `localMap` lookup and why the shadowing proof is load-bearing.
  #  - binary-ops.ts +23: one extra disjunct on `rightIsAbstractNonString`
  #    (three lines) plus the note recording that this file's own #2503 comment
  #    already described the object case the flag did not test.
  #  - expressions/new-super.ts +56: the nested-`new` arm, which must sit inside
  #    `compileNewExpression`'s unwrap block next to the direct
  #    NAMESPACE_NON_CONSTRUCTORS arm it shares a set with (that set is hoisted
  #    to module scope by this change so the two arms cannot drift). Already
  #    carried by #4506's grant for the same path; listed here for attribution.
  - src/compiler/early-errors/node-checks.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/native-strings.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/math-helpers.ts
  - src/codegen/declarations/import-collector.ts
func-budget-allow:
  # The same three edits seen per-function; the fourth (`compileNewExpression`)
  # is already granted by #4506 for this path.
  #  - ensureAnyToStringHelper 606 -> 637: this function IS `__any_to_string`'s
  #    body builder. The new arm is the body's outermost `if`.
  #  - compileAssignment 531 -> 557: this function is the ORDERED chain of
  #    identifier/target assignment arms; a new arm is one more link and its
  #    position is the fix.
  #  - compileBinaryExpression 1647 -> 1670: the route-selection preamble that
  #    decides between the string fast path and the runtime-tag cascade. The
  #    change is to that decision, so it cannot live outside it.
  - src/codegen/native-strings.ts::ensureAnyToStringHelper
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
---

# #4621 — ES5 smalls sweep

## Problem (measured 2026-08-16) — seven bounded families

- **A — regexp-literal lexing (7)**: `S7.8.5_A*_T2` + annexB
  `RegExp-{leading,trailing}-escape-BMP` — "Code unit: 0 Expected
  SameValue(«undefined», …)": the literal's source/exec on escape shapes
  loses code units; plus `RegExp-control-escape-russian-letter` +
  "Unsupported dynamic regular expression pattern" (2 in built-ins/RegExp).
- **B — strict-mode eval/arguments assignment TypeErrors (~4)**:
  `10.2.1.1.3-4-16-s`/-18-s etc. — assigning to an immutable binding in
  strict code must throw TypeError.
- **C — global-object value props round 2 (2)**: `S10.2.3_A1.1/1.2_T3`
  `Date === null` — the #4485-B carrier family for CONSTRUCTOR globals
  (needs callable with own length/name/prototype; #4485's residual
  recorded exactly this).
- **D — operator smalls round 2 (~8)**: `switch(null)` (2 — null case
  dispatch), `equals/does-not-equals` ToPrimitive-order rows (2),
  `addition S11.6.1_A3.2_T2.4` (`new String("1") + null`), `in` rows (2 —
  may be #4506-walled, verify), `new/S11.2.2_A4_T5` (`new new Math()`
  TypeError).
- **E — with-scope writes (2)**: `S12.10_A5_T4/T5` `x === 1` got
  undefined — a WRITE inside `with` to an outer var.
- **F — compile timeouts (2)**: `comments/S7.4_A5/A6` (10s timeout —
  pathological comment lexing; likely a lexer loop, diagnose with a
  smaller repro).
- **G — Math_random host-import CE (1)**: `S15.8.2.14_A1` — standalone
  emitted `env::Math_random`; needs a native PRNG (spec allows any
  implementation-defined randomness; a simple xorshift seeded
  deterministically is acceptable) or decline-with-skip.
- **H — try/throw property-on-null (2 + throw twin)**: `S12.14_A18_T6`,
  `S12.13_A2_T6` — catch-parameter object property access.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   every family live; F (timeouts) and G (CE) are crash/CE class — first.
2. F: reduce the comment shape; fix the lexer loop bound.
3. A: the regexp LITERAL path (lexer→pattern encoding); compare with the
   dynamic-pattern path; the escape families are table-driven.
4. B: strict-assignment machinery from #4484-C (spec-non-writable arm) —
   extend to immutable env-record bindings.
5. C: extend the #4485-B carrier family per its residual note (callable
   constructor carriers).
6. D/E/H: per-row; E reads the with-statement lowering (#1387-guarded) —
   the write-through arm for proven-closed shapes.
7. Verify: per-family scoped runs before/after (own runs); pins
   4484/4485 + regexp suites green; ≥18 of ~35 flip, zero regressions;
   residuals with owners.

## Re-measurement (2026-08-23) — the map above was partly stale

Everything below is from runs **I** executed on branch `issue-4621`, base
`04c0d5d42` (the campaign branch tip), standalone lane via `runTest262File`,
with `.tmp/base-*.ts` revert copies captured at the first edit of every source
file and re-run for the before-numbers.

The live failing population inside the seven named families is **23 rows, not
~35**, and three of the seven need correcting before anything else:

| family | the issue says | measured on the base |
| --- | --- | --- |
| **A** regexp-literal lexing (7) | "loses code units" | 5 rows fail, and the cause is NOT the literal path — see below |
| **F** comment compile-timeouts (2) | 10 s timeout | **both already PASS** at the 10 s CI timeout |
| **G** `Math_random` host-import CE (1) | standalone CE | **already PASSES** |
| **B** strict eval/arguments TypeErrors (~4) | ~4 | 2 rows |
| **C** `Date === null` (2) | 2 | 2 rows ✔ |
| **D** operator smalls (~8) | ~8 | 10 rows in scope, of which 8 are ES5 (the rest are ES6 spread) |
| **E** with-scope writes (2) | "a WRITE inside `with`" | 2 rows, but the defect is `delete`, not a write — and it is **not** eval-specific |
| **H** try/throw property-on-null (2) | "catch-parameter property access" | 2 rows, and the failing statement is **not** the catch clause |

**Family A is an eval-THROUGHPUT wall, not a `.source` bug.** Two separate
measurements:

- `eval("/abc/")` with a CONSTANT source string folds and `.source` is right;
  with a COMPUTED source (`eval("/" + xx + "/")`, which is what every `_T2` row
  does) the result is a provider handle whose `.source` reads `undefined` —
  measured for cu = 0, 1, 9, 32, 65, 97, 0x410, 0xffff, all `undefined`.
- That is not the binding constraint. Each `_T2` row runs ~65,500 runtime
  evals. A probe that runs the identical loop with **every `.source` read
  removed** did not finish: killed at **>290 s** against a 10 s budget. A
  smaller calibration probe put steady-state runtime eval at ~3.6 ms/eval at
  load 7.8 (500 evals, 1794 ms of execute time including provider init).

So fixing `.source` would convert `fail` into `timeout`, not into `pass`.
Declined here and recorded as a residual against the runtime-eval-throughput
lane.

**F is load-sensitive, not broken.** Both comment batteries also run ~65,536
evals. In a fresh process at load ~7 they pass in under 10 s (measured on the
base BEFORE any edit, and again on the final tree). Inside a vitest file, after
two dozen prior compiles in the same worker, both exceed 60 s. They are
therefore not pinned in `tests/issue-4621.test.ts` — a pin whose verdict tracks
machine load is not evidence about the compiler.

## Root cause (per arm)

**B — §19.1.1-19.1.3, bare-identifier spelling.** `NaN`, `Infinity` and
`undefined` are `{[[Writable]]: false}` value properties of the global object,
so a strict-mode `NaN = 12` is a PutValue whose [[Set]] fails and §6.2.5.6 step
6.a throws. #4484 C built the table and the shadowing proof for the PROPERTY
spelling (`Math.PI = 20`); the identifier spelling had no arm at all and
silently did nothing.

**C — `Date` had no carrier.** #4485's residual table named this exactly. Every
other constructor in `S10.2.3_A1.{1,2}_T3`'s 15-name walk already had one
(`Object`/`Array` namespace objects, the Error family, the #4223 wrappers,
`RegExp`, `Function` via #4442); `Date` alone read `ref.null.extern`.

**D — `case null` could never match.** The standalone strict-equality cascade in
`emitSwitchStrictEq` ends in an identity arm that does `ref.test (ref eq)` on
both operands. `ref.test` with the non-nullable `eq` heap type answers **0** for
a null, so two nulls fell out of the cascade as unequal and `switch (null)` took
`default`. `undefined` was unaffected because it is the tag-1 singleton (#4489),
not a null.

**D — `switch ()` / `case :` compiled and RAN.** TypeScript *does* report
"Expression expected" for both, but that code (1109) is in
`TOLERATED_SYNTAX_CODES` in `compiler.ts`, downgraded to a warning by #537
because the TS-mode parser raises it for several patterns that are valid
JavaScript. The blanket tolerance also swallowed these two genuine grammar
violations.

**D — ToString(null) rendered "[object Object]".** `__any_to_string`'s tag-0
("null") arm only fires for an `$AnyValue` **box**; a RAW null ref fell past it
into `residualArm` and out the "[object Object]" terminal. The residual-arm
comment even listed "null ref" among the shapes it handled — it did not handle
it. Only additions with an OBJECT operand reach this terminal (they route
through `addition-to-primitive.ts`, which boxes both sides to anyref); the
all-primitive spellings fold statically and were always right, which is what hid
it. Measured surface: `new String("1") + null` → `"1[object Object]"`,
`{} + null` → `"[object Object][object Object]"`,
`{toString(){return "T"}} + null` → `"T[object Object]"`.

**D — `"str" == {obj}` never called ToPrimitive.** The static-string-LEFT route
excludes an `any`/`unknown` right operand from its content-compare fast path —
and this file's own #2503 comment already described the object case ("or an
object (must ToPrimitive then recurse …)") — but the flag it wrote only tested
`Any | Unknown`, so a right operand with a real OBJECT type still took the pure
content compare. Measured: `"+1" == {valueOf(){return 1}, toString(){return {}}}`
answered `false` with an **empty call log** — neither method ran.

**D — `new new Math()` produced `undefined`.** `new Math`, `new Math()` and
`var x = new Math(); new x()` all threw already. The generic guard
(`tryNonConstructableNewTarget`) cannot reach the nested spelling: it asks the
oracle for the callee's type fact, and `new Math()` has an ERROR type, so the
fact is `any` — which that guard rightly refuses to act on, since a constructor
may `return function(){}`.

**H — a property NAMED `eval` poisoned the whole module.** This one took the
longest to find and the error message pointed at the wrong statement.
`deadcode-elide.ts` counted EVERY identifier spelled `eval`/`Function` as an
escaped evaluator, including a member name (`e.eval()`) and an object-literal key
(`{eval: fn}`). One surviving "unknown dynamic position" revives **every** dropped
candidate — including the `$262.evalScript` shim, whose own computed `eval` then
puts the module in runtime-eval carrier mode. That is the failure this module's
own doc comment already describes for `Function.prototype.*`; the member-name
case is the same bug one position over, and the mirror predicate in
`src/ir/runtime-eval-boundary-plan.ts` (`isMemberName`) already had the carve-out.

The consequence is what made it hard to see: with the module in carrier mode, the
top-level `myObj.i = 6` on line 268 of the ASSEMBLED source routes through a
global environment record whose realm object was never seeded, so its receiver
null-check throws "Cannot access property on null or undefined **at 268:1**".
The runner's own source-map lookup attributed that offset to the catch clause
(`at L30: if (e.p1!=="a") …`), 30 lines earlier — so the reported statement, the
catch-parameter read, was never the problem. `myObj` itself is a live object
there; a bare `myObj` READ answers correctly in the same module.

## Fix

| arm | file | shape |
| --- | --- | --- |
| B | `src/codegen/builtin-nonwritable-write.ts` + `expressions/assignment.ts` | `isSpecNonWritableGlobalValueName` + a strict-gated arm on the identifier-assignment chain, above the `localMap` lookup, behind the existing `resolveUnshadowedGlobalIdentifier` shadowing proof |
| C | `src/codegen/builtin-static-globals.ts` | `"Date"` added to `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` (one line + the safety argument) |
| D switch-null | `src/codegen/statements/control-flow.ts` | a NULL arm ahead of the tag cascade in `emitSwitchStrictEq`: either-null ⇒ both-null |
| D switch-parse | `src/compiler/early-errors/node-checks.ts` | two `on([...])` checks for a parser-recovered zero-width `SwitchStatement.expression` / `CaseClause.expression` |
| D ToString(null) | `src/codegen/native-strings.ts` | `ref.is_null → "null"` as the FIRST test in `__any_to_string`'s body |
| D string==object | `src/codegen/binary-ops.ts` | one extra disjunct on `rightIsAbstractNonString` for the `object` type fact — `object` ONLY (see the in-file note on why `class`/`builtin`/`function` decline) |
| D new-new-Math | `src/codegen/expressions/new-super.ts` | nested-`new` arm next to the direct namespace arm; `NAMESPACE_NON_CONSTRUCTORS` hoisted to module scope so the two cannot drift |
| H | `src/deadcode-elide.ts` | `isNonReferenceEvalMention` — member names and object/class member KEYS are not references. Shorthand `{eval}` and computed `{[eval]:1}` deliberately still count |

## Test Results

Every number is from a run I executed. The `.tmp/base-*.ts` copies were captured
at the first edit of each file; the base runs below were produced by checking
those files back out at `04c0d5d42` and re-running under identical conditions.

**Clean A/Bs — serial, single process, identical 40 s timeout on both sides:**

| scope | base | after | delta |
| --- | --- | --- | --- |
| the 14 rows this issue flips | **0/14** | **14/14** | **+14**, 0 broke |
| `built-ins/global` (29 rows) | 23/29 | **27/29** | **+4**, 0 broke |
| `built-ins/Date` — all 78 constructor-surface rows + a 1-in-4 sample of `prototype/` (213 rows) | 151/213 | **164/213** | **+13**, 0 broke |
| **host/gc lane** — `built-ins/global` + `switch` + `new` + `throw` + `addition` (261 rows) | 208/261 | **213/261** | **+5**, 0 broke |

**Wide standalone sweep** — 1121 rows over the 14 directories the seven families
live in (`literals/regexp`, `annexB/built-ins/RegExp`, `comments`, `switch`,
`try`, `throw`, `with`, `in`, `new`, `addition`, `equals`, `does-not-equals`,
`built-ins/global`, `Math/random`), 3 shards, 15 s: base **939/1121** (1021 s).
Re-run after the change in two halves, both sharded exactly like the baseline:

| half | rows | base | after | net |
| --- | --- | --- | --- | --- |
| the 8 directories my diff can reach | 547 | 454 | 453 | −1 (all 11 "breaks" are load artifacts, see below) |
| the remaining 6 (**regexp + annexB/RegExp + with + in + try + comments**) | 860 | 738 | **738** | **0** — 2 fixed, 2 "broken", both load artifacts |

> ⚠ **Neither "break" is real, and both are the same instrument error.** The
> 547-row half reported 11 `built-ins/global` rows newly broken, ALL with
> "compilation timeout" at 15-32 s against a 15 s budget, at 1-minute load 10-16
> with three sibling agent lanes on a 4-core box. Re-run serially at load ~7 with
> a 40 s timeout, that directory goes 23/29 → 27/29 with **zero** regressions
> (table above). The 860-row half likewise reported
> `language/statements/with/S12.10_A1.{3_T3,5_T5}` as broken at 15.7 s / 16.9 s;
> run serially both pass, and their compile time is **faster** with the change
> than without it (11.3 s vs 13.1 s, and 6.5 s vs 8.5 s — measured both
> directions, same process shape, same box). Both rows already sat near the
> budget on the base. This is the hazard the campaign brief warns about, and
> disproving it cost a full sweep cycle: **a sharded sweep is not a valid
> instrument for a timeout-adjacent row.**

### Against the acceptance bar ("≥18 of ~35 flip")

Stated plainly, because the two numbers differ: **27 rows flip in total, but only
14 of them are inside this issue's own named families.** The bar was written
against the 2026-08-16 map, and 10 of the ~35 rows it counted are not winnable
here — F (2) and G (1) already pass, and A (~8) is walled behind a >30x
eval-throughput gap, all three measured above. Of the ~27 rows that were really
failing in the seven families, 14 flipped and 13 are declined with a named owner
in the residual table below. The other 13 flips are `built-ins/Date` rows that
fall out of family C's carrier.

**Total: 27 rows flip** — 14 in the issue's own scope plus 13 more in
`built-ins/Date` that fall out of family C (exactly the rows #4485's residual
table predicted: `built-ins/Date/{is-a-constructor, name, length, S15.9.4_A1,
_A4, _A5, S15.9.3.1_A2_T1..T6, S15.9.3.2_A2_T1}`). Zero regressions in either
lane.

Flip list, in-scope (each verified individually, serial, both directions):

- B: `built-ins/global/10.2.1.1.3-4-{16,18}-s.js`
- C: `built-ins/global/S10.2.3_A1.{1,2}_T3.js`
- D: `language/statements/switch/S12.11_A1_T{3,4}.js` (null case dispatch),
  `S12.11_A3_T{1,4}.js` (the two grammar violations),
  `scope-var-none-case.js` (unexpected — it was failing "reference preceding
  statement Expected SameValue(«2», «3»)" on the base and passes now)
- D: `language/expressions/addition/S11.6.1_A3.2_T2.4.js`,
  `equals/S11.9.1_A7.9.js`, `does-not-equals/S11.9.2_A7.8.js`,
  `new/S11.2.2_A4_T5.js`
- H: `language/statements/throw/S12.13_A2_T6.js`

**Pins:** `tests/issue-4621.test.ts` — **27 tests, all green, exit 0**. Six of
them are `pinResidualRow` (the row must STILL fail) so a later fix trips the pin
rather than leaving the residual table below stale. The file carries the #4003
`afterEach` macrotask-yield mitigation; measured A/B on this file today, without
it vitest exits **1** with 27/27 assertions green and one
`[vitest-worker]: Timeout calling "onTaskUpdate"` unhandled error, with it exit 0.

**Named suites — `tests/issue-4484.test.ts` + `tests/issue-4485.test.ts`: 45
tests, all green, exit 0.** Getting there needed three corrections, none of them
caused by this diff, all verified by re-running with #4621 fully REVERTED at
`04c0d5d42`:

1. `#4484`'s `it.fails` pin for `'valueOf' in {}` had **healed** — the residual
   was fixed by #4479 slice 2 (Annex B `Object.prototype` accessors standalone),
   which is in this branch's base. Flipped to a positive pin.
2. `#4485`'s `pinResidualRow` for `setYear/year-to-number-err.js` had likewise
   healed. Flipped to a positive pin and retired from that issue's residual list.
   (Both files ask for exactly this — "the pin fails loudly then" — so a tripped
   residual pin is the mechanism working, not a defect.)
3. Both files then still exited **1** with every assertion green and one
   `[vitest-worker]: Timeout calling "onTaskUpdate"` unhandled error. That is the
   #4003 hazard both files' headers already describe; keeping each `it` short is
   necessary but not sufficient at this row count. Added the measured
   `afterEach` macrotask-yield hook from
   `es5-standalone-harness-selftests.test.ts` to both. Measured on this branch:
   without it exit 1 / 45 green / 1 error, with it exit 0 / 45 green / 0 errors.
   The same hook is in `tests/issue-4621.test.ts` for the same measured reason.

## Aggregate remeasurement (2026-08-25)

The earlier conclusion that `Math.random` already passed no longer held on the
authoritative aggregate standalone branch: the exact ES5 row emitted
`env::Math_random` and was rejected as a host-import leak. Standalone now emits
a module-local xorshift64 generator with no entropy capability; WASI retains
`random_get`, and the default GC target retains `env::Math_random`. Evidence:
the exact row is 1/1, `tests/issue-1322.test.ts` is 7/7, and typecheck, lint,
format, LOC/function, coercion, oracle, dead-export, and stack-balance gates
pass.

The same aggregate run tripped three intentionally stale residual pins, proving
that `S12.10_A5_T5`, `S8.12.6_A2_T2`, and `S7.8.5_A1.1_T2` now pass. They are
positive pins in `tests/issue-4621.test.ts`; the historical table below records
the earlier branch measurement rather than the current aggregate state.

## Residuals

| residual | rows | owner |
| --- | --- | --- |
| **Family A in full.** Not a `.source` bug: the `_T2` rows run ~65,500 runtime evals and the loop alone exceeds the 10 s budget by >30x (measured: >290 s with every `.source` read removed). Fixing `.source` on a provider-minted RegExp converts `fail` into `timeout`. | `language/literals/regexp/S7.8.5_A{1.1,1.4,2.1,2.2,2.4}_T2.js` (5), `annexB/built-ins/RegExp/RegExp-{leading,trailing}-escape-BMP.js` (2) | runtime-eval THROUGHPUT lane. A separate, smaller residual underneath it: an eval-minted RegExp reached through a computed source string is a provider handle whose `.source` reads `undefined` |
| `new RegExp(<dynamic string>)` is unsupported standalone ("Unsupported dynamic regular expression pattern") | `annexB/built-ins/RegExp/RegExp-control-escape-russian-letter.js` (1) | dynamic-RegExp lane — needs a runtime pattern compiler, not a lexer fix |
| **Family E, and its cause is not eval.** `delete <name>` inside a `with` whose target is a proven closed object literal answers `true` and deletes NOTHING. The plain `with (o) { del = delete q1 }` control reproduces it with no eval in the module at all, and the qualified `delete o.q1` works correctly (verified through `=== undefined`, `in` and `hasOwnProperty` — `typeof o.q1` static-folds and is NOT a valid observation channel here). | `language/statements/with/S12.10_A5_T{4,5}.js` (2) | with-scope / closed-struct-presence lane |
| **H's second row.** `throw obj` preserves identity for a plain object, an array, a constructor instance and an `Error`, but an object literal carrying a `valueOf` **or** `toString` override loses it at the externref boundary of a CALL or a THROW (array slots and object slots keep it). So `catch (e) { e.i = 10 }` writes to a copy. | `language/statements/try/S12.14_A18_T6.js` (1) | value-representation / to-primitive-carrier lane |
| `in` does not walk a REASSIGNED prototype (`Robin.prototype = __proto`), while the value read, `hasOwnProperty` and own-name `in` are all correct | `language/expressions/in/S8.12.6_A2_T2.js` (1) | prototype-chain `in` fold — the static fold should decline when the class's `prototype` is assigned anywhere in the module |
| The constructor carriers own only `length`/`name`/`prototype`, so `"MAX_VALUE" in Number` is false | `language/expressions/in/S11.8.7_A2.4_T1.js` (1) | the #4442 carrier generalisation — static VALUE properties on a ctor carrier |
| `f1 + 1 === f1.toString() + 1` — function source text | `language/expressions/addition/S11.6.1_A2.2_T3.js` (1) | **#4619-adjacent** (`Function.prototype.toString`); declined rather than implemented in parallel, per the coordination note |
| `typeof o.q1` static-folds to the declared type and ignores a completed `delete` | (no dedicated row; found while measuring family E) | typeof-fold lane — the fold must decline for a name the module ever deletes |
