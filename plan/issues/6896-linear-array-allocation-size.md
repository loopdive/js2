---
id: 6896
title: "Linear array runtime: check allocation byte size and capacity doubling before malloc"
status: ready
created: 2026-10-07
updated: 2026-10-07
sprint: Backlog
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen-linear
language_feature: arrays
goal: correctness
related: [1977, 3501, 1804, 2956, 4540, 4557]
origin: "Session B parent-confirmed runtime allocation-size overflow and admitted normal source-IR control"
---

# Checked Linear array allocation size

## Baseline, evidence and ownership

Exact canonical baseline: `c0a314636dfcaa437df1468f922bf0d6b0c5bcae`.
Specification worktree `/private/tmp/js2-6896-linear-array-capacity-plan-20261007`,
branch `codex/6896-linear-array-capacity-plan-20261007`; only this issue file
is writable by the architect. Parent reports a fresh canonical issue allocation
with `pr_scan: ok` and effect-verified plan claim
`6896:linear-array-capacity-plan-20261007`, owner
`ttraenkler/codex-linear-b-array-capacity-astra-20261007`.

Parent-confirmed production runtime observations on the baseline:

- `__arr_new(0x20000000)` consumes 16 bytes but records capacity 536870912;
  its required mathematical size is **4294967312** bytes.
- `__arr_new(0x20000001)` consumes 24 bytes, again recording a capacity whose
  required byte size cannot fit u32.
- `__arr_new(-1)` records unsigned capacity 4294967295 and consumes 8 bytes,
  smaller than the 16-byte array header itself.
- `__arr_grow(old, 0x20000000)`, with valid old capacity 4 and length 1,
  consumes 16 bytes and records the huge capacity after relocation.
- Valid `__arr_new` controls: capacity 0 consumes 16 bytes; capacity 4
  consumes 48 bytes.

The parent's first probe had a **BigInt reporting/setup error**. Preserve its
raw failure separately: it is not an array-runtime trap or evidence of safe
overflow rejection. The corrected probe measured the rows above. Preserve
both probe versions, their exact input/options and raw logs; do not relabel
the first failure as a production improvement. The architect inspected source
only and performed no tests, heavy jobs, source edits, commits, pushes or claims.
No unreported pointer, trap message or test denominator is inferred here.

Parent's counted inventory covered 23 open PRs, with zero `runtime.ts` edits.
No active 1977/3501/4557 claim was found by the parent. Historical fixed-vector
frontend claims under 1804/2956 remain recorded; absence of published refs is
not abandonment or a transfer of ownership. Fresh sole K/T claims and exact
scope comparison are required before implementation release.

A retains all shared IR/frontend/emitter/integration/source-map work. Active
4540, "Heap coexistence in one linear memory: relocate the bump arena above
the engine's heap base, passive data segments only", retains `addRuntime`,
allocator and linked-chunk ownership. No transfer is implied by touching a
different region of `runtime.ts`. Any newly overlapping function-region claim
blocks dispatch until parent comparison, not a blanket runtime-file takeover.

## Reachability: proven normal source IR, separate overflow entry tests

The parent confirmed this exact source on baseline:

```ts
export function run(a:number,b:number):number {
  const values=[a,b];
  return values[0]+values[1]+values.length;
}
```

With `JS2WASM_LINEAR_IR=1`, report `compiled: ['run']`, `rejected: []`, result
at `(1.5,-2.25)` is **1.25**. Its canonical f64 layout is base 16, stride 8,
minimum capacity 16; planned arena allocation is **144 bytes**. This proves
normal production IR allocation consumption, not reachability of huge dynamic
capacities from source. `new Array(n)` is currently an unsupported constructor:
do not change that fixture or claim its admission, and do not credit manually
exported runtime functions as source-IR large-capacity proof.

Source anchors on the exact baseline:

- `src/ir/analysis/linear-memory-plan.ts:812`, `planLinearVectorLayout`, is the
  existing generic layout authority. Its f64 plan supplies the base/stride;
  `allocationSize` near line 974 accounts for the source minimum capacity.
- `src/ir/backend/linear-integration.ts:1904`, `f64VecHandle`, consumes that
  plan. `linearRuntimeFunctionName` near line 2199 maps arena/f64 vector
  allocation to `__arr_new` (line 2216); grow operations map to `__arr_set`.
  This wiring is read-only.
- `src/codegen-linear/runtime.ts:847`, `addArrayRuntime`, emits `__arr_new`
  near line 854: unchecked `i32` expression `16 + cap*8`, then malloc/header
  stores. The stored capacity is the unvalidated original parameter.
- `__arr_grow` near line 893 first doubles the old capacity using `i32.mul`,
  applies unsigned maximum with minCap and the existing floor 4, then uses
  the same unchecked allocation-size expression near line 942. Header writes,
  copy and old-header forwarding follow allocation.
- Runtime `findFuncIndex` near line 4225 selects defined helpers and adds
  function imports; do not alter that index/registration convention.

## Implementation Plan

### Finite disjoint slices

K owns only:

1. One new cohesive leaf `src/codegen-linear/runtime/array-allocation.ts`.
2. The import of that leaf in `src/codegen-linear/runtime.ts`, and within
   `addArrayRuntime`, only `__arr_new` allocation sizing and `__arr_grow`
   capacity selection/doubling/allocation sizing.

T owns only the new
`tests/issue-6896-linear-array-allocation-size.test.ts`.
Issue evidence remains parent/spec-owner controlled. Existing suites and
fixtures are preserved. No other helper, runtime builder, allocator, C ABI,
registry, compiler entrypoint or shared IR file is writable by K/T.

### Shared layout first; target-local checked arithmetic

The leaf should emit instruction fragments, not register another Wasm helper
or own an allocator. Reuse `planLinearVectorLayout(irVal({kind:'f64'}))` from
the existing shared plan/nodes modules, as the integration already does.
Read `elementsOffset` and `elementStride` from that plan. Do not create another
ABI constant authority or import frontend/compiler integration into the leaf.
The canonical plan presently gives base B=16 and stride S=8. Its
`minimumCapacity=16` is a source allocation policy, **not** permission to clamp
runtime `__arr_new(0)`/`__arr_new(4)` or replace the existing growth floor 4.

For wasm32 unsigned request sizes derive at code-generation time:

```text
U = 0xffffffff
C = floor((U - B) / S) = 536870909 = 0x1ffffffd
H = floor(C / 2)       = 268435454 = 0x0ffffffe
B + C*S               = 4294967288 = 0xfffffff8
```

JS Number arithmetic represents these derivations exactly; no runtime BigInt
reporting conversion is needed. Validate the selected layout shape/constants
when constructing the fragment if necessary; fail visibly on an incompatible
layout rather than silently assume another element stride. This is a target
wasm32 byte-request bound, not the allocator's maximum successful allocation.

Keep the leaf narrow: a shared capacity-bound guard and a checked-size fragment
plus a checked-doubling fragment, or an equivalently small cohesive interface.
Suggested contracts (names may be adjusted within this leaf):

- `checkedArrayAllocationSize(capacityLocal): Instr[]`: empty input stack,
  leaves one i32 byte request on success; unsigned overflow traps first.
- `checkedArrayCapacityDoubling(capacityLocal): Instr[]`: reads and updates
  the existing capacity scratch local, empty stack in/out; traps before an
  unsafe doubled result is computed. Reuse the leaf's private guard emitter.

No generic arithmetic framework, umbrella runtime extraction, duplicated
forwarding algorithm or separate semantic/ABI authority. Do not register new
function types, imports or globals for these pure TypeScript emitters.

### __arr_new: checked request before malloc

Replace only its existing `16 + cap*8` instruction fragment. Interpret the
i32 capacity as u32, matching the existing stored-capacity contract. Emit:

```wasm
local.get $cap
i32.const C
i32.gt_u
if
  unreachable
end
i32.const B
local.get $cap
i32.const S
i32.mul
i32.add
;; existing call $__malloc, local.set pointer, header writes and return
```

Since cap<=C, neither product nor sum wraps. Negative signed inputs including
-1 have large unsigned representations and are rejected by this same guard;
do not introduce an unrelated JS constructor count-conversion policy.
Preserve param/local indexes, signature, tag, length=0, stored capacity,
malloc call and returned pointer. No new local is needed.

### __arr_grow: reject before doubling can destroy evidence

Retain the resolved-header precondition and existing locals
`lenLocal`, `newCapLocal`, `newPtrLocal`, `iLocal` (four i32 locals).
Loading old length before the checks is harmless; no header or allocator
mutation may precede rejection.

1. Load the old capacity field into `newCapLocal`.
2. Before multiplying, trap if `newCapLocal > H` using unsigned comparison.
   Then multiply by 2 and write `newCapLocal`. This bounds both the doubling
   and its eventual byte product, including when an earlier wrapped double
   would otherwise appear small. Do not multiply first and check afterward.
3. Keep the existing unsigned max with minCap and existing floor 4.
4. Use the **same** checked allocation-size fragment on `newCapLocal` before
   the unchanged malloc call. This catches an oversized minCap even when old
   capacity was valid, including signed -1 treated as u32.
5. Leave all new-header stores, slot-copy instructions/order, old-header
   forwarding and return untouched.

Policy remains `max(2*oldCap, minCap, 4)` for representable requests. If that
policy's mathematical doubled capacity cannot fit the byte bound, trap; do
not saturate, clamp to minCap, switch growth strategy or silently shrink.
For example oldCap=H+1 has a representable old record size but doubled bytes
would be exactly 2^32; it must reject even though doubling itself fits i32.
An oldCap high bit can wrap the initial i32 doubling to zero; it too must
reject before multiplication. Tests using such fabricated large old headers
are arithmetic unit probes, not evidence of naturally allocated huge arrays.

Rejected requests throw an ordinary Wasm `unreachable` trap before malloc,
header writes, copies or forwarding. No catchable JS RangeError contract is
introduced. Successful small allocations keep their existing behavior.

## Limits: allocator work explicitly excluded

This contract guarantees only exact u32 **requested byte size** and safe
capacity selection, with rejected requests having no allocation side effects.
It does not establish `heapPointer + requestSize`, alignment-endpoint safety,
memory-growth success, zero/null/OOM return handling, linked chunk sizing,
rollback after allocator failure, or a physical memory capacity promise.
`addRuntime` still owns those operations. The 4540 allocator work remains a
separate blocked/dependent obligation; do not close it or claim full allocation
safety here. In particular C's byte size fits u32 but must never be passed to
the real allocator by these boundary tests. No memory maximum increase or
multi-gigabyte allocations are authorized.

## T regression and baseline proof

### Real production runtime, small wrapped requests only

Build a fresh module with real `addRuntime` and `addArrayRuntime`; expose
existing `__arr_new`, `__arr_grow`, `__arr_set`, `__arr_resolve`, arena usage
and heap pointer for test observation. Do not modify their bodies in this
group. Validate and instantiate the actual binary. Set up records/sentinels
before taking snapshots; reacquire DataView after calls that can grow memory.

- Reproduce the parent's `__arr_new` inputs `0x20000000`, `0x20000001`, -1.
  These old wrapped requests are small (16/24/8); do not dereference the huge
  advertised capacity or construct a huge payload view. Record actual trap
  class, heap/usage delta, memory size and bounded/full small-memory snapshots.
  Candidate must trap with heap, usage, memory size and all bytes unchanged.
  Baseline is expected to violate this assertion; record its actual outcome.
- Reproduce `__arr_grow` with a real cap4,len1 source and minCap0x20000000.
  Initialize one fractional slot. Require candidate rejection before malloc
  or mutation: original header/payload, forwarding tag/pointer, neighbors,
  memory bytes and allocation state all unchanged. The baseline's wrapped
  allocation/copy may affect its small neighboring region; use a fresh instance
  and bounded snapshot, and never interpret its huge capacity as readable.
- Valid new cap0/cap4 controls retain allocation deltas16/48, stored capacities,
  tag and length. Add ordinary small growth controls exercising the floor4,
  doubling and minCap-dominant paths (e.g. cap0/min1 ->4, cap4/min5 ->8,
  cap4/min12 ->12), with valid lengths and fractional payloads. Check copied
  values, new length/capacity, genuine forwarding resolution and expected
  aligned allocation deltas. Confirm source payload is preserved and only
  the old forwarding header changes, not a separate sentinel record.

### Non-allocating arithmetic boundary observer — UNIT ONLY

Exercise the real emitted array-helper bodies but substitute the module-local
`__malloc` body in this **separate test fixture** with a call to a declared
host observer that records the u32 request and throws a unique sentinel Error
before returning. Install imports before runtime construction and preserve
the original malloc signature/index; do not edit production allocator code.
Assert caught error identity, not just "some throw": reaching the observer is
different from an earlier Wasm overflow trap. No host allocation, memory grow,
header write or copy can follow its throw. Label every such row
`unit-nonallocating-observer`, not production allocation or source-IR proof.

Use bounded manually initialized old records only for growth arithmetic unit
cases; their huge capacity metadata is synthetic. They must not be used to
claim valid giant runtime allocations. Check all state remains unchanged and
observer call count is zero for rejected cases, exactly one with exact unsigned
size for accepted arithmetic cases. Use `arg >>> 0` for logged i32 byte counts;
serialize any independently computed BigInt oracle as decimal strings.

Finite boundary matrix:

- New cap C-1 and C reach observer with exact B+cap*S; C+1 must trap before
  observer (this catches addition overflow separately from product overflow).
- New cap0x20000000, cap0x20000001 and u32(-1) reject before observer.
- Grow oldCap4/minCap C reaches observer at B+C*S; minCap C+1 rejects.
- Grow oldCap H/minCap0 reaches observer at B+(2*H)*S; oldCap H+1/minCap0
  rejects. Also oldCap0x80000000/minCap4 rejects before its double can wrap.

For accepted observer cases on baseline, the sentinel prevents any dangerous
real allocation; for rejected boundary cases baseline may reach the observer
with a wrapped size, which is the failure evidence. Do not import the new leaf
from the test: the identical test file must execute on the untouched baseline.
Construct through `addArrayRuntime` so both runtime call sites are exercised.

### Actual source-IR normal control — mandatory and separate

Preserve the exact source and inputs recorded above, with IR enabled. Require
real compilation, valid binary, `run` compiled and no rejection/fallback for
that owner, actual nested vector allocation and its canonical f64 plan/site,
arena allocation144 and mapping to the defined `__arr_new` in the emitted
module. Follow existing `tests/issue-2956.test.ts` report/owner patterns; use
actual report fields, not a forged plan. Execute and require result1.25. If
measuring arena usage, use the existing exposed-usage allocator option and
record that configuration explicitly; do not instrument production source.
Retain a nonzero input-dependent result so folding cannot replace the route.

This passing case proves preserved normal IR consumption only. No large-cap
source constructor or frontend/emitter change is released. Unsupported dynamic
constructor and any unrelated scalar growth/read failures remain separate
A-owned obligations; do not turn them green by changing fixtures or claims.

### Exact comparison and non-vacuity

Parent runs identical new test bytes on exact baseline and a frozen recorded
candidate, sequentially. Keep all previous original probes, including reporting
errors. Record full revisions, source/helper/test digests (helper absent on
baseline is explicit), Node/V8, flags, lane, harness, actual case identities,
results/traps, observer invocations/unsigned sizes, memory/heap state and route
ownership. Separate real-runtime, observer-unit and source-IR rows. Report
actual pass/fail/skip denominators; baseline overflow failures are expected
evidence, not omitted controls. Never run accepted near-u32 bounds against the
real allocator to improve coverage numbers.

Inspect that both allocation sites consume the same checked-size fragment and
doubling rejection occurs before arithmetic/malloc. Compare unchanged runtime
function bodies/registration order outside the released fragments against the
exact base; no imported helper shadowing or new index shifts. Existing growth,
fractional-array and normal IR suites remain unchanged; parent selects/runs
them and retains any pre-existing/A-owned failures instead of claiming closure.
Do not execute unrelated linked-heap stress or allocator tests under this slice.

## Acceptance and handoff

- [ ] Exact parent overflow rows retained; initial BigInt reporting error classified.
- [ ] Both byte-size sites reject before malloc; growth doubles only after a bound check.
- [ ] Real rejected calls preserve heap, usage, memory, headers and neighbors.
- [ ] Small valid capacity/growth semantics, copy and forwarding are preserved.
- [ ] Nonallocating units prove exact boundary and pre-double behavior without large allocations.
- [ ] Normal source-IR owner/layout/allocation and result1.25 preserved with actual evidence.
- [ ] Only K's two regions/import/new leaf and T's new file differ; fresh sole claims verified.
- [ ] Allocator endpoint/OOM/linked-chunk and unsupported source-capacity obligations remain explicit.

Ready finite specification, not implementation/test completion or a claim to
4540/A work. Parent owns coordination, evidence publication and final
integration. Any need to change shared layout or allocator authority requires
a new scope comparison; stop rather than broadening this leaf fix.
