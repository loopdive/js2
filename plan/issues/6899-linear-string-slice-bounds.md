---
id: 6899
title: "Linear string-slice bounds normalization"
status: in-progress
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen-linear
language_feature: string-methods
goal: ir-full-coverage
related: [1976, 2115, 2956, 3528, 4095]
files:
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/runtime/string-slice.ts
  - tests/issue-6899-linear-string-slice-bounds.test.ts
loc-budget-allow:
  # Issue6899 only: one leaf import and __str_slice bounds integration;
  # at most +20 counted LOC versus the pinned baseline, not other helpers.
  - src/codegen-linear/runtime.ts
func-budget-allow:
  # Issue6899 only: __str_slice integration within this over-limit builder;
  # at most +20 function-size lines versus the pinned baseline.
  - src/codegen-linear/runtime.ts::addStringRuntime
---

# Linear string-slice bounds normalization

## Classification and evidence

This is an independent target-runtime **correctness prerequisite**, not new
PreparedIR coverage, full String.slice compliance, or frontend retirement.
Exact inspected baseline: `8f3b70b37a37d5f475f759d155391621d79ffc92`.
No tests or runtime probes were executed while writing this plan. Predictions
below require identical baseline/candidate measurements before acceptance.

`src/codegen-linear/runtime.ts::addStringRuntime` registers `__str_slice` at
lines 2227–2313. It subtracts raw signed-i32 arguments, clamps a negative
difference to zero, allocates `12 + difference`, and copies from
`source + 12 + start`. Neither endpoint is normalized against source length.
Negative indices can read header/pre-payload bytes; oversized ends can copy
past the source; subtraction can wrap before allocation.

Real production callers, all retained:

- `src/ir/backend/linear-integration.ts::stringMethodPlan:2001–2015` maps
  `.slice` to `__str_slice`; `resolveFunc:1955` resolves that intrinsic.
  `src/ir/from-ast.ts::lowerStringMethodCall:9914–9930` emits saturating
  f64-to-signed-i32 conversion, but no relative-index/bounds normalization.
  This is the existing Linear overlay route, not the whole PreparedIR consumer.
- `src/codegen-linear/string-methods.ts::compileLinearStringMethodCall:174+`
  calls the same runtime from the direct frontend.
- `runtime.ts::__str_split:2439+` uses in-range byte intervals;
  `addLinearIrStringRuntime`'s charAt helper at 2704+ supplies either an
  in-range one-byte interval or `[0,0)` after its own bounds check.

Original proposed public regression, preserved verbatim:

```ts
export function run(start: number, end: number): number {
  return "abcdef".slice(start, end) === "ef" ? 1 : 0;
}
```

Native `run(-2,6)` is 1. Source inspection predicts current runtime length 8
and a read beginning two bytes before the payload, hence inequality/result 0
if this source owner reaches that helper. This is **not a measured admission
or value result**. Record any actual refusal separately; do not replace the
fixture, credit direct fallback as IR, or suppress an unrelated failure.

## Semantic boundary

Primary sources inspected 2026-10-07:
[String.prototype.slice, §22.1.3.22](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.slice),
[ToClampedIndex, §7.1.26](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-toclampedindex),
and [ToAbsoluteIndex, §7.1.25](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-toabsoluteindex).
After conversion, a negative finite index is relative to length, each endpoint
is clamped independently to `[0,length]`, and an end not above the start gives
an empty result. Bounds are not swapped. Omitted end is handled by callers.

Here the ABI already supplies signed-i32 endpoints and canonical byte-backed
string records. Implement only that integer normalization. For ASCII, byte
and UTF-16 indices coincide. Do not change numeric conversion, omitted-value
selection, receiver coercion, UTF-8 storage, surrogate semantics, encoding
admission, or non-ASCII guarantees. Existing in-range byte callers retain their
exact behavior. This does not repair general UTF-16 slicing.

## Ownership and dependencies

Plan claim supplied/effect-verified by parent:
`6899:linear-slice-plan-20261007`, owner
`ttraenkler/codex-linear-b-slice-astra-20261007`.

Finite disjoint implementation slices, released only by parent:

1. K, proposed for parent review before release: new
   `src/codegen-linear/runtime/string-slice.ts::linearStringSliceBoundInstrs`,
   its single import in runtime.ts, and **only**
   `runtime.ts::addStringRuntime`'s `__str_slice` registration,
   instruction-body builder, local count and adjacent comments. Keep its name,
   signature, registration position, malloc binding and exports unchanged.
2. T: **only** new `tests/issue-6899-linear-string-slice-bounds.test.ts`.
   Existing test files, fixture bytes, baselines and failure records remain.

No other helper, allocator, Wasm import, provider registry, shared emitter, index,
from-AST or metadata change is released. Parent's PR6572 array allocation
functions are disjoint within runtime.ts and must be preserved; issue4540's
allocator and issue2956's vector scope remain foreign. Older formatter/provider
claims are not transferred. Parent reports a fresh 25-PR inventory with no
other Linear function overlap. Reconfirm function-level ownership before K/T
release; absence of a PR path alone is not ownership authority.

Duplicate classification supplied by parent: completed issue1976's Linear
comparison/length repair records broader Unicode residuals; issue4095's GC
reflective string arms and issue2115's GC slice-bounds work are different
implementations. This issue is the narrow existing Linear helper repair.

A retains shared Prepared allocation/materialization and wiring. In particular
`src/ir/program-physical-plan.ts::planPhysicalSetup:1457–1459` rejects Linear
allocation plans as not materializable. Issue3528, “IR-only R8: linear consumes
the shared Prepared IR program”, remains the integration dependency. Do not
edit its foreign plan or remove that refusal to obtain positive coverage here.

## Implementation Plan

### Normalization and Wasm stack contract

Keep params 0=source, 1=start, 2=end, all i32; result remains i32 pointer.
Retain existing locals 3=newLen, 4=result, 5=copy cursor. Add local 6=byteLength
and local 7=magnitude scratch; set the registration's extra-local count to 5.
Load source length once from its existing offset 8. Normalize params 1 and 2
in place (Wasm parameters are mutable locals; caller values are unaffected).

For each endpoint `x`, emit this algorithm:

1. Test `x < 0` with `i32.lt_s`.
2. Negative arm: compute `m = 0 - x` in i32 and interpret `m` as unsigned.
   Compare `m >= byteLength` with `i32.ge_u`: choose zero if true, otherwise
   `byteLength - m`. Do **not** test the magnitude as signed or negate and
   then perform signed max. For INT_MIN, its magnitude bit pattern is
   `0x80000000`, correctly handled by the unsigned comparison.
3. Nonnegative arm: compare `x > byteLength` with `i32.gt_u`; choose byteLength
   if true, otherwise x. Each arm produces exactly one i32 using value-typed
   `if`s, then `local.set` consumes it into the endpoint parameter.
4. After both endpoints are in `[0,byteLength]`, compare end > start unsigned.
   A value-typed `if` yields `end-start` when true, otherwise zero; store newLen.
   Remove the old raw subtraction/signed-negative clamp.

This avoids signed overflow in `length+x`, works even when unsigned length has
its high bit set, and guarantees `0 <= newLen <= byteLength`. For nonempty
results every read has normalizedStart+cursor < normalizedEnd <= byteLength.
For empty/reversed results the existing loop performs no byte load. These are
logical bounds for a valid record, not validation of forged headers/pointers.

Keep the existing allocation/header stores, byte-copy loop and return. Exactly
one result record is allocated even for empty/full slices; do not add identity
reuse, a new copy kernel, source writes, forwarding or ASCII-cache mutation.
Payload size stays `newLen + LINEAR_STRING_PAYLOAD_PREFIX_BYTES`, length newLen,
payload at +12, allocator-owned header initialization unchanged. The runtime's
canonical layout authority remains single-sourced. No new allocator safety,
4-GiB endpoint, OOM or corrupted-record guarantee is claimed.

DRY implementation: place ONE small target-local instruction factory in
`runtime/string-slice.ts`, grouped with the runtime leaves:
`linearStringSliceBoundInstrs(boundLocal, lengthLocal, magnitudeLocal): Instr[]`.
Its inputs are distinct i32 local indices; it reads signed bound/unsigned
length, may overwrite only magnitude scratch, and leaves exactly one normalized
i32 on the stack. Invoke it twice from the actual `__str_slice` body and consume
each result with `local.set` to parameter 1/2. Return fresh instruction objects
per call; do not share mutable instruction arrays. Import only the existing
Instr type in the leaf. This is a used emitter fragment, not a new emitted Wasm
function, provider facade, semantic contract, or orchestration layer. Keep
result-length selection in the caller and allocation/copy/header code intact.
Leave optimizations to dedicated passes; no inlining/DCE decisions here.

The issue-owned frontmatter grants cover only unavoidable integration growth
in the already-over-limit file/function, capped here at +20 counted LOC and
+20 function-size lines respectively against the exact baseline. Record both
deltas; do not borrow another issue's grant, edit ratchet baselines, use `total`,
or grow any other runtime region. The new leaf must satisfy ordinary file and
function limits without exemption. If these bounds cannot be met, stop for
review rather than expanding them. Parent must explicitly release the proposed
leaf/import scope; this plan alone is not that release.

### T: finite regression population and safe baseline execution

Use the same new test bytes for exact baseline and final candidate. Parameterized
cases may share fixtures but each row has a stable ID and independent assertion.
No skip, `.fails`, conditional green pin, excluded failure, or replacement oracle.

**18 runtime rows:** for source `abcdef`, endpoints are:
`(1,4)`, `(0,6)`, `(2,2)`, `(5,2)`, `(-2,6)`, `(1,-1)`, `(-4,-1)`,
`(-20,3)`, `(2,20)`, `(20,30)`, `(0,-20)`, `(-20,-10)`, `(INT_MIN,6)`,
`(0,INT_MAX)`, `(INT_MIN,INT_MAX)`, `(INT_MAX,INT_MIN)`, `(INT_MAX,INT_MAX)`;
the eighteenth row is empty source with `(INT_MIN,INT_MAX)`.
Use native JS `source.slice(start,end)` as the exact expected ASCII payload.

Construct real runtime modules, in production builder order: `addRuntime`,
`addUint8ArrayRuntime`, `addArrayRuntime`, `addStringRuntime`; add
`addLinearIrStringRuntime` for charAt controls. Resolve helper export indices
as defined-function position plus function-import count, not hardcoded slots.
Use real malloc-backed small canonical source records (at most 16 payload
bytes), initialize only their data/length/payload-size fields from shared layout
constants/plan, and retain allocator-cleared header. Snapshot the whole source
record and adjacent occupied/poisoned storage before each invocation.

Extreme indices can make the **baseline** request gigabytes or copy from an
invalid address. Do not execute them through an unrestricted allocator. In the
test-built module only, prefix the real `__malloc` body with test observation
of request/call count and an unsigned `request > 64` trap **before** its original
body. Preserve the original body/locals; this is a labeled safety instrument,
not a source allocator fix. Small requests execute the real allocator. Cap the
fixture memory at one page; all setup must fit. Reset observation counters after
setup, not arena state. Validate the guard independently using requests 16
(passes with real allocation/header clearing) and 65 (guard fires with zero
allocator side effects). Log an oversized-request guard as instrumentation-
bounded baseline failure, never as a production runtime trap or candidate win
unrelated to normalization. Candidate must pass every semantic row without
triggering the guard. No giant strings, fake huge header lengths or timed loops.

For every successful row assert full bytes/text, length, payload-size word,
zero initial result header, distinct allocation, and exact arena delta
`align8(12 + expected.length)`. Check all source/neighbor/guard bytes unchanged
and output entirely inside the allocation/memory. Read result length first and
refuse to construct an oversized host view; record malformed lengths before
failing. Capture baseline exception, requested bytes and before/after state
even when semantic assertions fail; fresh instance per row prevents cascading
failures. In-range and ordinary negative/oversized small rows additionally
exercise the unmodified real allocator fixture, establishing guard transparency.

Source-derived baseline predictions, not observed results: `(-2,6)` produces
wrong length 8; `(1,-1)` produces empty instead of `bcde`; `(2,20)` requests
30 bytes and produces wrong length 18; `(INT_MIN,INT_MAX)` wraps the difference
to -1 and returns empty instead of `abcdef`; `(0,INT_MAX)` reaches the safety
guard. Record actual values/traps before drawing any measured conclusion.

**16 public rows:** eight bounded endpoint pairs in both overlay-enabled and
direct modes: `(-2,6)`, `(1,-1)`, `(-4,-1)`, `(-20,3)`, `(2,20)`, `(20,30)`,
`(1,4)`, `(5,2)`. Compile target linear, optimize false, with numeric runtime
parameters for endpoints so constant folding cannot stand in for the helper.
For each pair use the original numeric-return comparison fixture above with
the native expected literal; preserve the original `(-2,6)`/`ef` fixture exactly.
All correct candidate calls return 1. Record binary validation, actual result,
report compiled/rejected and owner evidence. Overlay rows must show compiled
owner `run`, no rejection of that owner, and the real intrinsic call/binding
to `__str_slice` in the reported body; direct controls use `JS2WASM_LINEAR_IR=0`.
Missing admission is a separate blocker, not permission to edit shared files or
silently substitute unit/direct evidence. No claim about PreparedIR ownership.

**Unchanged-caller controls:** actual charAt runtime calls for ASCII positions
-1,0,5,6,INT_MIN,INT_MAX (expected empty,a,f,empty,empty,empty), and real split
on `a,b,c` with comma plus `abc` with absent delimiter `|` (all component payloads
and array lengths checked). Their small in-range slice calls must remain exact.
Also retain a public omitted-end `.slice(-2)` comparison in each direct/overlay
mode; classify any existing admission failure without bypassing it. Verify
in-range UTF-8 byte intervals remain byte-for-byte unchanged with a runtime-only
`éx` control `[0,2)`; this is existing byte ABI preservation, not JS Unicode
slice compliance. Do not introduce empty-separator split or unrelated features.

Expected semantic population: 18 runtime rows + 16 public rows + 6 charAt +
2 split + 2 omitted-end + 1 byte-ABI control = **45 semantic rows**, plus the
2 allocator-instrument controls. Extra transparent-allocator repetitions are
reported separately, not counted as additional feature coverage. Use the same
bounded cases on both revisions; parent serializes runs with a finite external
watchdog and records timeout/incomplete results, never widens a timeout to pass.

## Validation and acceptance

Parent records exact baseline/candidate SHAs, source/test SHA256, Node/V8,
command, target/options/env, all row IDs/results, pass/fail totals and full raw
logs. This plan reports no pass count. Candidate failure classification must
distinguish runtime semantics, compilation/admission, and test setup/guard
failures. Repair an instrument only by preserving its prior bytes/logs and
rerunning identical repaired bytes on both revisions.

Required release evidence:

- [ ] Source diff changes only the released `__str_slice` region/local count,
      its one leaf import and the reviewed normalization leaf;
      unrelated helpers including parent array work remain unchanged.
- [ ] New test proves at least one actual original production failure and an
      unchanged passing control on baseline; candidate fixes the bounded rows.
- [ ] All 45 semantic rows and 2 guard controls accounted for without skips;
      overlay/direct/runtime-only evidence explicitly separated.
- [ ] Exact output/allocation/bounds/source-immutability checks pass, including
      INT_MIN/MAX with no oversized candidate allocation and no baseline risk.
- [ ] Existing `tests/linear-string.test.ts`, `tests/issue-1976.test.ts`,
      `tests/issue-2956.test.ts`, and directly relevant string-runtime controls
      run unchanged on both exact revisions; retain and attribute existing
      failures rather than editing expectations or announcing generic green.
- [ ] Parent-approved typecheck, formatting and scoped budget/static checks
      pass within this issue's two bounded integration grants; no further
      budget exemption or shared-file release is inferred.
- [ ] PreparedIR allocation refusal and Unicode/numeric conversion limitations
      remain explicit; no claim of new admission, migration completion or
      retirement. Any shared dependency returns to A, not to K/T source scope.

Plan author performed read-only source/spec inspection and wrote this issue
only. No source/test edits, test execution, commit, push or claim operation.

## Implementation record — 2026-10-07, Session B

The parent released the finite K/T scopes after reviewing the complete plan.
Sol 6.1 Medium implemented the source and independent test in separate worktrees;
Astra High's static source review found no actionable defect. No shared A file
was edited. Source commit `beda2d0c15db4027b7407d3b0382fd31323fb394`
adds the 49-line used leaf and changes only the declared runtime seam/import.
Runtime file growth is +4 lines; `addStringRuntime` grows +3, below both caps.
Normal formatting, lint and budget hooks passed; ratchet baselines are unchanged.

Frozen validation:

- Baseline source `8f3b70b37a37d5f475f759d155391621d79ffc92`, with the new
  test untracked in its isolated test worktree; no production edits.
- Candidate source/test `899883bec7874bc438fe0955d2094d67bb04abc0`.
- Identical test SHA256:
  `07ece44523e7e9c82aeb60f44d34b43506bc797151b510099b042b9a2ed03136`.
- Candidate runtime SHA256:
  `7482f82a03f431bf5bdeb334697b25c5b5a3ad24ec3130da65ab13c9daa58f09`;
  leaf `876837def1a21df66198f7bfece58c4096b16e895bd8cba7d069b086c48980f6`.
- Node 22.23.2 / V8 12.4.254.21-node.56, single-fork Vitest, target Linear,
  public optimize:false. Each feature run had a 180-second external watchdog;
  each unchanged-control run had 240 seconds. No timeout or widened limit.

Actual V1 feature result: baseline **22 pass / 25 fail out of 47**, candidate
**47/47**, no skips. Both population records account for all 45 semantic rows,
two safety-instrument controls and 12 separately logged real-allocator
transparency comparisons. Baseline runtime failures were 11/18; public explicit
bounds failed 6/8 on each route, and omitted-end failed on each route. Candidate
fixes those values with the same tests. All nine overlay public owners prove
actual admission, intrinsic binding, installed owner/export association and
real `__str_slice` call. This is existing overlay ownership, not newly admitted
source or shared `PreparedIrProgram` acceptance. Direct-mode global report data
can remain from the preceding overlay; it is diagnostic only, not direct-mode
ownership evidence. Direct controls are identified by their actual flag/options.

Extreme baseline requests were bounded by the validated test-only instrument;
one oversized request hit that guard. Guard trips are not production allocator
trap claims. Candidate never trips it. Split's valid 144-byte array allocation
uses the unmodified one-page allocator, not the 64-byte instrument. All complete
payload/header/allocation/source-memory checks pass. In-range byte ABI, six
charAt controls and both split controls remain unchanged.

All 22 previously passing feature rows compare exactly after excluding only
`evidence.binarySha256` and `evidence.emittedSha256`; no behavior, memory, error,
route or ownership field was excluded. The retained comparison reports 47
baseline rows, 47 candidate rows, 22 compared and zero differences.

The combined unchanged-control population (`linear-string`, issue1976 and
issue2956) produced **45 pass / 3 fail out of 48**, exit 1, on each revision. Failure
identities are unchanged: fixed-number-vector admission; core Linear string
admission; UTF-16 charCodeAt capability including omitted arguments. Original
positive requirements, fixtures and diagnostics are retained, not weakened.
These results do not establish whole-suite parity or full IR completion.

Lossless raw feature/control logs and the exact passing-row comparison are in
`plan/log/6899-linear-string-slice-20261007/`. Raw feature SHA256 values:
baseline `a402a70dfc856e01210e6272f7506d328a6be7784c5494123a43ae72b6c5e3ca`,
candidate `08cc7d28252d7da4efb67532c7d2db7e5869f43f704c4014ff74ba6c653b5e32`.
Raw control SHA256 values: baseline
`1ab22273aa6fc264cfba79b648927f36b749c69151758f5ed4ffcf2f8dbf4903`,
candidate `c72dc54693a0edc8a2555d1547583193b76a786bf1b6a2d192d79915b3d9a97b`.
Vitest's failure rendering includes NUL bytes, so extraction uses `rg -a` plus
jq with positive population counts; ordinary text-mode search is not evidence
of empty output. No source fixture or semantic assertion was changed; the
strict test-typing repair below preserves the original instrument and logs.

PR #6575 is non-draft and held for A's integration/queue decision. Initial
published plan/handoff HEAD was `519b45f5e24898a0eaed0fd34a470a7f4e775c6d`;
later publication is verified against the remote/PR head separately. Legacy,
encoding/numeric conversion limitations and shared allocation refusals remain.
Signing correction: this host has no configured signing settings and these
commits contain no `gpgsig`; earlier signed-commit wording was unverified.
Signing was not disabled; normal commit/push protections remain active.

### Final V2 instrument qualification

V1 strict test-inclusive TS7 diagnosed two DOM `BufferSource` generic mismatches
and consequent instantiate-overload errors. Sol repaired only those two
WebAssembly API sites using ordinary ArrayBuffer-backed byte copies; original
byte digests, all source fixtures and all assertions remain unchanged. V1 test
bytes and diagnostics remain losslessly archived, not replaced by V2 evidence.

Final V2 test SHA256:
`d808dc5b064c536f7e94576325fab46dc6ec489aeb453d8936fa60058097252b`.
The same V2 bytes were rerun on baseline `8f3b70b37a` and candidate
`cfbfe60ce1`: **22 pass / 25 fail out of 47** versus **47/47**, with all
45 semantic rows, two guard controls and 12 transparency comparisons accounted
for. Both repaired-run raw row arrays are exactly equal to their corresponding
V1 arrays, with **no excluded fields**. The final cross-arm passing-row comparison
again has 22 rows, zero differences, excluding only the two binary digest fields.

Raw V2 feature log SHA256: baseline
`f7a4b888baa917cb1de18775e31571c459a29262b7bdaf82c18076bd83d8ee2f`,
candidate `b0cee9702bdad7d8fde76da9c875acbea95fa304a0e71ea9eb8b9b94e246743c`.
Source runtime/leaf bytes remain those qualified at `899883bec7`; the unchanged
48-control population is qualified at that source epoch, not relabeled as a
new full suite at a later test/docs commit.

Strict candidate TS7 covering all source and the new test finished **exit 0**,
zero diagnostics, with `.tmp/6899-validation/tsconfig-test.json`; V1's diagnostics
are its positive control. A path-adjusted reproduction config with the same
selected files/options is published in this log directory. Reproduce with
`node node_modules/typescript7/lib/tsc.js --noEmit -p plan/log/6899-linear-string-slice-20261007/tsconfig-test.json`.
All runtime feature runs kept their original 180-second watchdog; no timeout
extension, semantic fixture change, skip or protection bypass was used.

## Residual UTF-16 source-slice plan — 2026-10-08

### Authority, preserved scope, and corrected eligibility

This appendix does not revise the byte-interval contract, original fixtures,
qualification counts, failures, or acceptance records above. It specifies a
separate residual within this issue; it does not reclassify PR6575's bounded
byte-normalization repair as full Unicode slicing or completed IR migration.

Planning base: PR6575 head
`2ca9e12af199c1d0c4b4fe446e8c99149b2b83af`, in
`/private/tmp/js2-6899-unicode-slice-plan-20261008`, branch
`codex/6899-linear-unicode-slice-plan-20261008`. Parent effect-verified exact
upstream planning claim `6899:unicode-slice-contract-plan-20261008`, owner
`ttraenkler/codex-linear-b-unicode-slice-astra-20261008`, at ledger
`884cc91d901f7e2f650c9f713792833274bce500`. The release covers ONLY this issue
file. All source/test partitions below are proposals, not implementation
claims, transfers, or permission to edit their files. Parent serializes runtime
implementation and typing/qualification. Parent integrates this appendix into
existing PR6575; no new checkpoint PR or GitHub issue is requested.

The residual has two distinct parts: a measured legacy Unicode wrong answer,
and a missing Linear IR encoding/admission capability. **There is no measured
accepted-IR Unicode wrong answer in the diagnostic below.** Keep the existing
loud IR refusal until the representation, provider, routing, and real execution
contracts are all proven. B cannot widen admission to turn a rejected program
into an apparently covered one.

### Measured correction: four diagnostic rows, two ASCII controls

Parent ran the genuine public compiler and validated/instantiated native Wasm
in `/private/tmp/js2-6905-main845-baseline-20261008`, HEAD
`3fee634ae67f23f57085ce6b792e584cd78e85ac`, source tree
`953f74f80cf2f8085b8e1c93489fcdd357929b37`. This is a distinct diagnostic epoch,
not a run on the PR6575 planning head. Runtime SHA256:
`2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f`.
Node was v22.23.2. The recorded native policy is explicitly
`unclassified; compatibility diagnostic only`.

The actual source template is:

```ts
export function run(start: number, end: number): number {
  return "éx".slice(start, end) === "x" ? 1 : 0;
}
```

The retained probe carries its exact original one-line source bytes, using
either `ax` or `éx`, and runtime arguments `(1,2)`. Options were target Linear,
optimize:false, experimentalIR:false, disableIrFirst:true, and
moduleName `issue-6899-unicode.ts`; `JS2WASM_LINEAR_IR` was 0 for direct and
1 for overlay. All four rows compiled successfully and validated their binaries:

1. Direct `ax`: actual1, native1; compiled/rejected fields deliberately null.
2. Direct `éx`: actual0, native1; compiled/rejected fields deliberately null.
3. Overlay `ax`: actual1, native1; compiled `["run"]`, rejected `[]`.
4. Overlay `éx`: actual0, native1; compiled `[]`, rejected `run` with
   `string-evidence-unsupported`, detail
   `ir/linear-string: ASCII encoding proof required for constant result (got utf8-guaranteed)`.
   The actual0 executes retained legacy fallback, not an accepted IR owner.

These are two successful ASCII value controls and two Unicode wrong values
on the legacy path. The overlay Unicode row also proves a genuine IR refusal.
The probe records the current report but does not capture a complete prepared
owner/consumer/physical-call join; do not promote its report into that stronger
proof or claim new native-policy coverage. Its terminal record confirms source
custody unchanged and expectedRows4. Parent reports normal approved execution
exit0; that exit means diagnostic completion, not four semantic passes.

Read and retained evidence, which parent will archive without overwriting:

- `.tmp/6899-unicode-slice-probe.mts`, SHA256
  `3e6cfec5d0052b677ce0a535ccb5dc7985971f8cda35a5344291c728a777a7d2`.
- `.tmp/6899-unicode-slice-probe-v2.log`, SHA256
  `6719ce950524281e6f08ccbaa68c241796e7da2f58708b436a28ec5a8294e097`.
- Initial `.tmp/6899-unicode-slice-probe.log`, SHA256
  `161212b205baf5a1e446d6e60fe01a00dc92052285084f02459f7e45e6172b61`:
  local tsx IPC failure before compilation, not compiler/runtime evidence.

The earlier source-derived prediction is now narrowed by measurement: bytes
for `éx` are c3 a9 78; the existing byte helper's interval `[1,2)` selects a9,
not 78. That explains the legacy mismatch. It does not establish an IR
execution of that Unicode operation. No probe was rerun by the plan author.

### Existing contracts and required architecture

There are two different operations sharing the old name:

- Source `String.prototype.slice` consumes UTF-16 code-unit positions and
  returns the exact selected code units, including isolated surrogate halves.
- Internal `__str_slice` consumes byte intervals in the existing record.
  `addStringRuntime`'s `__str_split` uses it with byte positions;
  `addLinearIrStringRuntime`'s ASCII-only charAt provider also delegates to it.

Retain `__str_slice` and `linearStringSliceBoundInstrs` as the existing byte
operation. Do not silently reinterpret their indices, rename the symbol out
from under callers, or change split/ASCII-charAt bodies. A distinct semantic
source-slice binding must identify a real UTF-16-capable target provider.
Its eventual symbol/ABI is a dependency to publish, not a guessed name to
register now. No boolean mode parameter, name alias, or fallback silently
switches the meaning of the byte helper.

Generic contracts describe string values, code-unit semantics, encoding
evidence, allocation identity, and effects. Linear owns physical decoding,
allocation, and emitted instructions. Runtime body construction belongs in
the target's cohesive string runtime leaves; it must be installed by the
real registration path and called by the authenticated current source owner.
Do not add an idle builder, speculative adapter, new generic orchestration
layer, or copied JS allocator/decoder as an implementation substitute.

Concrete representation constraints in this source:

- `src/ir/core/string-types.ts::IrStringEncoding` distinguishes `ascii`,
  `utf8-guaranteed`, and `wtf16`. These are semantic guarantees, not permission
  to change record bytes or select an undocumented wire format.
- `src/ir/analysis/encoding.ts::classifyCall` deliberately does not preserve
  UTF-8 evidence through slice/substring/charAt: slicing can split a surrogate
  pair, so their general result is conservatively `wtf16`.
- `src/ir/analysis/linear-string-runtime.ts::validateLinearStringRuntimeEncoding`
  and `bindLinearStringRuntime` currently require ASCII evidence. The measured
  Unicode constant refusal is consistent with this gate; removing it alone
  would be unsound.
- `linear-memory-plan.ts::linearStringLayoutId` names `string:utf8-bytes-v1`;
  its literal materialization and `string-literals.ts::linearStringLiteralInstrs`
  use `TextEncoder`. That cannot preserve an isolated surrogate. The current
  `__str_from_data` copies bytes; it is not an implicit WTF-16 codec.
- Runtime length/charCodeAt decoders accepting some byte patterns do not prove
  a valid lossless carrier contract. `__str_eq` compares bytes, so a new
  noncanonical surrogate encoding can disagree with an equivalent string
  constructed by another path. Hashing, concatenation, repeat, caches and
  boundary conversion must agree too; tolerance by one decoder is insufficient.

For `"😀".slice(0,1)`, the result must contain code unit d83d, and `(1,2)`
must contain de00. Neither may become fffd, empty, or the original pair.
Likewise a genuine input lone surrogate must survive. Do not encode the native
expected string through `TextEncoder` and mistake replacement bytes for an
oracle. A lossless WTF-8-like representation, UTF-16 storage, or another carrier
is not selected by this appendix. A must publish the genuine contract and its
consumer closure first. Until then full Unicode runtime implementation is held.

### A-owned dependency packet and proposed exact partitions

Parent identifies PR6583 comment6049709582 as the latest A scope authority:
`https://github.com/loopdive/js2/pull/6583#issuecomment-6049709582`.
A holds `linear-integration.ts`, `index.ts`, target admission and shared
preparation; its scope excludes JS-host IR. This attribution is parent-supplied;
the plan author's read-only API lookup failed to connect. No new release is
inferred, and no JS-host IR route is requested or offered as a substitute.

Before B source dispatch, A/parent must publish and verify:

1. Input/result encoding and physical layout authority, including lossless
   isolated-surrogate construction, canonical equality/hash behavior, and
   result allocation/effect evidence. Name every affected real producer and
   consumer; acquire separate ownership for any changes beyond A's packet.
2. Exact target provider symbol, signature, locals/dependencies and reservation
   order, with source-method binding separated from byte-helper binding.
   State index units, omitted-end policy and supported numeric domain. Do not
   hardcode function indices or treat a namesake import as the provider.
3. Admission/preparation rules which reject unsupported input or result
   encodings before consumption. Keep current refusal until the complete
   runtime and routing are ready; no optimistically broadened interim gate.
4. Whether delivery covers the current Linear overlay, the shared Prepared
   consumer, or both. Authenticate and report each separately. A's wider
   migration work is not completed merely because a leaf runtime passes.

Proposed A integration partition, subject to A's explicit acceptance:

- `src/ir/backend/linear-integration.ts::makeLinearIrResolver`: its
  `stringMethodPlan`, intrinsic `resolveFunc` binding, and the exact string
  encoding/admission/preparation dependencies needed for the new operation.
  Existing `prepareLinearStringCapabilities`/`prepareLinearIrOverlay` remain
  A-owned; A must enumerate any necessary subregions before release.
- `src/codegen-linear/index.ts::sourceMayUseLinearIrStringRuntime`,
  `generateLinearModuleBody`, and `generateLinearMultiModuleBody`: only the
  demanded provider registration/preparation plumbing A actually selects.
- `src/ir/from-ast.ts::lowerStringMethodCall`, `encoding.ts::classifyCall`,
  `linear-string-runtime.ts::{validateLinearStringRuntimeEncoding,bindLinearStringRuntime}`,
  and `linear-memory-plan.ts` layout/materialization are contract inspection
  dependencies, NOT a blanket edit request or a claim that all must change.
  A identifies exact changes/owners if its published contract requires them.

Proposed B runtime partition, **only after that packet and fresh exact claims**:

- New `src/codegen-linear/runtime/strings/slice-utf16.ts`, proposed
  `buildLinearStringSliceUtf16Body`: one fresh-instruction body builder for
  the published physical contract, with concrete dependency/local operands
  supplied by the real registration owner, no module/AST/planner ownership.
- `src/codegen-linear/runtime.ts::addLinearIrStringRuntime`: only the new
  source-slice provider registration/body delegation and associated import,
  if this is the registration home A approves. Do not change neighboring
  append/charAt/charCodeAt callbacks or `findFuncIndex`/`addRuntimeFunc`.
  Function-table/registration effects require A's serial integration review.
- Existing byte normalization in `runtime/string-slice.ts` may be consumed
  unchanged against a proven code-unit length if the approved index domain
  matches its signed-i32/unsigned-length contract. Do not clone the normalization
  algorithm, alter existing byte callers, or select a new ABI just to reuse it.

There is no runtime-only production release while the result representation
is unknown. Once it is fixed, runtime construction and exact emitted-Wasm
semantics are B's independent work package, but landing requires real A-owned
call-through; a test-only export does not complete the migration. Existing
budget allowances above apply to the historical byte repair, not automatic
grants for this additional provider.

Proposed test partition: new
`tests/issue-6899-linear-utf16-source-slice.test.ts`, separately claimed after
parent approves its finite population and contract. Keep the existing47-case
file and all historic logs unchanged. Before implementation, parent may release
only a bounded diagnostic test phase preserving the four measured rows and
refusal as evidence, without faking positive IR admission. Parent alone assigns
and serializes runtime tests, full consumer qualification, and strict typing.

Legacy direct-route parity is an explicit separate dependency:
`src/codegen-linear/string-methods.ts::compileLinearStringMethodCall`, only its
`slice` branch, requires its own release and approved source-semantic binding.
It is not included in B's leaf authority. Its current omitted-end behavior and
argument conversion must be assessed by its owner. The measured legacy defect
remains open if only the IR route is delivered; do not claim both fixed.

### Conditional implementation semantics, not a speculative ABI

After A publishes the physical contract, implement the following in the real
target provider; no source dispatch is authorized before that point:

1. Interpret source endpoints as UTF-16 positions after the published
   ToIntegerOrInfinity conversion. Normalize each independently against the
   code-unit length; negative positions count from the end, reversed/equal
   intervals yield empty, and omitted end means that length. Preserve source
   evaluation order and single receiver evaluation in the routing owner.
2. For a proved signed-i32 index domain with code-unit length below INT_MAX,
   reuse the checked normalization fragment with that length, not byte length.
   A must prove the length bound if it retains saturating i32 conversion;
   otherwise index representation is an A dependency, not a B workaround.
   Numeric NaN, infinities, fractions and negative zero remain source semantics,
   not accidental Wasm traps or unsigned reinterpretation of negative indices.
3. Walk the approved physical representation while tracking byte/storage
   position separately from UTF-16 unit position. For a scalar-only UTF-8 input,
   one-/two-/three-byte sequences contribute one unit and four-byte sequences
   contribute two. Endpoints may fall between those two units. Include exactly
   the selected units; do not round outward to whole code points.
4. Compute the physical result size using the approved lossless writer before
   allocation, or use a proven checked bound with the contract's capacity rules.
   Guard endpoint/size arithmetic before narrowing or allocation. Physical
   output byte count is not necessarily selected code-unit count. Use the
   existing allocator, record fields and cache initialization contract once.
   No foreign allocator repair or universal OOM guarantee is included.
5. Emit the selected units using the authoritative representation. Copy intact
   spans only when proven equivalent to that writer; encode a boundary half
   only according to the published surrogate policy. Initialize all visible
   result fields; preserve input/neighbor payloads and allocator custody.
   Do not change the old byte helper's allocation or cache behavior.
6. Reuse existing target-local codecs only if they implement the published
   contract. If a missing codec or another consumer needs edits outside this
   partition, return that concrete dependency to its owner. Do not scatter
   subtly different decoder/encoder algorithms across helpers.

### Finite acceptance and proof of real consumption

Retain the original four source rows exactly, including flags/options/source
bytes and the two ASCII controls. Preserve their current Unicode failure and
overlay refusal records before measuring a candidate. A future positive IR
claim requires current source-owner identity, actual admitted body, prepared
consumer/batch association where applicable, resolved defined provider and
physical call in that same module, validated bytes and executed result. A
report getter, compilation success, legacy fallback or manual IR is insufficient.

Finite semantic obligations for the later independent test file:

- BMP mixed input `éx`: `(0,1)`, `(1,2)`, `(-1,2)`, full, empty and reversed;
  mixed `aéb€c`: `(1,4)` selects `éb€`. Compare exact code units and length.
- Astral `a😀b`: `(1,3)` selects the pair; `(1,2)` only d83d; `(2,3)` only
  de00; `(2,4)` low half plus b; `(-3,-1)` the intact pair; full/empty controls.
- Genuine lossless inputs containing a lone high surrogate, lone low surrogate,
  adjacent nonpair surrogates, and surrounding ASCII. Use the approved real
  producer, not manually fabricated headers or TextEncoder replacement. Missing
  production construction is a dependency, not a waived case.
- Read selected results through authentic length and charCodeAt; compare every
  code unit to native JS. Check equality with independently produced equivalent
  values, slicing a result again, concatenating selected high+low halves versus
  an intact pair, and repeat of a half. These expose carrier/canonicalization
  mismatches; do not edit foreign consumers to satisfy them without release.
- For a small proven input, preserve numeric source controls NaN, +Infinity,
  -Infinity, -0, fractions, signed-i32 boundaries, and omitted end. Compare
  source results with native JS; do not feed f64 arguments to an i32 runtime
  export and call that a conversion test. Unsupported source forms remain
  explicit admission dependencies, not automatic skip/green cases.
- Old byte helper on `éx`, interval `[0,2)`, must still return c3 a9. Retain
  original split and ASCII-charAt controls and the earlier47-case population.
  Keep byte-ABI preservation distinct from source Unicode correctness.

Use genuine runtime construction (`__str_from_data` for valid scalar UTF-8
fixtures, the approved lossless producer for surrogate cases), real emitted
providers and native Wasm. Observe full result bytes/header/capacity, source and
neighbor memory, allocation request/delta, and errors. Interpret raw result bytes
only with the approved carrier codec; native JS code units are the independent
semantic oracle. Do not use a JS copy of the candidate algorithm as the subject.

Before dispatch, parent freezes explicit row IDs/inputs/expectations and the
approved producer/consumer APIs, avoiding an open-ended matrix. Missing owner
joins, setup failure, suite skips and refusal are not passes. Baseline and
candidate use identical frozen test bytes; any instrument repair preserves
both old bytes/logs and reruns both arms. Parent archives full raw records,
commands, relevant effective flags, source/test/binary hashes, exact epochs,
actual totals, watchdog outcomes, and complete witness comparisons. The original
four-row probe is diagnostic evidence, not the future full qualification suite.

### Release/acceptance checklist for this residual

- [ ] A's explicit contract/routing packet is published; source ownership is
      effect-verified and disjoint, including any direct-route change.
- [ ] Lossless input/result surrogate representation and its actual consumer
      closure are proven; existing refusal is not removed prematurely.
- [ ] B's named runtime provider has a real current source consumer, not only
      manual exports. Accepted-IR Unicode execution is measured separately
      from retained fallback and any new shared Prepared capability.
- [ ] New source/runtime semantic obligations and unchanged byte-caller
      controls are accounted for without fixture/assertion weakening; original
      evidence/counts remain under their original source epochs.
- [ ] Parent's serial strict typing/static/budget/CI checks are recorded on
      the actual composed revision; no default-CI pass or performance claim
      follows merely from the diagnostic or a leaf test run.

No JS-host IR, generic admission widening by B, foreign3518 append/4540 allocator
takeover, legacy retirement, new benchmark claim, shared registry exemption or
error-protection bypass is authorized. This appendix is a dependency-gated
implementation proposal; only its documentation write/commit is released now.

## Bounded registry handoff — 2026-10-08

Parent released only this existing issue and `scripts/compiler-boundaries.json`
under canonical claim `6899:registry-handoff-20261008`, owner
`ttraenkler/codex-linear-b-registry-sol61-20261008`. Fresh canonical ledger
`7f0c4e36be071ab38a48b4a5fe25b4aa7790d09b` records this claim in progress,
write ID `79507-xolp9ix8`; raw evidence is retained in
`.tmp/6899-registry-handoff-20261008/`.

Authority is A's published registry proposal
`52b64c8277b4e61c42f24e7821445260aa638179` (PR6595), with approved Astra
High plan provenance adopted in PR6596 commit
`555af588b3b41dda3b95a3d53468e0f4d55a32c7`. Adopted plan SHA256:
`ca7b3e3ed09a89da6917231a7ccc906369e567d2e180e0b145ac05c5f299d636`;
handoff SHA256:
`29879b4e2ee6d4968156ecf950206239087d75011d028d7d14eec776b9e57f57`.

Fresh PR6575 head is `e04ba4a8df5b81d65787f2b574e0d8f433bd3060`,
actually backed by `ttraenkler/js2`, with HOLD and null auto-merge. Of the
eight proposed paths, only `src/codegen-linear/runtime/string-slice.ts`
exists here. Add only its exact published `unmigrated` / `legacy-linear`
module row; all seven absent paths, including runtime README, remain absent.
Preserve every baseline policy byte and order outside that insertion, with no
exemptions. This older source epoch is not refreshed or requalified on main.
No source, tests, workflow, claims, holds, queue or admission changes are released.

Validation: normal boundary inventory against the exact original head exited 0,
with 1,883 tracked modules, 14,526 resolved edges, two excluded non-modules and
zero errors. Inventory is valid; graph and architecture completeness remain
false, so this is not migration completion or main-epoch qualification.
The meaningful floors (1,700 modules / 1,000 edges), exact published-row equality,
full-policy removal and baseline-byte/order preservation checks passed.
Baseline SHA256 is
`1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f`;
updated policy SHA256 is
`21173628c0c675407b4381101eb3ffb26aa9fd6bda0a63ce0a4677639bcaa184`.
Prettier and whitespace checks passed. No heavy tests, typecheck or build were
run; the previously completed 125-test detector regression was not duplicated.
Parent retains review/push authority; this bounded commit does not release HOLD.
