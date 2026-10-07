# Issue 6891: Prevent unsigned wraparound in Linear stack-arena admission

## Scope and planning custody

Planning baseline: canonical `e7760d1c2af4636ede6a352154d193b234af5fc4`.
Planning branch: `codex/6891-linear-runtime-spec-20261007`.
The parent confirmed reservation and the exact upstream planning claim
`6891:linear-runtime-plan-20261007`, owned by
`ttraenkler/codex-linear-b-runtime-astra-20261007`.
This document is the only released planning write. It does not create an
implementation claim or authorize shared-source work.

Proposed implementation ownership, for the parent to release separately:

- `src/codegen-linear/runtime-stack-arena.ts`: within
  `addLinearStackArenaRuntime` (line 10), only the emitted
  `__linear_stack_alloc` locals and body (lines 63–95).
- New `tests/issue-6891-linear-stack-arena-overflow.test.ts`: all fixture
  construction and regression assertions for this issue, kept in this file.

Do not modify helper signatures, globals, registration order, mark/restore,
`findFuncIndex`, other runtime allocators, existing tests or fixtures, semantic
IR, planner, compiler entrypoints, any index, registry, shared integration,
source-map files, metadata, or legacy protections. Session A owns shared
integration/compiler/source-map work; issue6888 belongs to the separate
emitter plan. Neither ownership transfers to this issue.

## Problem and eligibility

The stack adapter admits a request after computing an aligned endpoint with
wrapping i32 additions. A huge unsigned request can produce a small endpoint,
pass the capacity comparison, and rewind the stack pointer into live storage
or below the reserved block. This is an independent target-runtime defect;
the existing symbolic allocation operations and bindings already suffice.

This plan specifies an executable helper-level regression on actual emitted
Wasm. It does not assert that ordinary source compilation currently exposes
every huge request: the analysis policy normally promotes fixed-size sites.
No tests were executed during assessment or planning.

## Implementation Plan

### Root cause

At `runtime-stack-arena.ts:71–83`, both `ptr + size + 7` and
`base + LINEAR_STACK_ARENA_BYTES` are calculated in i32 before the unsigned
comparison. Unsigned comparison cannot recover overflow already discarded
by those additions; alignment can wrap independently of `ptr + size`.

### Architecture and existing patterns

Keep target-neutral allocation policy and symbolic mark/allocate/restore
operations in the existing generic IR/planner. Keep Wasm32 endpoint
arithmetic in this existing Linear runtime module. Do not add a second
lowering driver, allocator algorithm, shared arithmetic API, or new module
for this one bounded operation. Reuse the existing fallback branch exactly
once; the underlying allocator remains responsible for its own result or
failure. The existing module already groups the three stack-region helpers
by responsibility.

Read-only wiring dependencies at the baseline:

- `src/ir/analysis/linear-memory-plan.ts:68` supplies the 64 KiB capacity.
- `src/codegen-linear/index.ts:221` installs this adapter when the selected
  policy is `analysis-stack-arena-v1`.
- `src/ir/backend/linear-integration.ts:2200`,
  `linearRuntimeFunctionName`, maps stack allocation to this helper;
  `resolveLinearRuntimeOperation` at approximately line 2257 resolves its
  imported-function-adjusted index. Existing frame operations provide
  mark/restore custody.
- `src/codegen-linear/runtime.ts`, `addRuntime` at approximately line 129,
  supplies the existing `__malloc`; use its already-resolved `mallocIdx`.
- `src/emit/binary.ts` already emits `i64.gt_u`, `i64.and`,
  `i64.extend_i32_u`, and `i32.wrap_i64`. No emitter support is required.

The public helper remains `(i32) -> i32`. Widening is internal arithmetic,
not a memory64 ABI change or a change to generic allocation semantics.

### Exact change

In the emitted allocation function, retain parameter 0 (`size`) and local 1
(`ret`, i32). Change local 2 (`next`) to i64. Capture the original pointer,
zero-extend both pointer and size, then compute the aligned endpoint in i64.
Zero-extension is required: negative JS numbers passed to an i32 export
represent large unsigned request bit patterns here.

Reject stack admission if either the widened endpoint exceeds the widened
capacity endpoint or it cannot be represented as an i32 pointer. Combine
the two comparison results with `i32.or`, then reuse the existing fallback
`if` and return. Only the successful branch narrows and writes the pointer.

```wasm
;; Parameter 0: size:i32; locals 1: ret:i32, 2: next:i64.
global.get $stack_ptr
local.tee 1
i64.extend_i32_u
local.get 0
i64.extend_i32_u
i64.add
i64.const 7
i64.add
i64.const -8
i64.and
local.tee 2
global.get $stack_base
i64.extend_i32_u
i64.const 65536                 ;; use LINEAR_STACK_ARENA_BYTES in TS
i64.add
i64.gt_u
local.get 2
i64.const 4294967295
i64.gt_u
i32.or
if
  local.get 0
  call $__malloc
  return
end
local.get 2
i32.wrap_i64
global.set $stack_ptr
local.get 1
```

Encode constants using the existing Instr representation. The maximum sum
of two unsigned i32 operands plus seven fits comfortably in i64. The second
guard is necessary when a capacity endpoint is exactly 4 GiB: narrowing an
otherwise in-capacity endpoint of 4 GiB would install zero as the pointer.
Keep all comparisons unsigned and the capacity comparison strictly `>`;
exact fit remains valid when its endpoint is representable.

Preconditions remain the existing protocol: mark initializes the arena;
restore receives a previously saved valid mark. Forged marks, allocation
before initialization, allocator reentrancy, and a failed backing-block
reservation are not new contracts to solve in this slice.

### Concrete real-runtime regression

Follow `tests/linear-runtime.test.ts`'s minimal-module pattern:
`createEmptyModule`, `addRuntime`, `addLinearStackArenaRuntime`, test-only
exports, `emitBinary`, `WebAssembly.validate`, and
`WebAssembly.instantiate`. Export helpers/globals by name lookup with the
appropriate import counts; do not assume local function indices are absolute.
Do not implement a JS copy of the allocation algorithm as the subject.

On a fresh production-runtime module:

1. `mark()` returns 1024. `alloc(8)` returns 1024, leaving stack pointer 1032.
2. `alloc(-16)` supplies unsigned size `0xfffffff0`.
3. Before the fix, it returns 1032 and installs pointer 1016. A following
   `alloc(8)` returns 1016, below the reserved stack region.
4. After the fix, it delegates to real `__malloc`, whose initial heap pointer
   after the backing reservation is 66560, and leaves stack pointer 1032.
   A following stack `alloc(8)` returns 1032, advancing to 1040.

Inspect the exported stack-pointer global directly, rather than calling
`mark()` to observe it: a broken zero pointer would cause mark to allocate a
new block and hide the original corruption. Assert concrete return values
and pointer values; a valid binary alone is not a passing regression.

The existing ordinary `__malloc` also has unchecked arithmetic at
`runtime.ts:248` onward. In this reproduction its heap pointer can still
rewind on the huge delegated request. Do not dereference that huge result or
claim global allocation safety. Use a fresh instance per destructive-size
case; repairing the heap allocator is a separately owned task.

### Regression matrix and custody

Use the real runtime for normal allocations and the concrete regression
above. For precise huge-request routing, create a second minimal fixture in
the new test file: supply a local Wasm `__malloc` wrapper around a recording
host import, then add the production stack adapter unchanged. The import
returns a configured nonzero base for the initial 65536-byte reservation and
a distinct result for fallback, and records calls and original i32 bits.
This executes the production emitted stack-helper body without reserving
gigabytes or relying on the separate heap allocator's overflow behavior.
Keep this fixture explicitly labeled as a controlled allocator boundary,
not an end-to-end heap proof.

Required assertions:

- Zero and alignment: initialized `alloc(0)` returns the current pointer
  without moving it or invoking fallback. Sizes 1, 7, 8, and 9 advance by
  8, 8, 8, and 16 respectively from an aligned pointer, using fresh instances
  or explicit expected cumulative positions.
- Capacity: from base 1024, size 65536 ends at 66560 and succeeds; size
  65535 also aligns to the end; size 65537 falls back. Repeat an exact
  remaining-capacity case after a prior allocation. At an exhausted arena,
  zero still succeeds and one byte falls back.
- First-add overflow: at pointer 1032, request `0xfffffff0` reproduces the
  backwards movement above. Fallback receives that exact unsigned bit
  pattern once; stack base and pointer remain unchanged.
- Padding-only overflow: at pointer 1024, size `0xfffffbff` makes
  `ptr + size == 0xffffffff`; the old `+7` wraps and aligns to zero.
  Require fallback and unchanged pointer. This defeats a fix that only
  checks the first addition or compares a wrapped endpoint to capacity.
- Huge i32 cases: `0x7fffffff`, `0x80000000`, `0xfffffff0`, and
  `0xffffffff` all delegate from a fresh low arena. Normalize recorded JS
  i32 arguments with `>>> 0` when checking their bits; do not clamp or
  reinterpret them as negative allocation sizes.
- High-address arithmetic: in the controlled fixture only, use base
  `0xffff0000` and no memory loads/stores. A small allocation succeeds
  despite `base + capacity == 2^32`; an allocation whose aligned endpoint
  reaches `2^32` delegates and never sets pointer zero. This checks widened
  capacity and representability independently. It does not prove physical
  high-address memory is allocated.
- Fallback custody: ordinary exhaustion and huge requests leave both stack
  globals unchanged, pass size unchanged exactly once, and propagate the
  allocator's returned pointer. Configure the host boundary to throw in a
  separate case; its exception must propagate with stack globals unchanged.
  A subsequent small fitting allocation still uses the retained stack
  pointer. Do not add catches, new sentinels, or new allocator error behavior.
- Frame custody: reserve an outer allocation, save an inner mark, allocate
  inner storage, force fallback, and restore the saved mark. Outer bytes
  retain their values and inner storage is reusable at the expected address.
  Use real memory for these byte checks. Restoring a mark does not claim to
  free delegated heap allocations.
- Binding custody: the controlled fixture includes an imported function
  before the local `__malloc`, so helper calls and exports exercise existing
  imported-function offsets. Assert one initial backing reservation across
  nested marks; retain the existing lazy initialization behavior.

Use a small shared builder inside the new test file for each fixture type;
do not duplicate the production helper or create shared test infrastructure
for this isolated task. Assert return values, memory contents, globals, and
recorded calls, not console output or an opcode-only snapshot.

### Verification and acceptance

The implementation owner/lead should execute the new focused test file
against baseline and candidate, reporting exact commits and actual counts.
The backwards-pointer and padding-overflow regressions must fail on the
baseline and pass on the candidate. Run the existing
`tests/linear-runtime.test.ts` and the relevant allocation-policy execution
coverage in `tests/issue-3300.test.ts` unchanged as compatibility controls;
the latter covers repeated invocation, alias/identity, and exhaustion.
Apply repository-required scoped checks without changing fixtures, budgets,
expected errors, policy activation, or legacy fallbacks to obtain a pass.

- [ ] Only the released allocation-helper locals/body and new issue test
  file change in the implementation diff.
- [ ] Real emitted Wasm demonstrates both overflow failures before the fix.
- [ ] All normal, boundary, huge-size, high-address, and custody checks pass
  after the fix; fallback argument/result/exception behavior is preserved.
- [ ] Existing allocation-policy and runtime controls pass unchanged.
- [ ] No shared ABI, semantic IR, planner, registry, integration, metadata,
  source-map, fixture, error protection, or legacy behavior is weakened.
- [ ] Results explicitly distinguish safe stack admission from the separate
  unchecked ordinary-allocator behavior; no claim of universal OOM safety.

## Overlap assessment and release dependency

The read-only assessment searched issue files in the session tree and main
checkout for this helper and stack-arena wrap/overflow. No exact duplicate
was found. Related completed work is issue3300, "Porffor backend P5: prove
shared allocation-policy leverage", and issue3924, "linear backend: the
bump arena is never reclaimed across calls"; neither addresses this
arithmetic mechanism.

The cached canonical claim book `5618988ac0` had no explicit
`runtime-stack-arena`/stack-allocation match. It still recorded occupied
heap-coexistence, refcount, and native-emission work under issues4540,4542,
and4544. The parent subsequently effect-verified the exact issue6891
planning claim against upstream and released this document for writing;
no additional remote clearance is required for this planning write.
Implementation release still belongs to the parent, with exact source/test
claims and shared-owner coordination; the planning claim does not grant
those writes.

No shared wiring patch or handoff is required by this plan. If implementation
discovers one is necessary, report the concrete dependency to the parent
instead of expanding the leaf slice.
