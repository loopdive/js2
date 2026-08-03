---
id: 2929
title: "Interpreter direct eval + with + Proxy-MOP convergence"
status: in_progress
created: 2026-07-02
updated: 2026-08-03
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: current
parent: 1584
depends_on: [2928, 2925, 2864]
related: [1355, 2865]
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/direct-eval-environment.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/generators-native.ts
  - src/codegen/helpers/body-uses-arguments.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/statements/nested-declarations.ts
  - src/interp/eval-environment.ts
  - tests/issue-1102.test.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/generators-native.ts::isNativeGeneratorCandidate
  - src/codegen/generators-native.ts::isNativeGeneratorExpressionShape
  - src/codegen/helpers/body-uses-arguments.ts::bodyNeedsArgumentsObject
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
---

# #2929 — Interpreter direct eval + `with` + Proxy-MOP convergence

Slice **F** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-F, §7).
#1584 Phase 2. Adds standalone **direct-eval scope capture** to the interpreter,
and — deliberately — builds the shared substrate (`with`, Proxy MOP) so those
tracks converge on it instead of re-deriving it.

## Scope

### 1. Standalone direct-eval scope capture
Add `LdName` / `StName` opcodes that resolve identifiers against a **reified
environment-record chain** (§4.1). Reuse the `$EnvRecord`/name-map carrier
introduced in the JS-host reification slice **#2925** (which extends #2864's
`$Frame` with a name map) — do NOT define a second environment type. This makes
`function f(){ var x=1; eval("x=2"); return x }` return `2` **standalone**,
mirroring the JS-host behavior #2925 delivers.

### 2. `with` (shared substrate, roadmap §7)
`with (obj) { … }` prepends an **object environment record** to the lexical
environment chain and resolves names against the object's properties — the same
chain the interpreter walks for direct eval, with one link being an arbitrary
object. Implement `with` as an object-environment-record variant of the §1
chain. (`with` is currently in the IR "deferred-feature" bucket alongside eval;
this is where it exits that bucket.)

### 3. Dynamic meta-object protocol (Proxy trap surface, roadmap §7)
The interpreter's generic property opcodes —
`Get`/`Set`/`GetByValue`/`HasProperty`/`OwnKeys`/`Delete` — must implement the
full ordinary-object internal methods (prototype chain + descriptor semantics)
on `any`-typed receivers. Build these as **reusable `$Object`-level MOP
primitives** so #1355's Proxy handler dispatch plugs into the *same* surface.
**This issue does not implement Proxy traps or edit #1355's files** — it exposes
the MOP primitives #1355 consumes, and coordinates their signatures with the
#1355 owner (roadmap §7).

### 4. Generator / async opcodes
`SuspendGenerator`/`ResumeGenerator`/`YieldValue`, aligned with the #2864/#2865
`$Frame` suspend/resume encoding (the interpreter's frame IS the #2864 carrier).

## Coordination (must-not-diverge)

Per roadmap §7, the `$EnvRecord` type (with #2925/#2864) and the MOP-primitive
signatures (with #1355) are reviewed **jointly with those owners before
implementation**, so one carrier and one MOP surface serve direct-eval, `with`,
and Proxy.

## Acceptance criteria

- [x] `function f(){ var x=1; eval("x=2"); return x }()` returns `2`
      **standalone** (interpreter direct-eval capture).
- [ ] `with ({a:1}) { a }` evaluates to `1` via the object-environment-record
      chain (standalone).
- [ ] The MOP primitives are consumed by at least one #1355 Proxy trap in a
      joint integration test (coordinated, not implemented here).
- [ ] A generator run through the interpreter suspends/resumes correctly using
      the #2864 `$Frame` carrier.
- [ ] Direct-eval scope tests pass identically via JS-host (#2925) and the
      standalone interpreter (differential check).

## Notes

Depends on #2928 (VM core), #2925 (env-record carrier), #2864 (`$Frame`).
Converges with #1355 (Proxy) and `with`. Umbrella: #1584. Goal: `runtime-eval`.

## 2026-08-02 implementation handoff

Branch `codex/2929-direct-eval-capture` implements a resumable direct-eval
interpreter checkpoint:

- an AOT function whose lexical descendants can reach direct `eval` promotes
  eval-visible locals to the compiler's existing canonical mutable capture
  cells;
- direct eval passes current-activation state, lexical captures, outer captures,
  strictness, and mapped-parameter metadata through the standalone provider
  boundary
  `__runtime_direct_eval(source, globalObject, thisArg, activationState, activationSeedNames, activationSeedSlots, lexicalNames, lexicalSlots, outerNames, outerSlots, callerStrict, mappedParamNames)`;
- the provider creates a declarative `$EnvRecord` above the global record, and
  interpreter name lookup, assignment, and `typeof` dereference those live
  cells; and
- writes therefore flow both ways without a copy-back pass. The standalone
  probes cover an ordinary function, a nested function declaration, a function
  expression, an arrow, non-string passthrough, the refusal provider, and the
  real zero-import Acorn provider.

The MVP mutation gate is green: a caller cell initialized to `40` is changed by
dynamic direct eval to `42`, and the probe observes both the eval result and the
subsequent AOT read (`42 + 42 = 84`). Existing indirect-eval and `new Function`
provider routes remain green.

The follow-on declaration/strictness slice is also present on the same branch:

- `EvalDeclarationInstantiation` now separates top-level `var`/function names,
  top-level lexical names, and nested block functions;
- strict direct eval inherits caller strictness across the provider ABI, while a
  source-level `"use strict"` directive is detected inside the runtime AST;
- strict eval receives a private declarative var environment, and top-level
  `let`/`const` bindings receive a private TDZ environment;
- `InitName` initializes those predeclared lexical cells without weakening
  ordinary assignment's TDZ and strict-unresolvable checks; and
- nested block functions use real block lexical environments, so their closures
  retain the correct environment without leaking after the block exits.

Three further MVP slices are included:

- **Activation persistence.** Each AOT activation owns a persistent eval overlay
  with capacity for 64 eval-created names. Sloppy top-level eval `var` and
  eligible Annex B block-function bindings survive later direct-eval calls in
  the same activation, while strict eval and lexical declarations remain
  isolated. Current-activation names, lexical captures, and outer captures are
  represented separately, so a new current-function `var` cannot overwrite an
  outer capture.
- **Mapped arguments.** Sloppy simple parameters and `arguments[index]` share
  the same backing cells across direct eval. The dispatcher preserves the raw
  source-level argument count while widening to declared arity, and the local
  snapshot restores the exact boxed capture map. Parameter-to-arguments and
  arguments-to-parameter canaries return `202` and `303`, respectively.
- **Block, Annex B, and class MVP.** Nested blocks create lexical environment
  records with TDZ, closure capture, and cleanup on normal exit, `break`,
  `continue`, and exceptions. Sloppy block functions implement bounded B.3.3
  outer-binding behavior, including lexical-conflict and skipped-block cases.
  Classes support declarations and expressions, default/explicit constructors,
  and ordinary noncomputed instance/static methods. Class bodies are strict and
  calling a class without `new` throws `TypeError`. Inheritance, fields, private
  names, accessors, computed names, and `super` fail loudly.

Class construction and method calls are green while the class remains inside
the interpreter. Returning an interpreted class through the provider and then
constructing it in a separately compiled AOT module still loses constructor
arguments/prototype state. That is the deferred generic external-callable /
cross-module rec-group ABI seam, not an interpreter class-semantics success;
this checkpoint does not claim it.

The real Acorn provider remains a zero-import standalone artifact. Its runtime
canaries cover sloppy caller mutation, strict-source and strict-caller var
isolation, lexical isolation and TDZ, strict early errors, indirect strict var
isolation, declaration-plan/environment construction, activation persistence,
mapped arguments, block shadowing/TDZ/closure capture, abrupt-completion
cleanup, Annex B block functions, and the bounded class surface above. The
focused Node environment suite is 18/18.

### Test262 eval-code measurement

The full standalone runtime-eval lane was measured with:

```sh
TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 \
TEST262_PATH_FILTER=language/eval-code \
TEST262_REPORTER=dot \
pnpm run test:262
```

Result: **207 / 816 pass (25.4%)**, all 207 host-free.

| Scope | Pass | Total | Direct | Indirect |
| --- | ---: | ---: | ---: | ---: |
| Current standard | 130 | 347 | 97 / 286 | 33 / 61 |
| Annex B | 77 | 469 | 52 / 309 | 25 / 160 |
| Combined | 207 | 816 | 149 / 595 | 58 / 221 |

The 207-file passing surface is concentrated in these concrete families:

- direct and indirect non-string passthrough, `parse-failure-1..6`, and normal
  completion-value cases (`cptn-nrml-*`);
- strictness/isolation cases including direct `strict-caller-*`,
  `strictness-override`, both `block-decl-eval-source-is-strict-*` variants,
  indirect `always-non-strict` / `block-decl-strict`, and the passing strict
  `var-env-func-*`, `var-env-global-lex-*`, and `var-env-lower-lex-*` cases;
- the supported arrow/async arguments-declaration matrix where `arguments` is
  absent, a parameter, a `var`, or a function declaration (lexical-binding and
  several method/default-parameter shapes remain failures);
- direct global-environment/catch/eval/function cases, selected `this` and
  `super-call` cases, and direct/indirect import/export syntax checks; and
- 77 Annex B cases, primarily `*-block-scoping`, existing function/var
  no-initializer behavior, and the selected `*-skip-early-err-{block,for}`
  variants listed by the lane result.

Non-pass outcomes were 565 runtime failures, 16 compile errors, and 28 compile
timeouts. The leading runtime buckets were 349 assertion failures, 173 other
errors, 24 syntax errors, 14 illegal casts, 3 type errors, 1 negative-test
failure, and 1 null dereference; the 16 compile errors were reported as host
import leaks.

A maintained 56-test `var-env-*` / `lex-env-*` declaration cohort was measured
before and after this follow-on and remained **16 / 56** with no per-file status
changes. These Test262 inputs use literal eval sources and are currently handled
by the compiler's separate AOT `tryStaticEvalInline` path, so that cohort does
not exercise the runtime interpreter. The dynamic Acorn-provider canaries above
are the acceptance gate for this slice. A future interpreter-only Test262 score
needs an explicit maintained compile mode that prefers runtime eval; it must not
silently disable constant folding, because existing acceptance tests require
literal eval to remain provider-free.

The final post-merge full-lane A/B run (`20260802-075946`) remained **207 / 816** with the
exact same 207 passing files as the pre-slice baseline: zero pass-to-fail and
zero fail-to-pass transitions. Candidate non-pass outcomes were 569 runtime
failures, 16 compile errors, and 24 compile timeouts. The only four status
changes were Annex B files that moved from compile timeout to a known runtime
`ReferenceError`; they do not change the passing denominator. Current-standard
coverage remains 130/347 and Annex B remains 77/469.

### Remaining work, in recommended order

1. Complete dynamic mapped-arguments descriptor semantics: deleting or
   redefining an indexed property must sever the parameter alias exactly when
   required. The current MVP covers ordinary indexed reads/writes and direct
   parameter mutation, not every descriptor transition.
2. Extend lexical lowering to per-iteration loop environments, catch-parameter
   lexical bindings, and `switch`; extend classes with inheritance, fields,
   private names, accessors, computed names, and `super`.
3. Cover methods, async/generator functions, `new.target`, `super`, and strict-
   caller `this` behavior in the interpreter emitter/runtime. Freeze the
   external callable/constructor and rec-group ABI with the packaging owner
   before claiming classes returned across a module boundary.
4. Implement the object environment record for `with`, then coordinate the
   shared ordinary-object MOP surface with #1355 before adding Proxy traps.
5. Add generator suspend/resume opcodes on the shared #2864 frame carrier, then
   run the JS-host/standalone differential acceptance gate.

This branch is a resumable MVP slice, not closure of #2929. Only the first
acceptance checkbox is satisfied.

## 2026-08-03 verified handoff

The current checkpoint closes the runtime-routing and direct-capture MVP while
leaving the broader `with`/Proxy/generator scope open. In addition to the
previous caller-mutation gate, it now covers persistent sloppy-eval bindings,
strict/private declaration environments, mapped arguments, nested block and
loop lexical environments, bounded Annex-B block functions, classes, direct
eval caller-`this`, and the cross-module interpreted-callable boundary. The
deterministic linked-runtime probe now mirrors production by unwrapping
arguments and receivers before `applyRuntimeEvalCallable` and exposing returned
interpreted environments.

The authoritative local interpreter-tier measurement is:

| Scope / route | Pass | Total |
| --- | ---: | ---: |
| Standard direct eval | 108 | 286 |
| Standard indirect eval | 60 | 61 |
| Annex-B direct eval | 185 | 309 |
| Annex-B indirect eval | 120 | 160 |
| **Combined** | **473** | **816** |

The same worktree with the refusal provider passes 158/816. Comparing the two
JSONL result sets yields **315 interpreter-attributable fail→pass transitions**
and **zero pass→fail regressions**. The full arm has no timeouts or skips; its
44 compile errors are unchanged from the refusal arm. Run IDs are
`20260803-015311` (full) and `20260803-020039` (refusal), both with
`COMPILER_POOL_SIZE=2`, `TEST262_WORKERS=2`, and a 600-second per-test queue
budget. Generated benchmark reports are intentionally not part of the source
commit.

Focused verification is 128/128 plus typecheck. The final regression repair in
this checkpoint makes sloppy direct eval inherit the already-established
caller `this` (including global substitution for a bare sloppy AOT call), and
prevents Annex-B synthetic outer vars from crossing `for (let …)` lexical
bindings. The affected Test262 files moved 18/18 from fail to pass over the
immediately preceding 455-pass run, with no regressions.

### EvalDeclarationInstantiation collision slice

The next slice now implements the non-strict
`LexicalEnvironment`→`VariableEnvironment` preflight before creating any eval
binding. It checks the complete ordinary `var`/function name set atomically,
skips object environment records, applies Annex-B cancellation to eligible
block functions, and fails closed if the supplied environment chain is
malformed. The AOT capture boundary now classifies
function-body `let`/`const`/class bindings as lexical rather than as var
activation entries, so the production Acorn route sees the same intervening
record as the interpreter unit seam. Cancelled B.3.3 assignments are omitted
from emitted bytecode, preserving both the caller lexical cell and the Script's
empty-completion behavior; the assignment builtin also refuses to fall through
to an unrelated same-named lexical binding.

The literal direct-eval fast path normally remains provider-free, so
`tryStaticEvalInline` separately
reconstructs the caller-dependent collision rules. It recognizes lower lexical
bindings and parameter-initializer environments, including ordinary functions'
implicit `arguments` binding, while preserving the permitted arrow case with no
pre-existing `arguments` binding. Explicit strict eval declarations route to
the provider because the foreign-AST splice cannot supply their private
environment.

The maintained honest standalone cohort selected by
`declare-arguments|var-env-lower-lex` contains exactly 198 official Test262
files. Restricting the pre-slice full-interpreter run `20260803-015311` to those
same paths gives 52 pass / 102 fail / 44 compile errors. Candidate run
`20260803-042954`, measured after reconciling the branch with current main,
gives **154 pass / 0 fail / 44 compile errors**: exactly **102 fail→pass**,
52 pass→pass, 44 compile-error→compile-error, zero
pass→fail, and no missing rows. The full zero-import Acorn package canary and
the focused interpreter/environment/static-eval/Annex-B/provider tests also
pass; the directly affected unit suites are 49/49 and the real Acorn package gate
is 1/1.

The former sole runtime residual is now green:
`arrow-fn-body-cntns-arguments-func-decl-arrow-func-declare-arguments-assign-incl-def-param-arrow-arguments.js`.
Closure capture analysis recognizes a closure created directly
inside a parameter initializer and prefers its live parameter-environment
local over an eagerly registered same-named body function. Eval's
parameter-environment `arguments = "param"` cell therefore remains visible to
the default-parameter arrow while the later function-body
`function arguments(){}` binding remains the body binding.

The compile-error follow-on closes the remaining 44 files. Run
`20260803-044922` first moved the cohort to **182 / 198**: method values read
from direct-eval-reified object bindings now recover their concrete WasmGC
struct from `externref` before reading the closure field. This eliminated all
36 invalid-Wasm modules; 28 became passes and 8 exposed generator host imports
that the earlier validation error had masked, leaving 16 generator-family
compile errors and no runtime failures.

Run `20260803-045435` is the final measured gate: **198 / 198 (100%)**, with
zero runtime failures, compile errors, host-import leaks, timeouts, skips, or
missing rows. Generator admission now distinguishes a bare body binding named
`arguments` (`let arguments;` / `var arguments;`) from an executable use that
requires the implicit arguments object. The 12 synchronous generator
function-expression/method cases and 4 async-generator method cases therefore
use the existing native standalone generator paths; their default-parameter
direct eval still throws the required catchable `SyntaxError` at call time.

Across the fixed path set, the pre-slice `20260803-015311` baseline's 52 passes
remain passes, all 102 runtime failures and all 44 compile errors become passes,
and there are zero pass-to-fail transitions. Focused direct-eval coverage is
29/29 and the relevant native generator suites are 60/60 after excluding one
unrelated mixed async-generator warning assertion that reproduces unchanged on
the exact stacked baseline; typecheck passes. Generated Test262 reports remain
outside the source commit.

### Next-agent order

1. Finish Annex-B block-function initialization and update semantics. The
   largest residual clusters are missing function-valued outer updates,
   skipped-declaration initialization, and existing-global descriptor cases.
2. Close mapped-arguments descriptor severing and `new.target`/`super`/method
   context before attempting the full differential checkbox.
3. Continue the original issue scope with the object environment record for
   `with`, the jointly-owned #1355 MOP seam, and #2864 generator suspend/resume.

Do not reinterpret the 473/816 figure as the default CI baseline: it requires
`TEST262_FULL_RUNTIME_EVAL=1`. The default refusal tier remains intentionally
capability-free until the full provider is published as a reusable build
artifact.

## 2026-08-03 Annex-B eval binding lifecycle checkpoint

Branch `codex/2929-annexb-init-update` is a suspended, resumable follow-on to
the direct-eval collision slice. It does not close #2929.

The checkpoint fixes four lifecycle boundaries exposed by the Test262
`eval-code` Annex-B collision family:

- A `BlockStatement` directly under a Script `SourceFile` is now classified as
  a real block-nested Annex-B declaration site, rather than being mistaken for
  a function body's declaration list.
- Constant direct eval remains on the import-free AOT path for simple late-read
  block functions, but routes to the interpreter when B.3.3 initialization or
  update order depends on an eval `var`, a caller/global binding, an early
  reference, or a source-level `if`/`switch` declaration.
- Sloppy direct eval at Script global scope enters the provider through the
  global-environment route. This avoids an empty synthetic activation record
  hiding B.3.3 global object properties.
- B.3.3's synthetic outer assignment first updates an eval-created variable,
  then the exact pre-existing caller activation cell recorded by declaration
  instantiation. It never walks into an unrelated outer capture or lexical
  record.

The frozen focused gate is green:

- `pnpm run typecheck`
- 57/57 tests across `tests/issue-2929-annexb-eval-lifecycle.test.ts` and
  `tests/interp/eval-environment.test.ts`
- 2/2 selected import-free `block-nested` / `if-nested` fast-path canaries in
  `tests/issue-2923-eval-const-broaden.test.ts` (17 unrelated cases skipped)

The new coverage proves fresh and existing global descriptors, later
same-name block-function wins, exact caller activation updates, provider
routing for pre-declaration/collision cases, and preservation of the simple
zero-import `eval("{ function f() {} } ...")` fast path.

### Publication and remaining gate

PR #4013's merge-group Test262 gate rejected the preceding direct-eval
checkpoint. On the content-current merge candidate it measured 48,346/48,346
rows with 184 stable non-timeout regressions versus 105 improvements, a net
-79 fine-gate delta, a 217-pass standalone-floor breach, and five new null
dereferences in Annex-B existing-var-update files. CI, differential, and CLA
were green; the Test262 result is a real landing blocker and must not be
bypassed.

This follow-on targets the common B.3.3 lifecycle cause, but the user-requested
suspension happened before a fresh complete 101-file collision replay or full
816-file eval-code A/B measurement. The next agent should therefore:

1. Rebase or merge the current `origin/main`, build the full interpreter
   provider, and run the exact 101-file collision slice before attempting to
   land #4013 or this stacked PR. Require zero pass-to-fail transitions and no
   standalone-floor breach.
2. Re-run all five `existing-var-update` null-dereference files first. If any
   remain, trace materialization of the explicit eight-slot interpreted
   callable carrier; do not alter the shared closure/rec-group ABI merely to
   fit this path.
3. Finish same-name AOT/global block-function synchronization, especially the
   direct and indirect `existing-block-fn-update` cases, and preserve existing
   global property descriptors through block execution.
4. Isolate the cross-module `verifyProperty` open-object-to-closed-struct
   illegal cast at `__call_fn_method_4`; keep it separate from interpreter
   declaration semantics and from the deferred E6 packaging/rec-group ABI.
5. Only after the collision slice is clean, repeat the full interpreter-tier
   `language/eval-code/` measurement and update the 473/816 handoff table with
   an explicit provider tier and run IDs.

Generated Test262 reports and `benchmarks/results/runs/index.json` are not part
of this checkpoint.
