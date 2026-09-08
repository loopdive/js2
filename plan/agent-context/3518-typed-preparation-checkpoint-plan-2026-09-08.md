# Typed preparation boundary: implementation plan and dispatch

Status: coordinator-approved bounded implementation, 2026-09-08.
Parent prerequisite: PR #5744 at `6ff05f6b5a197f8d0423036f7d171888ff99bd40`.
Upstream main: `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`.
The complete goal remains IR-only compilation and eventual direct-codegen retirement;
this checkpoint implements a real source-free preparation entry, not public cutover
or clean-folder completion. Standalone WasmGC is the active lane; preserve host/linear.

## Live ownership and publication

The coordinator acquired `3518:typed-program-preparation-boundary` as
`ttraenkler/codex-astra-typed-preparation-20260908` on the authoritative upstream
assignment ref at `ed53d4e1e9f4c9701212ed1d91957a5eebceefa0`.
The new record is the only change from `1aada624`; no historical claim was released.
The pre-dispatch scan covered all 16 open PRs, including all 135/135 files in
large PR #5683. None overlaps the 18 owned source paths.

The dirty main checkout and P/C drafts remain read-only. Fresh P/C fingerprints
match the historical values preserved below. This routes the reconciled A/P source
and B runtime work through two native Astra Low subagents, superseding their old
execution assignments without deleting drafts or changing the historical claims.
Astra High owns architecture/review; the coordinator serializes integration,
normal-hook commits and pushes. Every checkpoint gets a non-draft PR on
`loopdive/js2`, based on main with the dependency disclosed. Keep `hold`, with no
auto-merge, enqueue, workflow/ruleset changes or retirement certification.

## File-disjoint worker ownership

Source worker A (Maxwell), worktree
`/private/tmp/js2-3518-typed-preparation-source-20260908`:

- New: `src/ir/program-input.ts`, `src/ir/program-prepare-ir.ts`,
  `src/ir/program-callable-contract.ts`.
- Existing: `src/ir/program-source.ts`, `src/ir/program-preparation.ts`,
  `src/ir/program-abi-contracts.ts`, `src/ir/program-validation.ts`,
  `src/ir/alloc-registry.ts`.
- Tests: `tests/issue-3518-typed-program-preparation.test.ts`,
  `tests/issue-3518-typed-program-source-free.test.ts`,
  `tests/issue-3518-preparation-allocation-replay.test.ts`,
  `tests/issue-3518-typed-program-callable-contract.test.ts` and dedicated
  `tests/helpers/typed-program-*` transport/control helpers as required.

Middle-end worker B (Boyle), worktree
`/private/tmp/js2-3518-typed-preparation-middleend-20260908`:

- New: `src/ir/passes/gvn-core.ts`, `src/ir/program-middleend-ir.ts`,
  `src/ir/async-prepare-ir.ts`.
- Existing: `src/ir/passes/gvn.ts`, `src/ir/program-middleend.ts`,
  `src/ir/verify.ts`, `src/ir/async-prepare.ts`,
  `src/ir/runtime-program-producers.ts`, `src/ir/async-linear-prepare.ts`,
  `src/ir/passes/monomorphize.ts`.
- Tests: `tests/issue-3518-typed-middleend-controls.test.ts`,
  `tests/issue-3518-typed-gvn-diagnostics.test.ts`,
  `tests/issue-3518-typed-async-preparation.test.ts` and dedicated
  `tests/helpers/typed-middleend-*` helpers as required.

No worker edits its peer's paths, shared plan/issue/package files, claims,
settings, CI, the pending ABI getter or historical P/C trees. Ask the coordinator
for any scope expansion. The coordinator owns
`/private/tmp/js2-3518-typed-preparation-checkpoint-20260908` and integration.
Worker patches are copied only after a frozen path/blob manifest and review.
No source file is relabeled a clean layer while type-only backedges remain.

Heavy checks are serialized with 2 GiB Node and a single Vitest fork, no file
parallelism and no local Test262 campaign. Request the heavy-test slot before
using it; report exact commands, denominator, outputs and known-control results.
Production runs must establish actual supported-source populations and real
values, not treat compile success, empty results or mocked receipts as proof.

## Measured starting baseline

At unchanged source head `6ff05f6b`, the five existing whole-program source,
population, projection, validation and allocation-registry test files pass
**26/26** with no skipped tests. Receipt:
`.tmp/typed-preparation-base-tests.json` in the integration worktree. Command:

```sh
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 pnpm exec vitest run tests/issue-3521-whole-program-source.test.ts tests/issue-3521-whole-program-population.test.ts tests/issue-3521-whole-program-projections.test.ts tests/issue-3521-whole-program-validation.test.ts tests/ir/alloc-registry.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism --reporter=json --outputFile=.tmp/typed-preparation-base-tests.json
```

Runtime: Node v22.23.2, V8 12.4.254.21-node.56, ICU 78.2, locale en-US.
These are baseline controls, not evidence that the new entry is implemented.
The five files include historical host/linear compatibility fixtures; those
results are not new standalone acceptance evidence.
The recorded dispatch starts two active implementation workers; integration and
new-boundary acceptance remain pending. Preserve all failures exposed later.

The unchanged integration source also passes **12/12 public preservation runs**:
scalar, vector, record, class, closure and loop programs under GVN off and on.
Every binary validates with zero imports and returns its expected value twice;
the exported `run` has one IR emission and zero direct emissions. Receipts:
`.tmp/typed-public-base-off.json` and `.tmp/typed-public-base-on.json`.
Both record all 1,256 source files with census SHA-256
`208c8c063fa90806abdfd7451aeabc460f325a06318519cb3c46469e12f336e4`.
These six programs have no GVN-mode binary difference, so this does not prove
active GVN merging; B's dedicated merge/poison/counter controls remain required.
The reports are preservation baselines, not evidence for the new typed entry.

## Frozen cross-worker API and lifecycle

### B implementation checkpoint: resolved middle-end and IR-only async preparation

PR #5745 now carries the reviewed B implementation: ten production paths and
three focused suites plus their fixture helper. Existing source preparation
continues through the historical optimizer, which delegates to the resolved
implementation. The new A typed-input entry is a separate, still-unaccepted
worker draft; this checkpoint does not claim its capture or source-free replay.

The GVN algorithm retains its original increment sites, pass order and identity
termination. Explicit controls are separated from the historical environment,
import-time debug handler and once-only transaction publication. The async
extraction retains all 18 moved declarations, including 13 function bodies,
and the historical AST predicate. Derived identity construction uses the
canonical value module. Astra High reviewed all ten frozen production blobs;
the coordinator verified exact blob equality on integration.

Measured B validation:

- Three new focused suites pass **77/77**, zero skipped: 15 GVN diagnostic,
  36 resolved-control and 26 async-extraction tests. This includes real merge
  and poison operations, failure-path counts, nonempty async transformations
  and child-process forbidden-load positive controls. Synthetic pass fixtures
  are not substituted for the separate frontend-produced A acceptance corpus.
- Typecheck passes with zero diagnostics.
- Existing scoped compatibility controls: **280/284** pass across 23 files,
  zero skipped. The four failures are retained, not waived: three #4113
  telemetry-row assertions and one #4124 generic Promise closure assertion.
- The two failing files run unchanged on pinned `6ff05f6b`: **11/15** pass,
  with the same four full failure messages after worktree-path normalization.
  No B-induced difference was observed in that comparison; it does not prove
  those pre-existing failures harmless or grant merge clearance.

Reproduction receipts are `.tmp/typed-middleend-frozen-handoff.json`,
`.tmp/typed-middleend-focused-final.json` and
`.tmp/typed-middleend-existing-controls.json` in the B worktree, and
`.tmp/typed-middleend-existing-base-failures.json` in the prerequisite worktree.
The B handoff records exact commands, all 14 path/blob pairs, the first focused
test failure and its test-only correction, and the final measured denominators.
No B production fix was made after the frozen High review.

Integration public compile preservation passes **12/12 complete pairs** against
the pre-split baseline: all six programs in each GVN mode have identical full
binary bytes, WAT, imports, exports, string pools, IR outcomes and returned
values. Candidate receipts `.tmp/typed-public-B-off.json` and
`.tmp/typed-public-B-on.json` cover all 1,259 source files at census SHA-256
`5f7be91f2ac323ddaaf50fea946404df66b08fdf3d79d2131cbf277e971f9670`.

The actual package-equivalent caller-preservation check passes (exit 0), receipt
`.tmp/typed-B-preservation.json`: N1 **6/6** full and dispatch-cut witnesses,
core types **10/10** full and dispatch-cut references, and core nodes **12/12**
observed public-compiler callers. Core-node dispatch-cut remains UNKNOWN.
Strict modeled closure still fails on the same two nonliteral imports in
`getBinaryenModule` and `resolvePlatformCapabilityImport`; no unknown is removed.
The passing extraction verdict is not the failing retirement verdict.
All type backedges, two strict unknown imports, the merge hold and complete
retirement criteria remain in force. No new clean layer is certified.

### B inventory correction and next A handoff

The B source checkpoint is published at `f10ce7aeefd8c5d2bc1e2495a0339ef66006430a`
on non-draft held PR #5745. All 14 changed root suites and normal commit/push
hooks passed, including the final test-only `escapeAnalysis` namespace rename.
CI quality then correctly rejected three new modules omitted from the exact
compiler inventory. Job `101941618517` in run `34188522025` reports three
`unclassified-module` and eight `unclassified-target` errors. The unchanged
local checkpoint reproduces all eleven errors against the same immutable main
base `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`.

The follow-up adds only those three records in `scripts/compiler-boundaries.json`
as **unmigrated / mixed-needs-split**, with destinations `ir-runtime` (async),
`ir-passes` (GVN) and `ir-program` (middle-end). Removing the three additions
restores every prior policy field and record. No active layer, entry floor,
evidence denominator, enforcement code, workflow or exemption changes.

The actual detector now passes inventory mode (exit 0) and still fails complete
mode (exit 1): **1,259 modules, 18 clean, five compatibility adapters, 1,236
unmigrated, four unknown edges, zero inventory errors**. Classification restores
the eight previously rejected incoming edges, making 9,811 resolved edges;
all older source-reference rows remain unchanged. Receipts:
`.tmp/typed-B-boundary-before-inventory.json`,
`.tmp/typed-B-boundary-after-inventory.json` and
`.tmp/typed-B-boundary-after-complete.json`. The Linux CI artifact is preserved
under `.tmp/ci-B-boundary-34188522025/`; external dependency resolution paths
differ because local worktrees share `node_modules`, not because source moved.
All **42/42** existing boundary-detector controls pass, zero skipped, receipt
`.tmp/typed-B-boundary-controls.json`. No detector test or enforcement code changed.

A's frozen worker checkpoint remains at
`/private/tmp/js2-3518-typed-preparation-source-20260908`, base `6ff05f6b` plus
the exact ten B production files. Its current frozen manifest is
`.tmp/typed-preparation-A-frozen-manifest-20260908.json` (eight production paths,
four suites, three helpers). High's first review found incomplete global-owner
joins, pre-admission getter reads and prototype-erased Date data loss. The
repaired files pass **66/66** focused tests, **26/26** legacy compatibility tests
and typecheck; High rechecked all 15 blobs and found no remaining concrete
blocker within that repaired scope. The original lexical/TDZ and native async
refusals remain counted. The coordinator has copied all 15 exact frozen blobs
into integration; this copy alone is not acceptance. Independent historical
preparation comparison and integrated validation remain pending.

High's repair approval was conditional on the input-contract decision, now
resolved below. Portable reflection is not universal hidden-state/Proxy
authentication. The concrete Date rejection is not a claim that a finite
blacklist establishes such authentication. No Node-specific classifier was added.
Reconcile A's three new inventory records, independently compare historical
artifacts, run integrated gates and publish the next source checkpoint.

### User input contract and current integration evidence

The user's explicit decision was relayed from the side conversation on
2026-09-08: **"the position should be to make a robust compiler, but only expect
ir to be fed by js source, not intentionally crafted objects"**.

The typed entry consumes internal compiler data derived from JavaScript source,
including that data's internal lossless transport/replay. It is not a public
security boundary accepting arbitrary live JavaScript objects. Deliberately
injected Proxies, getters or fabricated-object authentication do not block this
migration. This does not relax handling of invalid/adversarial JavaScript source,
IR invariants, complete population, explicit unsupported-construct errors,
lossless supported data, or preservation of program semantics. Existing concrete
capture and malformed-data controls remain; no test is deleted or waived.

The coordinator independently compared A's public compilation receipts against
the pre-split source baseline: **12/12 complete pairs**, six programs each under
GVN off/on, with identical full binary bytes, WAT, import/export order, string
pools, IR emission/outcome records and returned values. Candidate reports
`.tmp/typed-public-A-off.json` and `.tmp/typed-public-A-on.json` in A's worktree
cover all **1,262** source files, SHA-256
`50a5faf25558ed373002c23d4c1656b90813f992171d97b111fc8863e43f4cdf`.
The baseline reports above cover 1,256 source files at unchanged pre-split source
on planning commit `c4cfdfdffd5270776babfb82e32e041f28446a31`; A is uncommitted
on `6ff05f6b5a197f8d0423036f7d171888ff99bd40`, so its census and frozen 15-file
manifest, not HEAD alone, identify the measured candidate. Runtime, locale,
harness and all explicit control fields agree. This is public-route preservation,
not evidence that the new whole-program typed preparation entry executed.

Native Astra Low owns the separate old-versus-new whole-program preparation
comparison in isolated children with root-bound imports. Astra High requires
exact canonical prepared serialization and each arm's codec replay, the actual
instantiated bytes/WAT/values, nonempty live allocation and GVN-merge controls,
source-order reversal, retained TDZ/native-async refusals and comparator negative
controls. The denominator and failures must remain visible. A second Astra Low
agent prepares the three inventory records without changing enforcement.

Published B inventory checkpoint `247f5d011049fe7b70143dbaa8bc1d74ca6c63ae`
has completed CI: **29 passed, 14 skipped, zero failed**, with no unresolved
review threads and a mergeable, non-draft held PR #5745. Quality job
`101944686852` in run `34189575594` passed; its retained inventory artifact
confirms 1,259 modules, 18 clean, five adapters, 1,236 debt, four unknowns and
zero inventory errors. These results apply to B's published head, not the newly
copied A files. The input decision and green PR CI do not remove the merge hold,
resolve the N1 host/queue incident, or authorize direct-codegen retirement.

### A composed implementation: measured preservation and retained gaps

Integration contains the eight production paths, four suites and three helpers
from A's frozen manifest. Twelve blobs remain exact; the only differences in
the other three files are the High-approved input-contract JSDoc clarifications.
The coordinator compared comment-free TypeScript syntax for those three files.
No implementation, negative control or diagnostic rule changed during composition.
The three new inventory records match proposed blob
`9b205989faf41c12fee70f92bd96f6c33ffd1816`; removing them restores all prior policy.

Composed validation passes **169/169 tests in 12 files**, zero failures/skips:
A's 66, B's 77 and the 26 unchanged source/population/projection/validation and
registry compatibility controls. Report: `.tmp/typed-A-integration-focused.json`.
Typecheck exits 0. The actual inventory check passes with **1,262 modules, 18
clean, five adapters, 1,239 debt, 9,835 resolved edges and four unchanged unknowns**;
complete mode still exits 1. Reports: `.tmp/typed-A-boundary-inventory.json` and
`.tmp/typed-A-boundary-complete.json`. The package-equivalent caller-preservation
gate exits 0 (`.tmp/typed-A-preservation.json`): N1 6/6 full/cut, core types 10/10
full/cut, core nodes 12/12 observed callers. The old dead-export population is
unchanged at 25/25. Node dispatch-cut remains UNKNOWN and strict modeled closure
still fails at the same two nonliteral imports; no retirement proof is granted.

The independent historical harness in A's `.tmp/whole-preparation-ab.mjs` calls
the actual old and new `prepareWholeIrProgram`, with every compiler import bound
to the selected checkout in separate children. Nine real source fixtures plus
five reversed multi-source variants run under GVN off/on: **28 historical pairs,
56 arm rows**, not 56 pairs or 28 successful executions. The four r2 reports
(`whole-preparation-base-r2-{off,on}.json` and
`whole-preparation-candidate-r2-{off,on}.json`) have clean terminal receipts,
unchanged source/test censuses and pinned controls/runtime provenance.

Both coordinator and High independently inspected the retained rows: **16/16
prepared canonical-serialization pairs and 10/10 executable artifact pairs
match**, including each program's own decoded replay, actual instantiated Wasm
bytes, WAT and returned values. GVN genuinely removes one of three duplicate
adds in both arms. **26/28 raw rows are identical**; the other two are the
live-record backend failure, with only absolute checkout prefixes differing in
the retained stacks. Exact error text, code, stage and source ownership agree.
The independent census includes two README files excluded by the public-compiler
module census (1,258/1,264 versus 1,256/1,262); every common module hash agrees.

The record fixture prepares and round-trips one live allocation, but backend
emission fails to lower `object<left:f64,right:f64>` after acceptance. The vector
fixture refuses source preparation because it cannot register the `number[]`
annotation. Original TDZ and native async refusals also remain. None is omitted,
waived or counted as execution. **Executed live-allocation preservation remains
unproved**; it is an outstanding migration/backend obligation, not a newly
invented prerequisite for publishing this reviewed preservation checkpoint.

B independently inspected the unchanged source/consumer/lowering paths and
existing codec execution controls. It found no defensible alternative executed
allocation fixture: the consumer supplies no object/vector/closure/boxed/string
materialization, string emission needs absent callbacks, and runtime-backed
alternatives need missing function materialization. Nine relevant files match
the baseline byte-for-byte. No extra speculative compilation or weaker fixture
was used to manufacture a passing allocation witness.

High approved held, non-draft publication of the bounded implementation and found
no A-induced regression in these measured rows. Full checkpoint/backend
acceptance remains open. Its review also found gaps in the temporary comparator:
arm-specific provenance, terminal-receipt admission and nonzero acceptance on
unequal outcomes. That comparator is being repaired with negative controls;
its earlier exit 0 is not accepted as a blanket equality verdict. The reported
pair counts above come from independent row/artifact inspection, not that exit
status. No source-free closure, public cutover or direct-codegen deletion is
claimed. Normal publication hooks and fresh CI on the eventual A head are still
required; the old B CI result does not cover these new source files.

Freeze the A/B contract below. The optional third counter argument is intentional: it preserves partial diagnostics when the **original exception escapes unchanged**, without callbacks or global effects in typed preparation.

### B-owned exports

In `src/ir/passes/gvn-core.ts`:

```ts
export type IrGvnMode = "off" | "on" | "poison";

export interface GvnOptions {
  readonly poison?: boolean;
}

export interface GvnCounters {
  functions: number;
  merged: number;
  poisoned: number;
}

export function createGvnCounters(): GvnCounters;

export function gvnCore(fn: IrFunction, options: GvnOptions, counters: GvnCounters): IrFunction;
```

`createGvnCounters` returns a fresh, sealed, null-prototype record containing exactly three writable numeric data properties, initially zero. No methods, getters, callbacks, global registration or serialized authority.

Keep counter increments at their **existing algorithmic sites**. In particular, empty functions and dominance-analysis refusal do not increment `functions`; partial merges before a subsequent throw remain recorded. GVN-off skips `gvnCore` entirely.

In `src/ir/program-middleend-ir.ts`:

```ts
export interface IrPreparationControls {
  readonly gvnMode: IrGvnMode;
  readonly ownership: boolean;
  readonly escape: boolean;
  readonly verifyIntermediateAllocations: boolean;
  readonly verifyDominanceNaive: boolean;
}

export interface IrProgramOptimizationResult {
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
}

export function runHygienePassesIr(
  fn: IrFunction,
  registry: AllocSiteRegistry | undefined,
  mode: IrGvnMode,
  counters: GvnCounters,
): IrFunction;

export function optimizePreparedIrProgramIr(
  input: PreparedIrProgramProducerInput,
  allocations: AllocSiteRegistry,
  controls: IrPreparationControls,
  counters: GvnCounters,
): IrProgramOptimizationResult;
```

Preserve current node/result types, pass order, ten-iteration ceiling, reference-identity termination and derived-unit ordering. Every nested hygiene call receives the **same transaction counter**. Neither function publishes counters or observations.

In historical `src/ir/program-middleend.ts`:

```ts
export function resolveIrPreparationControlsFromEnv(): IrPreparationControls;
```

This returns a frozen, complete five-field record using the already-specified exact environment conversions.

In `src/ir/verify.ts`:

```ts
export interface IrVerificationOptions {
  readonly verifyDominanceNaive: boolean;
}

export function verifyIrFunction(
  func: IrFunction,
  domain?: TagDomain,
  declarations?: IrModuleDeclarations,
  options?: IrVerificationOptions,
): IrVerifyError[];
```

Preserve the existing default domain. Read the environment **only when `options === undefined`**; explicit `false` must never fall through to it.

### A-owned join

In `program-input.ts`:

```ts
export interface TypedIrProgramOptions {
  readonly policy: RuntimeManifestPolicy;
  readonly runtimePolicies: readonly RuntimeManifestPolicy[];
  readonly controls: IrPreparationControls;
}
```

`TypedIrProgramInput` remains the detached data contract already specified. Counters are **not** part of either serialized input or options.

In `program-prepare-ir.ts`:

```ts
export function prepareTypedIrProgram(
  input: TypedIrProgramInput,
  options: TypedIrProgramOptions,
  counters?: GvnCounters,
): IrProgramPreparationResult;
```

Absent counters mean a fresh private accumulator—not legacy reporting. A validates supplied diagnostic records as sealed, own-data-only three-counter records; the outer caller supplies fresh zero counters.

A calls B’s resolved optimizer directly. Final validation becomes:

```ts
export function assertPreparedIrProgram(program: PreparedIrProgram, options?: IrVerificationOptions): void;
```

A forwards `options` to every final `verifyIrFunction` invocation. Typed preparation always supplies the explicit dominance setting; historical callers may omit it. Intermediate allocation verification uses the resolved boolean; final allocation verification remains unconditional.

B does not import A’s new input/options module: its existing `PreparedIrProgramProducerInput` contract suffices.

### Counter ownership and compatibility

B’s historical `gvn.ts` additionally exports:

```ts
export function recordLegacyGvnCountersOnce(counters: GvnCounters): void;
```

It owns the existing aggregate counters and a private already-recorded `WeakSet`. Repeated recording of the same accumulator is a no-op. For valid factory-created counters, recording must not throw or mask an in-flight error.

The ownership rules are:

- Historical `gvn(fn, options)` creates counters, calls `gvnCore`, and records in `finally`.
- `gvnFromEnv` retains its current mode parsing and delegates to historical `gvn`; it does **not** record separately.
- Preserve historical `runHygienePasses`’ existing `gvnFromEnv` orchestration, including its real integration callers. It adds **no outer counter publication**.
- Historical `optimizePreparedIrProgram` delegates to the resolved optimizer with fresh counters and records once in `finally`.
- A’s `prepareWholeIrProgram` calls the **resolved** optimizer through typed preparation, never the historical optimizer.

A’s wrapper ordering is:

1. Preserve existing policy validation and source-failure ordering.
2. Produce/detach frontend input; resolve controls.
3. Create counters; invoke typed preparation inside `try/finally`.
4. Record counters in `finally`, including typed refusal and thrown failure.
5. On successful preparation only, publish the existing `prepared` observation and return the unchanged result shape.

Record **before** notifying observers. If an observer throws, counts are already accounted for and its original error escapes unchanged.

GVN debug enablement stays evaluated when the **legacy GVN module loads**. Keep its existing exit-handler condition, output format and aggregate behavior even if the environment changes later. The typed import closure must not load this compatibility module or install its handler.

### Required cross-worker controls

**B tests**

- Real merges/poison and unchanged-function identity.
- Exact counter values for off, empty, dominance refusal and repeated hygiene rounds.
- Injected sentinel throw after a real counter increment: same thrown object, partial counts retained.
- Repeated publication cannot double-count.
- Import-time debug enablement versus later environment changes.
- Historical hygiene and resolved hygiene agree under fixed settings; historical callers still exercise `gvnFromEnv`.

**A integration tests**

- Fixed options ignore contradictory ambient controls, including final validation.
- Success, returned refusal and thrown failure each publish counters exactly once.
- Observer failure preserves its exception and cannot lose or duplicate counts.
- Nested/sequential compilations use distinct accumulators.
- Direct typed preparation produces no legacy debug/observer effects.
- Counter records never enter captured input, prepared-program encoding or runtime authority.

No additional source paths beyond the dispatched A/B maps are needed. No exception wrapping, diagnostics callbacks, global typed-entry telemetry or ABI/schema changes.

## Architecture and acceptance evidence

The following original specification and required amendment preserve all scope,
lifecycle and acceptance requirements. Their historical proposed/unclaimed status
is superseded by the live dispatch above. The amendment supersedes earlier options
and observation placement; the frozen API above makes the join exact.

# Next checkpoint: source-free typed preparation

Status: Astra High specification, with coordinator reconciliation and amendment.
Implementation has NOT been dispatched, and the proposed claim has NOT been acquired.
The amendment below supersedes the initial proposal wherever it changes options,
observation placement, file scope or losslessness requirements.
This concerns the repository epic `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`,
not GitHub item 3518 (which is an unrelated historical pull request).

Current published prerequisite: non-draft held PR #5744, head
`6ff05f6b5a197f8d0423036f7d171888ff99bd40`. Its code, tests and caller-proof handoff
are pushed. All future implementation checkpoints must also use non-draft PRs on
`loopdive/js2`; keep the existing merge hold and do not enqueue or merge.

## Coordinator reconciliation

- Upstream main remains `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`.
- Fresh authoritative assignment read: `1aada624aa73f843511e7b4c41f84c0b9332490b`,
  2,138 total records and 817 active claims. Historical preparation, runtime,
  async and backend claims remain intact. No source ownership is released here.
- P: 12 modified/untracked source/test files at `6037ac8bcf07be4f71839cea33cf8c90ecc87f94`,
  sorted path/blob fingerprint `ecb33cddf6a6d0049b5c6d4b8440a2d95415ae60bf7a108172c396dc62816494`.
- C: five modified/untracked source/test files at `9feb7bf8fc0f8fddccf87235c7664651eb338e92`,
  fingerprint `73665f99262a0bae9dac0b48e21c1cbd0c1ec247b39885fc087e826c2047e73f`.
  Both fingerprints were revalidated unchanged; both drafts remain untouched.
- Coordinator read all four overlapping P diffs and its callable-result helper.
  Reconcile only the callable/body-result distinction now. Do not import the
  resource ABI union, schema-v2 amendment, host resource producer or C materializer.
- Before writes, acquire and verify the new bounded scope, preserve all existing
  claim records, establish file-disjoint native Astra Low worker ownership, and
  freeze interfaces between workers. Astra High reviews the integrated result;
  the coordinator owns normal-hook commits, pushes and PR shepherding.
- No ABI-getter decision, workflow/ruleset change, Temporal concurrency fix,
  retirement exception, host/linear cutover or clean-layer certification is granted.

## Initial specification

Recommend the **actual typed-preparation handoff**, before relocating the whole preparation package. This follows Phase 1’s explicit “split before placing” sequence and changes a real producer/consumer boundary.

Inspected source at `6ff05f6b5a197f8d0423036f7d171888ff99bd40`; its `src/` is unchanged from `8429806b`. P/C remain preserved at the bases and fingerprints you revalidated.

### Concrete boundary

Today, [prepareWholeIrProgram](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/program-preparation.ts#L30) invokes the frontend once, then performs async transformation, optimization, ABI construction, runtime projection and sealing.

Two things prevent simply extracting its tail:

- [The source carrier](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/program-source.ts#L45) contains **actual AST declarations** through `globals[].identity.declaration`, plus a mutable allocation registry.
- Runtime preparation still loads AST inventory through `createDerivedIrUnitId` imports in four modules; `async-prepare.ts` also mixes its IR transformation with an AST predicate.

Introduce `prepareTypedIrProgram(input, options)`, called by the existing `prepareWholeIrProgram` wrapper. Its input contains:

- Complete inventory, canonical semantic `core.IrModule`, derived-unit provenance, startup plans and callable records.
- Explicit global storage records: source/storage-owner IDs, value/TDZ references and semantic type. Frontend-only declarations/resolvers never cross.
- A complete allocation snapshot—not the frontend’s mutable registry.
- Existing resolved policy requests and explicit ownership/escape-analysis choices; no checker, oracle, source callbacks, emitter or backend allocator.

Keep the existing source-preparation API for its other consumers. Construct the new projection explicitly; neither spreading the old carrier nor casting away `declaration` is sufficient.

### Proposed exact source claim

Proposed, **not acquired**: `3518:typed-program-preparation-boundary`.

New files:

- `src/ir/program-input.ts`: detached input contract and structural admission.
- `src/ir/program-prepare-ir.ts`: existing preparation tail, accepting only that input.
- `src/ir/async-prepare-ir.ts`: existing IR transformation declarations and helpers, excluding `isSingleAwaitReturnAsyncCandidate`.
- `src/ir/program-callable-contract.ts`: P’s canonical callable-result helper, reconciled against canonical core types.

Existing files:

- `src/ir/program-source.ts`: explicit detached projection; reconcile P’s separate body-result/callable-result construction.
- `src/ir/program-preparation.ts`: preserve existing API, policy-validation order and failure behavior; delegate frontend output to the typed entry.
- `src/ir/program-abi-contracts.ts`: consume the detached global contract; apply P’s callable-result correction.
- `src/ir/program-validation.ts`: corresponding canonical callable-result comparison only.
- `src/ir/alloc-registry.ts`: validated reconstruction of an independently owned registry.
- `src/ir/program-middleend.ts`: receive resolved analysis choices instead of reading environment variables inside the typed transaction.
- `src/ir/async-prepare.ts`: retain the AST predicate and compatibility re-exports of moved IR transformations.
- `src/ir/runtime-program-producers.ts`: import the IR-only transformation module; redirect identity construction downward.
- `src/ir/async-linear-prepare.ts`
- `src/ir/passes/monomorphize.ts`

The last two receive **identity-import corrections only**. Here “linear” describes sequential suspension IR, not authorization for linear-memory backend work. Preserve the existing transformation order and supported shapes.

No writes to C’s consumer/materializer, `prepare.ts`, the pending ABI getter, compiler/public dispatch, settings or CI.

### Lifecycle authority to preserve

The frontend alone owns AST/checker joins, source ordering, TDZ/startup proofs and original body construction.

Typed preparation owns its working allocation registry and all subsequent transformations. Restore the **entire** snapshot: IDs, live/aliased/retired slots, metadata namespaces and explicit `undefined` entries. Do not rebuild just live sites, renumber allocations, flatten evidence opportunistically or reuse the frontend registry.

Preserve the current sequence:

1. Validate complete source/body population.
2. Construct provisional callable ABI; produce async plans and derived bodies.
3. Run existing passes and reconcile derived ownership.
4. Freeze semantic data.
5. Scan every final body/state; select runtime projections.
6. Freeze authenticated attachments **in place**, validate, then publish the single `prepared` observation.

[Runtime replay](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/program-codec.ts#L403) must continue regenerating projections and rejecting contradictions. C retains private acceptance/reservation/emission authority; no new token or allocator crosses this seam.

### What to retain from P/C

**Use P’s canonical callable/body distinction now.** Async callable results are Promise carriers, while body results describe fulfillment. That correction belongs in frontend call planning, ABI production and validation together.

**Preserve—but do not integrate wholesale—P’s resource extension.** Its valuable contracts are the single ABI union, owner-qualified helper identities, delayed sealing and replay reconstruction. However, its preserved, uncommitted `src/ir/program-async-resources.ts:275` explicitly reports native resources unavailable and declares host resources otherwise. Its v2 codec/schema amendment is inseparable from that resource contract, not required for this boundary checkpoint.

C’s reservation-before-seal, immutable acceptance and revocation mechanisms remain valuable later. Its current async planner/materializer is host-specific; resuming it would not implement standalone resource closure.

The proposed map overlaps **four P files**: source, preparation, ABI contracts and validation, plus reuse of its new callable helper. It intersects no C source file. Parent must reconcile those P hunks and the historical runtime-producer/async claims before dispatch.

### Acceptance and honest limits

Add focused tests:

- `tests/issue-3518-typed-program-preparation.test.ts`
- `tests/issue-3518-typed-program-source-free.test.ts`
- `tests/issue-3518-preparation-allocation-replay.test.ts`
- Standalone adaptations of P’s canonical-callable controls.

Require real frontend-produced inputs, exact population floors, source-order reversal, aliases/reexports, live globals/TDZ, allocation mutation isolation and async callable/fulfillment checks. Compare split versus original preparation, final encoded programs and supported standalone execution. Unsupported native resources remain located refusals—not omitted owners.

A fresh process must prepare captured, losslessly transported frontend output and codec-revalidate it while rejecting frontend/checker/direct-generator loads. Include a positive forbidden-load control. Preserve all existing N1/core-type/core-node gate populations and strict unknowns.

**Measured architectural limit:** my in-memory value-import projection, cutting the source call and correcting those five AST-loading causes, reached 67 modules/202 value edges with no frontend/backend dependency or nonliteral loading encountered. This is a source projection, **not an executed proof**.

Type-only backedges remain through inventory/outcomes, program contracts, startup, prepared attachments and other mixed adapters. Therefore these new implementation files should remain explicitly tracked migration debt: **do not place them in or certify the clean `ir/program` layer yet.** Canonical destinations remain `frontend/ts/prepare-source-program.ts`, `ir/program/prepare.ts` and `ir/runtime/*` after their complete type closure is separated.

This checkpoint makes preparation genuinely invocable without source services; it does not finish folder separation, standalone backend extraction or public IR-only cutover. It requires parent scope approval, but no new architectural choice, ABI compatibility decision or retirement exception.

## Required amendment after coordinator review

The amendment needs **five explicit execution controls plus one legacy diagnostic setting**. My earlier options list was incomplete.

### Ambient controls found

The same projected closure remains 67 modules/202 value edges. Source inspection found:

- GVN mode: [gvn.ts:92](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/passes/gvn.ts#L92).
- GVN debug: import-time environment read, exit-handler registration, global counters and stderr output at that file’s line 98.
- Ownership and escape: `program-middleend.ts:96`.
- Intermediate allocation verification: [verify-alloc.ts:57](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/verify-alloc.ts#L57), reached through `assertAllocProvenance`.
- Naive dominance verification: [verify.ts:428](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/verify.ts#L428), reached both during optimization and final program validation.

The capability catalog’s `JS2WASM_FIXED_ARITY_HOST_CALLS` occurrences describe selection evidence; they do not read the environment. The dominance-analysis file’s flag mention is documentation, not another reader.

### Minimal scope/options amendment

Add these **four paths** to the previously proposed source map:

- `src/ir/passes/gvn-core.ts` — environment-free GVN implementation with transaction-owned statistics.
- `src/ir/passes/gvn.ts` — retain historical `gvn`/`gvnFromEnv` APIs, exact mode interpretation and import-time debug behavior; delegate to the shared implementation.
- `src/ir/program-middleend-ir.ts` — resolved-options hygiene/optimization implementation. The existing middleend file remains the historical wrapper.
- `src/ir/verify.ts` — add an explicit verification-options argument; omitted options retain historical environment behavior.

The already-mapped `program-validation.ts` must forward explicit verification options to its final `verifyIrFunction` call. Otherwise the last validation still rereads ambient state.

Require these fields on typed preparation’s resolved controls:

- `gvnMode: "off" | "on" | "poison"`
- `ownership: boolean`
- `escape: boolean`
- `verifyIntermediateAllocations: boolean`
- `verifyDominanceNaive: boolean`

Preserve exact conversions: GVN accepts `"1"`, `"true"`, `"poison"`; ownership/escape/allocation verification accept `"1"` or `"true"`; naive dominance accepts only `"1"`. No changed defaults.

For intermediate allocation checks, the resolved implementation can conditionally call existing `assertFinalAllocProvenance`; both existing wrappers use the same throwing checker. **Final publication checks remain unconditional.** No `verify-alloc.ts` edit is necessary.

Resolve controls in the compatibility wrapper before entering typed preparation—after frontend production for the whole-source API. Preserve historical standalone calls to `runHygienePasses`, including its four production integration callers. Typed execution never calls an environment wrapper.

Keep GVN debug outside semantic controls: preserve its **import-time** enablement, aggregate real counters, and retain diagnostics on failure paths. Typed execution must neither install exit handlers nor update process-global statistics. Use bounded transaction-owned counter data, not an arbitrary callback/context.

Likewise, move the `prepared` observation from the typed entry to its successful compatibility wrapper. Its listeners are executable process-global state; publish exactly once after validation.

### Allocation capture and admission

[snapshot()](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/alloc-registry.ts#L228) is shallow. Copying its arrays alone does not detach site types, origins or metadata values.

Separate three contracts:

1. **Capture:** preserve every slot, alias target, retired slot, metadata row and namespace/value pair. Preserve missing versus present-`undefined`, row/entry order and applicable shared/recursive identities. No namespace filtering or JSON normalization.
2. **Structural restoration:** validate IDs, denominator, duplicate rows/namespaces and alias structure; reconstruct exact registry state without replaying `alias()` operations that flatten chains or merge metadata. Next `fresh()` must retain the original index.
3. **Final semantic verification:** retain existing [program allocation validation](https://github.com/loopdive/js2/blob/6ff05f6b5a197f8d0423036f7d171888ff99bd40/src/ir/program-allocations.ts#L53), which recognizes only encoding/ownership/escape evidence and recomputes it.

An unknown namespace containing admissible data must survive capture/restoration unchanged. If it survives legitimate transformations, today’s final validator rejects it. Do not silently drop it, bless it as verified, or apply final metadata verification prematurely to unoptimized input.

`unknown` metadata values are **not permission to serialize arbitrary executable objects**. Inspect descriptors without invoking accessors; unsupported instances/functions/symbols or unrepresentable graph structure produce an explicit capture failure, never omission or a replacement value. Existing registry APIs retain their generic metadata behavior.

Do not assume existing helpers establish losslessness: array branches in the copier/codec do not preserve arbitrary extra array properties. Capture must detect such cases before normalization.

### Transport and acceptance additions

No P resource/schema-v2 or C production-codec change is required. The new boundary is an in-memory contract; fresh-process evidence may use a dedicated test transport, but must prove exact round-trip preservation of the captured packet **before preparation**. It must not cast raw input into `PreparedIrProgram` or treat ordinary JSON as universally lossless.

Add controls to the already-proposed tests for:

- Fixed resolved controls under contradictory ambient settings, including import-time debug settings; no typed-entry exit registration/stderr/observer callbacks.
- Real GVN merges and poison execution, plus historical wrapper mode/default parity.
- Explicit intermediate/final verification behavior.
- Unknown metadata namespace retention; present `undefined`, sparse arrays, special numbers, bigint, collections and recursive class-shape handling.
- Nonempty alias chains, retired targets, metadata collision precedence and next-allocation identity.
- Accessors, extra array properties and unsupported metadata failing capture without becoming “empty metadata.”
- Source/packet/restored-state comparison and caller-mutation isolation.

Retain unsupported capture cases in the evidence denominator; if a real supported source produces one, that blocks the checkpoint rather than narrowing its corpus.

Finally, describe this as **source-free preparation with explicit controls and owned state**, not universal referential transparency: authenticated runtime attachments retain existing identity bookkeeping, and ordering still uses runtime-dependent `localeCompare`. Record Node/V8/ICU/locale provenance; do not change ordering semantics in this slice.
