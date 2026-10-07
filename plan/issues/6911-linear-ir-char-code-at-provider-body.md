---
id: 6911
title: "Linear IR charCodeAt provider: reusable emission body and exact preservation"
status: in-progress
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen-linear
goal: ir-full-coverage
related: [2956, 3673, 3502, 3518, 6905]
files:
  - plan/issues/6911-linear-ir-char-code-at-provider-body.md
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/runtime/strings/char-code-at.ts
  - tests/issue-6911-linear-ir-char-code-at-provider-body.test.ts
  - src/codegen-linear/runtime/README.md
  - src/codegen-linear/runtime/strings/README.md
---

# Linear IR charCodeAt provider: reusable emission body and exact preservation

## Authority, evidence and purpose

Exact baseline: `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`.
Planning branch: `codex/6911-linear-char-code-at-provider-20261007`.
Parent verified reservation/prScan and planning claim
`6911:char-code-at-plan-20261007`, owner
`ttraenkler/codex-linear-b-char-code-at-astra-20261007`.
This is a specification, not a measured compiler fix or new Prepared admission.

Parent's completed 25-PR inventory (including checked file counts
135/294/397/402) found only three runtime-file overlaps: PR6572 array new/grow,
PR6575 string slice, PR6577 vector initialization. Their function regions are
disjoint. The pre-allocation 974-claim snapshot contained no 3502/3673 or target
char-code-at claim; A's published 45-path packet excludes runtime.ts. Broader
3518 GC-native string/provider claims do not release their shared interfaces.
Parent must acquire fresh exact source/test claims before dispatch.

Foreign [Heap coexistence in one linear memory: relocate the bump arena above
the engine’s heap base, passive data segments only](4540-linear-heap-coexistence-arena-relocation.md)
retains allocator/linked-heap ownership. A retains all shared compiler, emitter,
frontend, provider-contract, integration and source-map paths. Do not adopt
6896 allocation guards or 6897 forwarding regions. Legacy remains.

## Current production contract

- `runtime.ts::addLinearIrStringRuntime` (2547) registers appendASCII, charAt,
  then the guarded `LINEAR_IR_STRING_CHAR_CODE_AT_FN` definition (2736–2969).
  That final callback is the complete extraction target, not the whole function.
- `src/codegen-linear/index.ts::sourceMayUseLinearIrStringRuntime` (71) and the
  flag-enabled generator register this provider for real charCodeAt source use.
- `linear-integration.ts::makeLinearIrResolver` exposes `stringMethodPlan`
  (2001) and `emitStringCharCodeAt` (2079); the latter checks the memory plan
  and calls this runtime helper. Both callers remain unchanged and read-only.
- ABI is `(i32 stringPointer, i32 utf16Index) -> f64`, five i32 extra locals:
  byteLen, bytePos, unitPos, lead, codePoint. Current first extra local is 2.
- Canonical `LINEAR_STRING_LENGTH_OFFSET` is 8 and
  `LINEAR_STRING_ELEMENTS_OFFSET` is 12 in `ir/analysis/linear-memory-plan.ts`.
  UTF-8 storage is decoded into UTF-16 code units. The ASCII dependency is
  `__str_is_ascii(i32)->i32`; it may memoize at string-header byte 1.
- Existing `tests/issue-2956.test.ts` includes ASCII/BMP/astral/omitted/bounds
  source assertions. `tests/linear-charcodeat-ascii-fast-path.test.ts` includes
  source and runtime controls; its historical ASCII-only comment is not current
  admission proof. Neither file has been run for this plan.

## Implementation Plan

### Source slice — two files, one existing function region

Sol source owns only the new import in `src/codegen-linear/runtime.ts`, its
charCodeAt body-factory delegation, and new
`src/codegen-linear/runtime/strings/char-code-at.ts`. Keep the exported runtime
symbol, function guard, registration arguments/order, five-local count and
neighboring appendASCII/charAt code byte-for-byte unchanged where possible.
No edits to `addRuntime`, `addStringRuntime`, `__str_is_ascii`, findFuncIndex,
addRuntimeFunc, registry, indexes, GC paths, or existing tests.

The leaf exports `buildLinearCharCodeAtBody(asciiFuncIdx: number,
firstLocalIdx: number): Instr[]`. Import the instruction type from the Wasm
model and the two existing canonical layout constants. No WasmModule, context,
AST/checker, allocation policy, registry, frame allocator or resolver callback
enters the builder. These numeric inputs are supplied by the actual caller;
they are not self-authenticating ownership tokens or newly assigned indices.

The existing callback delegates with `findFuncIndex(mod, "__str_is_ascii")`
and its supplied `firstLocalIdx`. Resolve inside the existing callback, after
the existing idempotence guard and registration setup; do not move lookup ahead
of those effects. The defined-function lookup already accounts for imported
functions. Never substitute name lookup inside the leaf, index guessing, module
cloning/rebasing, resource adoption, or an unverified numeric receipt.

Move the full existing decoder and its local instruction factories together:

1. Signed-negative index returns f64 NaN before any string read/helper call.
2. Load byte length; unsigned index >= byte length returns NaN before ASCII call.
3. Call the supplied ASCII helper; true loads payload[index] and widens unsigned
   i32 to f64. Keep this call and its cache effects, not a copied ASCII detector.
4. Otherwise walk bytes and UTF-16 units. Preserve one-/two-/three-byte handling,
   four-byte high/low surrogate formulas, unit increments, branch depths and
   final NaN. Keep all mask/shift constants and instruction order unchanged.

Replace only layout literals 8/12 used as length/payload offsets with the canonical
constants; do not mistake decoding shifts or UTF-8 widths for layout offsets.
Each invocation creates fresh arrays, instruction objects and nested block types,
including decodeTwo/Three/Four and every then/else/body array. No module-scope
instruction cache, shallow shared templates or instruction reuse across functions.
The builder emits no malloc, store or memory growth; its emitted ASCII call still
has the existing header-cache effect. No malformed-UTF8 policy or numeric argument
conversion changes belong here; the helper boundary receives signed i32 indices.

This is a used target-side body, not a new umbrella runtime or generic semantic
layer. Reuse small decoder factories within this leaf; no new optimization pass,
dispatch registry or orchestration. Future A-owned reservation wiring may provide
the resolved helper index after authentic reservation; that wiring is NOT delivered.

### Test slice — one new file, ten ordinary tests

Sol test owns only `tests/issue-6911-linear-ir-char-code-at-provider-body.test.ts`.
Use existing public runtime/compiler APIs on both arms; do not import the new leaf
on baseline, alter existing fixtures, or fabricate a successful IR body. Arrange
independent tests so one failure does not prevent the other observations:

1. Independent native-JS oracle for the finite strings/indices below; compare
   actual compiler/helper results against it, never baseline alone.
2. Production ASCII source: `export function at(i:number):number {
   const s="Ab9~"; return s.charCodeAt(i); }`. Public `compile`, explicit
   `moduleName:"issue-6911.ts"`, target linear, optimize/maps off,
   experimentalIR false, disableIrFirst true, `JS2WASM_LINEAR_IR=1`.
   Require call-through generator/overlay/runtime registration observations,
   current compilation's admitted owner/body and actual provider call, validated
   binary and execution for indices -1,0,1,3,4. No stale global report alone.
3. Real runtime ASCII helper with all indices of `Ab9~`, including repeated calls
   on the same allocation to exercise both cold and cached ASCII verdicts.
4. Runtime BMP/mixed UTF-8: `aéb€c`, all UTF-16 positions, length and byte-length
   boundaries; include a prefix-ASCII string ending in é to guard full detection.
5. Runtime astral: `a😀b`, all units, high 0xd83d and low 0xde00, then bounds.
6. Runtime empty and signed-i32 extremes: empty at -1/0/1; valid nonempty input
   at INT_MIN/INT_MAX. Require typed NaN, no giant allocation or unbounded scan.
7. Registered symbol/ABI/five-local inventory and idempotence of the existing
   builder; retain unchanged sibling helper bodies and resource counts.
8. Deep fresh-object custody across two independently built modules and a third
   after mutating one test-owned nested instruction/block type. Compare structural
   equality and recursively disjoint mutable objects, not just root-array identity.
9. Real harmless function-import prefix and an imported ASCII-helper namesake:
   verify the emitted call targets the actual defined helper with import offset;
   the namesake throws if invoked. Do not patch/rebase generated call operands.
10. Cache effects and early exits on one real allocated string: snapshot memory
   and arena state after construction. Valid calls may change only cache byte 1
   (unknown to the existing yes/no verdict); negative/byte-bound exits must not
   call the helper or warm that cache. Repeated calls allocate nothing. Payload,
   length, other header bytes and adjacent memory remain unchanged.

For runtime rows use real addRuntime/addUint8ArrayRuntime/addArrayRuntime/
addStringRuntime/addLinearIrStringRuntime and `__str_from_data`, as existing
controls do, with bounded strings. Construct first, then snapshot/call repeatedly;
do not rematerialize per read or fake headers/ASCII caches. Unit wrappers resolve
actual helper indices. These rows prove runtime preservation, not Unicode source
admission. Do not add a Unicode source success assumption; preserve all genuine
existing source failures and any separately requested positive requirement as red.
Restore environment/spies in finally; no any casts or weak typecheck configuration.

### Evidence, ownership and quality gates

Parent alone owns documentation, evidence and serialized heavy validation.
`src/codegen-linear/runtime/README.md` is B's 6905 parent-owned document, published
at the parent-reported `69d2` checkpoint; parent may reuse its exact published
bytes under the explicit docs handoff. Parent creates only the new
`src/codegen-linear/runtime/strings/README.md` boundary documentation. Neither
README belongs to source/test workers. Declare body-only target builders using
canonical layout contracts and fresh mutable instruction trees; no frontend
imports, module registration/mutation or index/ownership authority. No A transfer.

Freeze identical new test bytes on baseline 6c88 and the exact candidate. Emit
ten uniquely identified nonempty observation rows, including failures, with each
finite case array explicitly counted. Record source/options/runtime/test hashes,
call ownership, helper ABI/indices, binaryBase64 plus SHA256, memory/cache effects
and native expected/actual values. Encode NaN explicitly (e.g. `{kind:"nan"}`),
not JSON null; tag ordinary numbers separately and preserve -0 if encountered.
Require exact full-row equality and exact artifact bytes for matching arm/config,
apart from separately recorded epoch/timing provenance. No digest exclusions,
normalization hiding changes, performance claim or configuration tuning.

Parent runs unchanged relevant populations in issue-2956 and the ASCII-fast-path
test on both arms, preserving original fixtures and all red outcomes. Run strict
test-inclusive TS7, lint/format and existing size/ownership gates with unchanged
settings. An instrument repair requires separately retained versions/diagnostics
and identical paired reruns; no skips, it.fails or pinning failures as success.

Parent's completed baseline on 6c88: both unchanged control files together
**28 pass / 3 fail / 31**, exit 1, total 49.81s (external deadline 300s).
The original issue-2956 charCodeAt source case fails compilation. Unicode runtime
units do not prove frontend admission. Preserve all 31 original controls and all
three failures; parent retains exact diagnostics for attribution, without assuming
the other two causes here. Candidate must retain the same population and behavior.
This releases only the reviewed extraction after parent's exact K/T claims and
source freeze: actual body/ABI/five locals/cache/caller preservation, no admission fix.

No budget grant is issued here. runtime.ts/addLinearIrStringRuntime must shrink;
measure any new leaf/function gate failure before requesting an exact issue-owned
grant for the moved body only. Never borrow another issue's allowance, inflate a
baseline, or broadly exempt the directory. No tests/heavy jobs were run in planning.

## Acceptance

- [x] Fresh exact K/T claims and parent-reviewed partition before implementation.
- [x] Existing real caller delegates; only the released two source files change.
- [x] All ten new tests measured; source route/callee attribution is non-vacuous.
- [x] Identical paired rows/artifacts, native oracles and cache/custody controls.
- [x] Existing controls and strict test-inclusive checks retain their full results.
- [x] Parent publishes coherent evidence; no new Prepared coverage/retirement claim.

## Dispatch checkpoint — 2026-10-07

Canonical main remains `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`.
Reviewed Astra plan commit: `987d870cb7` (production baseline unchanged).
The refreshed assignment snapshot had 976 held claims, including only B's
reservation and plan for this issue. Main history and the refreshed 27-open-PR
inventory contain no implementation of this task.

Exact claims were acquired and verified on `upstream/issue-assignments`:

- `6911:char-code-at-source-20261007`, owner
  `ttraenkler/codex-linear-b-char-code-at-sol61-20261007`, branch
  `codex/6911-linear-char-code-at-source-20261007`: the two source paths and
  final callback region above, Sol 6.1 Medium.
- `6911:char-code-at-tests-20261007`, owner
  `ttraenkler/codex-linear-b-char-code-at-tests-sol61-20261007`, branch
  `codex/6911-linear-char-code-at-tests-20261007`: the single new test file,
  Sol 6.1 Medium.
- `6911:char-code-at-docs-20261007`, owner
  `ttraenkler/codex-linear-b-char-code-at-docs-20261007`, planning branch above:
  parent documentation, evidence and serialized validation.

Session A has now published vector-read repair PR #6582, observed head
`556d0a3324ca41637d7eb6ff38a0513889a5c9df`. Its reported alias/read repairs are
not this task's evidence or an ownership transfer. A retains its shared emitter
and final integration. B's corresponding C ABI checkpoint remains separately
published; only an integrated test epoch can establish combined behavior.

Baseline existing-control raw log SHA256:
`2d425264b85eed78b3b7180c6c3488a6e2593004b18e8eeb994509bf620f5576`.
Unchanged issue-2956 fixture SHA256:
`cb187a61186bb77761f5cfcad6ed36dc0a50f6a10cad5108650915baedf08d42`.
Unchanged ASCII-fast-path fixture SHA256:
`47e99c2b55177f1af551abcd16d6e4731a15e3a82349ac74f62d5e508a5250ab`.
The three baseline failures retain their original ordinary assertions:
vector operand/coercion closure; string concat ASCII-proof rejection; and
UTF-16 source compilation rejection. No claim that runtime extraction repairs
these admission failures is made.

## Source preservation checkpoint

Source commit: `5761898b7b8e9c3e0983077a35efd33269c9219c`.
Frozen source hashes are `3f9ead0c3f3342a78f07e4afe624be205b99413ce203f167365e01ef63fb0e60`
(runtime.ts) and `89a29dfe8162813b907ae7a4291eded47ebdd468e7f7f486d9d420815dcae538`
(char-code-at.ts). Scoped format/lint, LOC and function-budget checks passed.
The unchanged 31-control candidate run completed exit 1 in 70.85s: **28 pass /
3 fail / 31**, matching baseline. All 6,316 characters of the complete three
failure sections match exactly, including their original assertion locations.
No failure is skipped or converted into expected-success behavior.

Candidate raw log SHA256:
`82bd6a0778bb0eedb2caf66b2bb6d9c3d1202ad93e78d0f1ac4349a88e28cb49`.
Both original logs are retained compressed under
`plan/log/6911-linear-char-code-at-20261007/`. The count-floored
`compare-existing-controls.mjs` verifies both populations and exact failure text.
The ten new paired preservation tests and strict test-inclusive typing are still
pending at this checkpoint; it is not final acceptance.

B published an explicit dependency request on A's vector-read integration PR:
[coordination comment](https://github.com/loopdive/js2/pull/6582#issuecomment-6041736166).
It identifies B's published C ABI and initializer checkpoints and requests A's
shared array admission/resource-binding contract. Posting is not acknowledgement
or an ownership transfer. A retains queue submission and final integration.

## Paired provider acceptance — 2026-10-07

[PR #6583](https://github.com/loopdive/js2/pull/6583) is non-draft, labelled HOLD,
with no auto-merge. The original creation request completed without a retry.
Its first verified published head was `90aeff4bccd4c360180baaa8f50d7c3d434e4952`.
At authoring, the new test was committed locally at
`462fb0565d1e3f296c12a7e87ab422b398ea057d`; the verified publication follows below.

Identical V1 test SHA256:
`a3e5d6fa5389615c2fe97faedb6f2f2228098ee6175ce53fb1cfc0a036b996b9`.
Baseline test-only commit:
`a9f672f1dd776726cf7bde948b8646b72254dbcb`, whose production tree is unchanged
from canonical main `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`.
Candidate observations record checkpoint `90aeff4bccd4c360180baaa8f50d7c3d434e4952`
plus the explicitly frozen test bytes (then untracked); production is source
commit `5761898b7b8e9c3e0983077a35efd33269c9219c`. The later test-only commit
retains exactly those measured source and test hashes; it is not a new test epoch.

Both arms: **10 pass / 0 fail / 10**, external deadline 300s, unchanged single
fork configuration. Baseline total 86.45s; candidate total 45.15s. These are raw
run durations, not a performance claim. All ten complete behavior rows match
exactly, including **14 valid binary witnesses per arm**, actual owner/body and
helper binding, UTF-16 units, NaN tags, deep object custody and cache/memory
effects. The finite populations are native 41, source 5, ASCII runtime 24,
BMP/tail runtime 19, astral runtime 9, extreme runtime 5, imported-helper 2,
cache/early-exit 8. Runtime units do not prove Unicode frontend admission.

Raw JSONL SHA256: baseline
`2997ab638a77e1d9126f51f4241d7279bc3b610b00f6b93a0331ca018252d571`, candidate
`3c937aec7ed73208bbc6f36e782e2ccc3ac3882000b8ec02f4c2b6b1cc14d657`.
Raw new-test logs: baseline
`56242a2c86daa42469528223c10e405dc9dc53964fa15996f2346b5f484b9c3c`, candidate
`ca7021540d0604bbe20c939da25da973281555ca74a3b2bd1bdbe0bc668433cb`.
The original V1 test, both raw observation/log files and exact comparison result
are retained compressed in the evidence directory. The comparator checks ten
unique rows, all finite case counts, all fourteen nonempty binary witnesses,
their bytes/hashes/validation and full-row equality; it accepts compressed inputs.

Strict test-inclusive TS7 exit 0, zero diagnostics, unchanged strict settings.
The saved configuration explicitly includes all source and the new test, since
the normal root gate excludes tests. Config SHA256:
`9306b6dc0f73a94f8628d2a23889cbc0e7b0015af8abd3ccf067037487c574de`.
The empty diagnostic log is saved separately; no test instrument repair or
typing suppression was needed. Normal first-push gates passed, including
18/18 numeric parity tests. Final evidence push gates remain a separate step.

The original 31-control results and all three complete failures remain unchanged.
This accepts only used provider-body preservation; shared provider reservations,
Unicode source admission, whole-program IR equality and legacy retirement are
not delivered. Session A must requalify any combined integration epoch.

## Verified publication and integration boundary

Both `git ls-remote upstream` and PR #6583's API independently confirmed remote
HEAD `f9c64b9f0b972617fdf15d56351e2f4654c49341`, containing source, tests and all
paired evidence. The normal evidence push completed exit 0, including source
typing, lint/format, oracle/coercion ratchets, numeric parity **18/18**, and issue
integrity. PR remains non-draft HOLD, `auto_merge: null`; B has not submitted it
to the queue. Subsequent documentation-only commits are not new test epochs.

Canonical main has meanwhile advanced to
`e02ed67eb91bbe0d3ffeec1359a599ad17004ecd`, landing A's generic string-operation
extraction PR #6578. That eight-file shared change is not merged into this tested
branch or requalified here. A must qualify the new combined epoch before landing.
The shared array admission/reservation contract remains unreleased to B, and the
GitHub coordination request had no response when checked. No acknowledgment or
shared-file ownership transfer is inferred. Status stays in-progress until actual
main integration, and full IR migration remains open.

## Measured composition with canonical main e1e — 2026-10-07

The previously pending shared changes are merged unchanged from canonical main
e1e07bd4683faafcd69846bc757cce36ebb9fb61. Candidate execution HEAD is
cc08d22e987dc0e42608b25d23996961b87e41e4; baseline production is exactly that
main, with only the identical new test and documentation at test-only HEAD
87d7d5f09facc4e23ba077e5966db5218adc33ce. No shared ownership transferred.

The unchanged combined population is41 tests: the original31 controls and the
ten new provider tests. Both arms measure38 pass/3 fail, exit1; all ten new tests
pass. All ten full observation rows and fourteen valid binary witnesses per arm
are exactly equal under the existing count-floored comparator. Strict new-test-
inclusive TS7 on candidate exits0 with zero diagnostics, unchanged configuration.
The complete three historical control failures remain retained; no fixtures,
assertions or failure markers changed. Raw logs, rows, comparison and strict log
are archived separately under `plan/log/6911-linear-char-code-at-20261007/main-e1e/`.

This is preservation of the used Linear IR provider on the composed epoch, not
Unicode source admission, shared provider reservation, full IR equality or
legacy retirement. A retains final integration/queue authority; HOLD remains.
Canonical main later b5991f6c760623c8e06a692d0905123bf66ce6d9 changes only nine
benchmark artifact files, not these frozen production operands. These results
remain explicitly pinned to e1e; later publication commits do not change them.
