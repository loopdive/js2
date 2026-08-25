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
