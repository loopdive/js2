# Shared linear-memory allocation-policy proof (#3300)

> **Scope:** #3300 is a hand-built-IR allocation-policy proof. Its Porffor and
> linear-Wasm lanes do not start from the same source path, and it does not
> include source compilation time. It must not be cited as a direct compiler
> A/B. See [#3482's direct source methodology](porffor-direct-ab.md) for that
> comparison.

Measured 2026-07-17 on Apple M1 Max, macOS/Darwin 25.3.0, Node 22.16.0,
pnpm 10.30.2, and `Apple clang version 17.0.0 (clang-1700.6.3.2)`.
Porffor was present at the adapter's exact pinned commit
`60a1d41d60580ff4faa38ffd5f7783d23df68bad`.

## Policies and planner decisions

Both runs build the same immutable `LinearMemoryPlan` inputs: allocation-site
IDs and owners, layouts and sizes, pointer maps, ownership/access facts, escape
classes, stack-candidate facts, roots, barriers, data segments, globals, and
symbolic runtime operations. Only `LinearAllocatorPolicy.decide` changes.

| Policy                    | Fixed numeric objects                 | Dense f64 vector | Benchmark roots / barriers |
| ------------------------- | ------------------------------------- | ---------------- | -------------------------- |
| `arena-v1`                | arena                                 | arena            | none / none                |
| `analysis-stack-arena-v1` | stack when owned + local + fixed-size | arena fallback   | none / none                |

For the supported record/vector sites, the alternative is deliberately
stack-plus-arena; it does not introduce a new managed heap. ADR-0017 keeps
JS2's raw linear pointers non-moving, and this proof does not silently adopt
Porffor's GC object kinds or root discovery. A mixed managed comparison is
therefore unsupported: the current Porffor renderer selects GC globally, while
JS2 has not yet defined managed root slots/type IDs for these raw layouts.
Non-promoted opaque sites retain the baseline managed allocation, root,
safepoint, and barrier decision; the alternative policy does not rewrite them
as arena allocations. Managed-collection stress is unsupported because neither
backend can execute that mixed contract yet. The checked fixtures instead
stress function-frame reclamation, repeated overflow, and the existing
non-moving arena fallback.

## Fixed benchmark

The benchmark invokes a two-allocation fixed numeric-object kernel 200,000
times per round. It discards five warmup rounds and reports the median of 21
fresh measured rounds. Runtime is kernel CPU time (`process.cpuUsage` for
linear-Wasm and `CLOCK_PROCESS_CPUTIME_ID` for C), excluding instantiation and
process startup. Linear-Wasm peak memory is the maximum
`memory.buffer.byteLength` after a fresh-instance round. Each Porffor-C round
runs in a fresh child; peak memory is the maximum resident set size reported by
`/usr/bin/time -l`. It includes the C runtime and committed Porffor memory, so
it is not directly comparable to the Wasm page count. Allocation counts are per
timed round. Runtime and size comparisons are only within one backend.

| Backend / policy        |                      Output size | Median runtime |      Peak memory | Logical allocations | Backing-arena allocations |
| ----------------------- | -------------------------------: | -------------: | ---------------: | ------------------: | ------------------------: |
| linear-Wasm `arena-v1`  |                     4,889 B Wasm |      10.856 ms |      9,633,792 B |             400,000 |                   400,000 |
| linear-Wasm stack/arena |                     5,066 B Wasm |       6.382 ms |        131,072 B |             400,000 |                         1 |
| Porffor-C `arena-v1`    | 30,087 B C / 34,048 B executable |       1.858 ms | 10,911,744 B RSS |             400,000 |                   400,000 |
| Porffor-C stack/arena   | 31,260 B C / 34,344 B executable |       1.075 ms |  1,310,720 B RSS |             400,000 |                         1 |

The planner result explains the allocation-count and peak-memory change: two
logical object allocations per call become offsets in one reusable 64 KiB
function-stack backing region. If one invocation exceeds that region, both
adapters preserve behavior by falling back to the ordinary arena for the
overflowing allocations. Backend artifacts explain the remaining deltas.
Linear-Wasm pays 177 bytes plus mark/restore calls; Porffor-C pays 1,173
C-source bytes / 296 native bytes. The measured median runtime decreased by
about 41% for linear-Wasm and 42% for Porffor-C because both avoid 400,000
calls to their arena allocator. A repeated independent run preserved both
directions; this pilot does not establish a universally better policy.

The supported comparison families are fixed numeric records (promotion) and
dense f64 vectors (arena fallback). Both benchmark kernels perform the same two
fixed-record allocations and alias mutation and return `911`; the typed IR
fixture additionally asserts reference identity through Porffor. Strings,
closures, variable-size objects, managed collection, and Porffor-native
object/array operations are outside the proof. Vector indices 1, -1, and 8
return `309`, `300`, and `300` through both policies/backends.

## Reproduction

```sh
git -C vendor/Porffor rev-parse HEAD
cc --version
pnpm exec tsx scripts/benchmark-allocation-policies.mts
IR_VERIFY_ALLOC=1 pnpm exec vitest run tests/issue-3300.test.ts tests/issue-3299.test.ts tests/issue-3298.test.ts tests/issue-3297.test.ts --reporter=dot
```

The benchmark prints the raw JSON, including methodology, checksums, artifact
sizes, runtime medians, peak-memory readings, compiler, and Porffor commit.
