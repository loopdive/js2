---
id: 2929
title: "Interpreter direct eval + with + Proxy-MOP convergence"
status: in-progress
created: 2026-07-02
updated: 2026-08-11
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

During PR #4077's 2026-08-04 main sync, its proposed 16-line classifier was
found already present on `main` with the required `ctx.standalone` boundary.
The stale unqualified duplicate made host literal indirect Annex-B eval import
`__extern_eval`, so it was removed. No unique interpreter source delta remains
in #4077; the corrected lifecycle checkpoint is already on `main`.

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

### Merge-group repair checkpoint (2026-08-03)

The suspended collision handoff above has now been executed against merge-group
predecessor `ff5041e3` and repaired on PR #4013. The exact 38 locally
reproducible predecessor-pass/candidate-fail Test262 paths are 38/38 passing.
Across the complete 184-path stable non-timeout failure artifact, the repaired
branch is 145 pass / 39 fail; all 39 remaining failures reproduce on the exact
predecessor, leaving zero predecessor-pass/current-nonpass transitions.

The repair keeps provider-only routing in standalone mode while restoring the
established host literal compile-away boundary. It also closes the merge-group
gaps in direct-eval activation shadowing, Annex-B existing-var updates, native
async exception rejection, host callback argument-count isolation, and
recursive tagged-template capture forwarding. The focused unit matrix is
65/65 and typecheck passes. Generated Test262 reports and benchmark indexes
remain excluded from the checkpoint.

### Standalone merge-group follow-up (2026-08-03)

The next merge-group candidate exposed a separate standalone boundary defect.
Its 25,075 passes missed the 26,996 high-water floor by 1,921. A line-safe
predecessor/candidate join split the pass losses into four concrete cohorts:

- 1,877 illegal casts through `__call_fn_method_4` and 65 through
  `__call_fn_method_2`, both reached from the runtime-eval AOT-callable adapter;
- 100 deliberate refusal-provider `TypeError`s after semantically unsafe
  literal-eval splices were declined (55 Annex B, 10 other primary strict-eval
  cases, and 35 inherited-strict reruns); and
- 29 in-process fixture-graph modules whose harness never attached the cached
  `js2wasm:runtime-eval` provider namespace.

The callable repair preserves the source-level argument count while turning
omitted nullable reference formals into typed nulls before dispatch. It also
makes reference-valued parameters representation-neutral for top-level script
functions published through runtime eval, so a supplied object keeps its
identity and properties instead of being cast to a nominal, unrelated WasmGC
struct. Numeric/native scalar specialization and modules without the runtime-
eval boundary remain unchanged.

The Test262 fixture path now uses the same shared cached-provider selection as
the fork worker and instantiates a fresh provider per fixture. A representative
previously unlinkable module is 1/1 passing, a five-fixture sample has no
missing-provider failures, the 24-file callable sample has zero illegal casts,
the exact host regression replay remains 38/38, the focused callable/provider
unit matrix is 28/28, and typecheck passes. The 100 refusal transfers remain
intentional and are not hidden by weakening the semantic bails. Recovering the
1,942 cast rows plus 29 fixture links projects 27,046 passes on the same merge-
group population, 50 above its floor; the authoritative confirmation remains
the next merge-group run.

### Final #4013 collision checkpoint (2026-08-03)

The authoritative replay replaces that projection. Merge-group run
`30800239895` had 27,041 predecessor passes, 26,953 candidate passes, and a
26,996 floor. Its exact 101 predecessor-pass/candidate-fail paths comprised 65
primary records and 36 inherited-strict reruns. With the full provider selected
through the real fork worker, the repaired branch now records **101 / 101
passes**, with zero runtime failures, compile errors, or skips.

The final repair has four bounded parts:

- runtime-eval reference parameters widen only structurally typed object/
  interface parameters; native strings, vectors, promises, closures, and class
  instances keep their existing representations;
- capturing sibling declarations are pre-registered before any sibling body is
  compiled, and only explicit lifted captures are forwarded, so returned and
  recursively referenced closures materialize the established callable carrier
  without a null dereference;
- full-provider CI uses one canary-verified uploaded cache artifact for every
  standalone shard and fails loud when that artifact is absent, instead of
  silently selecting the refusal tier in an authoritative comparison; and
- append-only signed-shift opcodes close the two line-terminator direct-eval
  rows that remained after the first 99/101 replay.

The tagged-template TCO reproducer now reaches the same ordinary stack overflow
as the merge-group predecessor rather than trapping on a null dereference. The
focused Node/standalone/provider matrix is 81/81, the exact collision replay is
101/101, the required full-provider cache canaries pass, and typecheck passes.
No callable type, rec-group ABI, runtime-eval namespace, or result-envelope ABI
was changed. Generated Test262 reports and cache artifacts remain outside the
commit.

The PR is ready for a fresh merge-group run. If it fails again, the next agent
should diff the new candidate against its exact merge-group predecessor and
work only newly introduced transitions; do not return authoritative standalone
shards to the refusal provider or broaden the shared closure ABI.

## Implementation Plan — EvalDeclarationInstantiation early errors (arch, 2026-08-08)

### 0. Population reality check — the "~89 SyntaxError" cluster is ALREADY LANDED

Fresh measurement on main tip `a8bbc0d7` (this spec's worktree, full Acorn+interpreter
provider, cache key `8d62618f76cb96b7`, run `20260808-072852`):

```sh
TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

Result: **747 / 816 pass (91.5%)** — standard 305/347, Annex B 442/469, 69 fail,
0 CE, 0 timeout. The 2026-08-03 measurement this issue's task text was written
against (473/816, "89 missing EvalDeclarationInstantiation SyntaxErrors in
literal direct-eval / default-parameter shapes") predates the merged collision
slices (PR #4013 lineage; `src/interp/` landed on main 2026-08-07 via the
#4156 merge). **The entire 192-file `declare-arguments` default-parameter
matrix now passes (192/192, zero failures).** The var-env strict shapes and
lower-lex shapes also pass. Do NOT re-implement:
`foldedEvalParameterCollision` / `foldedEvalLowerLexicalCollision`
(`src/codegen/expressions/eval-inline.ts:360-470`), the interpreter's
`validateNonStrictEvalVarNames` / `prepareGlobalDeclarations` / TDZ lexical
records (`src/interp/eval-environment.ts:470-642`), or the
`preparePersistentEvalBindings` atomic preflight — all merged and green.

What REMAINS of the EvalDeclarationInstantiation early-error family, from the
69-failure enumeration (exact file list in
`benchmarks/results/test262-standalone-results-20260808-072852.jsonl`):

| Bucket | Count | Expectation | Status |
| --- | ---: | --- | --- |
| **A. Global lexical collision** (sloppy eval `var x` vs script `let x`) | 2 | runtime SyntaxError | evaluates silently — **this spec** |
| **B. Eval-lexical leak** (`eval("let x=3")` leaks `x` into caller) | 8 | typeof undefined + ReferenceError after eval | binding leaks — **this spec** |
| **C. Global own-property var/func init** (`var-env-{var,func}-init-*`, `var-env-{var,func}-non-strict`) | 13 | own property on globalThis, configurable, deletable | module-global storage, not `$Object` property — **sketch, follow-on slice** |
| **D. Non-definable global** (`non-definable-global-{var,function,generator}`) | 6 | TypeError (CanDeclareGlobalVar/Function) | no runtime check — **sketch, depends on C** |
| E. `SyntaxError: NaN` Annex-B skip-early-err | 24 | must NOT throw early | **#4137's — in-progress, another lane. DO NOT TOUCH** |
| F. Out of scope: new.target (4), super-prop (6), this-value-func-strict-caller (1), indirect realm (1), indirect lex-env-heritage (1), annexB existing-block-fn-update (2), annexB script-decl-lex-no-collision (1) | 16 | various | different mechanisms (metaproperties/method context, realm identity, B.3.3 update) |

2+8+13+6+24+16 = 69 ✓.

**Bucket A files (2):**
- `test/language/eval-code/direct/var-env-global-lex-non-strict.js` — `let x; eval('var x;')` at global; `negative: {phase: runtime, type: SyntaxError}`; currently "expected runtime SyntaxError but succeeded"
- `test/language/eval-code/indirect/var-env-global-lex-non-strict.js` — `let x; (0,eval)('var x;')` in try; caught must be SyntaxError; currently nothing thrown

**Bucket B files (8):** `test/language/eval-code/{direct,indirect}/lex-env-distinct-{let,const}.js`, `test/language/eval-code/{direct,indirect}/lex-env-no-init-{let,const}.js` — e.g. `eval('let xNonStrict = 3;')` then `assert.throws(ReferenceError, () => xNonStrict)`; currently the `let` resolves after the eval returns.

**Bucket C files (13):** direct: `var-env-func-init-global-new`, `var-env-func-init-local-new`, `var-env-func-init-local-new-delete`, `var-env-func-init-local-update`, `var-env-func-non-strict`, `var-env-var-init-global-new`, `var-env-var-init-global-exstng`, `var-env-var-init-local-new-delete`; indirect: `var-env-func-init-global-new`, `var-env-func-non-strict`, `var-env-var-init-global-new`, `var-env-var-init-global-exstng`, `var-env-var-non-strict`.

**Bucket D files (6):** `{direct,indirect}/non-definable-global-{var,function,generator}.js`.

### 1. Root cause (buckets A and B — both in the AOT constant-splice path)

Both failing populations use **literal** eval sources, so they never reach the
interpreter: `tryStaticEvalInline` (`src/codegen/expressions/eval-inline.ts:657`)
splices the foreign AST into the caller and returns before the provider routing
in `calls.ts:6313-6323`. The interpreter side is already correct for both rules
(`prepareGlobalDeclarations` at `eval-environment.ts:554` throws the
HasLexicalDeclaration SyntaxError against the global lexical-cells carrier;
`prepareEvalEnvironment` gives eval lexicals a fresh discarded TDZ record at
`eval-environment.ts:635-642`). The splice reconstructs the
parameter-environment and lower-lexical collision rules (lines 726-738) but is
missing exactly two caller-dependent behaviors:

- **A**: no check of the eval body's VarDeclaredNames against the **script's
  global lexical declarations** (`ctx.globalLexicalBindings`, populated by
  `recordScriptGlobalLexicalBindingNames`, `src/codegen/source-scan-predicates.ts:397`,
  wired in `recordSourceGlobalEnvironment`, `src/codegen/index.ts:3173`). At
  module-init scope `fctx.directEvalBindingNames` is undefined (only
  FunctionLikeDeclarations get it, `src/codegen/function-body.ts:402`), so
  `foldedEvalLowerLexicalCollision` sees an empty set and the splice proceeds.
- **B**: `compileInlinedEvalStatements` (line 911) calls `hoistLetConstWithTdz`
  (`src/codegen/index.ts:8853`) which registers the eval body's top-level
  `let`/`const` **into the caller's live `fctx.localMap`** and never removes
  them. For direct eval, `isolateBindings` is false; for indirect eval it is
  true only when `hasScriptScopeAnnexBFunction(sf)`. Per PerformEval steps
  17-20 the eval's LexicalEnvironment is a fresh record discarded on exit; a
  later caller read of the name must be an unresolved reference.

### 2. Changes

**All changes are in `src/codegen/expressions/eval-inline.ts` only.** Do not
touch `src/interp/emitter.ts` (owned by in-flight #4137) or
`src/interp/eval-environment.ts` (correct already).

#### 2a. Bucket A — global-lexical collision guard in the splice

Location: inside `tryStaticEvalInline`, immediately after
`const declarationNames = foldedEvalDeclarationNames(sf);` (line ~721),
alongside the existing direct-eval collision block (lines 726-738).

```ts
// §19.2.1.3 step 3.a: when eval's VariableEnvironment is the
// GlobalEnvironmentRecord, every VarDeclaredName must miss the script's
// lexical declarations. Applies to ALL sloppy indirect eval (its varEnv is
// always global) and to sloppy direct eval whose call executes in global
// Script code (module-init fctx — blocks/case/catch do not change varEnv).
if (!evalIsStrict && (!directEval || fctx.name === "__module_init")) {
  const globalLexicals = ctx.globalLexicalBindings;
  if (globalLexicals !== undefined && globalLexicals.size > 0) {
    for (const name of declarationNames.varNames) {
      if (globalLexicals.has(name)) {
        emitThrowJsError(ctx, fctx, "SyntaxError",
          `Identifier '${name}' has already been declared`);
        return { kind: "externref" };
      }
    }
  }
}
```

- Use the `fctx.name === "__module_init"` predicate (same precedent as
  `unsupportedGlobalShape`, line 763), NOT a parent-pointer walk: a nested
  `eval('eval("var x")')` recursion compiles foreign AST nodes whose parents
  reach the foreign `EVAL_SOURCE_FILENAME` SourceFile, so an AST walk gives
  the wrong answer, while the fctx identity is inherited correctly. It is also
  deliberately different from `directEvalRunsAtScriptGlobal`
  (`calls.ts:3264`), which stops at Block/Case/Catch/With — that predicate
  models the LexicalEnvironment global-route; varEnv-globality must NOT stop
  at blocks.
- `declarationNames.varNames` already includes top-level FunctionDeclaration
  names (see `foldedEvalDeclarationNames`, line 374-406) — required, since
  VarDeclaredNames covers them.
- **Exclude `declarationNames.blockFunctionNames`** — B.3.3 cancels, never
  throws (this is what keeps `annexB/.../script-decl-lex-no-collision`-family
  and the `*-skip-early-err-*` family unaffected).
- `evalIsStrict` is the already-computed value at line 712 (uses
  `ctx.inferModuleStrictArguments`), so the #1102 AC2 TS-module lane
  (module-strict ⇒ strict eval ⇒ private varEnv ⇒ no collision) is preserved
  automatically.
- Emitting the throw (rather than `return undefined` to the provider) is
  correct AND cheaper: the error does not depend on runtime state — the
  script's lexical name set is static. It also covers host/GC mode, where the
  provider is not in play.

#### 2b. Bucket B — scoped lexical isolation for the splice

Add a collector next to `foldedEvalDeclarationNames` (~line 406):

```ts
/** Top-level LexicallyDeclaredNames of the eval body: let/const declarations
 * and class declarations directly under the foreign SourceFile. */
function foldedEvalTopLevelLexicalNames(sourceFile: ts.SourceFile): Set<string>
```

(let/const via `NodeFlags.Let | NodeFlags.Const` on direct SourceFile-child
VariableStatements, plus named ClassDeclarations; reuse
`addFoldedEvalBindingNames` for destructuring patterns.)

Add a shadow/restore pair mirroring `enterFoldedDirectEvalVarScope` /
`restoreFoldedDirectEvalVarScope` (lines 601-640):

```ts
interface FoldedEvalLexicalShadow {
  name: string;
  localIdx: number | undefined;        // caller's prior localMap entry
  boxed: BoxedCaptureInfo | undefined; // caller's prior boxedCaptures entry
  tdzFlag: number | undefined;         // caller's prior tdzFlagLocals entry
  boxedTdz: ... | undefined;           // caller's prior boxedTdzFlags entry
  preHoisted: ... | undefined;         // caller's prior preHoistedLetConstSlots entry
}
function enterFoldedEvalLexicalScope(fctx, lexNames): FoldedEvalLexicalShadow[]
function restoreFoldedEvalLexicalScope(fctx, shadows): void
```

`enter` snapshots the five per-name structures **before** the splice compiles
(so a caller binding of the same name is captured); `restore` runs **after**
the splice and (a) deletes the eval-created entries for each lexical name,
(b) reinstates the snapshot values where they existed. This makes the eval's
lexical record observably fresh-and-discarded:

- caller `let outside = 23; eval('let outside;')` — no error, eval shadows,
  caller binding restored (lex-env-distinct first half);
- `eval('let x = 3;')` — after restore `x` is unresolved in the caller, so
  `typeof x` is `"undefined"` and a bare read produces the ReferenceError the
  tests assert (the caller-side unresolved-read machinery already does this —
  proven by the strict variants of the same files, which route to the provider
  today and pass).

Apply at both call sites:

1. **Direct tail** (lines 842-858): wrap the existing
   `enterFoldedDirectEvalVarScope`/`compileInlinedEvalStatements` sequence —
   `const lexShadows = enterFoldedEvalLexicalScope(fctx, foldedEvalTopLevelLexicalNames(sf))`
   before `compileInlinedEvalStatements`, `restoreFoldedEvalLexicalScope` in
   the same `finally` that restores `directEvalSloppyThisFallback`. On the
   `result === undefined` bail path restore BEFORE falling through to the
   provider (no double bookkeeping).
2. **Indirect arm** (line 840): same wrap around
   `compileInlinedEvalStatements(ctx, fctx, stmts, isolateIndirectBindings)`.
   Note indirect isolation today is all-or-nothing keyed on Annex B functions;
   the new scoped-lexical restore is orthogonal and must run even when
   `isolateIndirectBindings` is false (vars must still share the caller/global
   scope — only lexicals are isolated).

Var declarations are deliberately NOT touched: sloppy eval-created vars
persisting in the caller activation is spec behavior and #1102 AC2.

#### 2c. How the caller's lexical-binding set reaches the check (already reified)

Nothing new must be threaded for A/B. The inputs all exist:

- script global lexicals → `ctx.globalLexicalBindings` (compile-time set) and,
  for the runtime provider path, the `RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY`
  carrier (`runtime-eval-provider.ts:46`, seeded by
  `emitRuntimeEvalGlobalBindingSeed`) which `createRuntimeEvalGlobalEnvironment`
  rehydrates into `ENV_GLOBAL.names` — that is why the dynamic-source variant
  of bucket A already throws in the interpreter (`prepareGlobalDeclarations`,
  `eval-environment.ts:560-568`);
- function-scope lexicals → `currentDirectEvalLexicalBindingNames`
  (`direct-eval-environment.ts:242`) — already consumed by
  `foldedEvalLowerLexicalCollision`, already passing its tests.

### 3. AOT splice-path guard design (general principle)

A compile-time fold must never erase a required early error. The decision
table this slice completes, for a literal eval body under standalone:

| Condition | Action |
| --- | --- |
| Parse error | emit-throw SyntaxError (exists, line 694) |
| Script early error (strict names, orphan break/continue, dup params) | emit-throw (exists, `eval-early-errors.ts`) |
| Sloppy var/func name ∈ param-env or lower-lexical (function callers) | emit-throw (exists, lines 726-731) |
| **Sloppy var/func name ∈ script global lexicals (global varEnv)** | **emit-throw (NEW, 2a)** |
| Annex B block-fn crossing caller lexical | bail to provider — cancellation, not error (exists, line 738) |
| Explicitly-strict body/caller with scoped declarations | bail to provider (exists, line 748) |
| Non-static preconditions (extensibility, descriptors — bucket D) | cannot be decided statically: bail to provider once C lands (see §5) |

Emit-throw when the error is statically certain; bail-to-provider when the
outcome depends on runtime environment state. Never splice-and-ignore.

### 4. Edge cases

- **Nested evals**: inner literal `eval` recursion inherits the outer fctx —
  the `__module_init` predicate stays correct; an inner eval spliced inside a
  function-caller fctx keeps using the function-scope collision path.
- **Blocks/switch/catch at global scope**: do NOT suppress the bucket-A guard
  (varEnv is still global). This is exactly the shape of
  `non-definable-global-*` (eval inside `if{try{}}`) — those must keep
  compiling (guard only fires on a *lexical-name* collision).
- **catch-adjacent scopes**: `catch (e) { eval('var e') }` inside a function —
  Annex B.3.5 exempts CatchParameter collisions; the function-scope path
  handles it today (passing); the new guard never fires there (not
  module-init... it can be: global `try/catch` — B.3.5 means `var e` must NOT
  throw. CatchClause bindings are NOT in `ctx.globalLexicalBindings` (only
  top-level let/const/class are — verified `source-scan-predicates.ts:407-414`),
  so the guard correctly stays silent. Add the canary anyway.
- **Indirect eval must NOT get caller collisions**: the guard consults only
  `ctx.globalLexicalBindings` — a function-local `let x` around
  `(0,eval)('var x')` never throws. `lex-env-heritage` (bucket F) is a
  separate indirect-splice caller-capture defect; out of scope here.
- **Annex B interactions — leave alone**: blockFunctionNames excluded from the
  guard; the `*-skip-early-err-*` family (bucket E) is #4137's; the B.3.3
  routing arm (lines 750-763) runs after the new guard and is unchanged.
- **Shadow restore vs. closures**: a closure created inside the eval body over
  an eval-lexical captured via `boxedCaptures` during the splice keeps its
  cell after restore (the cell local is not freed; only the name mapping is).
- **Duplicate lexicals inside the eval body** (`let x; let x`): Acorn/TS parse
  diagnostics already reject — unchanged.
- **Module-strict TS lane (#1102 AC2)**: `evalIsStrict` true ⇒ guard skipped,
  isolation for strict bodies already routes to provider — no behavior change
  for `tests/issue-1102.test.ts`.

### 5. Buckets C and D — sketch only (separate follow-on, do not bundle)

C (13 files) is a substrate item, not an eval-inline patch: eval-created
global `var`/`function` must materialize as **own, configurable (D=true),
deletable properties of the real global `$Object`** that
`Object.getOwnPropertyDescriptor(this, 'x')` sees, with `delete` severing the
binding. Today values round-trip through `__runtime_eval_push_globals`/
`__runtime_eval_pull_globals` cells but never become `$Object` own properties.
The live-binding pattern to follow is `src/codegen/annexb-global-live-binding.ts`
(#4182 — module-global-backed live cells for B.3.3.2). D (6 files) is the
runtime `CanDeclareGlobalVar/Function` TypeError arm
(`eval-environment.ts:510-523` already implements the check in the
interpreter); it is unreachable for literal evals until the splice can consult
the real global object's extensibility at runtime, i.e. it depends on C's
identity unification (AOT `this` object ≡ provider `globalObject`). File one
follow-on issue for C+D referencing this section; projected +19 files.

### 6. Verification

```sh
# Focused before/after (in this worktree, dirty-tree mode runs in place):
TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

- Baseline (2026-08-08, run `20260808-072852`): 747/816.
- After 2a: +2 → 749 (both `var-env-global-lex-non-strict` files).
- After 2b: +8 → **757/816** (all 8 `lex-env-{distinct,no-init}-{let,const}`).
- Required zero pass→fail; watch specifically: the 192 `declare-arguments`
  files, `annexB/.../script-decl-lex-no-collision`-family passes,
  `lex-env-*-strict-*` passes, and the 17 currently-passing
  `issue-2923-eval-const-broaden` fast-path canaries.
- Dev canaries (put in `.tmp/`, promote to `tests/issue-2929-*.test.ts`):
  - `let x; eval('var x;')` → SyntaxError (catchable, runtime phase)
  - `let x; (0,eval)('var x;')` → SyntaxError
  - `let x; var s = 'var x;'; eval(s)` → SyntaxError via provider
    (confirms the dynamic tier is already correct — regression tripwire)
  - `let x; eval('{ function x(){} }')` → NO error (B.3.3 cancellation)
  - `try {} catch (e) { eval('var e;') }` at global → NO error (B.3.5)
  - `eval('let a = 1; a')` → 1, then `typeof a === 'undefined'`
  - `let o = 23; eval('let o;')` → no error, `o === 23` after
  - `function f(){ let y; return eval('var y;') }` → SyntaxError (existing
    lower-lex path, must stay green)
- `pnpm run typecheck`; scoped vitest: `npm test -- tests/issue-1102.test.ts
  tests/issue-2923-eval-const-broaden.test.ts` plus any existing
  `tests/*eval*` suites touched by CI's quality gate.

### 7. Risks / gates

- **#4137 concurrency (real)**: in-progress, other lane, owns bucket E and has
  `loc-budget-allow: src/interp/emitter.ts`. This slice touches ONLY
  `src/codegen/expressions/eval-inline.ts` — no file overlap with #4137's
  declared budget. Do not "fix" any `SyntaxError: NaN` file encountered in the
  diff; they are #4137's baseline.
- **Oracle ratchet (#1930/#3273)**: the new code needs no type queries — it is
  pure syntax walking + `ctx.globalLexicalBindings`. Do not add
  `checker.getSymbolAtLocation` calls; if binding info is ever needed use
  `ctx.oracle`.
- **Coercion-sites ratchet** (`check:coercion-sites`): `emitThrowJsError` and
  the existing helpers are already counted; adding calls to existing helpers
  in an existing module does not create a new module needing
  `coercion-sites-allow`.
- **loc/func budget**: issue frontmatter already allows
  `src/codegen/expressions/eval-inline.ts::tryStaticEvalInline`.
- **False-positive SyntaxError is the top regression risk**: the guard flips
  currently-passing files if it fires for (i) strict eval, (ii) Annex B block
  functions, (iii) function-scope callers, or (iv) TS-module-strict lane.
  Each is excluded by construction (§2a); the §6 canaries pin all four.
- **Restore-path bookkeeping**: `compileInlinedEvalStatements` can return
  `undefined` (late bail to provider) — the lexical restore must run on that
  path too, or the provider-path compile sees phantom caller bindings and the
  fold/runtime disagree. Mirror the existing
  `restoreFoldedDirectEvalVarScope` discipline (line 849).
- **Standalone floor / merge-group**: PR-level test262 checks are designed
  no-ops; the real gate is the merge-group standalone floor. The change is
  monotone (+10 projected, 0 regressions) if the canaries hold.

## TODO — follow-on issue for spec buckets C + D (NOT YET FILED, no id allocated)

**Why this is a TODO and not a real issue file:** the implementing agent tried
to allocate an id with
`node scripts/claim-issue.mjs --allocate --by ttraenkler/opus-eval-lane` and it
**REFUSED (exit 6)**: `gh` is not installed in this sandbox, so the open-PR id
scan degraded and the tool would not reserve an unverified id. `--dry-run`
previewed `#4217`, but a DEGRADED-scan preview is not a reservation and
hand-picking it would race an in-flight PR (#2531). **The next agent with a
working `gh` must run `--allocate` for real and move this section into
`plan/issues/$NEW-<slug>.md`** — do not copy `4217` across.

Proposed frontmatter for the new file:

```yaml
id: $NEW
title: "Eval-created global var/function must become real global-object own properties"
status: ready
priority: medium
horizon: l
feasibility: hard
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: current
parent: 2929
related: [2929, 4182]
```

Scope (see [§5 of the 2026-08-08 implementation plan above]):

- **Bucket C — 13 files.** Eval-created global `var`/`function` must materialize
  as **own, configurable (`[[Configurable]]: true`), deletable properties of the
  real global `$Object`**, visible to
  `Object.getOwnPropertyDescriptor(this, 'x')`, with `delete` severing the
  binding. Today the values round-trip through
  `__runtime_eval_push_globals` / `__runtime_eval_pull_globals` cells and never
  become `$Object` own properties. The live-binding pattern to follow is
  `src/codegen/annexb-global-live-binding.ts` (#4182 — module-global-backed live
  cells for B.3.3.2).
  Files: `{direct,indirect}/var-env-{var,func}-init-*`,
  `{direct,indirect}/var-env-{var,func}-non-strict` — enumerated exactly in §0
  of the plan above.
- **Bucket D — 6 files**, `{direct,indirect}/non-definable-global-{var,function,generator}.js`.
  The runtime `CanDeclareGlobalVar` / `CanDeclareGlobalFunction` `TypeError` arm.
  The interpreter already implements the check
  (`src/interp/eval-environment.ts:510-523`); it is unreachable for **literal**
  evals until the splice can consult the real global object's extensibility at
  runtime — i.e. **D depends on C's identity unification** (AOT `this` object ≡
  provider `globalObject`). Per §3 of the plan, this is a
  "bail-to-provider once C lands" case, not an emit-throw: the outcome depends
  on runtime environment state.

Projected: **+19 files** on the `language/eval-code/` standalone lane
(757 → 776 / 816 on top of this issue's buckets A+B).

Explicitly out of scope for that follow-on: bucket E (24 Annex-B
`skip-early-err` `SyntaxError: NaN` files — owned by #4137) and bucket F (16
files: new.target, super-prop, realm identity, B.3.3 update — different
mechanisms).

## Implementation notes — buckets A + B (2026-08-08)

Buckets A and B of the plan above are implemented; C, D, E and F are not (see
the TODO section for the C/D follow-on; E belongs to #4137; F is out of scope).

All changes are in `src/codegen/expressions/eval-inline.ts`. Two things the
plan did not anticipate had to be added to make bucket B's 8 files actually
flip; both are recorded here because they generalise beyond this slice.

### 1. Dropping the NAME→slot mapping is not enough — the slot must be renamed

`restoreFoldedEvalLexicalScope` originally only removed the eval body's
`localMap` / `boxedCaptures` / `tdzFlagLocals` / `boxedTdzFlags` entries, per
§2b. That fixed a caller-scope read (`typeof x` at the splice site, an IIFE) but
NOT the shape test262 actually uses:

```js
eval('let xNonStrict = 3;');
assert.throws(ReferenceError, function () { xNonStrict; });   // did not throw
```

Cause: the **#1177 block-scope-shadow rescue** in
`src/codegen/closures/arrow-phases.ts` (and its twin in
`src/codegen/statements/nested-declarations.ts`) deliberately falls back to
scanning `fctx.locals` **by name** when `localMap` misses, so a closure built
inside a block can still capture a pre-hoisted-then-shadowed slot. That rescan
resurrects the eval's ORPHANED slot for any closure created **after** the eval
returned. Measured discrimination:

| shape | before the rename fix |
| --- | --- |
| IIFE at the splice site | throws (correct) |
| thunk passed to a helper (`assert.throws`) | **no throw** |
| thunk stored in a var, then called | **no throw** |
| thunk declared BEFORE the eval | throws (correct) |
| name never declared at all | throws (correct) |

Fix: after the splice, rename every slot the eval allocated to
`<name>@evallex$<idx>` / `<name>@evaltdz$<idx>`. `@` cannot occur in a JS
identifier, so no by-name probe can match; the slot INDEX is untouched, so
captures already planned for closures created *inside* the eval body keep
working (pinned by a canary). The mangled name deliberately does not start with
`__`, keeping the compiler-temp deduplicator in `context/locals.ts` away from it.

### 2. `lex-env-no-init-*` is a SECOND, unrelated defect: TDZ `typeof` of a foreign identifier

`eval('typeof x; let x;')` must throw ReferenceError. `typeof-delete.ts`
resolves the operand through `checker.getSymbolAtLocation`; a FOREIGN eval
identifier has no checker symbol at all, so it takes the
genuinely-unresolvable arm and statically folds to `"undefined"`, erasing the
error. (A *bare* read of the same binding is fine — it reaches the TDZ check.)
This is orthogonal to the lexical leak and is why the `-cls` variants of the
same files already passed: classes bail to the provider, whose lexical records
carry real TDZ state.

Fixed **in scope** by bailing to the provider (§3's "never splice-and-ignore"):
`foldedEvalTypeofBeforeLexicalDeclaration` detects a `typeof <ident>` textually
before that lexical's own declaration in the eval body. A `typeof` *after* the
declaration, or of an unrelated name, still folds — pinned by canaries.

The alternative one-line fix — teach `typeof-delete.ts` to consult
`fctx.tdzFlagLocals` before the `!hasValueDecl` fold — was deliberately NOT
taken here: it is outside this slice's declared file scope. It is the better
long-term fix and would also restore the fast path for these bodies.

### Measured result

`TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1
--official-scope-only`, all 816 official files, full Acorn+interpreter provider.

| run | pass |
| --- | ---: |
| baseline `20260808-072852` (main `a8bbc0d7`) | 747 / 816 |
| bucket A only, `20260808-082628` | 749 / 816 |
| buckets A + B, `20260808-091553` | **757 / 816** |

Zero pass→fail at every step. The 10 fail→pass files are the exact bucket A + B
enumeration: `{direct,indirect}/var-env-global-lex-non-strict.js` and
`{direct,indirect}/lex-env-{distinct,no-init}-{let,const}.js`.

## Implementation Plan — eval global own-property substrate C+D (arch, 2026-08-08)

Follow-on slice for buckets **C** (13 files, eval-created global/local var+func
binding materialization) and **D** (6 files, CanDeclareGlobalVar/Function
TypeError) of the eval-code failure enumeration in the A/B spec (§0/§5 of the
2026-08-08 EvalDeclarationInstantiation section — written in worktree
`/home/user/js2/.claude/worktrees/agent-ac08047453f4638e8/`, same file, not yet
on main). This section is self-contained: fresh per-file baseline, mechanism
probes, and the design are all re-derived on branch base `8d2f12a6`
(main + #4137 + #2200).

### (a) Fresh per-file baseline + the #4205 verdict

Instrument: faithful worker path — `CompilerPool(1, "unified")` +
`assembleOriginalHarness` + `pool.runTest(..., {originalHarness: true, target:
"standalone"}, 30_000)`, `TEST262_FULL_RUNTIME_EVAL=1`, full Acorn+interpreter
provider rebuilt for this branch (cache key `b83bad5b0b676c8b`, announced tier
INTERPRETER). Probe script pattern preserved in `.tmp/probe-cd-baseline.mts`.
All 19 files FAIL; per-file error text:

| file (`language/eval-code/`) | error |
| --- | --- |
| direct/var-env-var-init-global-new | `Test262Error: x should be an own property` |
| direct/var-env-var-init-global-exstng | `Test262Error: x should be an own property` |
| direct/var-env-func-init-global-new | `Test262Error: f should be an own property` |
| indirect/var-env-var-init-global-new | `Test262Error: x should be an own property` |
| indirect/var-env-var-init-global-exstng | `Test262Error: x should be an own property` |
| indirect/var-env-func-init-global-new | `Test262Error: f should be an own property` |
| indirect/var-env-var-non-strict | `Test262Error: x Expected SameValue(«1», «0»)` (eval `var x=1` wrote the CALLER's local) |
| indirect/var-env-func-non-strict | `Expected SameValue(«"undefined"», «"function"»)` |
| direct/var-env-func-non-strict | `Expected SameValue(«"undefined"», «"function"»)` (typeofInside was "undefined") |
| direct/var-env-func-init-local-new | `Expected a ReferenceError to be thrown but no exception was thrown` (leak) |
| direct/var-env-func-init-local-new-delete | `binding may be deleted Expected a ReferenceError…no exception` |
| direct/var-env-func-init-local-update | `Expected SameValue(«"number"», «"function"»)` |
| direct/var-env-var-init-local-new-delete | `Expected a ReferenceError to be thrown but no exception was thrown` |
| direct/non-definable-global-{var,function,generator} | `Expected true but got false` (`error instanceof TypeError` false — no throw; `preventExtensions(this)` itself WORKS, the guard `nonExtensible` was true) |
| indirect/non-definable-global-{var,function,generator} | `Expected a TypeError to be thrown but no exception was thrown` |

**Routing fact that reframes the whole issue**: a compile-probe of all nine
shapes (`.tmp/probe-route.mts`, inspects the import section for
`js2wasm:runtime-eval`) shows **every one of the 19 files' evals is SPLICED
today** (`tryStaticEvalInline` accepts them). None of these failures is a
provider/interpreter gap — they are all consequences of the AOT constant-splice
reconstructing EvalDeclarationInstantiation without the global-object /
deletable-binding halves.

**Mechanism probe — the interpreter tier already implements C-global and D
correctly, end-to-end** (`.tmp/probe-provider-equiv.mts`: same semantics with a
dynamic source `var s='…'; eval(s)`, which forces provider routing):

| probe (provider-routed) | result |
| --- | --- |
| new global `var` → own property, {writable,enumerable,configurable}=true, initial `undefined` | **PASS** |
| existing script `var x=23` + eval `var x=45` → own property {value:45, configurable:false}, initial 23 | **PASS** |
| new global `function f` → own property, configurable:true, instantiated before statements | **PASS** |
| `Object.preventExtensions(this)` then eval `var …` → TypeError | **PASS** |
| direct eval in IIFE declaring `function f` → caller-varEnv binding, mutable, no global leak, outer `f` throws ReferenceError | **PASS** |
| indirect alias eval `var x` from global → own configurable property | **PASS** |
| eval `delete x` on eval-created LOCAL var → later closure read must throw | **FAIL** (`no ReferenceError after delete`) |
| eval `function fun(){}` in IIFE, then AOT sibling `typeof fun` | **FAIL** (`inside: undefined`) |

This settles the two identity questions the task raised: **(1) AOT `this` ≡
provider `globalObject` is ALREADY unified** — `emitStandaloneDirectEvalRuntime`
(`src/codegen/expressions/runtime-eval-provider.ts:629`) passes
`emitGlobalEnvironmentObject(...)` = the #2996 native `$Object` singleton
(`emitNativeGlobalThisObject`, `src/codegen/array-object-proto.ts:2430`) into
`__runtime_direct_eval`, and `createRuntimeEvalGlobalEnvironment`
(`src/interp/eval-environment.ts:34`) uses that very object as
`ENV_GLOBAL.backing`. **(2) The cross-module property store works** — the
provider's `Object.defineProperty(globalObject, …)` / `Object.isExtensible`
land on the caller's singleton and are visible to caller-side
`hasOwnProperty`/`gOPD`/`verifyProperty` (proved by the four passing global
probes; the WasmGC `$Object` rec-group is structurally canonical across the
module seam, as #2928's carrier ABI requires).

#### #4205 verdict: ADJACENT — the shared substrate already exists; there is no 133-file spillover

`plan/issues/4205-script-goal-global-object-standalone.md` is **`status: done`
(2026-08-07) and its implementation record RETRACTS the filed framing**:

- "Standalone has no realm global object" is **false as of #2996** — the
  identity-stable `$Object` singleton exists, `this === globalThis` at script
  top level, `this.p1 = 1; p1 === 1`, `delete this.p1`, `gOPD(this,'p1')` all
  pass on main. The `!ctx.standalone` gate at
  `src/codegen/expressions/call-builtin-static.ts:2315` is gOPD-local and was
  **not on the symptom's path**.
- The census's 137-file lever was a *shape*, not a mechanism: #4205's full A/B
  (388 files, both arms) fixed 7 files, broke 0, and changed **zero** error
  signatures among the 96/99 `with`-overlap files. The "#4205 unmasks the
  `with` cluster" dependency **does not exist**. Do NOT project a 150-file
  yield from this spec; the honest population is the 19 files here (+2
  probable, see below).
- The one genuinely shared residue is #4205's deferred **G2** (script `var`
  visible as a global-object own property with configurable:false — 10 failing
  ES5 files, 0 passing, design sketched in #4205's record). **Bucket C does
  NOT depend on G2**: the provider's entry-time
  `__runtime_eval_push_globals` (`emitRuntimeEvalGlobalBindingPushBody`,
  `src/codegen/expressions/runtime-eval-provider.ts:132-287`) already defines
  every script var/function as a property (attrs `0x23`:
  writable+enumerable, configurable:false) on the singleton before interpreted
  code runs — which is exactly why the `-exstng` probe passes. G2 remains a
  separate, non-eval-facing 10-file item; recommend a fresh issue (allocate id
  via `claim-issue.mjs`), not bundling.

Where the two DIVERGE so implementations don't fight: #4205/G2 is about the
**static-correspondence read path** (module globals as storage, compile-time
name sets, member-access lowering in `unary-updates.ts` /
`sloppy-this-global.ts`). This slice deliberately adds **zero** new codegen on
any name-resolution or member-access path — its entire AOT-side change is a
routing predicate inside `tryStaticEvalInline`. No shared files, no shared
mechanism beyond the already-built singleton.

### (b) Substrate design — route, don't re-implement

**What object IS the standalone global?** The existing #2996 `$Object`
singleton (`__native_globalThis` module global). No new object, no facade.
Eval-created global vars/functions become own configurable properties on it
**by the interpreter's existing `prepareGlobalDeclarations` /
`prepareGlobalVarBinding` / `prepareGlobalFunctionBinding`**
(`src/interp/eval-environment.ts:510-592`) — code that is already correct and
already reachable for dynamic sources. The defect is only that literal sources
never get there.

**Core change (slice 1): bail the splice to the provider when the eval's
VariableEnvironment is the GlobalEnvironmentRecord and the body declares
vars/functions.**

- File: `src/codegen/expressions/eval-inline.ts`, function `tryStaticEvalInline`
  — place with the other standalone routing arms (after the strict-isolation
  bail at line ~749 and the Annex-B global-shape arm at lines ~751-765, BEFORE
  `containsEvalValueReference` at ~774; must stay ahead of the
  argument-side-effect compilation at ~834, which the existing comment already
  mandates for all eligibility checks):

```ts
// EvalDeclarationInstantiation §19.2.1.3 step 16/CanDeclareGlobal* (buckets
// C+D): when the sloppy eval's varEnv is the GlobalEnvironmentRecord, var and
// function declarations must become own (configurable, D=true) properties of
// the realm global object, gated by IsExtensible — runtime state the splice
// cannot know. The interpreter implements all of it (prepareGlobalDeclarations);
// route there. Direct eval's varEnv is global exactly when the caller fctx is
// the module initializer (blocks/case/catch do not change varEnv — same
// predicate precedent as unsupportedGlobalShape); sloppy indirect eval's
// varEnv is ALWAYS global regardless of call site.
if (
  ctx.standalone &&
  !evalIsStrict &&
  declarationNames.varNames.size > 0 &&
  (directEval ? fctx.name === "__module_init" : true)
) {
  return undefined; // provider owns EvalDeclarationInstantiation here
}
```

- `declarationNames.varNames` already includes top-level FunctionDeclaration
  names (`foldedEvalDeclarationNames`), so one predicate covers var + func +
  generator bodies. `blockFunctionNames` are deliberately NOT counted (B.3.3
  has its own arm at lines 751-765, unchanged).
- `evalIsStrict` (line ~712) excludes strict bodies and strict direct-eval
  callers — strict eval vars live in a private varEnv, never on the global
  (this preserves the #1102 AC2 TS-module lane and all `*-strict` siblings).
- `ctx.standalone` only: WASI has no provider (bail would degrade splice →
  refusal), host/gc keeps today's splice (its dynamic fallback is host `eval`
  with different scope plumbing — do not touch).
- Ordering vs the A/B slice: the bucket-A global-lexical-collision emit-throw
  (§2a of the A/B spec) must run BEFORE this bail — it is statically certain,
  cheaper, and also covers host mode. The provider would throw the same
  SyntaxError anyway (`prepareGlobalDeclarations` lines 560-568), so
  mis-ordering is a perf/coverage wart, not a correctness bug.

**Why routing beats materializing properties in the splice** (the design the
§5 sketch originally gestured at): an in-splice implementation must reproduce,
in emitted Wasm, the CanDeclare* preflight atomicity (validate ALL names before
defining ANY), descriptor-preserving redefinition rules, function-before-var
ordering, existing-property no-reset, AND reroute every subsequent read/write
of the created names through the object so `delete this.x` severs the compiled
read path. That is a re-implementation of `prepareGlobalDeclarations` plus a
new name-resolution mode — precisely the #4055 anti-pattern (new substrate
where an existing answer exists) and a standing perf hazard on identifier
lowering. Routing costs: interpreter-speed execution of these eval sites (eval
is cold), and the provider dependency (CI's standalone lane links the full
provider; local refusal-tier runs will report these files as the documented
TypeError — instrument note, not a regression).

**How reads/writes/delete converge after routing** (all existing machinery,
verified by the probes):

- Eval-created NEW global name, later AOT bare read: the outer identifier has
  no TS symbol → `emitRuntimeEvalGlobalRead` (`src/codegen/global-environment.ts:99`,
  HasProperty + get + unwrap; gated on `ctx.runtimeEvalGlobalFunctionBindings`,
  which is already true for every eval-consuming file via
  `sourceUsesRuntimeEvalBoundary` → `src/codegen/index.ts:6038`). `typeof`
  takes the non-throwing variant (`src/codegen/typeof-delete.ts:1575`).
- `delete this.x` → native `__delete_property` on the singleton (configurable:
  true ⇒ removed) → the SAME HasProperty-guarded read now throws
  ReferenceError. Severed both ways by construction — no static storage ever
  existed for the name.
- Existing script var (`-exstng`): seeded onto the object by
  `__runtime_eval_push_globals` at provider entry (configurable:false per
  ScriptDeclarationInstantiation), value-updated by the interpreter's
  SetMutableBinding, pulled back into the module global by
  `__runtime_eval_pull_globals`. AOT reads keep the `global.get` fast path.

**Slice 2 (local varEnv function declarations, direct eval)**: extend the bail
to sloppy DIRECT evals in FUNCTION callers whose body has top-level
FunctionDeclarations:

```ts
if (ctx.standalone && !evalIsStrict && directEval &&
    fctx.name !== "__module_init" &&
    foldedEvalHasTopLevelFunctionDeclaration(sf)) {
  return undefined;
}
```

(new tiny collector next to `foldedEvalDeclarationNames`; or derive from the
existing declaration walk). The provider models function instantiation order
and caller-varEnv binding via the reified activation cells — probe `lfunc-new`
passes including the mutation (`f = 5`) and the no-leak ReferenceError.
Expected: `func-init-local-new`, `func-init-local-update`. Keep this a
SEPARATE PR: function-scope literal evals are a much larger passing population
than global ones (the entire 192-file `declare-arguments` matrix is
function-scope — it declares only vars, so the predicate must key on function
declarations specifically, and the matrix must be a named canary).

**Slice 3 (interpreter/boundary gaps — the two probes that fail on the
provider tier)**:

1. `delete` of an eval-created binding in a FUNCTION varEnv does not sever
   (`lvar-delete` probe; files `var-env-var-init-local-new-delete`,
   `func-init-local-new-delete`). Investigate the interpreter's Delete opcode
   against `EnvRec` bindings created by `ensureVarBinding`
   (`src/interp/eval-environment.ts:491-508`) and the persistent activation
   cells (`preparePersistentEvalBindings`) — the closure created inside the
   eval (`postDeletion = function(){ x; }`) must observe the binding's removal,
   so deletion has to mark the cell/name-map entry dead, not just remove a
   local alias.
2. An eval-created NEW local binding is invisible to AOT sibling statements in
   the same activation (`lfunc-non-strict` probe; file
   `direct/var-env-func-non-strict`). The AOT caller compiled `typeof fun`
   against the no-symbol dynamic-GLOBAL read, but the binding lives in the
   activation layer the provider returned. Likely fix direction: on provider
   return, `reifyCurrentDirectEvalBindings` /
   the state-cell pool (`DIRECT_EVAL_STATE_BINDING_CAPACITY` cells in
   `emitStandaloneDirectEvalRuntime`) already carries eval-created names — the
   AOT-side no-symbol read inside a function that CONTAINS a direct eval
   should consult the activation state cells before falling through to the
   global object. Spec this as investigation, not prescription; it is
   boundary work across `direct-eval-environment.ts` + `eval-environment.ts`.

### (c) Bucket D wiring

Nothing new to build: `canDeclareGlobalVar`/`canDeclareGlobalFunction`
(`src/interp/eval-environment.ts:510-523`) already run inside
`prepareGlobalDeclarations` with the atomic validate-all-before-create order,
and the caller-side `Object.preventExtensions(this)` /
`Object.isExtensible(this)` already manipulate the singleton's flags field
(`$Object` flags, `src/codegen/object-runtime.ts:28`) in a way the provider
observes across the module seam — the `non-definable` probe passes with ZERO
interpreter changes. The slice-1 bail is the entire wiring for all 6 D files.
The direct-D shape (`eval` nested in `if{try{}}`) is covered because blocks do
not change the module-init fctx (same varEnv-globality argument as the A/B
spec's §2a).

### (d) Slicing / minimal first PR

| PR | change | expected flips | risk |
| --- | --- | --- | --- |
| **1 (minimal)** | slice-1 bail predicate (one `if`, `eval-inline.ts`) | **12 firm**: 6 C-global own-property + 6 D. **+2 probable**: `indirect/var-env-{var,func}-non-strict` (probe the exact files before claiming — the IIFE-caller indirect seed path was validated only from global scope) | low — eval-code-scoped; must stack on the in-flight #2929 A/B PR (same function) |
| 2 | local-varEnv function-decl bail | +2 (`func-init-local-new`, `-update`) | medium — function-scope eval population is large; declare-arguments canary mandatory |
| 3 | interpreter delete-severing + sibling visibility | +3 (`…local-new-delete` ×2, `direct/var-env-func-non-strict`) | medium — touches `src/interp/`; coordinate with #4137 (owns `src/interp/emitter.ts`) |

"Can C ship without D" is moot under this design — one predicate delivers both
(D is just the interpreter's existing check becoming reachable). The
"#4205-facing half" does not exist as work: #4205 is done; G2 is a separate
10-file issue to file independently.

### (e) Edge cases

- **Redeclaration of an existing global** (`var-env-var-init-global-exstng`):
  `prepareGlobalVarBinding` early-returns when the own property exists, so the
  push-seeded configurable:false descriptor survives and only the value updates
  (verified by probe). Do not "fix" the interpreter to redefine.
- **Function vs var descriptors**: eval's D=true makes BOTH configurable:true
  when newly created; functions redefine an existing CONFIGURABLE property to
  {writable,enumerable,configurable:true} but leave a compatible
  non-configurable data property's attributes alone
  (`prepareGlobalFunctionBinding` — already per §9.1.1.4.18).
- **Strict eval**: excluded by `evalIsStrict` in the predicate; strict bodies
  with scoped declarations already route to the provider via the line-749 arm.
- **Host lane**: untouched (`ctx.standalone` gate). WASI: untouched (no
  provider — keep splicing).
- **Annex B block functions**: `blockFunctionNames` not in the predicate; the
  existing 751-765 arm and #4137's bucket E are unaffected.
- **B.3.5 catch-parameter** (`try{}catch(e){ eval('var e') }` at global): the
  bail routes it to the provider, whose `validateNonStrictEvalVarNames` skips
  object records and B.3.5-exempts the catch binding — behavior preserved; add
  the canary from the A/B spec's list anyway.
- **TS-lib-shadowing names** (`eval('var name')` / `length` / `onload`): the
  outer AOT read of such a name resolves a lib symbol instead of the
  no-symbol dynamic path, so post-eval reads may miss the property. Known,
  pre-existing resolution split — note in the PR, do not chase.
- **Nested eval recursion**: an inner literal eval inside a provider-routed
  source is interpreted (fine); an inner eval inside a still-spliced outer
  body inherits the outer fctx, so the `__module_init` predicate remains
  correct (same argument as the A/B spec).
- **`eval('x = 1')` (assignment only, no declaration)**: `varNames` empty → no
  bail → splices exactly as today.

### (f) Verification

```sh
# per-file before/after (fast, faithful worker path — scripts preserved in .tmp/):
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 node --import tsx .tmp/probe-cd-baseline.mts
# full population (needs the machine-global lock free; ~30+ min):
TEST262_PATH_FILTER=language/eval-code/ TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
TEST262_REPORTER=dot pnpm run test:262 -- --official-scope-only
```

Prereqs on a fresh worktree: `pnpm install --prefer-offline`, `pnpm run
build:compiler-bundle`, the `runtime-bundle.mjs` esbuild line from
`.github/workflows/ci.yml:429`, and `node --import tsx
scripts/build-runtime-eval-provider.mjs` (~3.5 min; the cache key tracks the
compiler bundle, so REBUILD after every src/ change — a stale provider silently
serves the previous compiler's semantics).

- Expected flips: PR1 +12 (firm) to +14; PR2 +2; PR3 +3; total ≤19 in this
  population. NOTE: the A/B spec's 747/816 eval-code baseline predates the
  #4137/#2200 merges on this branch — re-measure the full-population number on
  the PR branch base before quoting deltas.
- **Zero-regression controls (named)**:
  - the **192-file `declare-arguments` matrix** (function-scope var-only
    evals — must NOT match any new predicate; spot-check that their compiled
    modules' import sections are unchanged, i.e. still spliced);
  - **annexB eval-code** current 444/469 — zero pass→fail;
  - the **17 `issue-2923-eval-const-broaden` fast-path canaries**;
  - `tests/issue-1102.test.ts` (module-strict lane), `tests/issue-4162.test.ts`,
    `tests/issue-4195-eval-refusal-message-and-dedupe.test.ts`;
  - `npm test -- tests/equivalence.test.ts`.
- **Hot-path perf**: the design's argument is structural — no codegen change
  on any name-resolution path, so eval-free modules must compile
  **byte-identically**. Verify: compile 3-4 `playground/examples/*.ts` before/
  after and diff wasm sha256 (stronger and cheaper than a perf run). For the
  perf canary on eval-CONTAINING code, `benchmarks/run.ts` →
  `playground-benchmark-sidebar.json` diff is the named benchmark; no entry
  there uses literal global-var eval, so expect noise-level deltas only.
- Promote the two probe scripts to `tests/issue-XXXX-*.test.ts` (id from
  `claim-issue.mjs --allocate` — unreachable from this sandbox, do NOT
  hand-pick) with the provider-linked pool pattern from
  `tests/issue-3426-realm-canary.test.ts`.

### (g) Risks / gates

- **File collision (real, sequencing-critical)**: the in-flight #2929 A/B
  implementer owns `src/codegen/expressions/eval-inline.ts` and edits the SAME
  region of `tryStaticEvalInline` (lines ~720-770). PR1 must stack on that
  PR's branch (predecessor-stacking per CLAUDE.md) or land after it; the
  bucket-A guard must precede the new bail. Slice 3 additionally risks
  `src/interp/emitter.ts` (#4137's declared budget) — keep slice-3 edits in
  `eval-environment.ts`/`direct-eval-environment.ts` or coordinate. **No
  overlap with #4194** (carrier-bag / property-access dispatch): this design
  touches no property-access codegen at all.
- **#4071 hazard (Object.keys widening)**: not triggered — no compiled-side
  property materialization on any receiver; the only object mutated is the
  singleton, by the interpreter, per spec (verifyProperty's enumerability
  probe REQUIRES the new keys there).
- **#4055 composition rule**: honored by construction — the existing answer
  (interpreter EvalDeclarationInstantiation + native property store) is used;
  no new substrate.
- **Query-must-never-allocate / hot-path**: no new queries; reads stay
  `global.get` for script names. The bail only swaps which existing arm an
  eval CALL SITE takes.
- **Oracle ratchet**: the predicate is pure syntax on the foreign AST + fctx
  identity — zero checker/oracle queries.
- **Coercion-sites ratchet**: no new module, no new coercion sites.
- **loc/func budgets**: `src/codegen/expressions/eval-inline.ts` and
  `tryStaticEvalInline` are already on this issue's allow lists.
- **Top regression risk**: a currently-PASSING file whose literal global
  var/func eval silently relied on splice semantics (eval-created var used as
  a TYPED module value later). Mitigation: the A/B over every standalone file
  whose source greps `eval(` with a `var`/`function` literal (bounded, few
  hundred files) before enqueue; anything that flips pass→fail is a provider
  fidelity bug to fix BEFORE landing, not after.
- **Instrument trap** (for whoever re-measures): with no
  `TEST262_FULL_RUNTIME_EVAL=1` (or a stale provider cache) the newly-routed
  files fail with the refusal TypeError / LinkError and the change reads as a
  regression. The tier announcement line (`runtime-eval tier: INTERPRETER
  (key …)`) is the control — quote it in the PR.

## Implementation record — C+D slices 1 & 2 landed, slice 3 NOT landed (2026-08-08)

Branch base for every number below: `main` + the merged #2929 A/B stack
(`64b8bcfc`, `0afe71af`, `08bd1244`). Standalone target, faithful worker path
(`CompilerPool(1,"unified")` + `assembleOriginalHarness` + `runTest`),
`TEST262_FULL_RUNTIME_EVAL=1`.

Tier announcement (the instrument control §f demands):

```
[probe] runtime-eval tier: INTERPRETER (key 4b014a5cc23d45eb, TEST262_FULL_RUNTIME_EVAL=1)
```

(key `1a78259035ddfefe` after slice 2 — the key tracks the compiler bundle and
was rebuilt after every `src/` change.)

### Re-measured baseline — the spec's 747/816 is stale

The §f note is right that the figure predates the merges. Re-measured here, and
the 816 splits into two populations that must be reported separately:

| population | base | after slice 1 | after slice 2 |
| --- | --- | --- | --- |
| `language/eval-code` (347 files) | 312 | 324 | **326** |
| `annexB/language/eval-code` (469 files) | 442 | 442 | 442 |
| combined | 754/816 | 766/816 | **768/816** |

**Zero pass→fail and zero fail-signature changes in either population, at both
slices.** All 19 C+D files reproduced the spec's §a error table exactly on the
base, so the diagnosis transferred intact.

### Slice 1 — +12, and the "probable" pair is CONFIRMED

6 C-global own-property files, 4 bucket-D files, and **both** members of the
spec's probable pair (`indirect/var-env-{var,func}-non-strict`) — probed
explicitly rather than assumed, as §d required.

The spec predicted "12 firm (6 C-global + 6 D) + 2 probable". The count landed
at 12, but the composition differs: only **4** of the 6 D files are reachable
by routing (see the residue below), and the 2 probable files flipped.

### Slice 2 — +2, exactly as predicted

`direct/var-env-func-init-local-new`, `direct/var-env-func-init-local-update`.
The 192-file `declare-arguments` matrix was compiled in full and its import
sections inspected: **192/192 still SPLICED, 0 provider imports**, before and
after. Keying the predicate on top-level FunctionDeclarations rather than on
`varNames` is what preserves it.

### Byte-identity (the §f hot-path argument)

`fib.ts`, `loop.ts`, `array.ts`, `string.ts` from
`website/playground/examples/benchmarks/` compile to **identical wasm sha256**
at base, slice 1 and slice 2. The design's "no codegen on any name-resolution
path" claim holds mechanically.

### RESIDUE 1 (bucket D, 2 files) — direct eval never applies CanDeclareGlobalFunction

`direct/non-definable-global-function` and `direct/non-definable-global-generator`
do **not** flip, and cannot be fixed by routing — they already route.

The spec's §a table describes all six `non-definable-global-*` files as the
`preventExtensions(this)` shape. That is only true of the `-var` pair. The
`-function`/`-generator` pair instead evaluates `function NaN(){}` and needs
`CanDeclareGlobalFunction` to REFUSE because `NaN` is an existing
`{writable:false, enumerable:false, configurable:false}` own property.

Measured, and the cause is **not** `NaN` and **not** realm population:

| probe | result |
| --- | --- |
| `NaN` own property of the realm global after any eval | present, `w=false e=false c=false` (`installRuntimeEvalRealm`, `src/interp/loop.ts:183-197`, works) |
| `(0,eval)("function NaN(){}")` | **TypeError** (correct) |
| `eval("function NaN(){}")` at global | no throw |
| define own `zzTop` `{w:false,e:false,c:false}`, then `(0,eval)("function zzTop(){}")` | **TypeError** (correct) |
| same, `eval("function zzTop(){}")` | **no throw** |

A user-defined property reproduces it, so this is not about `NaN`, the intrinsic
set, or #4205/G2. **A sloppy DIRECT eval whose varEnv is the global record does
not run the `plan.functionNames` CanDeclareGlobalFunction loop of
`prepareGlobalDeclarations` (`src/interp/eval-environment.ts:570-574`), while
the identical INDIRECT eval does.** Everything observed is consistent with
`plan.functionNames` being empty on the direct path (the var loop still runs —
`direct/non-definable-global-var` passes — and a NEW name still materializes as
a property via `prepareGlobalVarBinding`, which is why the direct
function-declaration cases otherwise look right).

This is a provider/interpreter defect in the direct-eval declaration-instantiation
path, independent of the C+D routing work. Worth its own issue.

### RESIDUE 2 (slice 3 gap i, 2 files) — eval-created bindings are not deletable

`direct/var-env-var-init-local-new-delete`, `direct/var-env-func-init-local-new-delete`.
Two independent blockers, both proven:

1. **Runtime**: `envDelete` (`src/interp/loop.ts:777-787`) returns `false` for
   *every* declarative own cell. §19.2.1.3 steps 9/11 create eval's var and
   function bindings with `CreateMutableBinding(n, **true**)` — D = deletable —
   so eval-created bindings must be severable. Deletability is per-binding, but
   `EvalBindingCell` is a frozen cross-module ABI struct and `EnvRec` a frozen
   rec-group, so the flag has to live in an out-of-line side table (the idiom
   `VARIABLE_ENVIRONMENTS` / `EXISTING_VARIABLE_ENVIRONMENTS` already use).
   Severing itself is cheap and needs no array splice: overwrite the entry in
   `env.names` with a unique non-string sentinel, since every own-binding probe
   compares `names[i] === name`. `preparePersistentEvalBindings`
   (`eval-environment.ts:342`) already treats `names[i] === undefined` as a
   reusable vacancy, so that convention exists.
2. **Emitter (the blocker)**: `src/interp/emitter.ts:1859-1862` folds
   `delete <identifier>` to `LdaFalse` at COMPILE time whenever
   `isBoundName(name)` — and `isBoundName` includes the eval body's own
   `hoistedVars`. So `envDelete` is never reached for exactly the names that
   are supposed to be deletable, and no runtime fix alone can work.

A first cut of (1) was written and then **reverted**: keyed on `ensureVarBinding`
it never fires (the direct-eval path allocates through
`preparePersistentEvalBindings` instead), and behind the (2) fold it is
unreachable regardless. Shipping unverifiable dead code would have been worse
than recording the analysis. Fixing this needs (2), which is
`src/interp/emitter.ts` — #4137's declared budget — so it needs coordination,
not a drive-by edit.

### RESIDUE 3 (slice 3 gap ii, 1 file) — eval-created local bindings are invisible to AOT siblings

`direct/var-env-func-non-strict`. Measured contrast:

| shape | result |
| --- | --- |
| `(function(){ eval('var q = 4;'); v = q; }())` | **passes** — SPLICED, so `q` is an ordinary caller local |
| `(function(){ eval('function fun2(){...}'); v = fun2(); }())` | **fails**, `fun2 is not defined` — routed by slice 2 |

The boundary carries only names collected from the CALLER's AST:
`collectDirectEvalBindingNames` / `collectDirectEvalActivationBindingNames`
(`src/codegen/direct-eval-environment.ts:64,109`) feed
`fctx.directEvalBindingNames`, and `currentDirectEvalBindings` builds the cell
layers from that set. A name the eval CREATES has no cell, so the AOT sibling
read falls through to the no-symbol dynamic global read and finds nothing.

The compiler *can* know these names — the eval source is a literal, and
`foldedEvalDeclarationNames(sf)` already computes exactly them. A fix would
pre-allocate activation cells for the eval's declared names at the call site and
have the provider write created bindings back. That is a new write-back
direction across `eval-inline.ts` + `direct-eval-environment.ts` +
`runtime-eval-provider.ts`, i.e. genuinely more than an L-slice, so it is
recorded rather than forced.

### Test coverage

- `tests/issue-2929-cd-global-materialization.test.ts` (new, 11 tests) — own-property
  descriptors, existing-script-var non-configurability, delete-severing at global,
  the assignment-only no-bail case, the three reachable D refusals, and a pin on
  RESIDUE 1. Provider-linked `CompilerPool`; `describe.skipIf`s off the refusal
  tier. Kept under #2929's id because `claim-issue.mjs --allocate` cannot reach
  GitHub from this sandbox and hand-picking an id is forbidden (#2531) — it needs
  a real id before this work is filed as its own issue.
- `tests/issue-2929-evaldecl-early-errors.test.ts` — 28/28. Four tests changed
  from splice-behaviour to routing assertions, because their global-varEnv var
  declarations are now provider-owned by design.

## Implementation record — slice 3 checkpoint (2026-08-11)

The runtime-eval state slice above is implemented on
`codex/2928-runtime-eval-mvp-20260811`, based on `origin/main` `6c1117f8767e9b`.
No provider export or callable/rec-group ABI changed.

### Deletable eval-created bindings

- Eval/script bytecode now emits `DeleteName` for a bound identifier when
  EvalDeclarationInstantiation predeclared the script bindings. Ordinary
  function/module bound-name deletes remain folded to `false`.
- Each persistent source-visible eval binding occupies an even environment
  entry; the adjacent odd entry carries the impossible name
  `\0js2wasm:deletable-eval-binding`. This is a flat, native-string metadata
  carrier: `$EnvRec` and `$EvalBindingCell` stay frozen, and the separately
  compiled provider does not depend on a provider-local weak collection.
- Successful deletion tombstones both entries and clears the live value cell.
  A later eval reuses the pair. Established caller cells have no adjacent marker
  and still reject deletion.
- The caller state pool is one 256-cell flat carrier. Each source-visible
  binding consumes four `$EvalBindingCell` entries —
  `[name, value, markerName, markerValue]` — so the logical capacity remains
  64 bindings. AOT sibling lookup advances by that four-cell stride and never
  exposes the companion marker as a source binding.

The flat marker is deliberate. Self-compiled `WeakMap`/`WeakSet` metadata lost
identity at the provider boundary, while nested array/object metadata either
trapped on a foreign structural cast or made the standalone self-compiler's
type specialisation exceed its heap ceiling.

### AOT sibling visibility

Provider snapshot now normalises values written into caller-owned state cells
through the existing runtime-eval result carrier. A no-symbol AOT identifier
(including the `typeof` paths) first scans those persistent cells, unwraps a
match, and falls back to the ordinary realm-global read on a miss. Functions
without direct eval still take the byte-identical global-read path.

### Measured acceptance

Fresh compiler/runtime bundles and a fresh full interpreter provider were built
after the source changes. Provider key `cea83b3383b5f8ea`, 4,299,913 bytes,
canary-verified. Run `20260811-201606`, `TEST262_FULL_RUNTIME_EVAL=1`:

| file | result |
| --- | --- |
| `direct/var-env-var-init-local-new-delete.js` | PASS |
| `direct/var-env-func-init-local-new-delete.js` | PASS |
| `direct/var-env-func-non-strict.js` | PASS |

Report: **3/3**, zero compile errors. The full 816-file remeasurement is still
required before replacing the recorded aggregate baseline.

Additional gates at this checkpoint:

- `tests/interp/eval-environment.test.ts`: 55/55, including delete, tombstone
  reuse, function closure severing, and caller-binding refusal.
- `tests/issue-2928.test.ts`: standalone interpreter self-compile/canary PASS.
- targeted #2923/#2928/#2929 regression set: 125 passes; its nine failures
  reproduce identically on clean `origin/main` and are stale #2923
  warning-based bail expectations after runtime routing landed.
- typecheck PASS.

The QuickJS adapter shares this caller state pool. Its compatibility patch now
skips the exact marker pair, retains 64 *visible* slots, reconciles successful
deletions, and reuses tombstoned groups. The cross-engine result is recorded in
#4242; it does not change the interpreter default.

## Final runtime-eval parity checkpoint — 2026-08-11

The authoritative full-provider comparison now covers the complete 1,351-file
eval-dependent scope from #4242, not only the three repaired probes. Both arms
used the same compiler/runtime bundle, standalone target, official scope, two
compiler workers, two execution workers, and an identical expected-file gate.

| Engine | Run | Pass | Fail | Compile error | Timeout / skip |
| --- | --- | ---: | ---: | ---: | ---: |
| Acorn + bytecode interpreter | `20260811-222840` | **1,099 / 1,351** | 226 | 26 | 0 / 0 |
| QuickJS compatibility engine | `20260811-221743` | 1,081 / 1,351 | 244 | 26 | 0 / 0 |

The interpreter arm announces `INTERPRETER`, uses a fresh self-compiled
zero-import provider, and passes `tests/issue-2928.test.ts`. Relative to the
fresh promoted standalone baseline it has exactly three `fail -> pass`
transitions:

- `direct/var-env-var-init-local-new-delete.js`;
- `direct/var-env-func-init-local-new-delete.js`; and
- `direct/var-env-func-non-strict.js`.

This closes the three slice-3 residues above: eval-created local bindings are
deletable, deletion severs a returned interpreted closure's persistent state,
and later AOT siblings can observe runtime-created `var`/function bindings.
Direct eval, indirect eval, and `Function`/`new Function` continue to use the
same frozen provider/callable seam.

Two state-coherence extensions remain deliberately explicit rather than hidden
behind the successful simple-assignment surface:

1. compound, logical, and update writes (`+=`, `&&=`, `++`, and peers) still
   need to route through the persistent caller-state lookup; and
2. a nested closure that both captures an outer eval-state pool and owns its
   own direct eval needs an inner/outer two-pool chain. Capture-only nested
   arrows and function expressions already carry the single pool correctly.

Those are conformance follow-ups, not routing blockers for the runtime-eval
MVP. The interpreter remains the default and remains a permanent selectable
engine.

## 2026-10-04 — PR6435 native guard residual implementation gate (Astra)

### Authority, immutable evidence and limits

Docs-only proposal in `codex/4016-split-residual-plan`, base
`fdb116928b5861fd628abfde95da5e3deb91f689`. Only this appendix is new.
The entire preceding 1698-line MD was read and is preserved, SHA256
`874f9194b5de9b3ea0f49931a91e79a0083d9e8b0abda596cf2ca50637423fc5`.
The completed MD4016 audit and separate Script P2 appendix remain frozen.
No source, fixture, runtime, build, provider, claim, dependency, publication
or GitHub-state action was taken. This is not source GO or an issue closure.

The evidence was found through the COMPLETE external branch handoff
`6810-executable-native-eval-ci-contract.md` in the donor's `plan/issues`
directory, not present on current main; see the immutable
[donor commit](https://github.com/loopdive/js2/commit/16120f29f62e5748f8d9fec795695fca302a4a8a)
and read-only `/Users/thomas/.codex/worktrees/es6-native-eval-ci/js2`, head
`16120f29f62e5748f8d9fec795695fca302a4a8a`. Its historical production
baseline is `1f1b0ad61cbc74d0bde3a326e8b7e2e02b7add99`, NOT current main.
The durable directory `/private/tmp/js2-6810-native-provider.xz1tZR/` exists:

- `guards.json`: `9554c0a86f8ebb2afb00f54d9082be93a395a1f2c058f83200f64e118d954751`.
- `guards.log`: `c85a31c1547515f162a18190540f344b6af587378762121e31aa47fc4d584787`.
- `provider-build.log`: `962ece7ec56825737f6c0fc259e8dcb1693988dd7bfd479608bf2f8bd7864f37`.

All three hashes match the handoff. All 67 actual assertion rows and full log
were read: 67 unique names, 60 PASS, 7 FAIL, zero pending/skipped, six files.
The worker explicitly announces INTERPRETER, key `f672c24b5ff46645`, full
selection enabled; the builder reports 6,243,897 bytes and canary success.
Recorded provider SHA is
`5871f19b95b2a791dfa738bc3746ab9f936198374a146bf9363e5ea19070d40b`;
compiler/runtime bundle SHAs are
`35f6f894fe9551d33d5b0cf364cf7d350dc7ec1394622e20632b39abcb3a297e` /
`3aaf2742cdd255fb48f3dbff83ff8abcee5f520b7fceabf0bb6e8f1e314534e6`.
The build log also records building REFUSAL separately: that is NOT the
provider selected for these semantic rows. Historical Node was24.19.0,
pnpm10.30.2; corpus was `b363f29d3c43c626dc852744ad64a0b48a003693`.

The six fixture files are byte-identical between historical1f1b and this
planner's fdb, and between1f1b and the PR6435 head. Their SHA256 pins:

- `tests/issue-1102.test.ts` (31/31):
  `9cc1a9e31d4e9e9502e10a1207b744a13431563e5b55774728de3f4124758520`.
- `tests/issue-2928-refusal-provider.test.ts` (3/3):
  `8c997ca4109a5bdece07aae7b5b725a9aaa3391a79224c9a596a48d963315d51`.
- `tests/issue-2929-cd-global-materialization.test.ts` (5/12):
  `face0c7c4c693deff397060df0efade7284097e0644227855cc98fe1079ee6f6`.
- `tests/issue-2960.test.ts` (13/13):
  `f657a77fb39dcc684c2a5132b3aae405b226351f52505711e45e39801b8a2516`.
- `tests/issue-4197-consumer-mode-decl-getter.test.ts` (4/4):
  `b6cd9306189f38c4598eb5d097b062950407f9465080760dc062227c4c9ca4e6`.
- `tests/issue-4242-no-removal.test.ts` (4/4):
  `998531aad895248efb17849c3248c7f300f5e47d6c2bfbd09f060524e149d0f5`.

Historical total is executable native evidence, not a current score or an
original Test262 gain. The eight CI-contract tests are a different population.
The twelve-case MD2929 fixture was read completely, including its tier selector,
all original bodies and expectations. Its `selectInterpreterTier` explicitly
overrides engine selection for the lookup; the actual worker announcement also
proves native selection. QuickJS/P1/P2 repairs cannot substitute for this run.

### Seven row identities, not seven invented root causes

All seven failures occur in the pinned MD2929 fixture. First six report only
`fail: undefined`; JSON retains the outer Vitest assertion, NOT the full inner
CompilerPool result, exception payload, call trace, compiled source or Wasm.
The retained directory contains only the three receipts above. Consequently
the exact first failing instruction of these six is UNKNOWN, not attributed.

1. `cd/direct-var-new`, source lines84–93: `eval('var cdVarNew;')`, then own
   descriptor, undefined initial value and W/E/C=true. Distinguish declaration
   creation from descriptor lookup/primitive decoding; either can stop this row.
2. `cd/direct-func-new`, lines96–107: `initial = f` BEFORE function declaration,
   then caller `typeof`, call returning33, own `f` and configurable=true.
   Distinguish hoisting from stable callable exposure, pull-back into `initial`,
   invocation and descriptor observation. A failure before the call proves
   nothing about invocation; a successful call proves nothing about descriptor.
3. `cd/indirect-var-new`, lines110–119: indirect `var cdIndirect = 7`, then own
   descriptor value7/configurable=true. Separate creation, initializer store,
   shared-value export and caller descriptor value decoding. It has no caller
   activation binding and must not be repaired by giving indirect eval one.
4. `cd/existing`, lines125–135: script var23 preserved in `before`, eval changes
   it to45, caller reads45, descriptor remains non-configurable. Separate initial
   script publication, provider write and AOT pull synchronization. Making all
   globals configurable or recreating a fresh global object would violate it.
5. `cd/annexb-existing-primitive-call`, lines146–159: TWO sequential subcases,
   numeric `direct`/`indirect` become functions returning41/42. Preserve both.
   Separate conditional AnnexB assignment, marker publication, mutable-global
   type admission and ordinary callable dispatch. First subcase may mask second.
6. `cd/delete-severs`, lines165–177: eval var5, caller reads5, member delete must
   succeed, later bare read must throw caller-observable ReferenceError. Separate
   initial publication from delete status, missing-name lookup and error identity.
   This is a GLOBAL property deletion, not the historical local-pool tombstone
   bug already repaired earlier in this MD.
7. `gap/nan-not-own`, lines236–241: explicit Error states NaN IS now an own
   property. This proves the negative gap assertion fired, not that all NaN
   descriptor semantics work. It is an obsolete contract, not a missing-NaN bug.

ES2015 [18.1.2 NaN](https://262.ecma-international.org/6.0/#sec-value-properties-of-the-global-object-nan)
requires its global value with W/E/C=false. A separately approved fixture repair
must assert the own descriptor, numeric NaN, all three false flags, failed delete
and refused incompatible replacement, not skip/remove this row or manufacture
absence. Keep the original frozen67 receipt; report the revised contract as a
separate revision, not seven unchanged expectations suddenly passing.

Also read the official ES2015
[CanDeclareGlobalFunction](https://262.ecma-international.org/6.0/#sec-candeclareglobalfunction)
and [CreateGlobalFunctionBinding](https://262.ecma-international.org/6.0/#sec-createglobalfunctionbinding)
algorithms: an existing non-configurable data property is function-declarable
only when writable and enumerable; a compatible existing property retains its
attributes. These rules ground the refused NaN declaration and row4 controls,
not a license to reimplement the already-present native declaration preflight.

### Exact source path and falsifiable boundaries

Locations below are source reads at planner fdb; these are hypotheses to test
against actual emitted bodies, NOT proof every source path executes per row.
Compared with1f1b, the surveyed `src/interp/`, provider generator,
`runtime-eval-provider.ts` and `global-environment.ts` are unchanged; calls.ts
and eval-inline.ts have later changes. Do not transplant historical binary
indices or pair its provider with new compiler-bundle keys.

- `expressions/eval-inline.ts::tryStaticEvalInline`1150–1205 declines sloppy
  global var/function declarations to the provider; assignment-only remains a
  splice. `expressions/calls.ts`7893–7902 routes a direct call for which
  `directEvalRunsAtScriptGlobal` is true to `emitStandaloneIndirectEvalRuntime`.
  Therefore labels saying DIRECT do not prove the `__runtime_direct_eval` ABI
  was used. Record actual imports/callsite and assembled Script scope first.
- `eval-inline.ts::emitStandaloneIndirectEvalRuntime`2030–2078 publishes caller
  globals, evaluates/uses source, passes the same global object, calls
  `__runtime_indirect_eval`, then unwraps. Its source-cache/argument staging
  protocol is owned by PR6246/6774; no modification is proposed from these
  single-argument fixtures. Function-local paths use the direct provider ABI
  with live activation/lexical/outer cells (`runtime-eval-provider.ts`751–1050).
- `runtime-eval-provider.ts::emitRuntimeEvalGlobalBindingPushBody`313–541
  publishes script globals and stable AOT callable adapters; it must preserve
  script non-configurability and later user descriptor attributes. Pull body
  543–587 reads shared values, unwraps, adapts interpreted callbacks and writes
  the module global. Inspect actual physical global type before alleging that a
  numeric initializer forces a callable to remain numeric. No blanket widening.
- `scripts/runtime-eval-provider.mjs::PROVIDER_EXPORT_WRAPPER`249–408 creates
  `[ok, wrappedValue]`. Indirect success AND catch paths expose global lexicals
  and `exposeRuntimeEvalObject`; direct additionally exposes live cells and
  snapshots activation state. An exception inside exposure can replace the
  original completion. Distinguish this from an interpreter body exception.
- `interp/dynamic-function.ts::executeIndirectEval`263–287 ensures realm,
  parses, creates global EnvRec, prepares declarations, then enters emitted
  bytecode. `executeDirectEval`317+ is the separate created-local chain. Do NOT
  redirect this work to QuickJS or to `executeGlobalScript`293 merely because
  the outer fixture uses Script goal: its evaluated code is ordinary eval.
- `interp/eval-environment.ts::prepareGlobalDeclarations`778–830 validates
  before creation; `prepareGlobalVarBinding`764 creates missing own W/E/C=true
  undefined; `prepareGlobalFunctionBinding`749 prepares compatible descriptors.
  `emitter.ts::declareScriptGlobals`460–475 emits actual function closures before
  statements without resetting predeclared vars. Existing implementations must
  not be duplicated without proving their generated operation is the first loss.
- `interp/loop.ts::envAssign`850 writes the existing backing property;
  `envLookup`626 normalizes shared values. `exposeRuntimeEvalValue`503 memoizes
  interpreted function markers; `exposeRuntimeEvalSharedValue`520 normalizes
  before wrapping, and `exposeRuntimeEvalObject`540 rewrites enumerable values.
  The latter is a real candidate boundary for descriptor/abrupt-write effects,
  but the opaque errors do NOT establish it as the common cause.
- `runtime-eval-provider.ts::emitRuntimeEvalResultUnwrap`657–701 pulls globals
  BEFORE inspecting envelope success, reads slot1, decodes via
  `runtime-eval-boundary.ts::buildRuntimeEvalValueUnwrap`422+, reads/truth-tests
  slot0 and throws the decoded payload through caller tag on failure. Audit
  reserved/live helper indices and canonical vec/value brand on each side;
  distinguish real `[false, undefined]` from incorrect slot0/slot1 decoding,
  a pull-side exception, or renderer loss. No ABI/layout/global coercion change
  is justified until exact binary evidence identifies the failing contract.
- `calls-guards.ts::runtimeEvalMayReplaceCallee`91–100 ALREADY exempts mutable
  global var/lexical bindings from primitive-callee rejection. Do not add the
  same guard again for row5. `global-environment.ts::emitRuntimeEvalGlobalRead`
  555 delegates to HasProperty-guarded object read416; absence must throw, while
  `typeof` uses missingAsUndefined. Member-delete row6 must reach ordinary
  descriptor-sensitive delete on this SAME realm object, not a second store.
- `interp/loop.ts::installRuntimeEvalRealm`190–245 already installs NaN,
  Infinity and undefined as non-writable/non-enumerable/non-configurable data.
  Row7 needs a standards-positive test contract; deleting this producer is wrong.
- `scripts/test262-worker.mjs::extractWasmExceptionMessage`1761+ can inspect the
  actual exception tag/native renderer only with an instance; instantiate and
  deferred-init catches2450–2550 differ. `runScript`60–75 then retains only the
  returned status/error string in its failed assertion. `undefined` alone does
  not identify the exception type, origin, stage or whether globals changed.

R2-A named capturing apply is NOT yet a demonstrated mechanism for these rows:
their checked functions are interpreter-minted, and row7 uses a built-in borrowed
hasOwnProperty.call, not a capturing named declaration with hidden value/TDZ
parameters. Reuse the already reviewed MD6835 R2-A contract only if WAT proves
that exact physical capture-signature/argument mismatch. Do not duplicate its
held closure-dispatcher work or infer it from an incidental `.call` spelling.

### Smallest executable Sol6.1 High tasks, with explicit STOP gates

N0 — evidence-only baseline and per-row first-loss receipt. Proposed leaf
`2929:native-guard-seven-attribution`, not claimed here. In a NEW own worktree
at root-verified source, under a separately granted heavy lease, build the
ordinary current compiler/runtime and full NATIVE provider with standard
canaries. Verify Node24, actual engine, zero provider imports, originalHarness,
noStrict/inferModuleStrictArguments=false and maintained oracle14; pin every
effective source and binary. Never select QuickJS or refusal to get green.
Run all six unchanged files once; require67 unique rows, no skip/timeout/missing
row. Compare by full identity to historical receipt; current differences are
measured differences, not attributed regression from a docs/workflow patch.

For each of the six opaque failures retain the full CompilerPool response,
assembled unmodified source, consumer/provider binaries, normal WAT, imports,
exports, terminal result, actual tag match and existing native-renderer result.
The six expected-pass identities stay unchanged; keep row7 as historical red.
Use actual provider-entry/call/envelope/read/write/export bodies to distinguish:
not reached; provider throws; exposure throws; pull throws; unwrap misreads;
post-return assertion/descriptor/call/delete fails. If an unmodified run cannot
locate a stage, STOP with that gap and request a bounded supplemental diagnostic
manifest before adding checkpoints. Never replace the original oracle result
with a smaller rewritten probe or claim all six share a first loss.

N1 — native result/publication repair, only AFTER N0 identifies a shared loss.
Proposed leaf `2929:native-eval-result-publication`. Choose exactly ONE proven
producer/consumer hunk pair from the inventory above: native wrapper exposure
and its actual reader, or consumer pull/unwrap and its actual value producer.
Root reviews exact bodies/owners before source GO. Preserve success/throw flag,
undefined versus null, reference/closure identity, normal AND abrupt write-back,
canonical brands, live helper indices after late imports and existing rec-group
ABI. No error swallowing, fallback-null result, second global object, host shim,
global dirty flag or generic conversion rewrite. Include matched controls for
success undefined/null/false/0/string/object/callable; thrown undefined/null/Error;
and write-before-throw followed by another eval. These are supplemental controls,
not substitutions for the fixed67. If only one row moves, report one, not six.

N2 — remaining semantic repairs, independently gated per first loss after N1.
Only request the concrete hunk that failed: missing-var descriptor creation;
function prologue/store before statements; existing-global push/pull descriptor
preservation; AnnexB conditional assignment plus stable callable exposure; or
ordinary member delete plus missing-name read/error identity. Each has its own
row1–6 acceptance above and must preserve all currently passing controls. A
descriptor-reader defect is not permission to change EDI; a successful provider
function store plus failed consumer call is not permission to change hoisting.
Group rows only after binary proof and removal attribution, never by error text.

N3 — separate standards-positive fixture repair for row7. Proposed leaf
`2929:native-global-nan-contract`, requiring explicit fixture-owner grant. Keep
one replacement registered test with own NaN data descriptor W/E/C=false and
numeric NaN, failed sloppy delete and refused incompatible redefine; add direct
and indirect `function NaN(){}` rejection plus non-conflicting declaration
controls separately. Check throw identity and no partially created properties.
Do not call the expected historical fail→new-pass a compiler gain. If positive
assertions reveal a runtime defect, STOP and obtain its own narrow source plan.

N0 and N3 preparation are logically independent; no multiple heavy jobs.
N1/N2 are contingent implementation gates, not speculative repair authorizations.
Finish the finite selected task and report its first complete matched matrix;
do not chase additional files/functions automatically when a new failure appears.

### Ownership questions and acceptance

This docs delegation creates NO execution claim. No fresh GitHub/claim polling
was performed. Retained P1/P2 coordination positively holds4308 EDI,4245 membrane,
4647 receiver,4540 heap/allocator,4542 lifetime and4544 native emission; prior
R2-A evidence positively holds4637 callable-prototype/call/apply. Historical
`done` headers do not release any of these protocols. Current patch absence or
exact hunk clearance has NOT been newly established for this task.

Concrete requests before N1/N2: who owns native-only `exposeRuntimeEvalObject`
and wrapper result transport, distinct from4245 QuickJS membrane? May the exact
caller push/pull/unwrap hunk be edited while preserving4307 callable identity
and4308 declaration contracts? If row2/5 reaches callback application, obtain
4647/4637 clearance for that exact producer/reader pair; shared receiver save/
restore changes are not granted by the existing R2-A private-caller proposal.
For row6, identify ordinary delete/global-read owner before editing MOP. Keep
PR6246 argument staging and6774 spread routing untouched. Separate-machine IR
clearance does not release these claims or authorize interpreter/IR refactors.

Acceptance is all six substantive original guards corrected, all60 historical
PASS identities retained, and a separately approved stronger NaN contract green
with full denominator/accounting. Require per-row matched baseline/candidate and
removal arm on the ACTUAL repaired source with matching fresh provider/bundles;
no instrument changes between arms. Execute ordinary scoped/static/publication
gates under the implementer's authority without allowance increases or disabled
checks. Whole67 must be re-run on the final integrated source; local success
does not certify PR6435's published head. Preserve full native no-removal and
refusal controls, caller identity/error behavior, and zero-import capability.

No Test262 original is newly measured here. Neither67 diagnostic guards nor
8 workflow-contract tests count as gain against the frozen11,778 originals.
PR6435 remains unfinished until actual native semantic verification and normal
owner-led integration/publication are complete. Root must read this FULL appendix
before any Sol dispatch or expansion of its proposed exact source scope.

## Native guard follow-up: ownership and non-instrumented N0 collection

Docs-only adjudication, 2026-10-04. This supplements, and does not replace,
the preceding accepted 286-line plan. No source, fixture, worker, provider,
claim, dependency, or runtime change was made. Historical 67/60/7 remains
historical evidence; no new execution or gain is asserted. The future N0 job
still requires root dispatch and the heavy lease. N1/N2/N3 remain ungranted.

### Bounded current ownership evidence

One bounded snapshot read both books used by `scripts/claim-issue.mjs`
421–476: upstream and legacy, with upstream taking precedence for identical
record filenames. Absence in the upstream book alone is not release. Both
configured legacy remote names resolve to `ttraenkler/js2`; it was read once.
The pinned assignment commits were:

- `loopdive/js2`: `8ed0193fc5f3ba25f5c7bd9e7cd2c60871b0981f`.
- `ttraenkler/js2`: `3d6bc324711e54f4b4d41f71910ee228cc8ed6ac`.

The bounded root-tree filter covered records/slices for 2929, 4245, 4307,
4308, 4637, and 4647. Upstream supplied 2929/4637/4647; legacy supplied
4245/4307/4308. No matching slice record supplied a narrower release.
The actual records, not their age or issue-title status, establish:

- 4245: `in-progress`, `ttraenkler/opus-membrane`, branch
  `issue-4245-membrane-slice1`, write `3673-cuhch2hj`, claimed/updated
  `2026-08-09T18:35:41Z`.
- 4307: `in-progress`, `ttraenkler/opus-senior`, branch
  `issue-4307-closure-carrier-wrap`, write `2644-9ek9n79y`, claimed/updated
  `2026-08-09T19:45:42Z`.
- 4308: `in-progress`, `ttraenkler/senior-dev`, branch
  `issue-4308-slice-a-error-identity`, write `30953-9t03z4oe`, claimed/updated
  `2026-08-09T20:22:54Z`.
- 4637: `in-progress`, `ttraenkler/claude-es5-standalone`, branch
  `issue-4637`, write `21722-b4gyvn3s`, claimed/updated
  `2026-08-23T07:27:17Z`.
- 4647: `in-progress`, `ttraenkler/dev-4647`, branch
  `claude/es5-standalone-pass-rate-6tk9rb`, write `20393-us8ek9sm`,
  claimed/updated `2026-08-23T12:54:38Z`.
- 2929: `reserved`, empty assignee and branch, no write ID; reserved/updated
  `2026-07-01T23:30:25Z`. This identifies neither an active fixture author
  nor permission for this planner to claim or change its fixtures.

This snapshot does not re-adjudicate 4540/4542/4544, inspect new PR patches,
or confer whole-file clearance. Their previously recorded holds stand.

### Exact native scope versus shared protocol

MD4245 lines 75–85 explicitly leave the interpreter provider and all its
`src/interp/`, IR/codegen substrate, and acorn dependencies UNTOUCHED. Its
membrane implementation concerns QuickJS inward/outward wrappers and the
pinned native shim. Therefore `src/interp/loop.ts:540`
`exposeRuntimeEvalObject`, and the native interpreter wrapper string
`scripts/runtime-eval-provider.mjs:248` `PROVIDER_EXPORT_WRAPPER`, are not
4245 implementation hunks. This is a genuine recorded scope distinction,
not a grant to edit them. MD4245's frozen envelope, carrier, push/pull and
borrow/identity protocols remain constraints on any native implementation.
Do not route a native exposure failure into QuickJS membrane changes.

MD4307 lines 75–111 positively own caller callable wrapping, its inverse
`src/codegen/runtime-eval-callable.ts:596`
`emitRuntimeEvalCarrierUnwrapAny`, identity memo/finalize repair, the two
push/direct-cell crossing sites in
`src/codegen/expressions/runtime-eval-provider.ts`, and three closure-call
cast guards. This is a positive exact inverse-helper hold, not merely an
adjacent-file warning. `emitRuntimeEvalGlobalBindingPullBody` at line 543
and `emitRuntimeEvalResultUnwrap` at line 657 are distinct bodies from the
listed push/direct-cell producers; nevertheless their carrier decoding and
identity agreement cannot be altered under an inferred whole-file release.

MD4308 lines 1553–1589 positively describe `qjsWriteBackCallerCells`,
`qjsMirrorNewBindings`, global restoration/routing, and the specific
codegen activation-seed sentinel produced using
`directEvalCallerIsFunctionScoped`. They do not establish ownership of
every pull or result-unwrapping instruction. They do establish a held
global-versus-activation, declaration, error-identity and cell-marker
contract. Preserve it, including the frozen direct-entry ABI, while
investigating the native-only lane.

The current reader order is concrete: `emitRuntimeEvalResultUnwrap`
657–701 stores the envelope, calls global pull, marks provider inactive,
decodes field 1 into a caller-local representation, then branches on field
0 and returns or throws through the caller tag. Thus a pull failure may
precede observation of the provider completion. Neither `undefined` text
nor a failed fixture alone proves which stage failed. Do not reorder this
sequence, remove wrapping, or edit shared inverse helpers as a diagnostic.

Required subsequent owner decision is exact: after N0 proves a first loss,
grant the named native exposure/wrapper body if native-only, or obtain the
4307/4308 carve-out for the named caller pull/decoder body and preserved
carrier/declaration protocol. Callback application additionally intersects
4647 and possibly 4637, as previously recorded. No such edit is authorized
now. N3 requires a separate explicit fixture grant for
`tests/issue-2929-cd-global-materialization.test.ts`; reserved umbrella
2929 is not that grant. Do not change seven historical row identities.

### N0 job: maintained collection without core-worker changes

Run the unchanged full six-file 67-test guard set identified above, against
a freshly matched current native INTERPRETER artifact, in the future
approved lease. Keep the explicit interpreter keystore override, full
provider, Node/oracle provenance, source/flag/bundle/provider hashes and
all original expectations. No QuickJS/P1 substitution, stub8 replacement,
old-provider/new-key pairing, or stronger NaN fixture change in this arm.
Record all 67 statuses, including the unchanged obsolete NaN assertion;
compare identity-by-identity with the historical receipt, not just totals.

For detailed artifacts, an own-temporary sidecar collector can use the
maintained `CompilerPool.runTest` API (`scripts/compiler-pool.ts:217–294`)
on the exact original `runScript` bodies from that fixture. Freeze its
finite observation manifest for root review before execution: all 11
existing script bodies, plus the existing provider-tier assertion retained
by the full fixture run. Preserve byte-for-byte bodies, original harness
assembly/metadata, labels, strictness, timeout and all evaluation options;
add only distinct `wasmPath` and `metaPath` destinations. Do not rewrite
the fixture's source to add exports, counters, catches or sentinel returns.
Do not reinterpret this artifact pass as extra test identities or gain.

Persist each complete maintained pool response before fixture-level status
conversion, including status/error/ret, exception/instantiation flags,
imports, reachedTest, timings, and any other returned fields. Preserve
absence versus a serialized value; a string `undefined` is not a payload
classification. `runTest` forwards artifact paths explicitly. No worker
patch, option bypass, custom import replacement or trace hook is needed.

The worker saves successful binaries and metadata before execution at
`scripts/test262-worker.mjs:2348–2365`, including string pool, imports,
source map and bundle hash. Its save catch is silent, and compile-error
paths can write a zero-byte binary. Therefore independently require files
to exist, nonzero Wasm, parseable success metadata, matching bundle/source
provenance, and SHA-256 receipts. Artifact absence is instrumentation
incomplete, not a semantic result. Do not rely on `compile()` returning a
binary: the maintained compile-only worker result is status `compiled`.

Inspect imports/exports from the exact retained binary without executing
it; disassemble that same binary with an already available pinned local
tool, recording tool identity and WAT hash. If unavailable, report missing
WAT rather than installing a tool or recompiling a different variant.
Use source map and concrete function/call/field sequence to separate
wrapper publication, caller pull, result decoding, callback and MOP paths.
WAT alone proves generated instructions, not which dynamic branch ran.

### Explicit observation limit and stop condition

The pool returns serialized execution results, not live exception objects
or instances. Its existing renderer already calls `tryNativeExnRender`
(`scripts/test262-worker.mjs:1761` onward). The maintained shared renderer
is `scripts/lib/wasm-exn-render.mjs`: `tryNativeExnRender` line 68,
`exceptionPayload` line 92, `renderHarnessThrownText` line 120. Preserve
this policy; do not replace it with JavaScript stringification and call the
result an equivalent rendered exception.

`instantiateRuntimeEvalNamespace` at
`scripts/runtime-eval-provider.mjs:832–857` returns only the five runtime
entry functions for native providers, not the underlying instance, tag or
renderer exports. A start-time failure may also occur before the consumer
instance is available. Consequently the unchanged pool/artifact job cannot
promise a live provider payload/tag trace. The renderer helper's returned
`undefined` also conflates unavailable extraction with a genuine undefined
payload; a future authorized live observation must retain explicit tag
match success separately. No inference from that value is admissible now.

Stop N0 at the strongest supported first-loss evidence per row. If retained
raw results plus binary/WAT cannot distinguish two candidate stages, name
both and request a finite separate observation grant. Do not wrap provider
imports, expose private tags, alter start/deferred-init, edit the renderer,
or instrument the core worker under N0. A later approved replay must use
the maintained import-object/instantiation path and matched provider; it
is not silently included in this non-instrumented collection authority.

Deliver all rows and provenance, artifact completeness, exact producer/
consumer evidence, unresolved alternatives, and the smallest owner-scoped
next question. Six identical historical failure strings remain six
unattributed failures until this evidence separates or unifies them. This
addendum supplies no source GO, fixture GO, publication readiness, or
Test262-original gain. Root must read the entire addition before dispatch.

## N0 dispatch packet: frozen eleven bodies and ordinary native preparation

2026-10-04, docs only. No build, provider selection, test, replay, network
read, or source edit was performed for this packet. The preceding 2161 lines
remain unchanged. This specifies the future owner-dispatched diagnosis;
it does not start that job or confer a heavy lease.

### Finite source manifest

Read the complete 243-line fixture
`tests/issue-2929-cd-global-materialization.test.ts`, SHA256
`face0c7c4c693deff397060df0efade7284097e0644227855cc98fe1079ee6f6`.
Its eleven `await runScript` template literals contain neither interpolation
nor escape sequences. A read-only extraction verified exactly eleven bodies.
Body hashes below include their original terminating newline, not the template
delimiters. Wrapped hashes use EXACTLY the fixture's source construction:
`/*---\ndescription: ${label}\nflags: [noStrict]\n---*/\n${body}`.
These are input hashes, not compiled-result or harness-assembly hashes.
No current result is predicted. Historical statuses are only locator evidence.

1. `cd/direct-var-new`, body starts line 85, 359 UTF-8 bytes; historical FAIL.
   Body `e300df81f3bfa04f53419eadab75b526d3b1a94431a55b07b7944b192da58996`;
   wrapped `e54bf56968227a6689732fbfa2cd30de1cf535d5cf19e7cd898b948dd8d7d374`.
2. `cd/direct-func-new`, line 97, 458 bytes; historical FAIL.
   Body `e849ac2d43af94ff2758803277ed8e813fc2b3b3484de6941cc9a41979a4a981`;
   wrapped `3cda8ca82392fb49a499dd2ab018e6e41e2df97cd981f76f8369ef56be023767`.
3. `cd/indirect-var-new`, line 111, 309 bytes; historical FAIL.
   Body `ed6850a882050d4cfa2f513ff9b27a3e76c092ec9d6b11eaea21290f5f7ecc0a`;
   wrapped `b61ff6a35463c9abe11587854ad891eb0b3d10fe7616f851c0b41b3df0d1f166`.
4. `cd/existing`, line 126, 494 bytes; historical FAIL.
   Body `5d0b371785df21d50a2bcbfd07a774c8125370eaa45ba3d883c1e9eb5e5358bb`;
   wrapped `3e13d192b5e711656643dcbaafceab15f674419c79fa48e306d7efc754541130`.
5. `cd/annexb-existing-primitive-call`, line 147, 471 bytes; historical FAIL.
   Body `73c13b33c5ea6bc116bf2e3b8c84dab364ecf52e830a91c14df4f2c48d996941`;
   wrapped `6d3d7b44340512f1a4ba6c87236f1c6180d10d2f7de7ae3e93b4c7cf278a06b8`.
6. `cd/delete-severs`, line 166, 388 bytes; historical FAIL.
   Body `c95f1f3bc313d412201063fe0ad9871b11892d82ed80a27558340be8fa0318ab`;
   wrapped `38073079921b542080333066b828c28e7b1edb0c190fc5f267fa422434fa6bbd`.
7. `cd/assign-only`, line 181, 145 bytes; historical PASS.
   Body `1a2bc488988ce69a4732cc006a13c819c92ca8107d76d14ff1fa79277eef6472`;
   wrapped `e215d762b64a7053d83b04980949288153ad24541ed27448fd16ab7d761d5be3`.
8. `d/direct-var`, line 193, 411 bytes; historical PASS.
   Body `fbf76a053b43880e97215a8d31fa1602dcb517601deb5c7a4d16a00256a39033`;
   wrapped `5b5c540e505c110f7d2a693a01b961ba098e6cdfa8681f9b3e614b6198822603`.
9. `d/indirect-var`, line 206, 202 bytes; historical PASS.
   Body `1e1dfbda640f47b0a2dd89325f5de0f368eb1a268db179e6f37ef373009c9416`;
   wrapped `5e060ded154664fabcdc4c13ac1d89ee0de68b4adb1fb1efd16873bbff5f3cea`.
10. `d/indirect-func`, line 217, 212 bytes; historical PASS.
    Body `7604e5d0b1e14433dcbabfcbb7f3a236f528efe7fd1c940fa7e580210770d89a`;
    wrapped `c32e70fee07a1b479b8fbd3208dedcb8e886cbc1886b1820e08270e07ade04d0`.
11. `gap/nan-not-own`, line 237, 180 bytes; historical FAIL, obsolete negative
    assertion deliberately unchanged in N0.
    Body `af82dfb4501ffb72d2d478e41ed6fb7a71602dfab0b297cab67233f27c1dbc30`;
    wrapped `c223e744c1fa2da777bc4472c5d4887e21715616e7b524346d50c1b9b60e1d28`.

The twelfth fixture assertion is the INTERPRETER tier announcement, not a
script body. Keep it in the ordinary twelve-test fixture execution. Do not
turn eleven artifact invocations into twelve, or count them again in the 67.
The five historical PASS assertions in this fixture comprise four passing
bodies plus the tier assertion. The other five unchanged guard files supply
55 more; the complete historical PASS denominator remains 60.

### Exact future preparation and execution order

1. Root assigns Sol6.1 High an own execution worktree and reviewed current
   source revision, then separately grants the heavy lease. Pin that actual
   revision plus complete dirty-source diff if any; do not label the planner's
   fdb or historical 1f1b as current. This job changes no production source or
   fixture and needs no semantic claim takeover. Verify all six fixture pins,
   the corpus pin and actual harness bytes before work; STOP on a mismatch.
   Use existing approved dependencies and Node 24/pnpm provenance. No package
   install, submodule reset, cache purge, provider fallback, or configuration
   repair is part of this dispatch. Missing prerequisites are a root question.
2. Under the lease, prepare current compiler and runtime bundles with the
   ordinary CI commands below, followed by the ordinary full native builder.
   The source for this sequence is PR6435's `ci.yml:593–610` and
   `scripts/build-runtime-eval-provider.mjs`, not a private alternate compiler.
   Set `NODE_OPTIONS=--max-old-space-size=3072` for the bounded preparation.

   ```sh
   pnpm run build:compiler-bundle
   pnpm exec esbuild scripts/runtime-bundle-entry.ts --bundle --platform=node --format=esm --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
   node scripts/build-runtime-eval-provider.mjs
   ```

   Do not use `--refusal-only`. The normal builder prepares refusal separately
   and builds or reuses full native source/options/bundle-keyed bytes. A cache
   hit is acceptable only for the computed current key; record hit versus
   build honestly. The maintained `--require-full-cache` verification may
   confirm the matching full entry and its canaries after preparation, not
   substitute old bytes under a new key. Verify zero imports and five builder
   canaries (3, 3, 84, 3, 30) plus all five namespace entry functions. Record
   actual source key, compiler key, paths, hashes, bytes, terminal/log and
   selector announcement with `JS2WASM_EVAL_ENGINE=interpreter` and
   `TEST262_FULL_RUNTIME_EVAL=1`. Missing full selection is STOP, not REFUSAL
   semantic scoring. Do not point the QuickJS selector at native P1 artifacts.
3. Run the ordinary fixed six-file guard set serially, with the same two
   native-selection environment values and 3 GiB worker limit. The following
   command is a future instruction, not an executed or successful receipt:

   ```sh
   pnpm exec vitest run tests/issue-1102.test.ts tests/issue-2928-refusal-provider.test.ts tests/issue-2929-cd-global-materialization.test.ts tests/issue-2960.test.ts tests/issue-4197-consumer-mode-decl-getter.test.ts tests/issue-4242-no-removal.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=.tmp/2929-n0/guards.json
   ```

   The implementer creates a fresh own output directory without deleting any
   prior result and retains separate stdout/stderr/terminal receipts. Check
   67 unique complete assertion identities against the historical raw JSON,
   six files, zero pending/skips, and actual worker INTERPRETER announcement.
   Nonzero exit with complete semantic FAIL rows is not an instrument failure;
   OOM, signal, missing rows/provider/bundle or incomplete JSON is. Preserve
   actual results even if they differ from 60/7. Do not require historical
   totals as an oracle or rewrite the NaN assertion to make this run green.
4. Sequentially collect the eleven artifact observations in a temporary
   sidecar using `CompilerPool(1, "unified")`, `await pool.ready()`, and the
   exact fixture `assembleOriginalHarness(source, parseMeta(source))`. Retain
   wrapped and assembled source separately and hash actual assembly bytes.
   Keep `originalHarness:true`, `asyncTest:assembly.async`,
   `inferModuleStrictArguments:false`, `target:"standalone"`, original label,
   30,000 ms timeout. Do NOT add `scriptGoal`, native/linked harness, semantic
   provider, deferred-init, export wrapper or compile-only options absent from
   the fixture. The only run options added are unique wasm/meta destinations.
   Persist the entire pool response and finally shut down the pool. Each run
   continues to use maintained import-object/provider instantiation semantics;
   never reuse a single mutated realm across separate bodies.
5. Validate artifacts and inspect exact binary/WAT/imports/exports under the
   accepted non-instrumented limits above. Match each artifact run's status to
   its ordinary fixture row; divergence is a collection-equivalence problem,
   not evidence that a compiler fix occurred. Preserve the four historical
   passing bodies as positive controls for assignment routing and refusal.
   Finish with source/fixture/provider/bundle before/after invariants, all
   hashes and the finite per-row first-loss/unresolved-alternatives handoff.
   No source repair follows automatically; root reviews before N1/N2/N3.

The smallest native-only *candidate inspection area* is
`src/interp/loop.ts::exposeRuntimeEvalObject` and its native wrapper callers:
it is outside MD4245's explicit implementation scope and needs no QuickJS
shim edit to inspect. That is not a proven cause, an unconditionally unheld
execution leaf, or permission to patch. The first loss could instead be
caller pull before envelope decode. Exact owner clearance follows evidence,
not a desire to choose the cheapest apparent repair.

### Passive owned-PR next action from retained local receipts

No new remote state or logs were read. The prior six-PR audit is a dated
snapshot, not present-day readiness. A concrete already owner-scoped next
step exists for PR6246: its retained shepherd MD5157 lines 1700–1771 and
`.tmp/6246-refactor-cheap-terminal.json` prove all nine static checks passed
after the approved dependency repair, including SCC697, IR edges295 and
flat829. Receipt SHA256 is
`f65234286b2f16b00d0cd71dc15576cfb83d8963f1553d998dd3b1a1293c69ce`.
Thus another SCC exemption or source refactor is not the next action.

The assigned shepherd's next finite step, after root grants a lease, is its
already frozen matched preservation run: unchanged 15 controls and seven
canonical originals, baseline at
`/Users/thomas/.codex/worktrees/pr-6246-matched-baseline/js2`, candidate at
`/Users/thomas/.codex/worktrees/pr-6246-shepherd/js2`, manifest
`.tmp/6246-preservation-manifest.json` SHA256
`f3b62074a6fe06fe5e59cf5c9dd9ccf08505c4f7dc413b071cd3c8cc1835cfd5`.
Use its retained pre-refactor M1 baseline, not an invented clean-main
equivalence arm. Seven originals are seven identities, not thirteen strict
variants; four are frozen ES2015 spread targets and three preservation cases.
This packet does not dispatch that run or replace its own preflight.

M2 direct-spread/#6774 and strict-iterator scope remain held. Static success
and M1 preservation cannot certify M2 or complete PR6246. The old published
CLAUDE path failure is not a reason to edit unrelated docs in this planner:
current retained local document validation already passed. PR6206's four
retained reds need the separate four-source diagnosis; 6809 remains held;
5883's hold/conflict is not a takeover invitation; PR6435 awaits N0 and the
separate semantic/fixture grants. Map's assigned work must not be duplicated.
Await root's new P1 URL before the separately requested one-shot publication
audit. No watch, poll, source mutation or readiness transition is scheduled.

## Docs-only checkpoint publication manifest

Prepared 2026-10-04 after root's complete read of the N0 dispatch packet.
This section plans publication; no worktree staging, publication commit/hook,
branch push, PR creation or runtime action has occurred. Root's queue is Map's short
diagnosis, PR6246's frozen matched preservation, then native N0. This document
does not reorder that queue or reserve a concurrent lease.

### Exact two-file scope and ownership

One coherent docs checkpoint is appropriate: retained split/native diagnostic
plans and their owned-PR shepherd handoffs share evidence/ownership boundaries.
No separate PR per appendix is needed. Repository policy at CLAUDE.md's
docs-only merge protocol requires using an existing open docs PR if present;
otherwise one new docs PR may contain both files. That current open-docs-PR
check remains a later authorized publication action, not a stale audit guess.
An existing foreign-owned docs branch is not permission to overwrite it: root
must coordinate append integration if that is the selected publication vehicle.

The only publication paths are:

- `plan/issues/4016-standalone-string-search-value-tostring-path.md`:
  preserve base lines 1–390; append lines 391–834 only, 444 insertions and
  zero deletions. Whole file SHA256 remains
  `4e32b97c7aecbebe6af9120a06bac7a5ac2221ed61d7945dcdd492798ca08114`.
  This includes the two split residual diagnostic plan and dated six-PR audit,
  not a claim that those PRs are now ready or their defects repaired.
- `plan/issues/2929-interpreter-direct-eval-with-proxy-mop.md`:
  preserve base lines 1–1698, SHA256
  `874f9194b5de9b3ea0f49931a91e79a0083d9e8b0abda596cf2ca50637423fc5`;
  publish append 1699 onward, including historical 67-row evidence, ownership
  adjudication, frozen eleven-body dispatch packet and this manifest. The
  accepted 2161-line prefix remains SHA256
  `e7f0891adbffd75d66e7716b63da50d6ae7f72255c9449a144cab63aeb5cd6a6`.
  The accepted N0 packet at 2162–2335 hashes to
  `468003f6786f3c0128e061269a764fdcfdaa346d59fbb16a1bb8304f1c00d03b`.

Normal maintained claim operations, explicitly authorized by root after the
docs-only plan, checked each new leaf unassigned and then returned verified
upstream success, exit 0, for actor `ttraenkler/join_residual_plan_astra`,
branch `codex/4016-split-residual-plan`:

- `2929:native-guard-plan-shepherd-docs` (claim session 38634).
- `4016:docs-audit-native-guard-plan` (claim session 41128).

These grant ONLY the two owned MD append/publication scopes. The maintained
check also positively retained `4016:pr-6206-shepherd` for
`ttraenkler/pr_shepherd_sol`; it was not reassigned. No umbrella, reserved2929,
runtime, fixture, source, or foreign claim was taken over. Earlier sections'
statements that their planning passes made no claims remain true for those
dated passes; these two later publication claims are expressly recorded here.

### Local base, frozen exclusions and deferred gates

Own worktree remains
`/Users/thomas/Code/js2/.codex-worktrees/4016-split-residual-plan`, HEAD
`fdb116928b5861fd628abfde95da5e3deb91f689`. Read-only local upstream/main is
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`; that is NOT a fresh server
verification. The local commit-to-commit comparison contains only the same
six npm benchmark/mirror files recorded in the prior audit. Neither publication
MD differs between those two commits. Any later server/source change requires
ordinary integration review before publication, not an automatic reset/rebase.

No P2 transfer, MD5157 edit, corpus/test/source change, evidence-cache commit,
status/frontmatter rewrite or epic closure belongs in this checkpoint. The
separate P2 MD's SHA remains
`ed02b2ed6563459ddd6e330565194c9f1608338b6e28c31f0ed4405abf6900c7`.
Retain local evidence rather than publishing private temporary artifacts.
Only the two explicit MD paths may be staged; verify exact staged names and
append-only diffs before any commit. Do not use broad staging. Whole-worktree
diff enumeration encountered an unrelated Acorn LFS clean-filter sandbox error;
it supplied no clean-tree proof. No LFS/config repair or cleanup was attempted.
Two-path scoped checks work and remain the publication boundary.

Root must read this complete manifest and grant a separate hooks/commit lease
before normal validation/publication. Do not bypass hooks, alter gate budgets,
or run competing compiler/provider jobs. Later record actual docs checks and
their terminal statuses; this packet claims only source readback/hash and
scoped diff-check, not CI success. Follow normal server head/base/queue and
existing-docs-PR checks once authorized; no polling watcher is created here.

### Proposed commit and repository PR template

Author configuration was read and is `Thomas Tränkler <git@thomas.traenkler.com>`;
verify again immediately before the eventual commit. Proposed subject:
`docs(plan): preserve split and native eval diagnostic handoffs`.
Body: record the frozen diagnostic inputs, exact held boundaries and finite
native observation workflow; explain that no compiler/fixture changes or new
conformance gains are included. Required trailers for this Astra-authored work:
`Co-authored-by: Codex <codex@openai.com>` and
`Model: Codex GPT-6 Astra High`.

Proposed PR description follows the actual `.github/PULL_REQUEST_TEMPLATE.md`
headings, with no automatic-closing keywords:

### Description (proposed PR body)

Preserve the reviewed diagnostic plans and dated owned-PR handoffs for
[issue4016](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4016-standalone-string-search-value-tostring-path)
and [issue2929](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2929-interpreter-direct-eval-with-proxy-mop).
This is an append-only, two-Markdown-file checkpoint. It records the unchanged
split residual evidence, historical full-native 60/67 result, current ownership
boundaries, and eleven pinned script bodies for a separately authorized future
diagnostic run. No source/tests/providers are changed; no new runtime result,
original Test262 gain, semantic completion or implementation permission is
claimed. Prior issue history and P2 planning remain untouched.

Validation: full append readback, exact prefix/hash preservation and scoped
diff-check. Add actual normal publication-gate receipts after they run; do not
substitute planned native execution for completed verification.

### CLA (proposed PR body)

Please read the [Contributor License Agreement](https://github.com/loopdive/js2/blob/main/CLA.md).

- [ ] I have read and agree to the CLA

The checkbox is intentionally unsigned in this preparation. Thomas/Codex
commit attribution is not a legal signature. Do not check it on the user's
behalf without the relevant authorization. No PR was opened by this manifest.

## 2026-10-04 21:23 UTC — one-shot P1 and docs-publication preflight

Root authorized this bounded server read after the preceding publication
manifest. The complete prior 2456-line MD is preserved, SHA256
`ca77c1fbf6053d9dcdb417c65afd11b75fe210a02576794191687a6443eec224`.
MD4016 and P2 remain unchanged. No build, test, hook, branch push, merge,
review reply, queue/readiness change, CLA acceptance or CI rerun occurred.
The autopilot skill supplied conflict/review/CI triage order only; its usual
watch/fix loop is excluded by the explicit one-shot, read-only delegation.

### Owned PR6476: exact head and current gate

[PR6476](https://github.com/loopdive/js2/pull/6476),
`feat(quickjs): add inactive Script declaration plan producer`, is OPEN and
non-draft at head `17fd13bcc798705f0cd364a5d83445d4686f1d80`, branch
`codex/5157-script-plan-producer-p1`. Base main is
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`. Server state is
MERGEABLE/BLOCKED, no labels, reviewDecision null, mergeQueueEntry null.
There are zero issue comments and zero review threads; both connections have
`hasNextPage:false`. No unresolved discussion or merge conflict was exposed
by this snapshot, but that is not approval or a future-state guarantee.

The head's complete check-rollup connection also has no next page. No
completed failure/cancellation/timed-out context was returned. The separate
required-check classification reports six actual workflow contexts:

- [quality](https://github.com/loopdive/js2/actions/runs/37235405114/job/111533384729):
  IN_PROGRESS, not passed; this is the observed pending required gate.
- [equivalence-gate](https://github.com/loopdive/js2/actions/runs/37235405114/job/111533897170): SUCCESS.
- [cla-check](https://github.com/loopdive/js2/actions/runs/37235404957/job/111533385270): SUCCESS.
- [cheap gate](https://github.com/loopdive/js2/actions/runs/37235405100/job/111533385452): SUCCESS.
- [merge shard reports](https://github.com/loopdive/js2/actions/runs/37235405100/job/111533407230): SUCCESS.
- [check for test262 regressions](https://github.com/loopdive/js2/actions/runs/37235405100/job/111533407212): SUCCESS.

Three additional same-name PR-stub contexts are SKIPPED; they do not add
verification. A duplicate legacy CLA status is SUCCESS with no job URL, not
a separate legal agreement supplied by this agent. All eight equivalence
shards, aggregate issue-tests, and the changed
`tests/issue-5157-script-plan-artifact.test.ts` job are SUCCESS.
[libquickjs native build](https://github.com/loopdive/js2/actions/runs/37235405096/job/111533384920)
and [non-required QuickJS lane](https://github.com/loopdive/js2/actions/runs/37235405096/job/111533653657)
are also SUCCESS. Those are job verdicts, not newly audited assertion counts.
Actual Test262 shard execution contexts in this PR rollup are SKIPPED; green
report/regression aggregation is not a fresh conformance sweep or goal gain.

Because there is no terminal red, there is no failing log to diagnose in this
pass. Do not rerun quality, infer its result, or push a speculative fix. This
snapshot does not certify readiness while quality is pending. Root received
the exact head and absence of queue entry; no watcher or follow-up poll was
started. Any later authorized audit must re-read the then-current head, not
treat this result as continuing state.

### Existing docs-PR discovery and main comparison

The open-PR connection returned all 18 entries, no next page. Titles were
not used to decide whether a PR is docs-only. Every entry has an actual
non-docs path, so this snapshot contains no existing docs-only PR:

- 6476: `scripts/build-quickjs-eval-provider.mjs`.
- 6468: `.github/workflows/benchmark-refresh.yml`.
- 6475, 6436, 5883, 6246, 6206, 5753, 5911, 5784:
  `scripts/compiler-boundaries.json` in each PR.
- 6435: `.github/workflows/ci.yml`.
- 6341: `src/backend/wasmgc/resources/native-promises.ts`.
- 6383: `src/codegen/binary-ops-in.ts`.
- 6288: `scripts/compiler-extension-boundaries.json`.
- 6234: `src/codegen/binary-ops-typed-dispatch.ts`.
- 6195: `src/runtime/instance-lifecycle-adapter.ts`.
- 5748: `scripts/audit-javascript-soundness-probe.ts`.
- 5942: `tests/issue-3518-independent-pipeline-spike.test.ts`.

First 100-file pages provided positive code witnesses except PR5883, whose
second page still contained only plan material; its third page supplied the
listed witness at unchanged head6f73c8ed. These are pagination reads, not
state polling. A positive code path suffices to exclude docs-only status;
this does NOT claim complete file inventories or renewed overlap clearance
for the large PRs. No foreign PR is adopted as a publication vehicle.

Fresh server main is `1787b1af4a2f010f51ca1f45fc68fa540bfa4673`, matching
the locally recorded ref. Server comparison from own HEADfdb reports
ahead2/behind0, total_commits2, merge-base
`fdb116928b5861fd628abfde95da5e3deb91f689`. Its exact six changed paths are:

- `benchmarks/results/npm-compat-history.json`.
- `benchmarks/results/npm-compat-perf.json`.
- `benchmarks/results/npm-compat.json`.
- `website/public/benchmarks/results/npm-compat-history.json`.
- `website/public/benchmarks/results/npm-compat-perf.json`.
- `website/public/benchmarks/results/npm-compat.json`.

Thus the reviewed two-MD checkpoint can use one new docs PR when root grants
normal publication/hooks authority and current integration is performed.
This preflight itself did not merge even the safe benchmark delta, run hooks,
stage files or open that PR. Preserve both docs leaf claims and all previous
append-only history. If another docs PR appears before actual publication,
coordinate the existing vehicle rather than using this dated absence forever.

## 2026-10-04 — isolated N0 native guard observation preparation (Sol)

Root grants evidence-only preparation in
`/Users/thomas/Code/js2/.codex-worktrees/2929-native-guard-n0-observation`,
branch `codex/2929-native-guard-n0-observation`, exact upstream production
base `1787b1af4a2f010f51ca1f45fc68fa540bfa4673`. Normal worktree creation
40717/e35172 exits0. No production source, fixture, renderer, worker, provider
or shared ABI edit is granted. Full accepted Astra plan/dispatch packet was
read directly in `4016-split-residual-plan` MD2929 lines1699–2335; that
unpublished appendix remains owned and preserved for a coordinated single
documentation vehicle, not replaced by this execution record or a second PR.

Exact maintained observation leaf2929:native-guard-n0-observation check40545/
8b71f8 exits0 positively UNASSIGNED; claim10641/11519f exits0 positively
verifies ttraenkler/script_plan_p1_sol on upstream issue-assignments. Reserved
umbrella2929 and held fixture/4307/4308/4245/4637/4647/4540/4542/4544
contracts remain unchanged; narrow observation ownership is not source release.
Full refreshed REST pagination32469/72a0a1 exits0 at
2026-10-04T21:20:25.136Z:18 open PRs/1439 unique paths, every count matches
actual detail.changed_files, no MD2929 path match. This is not clearance to
edit native protocol paths. Known unpublished Astra MD overlap is preserved.

All six frozen fixture hashes match the accepted packet, as do the three
historical6810 guard/build receipts. All six fixtures and all67 historical
actual assertion rows were read completely: historical60PASS/7FAIL at
production1f1b0ad61c, not a current score. The obsolete NaN negative assertion
is unchanged in this N0 arm. Eleven original runScript bodies plus the tier
assertion remain distinct from67 total identities; artifact observations do
not add tests or conformance credit. Current results are NOT_RUN.

Existing dependency links point only to canonical primary node_modules and
pinned corpus b363f29d3c43c626dc852744ad64a0b48a003693. No install, config
repair or config-writing provision script ran. The ordinary worktree's Acorn
LFS payload SHA2562a15807615450606f15c52535c67a70d779da265d6447d5cf4a7ce4245c41309
is preserved and will not be staged/reset. Heavy bundle/provider preparation,
all67 execution and eleven artifact observations await a reviewed frozen
collection contract and root's separate exclusive lease. No live exception
replay, provider import wrapping, hidden tag export or core-worker instrument
is included. If raw response plus exact Wasm/WAT cannot separate stages, STOP
with named alternatives and request a finite owner-scoped observation grant.

### Frozen N0 source contract and source-only assembly receipts

Own ignored collector `.tmp/2929-n0/collector.mts` initial132-line SHA256
285881a61fe8897a025091f15ad38563526c009e045c78271ae33d0ac7d72bfa
passed canonical syntax check and root full read. Approved STATIC --freeze
274c72 exits0, no compiler/provider/pool imports, producing
`.tmp/2929-n0/frozen-contract-v1/contract.json`, SHA256
3e497933bbeffffd6123cefcc4348d0b38d60b81f8e51d48f74ea53e030f6a42.
It freezes all67 historical file/full-name identities and eleven byte-exact
raw/wrapped source bodies; all actual body/wrapped hashes equal Astra packet.
Its1847 maintained input hashes include1824 src files; every after-read matches,
whole input-table SHA256dc8f954fa2eda685d7b30f10494ffd6d74b5e302433f640d5cd42eba3045770d.
The first tiny static invocation omitted explicit1024 heap environment; actual
Node24/tsx had NODE_OPTIONS unset. No bounded-heap claim is made for it and no
compile/native execution occurred. Subsequent syntax/assembly checks explicitly
set1024. Preserve this invocation distinction instead of rewriting its receipt.

Root approved the exact separate --assemble source-only mode, current collector
SHA256ecb2a22ed2780671cf647d497945ea1b070501fbe6cda6d34546d1d2d154a12d.
Actual80429/start82312b/terminalc73aa2 exits0 at canonicalNode24/1024. Only the
maintained assembleOriginalHarness and parseMeta exports are called; no pool,
provider selector, worker, compile, module instantiation or native run occurs.
Exactly eleven full wrapped/assembled sources are retained in
`.tmp/2929-n0/source-assemblies-v1/{01..11}.{wrapped,assembled}.js` and the
complete assembly/metadata JSON has SHA256
f174d2f6c6a28fe13119f239a309b1bbeecf16b08a9ba1e3d3053764e4e3e356.
Contract bytes equal3e497933, all1847 input hashes still match. All eleven are
noStrict, primary.strict=false, async=false, no strict rerun. These are source
assembly facts only; current67 native guards and eleven artifact observations
remain NOT_RUN. Their expected pass/fail contracts were not changed.

Future preparation is exactly the accepted ordinary compiler-bundle command,
ordinary esbuild runtime-bundle command and full native provider builder, then
its --require-full-cache canary verification. Builder/worker heap3072, engine
interpreter and TEST262_FULL_RUNTIME_EVAL=1 are explicit; inherited bundle/key,
provider-disable, harness-mode and compiler-pool overrides must be scrubbed.
No refusal-only shortcut, cache purge, install, altered compiler option or
shared/canonical artifact write is authorized. Build only in own fresh worktree
and stop at actual terminal for root's pin/key/source/binary/canary inspection.
The six unchanged files run serially once under the fixed67 identity contract;
eleven sidecar observations use pool(1,"unified"), originalHarness=true,
assembly.async, inferModuleStrictArguments=false, target standalone, original
label,30000ms timeout, adding only unique wasmPath/metaPath. Full raw returned
fields/own-key presence persist before fixture conversion. Any missing/zero
Wasm, invalid success metadata, unmatched bundle identity or row omission is
instrumentation incomplete, not semantic scoring. Matched ordinary/artifact
row statuses must agree; neither11 extra observations nor historical60/7 totals
are new test identities or a current score. Exact retained Wasm/WAT inspection
uses existing Binaryen132 wasm-dis (tool SHA256
98201a639713272269fd0883fd8b07a4029f7a80e59b6540495e992e1472d99d).
Unavailable live tags/payloads/native renderers remain explicitly unavailable.
No inference from the text undefined releases a held producer/reader contract.

Root approved source-only provenance hardening before collection: actual worker
test262CompilerBundleHash is sha16 of compiler-bundle bytes; it is distinct
from the native provider's source+lock+bundle compiler key and native source/
option/provider key. Collector172-line SHA256
139c47ae31f4c8036c03fb6546b7a37c4245d433c3c8c68a0b768889428d0455
now records all three prepared binary byte/SHA receipts and both identities,
requires saved metadata.bundle_hash EQUAL the actual maintained worker hash,
and checks binary receipts after collection. All1847 source hashes remain
unchanged; this is provenance validation, not altered result expectations.

Future BUILD-ONLY recipe `.tmp/2929-n0/prepare.mjs`109-line SHA256
eb0ab4672afa94e0daac9ad11534250ad96bca5bea0269230e76822399f2cbc3
contains the exact ordinary commands/environment above and freezes its own/
collector hashes before and after, preserving all failed command terminals
without retries. Canonical syntax88b0f3 exits0 at explicit1024. It has NEVER
executed: native provider imports/exports, canary results, bytes and keys will
be actual evidence only after a separate approved preparation terminal.
No guard67, eleven artifact observations or live replay has been run.

### Actual current native BUILD-ONLY preparation terminal

Root granted the exact frozen recipe after the other lane's actual normal-hook
terminal. Own preparation handle75678/start35f74c/terminal27e7e6 exits0, no
live handle; exclusive build lease released. All four ordinary commands exit0:
compiler bundle, runtime bundle, full native builder, --require-full-cache.
CanonicalNode24/per-child3072, explicit interpreter/full selection, Corepack
network0 and inherited override scrub are recorded in actual command manifest.
Only inherited GIT_PAGER was removed. No lock/config repair, install, cache
purge, donor/canonical artifact write, adaptive retry or semantic fixture edit.

Fresh full native provider cache MISS compiled in74319ms to6249189 bytes,
key2e63998eab8a98ff. The standard five builder canaries passed; the separate
required-cache arm HIT those exact bytes and reverified canaries. The separate
refusal control was ordinarily built/canary-verified first (242185bytes,
key769f74e542dcd6ab), but was NOT the selected full provider. Actual native
selection announces INTERPRETER/full1; module has ZERO imports, all five
linkable runtime entry functions and actual renderer/tag exports. Namespace
renderer/tag availability is still NOT granted: N0 retains the five-function
maintained namespace and does not expose or call private observation exports.

Actual own binary receipts:

- compiler bundle21263424bytes, SHA256
  07fb2a4389fd4630ca98cec471c8bc686eeaf38825c624be9d1822d6f4f79d9a;
- runtime bundle20979259bytes, SHA256
  fa23d62605e42bef4bcfce7261095a54ded5c8d7be8c730dfbf59f6802ff8be6;
- full native provider6249189bytes, SHA256
  3edc9b58208d806e55b411f4e9a8b0fbb7283d02ae750292a763cc7fcc9c8325.

Native compiler source+lock+bundle keyff97d4c71ce3b003 is distinct from actual
worker compiler-bundle identity07fb2a4389fd4630. Read-only aftercheck394256
exits0: all1847 source inputs match, all three exact own binaries are regular
non-symlink files with matching byte/SHA receipts, recipeeb0ab and collector
139c47 are unchanged. Full metadata/exports/environment retained under
`.tmp/2929-n0/preparation-v1/`; no truncated summary substitutes for it.
Receipt hashes: preparation-contract.json
e6e9f715282bf74cc1db1e210f96b7cbf26a0ae7e2cc19707a944cdc90960edb;
commands-terminal.json
2bb54965782b93706eb3880a9132d4e56f5174745772180bf6415fc2461fe038;
prepared-artifacts.json
2ecf7f015e4a8d217471fb6c5d3d44b1a04a7840f5044ff766caa8c5419d614d;
full preparation terminal
6ac9582bf71158a9464b83304302a264bb5a84a8d109b095ed6ce2cf54526245.

Current matched native build feasibility is measured, not67 semantic acceptance
or11 artifact observations: both remain NOT_RUN, awaiting root's actual-artifact
review and a separate finite runtime GO. Historical60/7 remains historical;
no original Test262 or P1 producer-conformance gain is attributed to canaries.

### Actual unchanged finite native guard67 terminal

Root accepted the matched preparation artifacts and separately granted only
the exact six-fixture ordinary guard run. Own handle17519/start401df0/
terminal6f5704 exits1, signal=null, no live handle; the exclusive runtime lease
is released. This is a complete semantic-failure receipt, not an OOM, missing
report or interrupted instrument. No rerun, refusal fallback or expectation
change occurred. The eleven artifact observations remain NOT_RUN pending
root's full guard-row review and another finite lease.

The command preserves dispatch order1102/2928/2929/2960/4197/4242,
`--pool=forks --maxWorkers=1 --no-file-parallelism --reporter=json`, writing
only new `.tmp/2929-n0/guards-v1/guards.json`. CanonicalNode24 parent3072,
Vitest fork3072 via the maintained VITEST_FORK_MAX_OLD_SPACE_SIZE option,
CompilerPool worker3072, interpreter/full1 and Corepack network0 are explicit
in inputs-before.json. Inherited Git/test/provider/skip/tsx/Vitest overrides
were scrubbed; no config or `.git/config.lock` mutation occurred. The worker
announced INTERPRETER key2e63998eab8a98ff with TEST262_FULL_RUNTIME_EVAL=1.

Independent complete identity comparison ea3b26 exits0: six actual files,
67 unique file/fullName identities,60PASS/7FAIL, zero pending/skipped/missing.
All67 identities and statuses match the historical receipt, zero changes;
this is newly measured preservation, not a historical-total assumption. The
unchanged seven failed identities are the six bucket-C materialization cases
(new direct var, new direct function, indirect var, existing script var,
Annex B primitive replacement/call and deletion severing), each reporting
`fail: undefined`, and the obsolete NaN negative reporting that NaN is now a
global own property. The assignment-only and three non-extensible-global
positive controls pass, as do all60 historical PASS identities. Undefined
serialized error text is not a diagnosis of the live exception tag/payload.
No obsolete NaN assertion repair or native/protocol/source edit is included.

All1847 actual source inputs and three prepared binary bytes/SHA256 values,
plus collector139c47 and recipeeb0ab, match before/after. Raw67 rows and full
errors are retained without fixture-level summary loss:

- guards.json SHA25647dba208bb2a484b19903084a5fd6a4da13c0beb2d9242363887681cacf5df0b.
- identity-comparison.json SHA2568f352d183816341d20ac5698418deb2d31c0c8ca209e8590610cc4afd40cd978.
- inputs-before.json SHA256d2c29cb51d19f5bc8c803c48b5c8d183b0776b1653d9b7dfd4b75155531cc140.
- inputs-after.json SHA2562a216cf8674012b2ed0d4b326363e943bb2c619bbe4f00b85b194374eeee4dff.
- terminal.json SHA256ee52f1c9e07e7ad2eeacedbd234f506d30693f7dd92be9863f180b9463a001b0.
- full guards-v1-terminal.log SHA2566e06f6733286aae3301c22cafbd5383269e057b26ae8526cb895537ff23c4f2b.

These67 diagnostic assertions are not the original Test262 corpus, the P1
producer fixtures, or completion of2929. Six materialization losses and the
separate stale NaN expectation remain open; first-loss localization awaits
the separately approved eleven original-body artifact observations.

### Actual eleven original-body artifact observations and bounded handoff

After root's complete67-row review, root separately granted the frozen
collector139c47 --collect, eleven bodies only. Own handle63840/start5c9309/
terminaladb857 exits0, signal=null, no live handle; heavy lease released.
CanonicalNode24 --import tsx, parent/poolworker3072, explicit interpreter/full1,
Corepack network0 and scrubbed inherited overrides are retained in the separate
collection-v1-run launch receipts. Original PATH remains intact with canonical
Node prepended. No native build, guard rerun, source/fixture/provider/config
edit, live replay, namespace wrapping or hidden-export call occurred.

All eleven original label/body/wrapped/assembled identities match the frozen
contract3e497933 and source-only assembly receipts. Each saved Wasm is nonzero,
metadata.ok=true and metadata.bundle_hash=07fb2a4389fd4630 equals the actual
worker compiler bundle identity. Metadata sourceMap version3 sourcesContent
contains its exact saved assembled source in every row. The entire returned
response and own-key list persist before fixture-level conversion; no response
field is inferred from a simplified assertion string. All11 report
reachedTest=true; this establishes execution reaching the maintained test
region, not an exact user-statement/throw origin. The actual rows are:

- cd/direct-var-new: FAIL, isException=true, error literal string `undefined`.
- cd/direct-func-new: FAIL, isException=true, error literal string `undefined`.
- cd/indirect-var-new: FAIL, isException=true, error literal string `undefined`.
- cd/existing: FAIL, isException=true, error literal string `undefined`.
- cd/annexb-existing-primitive-call: FAIL, isException=true, error literal string `undefined`; both original direct/indirect subcases remain in the body.
- cd/delete-severs: FAIL, isException=true, error literal string `undefined`.
- cd/assign-only: PASS, ret=1, error/isException fields absent.
- d/direct-var: PASS, ret=1, error/isException fields absent.
- d/indirect-var: PASS, ret=1, error/isException fields absent.
- d/indirect-func: PASS, ret=1, error/isException fields absent.
- gap/nan-not-own: FAIL, isException=true, explicit `Error: NaN IS now a global own property — revisit the two non-definable-global-function/generator files`.

Thus4PASS/7FAIL agrees with the eleven corresponding ordinary guard statuses,
without adding assertions or gain. Eleven artifactComplete=true values mean
complete instrument outputs, not semantic acceptance. For every bucket-C row,
actual WebAssembly.Module imports are native apply_interpreted+indirect_eval;
direct-D imports apply_interpreted+direct_eval; indirect-D imports
apply_interpreted+indirect_eval; assignment-only and NaN rows have zero imports.
All names are in js2wasm:runtime-eval. Saved metadata.imports=[] differs from
these actual maps and is retained as recorded, never substituted as import
proof. Actual full export maps are retained independently (233/124/224/125
entries depending on the row). Provider selection remains native2e63998eab8a98ff,
native compiler keyff97d4c71ce3b003, distinct worker hash07fb2a4389fd4630.

Read-only validation e18a23 exits0 for all artifact/assembly/response receipts;
its excessive full metadata stdout was truncated and is not claimed as a full
output read. Bounded a8a521 retains all eleven complete response fields, actual
imports and metadata shape;3f2cdf exits0 for all eleven source-map content
comparisons. Seventy collection files retain full sources, Wasm, metadata,
responses, observations, provenance and selection. Receipt SHA256 values:

- collection-v1/observations.json c0f6b5845d9d8e943b58a44f298b0c704d230fd3dfebe4db24a7bdda870910fb.
- collection-v1/selection.json 71049caa3a8b67d30960a425b0755b9723ec84039702eb50dbe4100dcd984548.
- collection-v1/build-provenance.json 84c5add82320799b314c82b9371bdcf0cd4352ab05bac043e37f26b40cabe194.
- collection-v1-run/artifact-inventory.json 74d0db865c34266b76a48fdf513ac3b7d45a485974c73909a6df834831f30f1a.
- collection-v1-run/source-map-validation.json c777f601d41bbcf97d44c00d08212111a443e1f3d740f2bf1806e42a271ba762.
- collection-v1-run/inputs-before.json 56f312bef67e9b55ed96b648b564df2ccf176155531bc749fa41a94436013eea.
- collection-v1-run/inputs-after.json 74583bf85cb73246b553625f85acccb4f00483a909402a0bcc68c62b82ccd59d.
- collection-v1-run/terminal.json faa81da09baa65a64e8cdc2f2340ac43cbe06a10f78d941bc9969478ef63d28a.
- full collection-v1-terminal.log ae38b6a760f7abcaa53bca79bc7359cef303db4a3a6e30827637676eac4b14a5.

All1847 maintained source inputs, three prepared binary SHA256/byte receipts,
collector139c47 and recipeeb0ab match before/after. Compilation succeeds and
the maintained worker returns exception-classified failures, but no live tag,
payload or native renderer is exposed through this maintained pool response.
The six opaque failures therefore remain unlocalized among initialization,
eval/provider callback, property operation and exception-rendering stages;
`undefined` alone cannot choose one. No live replay or instrumentation grant
is inferred. A finite static Wasm/WAT/source inspection is a possible next
read-only step; any new live-boundary observation needs a separately reviewed
owner-scoped grant. The stale NaN negative remains a distinct fixture issue,
not evidence that native NaN installation is wrong. N0 is evidence-only,
not completion of2929, P2, original Test262 census or any semantic protocol leaf.

### Finite source-only routing inspection for the N1 planner

Root subsequently granted only maintained compiler routing inspection against
the exact saved sources/maps. No compile, instantiation, replay, import wrapper,
provider call, build or source edit ran. Map owns the heavy lease. Current
production source explains the observed import difference without changing
eval syntax classification or concluding that this routing is defective:

- src/codegen/expressions/calls.ts:3739 classifies a bare global `eval` as
  direct, `(0,eval)` as indirect. Lines7888–7891 attempt literal inlining first.
  Lines7893–7902 deliberately lower a direct call through the indirect global
  entry when directEvalRunsAtScriptGlobal returns true.
- src/codegen/direct-eval-environment.ts:77–98 returns true on reaching the
  SourceFile, but false when a Block or another lexical/function stopping node
  intervenes. Parser-only TypeScript createSourceFile inspection of all eleven
  exact original bodies (no Program/checker/compiler) verifies each C eval path
  ExpressionStatement→SourceFile. The Ddirect path is
  ExpressionStatement→Block→TryStatement→SourceFile. Hence its try block causes
  the direct-entry arm, while the C calls use the global indirect-entry arm.
  Annex-B's original direct and indirect eval subcases are both retained.
- src/codegen/expressions/eval-inline.ts:1175–1182 declines the splice for
  standalone sloppy global-varEnv eval with var/function declarations. The
  Annex-B block-function collision fallback is lines1132–1145; the fixture's
  original primitive script vars collide with those block-function names.
  Assignment-only has no declaration and does not trigger that predicate,
  consistent with its zero actual runtime-provider imports and PASS control.
- src/codegen/expressions/eval-inline.ts:2063–2078 registers the exact actual
  indirect import, with source/global externref arguments, then unwraps the
  result. src/codegen/expressions/runtime-eval-provider.ts:657–702 pulls global
  state, decodes the envelope payload and rethrows a false-ok result through
  the caller's exception tag. These are static operation-order facts, not a
  measurement identifying which operation produced the six failures.
- scripts/test262-worker.mjs:1691–1711 compiles the whole original JavaScript
  assembly (test.js/allowJs/sourceMap/deferred init); line2170 forwards
  msg.scriptGoal===true. That explicit flag is false for every original fixture
  call here, since it is absent from its options. It was not added in this arm.
  All eleven options are identical except labels and saved artifact paths:
  originalHarness=true, inferModuleStrictArguments=false, target=standalone,
  asyncTest=false. Thus no C/D compiler-goal or option difference was observed.

The AST receipt is collection-v1-run/source-routing-ast.json, SHA256
090223baa66040472a27bc7b9a8a0b26cdb97f04fc2bdfbf0b61cb3fb3cacf0d;
actual parser-only e9d280 exits0. Exact function/line facts were sent to root
and Astra's N1 planner, with routing-as-fact separated from unresolved live
failure origin. All1847 production inputs, three prepared binaries and both
sidecars still hash-match after source inspection. No conformance credit or
native/protocol implementation permission follows from this routing explanation.

### 2026-10-04: N0 evidence transfer into the existing docs checkpoint

Root reviewed the complete 334-line N0 donor appendix before authorizing this
lossless transfer. Its read-only donor worktree is
`/Users/thomas/Code/js2/.codex-worktrees/2929-native-guard-n0-observation`;
the donor uses this issue file's same repository-relative pathname. The donor
is 2032 lines, SHA256
19c3199b9ecd7d93d5147cd9d55bdf948a2ec4fe58bca875343bdc023ce500e3.
Its original 1698-line prefix is SHA256
874f9194b5de9b3ea0f49931a91e79a0083d9e8b0abda596cf2ca50637423fc5.
Only donor lines1699–2032 were appended, byte-for-byte, at destination
lines2556–2889; those 334 lines have SHA256
e2cfef03638c5261406604240920f533552fad087e5008cea05bb59519d3248d.

The published destination prefix remains all2555 lines, SHA256
1ee04474229db2d4348f400df83c984e3abce945db51020b80040da2b797904c.
The earlier shorthand2553 omitted the two-line, already-published external
donor citation repair; those lines are preserved too. No donor prefix,
frontmatter, foreign history, source file or fixture was replaced. Historical
NOT_RUN statements remain dated history before the later actual terminals.

The actual unchanged guard67 is60PASS/7FAIL; the finite eleven artifact
observations are4PASS/7FAIL, with all outputs complete. Six serialized error
strings say undefined; no live exception payload is thereby established.
The C/D import difference has a source-supported intentional routing
explanation, not a diagnosed routing bug. Neither diagnostic denominator is
an original Test262 gain. The separate NaN fixture question and six opaque
failure origins remain open; no N1 instrumentation/source plan is included.

Publication remains the existing docs PR6477, together with the accepted Map
planning checkpoint; no new PR or production ownership is requested. Root
must read this transfer manifest and the short Map25 handoff before granting
normal hooks/publication. This preparation ran no tests, builds, hooks,
commit, push, queue operation, provider call or trace instrumentation.

## Astra N1: finite exception-boundary observation, not a semantic repair

2026-10-04, source-only proposal after the frozen checkpoint. Preserve the
preceding2924 lines, SHA256
b8b03bc65634e91016567188ab2c08135f327dbb9f952f3511c41188fd570baa.
This appendix is private/unpublished and must not be pushed over queued6477.
No worker, provider, source, fixture, claim, runtime or publication change was
made. Root must read this whole proposal and grant exact instrumentation
hunks before a Sol implementer prepares a patch in a new isolated worktree.

### Evidence floor and the question the existing response cannot answer

N0's current native guard67 remains60PASS/7FAIL; its exact eleven original
bodies yield4PASS/7FAIL. All six C failures have isException=true,
reachedTest=true and error equal to the STRING undefined. Their complete
response lacks instantiateError; that absence is retained as an observation,
not proof of a specific native instruction. N0 binary/provider/input pins,
sources, originalHarness/noStrict options and all expectations stay fixed.
The assignment-only and three D positives plus explicit NaN Error remain
controls. Intentional Script-root direct-to-indirect lowering is explained
above; changing that route is neither a diagnosis nor part of N1.

Read-only anchors below were checked in the exact N0 donor worktree, not a
new bundle. scripts/test262-worker.mjs:2438 builds ordinary imports;
2456 invokes instantiateTest262Module;2498–2512 classifies instantiate
throws;2534–2555 invokes the existing __module_init once and classifies its
throw. Original-harness synchronous success returns at2558–2638 without
calling the synthetic test export. Its deferred-init order MUST remain so.
The generic exported-test catch2763 and outer catch2788 are distinct sites;
a diagnostic must record the actual site, not label all isException rows
as test-export failures. reachedTest is metadata, not a live program counter.

The actual reader is extractWasmExceptionMessage at1761, not merely the
similarly named shared original-harness renderer. It tries the consumer tag,
then Error/primitive/native rendering. For a successfully extracted nullish
payload it emits a fixed TypeError label, whereas a non-null native carrier
may render the text undefined; the non-Wasm fallback can also stringify a
value to that text. These are competing source-supported possibilities,
not an observed tag or payload classification. Failed getArg is currently
swallowed. scripts/lib/wasm-exn-render.mjs::exceptionPayload92 independently
collapses absence and a real undefined return, so its return alone is not
a diagnostic discriminator either. Preserve the maintained verdict policy.

instantiateRuntimeEvalNamespace (scripts/runtime-eval-provider.mjs:832–857)
creates one native instance and returns only five unwrapped entry functions.
Its tag/renderer exports exist in N0's binary but are absent from that public
namespace. attachConditionalImportNamespaces (scripts/test262-import-object.mjs:
135–152) attaches that exact namespace; instantiateTest262Module230–339 owns
the ordinary module-first lifecycle. currentLinkedPeers covers linked harness
providers, not automatic access to this native eval instance. Do not add it
to that registry, invent a second provider, or substitute a custom importer.

### Smallest proposed instrumentation surface: three scripts, no src hunks

Proposed leaf2929:native-exception-observation is NOT claimed by this plan.
An implementer needs fresh maintained exact-leaf/path checks and root patch
review; retained positive holds below are not released. Prepare only:

1. A private diagnostic leaf under scripts/lib, provisionally
   native-eval-boundary-observation.mjs. Built-in/leaf-only imports; no compiler,
   runtime or provider back-import cycle. It owns a WeakMap keyed by the actual
   namespace object and a per-row bounded primitive-record accumulator. It
   never exports raw GC handles or mutates namespace/instance exports. An
   explicit process-local observation flag defaults off; a strict manifest
   allow-list limits records to the eleven accepted labels. No new pool option
   is needed: CompilerPool.runTest uses an explicit option allow-list, so a
   casually added option would silently disappear. Clear row state on each
   request and before recycling; cap events and mark overflow INCOMPLETE.
2. ONLY the native WebAssembly.Module arm of instantiateRuntimeEvalNamespace:
   assign the existing five-entry literal to a local namespace, register its
   already-created instance in that WeakMap when enabled, return the same
   namespace. No new enumerable property, wrapper function, start call or ABI
   entry; every function reference is exactly instance.exports[name]. The
   QuickJS bundle arm returns as before and is not registered. Failure before
   successful instance construction remains provider-instance UNAVAILABLE;
   no substitute instance or manual initialization is allowed.
3. Worker-local capture in extractWasmExceptionMessage and its existing
   instantiate/deferred-init/export/outer catch call sites. Pass an optional
   local observation recorder, preserving call order and existing return text.
   Record catch-site, whether a consumer instance exists, actual
   WebAssembly.Exception discrimination, selected tag availability, getArg
   success/throw, and safe payload category only after successful extraction.
   Undefined/null/string/number/boolean/bigint/symbol/object/function are
   distinct; extraction failure is NOT undefined. Do not inspect arbitrary
   payload.name/message/constructor or stringify a GC object just to trace it.

Use values already obtained by the existing reader: capture its selected
tag/getArg result once, and each existing native-render attempt's returned
string or null once. Record which consumer/linked-peer/fallback branch
actually supplied the canonical text; do not rerun those renderers to fill
a trace. A null tryNativeExnRender result remains explicitly ambiguous among
missing export, empty/invalid length and caught rendering throw. No changes
to scripts/lib/wasm-exn-render.mjs policy/body are needed for this first pass.
sendResult3288 already spreads arbitrary payload fields to process.send;
attach only one serializable diagnostic field to the existing result. Keep
status/error/ret/negative verdict and own-key absence otherwise unchanged.
No raw exception, tag, payload, instance or function crosses IPC.

After canonical text/verdict is frozen, an optional terminal-only peer probe
may test the SAME caught exception against the stored native-provider tag,
recording missing/mismatch/extracted separately. Consumer and provider tags
are instance-specific; caller rethrow can match the consumer tag while its
payload originated in the provider. Tag ownership never proves payload origin.
Only after a successful extraction may the existing shared
tryNativeExnRender be used with the actual retained provider exports, once,
as a separately labelled diagnostic. This can execute native conversion and
potentially user conversion hooks: it is NOT part of the verdict and must run
only after this row's execution ends, with no resumed user code or subsequent
row sharing its instance. Root must explicitly include this observer call in
the grant; the tag-only pass is the default if it is not granted. Never invoke
runtime_eval entry functions, hidden field projectors or __module_init again.

Observation failures have their own captureError/INCOMPLETE status and never
replace the original failure. The observation-off branch must produce the
same result shape as N0. scripts/test262-import-object.mjs is a read-only
consumer: retrieve the existing attached namespace after its ordinary call,
including inside the catch, without changing attachment or init scheduling.
No CompilerPool type/IPC routing, compiler, core runtime, shared decoder,
property access or eval-result envelope edit belongs to these three groups.

### Protocol holds and exact carve-out questions

The accepted maintained-book snapshot pins upstream8ed0193 and legacy3d6bc324.
4245 remains positively held by ttraenkler/opus-membrane on
issue-4245-membrane-slice1 (write3673-cuhch2hj);4307 by
ttraenkler/opus-senior on issue-4307-closure-carrier-wrap (2644-9ek9n79y);
4308 by ttraenkler/senior-dev on issue-4308-slice-a-error-identity
(30953-9t03z4oe). These are retained records, not a fresh claim scan or inferred
release from done frontmatter. Their current MD scope passages were read.

MD4245 explicitly excludes interpreter implementation; native-only namespace
instance observation is distinct from its QuickJS membrane hunks. Its shared
carrier/identity/envelope contract remains held. MD4307 positively owns
callable wrapping/inverse emitRuntimeEvalCarrierUnwrapAny and crossing guards.
MD4308 owns declaration/cell/error identity and global-versus-activation
routing. N1 does not modify any of them. Ask the owners/root exactly whether
private non-wrapping native-instance retention plus terminal tag/renderer
observation is permitted without changing these contracts; separately obtain
the worker/instrumentation owner grant for the exact catch/reader hooks.
Do not call an unreviewed scripts hunk clear merely because it is outside src.

The source first-loss candidates stay separate: native indirect wrapper
PROVIDER_EXPORT_WRAPPER248 calls executeIndirectEval, lexical exposure,
exposeRuntimeEvalObject, then result wrapping; its catch repeats exposure
before wrapping the error, so exposure can itself throw. Caller
emitRuntimeEvalResultUnwrap657 calls global pull BEFORE decoding envelope
field1 and testing field0. Pull543 performs Get, shared-value unwrap,
interpreted-callable adaptation and coercion. These exact native/caller
functions are READ-ONLY hypotheses, not patches requested by this first pass.
If outer capture cannot distinguish an envelope failure from pull/Get/unwrap,
report that limit and request only the demonstrated next seam with4307/4308
clearance. No wrapper-entry JS trampoline or provider instrumentation is
smuggled into the three-script observation proposal.

### Finite preparation, controls, runtime gates and stopping rule

Before execution root must read the exact three-script diff and an eleven-row
manifest copied from N0, including original source/options hashes and provider
provenance. Pure source validation first: namespace's five names/references
unchanged; no QuickJS selection or native-source string change; normal import
graph has no added cycle; collector can represent unavailable/mismatch states.
No source metadata, oracle version or verdict baseline is changed for a trace.

Provider-cache feasibility is source-backed: computeCompilerBundleHash595
covers src/lock/bundle, while runtimeEvalProviderCacheKey607 includes assembled
provider source/options. The proposed script-only observation leaves those
inputs untouched; verify their actual keys and binary hashes, do not override
them. If ordinary selection misses or changes key, STOP—no provider rebuild,
TEST262_BUNDLE_HASH spoof, refusal fallback, stale-key bypass or cache repair.
The existing matched N0 compiler/runtime/provider artifacts must be supplied
by an explicitly reviewed own-worktree preparation, never rebuilt implicitly.

Four observer-unit controls can use host-created WebAssembly.Tag/Exception
objects without compiling fixture programs: successful extraction of actual
undefined; successful extraction of a known string; mismatched tag reporting
extraction failure; non-Wasm thrown undefined reporting that separate branch.
These are synthetic instrumentation controls, not native conformance cases.
They require their own frozen source/expected records and later runtime GO.
Do not manufacture private GC objects to make the native renderer succeed.

Then the same eleven original bodies run observation-off once and observation-on
once, serial canonicalNode24/3072 under separate approved finite leases,
pool1/originalHarness unchanged, no manual start or fixture catches. Preserve
all4 positive outcomes, explicit NaN Error and6 opaque failures; changes in
canonical outcomes mean an instrument perturbation, not semantic improvement.
Record complete result/diagnostic fields before fixture conversion, all
binary/source/namespace/function-identity provenance, terminal and survivor
checks. All phase records must have an explicit observation-complete flag.

If tag extraction plus the existing consumer rendering explains the text,
stop at that evidence; do not automatically execute the optional provider
render. If provider rendering is separately granted and exposes a meaningful
message, keep canonical undefined alongside it, not in place of it. If tags
are unavailable or both render paths remain opaque, retain UNRESOLVED and
name the smallest next held seam. This finite N1 supplies first-loss evidence,
not a promise of full internal stage tracing, six fixes,67/67, P2 completion
or original Test262 gain. No repair or wider tracing follows automatically.

## Astra N1 revision: observe only the existing consumer catch and reader

2026-10-05. This supersedes the earlier proposed N1 instrumentation surface,
not its historical evidence. Preserve the preceding 3122 lines and their
SHA256 2536366a46504ea62d6f502dc975e3dfae7429e3f86d01c9b5a33d1d8e4c5bde.
This is a source-only plan, not instrumentation or runtime permission.

### Decision and limits

Use only a private bounded record accumulator plus hooks in the EXISTING
worker exception reader and its call sites. Exclude native-provider namespace
retention, WeakMaps of instances, provider-tag probing, new renderer calls,
import-object changes, wrapper instrumentation, pull/unwrap changes, and
runtime-eval provider exports. Do not modify wasm-exn-render.mjs at all.

This can answer which consumer catch supplied the failure, whether its
existing getArg succeeded, which safe payload category it returned, and which
EXISTING rendering branch supplied the canonical text. It cannot identify
the provider's internal failing instruction, distinguish exposure from pull
or envelope decoding, prove payload origin, or recover a message that none
of the existing readers produced. Those limits are acceptable stop outcomes.

Six C rows contain the serialized STRING undefined; they do not prove that
the thrown value, extracted payload, or provider return was undefined.
Script-root direct-to-indirect routing remains intentional. All eleven
original bodies/options remain fixed; no replacement probe becomes a gain.

### Exact proposed source hunks and their invariant

Source anchors were read in the N0 donor at 1787b1af4a2f010f51ca1f45fc68fa540bfa4673.
Implementation must compare these bodies with its fresh base before editing.

1. New private scripts/lib/native-eval-boundary-observation.mjs: a leaf with
   built-in-only dependencies; stores only primitive records. Explicit opt-in
   process environment plus a frozen eleven-source digest allow-list, default
   off. No new CompilerPool option and no compiler/provider imports. A row
   record starts/reset in the existing process message handler (around2067)
   before compilation; match the actual source digest, not a label substring.
   Unlisted sources get no observer. Bound events/strings and mark overflow
   INCOMPLETE rather than truncate silently. Never retain exception/payload,
   tag, instance, exports or function references in this accumulator.
2. scripts/test262-worker.mjs::extractWasmExceptionMessage (1761–1825):
   optional local record target. Add constant branch events around operations
   ALREADY present, preserving their order and number. In the existing
   WebAssembly.Exception branch, record that fact; do not repeat instanceof
   to classify it. At the existing tag lookup record selected __exn_tag,
   fallback __tag, no-tag or no-instance using the already-read values.
   Do not read either export twice. Around the existing single getArg call,
   distinguish success from caught failure. Record successful undefined and
   null separately; a failed extraction has no payload category. Do not call
   err.is(tag), getArg again, or inspect caught-error properties for tracing.
3. In that same reader, record branch outcomes from existing values:
   payload-Error; consumer-native returned string/null; each already-visited
   linked-peer ordinal returned string/null; generic/native fallback chosen;
   payload safe-stringification; Wasm nullish label; host Error; non-Wasm
   fallback. Reuse existing native/viaPeer/generic locals and existing final
   result text. Where a return expression must become a local for recording,
   evaluate it exactly once at the same position. Preserve the special
   [object Object] policy and peer loop early returns verbatim. A null native
   render remains ambiguous: unavailable export, bad length, or caught throw.
   Do not add inspection or tracing inside the shared renderer to split it.
4. Worker reader CALL SITES only: attach constant context labels at the
   instantiate catch (2506), deferred __module_init catch (2548), exported
   test catch (2759), outer-Wasm catch (2794), and existing async-drain text
   path (2616). The existing originalHarnessExceptionMatches (1927) may call
   the reader too: label it negative-match and preserve its existing call
   count; do not merge its observation with a later formatting invocation.
   Increment an invocation ordinal so repeated legitimate reads are visible.
   Keep matching, source-map annotation, status and return logic unchanged.
5. Worker sendResult (3288): snapshot the bounded primitive diagnostic before
   existing cleanup; append one diagnostic-only own field when enabled for
   the allow-listed row. Default-off retains EXACT existing own-key absence.
   Canonical status/error/ret/reachedTest/negative fields are untouched. Do
   not modify pool transport/schema or verdict consumers. Existing sendResult
   already spreads payload through process.send; prove the ordinary parent
   collector retains the new field rather than assuming it does. If it drops
   it, STOP and request a separate exact transport observation hunk.

Safe category means only null comparison and typeof of an already obtained
value, or a branch the reader already entered. No payload.name/message reads,
String(payload), Object.keys, prototype inspection, JSON serialization of the
payload, or function invocation is added for observation. Existing behavior
may already do some of these; preserve that behavior but do not duplicate it.
All recorder errors are swallowed into a separate incomplete marker; they
never replace the test exception or run cleanup early. Reset at each message,
including errors/compile-only requests; no result inherits a prior row trace.

### Fresh ownership adjudication, not whole-file clearance

Maintained read completed with ref_read=ok at
5e15f033483955c0c6724223715b13e4a51951f9 (2663 records,1045 held).
The first sandbox attempt failed DNS; its failure was UNKNOWN, not unassigned.
The successful normal maintained read is tool receipt35bce2, exit0.
Our docs leaf2929:native-guard-plan-shepherd-docs and Sol's N0 observation
leaf remain separate; this plan claims neither implementation nor a worker.

Positive owners retained:3613 senior-dev-harness, branch
issue-3613-harness-vacuity-tests;6723 opus-6723-d4-rest, branch
issue-6723-d4-rest;4245 opus-membrane;4307 opus-senior;4308 senior-dev.
Their current scope passages were read, not inferred from done frontmatter.
3613 owns shared thrown-text/verdict parity;6723 owns the linked-peer generic
render fallback. The proposed hooks touch that worker reader's control flow
physically but do NOT change either policy, evaluation count, or ordering.
Request root's exact observation-only carve-out for the five groups above,
with the actual diff reviewed before source GO. If implementing them requires
changing those invariants, owner consent for that protocol is required first.

4245's QuickJS membrane,4307's callable carrier and4308's declaration/error
identity protocols are not written or re-entered. The earlier provider
WeakMap/terminal-render proposal is withdrawn for this pass; there is no
request to retain a native instance or observe hidden provider namespaces.
Do not call an entire script clear. A new implementation leaf, if approved,
needs its exact maintained check/claim and current open-patch collision check
before edits; no such claim or all-PR patch clearance is asserted here.

### Finite preparation and acceptance before any measured classification

Root first reads a source-only diff limited to the leaf, listed worker hooks,
and isolated observer tests. No src, provider/import-object, shared renderer,
cache policy, fixture, registry, oracle or result-verdict change is permitted.
Freeze six synthetic instrumentation controls: actual undefined payload,
null payload, known string payload, mismatched tag, missing consumer instance,
and non-Wasm thrown undefined. Add event-count controls around fake EXISTING
renderer functions to prove observer on/off has identical calls/order and
canonical output, including generic consumer plus successful linked peer.
These synthetic controls are not original Test262 evidence and need a lease.

Observer-off then observer-on run the SAME N0 eleven bodies, sources/options,
ordinary worker/pool lifecycle, canonical Node24 and matched native provider.
No manual init/replay, extra catches in fixtures, provider rebuild, key spoof,
stale bundle override, or compiler rebuild follows from this plan. Verify
actual compiler/provider/cache hashes; a changed key is a STOP, not a reason
to repair the cache. Retain all4 positives, six C opaque failures, and the
explicit NaN Error. Compare canonical response fields after stripping only
the new observation field and ordinary timing fields. Any verdict/text/route
or execution-count change rejects the observer, even if a row now passes.

The observer passes only with complete eleven-row provenance, no record
overflow, correct positive/mismatch controls, and unchanged canonical results.
Classify EACH C row independently: catch site, extraction status/category,
existing renderer route and final text. A non-null extraction would be new
measurement, not a conclusion imported from the old string. Failed getArg
does not prove tag mismatch without a separate approved test. No-consumer
and no-tag remain distinct from extraction-failed. Unresolved provider stage
stays UNRESOLVED. Stop after this one consumer-only pass and propose any next
held seam from the actual rows; do not expand instrumentation adaptively.

### Root decision after full review, 2026-10-05

Root read all147 revision lines3123–3269 (receipt df1a31) and granted the
exact observation-only carve-out for the five groups above, CONDITIONAL on
literal default-off behavior and unchanged getArg/render call counts, order,
canonical values and verdict. This is not provider, shared-renderer, transport
policy, pull/unwrap, identity or semantic-protocol authority. Sol must first
use a fresh isolated worktree, maintained exact implementation claim and
complete open-patch collision check. Root must read the actual source diff
before execution. No runtime/heavy lease, source edit, instrumentation result
or semantic gain is supplied by this docs grant.

## 2026-10-05 — consumer-only N1 observation preparation (Sol6.1)

Own managed worktree:
`/Users/thomas/.codex/worktrees/2929-consumer-exception-observer/js2`.
Branch `codex/2929-consumer-exception-observer`, fresh upstream production
base `719dfc865ad051facd01f2ebf41626598db9fabd`, verified with a server read.
The dirty root checkout was read only. Its older Documents memory path is
absent; the complete local MEMORY.md and relevant coordination/test262
memories supplied the operating context.

### Scope, ownership and collision floor

Maintained leaf `2929:native-consumer-exception-observer` was unassigned
before claiming, then the actual record was verified at book tip
`24cb2feeee24039939d3708cbdf8fe20d4c9adc8` (2664 records,1046 held).
Owner `ttraenkler/codex-sol61-native-consumer-observer`, matching this branch.
Positive holds3613/6723/4245/4307/4308 remain unchanged. Shared thrown-text,
linked-peer, carrier, declaration and identity policies are outside this leaf.

Complete paginated paths were read for all16 open PRs:
6468,6436,6435,6383,6341,6288,6246,6234,6206,6195,5942,5911,5883,5784,
5753,5748. Only6468 changes the worker. Its actual patch changes the fixture
graph import/helper and entrySelfImportGraph/fixtureGraph block; it does not
change the exception reader, reader call sites or sendResult. The new reset
sits immediately at handler entry, before existing reset statements, outside
that fixtureGraph block. No open PR changes this leaf or MD2929. This is exact
hunk clearance, not a blanket release of scripts/test262-worker.mjs.

The current reader, listed call sites, sendResult, runtime-eval provider and
shared renderer compare byte-identically with N0's1787b1af source anchors.
The accepted159-line revision above was copied exactly from the private
Astra checkpoint, appendSHA256
`cbb96b6d88c49ba5a46632991328956d0a8b0446aedcb46ffa06f1ecfeafe780`.
The fresh base's3122-line issue history is preserved before that copy.

### Prepared implementation and frozen controls — NOT_RUN

Only a built-in-only private primitive accumulator, the five approved worker
hook groups, this MD and an isolated Node control file are prepared.
Opt-in `JS2WASM_NATIVE_EVAL_BOUNDARY_OBSERVATION=1` admits only the eleven
literal assembled-source SHA256 values from N0. Missing flag, other values
and nonmatching digests admit no observer and add no result own key.
Records are bounded to128 events and1024 characters per string; overflow or
invalid capture is INCOMPLETE with an explicit reason. No raw Wasm value,
exception, tag, exports, instance or function enters a record.

The worker uses the existing tag/getArg/render operations once, retaining
their short-circuit order and canonical text. It labels instantiate,
deferred-module-init, exported-test, outer-wasm, async-drain and negative-match
reader invocations independently, including repeated-reader ordinals.
The result snapshot precedes existing cleanup and adds one diagnostic field.
The ordinary pool already resolves the whole received message
(scripts/compiler-pool.ts:162 and372); no transport edit is included.
Actual on/off pool retention still requires the finite runtime pass.

Six synthetic controls are frozen: actual undefined payload, actual null
payload, known string payload, mismatched consumer tag, missing consumer
instance, non-Wasm thrown undefined. Additional controls pin consumer/linked
peer calls and early returns, generic/safe fallbacks, fallback-tag read count,
repeated invocation ordinals, default-off/source rejection, explicit overflow,
and sendResult own-key absence/reset. Their sources execute the actual worker
reader/sendResult in an isolated host VM without importing compiler bundles
or executing the original fixture. These are instrumentation controls, not
original Test262 acceptance or semantic gain.

Source syntax and diff-whitespace checks pass. No prepared control, worker
execution, provider selection, native compile, build or hook has run. Root
must fully read the actual source/test diff before execution. Runtime work
also requires the exclusive serialized heavy lease.

### Current-source drift and future normal preparation gate

Fresh719df changes four IR source paths relative to N0's1787b1af:
new src/ir/analysis/backend-legality.ts and
src/ir/analysis/contracts/linear-memory-layout.ts, changed
src/ir/analysis/linear-memory-plan.ts and src/ir/backend/legality.ts.
Changed existing input hashes:
- linear-memory-plan: N0
  `382cb4acee2de86904da1c0162ecc8b9de4250f9f9cb49dcba57b1a056c1cc3c`;
  current `5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52`.
- backend/legality: N0
  `6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98`;
  current `5b67993fe312a0f5a52f9ef816c76a10cd32470f7e2a53819dec736764f45878`.

These unrelated upstream changes are read only; no IR edit belongs to N1.
Normal compiler identity includes the src tree, lock and built bundle, so
N0's native compiler keyff97d4c71ce3b003 and provider key2e63998eab8a98ff
cannot be assumed current. Its67 rows60PASS/7FAIL and eleven rows4PASS/7FAIL
remain historical. Fresh off/on results have not been measured.

A separately reviewed normal preparation may provision ordinary dependencies,
build the current compiler/runtime bundles with the repository commands,
build the full native provider with the ordinary maintained builder, and
check --require-full-cache once. No stale bundle, TEST262_BUNDLE_HASH override,
cache-key override, implicit provider rebuild, custom namespace, manual init,
replay or original-body change is allowed. Actual binaries, keys and source
hashes must be frozen before observer-off then observer-on run the identical
eleven original bodies under Node24/3072, pool1/unified/originalHarness.
Any unexpected key/byte change between arms is a STOP. Canonical response
comparison strips only this diagnostic field and ordinary timing fields;
any verdict/text/route/call-count change rejects the observer. Each row must
have complete original-source/options/artifact provenance and a complete
bounded record; failed getArg is not proof of a mismatched tag.

After that one consumer-only pass classify the six C rows independently and
stop. Provider-internal stage and payload origin may remain UNRESOLVED.
No semantic repair, original Test262 pass credit, provider/shared-renderer
instrumentation, or follow-up seam authority is implied.

### 2026-10-05 — actual isolated observer controls terminal

Root fully read the worker delta, private leaf, isolated controls and issue
appendix before granting this finite built-in-only control lease (root receipts
111f0a/05fb32). Ordinary canonical node_modules and26 non-.git test262 entry
links were prepared in the own managed worktree; no install, Git/config/hook
or provision-script execution occurred. Canonical corpus HEAD remains
b363f29d3c43c626dc852744ad64a0b48a003693; worktree .git was untouched.

Actual canonical Node v24.19.0, NODE_OPTIONS=--max-old-space-size=1024,
original inherited PATH, isolated node --test:11/11PASS,0FAIL,0SKIP,
0CANCELLED,0TODO. The default reporter command completed at22:52:18 UTC
2026-10-04 (77.004542ms reported by Node, exit0, receipt9bc933). Node emitted
the spec reporter by default; the same finite11 controls then ran once with
--test-reporter=tap to retain the required actual TAP (64.847ms, exit0,
receiptff565d). No original body, compiler, provider or native build ran.
The heavy lease was yielded immediately after these controls.

Complete actual TAP: .tmp/2929-n1/controls-v1.tap, SHA256
865bf27a738bd6f19079add4cb6dd60d6fe21388184ac5e64203af040026d0fe.
Terminal and complete before/after input pins:
.tmp/2929-n1/controls-v1-terminal.json, SHA256
67c9b3ce8e3fcc2b4743008005c2da333723f494b4162d443872c94725cce5ec.
All six file hashes are unchanged before/after both reporter runs:

- worker:360cd3b5ef4655bd9b1156faa87e85bcd94cea1c24c97362e1c66ed1a55e51cc.
- observer:afb1240a903c2fc8109556ba53565416d76783c809fbd6c4798acda518d9be6d.
- controls:0a1dc9e06bedcb70226829147a38ae9a0653886386d432d4102ed1360a1e3705.
- runtime shim:38803c267321eb785fca237c58e5fdb7f160e133108ab21a2fb03eee12b65d43.
- assert.js:206e274ca325eb8a652e3911c3fbd090e2480d11ed7579dc17a5d17a2360ed48.
- sta.js:1930c54af79455c484799f43e9a28e2b2f15c40d0917c9941ca54e26db243f35.

These measurements validate the instrumentation controls only. Native guard67
and fresh observer-off/on eleven-row runs remain NOT_RUN; original Test262
conformance credit is zero. Root independently read the exact eleven TAP rows
and terminal pins (receipt906176) and accepted that bounded result.

### Frozen future normal current build recipe — NOT_RUN

Own .tmp/2929-n1/prepare-current.mjs is129 lines, SHA256
4a5344c85ae8aa8a4014283b2ae583769927a399cb73ed92dc5708d5845c135e;
node --check passes. Root must read the complete recipe before a separately
authorized serialized build. It freezes current tracked src files plus normal
compiler/runtime/harness inputs once, checks the reviewed worker/leaf/control
and provider/lock hashes, asserts exact current package build commands, and
never copies old artifacts or cache metadata. The full maintained native
builder was read, including its normal refusal-first build, full-provider MISS
verification of five canaries and the namespace, and --require-full-cache
verification of the actual cached full-provider bytes.

Exactly four sequential commands are proposed: pnpm run build:compiler-bundle;
pnpm run build:runtime-bundle; canonical Node24
scripts/build-runtime-eval-provider.mjs; canonical Node24 with that same script
--require-full-cache. Actual build children use3072, original inherited PATH,
JS2WASM_EVAL_ENGINE=interpreter, TEST262_FULL_RUNTIME_EVAL=1,
TEST262_WORKER_MAX_OLD_SPACE_SIZE=3072 and ordinary existing dependencies.
No TEST262_BUNDLE_HASH, stale compiler key, provider-key override, alternative
namespace or manual initialization is admitted. Any command failure stops;
there is no fallback/retry. It records exact command terminals, normal current
compiler/provider keys, current assembled-provider source/options, all three
binary hashes, native zero imports and five entry-function exports, then
verifies the frozen inputs remain unchanged. It does not run guard67 or the
eleven original bodies. No full-native build lease is granted by this record.

After this normal preparation is reviewed and executed, one separately
reviewed ordinary matched observer-off eleven-row pass followed by observer-on
eleven-row pass remains the entire measurement scope. Literal source digests,
options and originals stay fixed; fresh off outcomes are measured rather than
assumed from N0. The consumer-only stopping rule and all held protocols remain.

### 2026-10-05 — actual current normal BUILD-ONLY terminal

The reviewed recipe's initial override preflight saw only injected GIT_PAGER
(display setting), not a semantic/IR/cache override. Receipt0119ad exited2.
The orchestration still entered the recipe, whose own strict GIT_* assertion
refused before any child command or output/cache directory was created
(fbc546, exit1). This was an orchestration mistake with zero build children;
the actual refusal is retained at .tmp/2929-n1/build-preflight-refusal-v1.json,
SHA256 0a98042be56adc670bf431d1fa159b050536d4c90bf85c7b9f53c08ba8b3078d.
No timeout/restart or cache recovery followed that refusal.

Root authorized the exact one-line assertion exception for GIT_PAGER while
retaining rejection of every other GIT_* setting. The source correction was
read back; corrected129-line recipe SHA256
e1ac41cb14ecb9ccf26ae20ccabacc0e4da9088a71c7581c60c104cdfdaf14ce.
The fixed orchestration checks actual preflight exit code before launching
the recipe. Actual preflight72bfa7 passed with zero semantic/IR/cache/Git
overrides; original PATH remained unchanged.

Exactly the four reviewed normal commands then completed once, all exit0,
same session37126, receipts95ec74/963d06/54a909,22:57:31.105–22:58:55.875 UTC
2026-10-04. Canonical Node v24.19.0/3072, original PATH, native interpreter
selection, FULL_RUNTIME_EVAL=1 and WORKER_MAX_OLD_SPACE_SIZE=3072 were used.
Normal full provider was a MISS, compiled in78799ms,6249189bytes, then the
maintained --require-full-cache command re-verified the actual cached bytes
and canaries. The normal refusal-first builder also verified its ordinary
floor canary. No provider function was manually invoked by this recipe.

Actual current provenance:

- native compiler key:a821fdc2f3d4671f; provider key:2dd35d72b70e8940;
  worker bundle:d0d456fe73351a58. N0's old keys were not reused.
- compiler bundle:21263464bytes, SHA256
  d0d456fe73351a58b374cb04acdf1eec44fdd5c58f4671f3df459f94f72b3b46.
- runtime bundle:20979299bytes, SHA256
  a4bf85b1bbc86274ccbbbe92897b8315441e6b92508c8528eacb121bbe52b768.
- full native provider:6249189bytes, SHA256
  3edc9b58208d806e55b411f4e9a8b0fbb7283d02ae750292a763cc7fcc9c8325.
- provider source SHA256:
  fe8db0fcf0c934bda24d54d1496d9daed4c27ab19e697d82db79370bed31339e.
  Maintained provider compile options are unchanged:experimentalIR=false,
  fileName=runtime-eval-provider.ts,skipSemanticDiagnostics=true,
  target=standalone. No ambient IR/cache override was introduced.
-1852 input files, including1826 current source files, frozen before/after;
  allInputsAfterMatch=true. Input-manifest SHA256:
  f0a3f31fa58df62bb19ed3cb6e61a8d5c40e0d764978334f36505b08ad433c3a.
- actual native zero imports and all five ordinary entry-function exports
  were verified from the normally selected current module.

Complete receipts under .tmp/2929-n1/preparation-current-v1:
preparation-contract.json SHA256
dfcd8f267f778350b7417772451e3fea1f914752583d6599beeab3b508e898c1;
commands-terminal.json SHA256
88856f2b5107235fc813d22b3eb08a6b9fd6714bb867d4480b00da6d71af6fd4;
prepared-artifacts.json SHA256
a6010f860fd14fc46f7a9fb028cce08b5cca3af56a878549c7973101d375fa94.
Worker, observer and controls remain byte-identical to the reviewed hashes.
The build-only heavy lease was yielded immediately on the true terminal.
No guard67, observer-off eleven or observer-on eleven original body ran.
No native semantics or original Test262 credit is supplied by this build.

### Prepared identical-source ordinary off/on recipe — NOT_RUN

Own .tmp/2929-n1/observe-off-on.mts is146 lines, SHA256
cdcdc0800e2ede0e4ea0aad8c5210ff96f603d992e6aa0a919cd3197b649bac2;
syntax check passes. Root must read it completely and grant the separate
finite runtime lease. It reads the actual current build/input receipts,
rechecks their hashes and normal selected keys, extracts exactly eleven
unchanged literal runScript bodies from the existing fixture, and uses the
maintained assembleOriginalHarness/parseMeta. All assembled digests must
match the frozen eleven-source allow-list and exact labels before any run.

Only ordinary pool1/unified runs are proposed:off11 then on11, timeout30000ms,
originalHarness=true,inferModuleStrictArguments=false,target=standalone,
asyncTest=false, with normal own wasm/meta artifact paths. No new pool option,
body change, provider/private instance, manual init/replay, extra renderer
call or semantic modification is introduced. Full returned own fields are
retained before conversion. Missing parent-retained diagnostic is an immediate
STOP, not permission to change transport. Every on row requires a complete
bounded record with the actual source digest/label; all rows require actual
complete runtime/artifact responses, unchanged bundle identity and input/
binary hashes. Canonical responses strip only the diagnostic and normal
compileMs/execMs fields; any mismatch or binary/source change rejects the
observer. Actual fresh off outcomes are measured rather than assumed.

The final six C-row classifications retain canonical outcomes and complete
diagnostics independently. Provider internal stage and payload origin remain
UNRESOLVED unless this consumer-only evidence supports more; no next tracing
seam is entered. The whole scope stops after this one matched off/on pass.

### 2026-10-05 — actual matched consumer-only off/on terminal and classification

Root fully read the146-line recipe and four actual build terminals (e4ac5d),
then independently rehashed all1852 input files and all three binaries and
checked actual native imports0/exports43/five-entry floor (4b8b44). The finite
runtime lease authorized only ordinary pool1/unified off11 followed by on11,
the exact original bodies/options, native interpreter/FULL tier and3072.
Actual override preflight66c929 passed; no inherited semantic/IR/cache override
was present. Canonical Node24 with the maintained --import tsx path ran the
exact recipe, same session36565, receipts42b1a6/49e22e/14f744/5fb5dc, exit0.
No source or issue edit occurred while either arm was live.

Actual fresh observer-off:eleven complete rows,4PASS/7FAIL.
Actual observer-on:eleven complete rows,4PASS/7FAIL, every row retaining the
complete bounded diagnostic through the ordinary unchanged parent collector.
All eleven canonical response pairs are identical after stripping only the
diagnostic field and compileMs/execMs. All eleven assembled-source and emitted
Wasm pairs are byte-identical; all1852 input files and all three prepared
binaries match their frozen hashes before/after. A separate read-only
post-terminal rehash again measured1852inputs+3binaries with0mismatches.
Default-off has no diagnostic own key. There was no overflow/capture error,
timeout, compile failure, route change or missing transport field.

Four original positive controls remain positive:cd/assign-only,d/direct-var,
d/indirect-var,d/indirect-func. The explicit gap/nan-not-own Error remains
unchanged. Six C failures keep the canonical STRING undefined. These are
current matched measurements, not assumed N0 outcomes; no original Test262
conformance gain or67-row rerun is claimed. The heavy lease was yielded on
the true terminal before these read-only classifications and this MD append.

Each actual C response and its nine primitive diagnostic events was read
independently. All six have exactly one reader invocation, complete=true,
captureError=null and this observed route:deferred-module-init catch;
consumer instance present;actual WebAssembly.Exception;selected consumer
__exn_tag;existing getArg succeeded;safe extracted payload category object;
existing consumer-native renderer returned the STRING undefined and supplied
the canonical reader text. The actual per-row records are:

-01 cd/direct-var-new:deferred-module-init,getArg success,object,
  consumer-native STRING undefined;1invocation/9events.
-02 cd/direct-func-new:deferred-module-init,getArg success,object,
  consumer-native STRING undefined;1invocation/9events.
-03 cd/indirect-var-new:deferred-module-init,getArg success,object,
  consumer-native STRING undefined;1invocation/9events.
-04 cd/existing:deferred-module-init,getArg success,object,
  consumer-native STRING undefined;1invocation/9events.
-05 cd/annexb-existing-primitive-call:deferred-module-init,getArg success,object,
  consumer-native STRING undefined;1invocation/9events.
-06 cd/delete-severs:deferred-module-init,getArg success,object,
  consumer-native STRING undefined;1invocation/9events.

The extracted category is demonstrably non-null object, not undefined/null
or failed extraction. The existing consumer render's non-generic string
return took the early return, so no linked peer was visited. No payload
properties, object identity, internal instruction or provider tag was inspected.
The canonical text is an actual consumer-rendered string; it does not prove
that the original thrown/provider value was undefined. The observed catch is
the deferred __module_init catch, not an inferred exported-test failure from
reachedTest metadata. Provider internal stage, whether exposure/pull/envelope
decoding failed, and payload origin remain UNRESOLVED for every C row.

Complete own retained receipts under .tmp/2929-n1/observation-current-v1:
terminal.json SHA256
b47699dfcd1060c9e72f319a4be66001d949120f9822b016ecede96440e5ef2f;
manifest.json SHA256
93d714ffd94487fcbbafa5f411a0914b722bcecda3c505a21cd33003a59c8ef7;
off/rows.json SHA256
b23105074589e81489c78e07dee884ab40e821596d942e92099ad9bfbabc2475;
on/rows.json SHA256
edadea5305513c25d2836383d3b1701021ceae84d9ffafea6101b7a18cdac8f9.
Each arm also retains all eleven full response/own-key files, unchanged
assembled sources, normal Wasm/meta artifacts and per-row provenance.

N1 stops here with its consumer-boundary question answered. No native provider,
shared renderer, transport, identity, declaration, pull/unwrap or semantic
repair follows. Any next internal seam requires its own exact owner-scoped
plan/grant and cannot borrow this observation authority. Publication gates
and root review remain separate from this completed finite observation batch.

### 2026-10-05 — bounded observer handoff and publication preflight plan

Root independently read all six diagnostics (1d93eb), all twenty-two raw
responses, all canonical pairs and all twenty-two Wasm rehashes (ae388a).
The instrumentation component is verified without semantic gain: six
non-null object payloads became the consumer-native STRING undefined.
Payload origin, brand, provider internal stage and producing instruction
remain UNRESOLVED. Existing worker policy accepts a non-null native rendering
other than [object Object] immediately; STRING undefined therefore prevents
the existing linked-peer route from being visited. This describes current
policy, not evidence that any peer would recognize the payload.

Next-owner handoff request: the maintained owners of shared rendering (3613)
and peer fallback (6723) should independently assess the producer/consumer
payload contract and native-render recognition, under their existing held
claims and a separately reviewed bounded plan. Neither a generic
undefined-as-not-mine fallback nor treating this text as proof of thrown
undefined is justified: legitimate thrown undefined and the string undefined
must retain their valid rendering behavior. This observer does not inspect
payload properties or identity and authorizes no new rendering, extraction,
provider tracing or runtime capture. The provider-stage question remains
open; no ownership transfer or change to either held policy is made here.

Publication is a separate future finite batch, not authorized by this plan:

1. Read the actual current server main and complete current open-PR path list,
   then refresh exact worker-hunk collision clearance and verify the maintained
   2929:native-consumer-exception-observer claim. Integrate current main only
   in this private worktree using normal Git operations, preserving all own
   and peer changes. Stop on a positive exact-hunk collision for root review.
   Root must read the resulting full actual diff before executing gates.
2. Keep the publication diff to the worker, private observation leaf, isolated
   builtin control test and this existing issue MD. No src/runtime/provider,
   shared renderer, transport, cache fixture or protocol changes; no generated
   binaries, dependency links or ignored .tmp receipts enter the commit.
   Preserve default-off response own keys, the eleven-source admission floor,
   original read/render call order and count, canonical text and verdicts.
3. Under a root-issued serialized lease, run the eleven builtin controls with
   zero skips and retain actual TAP plus before/after source and harness pins.
   On the integrated tree, freeze actual compiler/runtime/native inputs and
   use the maintained normal builder if current provenance requires rebuilding;
   never reuse stale keys or override cache metadata. Run exactly the reviewed
   ordinary eleven off/on pairs with unchanged literal bodies/options and
   fresh actual off outcomes. Require all twenty-two complete rows, default-off
   field absence, all on diagnostics retained, canonical/source/Wasm parity
   and unchanged frozen inputs. Any timeout, compile error, missing field or
   mismatch is a real failure, not permission to restart or change policy.
4. Run normal repository LOC/function budgets, issue/spec/integrity, import
   cycle, orphaned-script and quality checks applicable to the four-file diff.
   Explicitly include all three .mjs files in the normal Prettier/Biome checks:
   lint-staged includes mjs although the package's default format glob is TS.
   Read resulting formatter changes as real diffs; semantic changes need root
   approval and invalidate affected frozen validation. No budget relaxation,
   issue status inflation, hook bypass or configuration override is proposed.
   The ordinary commit hook includes lint-staged and LOC/function gates; the
   ordinary push hook includes typecheck/lint, changed-file formatting, oracle
   and coercion ratchets, numeric-local IR regression, conformance-doc sync
   and committed/working issue integrity. Retain actual gate terminals.
5. Only after explicit root publication authorization and successful normal
   gates, verify Thomas Tränkler <git@thomas.traenkler.com> attribution, make
   the scoped commit with Codex co-author and Model: Codex GPT-6.1 Sol High,
   and push the owned branch to the user fork. Verify the actual remote ref
   even if a hook reports failure. Create and attach a separate upstream PR
   with the correct Description and unchecked CLA box, without GitHub issue
   writes or changes to unready semantic PR 6435 or another owner's branch.

The scoped PR describes observation only: eleven isolated controls passed;
fresh matched eleven off/on outcomes were 4 PASS / 7 FAIL and canonically
identical; six failures exposed non-null object payloads rendered to STRING
undefined by the consumer. It must disclose UNRESOLVED provider stage/origin,
zero original conformance credit and no guard-67 rerun under this component.
Do not close the broader 2929 issue, claim a semantic fix, mask the seven
original failures, or mark the whole native-eval goal ready. PR readiness
requires actual mergeability and all required checks, not merely this plan.

No publication gate, commit, push, additional runtime or tracing was executed
while preparing this handoff. The completed consumer-only batch is stopped;
the agent slot is yielded with the dedicated Astra shepherd left resumable.

### 2026-10-05 — read-only publication refresh and exact pending gates

Actual server main is 27b18d375f0c446fcd5662056a35261db9881f7b, exactly one
commit ahead of this worktree's unchanged 719dfc865ad051facd01f2ebf41626598db9fabd.
The new commit changes nine benchmark result paths only, no observer file or
compiler/runtime/native input. No fetch, merge, staging, commit or push occurred.
After a separate root grant, fetch upstream main normally, verify the actual
server SHA still matches the reviewed snapshot, then use git merge --ff-only
upstream/main in this private worktree. The present nine-path update is disjoint
from all four owned dirty/new files; no stash/reset or foreign worktree edit is
needed. If main moves again, reread its actual delta before integrating it.

All seventeen actual open PR file lists were read with complete pagination:
6480, 6468, 6436, 6435, 6383, 6341, 6288, 6246, 6234, 6206, 6195, 5942,
5911, 5883, 5784, 5753 and 5748. New 6480 changes six benchmark/website JSON
files only. The sole owned-path intersection remains 6468's worker patch:
fixture-graph import, helper, comment and graph-selection additions. Its full
patch SHA256 is 04f231a1e759baf7057f7c9d6332e5a6c21b6834e814e4795b79b945d5a681a8.
None touches the actual exception reader, reader-context arguments, handler
entry reset or sendResult hooks. Shared import context is not a positive
changed-line collision. No other PR intersects either new leaf or this MD.

The upstream maintained claim tip is 97869591ba727ff9aadd7dfc08c8f79736869b5d
(2670 record blobs). Actual 2929-native-consumer-exception-observer.json,
blob 5ba2732babef75035af0d7a75b6d52377471382a, remains in-progress with this
agent's exact holder and branch. The legacy fork tip is
3d6bc324711e54f4b4d41f71910ee228cc8ed6ac (894 record blobs), read because the
maintained reader explicitly unions the legacy book. Actual upstream 6723
remains opus-6723-d4-rest; actual legacy 3613 remains senior-dev-harness;
4245 opus-membrane, 4307 opus-senior and 4308 senior-dev remain held. No claim,
status, ownership or rendering policy was mutated.

Source-only anticipated gate finding: the required verdict-oracle checker
explicitly matches expectedErrorType in changed mixed-worker lines. The
observation argument addition to originalHarnessExceptionMatches's existing
extractWasmExceptionMessage(...).includes(expectedErrorType) return therefore
matches that pattern despite unchanged verdict policy and the accepted matched
twenty-two responses. This is a static finding, not an executed gate failure.
STOP for root-specific resolution before declaring gates ready. Do not bump
the oracle, edit shared verdict files, weaken the gate, add a generic exemption
or treat instrumentation evidence as an original conformance improvement.
The checker documents an in-diff no-verdict-change comment mechanism; any
proposed precise explanatory comment requires root review before editing and
fresh validation of the final source pins. No such comment was added here.

Pending finite execution sequence, subject to the next explicit root lease:

1. Integrate the reviewed current main as above; perform normal scoped
   formatting before freezing final sources, and have root read all real
   formatter/comment changes. Explicit normal commands include pnpm exec
   prettier --check and pnpm exec biome lint for scripts/test262-worker.mjs,
   scripts/lib/native-eval-boundary-observation.mjs and its .test.mjs sibling.
   Formatter fixes use the maintained formatter and are not hidden in a hook.
2. Run canonical Node v24.19.0 with NODE_OPTIONS=--max-old-space-size=1024,
   --test --test-reporter=tap on the isolated .test.mjs file. Require exactly
   eleven top-level tests, zero skips and all source/harness before-after pins.
3. Reread all current preparation inputs and actual three binary hashes, using
   ordinary native selection/provenance. The benchmark-only main update alone
   does not change compiler/provider inputs, but final worker/leaf formatting
   changes require a new exact input contract. Prepare root-reviewed copies
   of the already accepted build/off-on recipes with only the new actual base,
   actual source pins and fresh exclusive receipt locations; preserve old
   receipts. If a normal rebuild is needed, run the same four normal commands
   once: build:compiler-bundle, build:runtime-bundle, maintained provider builder,
   then its --require-full-cache verification. Use canonical Node/3072 and
   original PATH, interpreter/FULL, no inherited semantic/IR/cache overrides.
4. Execute the unchanged ordinary pool1/unified eleven off then eleven on
   recipe with timeout 30000 and the frozen literal original bodies/options.
   Measure the new off outcomes; never assume historical 4 PASS / 7 FAIL.
   Require twenty-two retained complete responses, all default-off own keys
   unchanged, complete on diagnostics, canonical/source/Wasm parity and all
   current inputs/binaries matched. Stop on true failure without timeout retry,
   provider tracing, alternate replay or semantic repair. No guard-67 batch.
5. Normal explicit local gates include typecheck, lint, format:check,
   check:loc-budget, check:func-budget, check:import-cycles,
   check:orphaned-scripts, check:tracked-ignored, check:oracle-ratchet,
   check:coercion-sites, check:issues and the current CI quality gates applicable
   to this source change. The orphan checker considers only top-level scripts;
   both new files are private scripts/lib leaves, not new top-level candidates.
   No LOC/function baseline or allowance changes are proposed.
6. After authorized normal staging/commit with the standard hooks, run the
   committed-tree checks against the actual upstream base: check:issue-ids
   --against-main and --against-open-prs, check:issue-spec-coverage --base,
   check-verdict-oracle-bump.mjs --base, check-committed-issue-integrity.mjs HEAD
   and check-merged-issue-integrity.mjs upstream/main HEAD. These checks inspect
   committed diffs; running them before the owned files are committed would
   not validate this component. Do not present an empty precommit diff as proof.
   Any failure stops publication for root review, without bypass or unrelated
   issue/source edits. Ordinary commit/push hooks still execute normally.

Actual main ruleset 16700772 requires strict current-base checks: cheap gate
(main-ancestor + lint), merge shard reports, quality, equivalence-gate,
check for test262 regressions and cla-check. Its merge queue is enforced.
The legacy branch-protection endpoint returned 404; this does not erase the
actual ruleset requirements independently read from rules/branches/main.
This scripts change triggers normal code/test/build CI classification, not
docs-only or benchmark-only skips. A future observer PR is ready only after
its actual current tip is mergeable and every required check is satisfied;
unchecked CLA stays unchecked until the authorized human agrees to it.

The correct-template draft body is retained locally at
.tmp/2929-n1/observer-pr-body.md. Before actual publication, replace its explicit
pre-integration validation qualifier with the actual integrated-tip receipts;
never promote pending gates to PASS. The publication diff remains exactly four
owned files and stays separate from unready semantic PR 6435. No new runtime,
semantic trace, executable gate, Git mutation or external write was performed
during this read-only/source-only refresh. DataView retains the heavy lease.

### 2026-10-05 — source-only negative-match default binding (v2, not yet run)

Root fully read the actual worker diff, publication appendix and draft body,
and authorized only a genuine narrow structure change, not an oracle bump or
exemption. Full caller inspection found six reader calls total: one unchanged
negative matcher and five explicit contexts (instantiate, deferred-module-init,
async-drain, exported-test, outer-wasm). There is no seventh omitted caller.

The worker now supplies the optional negative-match observation as the third
parameter's default expression. originalHarnessExceptionMatches is restored
BYTE-EXACT to the original HEAD function, including its original two-argument
return. A source-only comparison of the complete original/current matcher
confirmed byte equality (6da463). The other five caller expressions and reader
body are unchanged from the reviewed v1. No extraction, renderer, provider,
payload read, verdict token or policy change was introduced.

When enabled, explicit contexts return their existing callback so the default
is not evaluated; omitted third selects negative-match before the first reader
body event. Its ordinal/context placement is unchanged. When disabled, all
explicit expressions and the default resolve to undefined from the own null
accumulator. The default may perform that own null lookup again, never an
exception/export/provider read. The reader's JavaScript function length becomes
two; this private function is neither exported nor passed as a callable, and
the complete worker/test references contain no function-length consumer.

The isolated VM honestly requires the worker accumulator's lexical binding.
makeReader now creates the same let binding from a test-only accumulator,
defaulting to null. Existing fallback-tag/ordinal control now invokes the
omitted-third reader with an enabled accumulator, then the explicit
deferred-module-init reader. All original call-count, tag, text, context and
ordinal assertions remain; the control additionally asserts the byte-exact
original negative-match return is present. All eleven top-level controls remain
in place. No assertion, admission rule, body or expected result was weakened.

The complete old worker/control source bytes were reconstructed and retained
under .tmp/2929-n1/source-v1/*.mjs.txt; their original SHA256 values were
independently verified as 360cd3b5ef4655bd9b1156faa87e85bcd94cea1c24c97362e1c66ed1a55e51cc
and 0a1dc9e06bedcb70226829147a38ae9a0653886386d432d4102ed1360a1e3705.
All previous build/runtime/TAP receipts remain immutable v1 evidence. They
must not be presented as validation of these new source bytes.

Actual pending v2 freeze: worker SHA256
be06c73b7ef501985d39313d3c52691d90d5067899225dbc1431e11858e4a233;
unchanged observation leaf afb1240a903c2fc8109556ba53565416d76783c809fbd6c4798acda518d9be6d;
control source 1e1df03e66a2224e0da7522e2e89bbc0519e04e9d645f6c02e36019ed3652df3.
Source-only recipe copies prepare-publication-v2.mjs (129 lines) and
observe-publication-v2.mts (146 lines) retain the exact accepted normal commands,
options, admission, provenance checks and stopping rules. Only the reviewed
future integrated base 27b18d375f0c446fcd5662056a35261db9881f7b, actual new
worker/control pins, preparation receipt reference and fresh exclusive v2
output paths changed. Their SHA256 values are respectively
4bb22879127abbb2e0e8fe67b5eccd1928a0fd4b50c90fe7635029ee1c55ecf1
and bb3f0d4e53d9cbcc90404b273d35d5a4d6ba1a39988ef27b2fade1977e0fe0e3.
Own HEAD remains 719dfc865ad051facd01f2ebf41626598db9fabd; the future-base
assertion intentionally prevents premature execution before authorized
integration. Any fresh-main movement or formatter change requires actual new
pins and root review, not key overrides or historical receipt substitution.

Root must fully read the exact v1-to-v2 source/recipe differences before the
finite controls/gates/build grant. No oracle exemption/bump, source-scope
expansion, Git mutation, executable test/gate, runtime or trace was performed.
The previous anticipated verdict-signal line is removed structurally, not
waived; the real committed-diff verdict gate remains pending. Q0 owns its
separate finite cheap lease. Publication and semantic PR 6435 remain distinct.

### 2026-10-05 — actual disjoint main integration and maintained format freeze

Root authorized normal private-worktree main integration and scoped maintained
formatting, but retained the serialized heavy lease with DataView. Actual
server main reread 0745a1 remained 27b18d375f0c446fcd5662056a35261db9881f7b.
Normal fetch 541330 succeeded; actual delta inspection ec89c4 confirmed only
the reviewed nine benchmark paths and zero src/scripts/test/owned-MD changes.
Normal git merge --ff-only upstream/main then succeeded (b8939b). Own branch
and all four owned dirty/new files remain preserved. No other worktree, IR,
semantic source, status, claim, configuration or remote branch was changed.

The initial maintained formatter command encountered filesystem EPERM because
this managed worktree lives outside the sandbox's primary writable root
(446842); it did not write either leaf. The identical formatter was run with
normal filesystem approval, not a configuration/hook bypass, and succeeded
(a632b2). The maintained .prettierignore explicitly ignores test262-worker.mjs;
its source stays be06c73b7ef501985d39313d3c52691d90d5067899225dbc1431e11858e4a233.
The two new private leaves were formatted normally. Changes are whitespace,
line wrapping and equivalent identifier-key quoting only, with all controls,
literal sources, admission keys, bounds and observation logic retained.
Their actual hashes are f4e842b98f6f4a37ac57aa12702a93769c3978f97efa89ae9c6c978274f48461
and 6aed93f55345804a19fe23569418d53bca64994ef569cfcf8e325ce4b3d1d235.
Existing Biome include globs are TS-only; neither normal configuration was
overridden to manufacture lint coverage. Actual normal lint/gate outcomes
remain pending and must disclose that maintained coverage accurately.

Read-only freeze 521572 rehashed all 1852 prior preparation inputs on integrated
HEAD. Only the worker and two owned leaves differ from v1; all other inputs,
including all 1826 src files and harness texts, retain their old hashes. The
current input manifest SHA256 is
c0d6204ae290a7218794b9b7048df92fa5320a26df5eb003afc998c1d08a6a24.
Preparation/off-on recipe v3 copies change only these two formatter hashes
and fresh exclusive preparation/observation receipt directory references.
Actual source-only recipe SHA256 values are
24059561e31fe191b86d5f9f429177ab67be754adeb8555cf3cd8f09967b4b14
and d93b6a9aafb2e315b3c6e4be3cc63c6893aa036a2869ebac0c28e57ff9b9271c.
All old receipts/recipes remain preserved. No asserted cache identity or stale
provider metadata is substituted for actual normal builder selection.

No builtin control, native preparation, matched runtime pair, gate, hook,
staging, commit, push or PR was run under this source-only permission. DataView
must explicitly yield its heavy lease before the root-authorized finite
validation/publication sequence starts. Final-source v3 validation is pending;
earlier v1 controls/pairs remain historical evidence, not current-source credit.

### 2026-10-05 — actual final-source controls and supplemental matched pairs

DataView explicitly yielded its heavy publication lease after publishing
separate component PR 6483. Root granted this observer's finite normal
validation/publication sequence. Fresh server/main audit a29c80/d9ce0c/81921d
confirmed f41a11059ccc7f646ae907d6b992b7dc50509938 differs from the previously
integrated base only in six benchmark JSON files. Private normal FF be56c4
preserved all source and harness pins. Nineteen complete paginated current PR
file lists (26d951/6a34e5) still have no positive observer-hunk collision;
6468's sole worker intersection remains the unchanged fixture-graph patch.
The actual maintained held leaf still identifies this exact owner/branch.
Actual commit.gpgsign and user.signingkey are unset; author remains Thomas
Tränkler <git@thomas.traenkler.com>. No signing/config override was introduced.

Important population clarification: these eleven pinned assemblies are
SUPPLEMENTAL DIAGNOSTIC SOURCES from the existing issue fixture, not physical
Test262 original files. Prior history's unchanged/original bodies means the
literal pre-existing fixture bodies were preserved; it must not be read as
eleven original Test262 conformance cases. No original pass or conformance
gain, sixty-seven-row rerun or promotion of semantic PR 6435 is claimed.

Canonical Node v24.19.0 / 1024 builtin controls actually completed 2a77d7:
eleven top-level tests, eleven PASS, zero FAIL/skip/cancel/todo, 100.834875ms.
All worker/leaf/test and three harness before-after hashes matched (5bc6cb).
Retained actual TAP .tmp/2929-n1/controls-publication-v4.tap has SHA256
fd02f8ad015584244a49a0aa0ddda8f6664509823301096b707dea8a8827e795.
This validates the final default-argument/VM lexical binding and formatting,
not merely the earlier v1 implementation.

Normal four-command preparation ran once in session 15680 (338280/9f0688),
2026-10-04 23:32:03.011–23:32:05.771 UTC, all exits zero. Compiler/runtime
bundles were built normally. The maintained refusal-first/native builder
measured cache HIT under current actual provenance, then --require-full-cache
performed real canary verification. Actual compiler key a821fdc2f3d4671f,
provider key 2dd35d72b70e8940, worker bundle d0d456fe73351a58 and all three
binary SHA256 values remain unchanged; all 1852 preparation inputs matched
afterward. No key assertion, stale metadata override, provider tracing or
manual init/replay was used. V4 recipe copies changed only actual main and
exclusive output paths; their hashes are cbad0f5549197454de30421ed173d2e69832d19a6934cdb89b36057cdd13218f
and f2e3a0941959186e3b91e86809bc66d42acd0a9ca0c395d26646eefb1e347eb6.

Ordinary fixed pool1/unified matched supplemental off11 then on11 ran once
in session 42135 (e277e9/2a977b), interpreter/FULL, canonical Node/3072,
unchanged literal fixture bodies/options and 30000ms timeout. True terminal
exit zero: twenty-two complete actual responses; fresh off = 4 PASS / 7 FAIL,
fresh on = 4 PASS / 7 FAIL; eleven canonical pairs and eleven source/Wasm pairs
identical; all eleven complete observer fields retained through the ordinary
parent; diagnostic own key absent on all off rows; all input/binary pins match.
A separate read-only comparison (e3c55b) rechecked all twenty-two raw response
rows, all canonical pairs and all twenty-two Wasm artifact hashes.

Each six-C diagnostic was read independently again: deferred-module-init,
consumer instance, actual Wasm exception, __exn_tag, successful existing getArg,
non-null object payload, consumer-native STRING undefined and canonical
consumer-native text; one invocation/nine events each. No peer was visited.
Provider stage/instruction, payload origin/brand remain UNRESOLVED. Neither
primitive undefined nor tag-read failure is inferred from that rendered text.

Retained v4 preparation contract/command terminals/prepared artifact receipts
have SHA256 bfb2abf8ad81efcedb2dc00bbeec4d6e1d41da6e5ec4e49e37968d589cdbd219,
05bc4b5773e53bec99c9c339d0bbdbcba737146432ae5b7eecb56a742b639b2e and
a6010f860fd14fc46f7a9fb028cce08b5cca3af56a878549c7973101d375fa94.
Matched v4 terminal/manifest/off rows/on rows have SHA256
b47699dfcd1060c9e72f319a4be66001d949120f9822b016ecede96440e5ef2f,
b980961147a748744adae5569eeecd7d52e349453fb380445d880878d6865d3e,
6d1ac832649bc81e0e6bba6aad033802f3b9d5214f8c3f26645397032fba36e9 and
4a3ee46ccdabd7dd9c5b3bdca1f166f879e23c81752a5c0687035cf40c65feef.
All old evidence remains preserved. The runtime batch has stopped; normal
publication gates/hooks and committed-diff checks are separate and still
pending at this dated receipt, without semantic source/scope expansion.

### 2026-10-05 — actual normal local publication gate terminal

The finite serial local gate batch used canonical Node v24.19.0 / 3072,
original PATH and actual integrated f41a11059ccc7f646ae907d6b992b7dc50509938
in session 93076 (c614f4/27bd07/20d182). All fourteen commands exited zero,
2026-10-04 23:35:09.505–23:36:54.280 UTC: scoped maintained Prettier,
scoped maintained Biome, typecheck, lint, whole-tree format:check,
LOC/function budgets, import cycles, orphaned scripts, tracked-ignored,
oracle/coercion ratchets, issues (including IR optimization retirement) and
conformance-doc synchronization. The final three source pins match unchanged.
All actual stdout/stderr and per-command terminals are retained under
.tmp/2929-n1/gates-publication-v4, including its complete terminal.json.

Coverage is explicit: maintained Prettier ignores the worker but checks both
formatted private leaves; maintained Biome's TS-only include matches zero
scoped mjs files. Its zero exit is not mjs lint coverage. The separate eleven
builtin controls and actual matched supplemental runtime responses are the
executed coverage for this component. No configuration/ignore override was
used, and all ordinary hooks remain enabled. Full CI quality/runtime jobs
remain separate from this finite local gate batch, not claimed as already green.

Normal staging/commit, standard commit/push hooks and the real committed-diff
issue/verdict/integrity checks follow only under the existing publication grant.
No empty precommit diff is substituted for those checks. Root's original-source
and semantic restrictions remain: four owned files only; no oracle exemption
or bump; supplemental diagnostic inputs rather than physical Test262 originals;
zero original conformance credit; unresolved provider stage/origin; no guard-67
rerun or semantic PR 6435 promotion. The broader issue stays in-progress.
