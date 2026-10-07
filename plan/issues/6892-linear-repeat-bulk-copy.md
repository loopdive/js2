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
