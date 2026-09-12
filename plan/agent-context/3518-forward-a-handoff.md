# Lane A forward driver checkpoint — 2026-09-07

## Authority and captured base

Authorized isolated continuation from recoverable C head
`651034e4fd295e826d73a769200279210b2b35e7`, not a claim to have recovered
the latest original A. Worktree `/Users/thomas/.codex/worktrees/c897/js2`,
branch `codex/3518-forward-a-prepared-driver`. High specification:
`9afe370642b2475434a21f68e73ce6af1e66c8a7`, final sections of issues 3518/3525.
Parent verified this is PR #5692's current head on the fork branch
`claude/3518-whole-program-c-20260906`. All original owners and held claims
remain unchanged. Any late recovered A output split must be compared before
adoption; no recovered driver/result files exist at this base.

Base blobs: compiler.ts `ef67764f17d9e47bb0a0be269f0fe5a0d0ad0ac8`,
compiler/output.ts `ab9cecead1b19b62c59a3acb6aa20853652060e9`,
index.ts `b471912f8d9da43718c751902b6623cc7aa5843d` (parent inventory).
Baseline rerun before source edits: 1 file, 2/2 tests passed, 12.25 seconds.
Initial 1/2 failure was a test-oracle correction for absent scalar signature,
not a compiler regression. The baseline focused run used one fork, heap ≤2048MB;
the initial six-suite overlap and explicit subsequent serial settings are
recorded below.

## Public baseline inventory (recorded before source edits)

`compile`, `compileMulti`, `compileFiles`, and bundled `compileProject` use
`runPipeline`; sync eval uses `compileSourceSync`. `compileToWat` calls
`compileSource` with `emitWat: true`. The generation block selects
`generateModule`, `generateMultiModule`, `generateLinearModule`, or
`generateLinearMultiModule`. Public `compileToObject` uses a separate
`compileToObjectSource` and `generateModule(ast)` without caller codegen
options. Its existing standalone refusal returns zero object bytes. There is
no public `compileSync` entry.

The owned focused test captures the real public scalar fixture
`export function calculate(value: number): number { return value * 3 + 2; }`.
Baseline execution returns 23 for 7; binary, WAT, DTS, source-map JSON, import
helper and adapter manifest are present. **The scalar base does not populate
`exportSignatures.calculate`**: an initial stronger expectation failed, so it
is not a contract credited to the candidate. Sync, one-file multi, WAT and
object routes succeed; standalone object refuses. Object bytes alone are not
linked-runtime evidence. Files/project, poison, linked-object and full target
matrices are outstanding; this two-test baseline does not cover them.

## Finalizer field readers and mutation order

After generation, `runPipeline` applies C ABI rewriting (linear + C ABI), then
widens reference types in module types/functions/globals/imports. Preserve
that mutation order. Import manifest uses imports/types, stringLiteralValues,
externClasses and jsxImportSource. Host inventory uses imports and link/profile
inputs; capability requirements additionally read platformCapabilityImportProvenance.
Binary/WAT read types, imports, functions, tables, memories, tags, globals,
exports, startFuncIdx, elements, declaredFuncRefs, dataSegments, and function
layout/ordinal mappings. Binary grouping and ABI verification read
canonicalRuntimeRecGroup. Source-map emission depends on authentic instruction
positions and the frontend's original sourcesContent, not only module bytes.
DTS consumes entry AST and asyncFunctions. WIT consumes entry AST, imports,
types and the same capability requirements. Adapter/import helper consumes
stringPool, imports, exportSignatures and derived export boundary policies.
Result publishes stringPool, exportSignatures, hasTopLevelStatements and
hasMain (from exports), plus target, capabilities, diagnostics and telemetry.
Validation failure deliberately retains emitted bytes; generation/refusal
failure does not. WAT failure is a warning. Preserve all existing diagnostics.

`compileSource` applies async optimization after sync output; optimizer warnings
use line/column zero. Multi/files use `applyOptimize` with a source anchor.
Both preserve unoptimized output on canonical rec-group drift. The sync core
ignores optimize. Public wrappers attach the import object after finalization.

`compileToObjectSource` emits without the executable finalizer's widening,
optimizer, DTS, WAT or source-map steps. `emitObject` consumes types/imports/
functions/tables/tags/globals/exports/elements and funcOrdinalToPosition;
symbol names derive from function/global names, with export flags from indices.
Do not replace this contract with executable-binary finalization.

## Explicit cutover dependencies

C constructs a physical module but does not supply exportSignatures,
hasTopLevelStatements, asyncFunctions classification or original instruction
positions. Accepted sourceMap/utf8Storage/moduleName options do not establish
their output contracts. An empty default module field is not metadata proof.
Example obligations: exported reference/string function for adapter conversion;
ordered live-global startup for hasTopLevelStatements; async export for DTS;
scalar source-map fixture with actual mapped original positions. Startup
adapter evidence exists through C's emittedStartupAdapterIndex accessor.

Object obligation: two sources with an aliased exported callable and live
global initialized at startup must survive emitObject → real linker → runtime
under public export names. C source-qualified physical names differ from export
labels; the current object writer derives symbols from physical names and
does not carry a start section/startup metadata. Nonempty object bytes prove
neither alias nor startup preservation. This requires existing object/linker
owners; A must not rewrite their machinery.

C also refuses unsupported async/reference layouts and some linear/WASI
physical capabilities. Preserve typed located refusal internally and retain
all current public generators until the full matrix passes. Preparation and
acceptance can RETURN invariant failures; those must throw, just like thrown
invariants. No arbitrary exception conversion, retries, manufactured tokens,
empty invented telemetry, or public optional IR mode is authorized.

The checkpoint may extract finalization in owned existing files while retaining
production generator selection. No C module is presented as a complete public
CompileResult. Full public poison/linked-object/CLI/selfhost matrices, both
backends/target profiles, optimizer and broad regression checks remain eventual
cutover obligations, not completed by scalar internal execution.

## Measured preservation failures on the recovered stack

Candidate six-suite output run: 72/81 passed; 9 failed. The original run's
CLI worker bound was overridden by vitest.config.ts pool maxForks (timing
showed overlap), so subsequent runs explicitly set VITEST_MAX_FORKS=1 and
--no-file-parallelism in addition to 2048MB fork/process heap limits.
Pristine baseline checkout `/private/tmp/js2-a-baseline-651034e`, detached at
exact `651034e4fd295e826d73a769200279210b2b35e7`, reran both failing suites:
21/30 passed, the same 9 failures, no edits to source or existing tests.

- object-file.test.ts: exported function symbol flags and the test named
  imported function UNDEFINED both fail `expected +0 to be truthy` at exported
  flag assertions; call relocation entries and reloc.CODE section-index tests
  both fail because reloc.CODE is absent (`expected undefined to be defined`).
- sourcemap.test.ts: enabled map source count and decoded mapping segment
  count are zero; filename list lacks mymodule.ts; sourcesContent has no
  non-null entries; raw WebAssembly.instantiate omits the required imports
  object. All five failure messages match on base and candidate.

Source-map JSON presence in the scalar baseline is not proof of real mapped
positions. The four entirely green preservation files are issue-1927 (10),
c-abi (38), cli-imports-helper-export-metadata (2), and output-widen-dag (1).
These existing failures remain open upstream-stack contracts; no expected
results were changed to force a green result.

## Implemented checkpoint and final validation

Six owned files changed; src/index.ts is unchanged. New internal
runIrProgramDriver snapshots runtime/backend options, calls the real whole
preparation once, accepts once and passes only C's authentic token to emission.
Its emitted result retains the actual program and emission receipt references.
Unsupported retains the original located failure and phase. Returned invariants
throw IrProgramDriverInvariantError carrying the original failure; thrown
exceptions retain identity. No public CompileResult or optional mode is added.

Existing executable finalization is extracted within compiler.ts, retaining
the original resolved target and emitWat/sourceMap snapshots. Object
finalization stays within output.ts. Existing public failResult, its telemetry
type and EMPTY_FAILURE_TELEMETRY move unchanged into output.ts. Optimizer
adapters and public wrappers are untouched. No new allowance is needed.

Final serial run: 5 files, **67/67 tests passed** (36.53 seconds): owned driver
16, validation parity 10, C ABI 38, CLI helper metadata 2, widening DAG 1.
The 16 driver tests include scalar execution on wasmgc/host,
wasmgc/strict-no-host and linear/host (7 → 23, 11 → 35); two-source main → 42
(2 sources, 2 emitted receipts); real namespace preparation refusal; missing
runtime-projection acceptance refusal; option snapshot mutation; injected
preparation Unsupported; returned invariants in two phases; thrown failures
in three phases; and three public output/poison controls. All internal cases
count all four legacy generator entries; scalar positives poison them. The
unchanged public object route hits poison exactly once and publishes no bytes,
proving the detector is attached. The missing wasmgc:wasi projection control
does not establish that an actually prepared WASI scalar is unsupported.

Typecheck passes with NODE_OPTIONS=--max-old-space-size=2048. LOC/function,
coercion, oracle, dead-export, IR layering/dialect/kind-neutrality gates pass.
Fresh-main simulation uses API-verified upstream main
`aa00621d96496e5d760b930e0cfb3da0bfaade6e`: LOC gate fails only on inherited
src/runtime.ts, 19451 > 19450 (+1). A never edits runtime.ts; this is a stacked
#5692 integration dependency and is not hidden with a new allowance or baseline
change. Default merge-base LOC check passes; distinguish that result from
fresh-main CI readiness.
Fresh-main function gate likewise reports inherited runtime.ts::resolveImport
7650 > 7648 and runtime.ts::<anonymous>#95 311 > 309. Recovered base and A
working tree both hash runtime.ts to `8ab771029e271e50af29f76f532a5adcc7ef665f`;
upstream aa00621 has `3c3fac1d818fd4a54251dc0c55de12c9262214a4`. Scoped Biome
lint passes for all five TypeScript files. These two fresh-main gate failures
are recorded limitations of the stacked branch, not green CI claims.
Final source blobs (in order, after formatting):

- compiler.ts: `ed0b981e63254c2c7e91dc8faf3a57800f419a91`
- compiler/output.ts: `d2fbe1c872567de1b41d5cc0486fb9251d6eac70`
- compiler/ir-program-driver.ts: `01db12ce7062e200467583afb73d6c370a0256d3`
- compiler/ir-program-result.ts: `c3187ac2540bb45531beee98b459578c95ad6a28`
- tests/issue-3525-public-prepared-driver.test.ts: `7151a922494a04953e485b8263bdeb9b6d8fc461`

This is an internal checkpoint stacked on #5692, not completed frontend
retirement. No full equivalence/Test262 or linked-object runtime matrix was
run. Preserve the isolated baseline checkout for audit. Original owners and
held claims were not modified.

## Main integration conflict repair — 2026-09-07

PR #5715 at f10c42d97a was confirmed CONFLICTING/DIRTY. The remote head still
matched local HEAD. A normal merge integrates canonical upstream main
`b577c29420d98069748c4416293e2ba019893db1`; C #5692 was still open/unmerged at
`62285503f25059e7f5266cea46eec01defa82155` when checked.

Only plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md and
plan/issues/3527-ir-r7-ast-free-async-plan.md conflicted. Both were append-only
collisions between historical implementation notes and the landed September 7
High specification. Resolution retains both complete sections in that order.
No A TypeScript file changed, and no source conflict required resolution.

Merged-tree validation: driver/public controls 16/16 passed in one 2048MB fork;
issue integrity and diff whitespace checks passed; default LOC/function,
coercion, oracle and dead-export checks passed. Prior pre-integration failure
measurements above remain historical evidence, not measurements of this merge.
