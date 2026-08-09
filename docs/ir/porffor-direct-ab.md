# Direct Porffor / JS2 source-to-native A/B (#3482)

This benchmark sends one exact checked-in TypeScript byte sequence through
direct pinned Porffor and through JS2's source-derived typed SSA/shared-plan
Porffor-IR route. It is an engineering measurement with explicit confounders,
not a general compiler ranking.

The source is
`tests/fixtures/porffor-source-to-native-canary.ts`: 249 UTF-8 bytes with
SHA-256
`b140de2b6e1f012da594cc62336e74a1e1b39ef484eb3d30f221a392b5b1235d`.
Node's native TypeScript type stripping imports those same bytes to produce the
oracle. There is no JavaScript twin or hand-built replacement IR.

## Four measured rows

| Row                                   | Front end / IR                                                              | Value ABI     | Allocation policy                                |
| ------------------------------------- | --------------------------------------------------------------------------- | ------------- | ------------------------------------------------ |
| `direct-porffor-gc`                   | pinned Porffor TypeScript parser and codegen                                | boxed `jsval` | Porffor's default global GC                      |
| `direct-porffor-bump`                 | the same direct path with only `--no-gc` added                              | boxed `jsval` | Porffor's global bump allocator                  |
| `js2-porffor-arena-v1`                | JS2 source to typed SSA and the source-derived shared plan, then Porffor IR | raw `f64`     | per-site JS2 `arena-v1`                          |
| `js2-porffor-analysis-stack-arena-v1` | the same JS2 path and renderer                                              | raw `f64`     | per-site JS2 stack promotion with arena fallback |

Every Porffor internal is guarded by commit
`60a1d41d60580ff4faa38ffd5f7783d23df68bad` and structural assertions. The
direct adapter runs the real `porf c --module -O1` parser/codegen model and
suppresses only generated `main` immediately before rendering. Each lane then
exports the same `void init(...)` and `double kernel(double)` C ABI. All lanes
compile as separate objects, link to one common harness object, use identical
external Clang optimization flags without LTO, and initialize outside the
timed region. `porf native` is never used.

Pinned Porffor's dynamic-object entries use a 20-byte stride with an `f64`
payload at offset 8. The second payload is therefore at byte offset 28, which
violates its eight-byte alignment. UBSan reliably reports the generated raw
loads/stores. The primary direct rows deliberately preserve those plain
generated accesses: they are not rewritten to Porffor's unaligned helper and
no sanitizer is suppressed. The adapter structurally counts three raw
`entryPtr` stores and one raw load in both direct rows, plus two GC traversal
loads in the GC row, so drift fails loudly.

This is a material result. Both optimized direct timings are
**UB-contaminated and non-authoritative**. They remain in the raw capture to
show what the requested plain compiler emitted and did on this machine, but
must not support a performance conclusion. Both JS2 rows must remain
sanitizer-clean. The allowed direct rendered-C mutations are only entry
suppression before render and the disclosed pinned `%lld` LP64 Clang-compat
cast; the common wrapper is separate. The rendered C is hashed independently
from the combined wrapper C.

## What the comparison means

The direct end-to-end rows and JS2 rows do not isolate one variable. An
ordinary TypeScript `number` is a boxed Porffor `jsval` in direct output, while
the JS2 function boundary is raw `f64`. Direct dynamic objects are about 56
bytes at the pin; JS2 uses fixed 24-byte records (an 8-byte header and two
`f64` fields). Porffor selects allocation globally, while JS2 can promote each
proven local fixed-size site independently.

Consequently, only `js2-porffor-arena-v1` versus
`js2-porffor-analysis-stack-arena-v1` holds frontend, ABI, layout, renderer,
and toolchain constant and isolates allocation policy. Direct-vs-JS2 numbers
conflate frontend, ABI, layout, generated IR, allocator, and known direct
undefined behavior. #3300 remains the hand-built-IR policy proof; it is not
this direct source A/B.

## Sampling and artifacts

An optimized capture performs five complete warmup rounds followed by 21
interleaved measured rounds. Every compiler worker and native invocation is a
fresh process, and every native sample executes exactly 200,000 calls. Fixed
outputs and checksum `46965020` must match the Node oracle before a sample is
accepted. Runtime uses `CLOCK_PROCESS_CPUTIME_ID`; process RSS, source-to-C,
Clang compile/link phases, generated C/object/executable sizes, commands, and
environment are retained. Q1, median, and Q3 use R-7 interpolation.

Correctness and ASan/UBSan use separate `-O1` artifacts. The direct rows must
reproduce the pinned `runtime error: ... misaligned address` failure and are
recorded as expected safety failures, never skipped or relabelled clean. The
JS2 rows must complete 20,000 calls with checksum `4711770` and no sanitizer
finding. Sanitizer times and sizes never enter optimized output.

The focused reproducer is:

```sh
PORFFOR_DIRECT_AB_REQUIRED=1 pnpm run test:porffor-direct-ab
rg -n '\*\(f64\*\)\(MEM \+ (entry|entryPtr) \+ 8' \
  .tmp/porffor-direct-ab-sanitizers/representative/direct-porffor-*/rendered.c
```

Exact compile/link/execute argv and raw UBSan stderr are retained in
`commands.json` and `logs/lane-execute-*.stderr.log` in the sanitizer artifact.

The checked-in [raw JSON](../../benchmarks/results/porffor-direct-ab/latest.json)
and [generated table](../../benchmarks/results/porffor-direct-ab/latest.md) are
the authoritative retained sample. Their capture metadata says whether the
data is canonical Ubuntu x86_64 or a noncanonical local Darwin run; numbers
must never be compared across machines. The `Optional direct Porffor / JS2
A/B` workflow's manual job is the canonical Ubuntu capture path and uploads
raw samples, representatives, logs, commands, and environment without a
performance threshold or automatic commit. Artifact URLs expire, so a
reviewed checked-in capture is retained.

## Reproduction

```sh
git -c submodule.porffor.update=checkout submodule update --init --checkout vendor/Porffor
test "$(git -C vendor/Porffor rev-parse HEAD)" = "$(git rev-parse HEAD:vendor/Porffor)"

pnpm run test:porffor-direct-ab
pnpm run benchmark:porffor-direct-ab -- --output .tmp/porffor-direct-ab
pnpm run benchmark:porffor-direct-ab -- --validate-result .tmp/porffor-direct-ab/latest.json
```
