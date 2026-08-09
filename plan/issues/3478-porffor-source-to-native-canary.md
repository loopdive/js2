---
id: 3478
renumbered_from: 3476
title: "Porffor source-to-native canary: real TypeScript through shared linear-memory planning"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
completed: 2026-07-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
model: gpt-5.6-sol
assignee: ttraenkler/porffor-3476-dev
task_type: test
area: ir, codegen-linear, backend, ci
language_feature: compiler-internals
es_edition: n/a
goal: backend-agnostic-ir
depends_on: []
related: [3288, 3297, 3298, 3299, 3300, 3336]
origin: "2026-07-20 user directive: prove a real .ts source through JS2 typed SSA and the shared LinearMemoryPlan to linear-Wasm and optional Porffor-C/native"
---

# #3478 - Porffor source-to-native canary over the shared linear-memory plan

## Objective

Add one honest, executable vertical proof that begins with a checked-in `.ts`
source file and follows this exact path:

```text
real TypeScript source
  -> JS2 parse/type analysis + IR selection + typed SSA lowering
  -> one source-derived IrModule + one shared LinearMemoryPlan
  -> current production linear-Wasm lowering -> WebAssembly execution
  -> optional Porffor IR lowering -> pinned Porffor renderer -> C compiler
     -> native executable
```

For each supported allocation policy, compare deterministic observable results
against direct JavaScript execution and the current linear-Wasm backend. Cover
both `arena-v1` and `analysis-stack-arena-v1`, including an ASan/UBSan stress
run of the rendered native executable.

Porffor-C remains an optional proof consumer. This issue must not add a public
Porffor target, make the submodule part of normal installation/build/test jobs,
or narrow `IrModule`/`LinearMemoryPlan` around Porffor or C.

## Current state and missing proof

Verified on `origin/main` `fac7d1c588f27885628ee8de46891c362be82f1a`:

- `src/ir/backend/linear-integration.ts:142-344`
  `compileLinearIrFunctions()` already performs the real source-front-end path:
  `planIrCompilation()` -> `lowerFunctionAstToIr()` -> `verifyIrFunction()` ->
  linear legality -> module-wide `planLinearMemory()` -> `LinearEmitter`.
- `src/ir/backend/linear-integration.ts:100-110` exposes lowered Wasm functions,
  rejection telemetry, helpers, and the resulting `LinearMemoryPlan` through
  `LinearIrResult`, but not the exact source-derived typed `IrModule` that the
  plan describes. The local `plannedFunctions` array is discarded after
  planning at lines 292-297.
- `src/ir/backend/porffor/integration.ts:32-109`
  `lowerIrModuleToPorffor(module, { memoryPlan })` already accepts a typed JS2
  module plus the target-neutral plan, runs fail-loud Porffor legality, and
  lowers through the five-part backend contract.
- #3297 proves scalar/control-flow Porffor-C execution, but its proof module is
  assembled from a mixture of source-lowered functions and hand-built IR.
- #3299 and #3300 prove heap/layout and both allocation policies through
  Porffor-C, but their Porffor modules come from
  `buildAllocationPolicyProof()` and `IrFunctionBuilder`. #3300 separately
  compiles `LINEAR_ALLOCATION_POLICY_SOURCE` only through linear-Wasm. No test
  sends the exact typed SSA produced from that source through Porffor.
- `src/ir/backend/legality.ts:204-245,302-315` already admits the selected
  numeric constants/operators and fixed numeric `object.new/get/set` shapes for
  Porffor. `src/ir/analysis/linear-memory-plan.ts:366-447` already owns both
  policies and all allocation decisions.
- The Porffor gitlink and compatibility constant both pin
  `60a1d41d60580ff4faa38ffd5f7783d23df68bad`; the loader remains dynamic.

### Duplicate check (2026-07-20)

Searches across `plan/issues/` found only the completed #3288/#3297-#3300
builder-based proofs and the target-neutral planning follow-up #3336. A query of
all open `loopdive/js2` pull requests found no Porffor, source-to-native, or
shared-plan canary work. The fresh ID was then reserved and claimed atomically
with `scripts/claim-issue.mjs --allocate`; its open-PR scan completed without
degradation.

### Collision recovery (2026-07-20)

Immediately before publication, `origin/main` advanced to `01862f8a8` and
landed an unrelated issue file using #3476. Main owns a landed ID, so this
branch followed the repository collision protocol: atomically reserve+claim
#3478 with a complete open-PR scan, release the obsolete #3476 claim, rename
the issue and dedicated test, and record `renumbered_from: 3476`. No compiler,
fixture, allocator, or workflow behavior changed during the renumber.

## Root cause

The production linear integration owns the only complete source-to-linear-IR
module build for this subset, but its report drops the typed module immediately
after planning. Porffor tests therefore reconstruct equivalent IR by hand.
That demonstrates backend mechanics, not that the compiler's real `.ts`
front end and analyses can feed both backends without semantic or allocation-
site drift.

## Chosen source fixture

Add `tests/fixtures/porffor-source-to-native-canary.ts` as a real file:

```ts
export function porfforSourceNativeCanary(seed: number): number {
  const first = { x: seed, y: seed + 1 };
  const second = { x: seed + 3, y: 5 };
  const alias = first;
  alias.x = alias.x + 2;
  return first.x * 100 + second.x * 10 + second.y;
}
```

For finite integer seeds, the observable result is `110 * seed + 235` (for
example `[-7, 0, 4, 31] -> [-535, 235, 675, 3645]`). The fixture is deliberately
narrow:

- It is already within the source surface proven by
  `tests/issue-3300.test.ts:199-226`: typed parameters/return, two non-empty
  fixed numeric object literals, local aliasing, a field mutation, field reads,
  and `f64` arithmetic.
- It lowers to two `object.new` allocation sites plus `object.get`,
  `object.set`, numeric constants, `f64.add`/`f64.mul`, locals, and return - all
  in the current Porffor legality subset.
- Both objects have the same canonical numeric record shape and remain local,
  owned, fixed-size, and non-escaping. `arena-v1` must plan both as arena;
  `analysis-stack-arena-v1` must promote both to stack with symbolic
  mark/restore and retain arena fallback.
- The result depends on the seed and both objects, so a stale constant or an
  omitted allocation/read cannot accidentally satisfy the oracle. The alias
  write is observed through `first`, exercising mutation through a shared
  pointer.
- It uses return values, not `console.log`: plain `target: "linear"` has no
  output import, so stdout would be a false cross-backend oracle.

## Implementation Plan

### 1. Retain the exact source-derived typed module in the linear IR report

**File: `src/ir/backend/linear-integration.ts`**

- Extend `LinearIrResult` near lines 100-110 with
  `readonly irModule: IrModule`. This is test/adapter telemetry beside the
  existing `memoryPlan`; do not put it on public `CompileResult` and do not add
  Porffor types here.
- In `compileLinearIrFunctions()` near lines 147-164, initialize an empty
  `{ functions: [] }` module and expose it through the same getter pattern as
  `memoryPlan`, so early selector/build exits report a coherent empty module.
- Near lines 292-297, assign exactly one `IrModule` from `plannedFunctions`,
  pass that same object to `planLinearMemory()`, and retain it in the result.
  Preserve `claimedDecls` order and include only functions that passed shared
  verification and linear legality.
- Continue lowering the production linear-Wasm bodies from those same built
  functions and bind the same `memoryPlan`. Do not rerun AST lowering, clone
  allocation sites, expose the mutable `AllocSiteRegistry`, or invoke Porffor
  from the production compiler.
- Keep `getLastLinearIrReport()` as the non-public immediate-read side channel.
  The canary must capture its report immediately after each `compile()` call;
  it must not use concurrent compiles.

This is the minimum seam required for the proof. A broader generic source-
module API can be designed separately if another backend needs a supported
public entry point.

### 2. Add the real source fixture and three-way policy matrix

**File: `tests/fixtures/porffor-source-to-native-canary.ts` (new)**

- Add exactly the fixture above. Keep it free of imports, host APIs, strings,
  dynamic values, classes, arrays, and unsupported composite operations.

**File: `tests/issue-3478-porffor-source-to-native-canary.test.ts` (new)**

- Read the checked-in fixture as source text. Execute its transpiled JavaScript
  directly (following the `ts.transpileModule` oracle pattern in
  `tests/issue-3297.test.ts:262-271`) and record return values for a fixed seed
  vector plus a deterministic stress checksum.
- For each matrix row below, call the public `compile()` with
  `target: "linear"` and that row's allocator, capture
  `getLastLinearIrReport()` immediately, and instantiate the emitted Wasm with
  no imports:

  | compile allocator | required plan policy      | required site class |
  | ----------------- | ------------------------- | ------------------- |
  | `bump`            | `arena-v1`                | both `arena`        |
  | `analysis-stack`  | `analysis-stack-arena-v1` | both `stack`        |

- Assert `compiled` is exactly `porfforSourceNativeCanary`, `rejected` is
  empty, `irModule.functions` contains that exact verified/exported function,
  both allocation sites retain source provenance, and
  `verifyIrBackendLegality(fn, "porffor")` returns no errors. This prevents a
  green result produced by the direct linear fallback.
- Assert the expected source IR families and two allocation IDs are present.
  Under the stack policy, also assert local escape/ownership facts and symbolic
  stack `mark`/`restore` operations; under the arena policy, assert no managed
  roots, safepoints, or write barriers are introduced.
- Compare the linear-Wasm export's returned values and stress checksum with
  direct JavaScript. Do not compare linear stdout.
- Pass that row's exact `report.irModule` and `report.memoryPlan` to
  `lowerIrModuleToPorffor()` with `prefs: { gc: false }`; do not call
  `planLinearMemory()` again and do not build replacement IR with
  `IrFunctionBuilder`.
- Load the renderer only through `loadOptionalPorffor()`, normalize its result
  with `porfforRendererOutputText()`, append a tiny C `main`, compile to a native
  executable, and parse its deterministic stdout. Compare the fixed result
  vector and checksum with the JavaScript and linear-Wasm oracles.
- Follow the temporary-file and C-symbol lookup pattern already used at
  `tests/issue-3297.test.ts:303-353` and `tests/issue-3300.test.ts:288-333`.
  Keep helper code local to this test unless it is genuinely reused in the
  same PR.
- Split core/source-to-linear assertions from optional Porffor execution. With
  no initialized submodule, the former must run and the latter must skip
  cleanly, matching #3295's optional-loader contract.

### 3. Validate native memory safety under both plans

**File: `tests/issue-3478-porffor-source-to-native-canary.test.ts`**

- Compile each rendered C artifact with Clang using:

  ```text
  -std=gnu11 -O1 -g -Werror -Wno-unused-function
  -fsanitize=address,undefined -fno-omit-frame-pointer
  ```

- The generated harness must call the exported function repeatedly (at least
  20,000 invocations over a deterministic bounded seed cycle), accumulate one
  exactly representable numeric checksum, print only that checksum, and exit
  zero. Compare the checksum with JavaScript and linear-Wasm under the same
  inputs.
- Run with `ASAN_OPTIONS=detect_leaks=0:halt_on_error=1:abort_on_error=1` and
  `UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1`. Leak detection is disabled
  only because `arena-v1` is intentionally allocate-and-exit; address,
  bounds, use-after-free, alignment, and undefined-behavior checks remain hard
  failures.
- Execute the sanitizer stress for both policies. For the stack policy, also
  verify the rendered Porffor node set contains `#js2_stack_mark`, two
  `#js2_stack_allocate` calls, and `#js2_stack_restore`; for the arena policy,
  verify the two sites lower through Porffor `Alloc`. Neither row may contain
  `RawC`, Porffor-native `Arr*`/`Len*`, `GcBarrier`, or `jsval` operations.

### 4. Add an optional, pinned Porffor CI workflow

**File: `.github/workflows/porffor-source-canary.yml` (new)**

- Add a separate, non-required workflow named `Optional Porffor source canary`.
  Trigger it with `workflow_dispatch` and on pull requests only when the
  Porffor adapter, shared IR/planner, linear adapter, canary fixture/test, the
  Porffor gitlink, or this workflow changes. Do not add it to `merge_group`, the
  normal `CI` job graph, package install hooks, or required checks.
- Use `actions/checkout` with normal submodules disabled, then explicitly run
  `git -c submodule.porffor.update=checkout submodule update --init --checkout
  vendor/Porffor`. The per-command override is required because `.gitmodules`
  deliberately sets `submodule.porffor.update=none`. Verify
  `git -C vendor/Porffor rev-parse HEAD` equals both the superproject gitlink
  (`git rev-parse HEAD:vendor/Porffor`) and `PORFFOR_IR_COMMIT` before testing.
- Use the repository's current Node/Corepack/pnpm setup, set `CC=clang`, install
  with `pnpm install --frozen-lockfile`, and run the focused #3478 test with the
  sanitizer mode enabled. A missing pin, renderer incompatibility, sanitizer
  finding, output mismatch, or skipped Porffor execution must fail this
  optional workflow.
- Leave all existing submodule-free typecheck/build/quality jobs unchanged.
  The new test must still pass its non-Porffor portion and skip only the native
  section when run there.

## Expected lowering patterns

No new semantic instruction family is required. The proof must demonstrate
that existing patterns are selected from one source-derived plan:

```text
typed SSA (both policies)
  object.new @site0, object.new @site1
  object.get / f64.add / object.set
  object.get / f64.mul / f64.add
  return f64

linear-Wasm, arena-v1
  i32.const <planned record bytes>; call $__malloc
  i32.store8/i32.store record header
  f64.store/f64.load at LinearMemoryPlan field offsets

linear-Wasm, analysis-stack-arena-v1
  call $__linear_stack_mark; local.set $mark
  i32.const <bytes>; call $__linear_stack_alloc  ;; arena fallback is in helper
  ...same planned loads/stores...
  local.get $mark; call $__linear_stack_restore before return

Porffor, arena-v1
  Alloc(ptr, planned bytes/site id) + Load/Store at planned offsets

Porffor, analysis-stack-arena-v1
  Call #js2_stack_mark
  Call #js2_stack_allocate for each planned site
  ...same planned Load/Store offsets...
  Call #js2_stack_restore before return
```

The test should inspect symbolic node/instruction families and plan fields, not
freeze backend function indices or unrelated rendered-C formatting.

## Acceptance criteria

- [x] A checked-in `.ts` fixture, not `IrFunctionBuilder`, is the sole source of
      the canary's typed SSA module.
- [x] The current production `compile(..., { target: "linear" })` path reports
      the exact verified `IrModule` and `LinearMemoryPlan` it consumed, with no
      selector fallback, post-claim demotion, or second AST-to-IR lowering.
- [x] For both `arena-v1` and `analysis-stack-arena-v1`, the exact
      source-derived `(IrModule, LinearMemoryPlan)` pair feeds
      `lowerIrModuleToPorffor()`; no test rebuilds IR or re-plans memory.
- [x] Direct JavaScript, linear-Wasm, and the Porffor-rendered native executable
      produce identical fixed outputs and deterministic stress checksums.
- [x] The arena row uses planned arena allocations; the analysis-stack row
      promotes both fixed, owned, local sites and proves mark/allocate/restore
      plus arena overflow fallback is present in both backend adapters.
- [x] ASan and UBSan execute at least 20,000 native calls under each policy and
      report no address, bounds, alignment, lifetime, or undefined-behavior
      failure. LeakSanitizer alone may be disabled for the intentional arena.
- [x] The Porffor adapter still emits JS2-planned `ptr`/`Load`/`Store`
      operations and does not use Porffor object layouts, builtins, NaN-boxed
      `jsval`, `RawC`, or Porffor GC.
- [x] The Porffor gitlink and compatibility fingerprint remain pinned to
      `60a1d41d60580ff4faa38ffd5f7783d23df68bad` and are checked before rendering.
- [x] A separate optional workflow initializes only `vendor/Porffor` and runs
      the sanitizer canary; ordinary install, build, typecheck, and test jobs
      remain submodule-free and green when Porffor is absent.
- [x] `LinearMemoryPlan` gains no Porffor enum, C fragment, renderer field,
      native symbol name, or Porffor-specific policy decision.
- [x] The complete implementation, fixture, tests, workflow, and issue-status
      update land in one implementation PR.

## Non-goals

- A public `target: "porffor"`, CLI flag, stable C API, or native build command.
- A second parser/front end or any use of Porffor's AST/codegen pipeline.
- General source coverage for classes, closures, strings, arrays/vectors,
  dynamic values, imports, multi-file projects, builtins, exceptions, or async.
- Adopting Porffor's `jsval`, object/array ABI, builtins, allocator policy, or GC.
- Changing either allocation policy, layout, pointer-map, root, barrier, or
  symbolic runtime-operation semantics.
- Making the optional workflow a required merge gate or initializing Porffor in
  existing normal CI jobs.
- Replacing #3300's performance benchmark or drawing performance conclusions
  from sanitizer runs.
- Refactoring all existing Porffor C test harnesses or publishing the
  `getLastLinearIrReport()` telemetry as supported public API.

## Risks and mitigations

- **False-green direct fallback:** a successful linear binary does not prove IR
  participation. Assert the exact `compiled` set, empty `rejected` list,
  verified `irModule`, allocation IDs, and Porffor legality before execution.
- **Plan/module drift:** re-lowering source or re-running `planLinearMemory()`
  can mint or mutate a different allocation-site universe. Reuse only the
  captured report's exact `irModule` and `memoryPlan` for Porffor.
- **Global report side channel:** `getLastLinearIrReport()` is last-write-wins.
  Keep the matrix sequential and capture each report immediately; do not use
  `test.concurrent` or start a second compile before capture.
- **Numeric text drift:** keep inputs/results finite, integral, and below
  `2^53`; print with `%.17g` and compare parsed numbers/checksums rather than C
  source text.
- **Expected arena retention:** arena allocations intentionally live until
  process exit. Disable only leak reporting; never suppress ASan/UBSan memory or
  undefined-behavior failures.
- **Unstable upstream renderer:** the optional workflow verifies the gitlink and
  frozen compatibility fingerprint before rendering. A Porffor update is a
  separate reviewed compatibility migration.
- **Planner ownership regression:** the implementation touches no planner
  vocabulary. #3336 may reframe planning metadata independently; avoid editing
  that issue or making this canary a Porffor-only planner owner.
- **CI portability:** require Clang in the optional Ubuntu job. Local runs may
  skip native execution when Porffor or a sanitizer-capable C compiler is
  absent, but the optional CI job must not skip it.

## Validation commands

Core/submodule-absent validation:

```bash
JS2WASM_PORFFOR_ROOT=tests/fixtures/porffor-intentionally-absent \
  pnpm exec vitest run tests/issue-3478-porffor-source-to-native-canary.test.ts --reporter=dot
pnpm exec vitest run tests/issue-3300.test.ts tests/issue-3299.test.ts tests/issue-3298.test.ts --reporter=dot
pnpm run typecheck
pnpm run build
pnpm run lint
pnpm run format:check
```

Pinned Porffor + native sanitizer validation:

```bash
git -c submodule.porffor.update=checkout submodule update --init --checkout vendor/Porffor
test "$(git -C vendor/Porffor rev-parse HEAD)" = "$(git rev-parse HEAD:vendor/Porffor)"
CC=clang JS2WASM_PORFFOR_ROOT=vendor/Porffor PORFFOR_NATIVE_REQUIRED=1 \
  PORFFOR_NATIVE_SANITIZERS=1 \
  pnpm exec vitest run \
    tests/issue-3478-porffor-source-to-native-canary.test.ts \
    tests/issue-3295-porffor-compat.test.ts \
    tests/issue-3297.test.ts \
    tests/issue-3299.test.ts \
    tests/issue-3300.test.ts --reporter=dot
```

Repository gates for the implementation PR:

```bash
pnpm run check:linear-ir
pnpm run check:ir-fallbacks
pnpm run check:loc-budget
pnpm run check:dead-exports
pnpm run check:issues
pnpm run check:issue-ids
GATE_BASE=origin/main pnpm run check:issue-ids:against-main
```

Do not run full local test262 for this slice; normal PR and merge-group CI own
the broader conformance gates.

## Implementation Summary

- `LinearIrResult` now retains the exact verified `IrModule` object passed to
  `planLinearMemory()`, including a coherent empty module on early exits. The
  production linear compiler still owns lowering and planning; no Porffor
  dependency or public target was added.
- The checked-in fixed-record fixture is compiled sequentially through the
  production linear target with `bump` and `analysis-stack`. Each immediately
  captured report supplies its unchanged `(irModule, memoryPlan)` pair to the
  Porffor adapter. Direct JavaScript, linear-Wasm, and rendered native C agree
  on four fixed results and a 20,000-call checksum under both policies.
- The test proves arena versus stack allocation classes, symbolic stack
  mark/allocate/restore, JS2 `Load`/`Store` lowering, and the absence of
  Porffor object/GC/`jsval` escape hatches. Required mode fails if Porffor,
  Clang, or sanitizer mode is unavailable, so advisory CI cannot pass by
  skipping native execution.
- The advisory workflow leaves ordinary jobs submodule-free, overrides the
  gitlink's intentional `update=none` setting only for `vendor/Porffor`, and
  verifies checkout, gitlink, and compatibility fingerprint equality before
  running ASan/UBSan.
- The pinned renderer prints its `i64` typedef with `%lld`; on LP64 Linux that
  typedef is `long`, so Clang rejects the generated vararg under `-Werror`. The
  test applies one exact, count-checked cast to `long long` before native
  compilation. This keeps `-Werror` and format diagnostics enabled, preserves
  the rendered value, and fails loudly if the pinned renderer fragment drifts.

The source lowerer currently assigns stable `AllocSiteId` values but does not
populate the optional line/column `IrSiteId` on `object.new`. An initial test
assertion for those absent coordinates was therefore invalid. The final canary
proves source provenance through the sole checked-in source, exact compiled
function/report identity, and allocation-ID continuity into the shared plan;
adding coordinate metadata would require an out-of-scope source-builder change.

## Test Results

- `JS2WASM_PORFFOR_ROOT=tests/fixtures/porffor-intentionally-absent pnpm exec vitest run tests/issue-3478-porffor-source-to-native-canary.test.ts --reporter=dot` — 1 passed, 1 skipped (native optional), file passed.
- `CC=clang JS2WASM_PORFFOR_ROOT=vendor/Porffor PORFFOR_NATIVE_REQUIRED=1 PORFFOR_NATIVE_SANITIZERS=1 pnpm exec vitest run tests/issue-3478-porffor-source-to-native-canary.test.ts --reporter=dot` — 2/2 passed under ASan/UBSan.
- Focused #3478/#3295/#3297/#3299/#3300 matrix — 5 files, 22/22 tests passed with the pinned checkout.
- GitHub's Ubuntu advisory run exposed the pinned renderer's LP64 `%lld` / `i64`
  vararg mismatch under `-Werror`. After the exact count-checked cast
  normalization, the same pinned local sanitizer matrix passed 22/22 while
  retaining format diagnostics.
- `pnpm run typecheck`, `pnpm run build`, `pnpm run lint`, `pnpm run format:check`, `pnpm run check:linear-ir`, `pnpm run check:ir-fallbacks`, `pnpm run check:loc-budget`, `pnpm run check:dead-exports`, `pnpm run check:issues`, `pnpm run check:issue-ids`, and `GATE_BASE=origin/main pnpm run check:issue-ids:against-main` passed.
- Workflow parsing/semantics, the `update=checkout` submodule override, gitlink
  pin equality, and `git diff --check` passed. Local test262 was intentionally
  not run.
