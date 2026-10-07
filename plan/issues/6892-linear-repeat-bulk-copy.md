---
id: 6892
title: "Linear string.repeat provider: replace bytewise remainder loop with bounded bulk copies"
status: in-progress
created: 2026-10-07
updated: 2026-10-07
sprint: Backlog
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: ir, codegen-linear
language_feature: string-methods
goal: performance
related: [3922, 1004, 3518]
origin: "Session B source-derived provider investigation and explicitly released specification scope"
---

# Linear repeat bulk-copy kernel

## Baseline, authorization and scope comparison

Plan against exact main `e7760d1c2af4636ede6a352154d193b234af5fc4`.
Planning worktree: `/private/tmp/js2-6892-linear-repeat-plan-20261007`, branch
`codex/6892-linear-repeat-plan-20261007`. Only this new issue file is authorized
for the architect to write. No implementation, tests, benchmark execution,
commit, push or claim operation was performed while writing the plan.

Parent supplied effect-verified specification ownership:
`6892:linear-repeat-plan-20261007`, owner
`ttraenkler/codex-linear-b-repeat-astra-20261007`. There is no implementation
claim yet. Parent's fresh held-book comparison at `fe6a91` reports no repeat
kernel claim and no open string-repeat PR. The previously ambiguous provider
scopes have been resolved by the parent:

- Host JS repeat owns the distinct `src/codegen/ir-host-string-repeat.ts` path.
- Provider current-reader work owns exactly
  `tests/issue-3518-provider-verification-ownership.test.ts`, as recorded in
  the main issue 3518 at line 3689.
- Active 6865 Linear finalizer, telemetry, source-map and numeric-module work,
  and Session A's shared integration/compiler ownership, are excluded here.

Earlier local issue searches found no narrow bulk-copy repeat issue. #3922,
"linear backend: 7 String builtins unimplemented", already records the repeat
kernel's delivery. #1004, "Optimize repeated string concatenation via
compile-time folding and counted-loop aggregation", delivers the upstream
transformation; this issue optimizes its existing Linear provider. #3935's
quadratic concatenation allocation is a different mechanism and is not fixed
or closed by this work.

## Problem and production reachability

`src/codegen-linear/string-repeat.ts:103`, `addLinearStringRepeatRuntime`,
generates `__str_repeat(i32 stringPointer, f64 count) -> i32 stringPointer`.
Its payload loop at lines 219-253 executes `i32.rem_u`, a byte load, a byte
store and loop control once per output byte. The output is already allocated
once. This is a source-observed optimization opportunity, not a demonstrated
wrong result, asymptotic allocation defect or measured speedup.

The actual admitted IR route exists on the planning base:

1. `tests/issue-3518-linear-counted-string-reservation.test.ts:29`,
   `compileCounted`, compiles a source loop appending ASCII `"xy"` to `"seed"`
   with `JS2WASM_LINEAR_IR=1`, `JS2WASM_IR_STRING_BUILDER=1`, target `linear`
   and `optimize:false`. Its N>=2 test at line 76 inspects one semantic
   `string.repeat` node and executes the exported function.
2. `src/ir/backend/linear-integration.ts:778` reserves the exact provider and
   binds its receipt during `prepareLinearIrOverlay`, before user slots.
3. `src/ir/lower-generic.ts:1944` consumes `string.repeat` and delegates to
   `LinearEmitter.emitStringRepeat` at `linear-emitter.ts:196`.
4. `linear-integration.ts:2053` emits the call through
   `resolvePreparedLinearStringRepeatProvider:1789` and
   `authenticatePreparedLinearStringRepeatProvider:1757`. Authentication
   requires the exact intrinsic binding, reservation, source/preparation
   receipt and `(i32,f64)->i32` ABI.
5. The resulting call reaches this leaf's `__str_repeat` body. Semantic Linear
   admission requires authenticated ASCII evidence
   (`src/ir/analysis/backend-legality.ts:158`). Non-ASCII provider tests below
   exercise the existing lower-level kernel, not expanded semantic admission.

The existing source test asserts the compiled owner, receipt site identity,
provider binding, and returned `"seedxyxyxy"`. It was inspected, not rerun.
An overlay flag or successful direct `.repeat` compilation alone is not proof
that an experiment exercised this semantic IR route.

## Implementation Plan

### Disjoint implementation ownership

K — kernel owner may edit only `src/codegen-linear/string-repeat.ts`, inside
`addLinearStringRepeatRuntime`: replace its payload loop and update only the
associated local declarations/names/comments. Preserve indexes 0-5. Reuse
the old i32 local 6 as `initializedBytes`; append at most one i32 local 7 as
`copyBytes`. No new helper registration, export, signature or wrapper.

T — validation/instrument owner may create only
`tests/issue-6892-linear-repeat-bulk-copy.test.ts`. Put semantic regressions,
provider regressions and an optional environment-gated performance case in
this single new file. This owner has no production write scope. Tests and the
performance section share one owner; do not dispatch competing writers to
that file. K and T are disjoint and can develop against the same baseline.

The issue document remains parent/spec-owner controlled. No shared fixtures,
existing tests, benchmark registries, scripts, compiler entrypoints, index
files, `linear-integration.ts`, `linear-emitter.ts`, source-map files, IR
metadata, feature manifests or custody receipts are writable by K/T.

### Preserve the existing semantic and allocation prefix

Leave all instructions preceding the old payload-copy loop unchanged:

- Count truncation, negative/+Infinity rejection, NaN normalization and their
  order, including rejection before empty-source handling.
- Empty-source and count-one reuse, result-byte-size calculation/limit,
  narrowing, the one `__malloc` call and its failure behavior.
- Header initialization: payload capacity at +4 equals resultLen + 4; byte
  length at +8 equals resultLen; payload begins at +12. Header byte-zeroing
  remains the existing allocator's responsibility.
- The final returned result pointer, provider name, signature, registration
  position, identity, reservation and receipt/authentication code.

The new zero-result check is local to the replacement copy region, **after**
the existing allocation/header writes. A nonempty source repeated zero times
still returns the same kind of newly allocated empty record as the baseline.
Do not move it into the semantic guards or convert it into a new early-return
allocation optimization.

### Copy algorithm and exact instruction operands

Let `S = sourceLen`, `L = resultLen`, `src = arg0 + 12`, `dst = result + 12`.
Wrap the complete new copy region in `if (L != 0)`; skip both seed and loop
for L=0. The existing empty-source return ensures S>0 on this path.

1. Emit one copy of S bytes from src to dst.
2. Set initializedBytes = S.
3. While initializedBytes < L (unsigned comparison):
   - remaining = L - initializedBytes;
   - copyBytes = min(initializedBytes, remaining), using unsigned comparison
     and the existing core `select`/local operations;
   - copy copyBytes bytes from dst to dst + initializedBytes;
   - initializedBytes += copyBytes.
4. Leave the existing result-pointer return in place.

Use the canonical existing `Instr` variant `{ op: "memory.copy" }`. Push
**destination address, source address, byte count**, in that order. For seed:

```wasm
local.get $result
i32.const 12
i32.add
local.get 0
i32.const 12
i32.add
local.get $sourceLen
memory.copy
```

For each expansion, the three operands are respectively
`result + 12 + initializedBytes`, `result + 12`, and `copyBytes`.
`src/emit/binary.ts:1665` already encodes memory.copy with destination memory
0 and source memory 0. No opcode/encoder/import/feature wiring change is
needed. The allocator remains responsible for obtaining memory; copying
must not call malloc, grow memory or mutate the input record.

### Correctness argument

After the unchanged guards, positive L is an integer multiple of S. A count
of one already returned, so the copying path with L>0 has L>=2S.

The seed establishes: the initialized prefix contains complete repetitions
of the input bytes; initializedBytes=S, and 0<initializedBytes<=L. Each next
copy reads at most initializedBytes bytes from this established prefix and
writes at most L-initializedBytes bytes into the uninitialized suffix. It
never relies on memory.copy manufacturing repetitions from bytes that the
same operation has not initialized. Read/write ranges are disjoint or touch
at their boundary because copyBytes<=initializedBytes.

Both prefix size and remaining bytes are multiples of S, so the copied prefix
has the correct repetition phase. Progress is positive, bounded by L, and
either doubles the prefix or completes the shorter final remainder. For
S=3 and count=5: lengths progress 3 -> 6 -> 12 -> 15; the final copy is 3
bytes, not 12. Count=9 similarly progresses S -> 2S -> 4S -> 8S -> 9S.
Only bytes in `[dst,dst+L)` are written. Existing size/allocation checks bound
the record; initializedBytes+copyBytes never exceeds the checked L. Total
bytes copied remain L and memory remains O(L); only the explicit loop/copy
invocation count becomes logarithmic in the repeat count. This is not an
O(log L) total-time claim.

This preserves the existing UTF-8 byte payload exactly, including embedded
NUL and multibyte sequences; it introduces no decoding or wider Unicode claim.
The source/header remain immutable, and count-one retains pointer reuse.

### Architecture and semantic references

The shared `string.repeat` node, ASCII evidence, prepared identity and runtime
ABI already express the semantic operation. Only target-specific physical
copying changes, in the existing `codegen-linear` leaf. Reuse memory.copy;
do not introduce a general copying service, new umbrella module, duplicate
orchestration or another repeated-concat optimizer. Inlining, DCE and counted
loop recognition stay in their existing dedicated shared modules.

The primary [ECMAScript repeat algorithm](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.repeat)
applies integer-or-infinity count conversion, rejects invalid counts and
produces repeated string contents. This provider's existing native traps
remain its documented limitation instead of catchable JavaScript RangeError.
The primary [WebAssembly memory.copy semantics](https://webassembly.github.io/spec/core/exec/instructions.html#exec-memory-copy)
define bounded source/destination copying, including overlap behavior. The
algorithm above intentionally reads only an already initialized prefix.

## Regression and baseline proof

### Production IR ownership, receipts and execution

Adapt the source fixture in the existing counted-string reservation test,
with trip counts 0, 1, 2, 3, 5, 7, 8, 9, 31, 32, 33 and one larger bounded
case. Use ASCII fragments of byte lengths 1, 2, 3 and 17 in a bounded selection
covering powers of two and short final copies; do not require a full Cartesian
product of slow compiler invocations.

For each N>=2 positive, assert all of the following before crediting success:

- Exact `run` owner appears in `getLastLinearIrReport().compiled`, with no
  rejection/fallback for it; locate its actual function in `report.irModule`.
- Exactly one nested `string.repeat` node, ASCII evidence and
  `provider.binding = { kind: "intrinsic", symbol: IR_STRING_REPEAT_FN }`.
- Exactly one prepared counted-append receipt; syntax trip count matches N;
  receipt siteId equals plan.siteId and node.countedStringAppendSite; parsing
  it agrees with the receipt's ownerUnitId/sourceId.
- Valid binary, successful instantiation, zero unexpected imports, and full
  decoded output equality to `"seed" + fragment.repeat(N)` on execution.
  Length alone, a checksum alone, or WAT containing a helper name is insufficient.

For N=0/N=1 retain the existing receipt behavior and no reserved repeat helper.
Keep the existing non-ASCII counted-loop refusal and reservation-tampering
fail-closed tests as controls. Do not change shared admission to pass them.

### Provider boundaries and memory integrity

Reuse the reserved-provider construction pattern from
`tests/issue-3518-string-repeat-ir.test.ts:671`: real addRuntime, exact
reservation/authentication, real emitted module and memory. No mock provider
or copied baseline algorithm. Store source records below the allocator floor
with canonical +4 capacity/+8 length fields; reacquire DataView/Uint8Array
after a call that may grow memory.

Cover zero-result skip with a long nonempty source and counts NaN, +0, -0,
-0.75 and 0.75. Preserve count truncation (1.9, 2.9, 3.9), pointer reuse for
empty valid sources and count-one, and negative/-Infinity/+Infinity/oversized
pre-allocation traps, including invalid counts on an empty source. Compare
arena usage and memory size around rejected requests after fixture setup.
No catchable RangeError implementation is part of this work.

For valid providers compare every output byte and decoded string for ASCII,
embedded NUL, `é`, `A😀`, and mixed multibyte fragments; use odd counts 3/5/9
and non-power-of-two byte lengths. These are provider tests; semantic IR
non-ASCII admission must remain refused. Do not add malformed UTF-8/lone
surrogate support under this optimization.

Verify source header/payload bytes are unchanged. Poison the future result
payload and a guard region beyond its expected end before the call (using
the known isolated bump position), then assert complete output initialization
and untouched guard bytes. In particular the zero-size case must not seed-copy
sourceLen bytes beyond the empty allocation. Check +4 capacity, +8 length,
and allocation consumption against the unchanged aligned allocation formula.
Snapshot surrounding occupied records as additional overrun controls.

Keep provider identity/uniqueness, same-reservation reuse, borrowed receipt,
wrong source/preparation, wrong ABI and missing-provider controls from the
existing suites. New tests may add relevant controls but may not weaken or
edit those suites or authentication functions.

### Exact baseline/candidate comparison

Run the identical new semantic/provider fixtures first on exact e776, then
on the candidate differing only by the kernel plus the new test. Both must
pass semantic equality: this task improves performance, not failing semantics.
Record full revisions, source/test digests, Node/V8 version, flags, allocator,
case identities, totals and results. Compare exact output byte arrays/strings,
headers, allocation deltas, source/guard bytes, trap classification and
normalized owner/receipt associations. Do not expect binary equality: the
provider body/locals intentionally change. The shared IR/provider contract
and admitted owner population must remain equivalent.

Inspect the candidate provider body itself for memory.copy and removal of
the old per-output-byte remainder loop; do not search unrelated whole-module
instructions. This mechanism check is distinct from semantic equality and
must not make baseline functional tests fail merely for retaining the old loop.

Existing focused controls to run unchanged during implementation validation:
`tests/issue-3518-linear-counted-string-reservation.test.ts`,
`tests/issue-3518-string-repeat-ir.test.ts`, and
`tests/issue-3922-linear-string-repeat.test.ts`. Report actual pass/fail/skip
denominators and reasons; do not inherit earlier session results as fresh.

## Bounded performance instrument (test owner only)

Add an optional case in the same new test file, enabled only by
`JS2WASM_BENCH_LINEAR_REPEAT=1`. Default regressions remain deterministic;
no wall-clock threshold in ordinary CI. No new script, benchmark registry,
production switch or instrumented provider. Print structured measurements to
stdout for the parent to capture; benchmark mode must not allocate issues or
write shared artifacts.

Use the identical instrument bytes on baseline and candidate. Include the
production source-derived counted-loop route above, with two ASCII fragments
(`"xy"`, `"abc"`) and N=3, 9, 1024, 65537. Each measured artifact must pass
the full ownership/receipt/output checks first. A direct provider measurement
may be reported separately to isolate copying, never substituted for this
source-derived evidence.

Compile/instantiate outside timing, prewarm each instance with three bounded
batches, then collect seven timed batches per case. Cap each batch at 256
calls and at 1 MiB estimated total allocation, including both repeated output
and final seed concatenation plus record/alignment overhead; use the smaller
bound. Use existing exposed arena reset outside each timed batch, only after
all prior pointers are dead, and verify its literal-cache handling/heap usage
on the fixture. Do not depend on automatic reset for a string-returning export.
If that fixture cannot safely reset, use independently instantiated bounded
batches with setup outside timing; disclose the resulting warmup difference.

Cap the total instrument at 30 seconds; an exceeded cap is incomplete evidence,
not a passing empty result. No unbounded loops, automatic iteration tuning or
OOM runs. Consume results and validate full final output outside the timed
interval; retain scalar checksums across calls. Keep reset, decoding and
assertion timing excluded identically for both revisions. Record memory growth
and retained arena usage so allocation/lifetime drift cannot masquerade as a
copy-speed win.

Report every case's calls, output bytes, seven raw elapsed samples, median and
spread, and baseline/candidate ratio. Perform paired runs on the same machine
with matching Node/V8, flags and test selection; alternate baseline/candidate
order for a confirmation pair. Report short-output regressions as well as
large-output improvements. Do not assume a speedup from instruction count;
if timing is noisy or does not demonstrate benefit, report that and return
the performance decision to the parent without expanding scope.

## Acceptance

- [ ] Kernel diff is limited to the payload-copy region and associated locals.
- [ ] Guards, allocation/header prefix, ABI, registrations and receipts unchanged.
- [ ] Source-derived IR positives prove exact owner, site, provider and execution.
- [ ] Zero-size, short-tail, memory-integrity, provider edge and negative controls pass.
- [ ] Identical baseline/candidate semantics and allocation behavior recorded.
- [ ] Bounded paired performance measurements reported without fabricated gains.
- [ ] Only released kernel/test paths changed; parent handles integration/claims.

This document is a ready specification, not an implementation claim or a
report of completed tests or measured performance.

## Bulk-only checkpoint outcome

Initial candidate9544cc223f passes all54 new tests on both sides of two
ordered baseline/candidate pairs; all80 complete functional rows match.
Existing repeat controls pass25/25. Raw observations, all timed samples,
provenance and exact comparisons are retained in
`plan/log/6892-linear-repeat-20261007/` and the Session B repeat handoff.
Large-output improvements coexist with measured short-output slowdowns.
This checkpoint is not accepted for landing; a bounded specification
amendment and follow-up validation are underway. No case is dropped.

## Evidence-driven amendment — 2026-10-07

Integration note: parent has preserved all four raw logs as gzip plus a
comparison JSON under `plan/log/6892-linear-repeat-20261007` and appended the
bulk-only checkpoint to the integration issue. Append this amendment after
that checkpoint; do not replace or overwrite its evidence. Status remains
`in-progress`. Parent plans a ready PR with the existing hold label and no
merge queue, keeping the work reviewable but not landed with unresolved short
regressions. This amendment does not authorize publication, merge or claims
by the architect.

### Preserved bulk-only candidate evidence; not final acceptance

Baseline: `e7760d1c2af4636ede6a352154d193b234af5fc4`.
Bulk-only candidate: `9544cc223f46c58bfa4f9f8bb2c00ba3d78a1d9e`.
The architect read the existing logs; no tests or benchmarks were run while
authoring this amendment. All four logs report 54/54 tests passed and eight
completed performance cases. The parent additionally reports all 80 full
functional comparison rows EXACT equal; that comparison is parent evidence,
not a new independent equality execution by the architect. Passing semantics
does not erase the performance regressions below.

Common provenance: target/lane `linear`, harness
`tests/issue-6892-linear-repeat-bulk-copy.test.ts`, Node `v22.23.2`, V8
`12.4.254.21-node.56`, `JS2WASM_LINEAR_IR=1`,
`JS2WASM_IR_STRING_BUILDER=1`, `JS2WASM_BENCH_LINEAR_REPEAT=1`,
`optimize:false`, empty `NODE_OPTIONS`. Recorded `execArgv`:
`--max-old-space-size=1024 --expose-gc --conditions node --conditions development`.
Ordinary bump allocation; benchmark artifacts expose arena usage but never
reset. Each batch has a fresh instance sharing the case's compiled module;
three independent warmup batches precede seven fresh-instance samples.
Literal materialization and memory growth are timed. A separate correctness
execution precedes these batches. This is not proof that each sampled instance
or the shared compiled code has reached a stable optimizing tier.

Identical test SHA-256 across all four runs:
`1c81601b54034f178179e55ffeb232c39ad15916a6ed9423b2bddbfd8951812b`.
Baseline kernel SHA-256:
`c8df1de8944d12cd155a29f321fe4bd09f72cb3b36078ec8b828ce9de32dfcad`.
Bulk-only candidate kernel SHA-256:
`717d7180bbcac0435eadd79f92d2a0e414da9d270dbff50d76fc9f16968f10f7`.

Keep these original logs unchanged, including every sample, spread, warmup,
allocation observation, functional row and outcome. Do not overwrite them
with amended-candidate runs. Paths and SHA-256:

- `/private/tmp/js2-6892-linear-repeat-baseline-20261007/.tmp/6892-baseline-ab1.log`
  — `89ea79eb6f5c55c07bab2906e13e8a6fa21fb95265eb5bfedfeff02ff63a9977`.
- `/private/tmp/js2-6892-linear-repeat-bulk-copy-20261007/.tmp/6892-candidate-ab1.log`
  — `07d77166bb7a17df2f7057fd98d56fff765511864b81996ac950ec730fb4602b`.
- `/private/tmp/js2-6892-linear-repeat-bulk-copy-20261007/.tmp/6892-candidate-ba2.log`
  — `09dc25417ec38dae3d2e6956c31e17aa07389ef61301fb2f90139b2edbe56f4a`.
- `/private/tmp/js2-6892-linear-repeat-baseline-20261007/.tmp/6892-baseline-ba2.log`
  — `f13ccc9dc79c372878fbf8855e7b3c23b1483d07a4278f7a326a66f0277a3dbe`.

Recorded medians in milliseconds, each list ordered N=3,9,1024,65537
(decimal values below preserve the logged numbers):

```text
ab1 baseline xy:  0.05625000000145519, 0.03245800000149757, 0.9880420000044978, 0.9455830000006245
ab1 candidate xy: 0.028791000004275702, 0.09737500000483124, 0.6260000000038417, 0.307874999998603
ab1 baseline abc: 0.07316700000228593, 0.04199999999400461, 1.7445000000006985, 0.8743749999994179
ab1 candidate abc:0.030249999996158294, 0.04287499999918509, 0.49316600000020117, 0.36691600000631297
ba2 baseline xy:  0.021957999997539446, 0.03258300000015879, 1.8135000000038417, 1.8475840000028256
ba2 candidate xy: 0.07349999999860302, 0.10804199999984121, 1.3856660000019474, 0.6375840000036987
ba2 baseline abc: 0.02350000000296859, 0.04124999999476131, 0.929374999999709, 1.0066250000018044
ba2 candidate abc:0.08241699999780394, 0.10874999999941792, 0.9772919999959413, 0.24612500000512227
```

Calls per batch are respectively xy `[256,256,252,3]` and abc
`[256,256,168,2]`, identical across runs. Parent-supplied rounded
baseline/candidate median ratios (greater than 1 favors candidate), in the
same N order:

- ab1 xy: `[1.95, 0.333, 1.58, 3.07]`; abc: `[2.42, 0.98, 3.54, 2.38]`.
- ba2 xy: `[0.299, 0.302, 1.31, 2.90]`; abc: `[0.285, 0.379, 0.951, 4.09]`.

Both N=65537 cases improve in both pair orders. N=1024 abc is mixed, including
a measured regression in ba2. Short outputs have material measured slowdowns,
especially xy N=9 in both orders and all four short cases in ba2. Do not
aggregate these away or claim a universal win. Tiering is a possible
explanation, not established by these logs: there are no actual tier events
or controlled tier observations here. Therefore do not change warmup or
discard samples on that hypothesis. No previously recorded failed acceptance
or noisy measurement is withdrawn by this amendment.

### One bounded next candidate: bytewise through 64 payload bytes

Keep the same generic IR contract, production source-derived route and
target-local helper. K's only source scope remains
`src/codegen-linear/string-repeat.ts`, `addLinearStringRepeatRuntime` (entry
line 103; candidate copy region starts near line 222). Inside the existing
positive-result copy guard, dispatch on **resultLen <= 64 unsigned**:

1. If true, execute the original e776 bytewise remainder loop, unchanged in
   its byte-addressing/load/store semantics. Initialize local 6 to zero and
   use it as byte index `i`. For `i < resultLen`, store
   `load8_u(arg0 + 12 + (i % sourceLen))` to `result + 12 + i`, increment i,
   and repeat. Keep the loop's unsigned exit and block/loop branch depths.
2. Otherwise execute the reviewed bulk seed/doubling body exactly as in
   `9544cc223f46c58bfa4f9f8bb2c00ba3d78a1d9e`. Initialize the same local 6
   from sourceLen for this branch; local 7 remains its copyBytes scratch.
3. Both branches join at the single existing result-pointer return.

Emit dispatch operands `local.get resultLen; i32.const 64; i32.le_u` followed
by an empty-result `if`: true is bytewise, false is bulk. Threshold is **payload
bytes**, excluding the 12-byte record header and the downstream `seed`
concatenation. Zero results skip both branches using the existing outer guard
after allocation/header stores. There must be no seed copy before dispatch.
The unchanged guards guarantee sourceLen>0 whenever remainder is evaluated.

Preserve params 0/1 and locals 2-5 exactly. Reuse i32 local 6 for both mutually
exclusive progress counters; a neutral name such as `copiedBytes` is allowed.
Retain i32 local 7, with no additional locals. No duplicate semantic guards,
allocation, headers, signatures, registration, authentication or returns.
Keep related instruction construction inside this existing helper; no new
umbrella module, copying service, shared optimizer, import or index wiring.
The original bulk correctness argument remains unchanged for resultLen>64;
the tiny branch is the original bounded byte-copy algorithm. Neither branch
may write the source/header or bytes beyond the allocated payload.

64 is a fixed bounded experiment, **not a measured optimal crossover**. The
observed short payloads are 6,9,18,27 bytes; 64 places them on the baseline
algorithm while leaving every existing N=1024/65537 case on bulk copying.
The dispatch/code-size cost can still hurt timing; restoring the old loop
does not prove restoration of the old performance. Try this one threshold,
not an automatic sweep or successive tuning disguised as validation.

### Disjoint test follow-up and acceptance of the next candidate

T remains confined to `tests/issue-6892-linear-repeat-bulk-copy.test.ts`.
No existing tests or shared utilities may change. Preserve all original
semantic/provider cases, poison/zero-result controls, ownership/receipt and
fail-closed assertions. Add a bounded boundary group for payload lengths
63,64,65 using source-derived `"x"` counts 63,64,65; also provider `"abc"`
counts 21/22 (63/66 bytes) to cover a short final bulk copy, and `"é"` counts
32/33 (64/66 UTF-8 bytes) to pin byte rather than character dispatch. These
are functional checks, not extra timing cases. Use the same byte/header,
source immutability, guard poison and allocation assertions on both sides.

Update only the provider mechanism classification that currently admits
bulkCopies=2/remainders=0 or bulkCopies=0/remainders=1: retain those two named
historical forms and explicitly recognize the new hybrid form. Do not merely
allow any body with two memory.copy operations and one remainder. Inspect
the positive-result guard and nested resultLen/64/i32.le_u dispatch: its true
branch contains the baseline remainder byte loop and no memory.copy; its
false branch contains the two bulk copy sites and no remainder. Verify both
branches reuse local 6, with bulk scratch local 7 and unchanged prefix/return.
Unknown shapes remain failures. This replaces blanket removal of remainder
from the entire provider: it must now be absent only from the large branch.

Keep the **same eight timed cases**, calls/allocation limits, three warmup
batches, seven samples, fresh-instance lifecycle, source ownership proof and
30-second cap. Do not drop short cases, widen budgets, pre-grow only one side,
change flags, or add warmup to manufacture acceptance. Fresh-instance and
shared-module warmup limitations must remain disclosed. If later actual
tiering evidence warrants another instrument, that needs a separately
reviewed amendment and cannot replace these historical measurements.

Parent runs the identical amended test bytes on exact e776 and the newly
committed hybrid candidate, in forward and reverse paired order on the same
machine. Record the new full commit and source/test digests, actual test/row
denominators, all seven samples/spreads, medians, per-case ratios and exact
functional/ownership/allocation equality. Preserve old 54/54 and 80-row results
as historical, not expected denominators after adding boundary tests. Save
new logs under new names; do not relabel the bulk-only candidate as hybrid.

This is one finite K change plus one finite disjoint T change, followed by the
parent's paired validation. Acceptance requires no semantic/integrity drift,
continued measured large-case benefit, and explicit review of **every** short
and intermediate result against baseline and the preserved bulk-only evidence.
If meaningful short regressions remain or the new measurements are too noisy
to settle them, stop after this candidate and return the decision to the
parent. Do not declare speedup from operation counts, declare regressions
fixed merely because the old loop is present, or silently accept a tradeoff.

- [x] Hybrid dispatch, unchanged prefix and both branch mechanisms reviewed.
- [x] Boundary, zero-result poison and existing exact semantic controls pass.
- [x] Identical amended baseline/candidate test bytes and full rows compared.
- [x] Both pair orders reported without suppressing short/intermediate regressions.
- [ ] Parent explicitly accepts the measured tradeoff or requests a new bounded step.

## Hybrid validation checkpoint — 2026-10-07

Tested source commit: `f9800cadcb9c33f928ba9b8e96ad1a0abf1bcbc1`.
Exact original baseline remains `e7760d1c2af4636ede6a352154d193b234af5fc4`.
The amended test digest is
`b0bb3cf778df90f3bef641f923765260bfdcbc2fd168a26a85508aacd7079898` on
all four runs. Source/test reviewers found no concrete correctness blocker.
The three unchanged repeat-control files also pass25/25 on the hybrid source:
issue3518 reservation, issue3518 typed repeat and issue3922 native repeat.
Their full output is retained as `hybrid-existing-controls.log.gz`.
Parent ran baseline/candidate then candidate/baseline serially: each passes
61/61, with all eight timed cases complete and 67 instrument observations.
All 90 complete functional rows per run compare deeply equal, including bytes,
owners, receipts, exceptions and negative controls. All ten batch states per
timed case compare exactly after omitting only elapsed time: allocations,
retained arena bytes, checksums and memory growth are unchanged.

New evidence is `plan/log/6892-linear-repeat-20261007/hybrid-comparison.json`
and four `hybrid-*.log.gz` files. They retain all seven samples, spreads,
medians, provenance and raw observations. The original bulk-only JSON and
four logs remain intact; no failed acceptance or fixture is withdrawn.

Ratios below are baseline median / hybrid median, ordered N=3,9,1024,65537:

- Forward `xy`: 3.0135, 1.0039, 1.5473, 2.0851.
- Forward `abc`: 2.7896, 2.7640, 0.7840, 2.4764.
- Reverse `xy`: 1.0459, 1.0191, 2.2136, 6.3013.
- Reverse `abc`: 1.0102, 1.9656, 3.5643, 3.7978.

**Decision: bounded correctness/equality checks pass; performance acceptance
is unresolved. Keep PR6563's `hold` label.** No short-case median is slower
than its paired baseline here, but that is not a confidence bound or universal
speedup. Forward `abc` N=1024 is 27.5% slower; reverse is 3.56x faster.
Wide spreads and shared-machine conditions prevent settling that discrepancy.
Tiering is not established. Large N=65537 gains in both orders do not erase
the intermediate result. Do not enqueue, suppress samples, change warmup,
or sweep thresholds. A further controlled measurement step requires an Astra
amendment preserving this evidence and original instrument as historical.

Astra High independently reviewed all four logs and agrees with this
disposition: exact functional/batch equality is established within the bounded
suite, while the contradictory intermediate timing prevents final performance
acceptance. No new concrete source or instrument flaw was identified.

Canonical main was refreshed to `8ac2ef29a37cb8edc217b11604c29bb11ef76932`.
Its intervening changes do not touch this runtime leaf or the new test; this
experiment intentionally remains on the exact recorded e776 baseline, not an
unmeasured merge. Session A owns final integration and queue submission.
No shared compiler/API/registry/source-map file was edited, no source packet
was inferred from A's documentation publication, and no legacy path is retired.
