---
id: 7139
title: "IR: lower native dynamic instanceof with complete prototype demand"
status: in-progress
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
parent: 3518
depends_on: [7138]
related: [6457, 6845, 7121, 2026]
assignee: "ttraenkler/codex-session-b"
---

## Problem and measured base

Reserved atomically with a complete open-PR scan on upstream/issue-assignments;
base is the published member boundary head
`5479dca8464ecabe0c5a26b562123131798b65e7` (PR 6879).
A separate read-only control checkout is exact main
`2fe8c1e0d5bd46adc071f484db4b0bdc8a2d54dd`.

For same-layout classes C and D, `check(o: any, K: any) { return o instanceof
K ? 1 : 0; }`, called as C/C + 10*D/C + 100*D/D, answers **0 instead of 101**
on both bases, standalone and WASI, with experimental IR disabled and enabled.
The check and caller remain legacy-owned (body-shape-rejected) even with IR on.
An explicit `K.prototype` read restores standalone on main and both native
targets on the member base. This is a missing implicit resource demand, not a
regression attributed to the member changes. Raw paired probes are retained in
the member and main audit worktrees under `.tmp/7138-dynamic-class-rhs-audit.*`.

## Implementation Plan

1. Audit the shared native operator, ordinary-instance test, class prototype
   demand and their finalize order. Register implicit prototype consumption at
   the canonical native runtime owner, before idempotent reuse, guarded so the
   standard JS boundary resource graph remains unchanged.
2. Measure positive/negative class identities, inheritance, primitives and
   invalid RHS/prototype cases, custom Symbol.hasInstance and effects. Existing
   comments describing partial behavior are not correctness evidence.
3. Integrate a typed IR producer/provider through the existing native physical
   parameter proof and ProgramAbiMap. Reuse canonical runtime semantics and the
   Wasm TypeError owner; no direct AST body semantics, permissive fallback or
   duplicate instanceof algorithm. Generic any-RHS admission must stay closed
   until its actual runtime protocol is qualified. Audit class-value producers
   rather than assuming a class identifier has an IR binding.
4. Qualify actual IR ownership, values/order/error identity, default/i32 native
   targets, exact-base regressions, and standard gc byte identity. Run quality
   gates against current upstream main, with no baseline changes.
5. Publish the isolated dependent PR and obtain fresh-context adversarial review
   before readiness/release. Preserve predecessor heads, HOLDs, queues and tests.

## Acceptance

- [x] Implicit native class prototype demand fixes the measured direct case.
- [x] Canonical dynamic operator protocol and meaningful negative controls pass for actual native carriers.
- [ ] Supported producer/check/caller units use IR with exact provider evidence.
- [ ] Exact-base, byte identity, source gates and limitations recorded.
- [ ] PR and independent review recorded.

## Scope

Native IR/shared runtime only. Closed issue 6457 supplied explicit prototype
reads; 6845 is a separate JS-host scope. C retains Number/harness providers and
its static self-guarded function-constructor lane. This issue does not claim full
IR migration, strict closure, handler retirement or Test262 population gains.

## Qualified shared-runtime prerequisite, 2026-10-22

The canonical native dynamic helper records class prototype demand before its
idempotent return. The class arm of the existing closure/prototype identity edge
uses the canonical `__extern_get(target, "prototype")` after matching the exact
class singleton. That getter invokes the existing lazy builder, preserving its
methods, constructor identity and parent chain. No second prototype object or
algorithm is introduced. Resolving a builder index directly during the edge's
fill was rejected: multi-source fills that edge before it mints builders. The
runtime Get delegation passes both pipelines without changing finalize order.

The demand set's readers were enumerated: class prototype/instance lookup,
prototype-read arms, static sidecars/builders and instance proto arms. Its
mutators are monotonic per compilation; no program-order snapshot is lost.
`hostFreeEnvironment` guards both new demand and delegation so the JS boundary
retains its resource graph. The pre-existing primitive-classifier sequence was
moved intact to a module helper to keep the native helper under its size limit.
No source budget grant or baseline was added.

Qualification on the final source:

- **62/62** across six files: the new 18 native controls plus dynamic residual,
  constructor-name shadow, error-family, class-instance collision and
  Symbol.hasInstance suites. **18/18** separately with i32 enabled.
- The identical new 18-test file on exact dependency parent `5479dca846`
  gives **14 failures / four passing primitive-left controls out of 18**.
- **14/14** successful standard gc binaries byte-identical against that exact
  parent: arithmetic, strings, static classes, dynamic class and function
  instanceof, source effects and compileMulti, each IR off/on. This is a bounded
  byte corpus, not a full equivalence claim.
- Typecheck, lint, current-main LOC/function budgets, coercion vocabulary,
  checker-oracle ratchet, import cycles and IR layering pass. Cycle allowances
  belong to the existing console prerequisite; this change introduces none.
  Dead-export preservation passes; strict closure remains OPEN for the two
  existing nonliteral imports in optimize.ts/platform-capability-adapter.ts.
- Raw logs in the own `.tmp/`: `7139-instanceof-final.log`, `7139-i32.log`,
  `7139-gc-bytes.jsonl`, `7139-typecheck-final.log`, `7139-func-final.log`,
  `7139-cycles-final.log`, `7139-lint.log`. Same byte script/JSON and before-test
  log are retained in the parent worktree. Early failed probes and the rejected
  direct-builder/finalize-order variants remain as diagnostics, not successes.

## Resource-only protocol census (before the operator follow-up)

A separate 22-shape / two-native-target probe runs actual Node oracles and records
**44 rows** on exact main `2fe8c1e0d5` and on the candidate. On the measured
candidate **19/44** match the oracle; the only changed outcomes against main are
six corrected class identity/memberless/inheritance rows (0 to 101/11). This
probe's check function is still legacy-owned. It does not certify generic IR
admission. Both raw JSONL logs are preserved in the audit and own worktrees.

Remaining failures include dynamic invalid RHS values answering false instead
of throwing TypeError, custom hasInstance dispatch, WASI function/builtin
identities, and a call-expression RHS whose effect is omitted by a legacy
static arm. The general IR selector stays closed; the production direct AST
body emitters remain untouched. The successful resource-only prerequisite must
not be described as completing this issue or the migration epic. Continue with
canonical operator/error semantics and exact IR provider/producer evidence;
never hide these failures by adding explicit prototype reads to programs.

## Native operator / IR follow-up, 2026-10-22

Resource prerequisite PR 6881 remains at exact published head
`b4776f6cc3b102a427316e8e44a7d5fab3f10f99`. Its CI run was still in progress
when the follow-up began; the new branch
`codex/7139-ir-native-instanceof-operator-20261022` preserves that head and all
predecessor HOLDs, queues and tests. Fetched main is
`dc3a066330a47f210632f507189849846d24e752`; its changes after `2fe8c1e0d5`
are artifacts/baselines, with no `src/` difference.

### Structure and code-quality criterion

- `native-dynamic-instanceof.ts` owns the full shared native operator and
  OrdinaryHasInstance. It reuses canonical Get, IsCallable, Call/argument-vector,
  ToBoolean and prototype walking. Bound targets delegate through the same full
  operator; their dispatcher reserves its slot early and fills it after carrier
  registration. No new body is minted at finalization.
- `ir/native-instanceof.ts` evaluates the already lowered operands through the
  exact runtime provider, consumes its 0/1/2 result and emits the shared native
  TypeError on 2. `ir/native-errors.ts` factors the identical error construction
  out of native `in` and function-object lowering as well. No new opcode,
  parallel property protocol or AST body semantic arm is added.
- Native dynamic-operand admission reuses the physical externref certificate;
  source expressions evaluate once, left then right, before RHS validation.
  Static/concrete operand admission and class/builtin value producers remain
  separate unfinished migration work.
- `dyn-ops.ts` observes the operator through the existing provider registry.
  Its generic observer is the same owner already extended in own PR 6878 for
  dynamic addition; integration must retain both needs when the branches join.
- The exact allocator provider registry exposes its live signature. The existing
  Program ABI declaration projection adds observed runtime signatures without
  replacing logical/nominal contracts. A final verifier pass after provider
  registration checks them before component sealing or body emission, including
  async state buffers. Only direct runtime calls receive this physical signature
  projection; intrinsic calls retain their semantic adapter contracts. This removes the gap where a malformed single call was
  only detected by the Wasm engine after binary generation.
- `object-ops.ts` changes only the existing accessor-value ABI choice to the
  canonical no-JS-host predicate. WASI now uses the same native closure carrier
  as standalone. The import collector uses the matching guard. The getter
  tests require zero imports outside `wasi_snapshot_preview1` and run the real
  Node WASI adapter; a supplied host getter stub is not accepted as evidence.

Quality acceptance: one shared operator/error/projection owner; unchanged JS
boundary bytes; no new size/cycle allowance, baseline change, direct AST body
semantics or duplicate helper registry. Fresh-context adversarial review must
check these claims before readiness/release.

### Measured evidence

- New actual-carrier protocol suite: **50/50** behavior tests across standalone
  and WASI. Class identities, primitive left operands, real TypeError/RangeError
  identity, invalid RHS/handler/prototype, exact getter counts, bound and
  bound-of-bound handlers, handler receiver/argument/ToBoolean, operand order
  and exception order are executed.
- Five checker/forward/operand functions are explicitly IR-owned with zero
  direct-body emissions. Some factory and error-classification helpers remain
  legacy-owned; this is not whole-program IR-only qualification.
- Four malformed-call injections (arity and argument carrier, both targets) now fail in verifier stage with
  **zero binary bytes**, no legacy body and no IR body. Together with declaration
  controls, **86/86** tests pass. Provider-discovery and Date-adapter controls
  bring that group to **95/95**. Before the final provider verification the
  arity injections failed: the compiler returned failure but retained an invalid
  binary, so that intermediate implementation was rejected.
- **258/258** neighboring tests pass across unsigned members, numeric class
  domains, native `in`, function-object evidence/stage 2, public hasInstance,
  custom handlers and the resource prerequisite. **72/72** protocol/resource
  tests pass with the i32 domain enabled.
- **14/14** bounded standard gc binaries remain byte-identical to b477's
  resource baseline (the same corpus was also identical to dependency 5479).
- Exact b477 before-control with the original 44 protocol rows plus five public
  descriptor/method controls: **13 failed, 14 passed, 22 skipped out of 49**.
  WASI beforeAll rejects the old host getter import; its 22 skipped cases are
  unmeasured, not claimed failures. The two descriptor tests also fail on b477
  because their empty import object lacks the existing runtime-eval namespace.
  These old failures are retained separately from the passing protocol suite.
- Raw logs are retained under own `.tmp/`: `7139-provider-post-registration-tests.log`,
  `7139-registered-provider-regressions.log`, `7139-provider-i32-tests.log`,
  `7139-provider-gc-bytes.jsonl`, `7139-early-arity-verified.log`. The exact-parent
  log is retained in the audit checkout as `7139-protocol-exact-parent-tests.log`.

### Remaining full-program failures

The corrected-start 44-program census improves from **19/44** oracle matches
on b477 to **35/44** on the operator candidate. Nine rows remain wrong: the
legacy static RHS arm omits an operand call (two targets), WASI ordinary-function
and builtin-constructor producers, computed-literal custom-handler producers
(two targets), standalone static null-prototype vivification, and static class
custom-handler producers (two targets). Raw before/after logs retain all rows;
there is no Test262 population claim. Issue 7139 and migration epic 3518 remain
in progress until the missing producers/callers and the epic's full acceptance
are qualified. C's held dyn.instanceof lane is recorded in coordination comment
6348051966; do not rewrite or take over that branch.

### Adversarial review and corrections

A fresh-context read-only review found four blockers: a bound dispatcher left
unfilled without a separate custom-handler demand; wrong scalar argument
carriers reaching backend validation; native prototype returns followed by
unreachable compatibility instructions; and duplicate binary-probe reservation
code. It also found the missing TypeError for a Symbol prototype. All were fixed
and covered by actual native controls. The ordinary helper now registers the
full operator after publishing its own slot, and reciprocal registration
rechecks the completed operator rather than minting it twice. Binary probes
share one reserve function; native and compatibility bodies are chosen at
generation time.

The shared declared-call rule now checks known argument carrier kinds and
accepts safe non-null-result widening into a nullable reference slot; the reverse
narrowing has its own negative control. This preserves the existing native Map
provider and intrinsic adapter boundary. Repeated post-hygiene/inline/mono
verification failure construction is shared to stay within both size budgets.
The canonical helper is also exposed by its existing compatibility barrel so
source-validation contract tests retain their exact export identity.

The reviewer rechecked all fixes and independently ran **86/86** protocol and
declaration/global tests: **no blocking findings remain**. This verdict covers
the reviewed local source, not full-program IR coverage or corpus-wide parity.
Review notes and the reviewer's own execution log are retained in `.tmp/`.

The broader async ownership/source-preservation group has **nine existing
failures**, with the same failure names and assertion texts on exact b477 and
the operator candidate. The newly discovered Map-result false rejection was
fixed; the provider-discovery test now passes. The existing two descriptor
failures remain outside the positive protocol denominator. Dead-export strict
closure is still open; no retirement/deletion certification is claimed.

### Final local qualification before publication

Typecheck, full lint, default and explicit-dc3 LOC/function budgets, coercion and
oracle ratchets, import cycles, IR layering, flat-directory and retirement-policy
checks pass. No new allowance or baseline was added. Stable-source dead-export
preservation passes 6/6 full and cut witnesses; strict closure remains open for
the two previously recorded nonliteral imports. One intermediate preservation
run saw source movement during execution and was discarded; the retained
stable-source log is `7139-preservation-stable-source.log`.

Final source/compatibility-barrel plus protocol tests pass **107/107**. The
reviewed 44-program census still records **35/44** matches with the same nine
remaining rows (`7139-reviewed-program-census.jsonl`). The independent reviewer
log is `review7139-recheck.log`; final standard byte evidence is
`7139-closed-review-gc-bytes.jsonl`; i32 evidence is
`7139-closed-review-i32.log` (**72/72**).

## Class-value lifecycle follow-up, exact parent 4e325e2f81

The next unpublished branch is
`codex/7139-ir-native-instanceof-values-20261022`; PR 6882 remains unchanged at
`4e325e2f81a9240f8e3f87a3fdab4eed5a11ff6e`. This is further work on the open
issue, not completion of its producer/caller acceptance.

A Node-oracle / real native-start audit of **16 source forms × two targets =
32 rows** found **20/32** correct values and **12/32** wrong values. All 32
sources compile; the wrong rows are not compile failures or missing host
imports. The six wrong forms fail on both standalone and WASI:

| Source form | JavaScript | Current native |
| --- | ---: | ---: |
| Effectful two-operand class check |112|101|
| Repeated uncaptured nested class evaluation, identity equality |0|1|
| Repeated captured nested class evaluation, identity equality |0|1|
| Read class through a function before its declaration; catch ReferenceError |1|10 (no throw)|
| Reassign class binding, then read it through a function |1|10 (old value)|
| Assign null to class binding, then read it through a function |1|0 (old value)|

The 20 matching rows include returned/aliased/forwarded classes, same-layout
negative identity, explicit/inferred returns, parameter shadowing, post-definition
initialization and prototype identity. They still do not prove IR migration:
class-producing functions remain rejected by selection, and even the matching
shadow control retains a direct body before its IR overlay.

`tests/issue-7139-ir-class-value-lifecycle.test.ts` and its 16-case fixture make
this a positive acceptance suite, not a test pinning an old bail. They assert 16
independent JavaScript oracles, 32 actual native values and 32 source-function
ownership controls. **Current red baseline: 44 failed / 36 passed out of 80**:
12 semantic failures + 32 IR-only ownership failures; the 36 passes are 16 Node
oracles + 20 native values. These tests are unfinished work and must not be
presented as passing or published in the operator PR. Raw 32-row provenance is
`.tmp/7139-class-values-base-4e325.jsonl`; suite output is
`.tmp/7139-class-value-lifecycle-baseline-tests.log`.

### Revised implementation constraints from the counterexamples

A direct `global.get __class_C`, or a wrapper that merely calls
`emitLazyClassObjectGet`, is insufficient as the general class-value producer.
The existing runtime singleton is the canonical materializer for a stable
class evaluation, but **the source binding is not a constant singleton**. A
new IR arm must not copy the current TDZ, reassignment or repeated-evaluation
bugs into the prepared program.

1. Reuse the existing exact class projection / checker symbol join in
   `ir/module-bindings.ts` and `ir-class-shapes.ts`. Do not create a second
   name-based class resolver. The current identity resolver deliberately models
   instance expressions, rejecting constructor signatures; any extension must
   distinguish instance and constructor values explicitly and preserve source,
   declaration, ClassId and shadow checks.
2. Model the lexical source binding and its initialization/write state through
   the existing module/local binding owners. `IrModuleBindingIdentity` currently
   covers VariableDeclaration only. Class value reads cannot bypass TDZ or
   mutable binding storage through a constant class-shape lookup. A class
   definition that affects observable value state must remain in the executable
   source population / prepared program; no new module-init exception.
3. Materialization retains one canonical native semantic owner. Static
   top-level singleton transport can reuse its existing runtime algorithm,
   with exact Program ABI callable/global observations. Repeated class
   definition evaluation needs fresh constructor/prototype identity and a
   retained lexical environment; it cannot reuse the same per-declaration
   global on every activation. Preserve the relationship between Construct,
   prototype Get, methods and captured source cells.
4. The prepared IR must carry every value/binding/effect dependency and exact
   source/class identity before backend emission. Runtime registration may
   allocate representation resources, but may not reconstruct source AST or
   infer an owner from a helper/global display name. Both backends consume
   that same semantic plan; unsupported backend capability is typed.
5. Reuse existing native value boxing / direct-call ABI owners for constructor
   values and operands. No second tag decision tree: `boxConcreteToDynamic`
   and the native `in` key boundary already cover overlapping families and
   must be reconciled before adding another boxer. Primitive concrete operands
   are also still missing from native `instanceof` admission; retain these in
   the open full operator/producer scope.
6. Keep the known first-class class identities, initialization/capture controls,
   mutable bindings, source-order operands, i32 domains, exact-parent controls
   and standard gc bytes in qualification. New capability admission requires
   real carrier evidence; an any annotation, a same-spelled class or a new bail
   assertion is insufficient. Preserve all public PR heads while work is local.

The goal remains the full acceptance of epic 3518, including one portable
PreparedIrProgram, both backends, source-located Unsupported, one production
policy and direct frontend deletion. The 32-row audit neither reduces that
scope nor claims classes complete.

### Concrete operand transport follow-up (local, 2026-10-22)

The class-binding extraction first moves the existing exact instance resolver
into `ir/class-binding-resolution.ts`; the compatibility module reexports it.
Shared planning invariant errors and parenthesis traversal have one owner.
The class-value lifecycle acceptance stays red until executable binding and
class-evaluation state is implemented. No class singleton read is admitted.

A separately measured operator step reuses the native `in` value adapter as
`ir/native-value-carrier.ts`, shared by `in` and `instanceof`, rather than
adding a third boxing decision tree. The source-expression evidence belongs
in the existing `select-expression-structure.ts` and is consumed by both
selection walks. Lowering retains existing exact static plans, then uses the
actual SSA operand types instead of predicting dynamic syntax a second time. Admit a primitive/null operand only when the
other operand has the existing native dynamic carrier proof. Preserve static
constructor and wrapper routes. Test real standalone/WASI execution, both
operand orders, error timing and exact IR body ownership; qualify the i32
domain and existing protocol/`in` controls. Quality acceptance: no duplicate
boxing implementation, no added direct AST semantics, no budget grants, and
no change to standard gc bytes. This does not complete class value producers
or the full migration.

### Concrete operand checkpoint qualification (2026-10-22)

The local child now admits native dynamic/primitive pairs, shares the native
value adapter with `in`, and preserves signed/unsigned numeric values through
`coerceIrNumeric`. Both operands evaluate once before operator validation.
Lowering consumes actual SSA types after exact static plans are considered;
it does not repeat selection's dynamic-expression prediction.

Fresh-context adversarial review found a logical-operand selection/build
mismatch and a prepared-support gap that emitted both bodies for logical /
`typeof` operands. Both are fixed. The existing `unitExternref` certificate
now covers truthy/typeof/strict-equality sidecars without requiring an unrelated
function-object call; exact physical provider signature checks remain intact.
Independent re-review reports no blocking correctness/quality findings, with
7/7 identity/extraction tests plus native logical/typeof/equality, unsigned
carrier and exception-order probes. Evidence: `.tmp/review-concrete-*.log`.

Executed qualification (overlapping groups are stated separately):

- 255/255 tests across concrete operands (70), complete protocol (54), native
  `in` (48), resource demand (18), exact class identity (4), source validation
  (53) and compatibility dynamic support (8).
- Native unsigned-member/numeric-domain neighbors: 151/151.
- i32 domain: concrete/protocol/native-`in` 172/172.
- Standard gc corpus: 14/14 exact-parent byte hashes unchanged.
- Older module-binding suite: final candidate and exact parent both have
  41/55 passes and the same fourteen failing names and full assertion texts.
- Typecheck, configured Biome lint (7319 files), default and explicit `dc3`
  size budgets, coercion/oracle/cycle/layering/flat-directory/retirement gates
  pass. No new grants, baseline edits or direct AST semantic arms.
- Preservation audit passes 6/6 full and cut source witnesses. Strict closure
  remains open for the two inherited nonliteral dynamic imports; deletion is
  not certified. An attempted ESLint invocation found no ESLint configuration;
  it is not a qualification result. The configured Biome command passes.

The full class-value lifecycle suite was rerun: **38/80 pass, 42/80 fail**.
All twelve native value failures remain, alongside thirty IR ownership
failures. The shadow-value case gains sole IR ownership from the corrected
strict-equality support; no class producer semantics are claimed complete.
The class-instance resolver extraction preserves its old symbol/source/ClassId
checks and deliberately introduces no constructor-binding singleton shortcut.
The published operator head and all held predecessor heads remain unchanged;
this is an unpublished local implementation checkpoint under the full goal.

### Class lexical binding identity plan (2026-10-22)

Native JavaScript controls establish two different source bindings for a named
class declaration: the mutable outer lexical binding and the immutable inner
class-name binding retained by methods/closures. Reassigning the outer name
does not change the inner constructor; an inner assignment throws TypeError.
Named class expressions own only their inner class-name binding; the receiving
variable stays with the ordinary variable-binding planner. Heritage and
computed-key reads of the inner name are still in TDZ.

Implement this source distinction in `ir/class-binding-resolution.ts`, sharing
the existing exact symbol/declaration/ClassId join with instance resolution.
The complete class record validator moves from codegen into the existing
planning-identity owner and is shared by the class-shape and binding planners.
The selector consumes the new exact binding evidence to report a source-located
class-value producer gap, replacing an accidental generic not-in-scope result.
It must not treat the evidence as a materialized constructor or instance,
allocate singleton storage, or admit an incomplete producer. The new resolver
will be the binding identity input to the executable class-definition plan;
module/activation storage and fresh evaluation identities remain required.

Quality acceptance: one symbol-to-class join, exact source/ClassId validation,
no source name authority or alias de-aliasing, no extra runtime registry, and
no new direct AST semantics. Test inner/outer shadowing, named expressions,
repeated nested evaluations' stable source identity, stale source/class maps,
ambiguous declarations and source-located capability outcomes. Preserve the
full lifecycle red suite; a new refusal code is not semantic completion.

Adversarial identity review found that diagnostics-off symbols may separate
class/variable collisions, merge class/function collisions, and split duplicate
classes across switch clauses. Resolve ambiguity from the enclosing statement
list (all switch clauses share one CaseBlock), including hoisted `var` and
function-body/catch parameters. Reuse the existing pure AST binding-pattern
collector and function-scope boundary predicate in `analysis/ast-scope.ts`; do
not introduce another destructuring walk. Runtime value declarations in a
merged checker symbol disqualify the shared class join; type-only merges and
namespace augmentation do not establish a second class identity. Test genuine
block shadows and type/interface merges alongside the rejected collisions.

The bare identifier selection arm is split from the oversized expression
selector without changing arm ordering. The paired exact/compatibility shape projections
are grouped in `codegen/ir-class-shapes.ts`, retaining the same provisional
population; resolver factories keep their original order in `planIrOverlay`.
This avoids an added value-import edge while shrinking that function. Neither
oversized function receives a growth allowance.

### Class binding identity checkpoint qualification (2026-10-22)

The resolver distinguishes mutable declaration bindings from immutable inner
class-name bindings, using exact source/ClassId/declaration records. It refuses
diagnostics-off value collisions across a shared lexical scope, including
variables/destructuring, functions, imports, enums, switch clauses, hoisted
`var`, and function/catch parameters. Valid block shadows and interface or
namespace augmentation retain identity. The old instance resolver still rejects
constructor objects. The selector now reports the producer gap before claim;
this is binding metadata and diagnostic work, not executable class semantics.

Fresh-context adversarial review found the scope and enum gaps above; all were
fixed and re-reviewed. Independent qualification: 100/100 targeted assertions
plus extra scope and instance probes, and a token comparison of the extracted
identifier arm. Evidence: `.tmp/review-class-binding-identity/`. The attempted
resolver grouping added a codegen-to-IR value edge and failed the cycle gate;
the final grouping contains only shape projections and preserves factory order.
No new size or cycle allowances were added.

Executed checks (groups overlap and are not summed as distinct coverage):

- Identity/outcome controls: 37/37; the combined seven-file native operator,
  identity and source-validation run: 224/224.
- i32 native concrete/protocol/`in`: 172/172.
- Standard gc corpus: 14/14 byte-identical to the exact parent checkpoint.
- Older module-binding suite: 41/55 pass, the same fourteen failing names and
  full assertion texts as parent `7165772057a6a39057fdb6ace67e88f63850fb14`.
- Full class-value lifecycle suite remains **38/80 pass, 42/80 fail**: twelve
  native value failures and thirty sole-IR-ownership failures.
- Typecheck, configured Biome lint, default/explicit-main-base size gates,
  coercion/oracle/cycle/layering/flat-directory/retirement checks pass. The
  preservation audit passes 6/6 full and cut witnesses; its strict closure is
  still open for the two inherited nonliteral dynamic imports.

Additional six-source/two-target class-name probes agree with JavaScript for
inner reads/writes (6/12 native value rows); heritage, computed-key and `typeof`
TDZ probes remain wrong (6/12 rows return 10 instead of ReferenceError result 1).
All twelve `run` functions remain legacy-owned. The updated probe instantiates
with only WASI imports and records actual module imports, which are empty for
all twelve binaries. The computed-key WASI compile nevertheless reports a
forbidden `env.__to_property_key` diagnostic while `success` is true; that row
is explicitly unqualified. Raw evidence: `.tmp/7139-class-inner-semantics-native.jsonl`.

The next required work remains executable class-definition state, source
binding storage/TDZ, fresh evaluation identity and retained lexical environments
through the canonical runtime and PreparedIrProgram. The lifecycle denominator
and the full IR migration acceptance remain unchanged. This checkpoint stays
local; published PR heads and HOLDs are unchanged.

### Executable class evaluation foundation (2026-10-22)

Fresh-context architecture review confirms that a fresh instance-shaped
struct is not a class constructor: existing compatibility runtime readers
identify constructors through singleton globals. The target producer instead
uses the canonical source-closure header, a private Construct-closure payload,
a per-evaluation bag/prototype and retained lexical cells. The concrete design
is retained in `.tmp/7139-class-evaluation-design.md`; the full lifecycle
acceptance remains required, including actual method capture values rather
than only distinct returned constructor identities.

First remove the fixed-prototype limitation in the existing realm-state
allocator: `runtime/wasmgc/values/realm-object-layouts.ts` owns one explicit
prototype state-allocation body. `backend/wasmgc/resources/native-realm-object-layouts.ts`
declares/reserves/fills that helper and the existing source initializer delegates
to it using its canonical function prototype anchor. No duplicate state layout,
prototype registry or source-closure capture implementation is introduced. The
new helper permits null as an explicit prototype operand while requiring an
initialized realm; it does not validate ClassHeritage or certify intrinsic
population. Test fresh states, retained prototype operands, null, independent
realms, displaced reservations, canonical fill/header tampering and genuine
source closure execution. Update all issuer token/completion/inventory checks
for both initializer slots.

This is a shared executable runtime prerequisite, not the accepted class-value
vertical milestone. Class lowering, both source bindings, constructor dispatch,
prototype descriptors, retained method captures and source M0 work remain open.
The full goal also requires true linear execution: target `wasi` here still uses
WasmGC and is not proof of the linear consumer.

The original sixteen-case/eighty-assertion lifecycle population is retained.
Four added sources exercise actual retained method calls, mutable independent
captures, fresh prototype identity and cross-evaluation instanceof. Separate
assertions inspect the exhaustive class-unit route census and physical class
walker entries; function-name checks alone did not cover class members/support.
Fatal compile diagnostics are now asserted independently of `success`, following
the measured computed-key WASI diagnostic inconsistency. Report original and
added populations separately; no runtime gains are attributed to this harness
change.

### Explicit-prototype realm-state checkpoint qualification (2026-10-22)

The canonical realm-state allocator now accepts the evaluated prototype operand;
the existing genuine source-closure initializer delegates with its function
prototype anchor. Both helpers participate in reservation authentication,
canonical completion and inventory. Calls retain stable function handles even
when imports displace physical indices. This changes state allocation plumbing,
not class-definition execution or heritage validation.

Fresh-context adversarial review found no remaining blocking correctness,
ownership or code-quality findings after the negative-header assertions were
corrected. Independent checks: 41/41 allocator tests; 74/74 adjacent source,
requirements and wrapper tests; an imported-index probe covering eight exact
prototype operands, fresh state, retained realm identity after reinitialization,
null anchors and signature tampering. Evidence is retained under
`.tmp/review-class-realm-state-*.log`.

Executed qualification (overlapping groups are not summed):

- Root realm/source/declaration controls: 91/91 across three files.
- Native concrete/protocol and class identity/outcome controls: 161/161.
- Standard gc corpus: 14/14 byte-identical to parent
  `a6c229b55ffa78b4613595af94033926b602d31d`.
- Typecheck, configured Biome lint, default and explicit-main-base size gates,
  coercion/oracle/cycle/layering/flat-directory/retirement checks pass. No new
  growth grants or baseline edits. Preservation witnesses pass 6/6 full and
  cut; strict closure remains open for the two inherited nonliteral imports.
- Expanded lifecycle suite: **42/140 pass, 98/140 fail**. The original eighty
  assertions remain **38 pass, 42 fail** (twelve native values and thirty IR
  ownership assertions). Added retained-method/prototype sources contribute
  four passing JavaScript controls and sixteen native/ownership failures.
  All forty added exhaustive class-unit census assertions fail. These failures
  expose missing execution and ownership; they are not allocator regressions
  or class migration gains.

This remains an unpublished local prerequisite checkpoint. Executable class
values, lexical TDZ/cells, retained method captures, constructor dispatch,
prototype descriptors, source M0 and true linear execution remain required.
Published predecessor heads, HOLDs and the queue are unchanged.

### Executable constructor-value allocation structure (2026-10-22)

Add `class.value.new` as a fresh allocation leaf, distinct from instance
`class.new`. Its explicit inputs are the exact class Call stub binding,
caller signature, captured Construct closure, actual constructor parent and
already-populated own property bag. The result uses the existing native
`callable` boundary representation; source/template identity remains with
class-definition planning and the exact source Construct closure. The allocator
is an explicit symbolic callable dependency, never a hidden codegen singleton.

Core traversal, operand rewriting, effect/provenance checks, verification,
prepared dependency collection and generic lowering must all see the new leaf.
The existing callable/closure machinery owns signatures and captures; no new
capture walker or binding registry. A canonical runtime layout beside closure
layouts carries a private Construct-closure field and RealmObjectState. The
Construct field has a mutable reference type so it cannot structurally alias
immutable source captures or mutable integer builtin metadata. The reservation
owner authenticates both prerequisite owners and the exact issued layout/body.

Exercise real allocation and retained Construct closures, explicit prototypes,
fresh identity, callable header behavior, displaced indices and tampering. The
source frontend remains unclaimed until the complete class-definition sequence
installs descriptors, bindings/TDZ and methods correctly. This leaf alone is not
the class vertical milestone. Linear legality must report its actual missing
function-reference/closure capability rather than treating WASI as linear.

Core class node declarations now live in `core/class-nodes.ts`; shared callable
reference and semantic-body visitors replace repeated scans. Allocation
bookkeeping is shared by object, closure, class and ref-cell builders; class
allocation lowering and operand remapping have their own owners. The neutrality
verdict table must scan the canonical class module and classify the new explicit
allocation leaf. A scratch-only classification refresh must preserve
`unresolved` and `jsInCore`. The committed classification record remains
unchanged under the main-only baseline-writer rule; the resulting record-drift
gate failure must be reported until that publication dependency is resolved.
Size/function/cycle/performance limits are not changed.


### Allocation prerequisite qualification — 2026-10-22

The executable allocation leaf is locally qualified against exact parent
`dfa5a9936eea0c40e2f8dab2d18f3fa2bf4e68f0`. Its physical owner retains the
actual Construct closure, parent and own bag, authenticates declarations and
completion, and reports only `class-value-allocation-only`. Call in the test
fixture is a marker stub, not the ECMAScript class-call TypeError behavior.
The decoded variant replays the source donor before constructing the allocation
IR; it is not class-leaf codec replay. Complete Prepared publication still
refuses the leaf until exact Call/allocator ABI and resource planning exist.

- Allocation tests 8/8, callable/retention/carrier/state contracts 8/8, canonical
  class-kind population controls 5/5. Adjacent allocation/ownership/escape tests
  28/28; older native concrete/protocol/class-binding controls 128/128.
- Independent adversarial review: 208 tests across eight files pass. Initial
  codec execution without V8 exnref support failed 1/27; the required engine
  flag produces 27/27. Review and original failure logs remain in
  `.tmp/review-class-value-leaf-audit/`. Four real defect groups were fixed:
  refusal fallthrough, callable references, retained operand ownership and
  embedded signature carrier rewrites. Later state/reference hardening has
  permanent distinct-unit controls and root execution evidence.
- Standard gc corpus is 14/14 byte-identical to exact parent. Typecheck,
  configured lint, dialect, layering, cycle, flat-directory, optimization
  retirement, coercion, oracle and default/current-main LOC/function gates
  pass. The resource-data assertion shares the existing declaration owner's
  exact comparator; it introduces no new backend-to-IR edge or growth grant.
- Class lifecycle remains **42 passed / 98 failed / 140 total**. Neither full
  source class support nor true-linear execution has improved in this slice.
- Kind classification is 98 kinds, 56 neutral, 39 JS, 3 unresolved and zero
  JS-in-core in the disposable refreshed record. The committed record is
  unchanged: its ordinary gate reports record drift. In independently copied
  exact-parent/candidate trees, scratch-only record refresh leaves the same
  two frozen 85-kind historical assertions failing: parent 56/58 pass,
  candidate 59/61 pass (three additional source-population controls). Those
  assertions were retained; no history or semantic ratchet was relaxed.

Machine-readable evidence: `.tmp/7139-class-value-checkpoint-evidence.json`;
root logs `.tmp/7139-class-value-*`. Published heads, HOLDs and queue remain
unchanged. Full class-definition execution and exact Prepared admission are
required next; this checkpoint does not close the class milestone or #3518.

### Next implementation: complete Prepared class-allocation admission

Before code: extend the canonical callable catalog with one explicit
`class.value.allocate` intrinsic binding and standalone WasmGC provider. Its
policy-independent ABI is `(funcref, i32, extern, extern, extern) -> extern`;
the semantic instruction still requires a typed Construct closure. Generic
backend lowering erases that closure using the existing `emitToExternref`
boundary; the canonical WasmGC allocator authenticates the root with a cast.
This replaces the unpublished physical allocator's signature-dependent root
parameter rather than inventing overloaded runtime symbols or another root
semantic type. It makes the serialized callable ABI independent of individual
capture layouts. Actual class [[Call]]/[[Construct]] semantics remain producer
work, and this does not rename WASI into true linear.

`ir/program/native-class-value-requirements.ts` must derive exact occurrences,
allocation IDs and noncapturing lifted Call targets from the existing issued
source-closure census; it must authenticate both semantic and projected views.
`ir/program/native-class-value-setup.ts` owns the descriptive setup/ABI join.
The existing physical planner and consumer reuse these modules and the issued
class allocation resource instead of maintaining class-name lookups or a new
registry. Supplemental ABI binding reconciliation should share the existing
invocation binding path. Typed unsupported policy remains for non-WasmGC
backends; malformed targets/provenance fail before physical emission.

Qualification must execute the actual allocation instruction in a complete
Prepared program, serialize/decode it, and replay it in a fresh process without
frontend modules. Tampered Call signatures/captures, allocator identity, stale
requirements and noncanonical allocation identities must fail. The source
class frontend remains unclaimed until the full lifecycle sequence executes;
all 140 lifecycle assertions remain in scope. Quality: no duplicate semantic
walkers or comparators, no oversized-driver growth grant, no baseline edits.

The first complete-consumer test failed during actual physical construction:
source closure types had no issued realm-state owner. This is a real missing
composition dependency, not a test expectation to bypass. Extend the existing
native realm foundation with selected class-program carrier state and reuse it
for source closures. The bootstrap must publish its **actual** allocated realm
identity and Function.prototype into that state owner, and state construction
must invoke the authenticated lazy bootstrap before reading either anchor.
No second identity or substitute prototype is allocated for classes. Keep the
existing `realmReady = 0`/bootstrap-only limitation honest: this connection does
not certify the unimplemented complete standard intrinsic graph or ordinary
object dispatch. Only programs demanding the new class allocation select the
new carrier layouts; unselected resource order/bytes must stay unchanged.

A second complete-consumer probe reached the existing heterogeneous-object
coverage guard: opening the ordinary-object carrier is not admitted by that
kernel. Preserve that guard. Split the realm **state-only** issuance surface
from its optional ordinary-object subtype declarations, sharing the same
canonical recipe/execution/ownership implementation. Classes/source closures
need identity/state/anchors/initializers; they do not need to open ordinary
object dispatch merely to retain those values. Existing full layout callers
must still authenticate their extensible storage dependencies. The selected
class realm foundation therefore reserves state only and borrows the actual
builtin bootstrap values; ordinary layout reservation remains unchanged.

Before qualification: reuse the existing source census for class occurrences
instead of introducing a second requirements registry. The physical source
invocation bridge owns class reservation/fill composition; the class setup
module stays descriptive and introduces no new IR-to-backend value edge.
Share the authenticated census description between planning and acceptance,
and support-owner indexing between ABI ownership and emission receipts.
Canonical feature/provider membership derives from the same closed semantic
provider registry used by validation. This removes duplicate lists and shrinks
the oversized planner/manifest drivers without grants or baseline edits.

Composition refinement before code: the selected class-realm owner now owns
the class carrier allocator's reservation/inventory/fill alongside its state.
The consumer binds the allocator through that real realm inventory, and the
existing source-invocation bridge only declares actual Call target references.
This keeps class resource composition in the backend and removes the extra
IR-to-backend import edge rather than adding a dependency-budget exception.

### Prepared class-allocation checkpoint (2026-10-23)

The actual `class.value.new` instruction now executes through complete Prepared
acceptance and the consumer's one-argument emission. Its canonical allocator
ABI is independent of capture layouts. The issued source census retains the
Call target, exact signature, allocation provenance and evaluated operands.
`bindNativeSourceClosureUnits` declares Call references used exclusively by
class values; the permanent fixture contains no independent closure allocation
that could mask an omitted `ref.func` declaration.

The selected backend class-realm owner owns the carrier allocator together
with state-only layout issuance. The canonical builtin bootstrap publishes
its actual realm and Function.prototype singleton into these state anchors.
The authenticated source closure initializer and explicit-prototype initializer
invoke that bootstrap before reading anchors. Original unselected artifacts
retain their byte order. The ordinary heterogeneous-object dispatch guard and
bootstrap-only completion scope remain intact.

Qualification against local parent `5fd2fc922bb76bdca70196a024a45ab67d93d84b`:

- New permanent tests: **16/16 pass** (4 actual Prepared/codec executions,
  6 malformed/issued-census controls, 6 state/bootstrap/completion controls).
  The third execution uses the existing guarded fresh-process replay runner:
  6/6 projected units emitted, 23,560 bytes, 4/4 scalar oracle calls, 926
  module-load records, zero frontend/TypeScript modules, byte-identical
  decode/re-encode. No host imports are used by the original artifact.
  The fourth execution omits indirect calls entirely and verifies class
  allocation with no native invocation resource selected.
- After each original/decoded artifact executes, an explicitly instrumented
  **copy** adds test-only getters. Actual retained Construct closures answer
  10, 11 and 9 for distinct/repeated captures. Class and source state equal
  the actual kernel realm/prototype values. Test-only bootstrap reset creates
  a new identity for later allocations while old captures/state remain intact.
  These inspection results are separate from unmodified-artifact execution.
- Fresh adversarial review found the missing class-only function declaration
  and preservation of instruction-only callback flags. Both are fixed. The
  ordinary closure branch now passes its entire instruction to the shared
  shape audit. New hostOneShot/DOM-authority census controls preserve the
  boundary refusal; the final source-census suite passes **30/30**.
- Existing native/runtime/resource regression run: **277/278 pass**. The sole
  failure is the frozen physical-record declaration hash. The exact parent
  record and exact parent receipt function reproduce it: actual `1e50d9cd...`,
  pinned `490bf9a7...`, 15 declarations. No target record/test/baseline changed.
- Existing WasmGC artifact hashes: **14/14 byte-identical**. Full class
  lifecycle remains **42 pass / 98 fail / 140 total**, unchanged.
- Typecheck, lint, LOC/function budgets, import cycles, IR dialect/layering
  and flat-directory gates pass. No new growth grants or baseline edits.

Full source class-definition evaluation, TDZ/order, descriptors, actual class
Call TypeError behavior, full Construct semantics, standard realm graph
completion and true linear remain unqualified. The constructed fixture's Call
body is a marker and its explicit parent/bag are null; it does not claim those
missing semantics. No public PR head, HOLD, queue or existing test was changed.
Machine evidence: `.tmp/7139-class-prepared-checkpoint-evidence.json`; root logs
`.tmp/7139-class-prepared-*`; fresh review
`.tmp/review-class-prepared-adversarial/REVIEW.md`.

### Source-definition coverage failure discovered after Prepared allocation

Against local `3d0a65dfec75c65c3854a8f6e3d768e53b1b2eef`, two genuine source
programs prepare, accept, emit and run while silently omitting definition work:

```ts
let trace: number = 0;
class C extends (trace = 7, null) {}
export function run(): number { return trace; }
```

The second uses `class C { [(trace = 7, "x")]: number; }`. Both native JavaScript
oracles are 7; both Prepared artifacts return 0. Evidence:
`.tmp/7139-class-definition-omission-probe.jsonl` (2/2 executed wrong answers).
The class records exist, but the source producer iterates function terminals
and treats unowned implicit constructor support as no executable source work.
This is a false complete-population claim, not an allocation-leaf limitation.

Before further class lowering, add an explicit source-definition coverage
check to the actual whole-source producer. It must inspect the authoritative
class inventory and exact declaration/constructor association; missing or stale
scanner data is an invariant, not an empty pass. Ambient declarations are
erased and remain allowed. Share the existing identical ambient-context
predicate from identity and method-name planning in one AST analysis owner.
For an executable class whose definition has no producer, return a stable
source-located `class-definition-execution-unsupported` result anchored to its
actual original constructor unit (including a currently unowned support unit).
This failure does not fabricate a terminal/body or use a display name as an ID.

This is an explicit temporary producer gap while the real definition sequence
is implemented. It must not be called class frontend completion, nor relaxed
by ignoring empty declarations or by presence of an unrelated allocation leaf.
Do not alter the typed-input constructed-IR path, legacy compilation, source
M0 accounting or public switches just to hide the bad artifact. Keep original
and additional lifecycle requirements and actual true-linear work in scope.
Regression controls must show actual 7-valued JavaScript oracles, pre-fix wrong
artifacts, precise refusals for unused/declaration/expression/nested/derived
forms, ambient positive controls, and an ordinary complete source replay.
After this coverage defect is closed, resume the executable class definition
producer and canonical Call/TDZ errors; unsupported is not the final goal.

### Source-definition coverage repair qualification (local)

The source entrypoint now refuses missing executable class definitions instead
of sealing the smaller function-only population as complete. Ambient ancestry
is shared with the original identity/method-name callers. The refusal uses the
exact existing constructor record, including support records; it issues no new
terminal or body receipt. Requested source-map catalog validation still runs
before this semantic refusal. Fresh review found an intermediate ordering bug
and independently confirmed its correction.

- Focused source/map/constructed-allocation/validation regressions: **65/65**.
  The final source-specific suite is **12/12**, including coherent malformed
  maps and a genuine ambient source program executing 7 with zero imports.
- Identity and binding controls: **72 pass / 4 fail / 76**. All four failures
  reproduce against the exact parent `3d0a65dfec75c65c3854a8f6e3d768e53b1b2eef`;
  their complete failure sections are identical (module-init outcome parity,
  two Iterator controls, timer R0 status). Existing tests/baselines are intact.
  The control loads the three changed source owners directly from that parent
  through a scratch Vitest loader, with SHA-256 provenance in the raw log.
- Existing WasmGC artifact comparisons: **14/14 byte-identical** against the
  qualified parent checkpoint; both experimental-IR settings are included.
- All eight quality gates pass; no new growth grant or baseline edit.
- Fresh review: no unresolved findings; independently reproduced both parent
  0-versus-7 wrong answers, checked 18 executable-class forms, five ordinary/
  ambient execution controls, five authentic locators and six corruption cases.

Evidence: `.tmp/7139-class-definition-coverage-*` and
`.tmp/review-class-definition-coverage/REVIEW.md`. This fixes a silent omission,
not class-definition execution. The 140-case lifecycle and true-linear
qualification remain open; the next work is the actual shared definition
producer, lexical environments and canonical Call/TDZ errors. Public heads,
HOLDs, queue and existing tests remain unchanged.

### Executable TDZ prerequisite: shared native error constructors

The next class-definition path needs actual lexical initialization guards and
an actual throwing class Call entry. The existing ReferenceError declaration
and standalone runtime provider already exist, but complete Prepared acceptance
cannot materialize their callable. A genuine source TDZ program prepares and
then refuses at that physical boundary (recorded in the class error probe).
Implement that missing constructor through the existing native error owner,
not a parallel error carrier or a test-side resolver.

Target structure before code: generalize `backend/wasmgc/resources/native-errors.ts`
by error kind while preserving the existing TypeError recipe/order/body. Its
constructor token has a generic name; all existing consumers retain TypeError
requirements. Add declarative recipe support to that same owner. A sibling
`backend/wasmgc/program/native-error-abi.ts` selects ReferenceError calls from
the existing complete program/projection demand census, validates the selected
canonical provider and exact callable contract, and contributes the actual
literal/resource/ABI binding. Native string resource composition owns the
canonical name literal and the error pack; it must authenticate/fill/reconcile
all declared tokens through the existing ledger. Share the IR throw helper
with the module TDZ guard instead of adding class-only exception machinery.

Prove actual source prepare/accept/emit/instantiate/run with a TDZ read caught
before initialization and an ordinary read after initialization, including
codec replay and opaque Error name/tag/message probes on a copy only. Require
zero imports and retain original source/unit accounting. Negative controls
must reject wrong provider/signature, stale/copy resource ownership and modified
constructor body. Preserve existing TypeError behavior and existing gc/host
bytes, with no new giant-file growth grants. This prerequisite is not class
frontend completion; all original class and true-linear criteria remain open.

The cycle gate rejects backend-to-codegen tag imports and backend ownership of
the semantic ABI selector. Keep the existing tag catalog once below both
consumers in `runtime/contracts/builtin-type-tags.ts`, with the old codegen
path as a compatibility reexport. Put demand/provider/ABI selection in
`ir/program/native-error-setup.ts`; backend composition imports that semantic
owner. The generic resource owner uses its existing backend declaration/data
comparison helper, removing the old backend-to-IR comparison edge rather than
adding a growth grant. Preserve the old TypeError API as a delegating adapter;
ignore unrelated extra requirement fields as before and force TypeError there.

### Executable native TDZ qualification (local)

A genuine source program now prepares, accepts, emits, instantiates and returns
**173**: the pre-initialization read throws/catches, then the initialized read
returns 3. Its actual standalone WasmGC artifact is **438 bytes / zero imports /
3 source units**. Original and decoded snapshots run under both string-storage
settings. Two separate abrupt evaluations return the JavaScript oracle **123**;
an uncaught startup TDZ propagates as a language exception. A test-only copy
captures the actual startup-thrown object and reads its **ReferenceError** name,
brand **-16**, absent message and fresh identity. Guarded fresh-process replay
has no frontend/TypeScript modules and reencodes identically.

- Five-file focused run: **100/100** (74 unchanged error/invocation owner tests,
  14 new source/owner tests and 12 class-source coverage controls).
- New source/owner tests also pass **14/14** in the default numeric domain.
- Existing constructed class allocation/replay/realm validation: **16/16**.
- Broader adjacent source/runtime/map controls: **87 pass / 3 fail / 90**.
  All three failures reproduce against exact parent
  `cd54ee26d774c6b316cef27064b5a38b308b66f1`, with identical complete failure
  sections: two verifier-facade spy assertions and one fresh-child facade-load
  assertion. Parent loader applied all seven changed tracked source owners;
  the fresh child's callable-declaration graph is unchanged by this patch.
- The one stale typed-preparation TDZ refusal assertion is replaced with actual
  normal and decoded/reversed-source execution returning **132 twice**. All
  original unit/global/detachment/order checks remain. No frozen owner tests,
  fixture receipts, source hashes, or baseline files are rewritten.
- Existing gc artifacts: **14/14 byte-identical**. Typecheck, lint, LOC/function
  budgets, import cycles, IR dialect/layering and flat-directory gates pass.
  No new growth grants; giant source/physical drivers shrink.

The shared native Error constructor owner preserves the TypeError facade and
canonical body, with the tag catalog below both consumers. Fresh review caught
an extra-kind substitution through the TypeError facade; it is fixed by the
facade's own explicit TypeError requirements, preserving original key/dependency
identity checks. Review now has no unresolved findings, with 29 independent
controls and a qualified exact-parent comparison.

Evidence: `.tmp/7139-class-tdz-*` and `.tmp/review-native-tdz/REVIEW.md` (including
`parent-comparison.json`). This is a necessary executable lexical-binding
prerequisite. Source ClassDefinitionEvaluation, inner/outer class environment
production, actual class Call TypeError/Construct execution, descriptors,
standard realm completion and true linear remain open. No public head, HOLD,
queue, or existing process was changed or cancelled.

### Source class execution ownership and startup census (implementation plan)

Before lowering ClassDefinitionEvaluation, complete-source preparation must own
the actual definition work. Extend the existing inventory scanner with an internal
`source-complete` module population mode, forced by the whole-source entry after
caller options. Default/legacy inventory retains its existing ordering and routing.
The scanner creates the actual M0 terminal before class discovery in this mode;
heritage/computed-key closures and empty implicit constructors retain that actual
owner. Class statements are scanned once. Planning identity consumes the scanner's
recorded mode rather than rebuilding a different population.

Share the class startup occurrence census in `ir/analysis/class-startup.ts`.
Complete-source plans record one `class-definition` evaluation at the declaration,
with static work inside that evaluation; existing legacy plans keep their static
field/block entries. Reuse this census in module-init planning and source-map
validation, removing their duplicate member walker. Extend the backend-neutral
startup kind and its data validator together. Source class exports must not claim
the implicit constructor body's callable as a produced class value.

Acceptance: real source-owned M0 for class-only modules, exact source/ClassID and
original unit ownership, definition-time closure discovery without duplicate IDs,
ordinary/class source ordering, ambient erasure, deterministic dependency order,
unchanged default inventory and ordinary source execution/replay. Preserve source-map
request validation precedence and all class execution refusals. Quality gates need
no giant-file growth grants. This foundation is not executable class completion;
class lexical environments, member ABI/capture lowering, canonical construction,
real Call errors, class descriptors, lifecycle and true-linear acceptance remain open.

Keep `identity.ts` below its existing budget by moving its existing class
definition-expression census unchanged to
`ir/analysis/class-definition-expressions.ts`. This syntax-only helper cannot
import the planning context: scanner -> planning -> scanner would create a cycle.
The shared startup occurrence owner separately consumes authenticated planning
records. No duplicate expression walker is added.

Fresh review identified a necessary ownership repair within this foundation:
AST ancestry still assigns an implicit-constructor class node or computed method
name to its callable body. Capture definition-expression execution boundaries in
the same source-complete scanner pass, validate their exact source/class/terminal
relations when projecting planning identity, and consult that boundary in owner
lookup before a callable declaration boundary. This is an authenticated AST view,
not a new unit or fabricated terminal; legacy inventory retains its old behavior.

The final syntax owner is named `analysis/class-definition-syntax.ts`: it also
receives the existing static-modifier/member-unit-kind classifier unchanged,
keeping the scanner driver below its original LOC ceiling after the ownership
boundary repair. Planning validates the complete expression census once per
class, including additions to a previously expression-free class.

The same review found class expressions in export assignments still inherited
null execution ownership. Complete-source export assignments now create the real
M0 before discovery too, and their support/closure scan inherits it. This changes
complete-source ordering/ownership for export assignments, including ordinary
ones; their original UnitIDs remain stable. Default legacy inventory remains
unchanged, and ordinary modules without export assignments retain their order.
This uses the existing export-work population predicate rather than a duplicate
recursive class-presence prewalk or a fabricated future terminal.

### Source class startup ownership qualification (local)

Complete-source inventory now retains a real M0 for class declarations and
export-assignment work. Its class definitions occur once in source order, with
static work inside that evaluation. Definition-expression boundaries preserve
actual execution ownership across heritage, computed method/accessor names and
decorators, while callable bodies retain their original units. The exact scanner
expression census is validated once per class, including stale additions to a
previously expression-free class. No synthetic terminal or duplicate scan is used.

- Focused source/inventory/TDZ/startup/source-map controls: **112/112**.
- New inventory controls also pass **24/24** in the default numeric domain;
  existing constructed-class validation passes **6/6** there. Existing class
  allocation/realm controls pass **10/10** in the adjacent i32 run.
- Adjacent original identity/typed-preparation files: **57 pass / 6 fail / 63**.
  All six failures have identical complete failure sections against exact parent
  `33e7dbd023dc3fe1405ddebd9579b569634a2763`; no assertions or baseline are changed.
- Existing gc artifacts: **14/14 byte-identical**, including both experimental
  IR settings. Default legacy inventory is unchanged; complete-source export
  assignments now have actual M0 ownership and changed internal array order,
  with their original UnitIDs preserved.
- Fresh adversarial review found and verified repairs for definition-expression
  ownership and export-expression ownership; independent controls include 24/24
  expression queries, 6/6 export-class forms, 16/16 exact-parent default inventories,
  malformed-map precedence, stale census and original/decoded execution.

Evidence: `.tmp/7139-class-startup-*` and
`.tmp/review-class-startup-inventory/REVIEW.md`. This foundation deliberately
retains `class-definition-execution-unsupported`; it produces no new executable
class value and claims no lifecycle conformance improvement. Lexical environments,
member closures, canonical Call/Construct, descriptors, realm completion and true
linear execution remain open. Public heads, HOLDs and queue remain unchanged.

### Canonical class Call error execution (implementation plan)

The retained class value can invoke its actual Call closure, but the existing IR
`emitNativeTypeError` has no semantic callable declaration or full-program physical
binding. Class Call must throw this error, while class lexical guards can also
need ReferenceError in the same artifact. Extend that shared path before producing
source class Call entries; do not substitute another class-only exception carrier.

Move the existing ReferenceError declarations/providers into parameterized
`ir/runtime/error-callables.ts`, preserving its exports, provider data and host
compatibility. Add TypeError only for existing WasmGC no-host targets, with the
same message/result ABI and canonical Error constructor owner. Extend the closed
feature/provider catalog and the existing callable-feature census. No new host
capability or host lane is introduced.

Generalize `ir/program/native-error-setup.ts` selection/binding by error kind,
retaining its ReferenceError API default. The native string plan/pack must carry
the full ordered error population, reserve/fill/authenticate each constructor
through `native-error-constructor.ts`, and contribute each literal/resource/ABI
entry exactly once. Preserve the old ReferenceError resource keys and old native
TypeError facade. Reuse one canonical Error layout/recipe; no copied error body.

Qualification must execute a retained class Call closure containing the real IR
TypeError throw, including catch continuation and coexistence with actual source
TDZ ReferenceError, original/decoded/fresh-process replay and zero imports. Inspect
actual thrown kind, brand, message and fresh identity on copies only. These are
constructed class-IR controls, not a claim of source ClassDefinitionEvaluation.
Reject changed provider/signature, lost/extra/reordered error requirements and
stale or swapped reservation owners. Existing TDZ/TypeError owner and artifact
controls remain unchanged. Quality gates require no driver growth grants.

Baseline probe: `.tmp/7139-class-call-error-baseline.mts` supplies the shared IR
throw helper in the actual retained class Call target of the complete allocation
fixture; preserve its observed refusal before claiming the physical fix. Source
class environments/construction and the complete migration acceptance remain open.

### Canonical class Call error execution qualification (local)

The actual retained class Call closure now throws the canonical native TypeError
through the shared semantic declaration, full-program selection, ABI binding and
physical Error constructor owner. ReferenceError and TypeError can coexist in one
prepared artifact with exact ordered resource accounting. ReferenceError retains
its existing keys, provider data and compatibility exports; no host import or
new host capability is added.

- Execution and source TDZ controls: **16/16**, including original/decoded
  packets, native/UTF-8 strings and guarded frontend-free process replay. Actual
  class calls throw TypeError with tag, name, full message and fresh identity;
  mixed artifacts retain genuine source TDZ ReferenceError. Construct closure
  probes retain independent captured values across calls and class evaluations.
- Provider/ABI/resource/owner/manifest controls: **113/113**. Source inventory,
  source class refusal, TDZ, prepared validation and realm owner controls:
  **55/55**. One selected default-domain Construct preservation case also passes;
  the other eight cases were not selected in that separate run.
- Exact parent `3dc1caa49c4dec0c47eefdc8f414136cc78b7823` still refuses the
  complete class Call packet with `unknown-function-ref` for `__new_TypeError`;
  the parent-loading probe passes **1/1** with source substitution provenance.
- Full existing class lifecycle: **42 pass / 98 fail / 140**. Every assertion
  status and full failure text matches both retained earlier lifecycle reports;
  there is no source class lifecycle gain from this constructed-IR slice.
- Existing gc artifacts: **14/14 byte-identical**. All eight source quality gates
  pass without grants or baseline edits. Fresh adversarial review reports no
  findings; final source/test hashes match its recorded scope.

Evidence: `.tmp/7139-class-call-errors-*`,
`.tmp/review-class-call-errors/REVIEW.md`. An intermediate expanded inspector run
was **12 pass / 4 fail / 16** because its UTF-8 observation branch used the wrong
Wasm `if` block-type property. The test-only reader is corrected; the final
16/16 run includes actual UTF-8 field inspection. Both logs are retained.

This qualifies constructed class IR Call, not source ClassDefinitionEvaluation
or true linear execution. Source lexical environments, original member closure
ABI, Call/Construct production, descriptors and full realm execution remain open.
The full migration acceptance is unchanged; public heads, HOLDs and queue remain
untouched.

### Original member closure entry and exact receiver (implementation plan)

Actual class methods/accessors are original terminal units with a ClassId lexical
owner and their own terminal owner. They must use their original main function
slot, rather than the nested-function lift allocator, derived provenance or a
copied synthetic function AST. Add an authenticated source closure-entry option
to the shared main AST lowerer: canonical closure self precedes user arguments,
existing closure.cap bindings recover the exact planned captures, and fixed
public arity remains the user parameter count. Extract the shared capture-binding
operation to a cohesive sibling owner so the AST driver does not grow another
closure implementation or receive a size grant.

The native invocation boundary already saves/restores exact currentThis, argc and
extras, including exceptional exits. Add a semantic `js.closure.receiver` read
through that existing issued owner and bind `this` once at original method entry.
Do not use legacy dyn.current_this's null-as-unbound normalization: explicit null
and undefined are distinct. Reserve its accessor only when actually demanded;
join demand, original source closure body, selected invocation/getter boundary,
ABI key and physical owner before admission. Do not add a class-global receiver,
new host import, duplicated dispatch body, or change the closure header/signature.

Qualification must execute receiver identity, null/undefined distinction,
independent captures, nested/reentrant calls and exceptional boundary restoration,
including decoded/source-free replay and unchanged old artifacts. Original member
entry controls must retain exact inventoried declaration/UnitID and source sites,
reject stale/foreign plans and keep source class admission closed until actual
ClassDefinitionEvaluation, environments, descriptors and Construct are produced.
This is a shared entry mechanism for that producer, not class lifecycle completion.

### Original member closure entry and exact receiver (local qualification)

Original read/write method ASTs now lower into their original terminal slots,
with ClassId lexical ownership, canonical closure-self ABI, user-visible arity,
exact ordered capture identities and shared mutable cells. The shared entry
planner rejects copied/foreign entries, detached or changed source declarations,
changed method parameters/results, unsupported module storage and captures outside
the actual enclosing lexical scope. Nested arrows retain the snapshotted lexical
receiver. The shared main lowerer shrinks by extracting its existing lifted-unit
identity operation and parameter resolver; capture binding, callable-kind
classification and DCE's terminator operands are shared rather than duplicated.

`js.closure.receiver` is selected from actual occurrences and bound to the optional
reader reservation in the existing issued native invocation owner. Its body reads
that owner's exact currentThis global, preserving null, host undefined, canonical
undefined, primitive values and reference identity. Every incoming allocation/use
route must be a selected native method/apply boundary. Direct calls, callback
bypasses, returns/escapes and exported readers refuse admission even when another
valid native call exists. Getter and general realm-entry routes remain unsupported
until their complete installation proof exists.

Validation against local parent 9a77106a285e3db2d0503c6499a798cc50cff03b:

- **56/56** focused cases across five files: twelve original-member cases, six
  constructed raw receiver cases and thirty-eight capture/getter controls.
  Actual original methods distinguish same-signature funcrefs, share cells within
  one evaluation and retain separate cells across evaluations. Original/decoded
  packets and fresh-process source-free replay execute with zero imports. Three
  decoded nested native-boundary cases verify receiver restoration after normal
  return and catch, plus exact thrown receiver reference identity.
- **174/174** older adjacent controls passed. The later focused run repeats the
  capture/getter neighbors touched by the subsequent freshness/arrow fixes.
- The exact parent-source override control rejects the semantic receiver as an
  undeclared callable; it does not silently run an alternate implementation.
- **14/14** old default/experimental WasmGC artifact rows match byte-for-byte.
  All **140/140** lifecycle status and full failure-text rows match the parent
  report: **42 passed, 98 failed**. This is preservation, not a lifecycle gain.
- Source typecheck and a separate focused-test TypeScript project pass. All eleven
  configured quality commands exit zero, including staged LOC/function budgets,
  cycles, dialect/layering and coercion checks. The dead-export command certifies
  preservation only: its graph remains OPEN and strict modeled closure fails on
  unresolved nonliteral imports; direct-handler retirement is not certified.
- Fresh adversarial review has no unresolved findings. It found and prompted fixes
  for stale captured/method declarations, mutable outer and module captures,
  lexical arrow this, capture ordering/scope, duplicated traversal, an unused test
  resolver and missing nested native-boundary qualification. Reviewed source/test
  hashes match the final staged snapshot; qualification notes were appended later.

Interim failures are retained in local evidence: initial 8-case harness had two
incorrect replay-option accesses and an escape negative removed by DCE; the fixed
8-case suite passed. A later nested `.call` attempt was explicitly refused by the
class primordial-effect proof, which was not weakened. It was replaced with an
honestly scoped original-arrow test and separate constructed nested native tests.
The first final typecheck caught a terminal-record narrowing error; the guard was
reordered and both source/focused-test typechecks now pass. Exact-parent probing
also exposed scratch-test syntax and expected-diagnostic mistakes before the final
control correctly asserted the actual undeclared-callable rejection.

Evidence is retained under `.tmp/7139-member-entry-*` and
`.tmp/review-class-member-entry/FINAL-REVIEW.md` in the Session B worktree. These are
local checkpoints, not published class completion. Actual source
ClassDefinitionEvaluation remains independently refused. Source binding storage,
fresh constructor/prototype population, descriptors, Construct, HomeObject/private
state, complete realm execution and true linear support remain open. Full migration
acceptance is unchanged; public PR heads, HOLDs and queue remain untouched.

### Stored Construct execution (implementation plan)

The next executable dependency of source ClassDefinitionEvaluation is canonical
Construct dispatch for the fresh class carrier already allocated by class.value.new.
Add the semantic js.construct(callee, newTarget, native external-element argument
vector) contract to the shared invocation declaration/census. Retain an internal
Construct closure ABI (closure self, newTarget, argument vector) distinct from
user constructor arguments and class public length. Its original prepared unit,
actual class allocation, private closure allocation, vector owner and newTarget
must join before admission; unknown constructor families remain typed Unsupported.

The existing issued invocation pack owns its optional Construct dispatcher and
shares its exact receiver/error/frame resources. The class realm supplies its
actual class metadata TypeReservation after reservation; no numeric index/name
lookup authorizes loading the private Construct field. Runtime bodies reuse the
canonical closure call core and save/restore boundary, including catch/rethrow;
class field zero remains the TypeError Call stub. No legacy Construct ladder,
second receiver global, host callback/import or copied user body is introduced.

Internal Construct bodies must use explicit newTarget/vector inputs; reject raw
Wasm and unowned ambient receiver/argument readers, including reachable helpers.
General prototype/escape routes still need their complete proof. Tests must execute real
stored closures with retained/distinct mutable captures, exact newTarget and
argument-vector transport, nested/exception state restoration, normal class Call
TypeError, decoded/source-free replay, actual import/unit accounting, and negative
signature/provenance/constructor-family substitution. Preserve old allocation-only
artifacts and exact failure rows. Fresh adversarial quality review remains required;
source class admission stays closed until its complete evaluation sequence exists.

The first Construct harness exposed an additional migration defect: a valid
reference-valued IR select lowers to untyped Wasm select, which rejects externref
operands at instantiation. The dispatch fixture now expresses its result-mode
branches as typed IR if/else. Reference-select backend lowering remains a tracked
full-migration obligation; this harness change is not evidence that select works.


The complex dispatch fixture exposes repeated preparation-data copying as a
measured emission cost (63.394 seconds before optimization; CPU profile retained).
Move the existing immutable native collection-slot cache out of program/data into
dependency-free core/native-data-slots and reuse it for allocation copying, with
an equally narrow Date-slot cache. Cache only unchangeable internal-slot brands;
all live prototype, descriptor, field, collection-entry and provenance checks
remain on every call. No successful whole-data authentication cache is allowed.
Exercise warmed mutation, erased prototypes, invalid Dates and non-invoking
accessor rejection, and remeasure the same executable fixture. Route the class
metadata accessor through the existing native realm seam so the change adds no
IR/backend cycle edge. No new size or cycle grant.


### Stored Construct execution checkpoint (2026-10-23)

Implemented canonical `js.construct` dispatch over actual class metadata and
original selected private closure slots. The callee and newTarget have separate
allocation/occurrence proofs across semantic and projected views; the actual
native externref vector is passed unchanged. Internal code uses the explicit
`(closureSelf, newTarget, argv)` protocol. Unknown constructor families and
unowned ambient/raw helper effects remain Unsupported. Public class Call is
still its canonical TypeError stub. One actual class metadata owner is permitted
per source closure family, with duplicate reservation refused before mutation.

The actual issued invocation state is neutralized on internal entry and restored
on both return and rethrow. Tests inspect only a copy after original artifacts
execute, checking exact receiver/argc/extras restoration, positive internal entry
counts, canonical undefined/-1/null entry state, exact newTarget/vector identity,
mutable retained captures, distinct same-signature bodies and nested/throw paths.
The five handwritten typed harness bodies retain their real original class/unit
inventory; they are not evidence of source ClassDefinitionEvaluation lowering.

Qualification: **98/98** combined Construct/authentication/allocation-relocation
checks, **161/161** adjacent invocation/member/class contract checks and **9/9**
class allocation checks. Source and focused test typechecks pass, as do all ten
quality/ratchet commands without a new grant. All **14/14** old artifact rows are
exactly equal; all **140/140** lifecycle statuses and full failure texts are equal
(**42 pass, 98 fail**, not migration closure). Exact parent `cb64b3505d81` lacks the
canonical Construct declaration and refuses the genuine encoded packet at the
ABI declaration population boundary. Its five loaded changed modules match the
pinned parent blobs; backend execution is not claimed for that refusal control.

The immutable-slot optimization removes repeated Date/collection brand probes
without caching live data authentication. The same fixture's unprofiled emission
fell from **66.723 s** to **44.685 s**; the original failure logs retain the
35-second test timeouts, invalid reference select, inspector correction and worker
RPC timeout. Final combined execution has no unhandled worker error. Review also
caught an introduced Array-iterator bypass of collection probes; numeric indexing
and a cold erased-Map regression close it. Exact allocation owner/member receipts
remain unchanged; only the reviewed copy helper receipt/import list changed.

The recorded Linear refusal is specifically a **missing linear runtime
projection** (`body-shape-rejected`, build stage), not proof that a Construct
owner ran on Linear. True linear execution, source binding/evaluation storage,
instance/prototype/descriptor construction, base/derived return rules, private and
HomeObject semantics, realm completion and reference-select lowering remain open.
Fresh adversarial review has no unresolved implementation/quality findings in the
reviewed scope; dead-export evidence is preservation-only (graph OPEN, strict
closure FAIL), so retirement/deletion remains uncertified.

Raw evidence: `.tmp/7139-construct-qualified-final-tests.log`,
`.tmp/7139-construct-adjacent-regressions.log`,
`.tmp/7139-construct-final-quality.json`, `.tmp/7139-construct-comparisons.json`,
`.tmp/7139-construct-parent-*`, `.tmp/7139-profile-construct*`, and
`.tmp/review-class-construct-execution/REVIEW.md`.


### Reference-valued select (implementation plan)

Move select emission out of the generic lowering switch into
`src/ir/lowering/select.ts`, next to the existing string-operation lowering seam.
Use the active backend TypeConverter's actual physical slot. Numeric/Wasm handle
selects and non-Wasm backends retain their existing instructions and local count.
A physical reference select stores both eagerly evaluated operands in distinct
per-instruction scratch locals, then evaluates the condition and emits a typed
if whose arms only read those locals. This preserves true/false/condition order
and unselected operand effects; it is not short-circuit evaluation.

Reuse the lowerer's scratch allocator and existing emitter local/if primitives.
Use defaultable nullable scratch for nonnullable references, refining only the
proven-nonnull reads; retain the exact original result block type. Do not pool
scratch by type: nested selects in the false operand or condition must not
clobber an enclosing saved true operand. No new emitter ABI, Wasm instruction
variant, encoder or host bridge is needed. Keep the generic switch smaller.

Acceptance includes original/decoded source-free standalone execution, exact
reference identity for both conditions, eager effects and abrupt completion,
nullable/concrete reference validation, nested false/condition regressions, and
exact numeric instruction/local/byte preservation. Check the actual linear
physical converter's numeric handle path separately from the still-open full
class/Construct linear projection. Fresh adversarial review must assess scratch
ownership, physical type conversion, nesting and the quality split.

### Reference-valued select checkpoint

The generic switch now delegates to the small select lowerer described above.
Actual backend physical slots determine whether select needs reference scratch;
logical strings on the production Linear converter still use their original i32
handle select without extra locals. The two nullable scratch slots belong to each
instruction; nonnullable reads refine back to the exact original result type.

Qualification: **24/24** focused tests pass, including original/decoded standalone
units, runtime nested selects in both false operand and condition, exact reference
identity, eager operand/condition calls, and exact thrown payload identity. A direct
helper-level Wasm test checks evaluation independently of the enclosing try
scheduler. Seven persistent physical-reference cases validate and execute extern,
nonnullable extern, function, eq/any and concrete nullable/nonnullable references.
Vitest's inspector initially threw on opaque GC objects; the retained failed log
records this, and Object.is now tests those identities without object inspection.

Four numeric/backend cases preserve literal instruction bodies, local counts and
resulting bytes; their golden modules share the lowered signature metadata. The
production Linear factory test separately executes its numeric handle path with
real emitted string handles. This does not establish full Linear class/Construct
execution or source-frontend reference-select construction. All **14/14** existing
GC artifact rows are exactly equal to parent `6caf9c520b76`.

The exact-parent source substitution positively reproduces the invalid untyped
reference select at Wasm validation; the same selected decoded case passes on the
candidate. Loaded parent source hashes match the pinned Git blob. All **50/50**
adjacent test statuses and full failure messages are unchanged: **46 pass, 4 fail**.
Those four existing frozen string-refusal expectations remain red on both sides;
they were neither skipped nor rebaselined. Source and focused test typechecks and
all ten quality commands pass, with no size grant. Dead-export qualification still
only preserves an OPEN graph/failed strict closure; it does not certify deletion.
Fresh adversarial review has no unresolved correctness or quality findings.

Evidence: `.tmp/7139-select-checkpoint-tests2.log`,
`.tmp/7139-select-checkpoint-tests-typecheck.log`,
`.tmp/7139-select-qualified-quality.json`, `.tmp/7139-select-comparisons.json`,
`.tmp/7139-select-exact-parent-failure2.log`, and
`.tmp/review-reference-select/REVIEW.md`. Full source class evaluation/binding and
Construct semantics, true Linear parity and migration retirement remain open.
