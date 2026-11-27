---
id: 7607
title: "Prepared IR path: the script `var` lists the module initializer still refuses (for-in head, catch re-declaration, `with` body)"
status: ready
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7372]
related: [7354, 7372, 7608, 7609]
---

# #7607 — the script `var` lists `<module-init>` still refuses

## Order of #7607, #7608 and #7609 (by rows that would pass)

Measured 2026-11-27 on `origin/main`, ES5 test262, strict Prepared entry, standalone. "Pass alone" is what the
change yields with nothing else landing; it is what orders the work.

| order | work | first-diagnostic rows | pass alone | why |
| ---: | --- | ---: | ---: | --- |
| 1 | #7609 A1: the global object as an identity value (script `this`) | 198 | ≈ 40 | 5 of 21 sampled rows need identity only |
| 2 | #7609 A2: unbound `this` of a sloppy function, direct-call receiver | (same rows) | ≈ +30 | 4 of 21 stop at exactly this |
| 3 | #7609 B: `this.name` on the script's own bindings | (same rows) | ≈ +15 | 2 of 21 |
| 4 | #7607 S1: catch re-declaration, accessor-body fix | 3 of 404 | 2–3 | 2 of 2 sampled pass |
| 5 | #7607 S2 + S3: for-in head and the Prepared for-in runtime | 351 of 404 | ≤ 10 | 184 rows also need `Object`'s statics; 5 of 10 sampled stop at "for-in runtime is unavailable" |
| 6 | #7608: `globalThis` (one arm on top of #7609 A1) | 289 | 0 | 13 of 13 sampled stop at `eval` / `Function` / `Object` next |

The three share one mechanism: **the realm has no global object**. #7609 adds it; #7608 is one identifier arm on
it; this issue needs it only for programs that observe a `var` as a property (they refuse today and keep refusing
until #7609 B).

Numbers above are upper bounds from a 60-compile sample (the machine allowed no more), not a full run.

## Problem

`ir/from-ast: module-init unit contains a nested var declaration` is the first diagnostic of **404** ES5 rows
(merge-queue run of 2026-11-27 19:14, 9029 rows: pass 2005, fail 759, compile_error 6253).

The refusal is `moduleInitContainsNestedVar` (`src/shared/var-declaration-lists.ts`), called from the module-init
arm of `lowerFunctionAstToIr` (`src/ir/from-ast.ts`). It fires for a `var` list outside
`FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration` that `isModuleInitVarList` does not
model. `isModuleInitVarList` models a list whose owner is a `VariableStatement` or a `for (;;)` initializer and
whose ancestors are all in `SCRIPT_STATEMENT_CONTAINERS`, minus a catch clause whose parameter it re-declares.
#7372 slice 1 left exactly these out by name.

Classification: a static scan of the 9,174-file ES5 list that calls the same predicate on the same assembled source
(`assembleOriginalHarness` + dead-binding elision). It predicts 410 rows (405 positive); the run measured 404. Three
raw compiles confirmed the diagnostic (3 of 3).

| sub-class (shape) | rows | refused by | next stop after an exact hand rewrite (`var` hoisted to the script top, the list replaced by an assignment at its site) |
| --- | ---: | --- | --- |
| `for (var k in o)` head | 351 | the owner test: only `VariableStatement` and `ForStatement.initializer` are owners | 10 sampled: 5 `dynamic for-in runtime is unavailable`, 3 `identifier "Object" is not in scope`, 1 `unknown class "Array"`, 1 bare `null`. **0 pass.** |
| `var` in a `with` body (5 also have a for-in head) | 60 | `WithStatement` is not a script statement container | 4 sampled: 1 `with target/body outside the closed-object IR slice`, 2 `globalThis`, 1 script `this`. **0 pass.** 59 of 60 have a non-literal `with` target; 53 of 60 also read script `this`. |
| `catch (e) { var e = … }` | 2 | `catchParameterIsRedeclared` | 2 sampled: **2 pass.** |
| `for (var x of …)` head | 1 | the owner test | 1 sampled: array literal vec. 0 pass. |
| `var` in an object-literal accessor body | 1 | the guard's own function-kind list omits accessors: this is a function's `var`, not a script `var` | not compiled (budget). The fix is exact: it is no script `var`. |

For-in rows by what else they name (static): `Object` only 184, no built-in 19 (3 negative, several enumerate
`this`), the rest mixes of `String` / `Boolean` / `JSON` / `Date` / `RegExp`. So the for-in rows pass in number only
once `Object`'s statics are on the path; the for-in work here is necessary, not sufficient.

## Implementation Plan

Binding: CLAUDE.md "IR path: code quality comes first". `src/ir/from-ast.ts` must not grow in any slice.

### Semantics (ES5 §10.5, §12.2, §12.6.4, §12.10, §12.14; Annex B.3.5)

| case | handling |
| --- | --- |
| hoisted to the script scope, `undefined` before the initializer runs | reused: the module-init prologue seeds `undefined` (#7372 slice 1) |
| visible to functions declared anywhere in the script | reused: the `__mod_<name>` home |
| a property of the global object | not modelled. A program that observes it (`this.k`, `globalThis.k`, `"k" in this`, `for (x in this)`, a descriptor read of it, `delete k`) refuses or aborts at that site today (H2 invariant, `src/ir/module-binding-script-var.ts`). #7609 B makes the static `this.k` read the home. |
| `for (var i = 0; …)` head | already modelled (lever L) |
| `for (var k in o)` head | S2: a script `var`; each visit writes the key into its home before the body |
| `try {} catch (e) { var e = 1 }` | S1: `e` is declared as a script `var` (stays `undefined`); the initializer writes the catch parameter |
| `var` in a `with` body | S1: declared as a script `var`; the initializer is an assignment resolved through the `with` scope. Only a closed object-literal target is admitted (the existing `with` slice); any other target keeps its own refusal. |
| the same name declared twice | #7372 slice 1b (one global per name); the new shapes map to the canonical declaration the same way |
| a `var` named like a function declaration | one binding; the declaration does not reset it; the initializer writes it. Inherits the existing rule for modelled lists; pin tests added. |
| a `var` named like a harness global | the same script: the "declared twice" case |
| a `var` named like a standard global (`var Array`, `for (var Object in o)`) | refuses as today (`src/ir/builtin-global-binding.ts`) |

### Slice S1 — one rule for script `var` lists (≈ 150 changed source lines)

- **Module:** `src/shared/var-declaration-lists.ts`.
- **Change:** one classifier of a `var` list outside every function-like: its names are script `var`s, and its
  initializer writes either the name's home (`slot`) or the enclosing scope (`scope`: a catch parameter it
  re-declares, a `with` body). `isModuleInitVarList` becomes "classified, and `slot`".
- **Duplicate removed:** `moduleInitContainsNestedVar` and its private function-kind list (the accessor bug). The
  guard in `from-ast.ts` asks the classifier (`ts.isFunctionLike`, as `moduleInitVarLists` already does), so
  from-ast shrinks.
- **Lowering:** a `scope` list's initializer lowers as the identifier assignment it is, through the existing
  assignment path (catch-parameter local, `withField`). No new arm.
- **H2:** a name with a `scope` list counts as rewritten in `preparedBindingRewritten`, so no typed home is
  certified over a write the checker cannot see.
- **Rows:** 2 pass (catch), 1 unblocked (accessor).

### Slice S2 — for-in / for-of `var` head as a script `var` (≈ 400)

- **Modules:** the classifier (the head list is an owner), `src/ir/select.ts` (`isPhase1ForInStatement`: the
  `forin-head-module-var` refusal of #7288 goes for a classified head), and a new `src/ir/for-in-lowering.ts` that
  takes `lowerForInStatement` out of `from-ast.ts` with a host object, as `annexb-block-function-lowering.ts` did.
- **Rule:** the head name's home is the dynamic one (no initializer, so no typed home is certified). Each visit
  stores the key into the home, then runs the body. Body writes and captures are the home's ordinary writes and
  reads, so the `forin-head-value-written` / `-captured` refusals do not apply to a script head.
- **Refused:** a head with an initializer (Annex B.3.6), a pattern head, a head inside `with` or re-declaring a
  catch parameter in for-of (an early error).

### Slice S3 — the Prepared for-in runtime (≈ 600; its own PR)

- **Problem:** `cx.resolver.dynamicForInPlan` is absent on the Prepared path, so every for-in refuses.
- **Change:** the Prepared resolver supplies the plan over realm object operations, keeping the existing four-symbol
  contract (keys snapshot, length, key at index, per-visit liveness).
- **Rules (§12.6.4):** `null` / `undefined` receiver runs no visit; own enumerable string keys, then the prototype
  chain's, a shadowed name once; integer keys ascending, then creation order; a key deleted before its visit is
  skipped.
- **Aborts at run time:** a primitive receiver (needs a wrapper), the global object (#7609), any object kind the
  realm's key enumeration does not cover.
- **Import edges:** IR→runtime import edges stay at 10; the plan reaches the runtime through the manifest's
  intrinsic declarations only.

### Acceptance

Correctness:

- every program in the tests agrees with node; each refusal is by name; no trap where JS throws catchably; valid
  Wasm; nothing thrown out of `compile()`;
- ordinary-pipeline output byte-identical (the classifier answers the old question unchanged for the shapes the
  ordinary pipeline models; S2 changes selection only where the subject is a Prepared module initializer);
- tests are source programs run against node. No census rows, receipts, hash / count / text pins, forged-plan
  tests (#7380).

Code quality:

- one classifier; no second walk over `var` lists anywhere in `src/ir` or `src/shared`;
- `from-ast.ts` shrinks in S1 and S2; no `loc-budget-allow` / `func-budget-allow` grant;
- no parameter or branch for a shape no test exercises.

## Out of scope

- `with` over a non-literal target (the object environment record).
- `Object`'s statics and the other standard globals the for-in rows name.
- A `var` as a property of the global object (#7609 B and its later slice C).
- for-of over anything the path does not already iterate.
