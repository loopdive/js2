---
id: 6491
title: "Linked lane: 36 negative early-error rows compile with no diagnostic (honest lane reports the SyntaxError)"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-17
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262-runner
goal: test262-conformance
depends_on: [3451]
related: [3451, 6486, 3506]
# (2026-09-17) The under-application fix lives where the defect is: the host
# bridge's free-function dispatch arm in src/runtime.ts. +29 lines, of which the
# executable change is 8; the rest records WHY widening is safe (never above the
# closure's declared arity) and names the residual `arguments.length` answer, so
# the next reader does not re-derive it from a 14-row test262 bucket.
# (2026-09-17, follow-up) Closing the `arguments.length` residual and the
# pad/value cast traps needs the argc-seeding wrapper family, the `__host_argc`
# channel and the two dispatcher admission gates. They belong in the dispatcher
# emitters they gate (closure-exports.ts) and beside `ensureArgcGlobal`
# (nested-declarations.ts); splitting them out would separate a gate from the
# arm it guards. Most of the growth is the reasoning for WHY an arm may decline.
# The two admission gates are per-dispatch-ARM decisions computed from the arm's
# own formal types, so they live inside the emitter loops that build those arms.
func-budget-allow:
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/context/create-context.ts::createCodegenContext
# (2026-09-17, round 2) +46 lines in `src/compiler/early-errors/node-checks.ts`,
# of which ~34 are comment. `node-checks.ts` IS the subsystem module the god-file
# gate wants — it is the per-node rule table the #1931 decomposition created, and
# a rule that fires on an Identifier/AwaitExpression has to be registered in that
# table's `on([...])` dispatch to run at all. Two of the three edits are ONE line
# each inside an existing rule (`"let"` added to STRICT_RESERVED_WORDS; the
# module-goal arm of the await-position condition); the third is the 12-line
# `isImportedBindingName` predicate, placed beside the two strict-binding rules
# that are its only callers because it encodes WHICH of an import's identifiers
# is the BindingIdentifier — a fact those two rules' parent-kind lists are
# otherwise silent about. Splitting the god-function is #3399's job.
# (2026-09-18, round 3) +17 lines in `src/index.ts` and +3 in `src/compiler.ts`
# for the `scriptGoal` compile option. Both are the declaration and the single
# read of ONE boolean, and neither can live anywhere else: `CompileOptions` is
# the public option type (src/index.ts IS where an option is declared), and the
# read sits on the line that builds `detectEarlyErrors`' opts next to the
# `moduleGoal` it must never be confused with. 15 of the 17 lines are the doc
# comment explaining why this flag is not `!moduleGoal` — the one fact that
# stops the next reader from "simplifying" it into a rule that rejects every
# product `export`.
loc-budget-allow:
  - src/index.ts
  - src/compiler.ts
  - src/runtime.ts
  - src/codegen/closure-exports.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/context/types.ts
  - src/compiler/early-errors/node-checks.ts
---

# #6491 — early errors not detected on the body-only unit

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

Parity bucket `expected SyntaxError but compiled with no diagnostic (early error
not detected)` = 36 rows: honest `pass` (diagnostic reported), linked `fail`.
The worker passes `enforceJsEarlyErrors: isNegative && negativePhase !== "resolution"`
to both branches, so either the early-error pass does not run on the
`compileMulti` graph the linked body is compiled through, or it runs on the
wrong file (the stub), or the check needs the harness prefix in the same unit
(e.g. duplicate-declaration / `let` redeclaration against a harness name).

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. Pull the 36 file names from the parity JSON artifact
   (`test262-linked-baseline-8eeaee8e…`, run 35116762391) and group by the
   early-error kind the honest lane reported.
2. For each group, compile the body-only unit through `compileHarnessLinkedBody`
   with `enforceJsEarlyErrors: true` in a vitest probe and check
   `result.errors`; find where `enforceJsEarlyErrors` is consumed in
   `compileMultiSource` (`src/compiler.ts` ~L1840–1960, `detectEarlyErrors`
   call) and whether it covers every user file of the graph.
3. Fix in the compiler/lane, add the rows' shapes as unit cases, re-measure on
   the next `linked_lane` dispatch (bucket → 0).

## Acceptance

- [x] No honest-lane change (measured: 50/50 rows still `pass`; a 1,297-row
      callback-heavy honest slice flips 0 rows).
- [ ] The 36 rows agree with honest — **15 of 50 fixed; the remaining 35 must
      NOT be "fixed"**: honest passes them only through a spurious warning (see
      below). Needs a lead decision, not more implementation.

## Implementation notes (2026-09-17, Opus lane)

### Setup

Worktree `/home/user/js2/.claude/worktrees/agent-af8bbc7b957057171`, branched at
`91e0fb35bd`. Bundles rebuilt from the bundle ENTRIES
(`scripts/compiler-bundle-entry.ts` / `runtime-bundle-entry.ts`) before every
runner measurement — a worktree without them makes every row a
`worker failed before ready` timeout. Lanes reproduced with the real runner
(`tests/test262-chunk-dynamic.test.ts`, `TEST262_PATH_FILTER` = the 50 rows).

### Finding 1 — 34 of the 36 (a)-rows are honest FALSE PASSES, not linked misses

The early-error pass DOES run on the linked graph: `enforceJsEarlyErrors` →
`runEarlyErrorsOnAllowJs` → `detectEarlyErrors` over every user source file, and
a synthetic `let x; let x;` body is rejected identically in both lanes.

What actually separates the lanes is the **diagnostic the honest unit carries
for an unrelated reason**. Compiling the honest whole-assembly for each of the
36 rows and printing `result.errors` (not just failures):

| honest diagnostics on the 36 rows                                        | rows |
| ------------------------------------------------------------------------ | ---- |
| ONLY `warning: IR path failed for $DONOTEVALUATE … [IR-FALLBACK]`         | 34   |
| that warning plus `warning: Cannot access 'arguments' before initialization` | 1 |
| `error: Duplicate identifier 'x'` (a real rejection)                      | 1    |

`$DONOTEVALUATE` is a HARNESS function. In the linked lane the harness lives in
the provider, so the body-only unit has no such warning and reports
`errors: []` — for all 36. The honest verdict then comes from
`scripts/test262-worker.mjs`'s #2912 **lenient warning arm**: on a negative
parse/early row, ANY diagnostic (warning included) whose type is consistent with
`SyntaxError` scores `pass`. So the honest lane never detected these early
errors at all; it passed them on an IR-fallback note about a harness function.

Making the linked lane "agree" would mean manufacturing that warning. It is not
done and should not be. The real defect is the lenient arm — the same
incidental-pass class #2898/#2920 already names — and tightening it changes
HONEST verdicts corpus-wide, so it needs the lead's sign-off plus a baseline
refresh, exactly as #2920 did. Filed as a finding, not a change, here.

### Finding 2 — `language/import/dup-bound-names.js`: a real rule nobody owned

Honest rejected it, linked did not. The honest rejection was itself an artifact:
the single-source path rewrites unresolvable imports into declarations, and
`checkDuplicateLexicalDeclarations` caught the rewritten pair; the multi-file
path resolves imports through the TS program and never rewrites.

Fix: `checkDuplicateImportedBindings` in
`src/compiler/early-errors/module-rules.ts` (§16.2.1.1 — ImportedBindings are
LexicallyDeclaredNames of a ModuleItemList), wired into `detectEarlyErrors`.
Import-vs-import only; the import-vs-top-level-lexical half needs the
module-goal scoping `checkDuplicateLexicalDeclarations` owns and is left alone.

### Finding 3 — (b) is not about `eval`: under-applied cross-module calls never ran

All 14 `eval-code/direct` rows are `assert.throws(SyntaxError, f)` where `f`
declares parameters and the harness calls it with NONE. Reduced to:

```js
// provider:  function valueOfCall(fn) { return "VAL:" + String(fn()); }
// consumer:  function g(a) { console.log("RAN"); return 1; }
//   single module: RAN | VAL:1        linked: VAL:undefined   (body never ran)
//            g(a = 9): VAL:9          linked: VAL:undefined
```

`__call_fn_N` matches only closures of declared arity N, so the host bridge's
free-function arm (`_wrapWasmClosureUnknownArity`, `src/runtime.ts`) — which
dispatched at the CALL SITE's argument count — selected `__call_fn_0`, matched
nothing and returned `undefined`. The body never ran: no default-parameter
initializer, no throw. This is the #2664 omission hazard, which the METHOD arm
right above it already handles via `__closure_arity`; the free-function arm
never got the same treatment. In one module the call is compiled in Wasm and
never reaches the bridge, which is why only a linked graph shows it.

Fix: widen the free-function dispatch to the closure's own declared arity when
the call is UNDER-applied (never above it, so the low-arity generator rule the
existing comment states is untouched), padding with real `undefined`.
Residual, documented at the site: this family has no argc-seeding wrapper (only
`__call_fn_method_argc_N` exists), so a widened call reports `arguments.length`
as the declared arity — a narrower wrong answer than not running the body, and
confined to calls that previously produced nothing.

Scope note: this is NOT a test262-only fix. Any provider→consumer callback that
under-applies was a silent no-op.

### Before / after (real runner, this worktree, 2026-09-17)

| lane                       | before | after |
| -------------------------- | ------ | ----- |
| linked, the 50 rows        | 0 pass / 50 fail | **15 pass / 35 fail** |
| honest, the 50 rows        | 50 pass | 50 pass (unchanged) |
| honest, 1,297-row callback slice (`Array.prototype.{forEach,map,reduce,sort,filter}`, `Promise.prototype.then`) | 913 pass / 334 fail / 46 CE / 4 CT | identical — **0 flips** |

The 15: the 14 `eval-code/direct` rows + `import/dup-bound-names.js`.
The 35 remaining are Finding 1 and are deliberately left failing in the linked
lane, where the verdict is the correct one.

### Guards

`tests/issue-6491-linked-under-applied-consumer-call.test.ts` (parity: linked vs
single-module, including two regression guards for the exactly-applied and
zero-parameter cases) and `tests/issue-6491-duplicate-imported-bindings.test.ts`
(accept/reject pairs). Re-run green: #1931, #2664 ×2, #2623 P-7, #3451 ×3,
#6474, #6492 ×2. `tests/issue-2623-p7b-observable-resolve.test.ts` fails
`Promise.try is not a function` — verified failing on the BASE runtime too
(this Node build), pre-existing and unrelated.

## Follow-up (2026-09-17, Opus lane) — the two merge-group parks on PR #5963

Run 35256162280 parked commit `376b9af9` with two findings. Both are the
`arguments.length` residual that commit documented, and both are now closed.

### 1. `test/harness/verifyProperty-arguments.js` (pass → fail) — CLOSED

`verifyProperty()` guards on `arguments.length`, and the widened call reported
the closure's DECLARED arity instead of the real count. Documenting that was
not enough: it is observable, so the count has to be right.

The method dispatcher already had an argc channel
(`__\0js2_call_fn_method_argc_<N>` seeds `__argc`, the arm clamps it to
formals, the wrapper clears it). The free-function family had none. Added:

- `__host_argc` — a **new** global, not `__argc`. `__argc` is written by
  in-Wasm callers (`maybeSetArgcForKnownCall`) and consumed only by callees
  that read `arguments`, so when a host callback re-enters the module it can
  hold a stale count from an unrelated call; a free dispatcher that consumed
  `__argc` would publish THAT number as `arguments.length`. One producer, one
  consumer, cleared on read ⇒ a module whose host never seeds it is bit-for-bit
  unchanged.
- `__\0js2_call_fn_argc_<N>` wrapper + ABI role `closureFreeArgcDispatcher`.
- `PROVIDER_COMPILER_ABI_VERSION` → **v2**. This is load-bearing and cost a
  full debug cycle: the provider cache key contains no compiler-source hash, so
  the first fixed build still failed this row — the run reused a **cached v1
  provider** that had no argc export, and the bridge silently took the
  fallback. Any change to the provider's export surface must bump it.

### 2. Trap ratchet `illegal_cast` 30 → 31 — MINE, and CLOSED

A/B by file copy on `src/runtime.ts`, linked lane, real runner:

| build | `sort/comparefn-resizable-buffer.js` |
| ----- | ------------------------------------ |
| origin/main | `fail` — *thrown* `The comparison function must be either a function or undefined: [object Object]` |
| +widening | `fail` — **`illegal cast` trap** |
| +widening, widening disabled again | back to the thrown message |

So the widening is the trigger: it makes a call that used to be a silent no-op
actually run, and execution reaches casts that were previously unreachable.
Two admission rules now keep a dispatch arm from casting what it cannot hold —
an arm that cannot represent a value simply **does not match**, which is the
same fall-through an unmatched arm already takes (i.e. the pre-widening
outcome), never a trap:

- **pad safety** (both dispatchers): a padded position needs a formal that can
  hold the host's `undefined` — `externref`, a nullable ref, or an unconverted
  param. A non-nullable ref formal blocks the widened match.
- **value safety** (method dispatcher): `ref.test` the REAL argument against a
  non-nullable ref formal before the arm is selected. `ref.test` is exactly the
  predicate `ref.cast` succeeds under, so this can never decline a call that
  used to work — it only converts a trap into a decline. The test mirrors the
  conversion exactly (same `needsExternToAnyForClosureParam` condition, same
  unwrap, vec-materializer route excluded); mirroring it loosely declined arms
  the cast would have accepted.

The row still fails (now `ctors is not defined` — a separate linked-lane
harness gap, and it failed on main too), but it no longer traps.

### Measurements (real runner, this worktree, 2026-09-17)

| lane | origin/main | with the full change |
| ---- | ----------- | -------------------- |
| linked, the 50 #6491 rows | 0 pass / 50 fail | **15 pass / 35 fail** (unchanged from the first commit) |
| linked, `verifyProperty-arguments.js` | pass | **pass** (was `fail` on `376b9af9`) |
| linked, `sort/comparefn-resizable-buffer.js` | fail, thrown | fail, thrown — **no trap** |
| honest, `Array.prototype.{forEach,map,filter,reduce,sort}` + `Promise.prototype.then` (1,297 rows, run in two halves) | 723 + 574 rows | **0 flips** |

`equivalence-gate`: 22 failing / 1,720 passing / 22 known — no new regressions.
Guards re-run green: #1931, #2664 ×2, #2623 P-7, #3451 ×3, #6474, #6491 ×2,
#6492 ×3.

## Round 2 (2026-09-17, Opus lane) — real early errors

Branch `issue-6491-r2`, based on `f25fd4bcda`. Round 1 established that the 36
`early error not detected` rows are honest-lane FALSE PASSES: the compiler
detects none of them and the honest verdict rides on an IR-fallback WARNING
about `$DONOTEVALUATE`. This round makes the compiler actually detect them, so
both lanes pass for the right reason. The worker's lenient arm is untouched.

### Where the misses came from

The early-error pass was not missing a plumbing hook — `enforceJsEarlyErrors`
and `moduleGoal` both reach `detectEarlyErrors` correctly. It was missing
RULES, and one predicate gap accounted for a third of them.

| # | rule (ECMA-262) | mechanism that hid it | rows |
| - | --- | --- | ---: |
| 1 | §11.2.2 module code is strict | `isStrictMode`'s SourceFile terminal deliberately refuses to infer module-ness from the syntactic indicator (the compiler ADDS `export {}` for TS, so a sloppy script would read as strict). That reasoning is about the INFERRED indicator; the EXPLICIT `moduleGoal` the runner passes for `flags: [module]` is a fact. A `WeakSet` of module-goal files, registered in `createEarlyErrorContext` before any rule runs, keeps `isStrictMode` a pure function of the node (which the #4431 memo depends on). | 5 |
| 2 | §16.2.2 ImportedBinding is a BindingIdentifier | The two strict-binding rules enumerate their parent kinds, and no import kind was on either list. `isImportedBindingName` adds ImportSpecifier/ImportClause/NamespaceImport — and deliberately NOT `ImportSpecifier.propertyName`, which is the other module's export name. | (of the 5) |
| 3 | §13.1.1 `let` is strict-reserved | `let` was the only member missing from `STRICT_RESERVED_WORDS`. Safe by construction: a `let` DECLARATION parses as a keyword, never an Identifier node. | 4 |
| 4 | §11.2.2 ContainsUseStrict of a FunctionBody | `isStrictMode` listed FunctionDeclaration/Expression/Arrow/Method but **not the two accessor kinds**, so a `"use strict"` prologue inside a getter/setter was invisible and every strict rule in an accessor body was unreachable. | 2 |
| 5 | §15.8 `await` in a non-async function | The rule existed but was gated on `isInsideNestedFunction` (depth ≥ 2) to tolerate a synthetic `export function test() { … }` wrapper. The corpus rows are ONE function deep. Under an explicit module goal that wrapper is not in play, so the goal selects the accurate predicate; top-level `await` with no enclosing function stays legal. | 4 |
| 6 | §13.15.1 AssignmentTargetType | `validateAssignmentTarget`'s tail is deliberately permissive, so destructuring ELEMENTS were never validated. Added the one kind that needs no judgement: a MetaProperty (`import.meta`, `new.target`) is not assignable in any goal or dialect. | 4 |
| 7 | §16.2.1.1 LexicallyDeclaredNames ∩ VarDeclaredNames | `checkDuplicateLexicalDeclarations` tracked only the LEXICAL side — plain `var` names were never collected at all. Added `collectVarDeclaredNames` (recurses through blocks/if/loops/try/switch, stops at functions and classes), consulted only where a top-level function IS lexical, so the Script rule is untouched. | 2 |

### Before / after — real runner, the 36 rows, both lanes

Artifacts: `benchmarks/results/test262-{linked,honest}-{lb,nb,la,na}-results-*.jsonl`
(`lb`/`nb` = base, `la`/`na` = this branch), fresh harness cache per run,
`scripts/compiler-bundle.mjs` rebuilt on each side of the A/B.

| lane | before | after |
| --- | ---: | ---: |
| linked, the 36 rows | 1 pass / 35 fail | **21 pass / 15 fail** |
| honest, the 36 rows | 36 pass | **36 pass** (unchanged) |

The honest column is the point: those rows were passing on a warning and now
pass on a diagnostic. Evidence — the honest whole-assembly's `result.errors`
after the change (`success=false`, no IR-fallback warning involved):

```
module-code/early-strict-mode.js          error: 'public' is a reserved word in strict mode …
statements/class/class-name-ident-let.js  error: 'let' is a reserved word in strict mode …
import.meta/…/invalid-assignment-target-array-destructuring-expr.js
                                          error: Invalid destructuring assignment target 'import.meta'
module-code/top-level-await/…-fn-declaration-body.js
                                          error: 'await' expressions are only allowed in async functions
module-code/parse-err-hoist-lex-fun.js    error: Duplicate identifier 'f'
```

### No false positives

- **Honest slice**, the directories these rules touch
  (`language/{module-code,expressions/import.meta,expressions/object,statements/class,statements/using,expressions/generators,expressions/async-generator}/`),
  deterministic quarter-chunk so both sides score the SAME subset — **924 rows,
  749 pass → 749 pass, 0 flips in either direction.** (A quarter rather than all
  7,309: an honest run of the full slice is ~60 min a side.)
- **`node scripts/equivalence-gate.mjs`** (what CI runs): 22 failing / 1,720
  passing / 22 known — **no new regressions**, identical to round 1's numbers.
- `tests/issue-4417-early-error-false-positives.test.ts`, `issue-1931`,
  `issue-3419`, `issue-2929` — 71 tests, all pass.
- `tests/issue-3632-eval-early-errors.test.ts` has 2 failures; **verified
  pre-existing** by A/B (same 2 fail with these changes reverted) — a runtime
  value and a standalone import error, unrelated to early errors.

### The 15 rows NOT fixed, with mechanism

| rows | rule | why not |
| ---: | --- | --- |
| 3 | `export` / `import` / `import.meta` in a **Script** (`global-code/{export,import}.js`, `import.meta/syntax/goal-script.js`) | Needs an explicit SCRIPT-goal signal. `moduleGoal === false` is ambiguous — it is also what every product `.ts` compile passes, and those legitimately contain `export`. Flagging on it would reject ordinary code. A separate `scriptGoal` option plumbed from the runner would fix all three. |
| 2 | import-attributes `json-{invalid,named-bindings}.js` | `negative.phase: resolution`, and the worker passes `enforceJsEarlyErrors: isNegative && negativePhase !== "resolution"` — the early-error pass is not asked to run at all. These need JSON-module resolution semantics, not a syntax rule. |
| 3 | class static block: `await` as a binding / reference, `arguments` reference (`static-init-{await-binding-invalid,await-reference,invalid-arguments}.js`) | §15.7.1 makes `await` and `arguments` illegal in a ClassStaticBlock. `isInsideClassStaticBlock` already exists and the AwaitExpression rule uses it; what is missing is the IDENTIFIER-shaped cases (`function await() {}`, `(x = await) => 0`, a bare `arguments` reference). Contained follow-up. |
| 2 | `yield` as a generator/async-generator FunctionExpression's own name | §15.5.1: the BindingIdentifier of a GeneratorExpression is in the generator's own scope, where `yield` is reserved. Needs a rule keyed on `FunctionExpression.asteriskToken` + `name.text`. Contained follow-up. |
| 2 | `module-code/early-export-{global,unresolvable}.js` | §16.2.3.1: every ExportedBinding must be declared in the module. Needs a module-goal pass collecting declared top-level names (var/let/const/function/class/import) and checking local `export { x }` clauses, skipping re-exports (`export { x } from …`), where the name is the other module's. |
| 1 | `module-code/export-expname-string-binding.js` | `export { "foo" as "bar" }` — a string ModuleExportName is only legal as the LOCAL name in a re-export. |
| 1 | `statements/let/syntax/identifier-let-allowed-as-lefthandside-expression-strict.js` | `for (let in o)` in strict code: `let` as an IdentifierReference in a for-in LHS, not a BindingIdentifier, so rule 3 above does not reach it. |
| 1 | `statements/using/redeclaration-error-from-within-strict-mode-function-using.js` | `{ using f = null; var f; }` — `using` declarations are not modelled as lexical names by the duplicate rules. |

Acceptance stays open: 21 of the 36 agree. The rows above are ordinary
follow-up work except the Script-goal three, which need a signal the runner does
not currently send.

## Round 3 (2026-09-18, Opus lane) — the Script goal, and the last contained rules

Branch `issue-6491-r3` (round 2 + `origin/main`). Round 2 left 15 rows; 13 of
them fall here. The other 2 are established below as honest-lane accidents and
are deliberately NOT "fixed".

### 1. `scriptGoal` — a new compile option, because the negation is unsafe

Round 2 could not implement the three Script-goal rules (`export`, `import`,
`import.meta` in a Script) because `moduleGoal === false` is also the state of
every product compile, and product `.ts` files legitimately export. So the goal
is now stated positively: `CompileOptions.scriptGoal`, set ONLY by a caller that
knows the goal.

The signal itself needed care. `isScriptGoal` (new, in
`scripts/test262-module-goal.mjs`) is **not** `!isModuleGoal(...)`:
`isModuleGoal` falls back to SYNTAX when the metadata is silent, so for
`global-code/export.js` — a Script test whose body is `export default null;`
*because that is illegal in a Script* — the fallback answers "module" and its
negation answers "not a Script", backwards for the very row the rule exists to
catch. `isScriptGoal` reads metadata only: no `flags: [module]`, not under a
module-only path, not `raw`.

Plumbing, both lanes, all six compile branches: `tests/test262-shared.ts` →
`scripts/compiler-pool.ts` → `scripts/test262-worker.mjs` → `src/compiler.ts` →
`detectEarlyErrors`. **The pool was the trap**: it forwards an explicit
ALLOW-LIST rather than spreading its options, so the flag was silently dropped
and the rule fired in a unit probe while doing nothing in the runner. Verified
no product path sets it (`grep` over `src/`, `scripts/`, `tests/`: the only
setters are the runner files above).

Positive controls, real runner, linked lane: `import.meta/syntax/goal-module.js`
and `goal-module-nested-function.js` — **both still pass**.

### 2. The contained rules

| rule | rows | note |
| --- | ---: | --- |
| §15.7.1 `await`/`arguments` in a class static block — the IDENTIFIER-shaped cases | 3 | The walk descends through ARROW functions (`Contains` is transparent for them) and stops at ordinary functions. A function DECLARATION's name is still inspected (it is declared in the block); a function EXPRESSION's name and parameters are not — see the correction below. |
| §15.5.1 a generator/async FunctionExpression may not be named `yield`/`await` | 2 | Expression form only: a DECLARATION binds its name in the enclosing scope, where the reservation does not apply. |
| §16.2.3.1 exported bindings must be declared | 2 | Local `export { … }` clauses only; a re-export names the other module's bindings. Collector covers var/let/const/function/class/interface/type/enum/namespace and every import form. |
| §16.2.3.1 a string ModuleExportName needs a `from` | 1 | |
| §14.7.5.1 `for (let in o)` in strict code | 1 | TypeScript parses this one shape as a VariableDeclarationList with ZERO declarations, which nothing else produces — that emptiness IS the discriminator. |
| §14.3.1 `using` is a lexical declaration | 1 | Every flag test asked only about Let/Const, so a `using` binding was invisible as a lexical name AND miscounted as a VAR by the negated form. `NodeFlags.AwaitUsing` is `Using \| Const`, so the `Using` bit covers both spellings — and is why the Const bit alone must never be read as "this is a const". |

**One over-fire, caught by the honest slice and fixed.** The first cut of the
static-block rule inspected a function EXPRESSION's own name, which broke
`expressions/generators/static-init-await-binding.js` — whose entire point is
that `static { (function * await (await) {}); }` is LEGAL, because a function
expression's BindingIdentifier and parameters belong to the function, not to the
block. The slice reported it as a single pass→fail row; the rule now steps past
expressions entirely. `tests/issue-6491-r3-…` carries it as a named guard.

### 3. import-attributes (2 rows) — ACCIDENTAL, recorded, not manufactured

Established by printing the honest compile result for both rows:

```
import/import-attributes/json-invalid.js         success=true
   warning: IR path failed for $DONOTEVALUATE … [IR-FALLBACK]
import/import-attributes/json-named-bindings.js  success=true
   warning: IR path failed for $DONOTEVALUATE … [IR-FALLBACK]
```

Plus a compiler notice on stderr: *"Import attributes on `…_FIXTURE.json` are
accepted but not yet acted on (#1288); the import is processed as if no
attributes were present."* So there is **no resolution error to mirror** — the
honest lane passes these on the same `$DONOTEVALUATE` lenient-arm accident as
the rest of the bucket, and the linked lane's `fail` is the honest verdict. Left
failing deliberately; closing them needs JSON-module resolution (#1288), not a
syntax rule.

### Before / after — real runner, the 36 rows, both lanes

| lane | round-2 base | round 2 | **round 3** |
| --- | ---: | ---: | ---: |
| linked | 1 pass / 35 fail | 21 / 15 | **34 pass / 2 fail** |
| honest | 36 pass | 36 pass | **36 pass** (unchanged) |

Per-row: all 36 agree except `import/import-attributes/json-invalid.js` and
`json-named-bindings.js`, both of which are §3 above.

### No false positives

- **Honest slice** over the seven directories these rules touch, deterministic
  quarter-chunk, **full chunk this time — 1,792 rows: 1,404 pass → 1,404 pass,
  0 flips in either direction.**
  *Correction to round 2's record:* that section reported "924 rows"; the chunk
  is 1,792 and the two runs happened to share 924 scored rows because one was
  truncated. The 0-flip result stood for the rows compared, but the count was
  not the chunk. Round 3's numbers are from two complete runs.
- **`node scripts/equivalence-gate.mjs`**: 22 failing / 1,720 passing / 22 known
  — no new regressions.
- `issue-6491-r2`, `issue-4417-early-error-false-positives`, `#1931`, `#3419`:
  56 pass. `issue-3489-test262-module-goal` fails on an uninitialized
  `test262-fyi/data` submodule — environmental, unrelated.

### Acceptance

34 of 36 agree; 48 of the 50 bucket rows overall. The 2 remaining are the
import-attributes pair and are not an early-error problem, so `status` stays
`in-progress` pending #1288 rather than being closed on a manufactured pass.
