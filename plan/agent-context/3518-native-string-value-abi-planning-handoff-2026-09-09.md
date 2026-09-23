# Native string/value ABI planning — worker r2

Worktree: `/private/tmp/js2-3518-native-string-value-abi-planning-20260909`.
Branch: `codex/3518-native-string-value-abi-planning-20260909`.
HEAD/base: `ea0f05c36267939d5731e3d5e927ada071ae1780`, independently verified
published non-draft #5782. No implementation commit, merge, push or PR operation.
Parent owns composed validation and held, non-draft publication.

## Revision 2 — support callable ownership repair

High's complete review found the missing source owner on internal support
callables. Production differs from r1 by exactly one added line:
`sourceId: anchor.id` in the support-function intent of `internalNativeBinding`.
Global/type intents and the native runtime unbox intent are unchanged; runtime
unbox remains owner-free. The explicit materializer fixture now names the same
entry-source anchor as its support reference.

Current frozen hashes:

- `src/ir/program-physical-plan.ts`: Git blob
  `0ec09bc81a4eda75a814969ec39ef87ca055a7ed`; SHA-256
  `ba0066c37237d101355a3ef81f0d690e6705aefeccd607e8fea8a0c0fd73fbcf`.
- `tests/issue-3518-native-string-value-abi-planning.test.ts`: Git blob
  `f48d0b3e3ed60dd29d4a1e3f9be15943b326da8b`; SHA-256
  `64259aaa6b110eaae73108d8d12f80998a9e6a5819d0d2a74be7a7979199e317`.

The AST census is **61 authored cases; 0 executed** (all original 57 retained).
Two new cases enumerate genuine oversized-literal and number-boundary support
callables, seal the complete positive plan with the unchanged `ProgramAbiMap`,
then independently remove or substitute their source owner. Two more cases
exercise missing/foreign ownership of the explicit materializer contract after
a genuine positive. Foreign IDs come from a separate actual source inventory;
they are not forged brands. Exact error codes distinguish missing provenance
from an owner outside the inventory. Existing native-unbox intent equality and
new absence checks pin runtime/global/type entries as source-owner-free.

Formatting, syntax-only AST parsing, exact one-line production reconstruction,
r1 snapshot hashes and `git diff --check` pass. No tests, typecheck, hooks or
other heavy processes were started. Parent composition and execution remain
unrun obligations; no new acceptance claim is made.

The unchanged r1 manifest is
`.tmp/native-string-value-abi-planning-frozen-r1.json`; exact three-file snapshots
are under `.tmp/r1-retained/`. Current three-file receipt is
`.tmp/native-string-value-abi-planning-frozen-r2.json`. Remaining sections below
retain the historical r1 handoff and its unrun commands/limitations.

## Historical r1 source and test (preserved)

- `src/ir/program-physical-plan.ts`: Git blob
  `cda5add7f0b328e9b3d246ffca99f3ba0e730fb5`; SHA-256
  `23f10c61067982f2ccb6956cbaf84c9f9685075acf8fbf4fdc17ed6cace1e771`.
- `tests/issue-3518-native-string-value-abi-planning.test.ts`: Git blob
  `5f0359da5246626e3faaefdd534b680972ea7d30`; SHA-256
  `10c30d5a0da831a70403512e52ed0e3d3a6c053762224ec557748d6b4d20853c`.

This handoff is the third owned path. All root, peer, previous source-admission
and other historical worktrees remain unchanged. No aggregate, resource,
consumer, source producer, boundary policy or shared script was edited.

## Agreed interface

`planPhysicalSetup(program, options, projection, native?)` accepts the optional
exact `NativeStringValueReservationInput` supplied by the parent. It adds only
`PhysicalSetupPlan.nativeStrings?: PhysicalNativeStringSetup`, containing:

```ts
interface PhysicalNativeStringSetup {
  readonly resources: NativeStringValuePhysicalPlan;
  readonly bindings: readonly NativeStringValueAbiBinding[];
}
interface NativeStringValueAbiBinding {
  readonly resourceKey: string;
  readonly entry: ProgramAbiPlanEntry;
  readonly reference: IrFuncRef | IrGlobalRef | IrTypeRef;
}
```

The consumer retains issued input privately. Only descriptive resources and
bindings enter the existing deep-frozen physical setup copy. This file never
allocates resources or clones the issued value-plan authority.

`PhysicalSignatureType` additionally carries logical `string`, alongside the
existing Wasm values and logical vectors. Native carrier attachments must
structurally join the recipe's AnyString declaration and a required semantic
type entry; an unjoined physical index is not evidence. The supported attached
carrier is non-null; nullable/foreign carriers fail rather than silently losing
nullability. The parent performs actual carrier-index conversion after type
reservation.

New exported type declarations: `NativeStringValueAbiBinding` and
`PhysicalNativeStringSetup`. All previous exports remain:
`PhysicalSignatureType`, `PhysicalFunctionSlot`, `PhysicalImportedFunction`,
`PhysicalDefinedGlobal`, `PhysicalImportedGlobal`, `PhysicalExport`,
`PhysicalStartup`, `PhysicalExceptionTag`, `PhysicalSetupPlan`,
`PhysicalSetupOutcome`, `planNativeVectorResources`,
`planNativePromiseResources`, `planNativeValueResources`, `planPhysicalSetup`.

## Planning behavior

- Authenticate the complete prepared program/projection through the retained
  entry check. Recompute the canonical aggregate recipe and compare the full
  declaration/selection data, then authenticate the exact issued value plan.
- Preserve every semantic ABI entry/order/alias. Literal reuse starts at the
  actual storage/materializer reference, checks the canonical alias root and
  its semantic contract, and separately uses the canonical physical recipe.
  Alias and canonical resolver references are retained as separate rows that
  all name the same required root. Two independent roots cannot own one token.
- Native unbox requires actual projected occurrences, the selected native
  number policy, complete unique canonical manifest/provider-map row, canonical
  intrinsic signature and each exact callable attachment. Its runtime intent
  contains only runtime origin and signature. Internal box remains support.
- Every other declaration receives a typed support-global/support-callable or
  source-type binding using canonical identity factories and the versioned
  structural role. Complete declarations remain authoritative; symbolic ABI
  keys are not standalone authentication receipts.
- Supplemental order is the safe-integer maximum at the entry-source anchor
  plus one and the original declaration index, retaining holes after reuse.
  New IDs and aliases are checked with the existing ProgramAbiMap rules.
- Existing no-demand behavior has no `nativeStrings` own property. Logical
  string signatures and authenticated native entries/providers are admitted
  only with an explicit nonempty native input. Other body/resource gaps stay.

Parent emission must plan original entries and new IDs in one emission ABI map,
check reused rows exactly, seal before allocation, reconcile complete actual
descriptors/tokens, and bind each canonical ID once using final indices. It owns
all acceptance, reservation, lowering, fill, publication and execution wiring.

## Validation evidence and remaining work

Static checks only: formatting, `git diff --check`, and TypeScript syntax ASTs
pass for both files. The main planner is 254 physical lines after formatting;
largest added helper is 113. The production file is 969 lines. The existing
vector, Promise and value-plan entry function bodies remain unchanged.

The test AST enumerates **57 authored cases; 0 executed**. The first eight
cover genuine source-produced literal/numeric programs across original/decoded
preparation and UTF modes. Further controls cover no-demand shape, historical
located refusal, canonical unbox/support-box distinction, private chunks and
empty encodings. Semantic storage/materializer/alias/carrier controls explicitly
add typed contracts over source-produced bodies and reauthenticate through the
actual codec; they do not claim the frontend already produces those references.
All countermodels retain a positive first. No validator/producer is mocked.

This isolated base deliberately lacks the parent's aggregate, demand/source
prerequisites and new producer recipes. No peer sources were copied or stubbed.
Before running tests, the parent must compose its actual aggregate and issued
plan guard, the producer declaration checkpoint, #5786 demand collection, and
#5787 source admission. The old consumer in this worker also does not yet handle
the added logical string union; the parent owns that integration. These are
explicit dependency gaps, not typecheck passes.

Commands **still unrun**, in the composed tree, after a serialized slot grant:

```sh
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 pnpm exec vitest run tests/issue-3518-native-string-value-abi-planning.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
NODE_OPTIONS=--max-old-space-size=2048 node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

No actual consumer emission/instantiation, import-offset witness, public
compiler parity, broad suite, boundary auditor, TS7 or TS5 was run by this
worker. Real original/decoded consumer execution and final-index ownership are
parent/test-lane obligations. ABI30, public cutover and retirement remain open.

Current full-program validation rejects a pre-existing semantic native-unbox
runtime entry because the generic runtime catalog has no such declaration.
The compatibility branch retains those checks and has no reachable positive
fixture claimed here; the new acceptance-side entry is the measured-design
path. Do not invent a semantic runtime caller or relax that catalog.

## Claim receipt

Normal helper session `86991` exited 0. Independently read upstream record:
`3518:native-string-value-abi-planning`, assignee
`ttraenkler/codex-native-string-value-abi-planning`, branch as above,
write ID `64094-e7wkdk20`. Introducing commit
`787df6839b1d729b1d073c79798566ed87593178` added only that record. Thomas
Tränkler authored/committed; Codex coauthor and `Model: Codex GPT-6 Astra Low`
trailers are present. Host signing settings were not changed; the remote
reports the claim commit unsigned. No signed claim is made.

The temporary operational helper retained the repository guards, imports and
verification; its only differences were the previously authorized normal push
without `--no-verify` and truthful attribution. It was deleted with apply_patch
after remote verification. The existing claim cache had only sample hooks;
no hook configuration was changed. The claim slot was explicitly released;
there is no live owned heavy process.
