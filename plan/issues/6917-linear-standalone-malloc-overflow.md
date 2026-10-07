---
id: 6917
status: blocked
title: Prevent unsigned overflow and failed-growth publication in Linear standalone malloc
related: [6891, 4540]
---

# Issue 6917: Linear standalone malloc overflow and failure atomicity

## Planning custody and status

Source baseline: `8452732f0b88c14c5c7634ece58f83240970ea4c`.
Planning worktree: `/private/tmp/js2-6917-linear-malloc-plan-20261008`.
Planning branch: `codex/6917-linear-malloc-plan-20261008`.

The parent confirmed atomic reservation of 6917 under
`ttraenkler/codex-linear-b-malloc-plan-20261008` and effect-verified the exact
upstream planning slice `6917:linear-malloc-astra-plan-20261008`, owned by
`ttraenkler/codex-linear-b-malloc-astra-20261008`, against
`upstream/issue-assignments`. The only released write is this new Markdown
file. Parent retains review, integration, and publication.

This is a specification, not a source claim, implementation authorization,
test execution report, or GitHub issue creation. No tests were executed in
preparing it. Arithmetic outcomes below are source-derived predictions to
verify on real emitted Wasm, not invented observed test counts.

Production remains **BLOCKED** on an explicit partition from the held owner
of issue4540, "Heap coexistence in one linear memory: relocate the bump arena
above the engine's heap base, passive data segments only":
`ttraenkler/claude-opus`, branch
`claude/linear-memory-quickjs-backend-gkhszu`. Its broad `addRuntime` scope
overlaps this proposal. Neither the existing linked/standalone code split
nor absence from another owner's shared paths is a release.

Issue6891, "Prevent unsigned wraparound in Linear stack-arena admission",
explicitly excluded ordinary `__malloc`. This new issue preserves that
historical scope and evidence; it does not retrospectively declare the
ordinary allocator fixed by the stack-arena work. Two existing6891 tests
also require a separate explicit release before composition can land.

## Exact ownership requests and phases

### Production partition: RELEASE REQUIRED

Request only `src/codegen-linear/runtime.ts::addRuntime`, with line numbers
relative to the pinned baseline:

- The standalone `__malloc` prologue, lines246–285.
- Its algorithm/failure comments, lines227–245, and mode-local registration
  comments around lines333–335.
- Standalone-only scratch-local index declarations alongside lines239–241
  and conditional registration in the existing `__malloc` locals list,
  lines330–335.

Preserve the linked-selection expression and `linkedMallocPrologue` call,
lines288–299. Preserve the shared publication, conditional header clearing,
and return instructions, lines300–324. Preserve the function type, function
registration order, existing global layout, and helper name/ABI. No other
`addRuntime` options, memory declarations, mode checks, or initialization
are released. Scratch locals must not change any linked/chunked frame.

No edits to `linked-arena.ts`, `heap-allocator.ts`, stack-arena source,
finalization/reset helpers, other runtime functions, semantic IR, planner,
compiler entrypoints, any index, integration, registry, emitter, source-map,
hooks, workflows, metadata, fixtures, or error/legacy protections.

### Independent new-file test phase: CONDITIONAL, separately claimed

Parent may authorize a finite baseline regression phase after checking
current overlaps and effect-verifying a fresh exact test-only claim for:

`tests/issue-6917-linear-malloc-overflow.test.ts`

That phase owns only the new independent file, including its fixture
construction, observation helpers, and assertions. This planning claim does
not grant it. The source tree must remain frozen at the recorded baseline;
no runtime patch, existing6891 test edit, shared test-helper edit, or source
fixture change is allowed. Archive runs only in a parent-approved,
worktree-local evidence location, not a shared scratch directory.

Correct-contract regressions are expected to fail against the broken
baseline. Capture those failures without converting them to skips, expected
failures, permissive assertions, or a green baseline. Baseline-only work is
useful evidence, not a merge-ready/default-CI pass or completed production
fix. Parent decides test execution and eventual publication. A later
released candidate must run the identical frozen new regression file.

### Existing test composition: RELEASE REQUIRED

Separately request only these two test callbacks and directly associated
limitation comments in
`tests/issue-6891-linear-stack-arena-overflow.test.ts`, lines144–163:

- `delegates first-add overflow without rewinding into live stack storage`
- `delegates padding-only overflow without installing pointer zero`

Both currently expect a huge request delegated to real `__malloc` to return
`END`. Once this issue makes the allocator fail safely, those expectations
must become native Wasm trap expectations while retaining stack-state and
subsequent-allocation assertions. Do not edit them during the independent
test-only phase. Do not delete, skip, weaken, or silently exclude them to
make a candidate green. Controlled-allocator result/argument/exception tests
remain unchanged. If this narrow release is unavailable, production
composition stays blocked even if the new independent tests are ready.

## Root cause and architecture

`addRuntime` emits an i32 bump allocator. It calculates
`next = (ret + size + 7) & -8` before comparing the result unsigned with
resident memory bytes. An unsigned comparison cannot recover the carries
already lost by either addition. Growth arithmetic also converts pages to
i32 byte counts and rounds a byte delta with an unchecked addition.

The baseline discards the `memory.grow` result and publishes `next` before
its header store. The comment at lines235–238 claiming a failed grow is
followed by a clean trapping store is false: the four-byte store at `ret`
can fit while the requested allocation does not. Even when the store traps,
the heap pointer was already changed.

Keep generic allocation policy and symbolic operations unchanged.
`src/ir/backend/linear-integration.ts::linearRuntimeFunctionName` already
maps memory/allocate with allocation class `arena` to `__malloc` at
line2222. Demand collection and resolution already use that mapping. This
is an existing target binding, not evidence that arbitrary huge sizes are
admitted from TypeScript source.

Wasm32 endpoint arithmetic and growth failure handling belong in the
existing Linear physical runtime module. Use its existing allocator once;
do not add a parallel allocator, generic arithmetic framework, new lowering
driver, or extraction-only module. No new admission, routing, or shared
wiring is necessary. Direct runtime exports in tests prove the helper's
contract, not a newly demonstrated source-level huge-allocation program.

## Implementation Plan

### Mode boundary

Apply only to the effective `linked === undefined` branch in `addRuntime`.
This is narrower than "module defines its own memory": `malloc-v1` installs
an allocator and sets the effective `linked` value even on self-owned
memory. Both host-linked chunks and `malloc-v1` must retain their existing
prologue, locals, ownership, and failure behavior.

### Checked endpoint and page arithmetic

All comparisons and shifts below are unsigned. Keep the existing size i32
parameter and pointer i32 result; interpret their bits as unsigned sizes
and addresses. The pseudocode specifies emitted Wasm, not a JS allocator:

```text
ret = heap_ptr
if size > UINT32_MAX - ret: unreachable
next = ret + size
if next > 0xfffffff8: unreachable
next = (next + 7) & 0xfffffff8

requiredPages = (next >>> 16) + ((next & 65535) != 0)
currentPages = memory.size
if requiredPages > currentPages:
    if memory.grow(requiredPages - currentPages) == -1: unreachable

continue the existing shared publication/header/return instructions
```

Emit the first bound with `i32.const -1`, `i32.sub`, and `i32.gt_u` in the
correct operand order. Use `i32.const -8` for the unsigned alignment limit,
`i32.gt_u` for its guard, then the existing add7/and-8 alignment. The page
calculation uses `i32.shr_u`, a low16-bit mask, an explicit nonzero result
of 0 or1, and `i32.add`. Capture `memory.size` once. Compare page counts with
`i32.gt_u`; subtract only inside that branch. Compare the actual
`memory.grow` return to i32 `-1` and trap with `unreachable` on equality.
Do not discard the grow result without checking it.

Keep `ret` at local1 and `next` at local2. Add standalone-only i32 scratch
locals for `requiredPages` and `currentPages`, at indices3 and4. The existing
linked `local_chunk` remains index3 in its mutually exclusive function
variant. Register the new locals only when effective `linked` is undefined;
do not append them to the linked variant. No new type/import/global/export
or function registration is needed in production.

Trap on unrepresentable endpoint or failed growth; do not return zero,
clamp, retry with a smaller size, or invent a JS exception type/message.
Preserve size>=4 header zeroing, size0 behavior at valid aligned pointers,
and successful allocation return values. This intentionally replaces unsafe
success or late trapping with failure before publication.

### Boundary and atomicity proof

1. `UINT32_MAX - ret` is representable for every unsigned i32 `ret`.
   Passing the first guard proves `ret + size` does not wrap.
2. Passing the second guard proves adding7 does not wrap. Alignment cannot
   move the endpoint below the unaligned sum. The largest representable
   aligned endpoint is `0xfffffff8`.
3. A one-past endpoint of `2^32` is rejected even if memory has65536 pages:
   the existing i32 heap global cannot represent that endpoint. This does
   not introduce a smaller signed-address limit.
4. For a valid aligned endpoint, page quotient is at most65535 and the
   remainder contribution at most1. `requiredPages` is therefore at
   most65536 and cannot wrap. No resident byte multiplication and no
   `delta + 65535` ceiling addition are needed. This covers zero-page and
   full wasm32 page counts without assuming the default maximum256 pages.
5. The growth delta is nonnegative and representable after the unsigned
   page comparison. Failed Wasm growth leaves memory size unchanged;
   failure is detected before any allocator store or heap publication.
6. Successful growth, or sufficient existing pages, establishes space for
   the entire requested region. For size>=4 the unchanged header store
   fits. Size0 does not store, including at an exact resident boundary.

This is allocator-local failure atomicity under the existing valid heap
state contract, not a transaction around a caller's earlier allocations.
It does not cover externally corrupted pointers or concurrent allocator
access, and does not require rolling back successful memory growth.

## Finite regression and control design

### Genuine emitted subject and observations

Follow `tests/linear-runtime.test.ts`: `createEmptyModule`, production
`addRuntime`, test-only exports, `emitBinary`, validation, and native
`WebAssembly.instantiate`. Resolve `__malloc` and `__heap_ptr` by name with
the correct imported-function/global offsets. Do not copy the allocator
into JS, patch the emitted body, intercept growth with a fake allocator,
or construct unsupported semantic IR to manufacture a source route.

Use fresh instances for independent destructive-size cases. Default heap
floor is1024. Test memory limits are explicit module configuration, not a
changed production default. The small caps below force deterministic
failure without allocating gigabytes. For the zero-page controls, supply
a memory declaration before `addRuntime` and export that real memory;
the runtime supports a pre-existing declaration. Do not forge heap globals.

For each invocation record input i32 bits, return or trap, pointer before
and after, page counts, and full before/after resident memory bytes.
Seed a nonzero canary at the would-be header where memory exists, plus live
allocation canaries. This proves failure does not silently zero a header.
Use soft assertions or an equivalent observation-first arrangement so an
unexpected baseline success/trap cannot hide the post-call state. Reacquire
views after growth. Do not dereference a returned huge allocation.

### Counterexamples and upper-bound controls

Each baseline outcome here is source-derived and must be recorded rather
than assumed during the later authorized run:

- **First-add wrap:** ret1024, size `0xffffff00`. Baseline endpoint768;
  it publishes768 and returns1024. Candidate must trap with original pointer,
  page count, and every resident byte unchanged.
- **Alignment-only wrap:** ret1024, size `0xfffffbff`. The unaligned sum is
  `0xffffffff`; padding wraps and aligned endpoint becomes0. Candidate
  must trap before header clearing or publication.
- **Failed grow with an in-bounds header:** min1/max1, ret1024,
  size64513. Required endpoint65544; baseline ignores grow failure,
  publishes65544, clears the header, and returns1024. Candidate traps with
  all state unchanged. This directly falsifies the old explanatory comment.
- **Largest representable aligned endpoint:** min1/max1, ret1024,
  size `0xfffffbf8`, endpoint `0xfffffff8`. Endpoint arithmetic is legal;
  required pages are65536 and growth must fail safely under the tiny cap.
  Baseline ignores the failure and publishes the huge pointer.
- **One byte above that limit:** ret1024, size `0xfffffbf9`. First addition
  does not wrap; alignment would. Candidate must reject it atomically.
- **Huge unsigned bit patterns:** fresh capped instances for
  `0x7fffffff`, `0x80000000`, `0xfffffff0`, and `0xffffffff`. Each must
  fail without publication or memory writes. Record the exact original
  i32 bits, including signed host spellings. These are safety controls,
  not proof that large allocations succeeded or hit a particular guard.
- **Zero-page ceiling overflow:** min0/max0, ret1024,
  size `0xfffffbf8`. Baseline computes the large aligned endpoint, wraps
  the ceiling addition, requests zero growth, publishes `0xfffffff8`,
  then traps on the header store. Candidate traps with pointer1024 and
  zero pages unchanged. A trap alone is not a passing assertion.

For resident-memory failures with remaining small capacity, follow a caught
failure with a small legal allocation in the candidate and verify exact
pointer progression and preserved live bytes. Do not require recovery by
allocation in the intentionally max0 fixture.

### Positive controls

- Fresh default instances for sizes0,1,3,4,7,8,9. Expect return1024 and
  endpoints1024,1032,1032,1032,1032,1032,1040 respectively. Check header
  bytes remain unchanged for sizes below4 and exactly the first four bytes
  are cleared for sizes at least4; preserve surrounding canaries.
- With min1/max2, allocate64512 from1024: endpoint65536 and one page.
  Then allocate0: return65536, unchanged pointer/page count/full memory.
  Then allocate1: return65536, endpoint65544 and two pages. Verify old live
  bytes survived growth and the size1 path did not introduce header writes.
- With min0/max1 and initial pointer1024, allocate8: grow to one page,
  return1024, publish1032, and retain the normal header contract. This
  pairs the zero-page negative with a genuinely working construction.
- Preserve successful repeated small allocations, alignment and non-overlap,
  with canaries covering prior allocations.

Verify the page arithmetic against the actual emitted instruction sequence
and the proof above. Tiny capped-memory failures do not independently prove
the exact requested page delta. Do not claim a65536-page resident-memory
execution from them, require a4GiB allocation, or substitute a JS clone as
the tested subject. The default256-page configuration does not itself reach
the `memory.size * 65536` full-address-space wrap; retain that distinction.

## Preservation, custody, and acceptance gates

- Before any dispatch, parent verifies current ownership/overlaps and grants
  the exact phase slice. A planning release is not a source or test release.
- Freeze the new test file and baseline source before execution. Preserve
  original source/test hashes, emitted binaries, raw stdout/stderr, exit
  status, command, effective relevant flags, runtime version, complete
  observations, and actual population/results. No default-CI success is
  inferred from an explicit local qualification run.
- Keep baseline failures and all earlier6891 evidence under their original
  epochs. Candidate evidence must identify its own source and unchanged new
  test hash. Do not overwrite logs or relabel historical failures as passes.
- After source release, all new correct-contract assertions must pass with
  full failure-state preservation, not merely valid Wasm or an exception.
- After separate existing-test release, update only the two named6891
  callbacks to the safe failure contract. Preserve their population and
  stack invariants, and preserve all controlled-fallback tests unchanged.
- Parent runs unchanged relevant controls from `tests/linear-runtime.test.ts`,
  `tests/issue-4540-heap-coexistence.test.ts`, and
  `tests/issue-4557-own-allocator.test.ts`, plus the existing6891 suite with
  only its explicitly released expectation amendment. Retain existing
  allocation-policy qualification where applicable; no shared wiring edit.
- Compare linked/chunked `__malloc` bodies and local layouts between source
  epochs. Preserve host-linked no-`memory.grow`, chunk acquisition, function
  indices, global layout, header behavior, reset refusals, and malloc-v1
  behavior. Existing optional controls must not be misreported as executed.
- Production stays blocked until both source ownership and existing-test
  composition are released and verified. Test-only readiness is not final
  correctness acceptance, ordinary CI qualification, or permission to land.

## Explicit non-goals

No caller-side size-multiplication audit, frontend admission expansion,
linked allocator overflow fix, heap finalization/reset rewrite, universal
OOM policy, memory64 migration, generic callback/security framework,
performance implementation or speed claim. No registry/hook/workflow bypass,
fixture alteration, legacy retirement, or weakening of existing protections.
If another failure needs such work, retain it as a separately scoped finding
and request authority rather than widening this partition silently.

## Parent release of independent baseline tests — 2026-10-08

The fresh pre-dispatch gate stopped solely on root6917 held by the parent
reservation owner above; no implementation conflict was thereby cleared.
Parent resolved that own-reservation blocker for ONLY the new file, then
effect-verified upstream slice `6917:linear-malloc-baseline-tests-20261008`,
owner `ttraenkler/codex-linear-b-malloc-tests-sol61-20261008`, branch
`codex/6917-linear-malloc-tests-20261008`. Isolated worker starts at
fbfe7d2462 (unchanged canonical845 production). Sol6.1 Medium owns only
`tests/issue-6917-linear-malloc-overflow.test.ts`; parent controls all heavy
qualification, commits and publication. Implementation is pending, not passing.
Production4540 and the two existing6891 test callbacks remain RELEASE REQUIRED.
No source ownership is inferred from the planning reservation or this phase.
