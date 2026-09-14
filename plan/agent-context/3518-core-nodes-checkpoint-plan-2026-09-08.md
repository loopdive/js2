# Complete semantic nodes checkpoint — Astra High implementation contract

Status: structural extraction and preservation published in non-draft held
PR 5744 at `8429806b2abb6a9f04160471170a0659c94bd335`. The additive node
execution follow-up is implemented, measured and independently approved for
bounded caller preservation by Astra High.
This is not complete migration or retirement acceptance.
Stack base: PR 5742, `acfd3e37b8765c4c4788c1fa94718d62c60e473c`.
Upstream main was independently read as
`16498efb481cb022ee5c4dcc9bb137b6d4c91a50` before dispatch.
PR 5743 is compatible but not a dependency. This checkpoint remains held with
its parent while the inherited N1 host-CI/merge-queue incident is unresolved.

## Outcome and scope

Move the complete semantic instruction/function dependency boundary into core,
not another isolated helper subset. Canonical functions describe semantic IR;
existing consumers retain optional prepared runtime attachments through old
module names. This does not authenticate a function, migrate program preparation,
complete the host/linear lanes, or authorize direct-codegen retirement.

The approved architecture permits core, foundation and pure Wasm-model imports.
Core must not reach runtime/provider catalogs, old compatibility facades,
frontend or backend code, including through type-only or inline import types.
Keep instruction-level closed provider annotations and symbolic layouts unchanged;
this is not a claim that every instruction is target-independent.

## Disjoint source ownership

Two Astra Low native subagents implement the following 14 paths. The parent owns
the plan, issue, package command, boundary/kind/dialect/caller controls and final
integration. No writer edits the dirty main checkout, older P/C worktrees or
another writer's worktree. Existing claims and drafts remain intact.

### A: nodes, dialect and semantic/prepared function boundary

- `src/ir/nodes.ts` → `src/ir/core/nodes.ts`: move all 83 type/interface
  declarations. Only canonical `IrFunction` drops `asyncRuntime`; canonical
  `IrModule.functions` uses that semantic function type. Preserve all 81
  instruction arms and four terminators. Move `asValueId`, `asLabelId`,
  `asAllocSiteId`, `asBlockId`, `forEachNestedBuffer`, `forEachInstrDeep`,
  `mapNestedBuffers`, `directUses`, `collectUses` with unchanged bodies and
  comments. Move the single `IrValueIdAllocator` class with private `next`,
  implicit construction, `fresh` and getter `count`. Old nodes re-exports the
  exact constructor, never a subclass or copy. `irValSigned` and `isDynamic`
  remain explicit unproved-caller compatibility debt.
- `src/ir/dialect/js.ts` → `src/ir/core/dialect/js.ts`: all 27 interfaces,
  unchanged. Old dialect is an exact type-only forwarder; canonical nodes is
  the sole instruction-union assembler. Do not widen roots over the old folder.
- `src/ir/async-plan.ts` → `src/ir/core/async-plan.ts`: the 19 semantic
  declarations from `IrAsyncStateId` through `IrAsyncPlan`. Leave all functions,
  prepared runtime types, validators and `preparedManifestByPlan` in old
  async-plan. Add `PreparedIrFunction extends CoreIrFunction` there with the
  exact optional `readonly asyncRuntime?: PreparedIrAsyncRuntime`, and
  `PreparedIrModule extends CoreIrModule` overriding functions as
  `readonly PreparedIrFunction[]`. Old nodes re-exports these as `IrFunction`
  and `IrModule`; no generic default erases attachments for existing consumers.
- Rewire canonical dependencies to core type/reference/provenance/fnctor files,
  F0 identity and Wasm-model instructions. In particular move the raw-Wasm
  instruction's inline `Instr` import away from the old `ir/types.ts` facade.

Worker A may add only `tests/issue-3518-core-nodes-seam.test.ts` besides its six
source paths. The other source slice supplies missing vocabulary destinations.

### B: close every remaining data dependency

- `src/ir/intrinsics.ts` → `src/ir/core/intrinsic-vocabulary.ts`: precisely 12
  declarations: five family `*_INTRINSIC_IDS` tuples, aggregate `INTRINSIC_IDS`,
  Number/Boolean/Extern boundary ID aliases, `IntrinsicId`, signature version
  constant and type. Preserve canonical tuple identity, order and comments.
  Definitions, runtime features, effects evidence and validators stay old.
- `src/ir/async-runtime-providers.ts` → `src/ir/core/async-intents.ts`:
  `ASYNC_RUNTIME_FEATURES`, `ASYNC_OPTIONAL_RUNTIME_FEATURES`,
  `AsyncRuntimeFeature`. Keep sets, guards, IDs, catalogs and selection old.
- `src/ir/string-runtime.ts` → `src/ir/core/string-types.ts`:
  `IrStringEncoding`, `IrStringConcatMode`, preserving all literal arms.
- `src/ir/counted-string-append-provenance.ts` →
  `src/shared/contracts/ir-counted-string-identity.ts`: private unique-symbol
  brand plus `IrCountedStringAppendSiteId`, `IrCountedStringAppendSiteIdentity`,
  `IrCountedStringAppendSiteClaim`. Preserve nominal identity, source-qualified
  identity fields and old exports; creation/validation/receipt functions stay.

Worker B may add only `tests/issue-3518-core-vocabulary-seam.test.ts` besides its
eight source paths. No forwarding function wrappers, duplicated brands or state.

## Consumer and mutator preservation

`attachAsyncRuntime` in intrinsic-support selects and authenticates providers,
then attaches the prepared runtime. Extern support rewrites prepared state bodies
copy-on-write. Prepared vector support preserves logical type identity and adds
frozen layouts. Generic passes also read prepared state bodies. All retain old
`IrFunction`/`IrModule` imports and the complete optional runtime shape.

Verifier, runtime-program manifest, validation, dependency collection, physical
planning and async codegen retain currentness/owner/freeze/identity checks.
Program preparation and codec retain all fields, reference relationships and
exact serialization: the codec reauthenticates regenerated projections before
accepting persisted IR. A type extension is not a replacement for those checks.

No selected plan/manifest/provider/type-layout object is cloned or reordered.
Preserve optional legacy-fixture fields in `PreparedIrAsyncRuntime`; do not
substitute `CurrentPreparedIrAsyncRuntime` or make attachments mandatory.

The preserved P worktree has 8 modified and 4 untracked source/test files on
`6037ac8bcf07be4f71839cea33cf8c90ecc87f94`; C has 2 modified and 3 untracked on
`9feb7bf8fc0f8fddccf87235c7664651eb338e92`. All are outside this write set.

## Additive caller proof, without retirement claims

Require a separate explicit node group: nine moved free functions plus the
allocator's construction, `fresh`, and `count` (12 obligations). N1's six-target
group, 25 historical dead-export baseline rows and two dynamic-import receipts
remain unchanged. The previous ten class-free core targets remain unchanged.
Default invocation without the new flag must report not-assessed, not success.
Both strict and preservation verdicts conjoin the requested node group. Strict
closure and retirement remain blocked by the reviewed unresolved imports.

### Reviewed amendment: observed callers, not a new static interpreter

Astra High approved using actual isolated public-compiler execution for the
new 12-target group. This supersedes the initial requirement for static full
AND dispatch-cut node paths. Existing N1 and ten class-free full/cut obligations
do not change. The new group must report `cutAssessed:false`,
`cutWitnessCount:null`, `cutStatus:"unknown"`, `closureCertified:false` and
`retirementCertified:false`, even when all twelve execution obligations pass.

Bind Inspector function-call breakpoints to the actual nine canonical exported
function objects, the single allocator constructor, its `fresh` method and its
actual `count` getter descriptor. Verify old/new export identity, physical source
and generated-script identity, exact function locations and the real public
`compile` function's frame. Only a paused observation inside a public compile
window may count. Class evaluation, unused methods, shadow functions, inactive
windows and a missing public frame must not invent witnesses. Missing, renamed,
unmapped, stale or unexercised required targets fail the explicit gate.

Require six successful standalone programs, including loops and allocation.
Validate emitted Wasm, zero imports, repeated execution values and IR outcomes
outside the observation window. The claim is only that each moved implementation
retains an observed real compiler consumer, not that all historical callers are
preserved or that legacy dispatch did not execute. Aggregate coverage entries
omitted by V8 cannot certify zero calls and are not the chosen evidence method.

The initial prototype observed all twelve actual objects during public
compilation of the vector program, with a real public compile frame in each
stack. At structural publication these scratch experiments were not a committed
acceptance gate. The follow-up below adds the hardened helper, explicit
auditor/package requirement and calibration of both explicit and implicit
constructors; the positive execution and strict-retirement verdicts stay separate.

## Parent-owned gates and acceptance

- Activate every new canonical destination in D0 with existing core and
  foundation permissions only. Keep old async-plan/provider modules explicit
  debt. Missing destinations and any facade/upward edge must fail.
- Extend dialect and kind gates to new and old paths. Allow only canonical
  assembly plus the exact old type-only forwarder. Keep old synthetic negative
  controls. `core/dialect` is still dialect for kind ownership, not neutral core.
- Preserve 85 kinds and three exclusions, every verdict, quote hash and ratchet.
  Use explicit citation relocation maps, never reseeded evidence.
- Preserve LOC/function baselines. If unchanged moved bodies cross new-path
  limits, use narrowly documented issue3518 relocation-only allowances backed
  by exact body and size receipts, retiring old allowance keys as appropriate.
- Check all old/new exports and type joins, constructor identity, all recursive
  traversal forms, tuple/provenance identity and negative caller-removal,
  shadow-class, unused-method and deferred-initializer controls.
- Run focused seam and existing async/currentness/extern/provenance consumers,
  typecheck, all previous caller fixtures plus new fixtures, boundary/kind/
  dialect gates, full inventory and fail-closed complete mode. Report exact
  populations and nonzero exits honestly.
- Compare pinned-base/candidate public standalone WasmGC binaries, WAT, import
  descriptors/order, pools, outcomes and executed values, including loops and
  allocation. Serialize heavy work at 2 GiB; no local Test262 campaign.
- Publish a non-draft checkpoint PR with code, controls, plan and issue handoff.
  Retain PR 5742 ancestry, but target main because the existing pull-request CI
  trigger accepts only main. Disclose the dependency and cumulative parent diff;
  do not change workflows. Normal hooks, user author and Codex/model
  attribution apply. Do not remove holds or alter CI/rulesets to obtain green.

## Measured structural checkpoint receipts

The 14 source files match the frozen Astra Low slices byte-for-byte. All 81
instruction arms, four terminators, moved function bodies and retained async
authority functions remain covered by declaration/body/identity controls. Seven
canonical destinations add no upward dependency. The policy activates 11 core
entries and four foundation entries, preserving the prior activation history
and every existing allowed edge. The old prepared/provider modules remain debt.

- 168/168 distinct source, seam, dialect, boundary and kind controls pass.
  Integrated TypeScript typecheck exits 0.
- Existing consumers: 51 pass and 16 fail out of 67. The same 16 counted-string
  proof failures reproduce on the untouched PR 5742 parent: all 29 test names,
  outcomes and first error lines match. No assertion, consumer implementation or
  baseline is waived to hide those failures.
- All six paired public standalone WasmGC programs match the parent in complete
  binary bytes, WAT, descriptors, exports/order, pools, compiled functions and
  outcomes. They validate, have zero imports and return expected values twice:
  scalar 85, vector/record/class/closure 42, loop 18. Each `run` has exactly one
  emitted-IR outcome and zero direct outcomes. This is preservation evidence.
- D0 inventory exits 0: 1,256 modules (1,249 tracked plus seven new), 18 clean,
  five compatibility adapters and 1,233 unmigrated. It resolves 9,794 edges
  (2,522 type-only, 7,272 runtime), with four unknowns and zero checker errors.
  Complete mode exits 1 and `architectureComplete` remains false.
- Existing preservation audit exits 0: N1 six and prior core ten retain full
  AND dispatch-cut paths, the historical dead-export ratchet stays 25/25 with
  no additions/removals, and the two exact nonliteral imports remain unknown.
  Strict mode exits 1; retirement remains false. The new node group is pending.
  All 134 existing caller/open-extension controls also pass unchanged (29 core,
  39 original rooted audit and 66 reviewed open-site tests).
- Exactly 174 kind-record citation prefixes relocate: 116 nodes, 55 dialect,
  two intrinsic vocabulary, one string encoding. Reverse those prefixes and
  apply the repository's deterministic Prettier formatting to recover the full
  parent blob `6b2be2d5b198b8df35b97e6fa14275c73d29c19b`; reversing the prior
  two shape citations also recovers original
  `905b33823e259908f964bbaa47c0c8177c256e4f`. No verdict, quote hash, counter
  or ratchet changed.
- Current source delta is +344 LOC; cumulative with PR 5742 it is +405 across
  23 source files. The issue's existing nodes LOC grant moves to the canonical
  path (2,468 lines); the old facade is 185 lines. No function allowance or
  budget baseline changes. Both budget gates pass against main `16498efb`.

Astra High independently supports publishing this structural checkpoint held,
with the execution gate pending and the dependency and non-green consumer
results disclosed. That review approves the observation architecture, not the
unfinished implementation or merge clearance. Across the measured focused
suites there are 394 distinct tests: 378 pass and 16 reproduce as parent failures.
The normal commit hook caught the parent core-type seam's obsolete physical
old-node declaration assertion. It now requires unique canonical declarations
and exact old-path type forwarders (including the prepared-function alias),
and all 25 cases pass. No source implementation or behavior assertion changed.

Full receipts remain under the integration worktree's `.tmp/` in
`core-nodes-source-tests.json`, `core-nodes-boundary-tests.json`,
`core-nodes-kind-final-tests.json`, `core-nodes-old-caller-tests.json`,
`core-nodes-type-seam-final-tests.json`,
`core-nodes-consumer-tests.json`,
`core-nodes-counted-base-tests.json`, paired base/candidate JSON, inventory and
complete JSON, and preservation-v1/strict JSON. Scratch receipts supplement,
not replace, committed executable controls. No local Test262 campaign ran.

## Additive execution-gate follow-up

The follow-up adds `--require-core-nodes` to the existing package check beside
`--require-core-types` and the approved preservation contract. Without the new
flag, the group explicitly reports not-required/not-assessed with no success
verdict. With it, the auditor runs a fresh isolated child before constructing
either existing static graph. Missing sources, binding failures, observer errors,
failed compilation/execution, stale receipts or an incomplete denominator fail
both requested verdicts. A passing child cannot promote an older failed verdict.

The child binds actual function objects, records acknowledged breakpoint IDs and
their matching pause events, validates the exact target and public-compile
frames, and drains observer callbacks before reporting. It authenticates current
source content, generated script/ranges, old/new export identity, the Node
executable, loader/parser/helper implementations and the planned launch. Parent
admission supplies independent before/after source and runtime expectations.
`NODE_V8_COVERAGE` is scoped to the isolated child and a unique private `.tmp`
directory so tsx embeds original source content; coverage output is never read
as caller evidence, a zero-call inference or a dispatch-cut result.

Final measured integration and review:

- 82/82 focused tests pass: 43 live calibration/receipt controls, 28 additive
  admission/deadline/environment controls and 11 child-adapter controls. The
  adapter tests use explicitly synthetic inputs, not fabricated compiler
  evidence. They preserve older graph populations, receipts, failure reasons
  and verdicts while rejecting incomplete or failed new groups.
- All 134 earlier caller/open-import tests pass. Only the old package-command
  expectation gains the explicit new flag; no previous caller assertion changes.
  Integrated typecheck exits 0. The repository linter rejected a static `delete`
  spelling in one new test; `Reflect.deleteProperty` plus an own-property absence
  assertion preserves that actual-deletion negative control.
- Actual composed preservation mode exits 0 with 12/12 observed implementations
  across six successful public compiler programs. Per-program distinct first-hit
  counts are 11, 12, 12, 12, 12, 11; these are not total invocation counts.
  Every binary validates, has zero imports and returns the expected value twice;
  every `run` outcome is emitted IR1/direct0. The source census is
  `208c8c063fa90806abdfd7451aeabc460f325a06318519cb3c46469e12f336e4`.
- Remove only the new `movedRuntime.coreNodes` report field and the entire
  integrated legacy report is deep-equal to the prior structural checkpoint's
  report: all graphs, edges, ten core and six N1 obligations, two unresolved
  imports, 25 dead-export baseline rows and verdicts are unchanged.
- No production source file changes in this follow-up. Dispatch-cut stays
  `unknown`, `cutAssessed:false`, `cutWitnessCount:null`; closure and retirement
  flags stay false. The final strict command exits 1, despite all twelve new and
  ten prior core obligations passing, on the same two unresolved imports.

Four review follow-ups are implemented and measured: the child removes inherited
`ESBUILD_BINARY_PATH`, pins `TSX_TSCONFIG_PATH` to the authenticated root config,
and disables/records the loader cache. Missing or changed override receipts fail.
A fixed 120-second deadline fails only the newly launched owned child, never an
unrelated running test. Controls cover timeout even with a passing-looking
receipt, nonzero/signal exits, missing/malformed receipts, changed source/runtime
identities and disagreeing validator/report verdicts. A constructor-less class
with an instance field separately proves evaluation, construction, method and
getter behavior. Astra High independently verified the final hashes, 82/82
receipt, six-program/12-target proof and exact old-report equality. All four
findings are resolved; no concrete review findings remain. Approval is limited
to execution preservation, not a dispatch cut, retirement or merge clearance.

The structural head `8429806b2abb6a9f04160471170a0659c94bd335` completed CI with
29 successful and 13 skipped checks, and is non-draft, conflict-free and held.
That status is not the follow-up's CI result or merge clearance.

Integrated receipts: `.tmp/core-node-integrated-tests.json`,
`.tmp/core-node-old-caller-integration-tests.json`,
`.tmp/core-node-loader-implicit-integrated-tests.json` (final 82 tests),
`.tmp/core-node-integrated-preservation.json` (initial composition),
`.tmp/core-node-final-strict.json` (final strict result), and
`.tmp/legacy-reachability.json` (final package result). The final package child
receipt is `.tmp/core-node-execution-dtC6oY/execution.json`, with helper SHA-256
`003707e595015dd3987afe3b9f1d32abc7a4bd11ad6e806cdef4265d53a29814`.
Worker calibration and
independent pre/post-launch receipts remain in the node worker's `.tmp`, with
the detailed API handoff in `core-node-execution-handoff.md`. Those worker-only
measurements are not substituted for the composed parent run.
