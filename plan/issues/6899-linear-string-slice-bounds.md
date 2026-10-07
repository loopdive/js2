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
