---
id: 3508
title: "Advance the optional Porffor integration pin to pre-alpha 9"
status: done
sprint: 73
assignee: ttraenkler/codex-senior-3508
created: 2026-07-21
updated: 2026-07-21
completed: 2026-07-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: infrastructure
area: ir, backend, tooling
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: []
related: [3295, 3297, 3299, 3300, 3478, 3482, 3498, 3499, 3500, 3501, 3502]
origin: "2026-07-21 user directive: pin exact Porffor pre-alpha 9 main and prove compatibility before the canonical landing benchmark"
---

# #3508 - Advance the optional Porffor integration pin to pre-alpha 9

## Objective

Advance `vendor/Porffor` from
`60a1d41d60580ff4faa38ffd5f7783d23df68bad` (pre-alpha 4) to the exact
Porffor `main` commit `257e8437bea2f00c8a1453a325561071d32be9cd`
(pre-alpha 9), migrate only the compatibility surface that changed, and prove
the optional JS2 IR/C integration before the canonical four-lane benchmark is
landed separately.

The shared `LinearMemoryPlan` remains target-neutral. This maintenance slice
may adapt the Porffor edge but must not narrow shared layout, allocation, or
analysis contracts around Porffor's experimental IR.

## Upstream audit

The old pin is an ancestor of the new pin, with 20 intervening commits. The
complete diff changes 15 files (`232` insertions, `249` deletions). Only two
changes affect JS2's frozen IR/C renderer boundary:

1. `e94dfede5cf5d1b67bf3a82261211370f38bd29a` removes the unused `ToNum`
   IR constructor and renderer arm. This shifts `JvTruthy` and every later `K`
   ordinal down by one; JS2 never emitted `ToNum`, so only the enum fingerprint
   and ordinal-derived nodes need migration.
2. `33f09c247be062082ea85eccb9f23f5b3774b096` reduces
   `Alloc(bytes, typeId, siteId, raw)` to `Alloc(bytes, typeId)` and fixes slot
   C to zero. JS2 had used the ignored slot as adapter-local `[siteId, raw]`
   metadata. Allocation class and provenance are already resolved from
   `LinearMemoryPlan` before final Porffor assembly, so the correct migration
   is to stop leaking that metadata into upstream IR rather than changing the
   shared plan.

The six-slot node layout, all `T` and `FX` entries, renderer input fields
`{ funcs, data, globals, entry, prefs, usedTypes }`, function record fields,
and renderer arity remain unchanged. Other renderer changes in the range alter
uncaught-error text and REPL output only and do not affect JS2's emitted
surface.

`git ls-remote origin refs/heads/main` in `vendor/Porffor` returned exactly
`257e8437bea2f00c8a1453a325561071d32be9cd`; the submodule is detached at that
commit rather than following a branch.

## Implementation notes

- Remove `ToNum` from the exact `K` fingerprint and update the pinned commit.
- Add an `Alloc` constructor probe so a future pin cannot silently reintroduce
  a slot-C schema mismatch.
- Emit slot C as zero for every final Porffor `Alloc` node. Keep site IDs and
  allocation-class decisions in the shared plan and pre-assembly expression,
  where they continue to drive stack-versus-arena selection.
- Keep the optional submodule's `update = none` policy, but change its ignore
  policy from `all` to `dirty`. This continues to ignore edits inside the
  Porffor worktree while making a checked-out commit/gitlink mismatch visible;
  the compatibility suite freezes both settings to prevent regression.
- Refresh the four exact plain-Porffor generated-C byte fingerprints. The
  pre-alpha 9 renderer adds `670` bytes to each raw CLI artifact without
  changing the accepted kernel outputs.
- Do not change Porffor's object layout, JS2's layouts, the value ABI, or the
  shared planner.

## Acceptance criteria

- [x] `vendor/Porffor` is pinned exactly to
      `257e8437bea2f00c8a1453a325561071d32be9cd`, detached from floating `main`.
- [x] `.gitmodules` retains `update = none`, uses `ignore = dirty`, and no
      longer hides a Porffor checkout/gitlink mismatch with `ignore = all`.
- [x] The compatibility fingerprint validates pre-alpha 9 enums, slots,
      `Alloc` shape, records, and real C rendering.
- [x] Focused Porffor IR conformance/parity and all four-kernel landing support
      tests pass.
- [x] JS2-generated native C is clean under combined ASan+UBSan.
- [x] Plain pre-alpha 9 Porffor sanitizer evidence classifies whether the known
      20-byte-stride/misaligned-`f64` finding remains, changed, or is fixed.
- [x] Relevant guards plus typecheck, lint, and formatting checks pass.
- [x] The ready PR excludes
      `.github/workflows/landing-four-lane-backend.yml` and
      `docs/benchmarks/landing-four-lane-backend.md`.

## Validation

Validation was completed on branch `codex/3508-porffor-prealpha9-pin`, starting
from audited tip `d4db9023e0ea1a74948fdb8a775c2643b410b74b` over
`origin/main` `ec5d218929caa7fcb650b544419b2d1835486d9d`. The final
documentation commit additionally retains a scoped compatibility-probe
hardening: the expected `Alloc` kind comes from JS2's frozen kind list instead
of echoing the candidate module's `K.Alloc` value.

### Diff, gitlink, and upstream audit

- `git diff --ignore-submodules=none --stat origin/main...d4db9023e` reported
  exactly 8 paths, 180 insertions, and 28 deletions. The only paths were
  `.gitmodules`, this issue, the four-kernel corpus fingerprints, the Porffor
  assembler/fingerprint, the focused #3295/#3299 tests, and
  `vendor/Porffor`. `git diff --quiet origin/main...HEAD --
  .github/workflows/landing-four-lane-backend.yml
  docs/benchmarks/landing-four-lane-backend.md` exited zero.
- `git diff --ignore-submodules=none --raw origin/main...d4db9023e` showed the
  gitlink as `160000` changing from `60a1d41d6` to `257e8437b`.
  `git ls-tree HEAD vendor/Porffor` returned
  `160000 commit 257e8437bea2f00c8a1453a325561071d32be9cd`, while
  `git ls-tree origin/main vendor/Porffor` returned
  `160000 commit 60a1d41d60580ff4faa38ffd5f7783d23df68bad`.
- `git submodule status -- vendor/Porffor` and
  `git -C vendor/Porffor rev-parse HEAD` both resolved the checkout to exact
  pre-alpha 9 commit `257e8437bea2f00c8a1453a325561071d32be9cd`;
  `git -C vendor/Porffor branch --show-current` was empty and status was
  `HEAD (no branch)`.
- `git config -f .gitmodules --get submodule.porffor.update` returned `none`;
  the corresponding `ignore` query returned `dirty`.
- Corrected visibility fact: `ignore = all` did not merely hide dirt inside
  the checkout; it hid this valid committed gitlink change from normal diff
  display. With the branch's `ignore = dirty`, normal
  `git diff --name-only origin/main...HEAD` includes `vendor/Porffor`.
  Repeating it with `--ignore-submodules=all` omits the gitlink, while
  `--ignore-submodules=none` exposes it explicitly. The prior pin's
  `.gitmodules` entry was `ignore = all`, so changing to `dirty` restores
  ordinary gitlink visibility while still ignoring content dirt.
- In `vendor/Porffor`, `git merge-base --is-ancestor 60a1d41d... 257e8437...`
  exited zero; `git rev-list --count 60a1d41d...257e8437...` returned 20.
  `git diff --stat` over that range reported 15 files, 232 insertions, and 249
  deletions. Commit `e94dfede5cf5d1b67bf3a82261211370f38bd29a`
  removes only the unused `ToNum` constructor/import/render arm. Commit
  `33f09c247be062082ea85eccb9f23f5b3774b096` changes
  `Alloc(bytes, typeId, siteId, raw)` to `Alloc(bytes, typeId)` and fixes slot
  C to zero. The six node slots, `T`, `FX`, renderer argument record,
  function record, and render function arity are unchanged. The remaining
  renderer deltas concern REPL output and uncaught-error rendering.

### Shared-plan authority audit

Removing Porffor's ignored slot-C metadata does not remove or weaken
`LinearMemoryPlan` authority:

- `PorfforExpr.kind === "alloc"` still retains `siteId` through semantic
  lowering. `assembleExpr` resolves that exact ID in the bound plan and fails
  if it is absent before selecting stack versus arena with
  `plannedAllocationClass`.
- `bindMemoryPlan` still validates every allocation's symbolic operation and
  stack mark/restore consistency. Heap lowering still fails without the shared
  plan, and `prefs.gc` remains constrained by the selected plan policy.
- The vector-growth helper still requires one exact planned f64-vector site,
  verifies its arena class and symbolic grow operation, and consumes its
  planned layout offsets/stride. The internal stack arena and overflow
  fallback are created only when plan operations require that runtime.
- Final upstream `Alloc` nodes therefore contain only the upstream-owned
  `[K.Alloc, T.ptr, FX.call | fx(bytes), bytes, typeId, 0]` schema. Site
  provenance and allocation-class decisions have already been consumed, not
  discarded. The updated #3299 test compares the complete allocation count and
  byte-size multiset against `plan.allocations`, asserts slot C zero, and keeps
  the plan-policy/class/root/safepoint/barrier checks.

### Focused and broad IR validation

Focused compatibility/shared-plan command:

```sh
IR_VERIFY_ALLOC=1 CC=clang JS2WASM_PORFFOR_ROOT=vendor/Porffor \
  pnpm exec vitest run \
  tests/issue-3295-porffor-compat.test.ts tests/issue-3299.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
```

Result: 2 files and 12/12 tests passed in 5.11 seconds, including exact enum,
slot, `Alloc`, optional-loader, real-renderer, shared-plan, linear-Wasm, and
native Porffor-C checks.

Broad required-native/sanitizer matrix:

```sh
IR_VERIFY_ALLOC=1 CC=clang JS2WASM_PORFFOR_ROOT=vendor/Porffor \
  PORFFOR_NATIVE_REQUIRED=1 PORFFOR_NATIVE_SANITIZERS=1 \
  pnpm exec vitest run \
  tests/backend-contract.test.ts tests/issue-2953.test.ts \
  tests/issue-3295-porffor-compat.test.ts tests/issue-3297.test.ts \
  tests/issue-3298.test.ts tests/issue-3299.test.ts \
  tests/issue-3300.test.ts \
  tests/issue-3478-porffor-source-to-native-canary.test.ts \
  tests/issue-3499-porffor-typed-bitwise-composites.test.ts \
  tests/issue-3500-linear-ir-recursive-call-graph-type-evidence.test.ts \
  tests/issue-3501-empty-array-element-inference.test.ts \
  tests/issue-3502-string-contract.test.ts \
  tests/issue-3502-string-hash-four-lane.test.ts \
  tests/ir-vec-two-backend.test.ts tests/ir/alloc-registry.test.ts \
  tests/ir/alloc-provenance.test.ts tests/linear-*.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
```

Result: 33 files and 241/241 tests passed in 58.57 seconds. This includes the
Porffor scalar/control-flow, heap/layout, allocation-policy, source-native,
typed-bitwise, recursive, vector, string, backend-contract, allocation
provenance, and broad linear suites.

An earlier 34-file/249-test superset also included
`tests/issue-3288.test.ts`: 33 files and 248 tests passed, while its one stale
assertion failed because it still expects
`PorfforTypeConverter` to reject strings after #3502 added pointer-backed
string support. This is inherited exactly from `origin/main`, not this pin:
branch and main have identical blobs for both the test
(`58e593555f52ec5e199c20a6a344b92f6a2d2772`) and type converter
(`c91b069e674a3d6722e61db19de931cca65aa07b`), and the #3508 diff touches
neither file. The result was recorded rather than misclassified as pin drift.

### Exact four-kernel support and sanitizer evidence

The authoritative support probe and validator were:

```sh
CC=clang JS2WASM_PORFFOR_ROOT=vendor/Porffor \
  pnpm run benchmark:landing-four-lane --probe \
  --output /private/tmp/js2-3508-landing-four-lane-prealpha9
pnpm run benchmark:landing-four-lane --validate-result \
  /private/tmp/js2-3508-landing-four-lane-prealpha9/latest.json
```

The probe reported `supported: 12`, `unsafe: 4`, and `unsupported: 0`; the
retained JSON passed the official validator. For every program, V8,
JS2-WasmGC/Wasmtime, JS2 shared-plan/Porffor-C, and plain Porffor-C produced the
same exact output vector. All four JS2 native combined-ASan+UBSan executables
exited zero with no sanitizer diagnostic and are authoritative. Plain Porffor
produced the correct optimized outputs but every sanitizer executable aborted
with the same known `store to misaligned address` class, so those four cells
are `unsafe-non-authoritative`:

| Program | Exact output vector in all four lanes | JS2 C sanitizer | Plain raw CLI C bytes / SHA-256 | Plain sanitizer first finding |
| --- | --- | --- | --- | --- |
| `fib` | `[0, 1, -1846256875, -1821818939]` | clean | `183170` / `17f0e0a68891b4d526b5d6b5c560df20ba6f54cdc087c8363561e47d2e95a8eb` | `lane.c:2998:3: runtime error: store to misaligned address` |
| `fib-recursive` | `[0, 1, 55, 832040]` | clean | `183927` / `7b932dcc561f0a30ed1b2d330de88cad5872d95facb9f6e0567ddb0bd2f755ed` | `lane.c:3031:3: runtime error: store to misaligned address` |
| `array-sum` | `[0, 0, 1018392, 511492320]` | clean | `212612` / `6acf77ddbc1a37cd295113251404ee8daf6387ab29af5509015a94ef609ffb4d` | `lane.c:3013:3: runtime error: store to misaligned address` |
| `string-hash` | `[0, 96500, 36729899, 862771296]` | clean | `188870` / `bf6b0b62f58edb7e9e12e9408826cba2502cd055503b9b9bf0d393d770d2b058` | `lane.c:3002:3: runtime error: store to misaligned address` |

The native probes compile with
`-fsanitize=address,undefined -fno-omit-frame-pointer` and run with
`ASAN_OPTIONS=detect_leaks=0:halt_on_error=1:abort_on_error=1` plus
`UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1`.

The full #3498 test wrapper also ran 10/12 tests successfully. Its two
non-support failures were environmental: the benchmark-resume-only test saw
the local default Rust 1.93.1 instead of canonical 1.94.1, and the first
sandboxed artifact path denied `mkdir`. The exact support probe above was then
run outside those unrelated benchmark-only constraints and validated
successfully. Neither wrapper file differs from `origin/main` (blob
`903f93e897e42608c1c7115e010b6a808499224d`).

### Direct Porffor A/B classification

```sh
PORFFOR_DIRECT_AB_REQUIRED=1 \
  PORFFOR_DIRECT_AB_TEST_OUTPUT=/private/tmp/js2-3508-direct-ab-prealpha9 \
  CC=clang JS2WASM_PORFFOR_ROOT=vendor/Porffor \
  pnpm run test:porffor-direct-ab
```

Result: 1 file and 4/4 tests passed in 11.23 seconds. Its independently
generated four-row sanitizer artifact confirms the landing probe:

| Row | Rendered-C SHA-256 | Result |
| --- | --- | --- |
| direct Porffor GC | `082626181257415715cf18a3f02d7217c86feef50a969aae7cab38dfe7391c63` | expected UBSan failure, `lane.c:3024:3`, misaligned dynamic-object `f64` store |
| direct Porffor bump | `05d7012a737eb79d942a4d168b06b55c1521d4011640208b2279f14a945b4974` | expected UBSan failure, `lane.c:846:3`, misaligned dynamic-object `f64` store |
| JS2 `arena-v1` | `bf40e17bd3a7d00170f45f7c8318318df4376d7f878798e2ffdaee5282f9c1b0` | clean, exit 0, fixed outputs `[-535, 235, 675, 3645]`, checksum `4711770` |
| JS2 `analysis-stack-arena-v1` | `04fc5bfda83944b70603c00119c114e042aab3b64b156e04f5e9a9bda4b71b79` | clean, exit 0, fixed outputs `[-535, 235, 675, 3645]`, checksum `4711770` |

Classification: pre-alpha 9 **still has** the known 20-byte dynamic-object
entry / misaligned eight-byte `f64` undefined behavior. It is neither fixed nor
a different sanitizer class. Only the exact generated-C hashes/locations moved
with the renderer pin; JS2's shared-plan layouts remain sanitizer-clean.

### Quality and repository guards

- `pnpm run typecheck` passed.
- `pnpm run lint` exited zero with no error-level diagnostics.
- `pnpm run format:check` passed: all matched files use Prettier style.
- `pnpm run build` passed with 332 modules transformed and declaration files
  generated. The identical approved rerun was needed because the sandbox
  denied Vite's normal replacement of the ignored `dist/` directory.
- `pnpm run check:ir-fallbacks` passed: no unintended, post-claim, or
  module-level increase.
- `pnpm run check:pushraw` passed at 55 call sites, `+0` versus merge-base.
- `pnpm run check:stack-balance` passed with every fixup bucket at delta zero.
- `pnpm run check:linear-ir` passed at 10 compiled versus baseline 8.
- `pnpm run check:loc-budget` passed for two changed source files, net `+27`
  LOC and no unallowed growth.
- `pnpm run check:dead-exports` passed with 0 new entries and one baseline
  entry gone.
- `pnpm run check:ir-adoption` passed; `ir-adoption.md` is current.
- `git diff --check` passed.
- `pnpm run check:issues` exited zero with 3,072 issues indexed and no issue
  file rewrites; it reported existing aggregate-index refreshes and resolved
  dependencies as informational.
- `pnpm run check:issue-ids` passed with no duplicate IDs among 3,071 workspace
  issues.
- `GATE_BASE=origin/main pnpm run check:issue-ids:against-main` passed with no
  branch-introduced collision.
- `pnpm run check:issue-spec-coverage` passed: the gated done flip carries
  probe/test references.
- Local full Test262 was intentionally not run, per scope.

## Implementation summary

- **What changed:** advanced only the optional Porffor gitlink and its frozen
  compatibility edge; removed the deleted `ToNum` ordinal, emitted the new
  zero slot-C `Alloc` shape, froze the constructor with a real probe, exposed
  gitlink changes with `ignore = dirty`, and refreshed the four exact plain-C
  byte fingerprints.
- **Why this shape:** site provenance and allocation policy belong to the
  target-neutral `LinearMemoryPlan`; Porffor's removed, renderer-ignored slot
  was an adapter leak rather than a shared-planner contract. Consuming the
  plan before final upstream assembly preserves authority without inventing a
  Porffor-only side channel.
- **What worked:** exact gitlink/fingerprint assertions, plan-aware lowering,
  four-lane output parity, and independent landing/direct sanitizer matrices
  all agree. The pin adds no object ABI, GC, parser, public target, or planner
  vocabulary.
- **What did not indicate a product defect:** sandbox IPC/sysctl/output-path
  restrictions required approved reruns of tsx, `/usr/bin/time`, and Vite;
  the complete #3498 wrapper additionally contains a canonical benchmark-only
  Rust/Wasmtime setup check. The stale #3288 string rejection is byte-identical
  on current main. None is caused by the pin, and each requested executable
  support/sanitizer path has separate passing evidence above.
- **Files changed:** `.gitmodules`, `vendor/Porffor`,
  `src/ir/backend/porffor/{compat,assembler}.ts`,
  `scripts/lib/landing-benchmark-corpus.mjs`, focused #3295/#3299 tests, and
  this issue record.
