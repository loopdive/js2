# Direct Porffor vs JS2 typed-SSA/shared-plan Porffor IR A/B

> This is a **clearly noncanonical darwin/arm64 local capture**. Do not compare these numbers with another machine or claim cross-machine ratios.

Generated 2026-07-20T01:47:14.103Z from repository commit `d7386a1a2179b4160cd058c2df5c3651a8f232c7`. The exact checked-in fixture is `tests/fixtures/porffor-source-to-native-canary.ts` (249 bytes, SHA-256 `b140de2b6e1f012da594cc62336e74a1e1b39ef484eb3d30f221a392b5b1235d`). Its 200,000 calls produce checksum `46965020` in Node and every native sample.

> **Safety boundary:** both direct rows preserve plain pinned Porffor C and reproducibly fail UBSan on misaligned dynamic-object `f64` accesses. Their optimized values below are UB-contaminated and non-authoritative. The JS2 rows are sanitizer-clean.

## Method

- Capture: `noncanonical-darwin-arm64-local`; workflow run: none (local capture).
- 5 complete warmup rounds, then 21 complete cyclically interleaved measured rounds.
- Every sample uses a fresh compiler worker, freshly compiled lane object, fresh link, and fresh native process.
- CPU time is `CLOCK_PROCESS_CPUTIME_ID`; RSS is whole-process high-water RSS. Q1/median/Q3 use R-7.
- Compile flags: `-O3 -DNDEBUG -std=gnu11 -DJS2_AB_ITERATIONS=200000 -fno-lto -Werror -Wno-unused-function -ffunction-sections -fdata-sections -c`.
- Link flags: `-O3 -fno-lto -Wl,-dead_strip`.
- The same separately compiled harness object is linked into all four rows; LTO, `porf native`, and `-march=native` are absent.

## Runtime and build summaries

All triplets are Q1 / median / Q3. CPU/build values are milliseconds.

| Row | Value ABI | Allocation | Authority | CPU ms | Runtime RSS | Total build ms |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `direct-porffor-gc` | boxed-jsval | porffor-default-gc | ub-contaminated-non-authoritative | 17.925 / 18.521 / 19.900 | 26.36 MiB / 26.36 MiB / 26.38 MiB | 1716.508 / 1730.566 / 1748.980 |
| `direct-porffor-bump` | boxed-jsval | porffor-gc-false-bump | ub-contaminated-non-authoritative | 12.061 / 12.405 / 12.746 | 22.67 MiB / 22.67 MiB / 22.67 MiB | 1395.607 / 1408.487 / 1427.896 |
| `js2-porffor-arena-v1` | raw-f64 | arena-v1 | within-machine-informational | 1.457 / 1.484 / 1.523 | 10.41 MiB / 10.41 MiB / 10.41 MiB | 1536.207 / 1574.960 / 1594.309 |
| `js2-porffor-analysis-stack-arena-v1` | raw-f64 | analysis-stack-arena-v1 | within-machine-informational | 0.727 / 0.731 / 0.748 | 1.25 MiB / 1.25 MiB / 1.25 MiB | 1551.339 / 1570.830 / 1604.284 |

## Compile phases

The JS2 source-to-linear-telemetry phase includes production linear-Wasm emission. It is not presented as a pure front-end timer.

| Row | Direct parse | Direct codegen | JS2 source→linear telemetry | JS2 IR→Porffor | Porffor render | Clang compile | Clang link |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct-porffor-gc` | 3.218 / 3.359 / 3.433 | 24.577 / 24.929 / 25.391 | n/a | n/a | 12.226 / 12.753 / 13.131 | 720.280 / 729.542 / 740.058 | 47.412 / 48.509 / 51.366 |
| `direct-porffor-bump` | 3.220 / 3.315 / 3.469 | 24.353 / 25.057 / 25.611 | n/a | n/a | 11.227 / 11.666 / 12.110 | 405.299 / 412.218 / 415.357 | 46.887 / 47.538 / 48.499 |
| `js2-porffor-arena-v1` | n/a | n/a | 544.798 / 554.050 / 561.104 | 2.215 / 2.356 / 2.507 | 3.056 / 3.128 / 3.175 | 54.378 / 55.221 / 57.999 | 48.619 / 49.864 / 53.556 |
| `js2-porffor-analysis-stack-arena-v1` | n/a | n/a | 546.479 / 557.730 / 575.489 | 2.740 / 2.799 / 3.026 | 3.572 / 3.684 / 3.843 | 54.787 / 56.695 / 59.751 | 48.762 / 49.563 / 49.995 |

## Artifact sizes and hashes

| Row | Rendered C B | Wrapper B | Object B | Executable B | Rendered C SHA-256 | Combined C SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `direct-porffor-gc` | 186848 | 390 | 127984 | 108568 | `8dd5f0be49386b638cf3a631393573fe77aaecdeef2f1ff9ca6d3dc77660c93c` | `f86c2ab2e5798a9ce4d43aa2a86b3237466474c09d1cc3393ae0eb414bc275cc` |
| `direct-porffor-bump` | 105517 | 343 | 75968 | 73736 | `9edf0adba0ea04679b3eb76adc375da533467ff409879b50f0f90854c4ed0517` | `6042e033b1142b0acc9ff0bb48f4e9f9d2640e3e0c7259d7391ded6e2edfacf0` |
| `js2-porffor-arena-v1` | 28608 | 210 | 2280 | 34056 | `fd43fd5171762861d587bb868afb0cd66208a41efaadcb48e21f0041cc09e624` | `2959a4eef72690346b11a7ed964b4323dbc849998e95537a2a56ffd6c5ef3ea5` |
| `js2-porffor-analysis-stack-arena-v1` | 29781 | 210 | 3880 | 34056 | `d065162c11264315b2cf8876883246d34c153eee310d6d9396c43d9af3afe157` | `926fb6c9904256c3712a5c058ff8e8547d08505a03bed9f3bf5ef3e7c4406489` |

## Interpretation boundary

The direct rows use ordinary TypeScript numbers boxed as Porffor `jsval`, including two asserted hidden call slots, dynamic objects of approximately 56 bytes, and a global GC-or-bump policy. Their 20-byte entry stride places the second `f64` payload at byte offset 28, violating its 8-byte alignment; the generated raw loads/stores are deliberately not repaired. The JS2 rows use a raw `f64` boundary, 24-byte fixed records (8-byte header plus two `f64` fields), and per-site escape-based stack promotion. Therefore direct-vs-JS2 conflates front end, value ABI, layout, generated IR, allocator, and known direct undefined behavior. **Only `js2-porffor-arena-v1` versus `js2-porffor-analysis-stack-arena-v1` isolates allocation policy.**

#3300 remains the hand-built-IR policy proof; its source paths and compile timing differ, so it is not evidence for this direct compiler A/B.

The complete raw warmups, all measured samples, actual interleave order, environment, and command provenance are in [latest.json](./latest.json). Representative C, wrappers, objects, executables, and logs are retained in the workflow/local artifact directory.
