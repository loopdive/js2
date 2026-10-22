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
