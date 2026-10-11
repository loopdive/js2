# Native string-output extraction E1 and UTF8-rope repair — publication handoff

Worktree: `/private/tmp/js2-3518-native-string-output-extraction-20260909`
Branch: `codex/3518-native-string-output-extraction-20260909`
Exact published base: `721cd33a828c89cfc04c851b011f910b76a4d2c5`.

## Current publication status

All 14 implementation/proof files are frozen: eight production files, five
tests and one proof CLI. The issue update, this handoff and the parent-authored
inventory classification make the 17-file worker publication set.
Original failed runs remain recorded below; later
sections supersede their historical status, not their evidence.

The original 84 E1, 75 repair and 61 flatten controls passed in session 97215;
its eight argv-proof failures were repaired in the test harness only. The
81-proof rerun passed in session 29311. TS7 session 78279 exited 0 with the
unchanged production. Public comparison completed all four compiler children,
eight compilations, 16 instances and 64 calls: candidate 32/32 correct,
baseline 24/32 plus eight expected illegal casts. Disabled UTF8 bytes/WAT and
outcomes are exact; enabled differences are retained. R2b comparison and six
negative controls pass without a compiler rerun. The original controller's
invented `warnings`-field assertion and exit 1 remain explicitly preserved.

No implementation commit, push or PR has been made from this worker. Publication
must use normal hooks and a non-draft held PR on `loopdive/js2`, after the parent
grants the serialized slot. No merge/default-cutover/complete-async claim follows.

Parent added and delegated inclusion of exactly two `files` records in
`scripts/compiler-boundaries.json`: `src/runtime/wasmgc/values/string-concat-bodies.ts`
and `src/runtime/wasmgc/values/stdout-bodies.ts`, each `state: clean` and
`layer: native-runtime`. Removing just these two records reconstructs the
entire base policy structurally. The exact parent-authored file SHA256 is
`b7ce2750413e3f3257a6a535a691e58abff9857602739b4d76d0cbaceeb2ea55`.
This is classification only: no allowed-edge, root, minimum, activation-history
or negative-control expansion. Required-root activation remains parent-owned.
The actual inventory check now passed in session 79242, exit 0, against the
immutable base 721cd33a: 1,353 modules, zero errors, inventory valid and
architecture incomplete. The source census contains two additional excluded
nonmodule files; the two new owners were still untracked before staging.
The report is `.tmp/e1-publication-inventory-r1.json`. This validates the
classification, not expanded required-root coverage or closure certification.
Existing caller regression suites and the full 64+2 three-arm scanner run remain
unrun here after the shared repair. Normal publication hooks are also pending.

## Historical R1 static status

Status: five production files and two new test files frozen for High review and
parent validation. No formatter, tests, typecheck, implementation commit or push
has run. The normal claim helper completed session 28707, exit 0; remote record
independently verified owner `ttraenkler/codex-native-string-output-extraction`,
write ID `35913-cymplpk4`, introducing commit
`ce9fa4ab3582286f4ed48be699f2ebc74be67b40`. Normal push, no bypass/config override;
Thomas author and Codex GPT-6 Astra Low trailers verified. The existing corrected
operational helper was reused read-only, with all guards unchanged. No new
operational helper needs removal. Claim-only heavy slot was explicitly released.

## Frozen executable interface

- `buildStringConcatDefinition(layout, resources)`: explicit four layout type
  indices, flatten function handle and already resolved empty-identity boolean;
  returns six locals and the entire original binary-concat body.
- `buildStringBatchedConcatDefinition(layout, arity, resources)`: explicit three
  layout type indices, flatten/concat handles and one detached undefined-literal
  instruction sequence per operand; returns three locals and the complete
  fixed-arity body. Validates integer arity and exact dense literal population.
- `buildStdoutAppendDefinition(resources)`: accumulator global and concat
  function handles, zero locals.
- `buildStdoutPrepareDefinition(resources)`: accumulator/readout globals, flat
  type and flatten function handles, zero locals.
- `buildStdoutCharDefinition(resources)`: readout global, flat/data type indices,
  exactly one nullable flat-buffer local.

All return fresh mutable instruction/local trees. Batched literal instructions
are deep-detached per guard per invocation; no arbitrary callback, allocator,
environment read, codegen import or helper lookup occurs in a pure builder.
The records are low-level resolved physical dependencies, NOT admission
credentials. Canonical Wasm model handle aliases retain the separate spaces.

The old wrappers retain exact registration, availability/cache checks, helper
names, signatures, global descriptors/initializers and publication order.
The binary environment read stays after helper registration. The batched wrapper
still calls `nativeStringLiteralInstrs(ctx, "undefined")` once per guard after
registration and in operand order. Growth, owned-concat, comparison/slicing and
`emitStandaloneStdoutAppendValue` are untouched.

Actual existing callers remain at `src/codegen/string-ops.ts:1838`,
`src/ir/integration.ts:7374`, `src/codegen/native-strings.ts:133` and the existing
stdout registration/finalization calls in `src/codegen/index.ts` (5552, 6167,
10720, 11544 at this base). No public caller was invented.

## Donor evidence

Exact originals were captured before source edits in
`.tmp/string-output-donors-before.json`. The durable preservation test pins both
original raw file SHA256s and complete parser token/comment receipt hashes; no
historical git object is needed in shallow CI.

Original raw file hashes:

- `native-batched-concat.ts`: 52a1aaace8b89e85cb5862ad0ee7df86a2ccccd9e9664516bf747a4600bf7bb1
- `native-strings-basics.ts`: d35ac41d78a1e12d3109d3001112fa6ef97e9548d1006e73241531f40c84865d
- `native-strings.ts`: b29419deb584cc1e285a19f89a4ab7f3394215fb3d5fa7fe5c037b5be0c44173

Measured original scopes (zero-based UTF-16 source positions, end exclusive):

- ensureNativeBatchedConcat: 2085..7372, lines 42..195,
  SHA256 0cb1d84114820b0d42f315b59107ff92d904f7a8c1775cee7d0b18d6b2562d5e.
- First binary-concat block ONLY: 1875..7328, lines 36..174,
  SHA256 a99f8646a2aa17581e0f845d7372afa61d76e50e488f9b37283e0e5558755017.
- ensureStandaloneStdoutSink: 108041..110417, lines 2459..2519,
  SHA256 3ad58ed16549c1c8c40f81c50e7a3ab04486039c61c9c67431c5b8c0b50e644c.
- emitStdoutSinkExports: 113527..117236, lines 2578..2678,
  SHA256 9538f088aeed7b3853cbc9328c448cc62551f62b9bcfe86b313b9b08b42be773.

Read-only AST comparison reconstructed ALL THREE entire legacy files exactly at
the token/comment level, not merely the moved expressions. It independently pins
headers, dependencies, constant population, all forwarding calls and imports,
then restores body/local construction at each original registration. This is
static preservation, not Wasm execution. Parser diagnostics: 0 across seven
owned files; scoped `git diff --check`: exit 0. Five builder spans are
137/132/25/19/41 physical lines; none exceeds 300.

## Authored, not yet executed

Two suites contain a planned 84 cases: 60 body/adapter cases and 24 preservation
cases (one genuine complete-file reconstruction plus 23 positive-first changes).

The real-Wasm fixture has 24 recipes: twelve binary and twelve batch recipes
(two lengths for each arity 3..8). Both empty-identity options are retained,
with two fresh instances and two repeated calls per row: 192 planned recipe
observations. It uses issued canonical literal and flatten packs, actual binary
concat/batch functions, and actual stdout append/prepare/char bodies. It checks
all UTF-16 code units, rope/flat selection, 63/64/65 boundaries, genuine rope and
UTF-8 inputs, nonzero flat offsets, lone-surrogate data, repeated identity
behavior, empty/null/bounds readout and four newline joins. Produced binaries,
WAT, ordering and observations are retained under its own `.tmp/native-string-output-*`.

The donor batch signature is nonnullable. A separate positive-first invalid
module control demonstrates null injection is rejected; it is NOT reported as
successful execution of the defensive undefined guard. That guard is still
preserved by exact reconstruction and changed-guard controls. No nullable
signature is fabricated to obtain a passing result.

There is no new output materializer yet. These resource-backed body fixtures are
not complete prepared-consumer, async-family, source-free replay, public default
cutover, ABI30 or retirement proof.

## Unrun commands, after parent grant

This new tree has no node_modules link yet. Provision pinned existing dependencies
using the repository's normal worktree workflow; no install/update. Do not alter
global settings or bypass hooks.

From the worktree, run sequentially:

```sh
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run tests/issue-3518-native-string-output-bodies.test.ts tests/issue-3518-native-string-output-preservation.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism --reporter=verbose
NODE_OPTIONS=--max-old-space-size=2048 node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

Existing actual caller regression suites, still unrun and unchanged:
`tests/native-batched-string-concat.test.ts`,
`tests/native-string-empty-concat.test.ts`,
`tests/native-strings-standalone.test.ts`.
Public compiler byte/WAT pairing and no-demand comparison remain unmeasured.
The existing three-arm no-demand instrument pins a different original/repair
scope; it cannot be relabeled as this two-arm extraction comparison.

Parent owns final inventory/boundary registration for the two new source owners,
resource admission integration, High review and non-draft held PR publication.
No allowances, baselines or boundary permissions were changed here.

## Frozen source/test git blobs

- `src/runtime/wasmgc/values/string-concat-bodies.ts`: `bc66046ee7dd0f26c9c0c7e355100b1640e9c288` (SHA256 `106451b45de1b08c7c7db79461f4c7d7bf8e92bae873845c6dde775fa00df8bd`).
- `src/runtime/wasmgc/values/stdout-bodies.ts`: `a4ea0245059c27a7109f1fa6de34a1d023f34660` (SHA256 `77bb3e9a06cf1bce5ef57754094c0c5129bd0fb587ddee731ee82c7b2788b208`).
- `src/codegen/native-batched-concat.ts`: `d3996b7b200d46051ae2ba77b759a09e084f48d5` (SHA256 `92c9f4b041c9598a1369f2cea630c07d7565f8030fe598f6e2d07cf191940eda`).
- `src/codegen/native-strings-basics.ts`: `c13e7f52b41066fa0a6c934ced859ad3db393c82` (SHA256 `b5443c3f4d319ccfad825c7f4e174502b5915ea0bf933238172669afa940e618`).
- `src/codegen/native-strings.ts`: `6d608fae95667011fa5c3eed500a7b52c7e9b926` (SHA256 `f29d91cbcf635e07d093d37e44568792d22e4112193d6c34a6675e8c5034dece`).
- `tests/issue-3518-native-string-output-bodies.test.ts`: `684f79577b208cf85735ceb0c6c7798184e1dc37` (SHA256 `d98037d6096111ffcad0b4752729cd5d98809b658ac474d894a757bc33651ad6`).
- `tests/issue-3518-native-string-output-preservation.test.ts`: `0fbb3b9adafd36a79400bbdc80a62af74cbd494c` (SHA256 `38612537dac57e0963e02e3a7d2ef3fb5d145015ced4d0a0b1e5e517b028bae0`).

Machine-readable full receipt:
`.tmp/native-string-output-extraction-frozen-r1.json`.

## Executed R1 and unresolved UTF8 rope dependency (2026-09-09)

The preceding static freeze remains historical evidence, not a test-pass claim.
Vitest session 96230 exited 1: 56/84 passed (preservation 24/24; bodies 32/60),
with all 28 failures retained in `.tmp/e1-validation-r1-vitest-96230.log`.
TS7 session 55689 exited 0 without diagnostics. All seven frozen source/test
hashes still match R1; no production or test repair has been made.

The 28 failures each use the genuine mixed rope `ConsString(6, "rope-", "é")`,
where the right leaf is an issued Utf8String. Binary-short, batch-short and
batch-long first-pair paths all reach the unchanged copy-tree traversal. With
empty identity enabled, `empty-rope` returns the original rope correctly and
fails in subsequent readout. In both original failed binaries, reported PC3832
is opcode `fb1603` starting at byte3831: casting the popped Utf8String to
ConsString before reading its right field. No case or assertion was removed.
The complete per-row attribution is `.tmp/e1-failure-attribution-r1.json`.

### Independent original-donor / extracted execution

An additional bounded A/B executes the exact original `emitStrFlattenHelpers`
and `flattenConsBody` retained in the checked-in donor fixture, independently
verified equal to `a6cc59a2cdfad5141d75faadf1530a9de63bebd7:src/codegen/native-strings-core.ts`.
Its emitter registration is captured into actual issued string/flatten
reservation tokens, validating every signature/name/handle. The candidate arm
uses the actual `fillNativeStringFlattenResources` implementation. Neither arm
substitutes a flatten algorithm or creates a fake provider.

Sessions 49371 (donor) and 37951 (extracted) both exited 0 as recorders. Four
cases per arm, two fresh instances and two calls per instance give 32 actual
observations: UTF16-only rope and UTF8 root each pass 4/4 per arm; mixed-right
and mixed-left UTF8 ropes each trap 4/4 per arm. This is 16 semantic successes
and 16 retained semantic failures, not a green execution suite.
The original and extracted copy-tree AND flatten bodies/locals are deeply
identical. Full binary/WAT are not equal: only the decoder definition differs
by the previously implemented offset-window correction (`b=0` becomes `b=off;
end=off+byteLen`); its locals and all other body entries are identical. Raw
bodies, bytes, WAT, imports/exports and every error stack are retained.

### Actual public source reproduction, not a constructed short rope

Baseline is an immutable `git archive` of published 721cd33a in the worker's
own `.tmp/e1-public-base-tKGczA`, with all 1,353 source files individually
verified against Git. Candidate is R1: the only five source differences are
the three compatibility adapters and two new body owners. Every source hash
is recorded before and after each arm. No baseline/peer checkout was edited.

The actual public `compile` input has a nonconstant `join(a:string,b:string)`
and an exported numeric probe choosing 64-character prefixes and `é`/`Ω`, then
calling `join(a,b).charCodeAt(64)`. Both branches produce 65 code units; expected
results are 233 and 937. No physical IR or string object is injected.
Target is standalone, nativeStrings is true, optimize is false, and the two
independent switches are experimentalIR and utf8Storage.

Eight compilations across baseline/candidate and four switch combinations
produced 16 real instances and 64 exported calls. All four pairs have exact
binary, WAT, import/export order AND full outcome/error-stack equality.
IR-off/storage-off, IR-off/storage-on and IR-on/storage-off pass all 8 calls
per arm. IR-on/storage-on traps all 8 calls per arm: 48 public semantic passes
and 16 retained public failures overall. With IR off, actual globals remain
UTF16 even when storage is on, so those passing rows are controls, NOT UTF8
leaf coverage. With IR and storage on, WAT shows actual Utf8String globals,
`join` calling `__str_concat`, the >=64 ConsString construction, and readout
calling `__str_flatten`. The public trap at 0x2ea2 is `fb1605`, the same
ConsString cast in the copy-tree body inlined into flatten—not a new failure
inferred from the shortened stack.

Public recorder sessions: 25675/1228 (IR off), 81485/87469 (IR on), all exit 0.
Exit 0 means complete measurement; acceptance remains false.
Complete comparison and six report paths/hashes:
`.tmp/e1-flatten-public-comparison-r1.json`.
Harnesses: `.tmp/e1-flatten-donor-ab.mts` and `.tmp/e1-flatten-donor-ab-ir.mts`;
the latter differs only in the explicit experimentalIR option. They retain
the original log, all failed observations and exact instantiated bytes.

### Required owner and next boundary

This is an inherited shared flatten gap, independently reproduced both from
the pre-extraction donor and through genuine public source on the E1 baseline.
The semantic owner is `src/runtime/wasmgc/values/string-flatten-bodies.ts`:
`buildStringCopyTreeDefinition` recognizes only NativeString leaves, with no
decoder dependency, while its AnyString worklist admits Utf8String leaves.
The root-only decoder branch in `buildStringFlattenDefinition` cannot handle
UTF8 children reached during traversal.

A separate High-approved repair must resolve the genuine optional decoder
handle and thread it through BOTH callers: the issued fill in
`src/backend/wasmgc/resources/native-string-flatten.ts` and legacy registration
in `src/codegen/native-strings-core.ts`. It must preserve the declaration/type/
function order copy-tree → optional decoder → flatten, avoid inferred sibling
indices, and retain disabled-UTF8 behavior. Exact phase staging belongs to that
owner/spec, not an E1 workaround. Do not preflatten/remove the mixed test leaf,
change concat's >=64 behavior or install a dummy decoder. Existing donor
receipts must retain their original hashes and identify any authorized delta.

No shared-flatten source repair is authorized or claimed here. Heavy slot was
released after 87469 terminated; no further heavy invocation is running.

## Subsequent authorized shared repair: final bounded execution receipt

This section records the later explicit High-contract repair authorization;
the preceding R1 failures and scope statement remain historical evidence.
The seven original E1 files and decoder remain byte-frozen. The three repaired
production files are exactly the approved manifest
`.tmp/e1-utf8-rope-repair-frozen-r1.json` (SHA256
`c92715020c068c5bc417c74d36c36530dffd430659679c6192562c06002cd89e`).
The sole subsequent proof-test change interchanges child argv positions;
the guard, checker and all 81 controls remain retained.

Validation history, without replacing failed runs:

- Session 97215 exited 1: original E1 84/84, repair 75/75, existing flatten
  61/61, proof 73/81; total 293/301. The eight proof failures were the
  file-URL-as-filesystem-argv instrument error.
- Session 78279: TS7 exit 0. Production has not changed since this check.
- Session 29311: corrected proof invocation exit 0, 81/81; JSON SHA256
  `9e9764212b5ff092d30aedbbfabe409326ac2d570548cee78c7bd09617ed07f7`
  at `.tmp/e1-utf8-rope-validation-r2-proof.json`.

The actual public pair reran the unchanged two probes and exact source/options
described above. Baseline is still the 721cd33a archive (1,353 source files,
every file checked against its Git blob). Candidate is that base plus the
five E1 and three shared-repair production paths (1,355 source files).
The complete changed-path census, all before/after source hashes and frozen
file hashes are in `.tmp/e1-public-pair-r2-results/preflight.json`, SHA256
`842b36e9aed719edf825effd3b9243e1faf57c3e3d49cf4bb841ff2286dd7c39`.
Node executable, tsx implementation, esbuild executable/implementation and
config content match; the child config path is explicitly bound to its arm.

Session 28157 ran four sequential children: PIDs 29113, 29166, 29178, 29188.
Every child exited 0, without signal or spawn error. All eight compilations,
16 real instances and 64 calls completed. Candidate passes all 32 calls;
baseline passes 24 and retains eight actual `RuntimeError: illegal cast`
outcomes in IR-on/UTF8-on. Both UTF8-disabled pairs preserve exact binary,
WAT, import/export ordering and outcomes. Both enabled pairs have explicit
raw differences; byte parity with the broken enabled baseline is NOT claimed.
Passing IR-off/storage-on still does not prove UTF8-leaf coverage.

The controller subsequently exited 1 because its validator invented a
required `warnings` field. The actual `CompileResult` exposes `errors`, not
`warnings`. Its original script and failure report are unchanged. The separate
comparison-only amendment requires the actually absent field, independently
revalidates all launch/terminal/source/runtime/row identities, and rereads the
same full artifacts without another compiler invocation. It exits 0; all six
negative controls reject (missing row, foreign root, wrong value, substituted
instantiated bytes, nonzero terminal, missing runtime).

Final report: `.tmp/e1-public-pair-r2-results/comparison-r2b.json`, SHA256
`55f87e2bac3473d7f66c33017451f6e87500cbb1998f52c450c5e16618e71913`.
Each arm's full bytes, instantiated bytes, WAT, order, values and raw stacks
remain in its referenced JSON, alongside separate launch/terminal receipts.
The amended comparator is `.tmp/e1-public-pair-r2b-compare.mjs`, SHA256
`52ade7773abf90e16892a3e4297f07137c2431c861ea986c61fda59aa76a9fa1`.

Recorded comparison-only invocation from this frozen worker:
`NODE_OPTIONS=--max-old-space-size=2048 node .tmp/e1-public-pair-r2b-compare.mjs .tmp/e1-public-pair-r2-results`
on the existing receipts; it intentionally refuses to overwrite its existing
output. The original execution controller and both probe hashes are retained
in preflight. Any new compiler run requires a new output directory and the
parent's serialized slot; no rerun is authorized by this handoff.

The heavy slot was explicitly released after all four children terminated.
No production, donor, original probe or prior failed receipt changed during
this validation. The full 64+2 scanner three-arm CLI has not been rerun after
the shared repair; its 81 proof controls are not that compiler population.
Complete native output/async acceptance and retirement remain separate.
