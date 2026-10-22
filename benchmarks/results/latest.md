# js2wasm Benchmark Results

Date: 2026-10-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.038ms | 0.052ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.017ms | 0.017ms | 0.016ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.413ms | 0.409ms | 0.407ms | FAILED | gc-native |
| string/replace | 0.102ms | 0.054ms | 0.054ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.562ms | gc-native |
| array/push-pop | 1.39ms | 0.500ms | 0.505ms | FAILED | host-call |
| array/sort-i32 | 0.789ms | 0.395ms | 0.395ms | FAILED | gc-native |
| array/map-filter | 0.126ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.501ms | 0.499ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.253ms | 0.012ms | 0.012ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.910ms | — | — | js |
| dom/set-attributes | 0.104ms | 6.65ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.65ms | — | — | js |
| mixed/csv-parse | 1.54ms | 0.316ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 0.263ms | 0.263ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.162ms | 0.213ms | 0.215ms | 0.718ms | js |
| mixed/sieve | 1.59ms | 2.10ms | 2.16ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| dom/read-attributes | host-call | warmup | dereferencing a null pointer |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.81 | 5.17 | 4.55 | — |
| string/concat-long | 1000 | 3.71 | 3.07 | 3.05 | — |
| string/indexOf | 1000 | 19.17 | 16.52 | 16.52 | 15.69 |
| string/includes | 1000 | 19.18 | 21.02 | 21.00 | 15.39 |
| string/split | 10000 | 41.30 | 40.92 | 40.73 | — |
| string/replace | 1000 | 101.56 | 54.42 | 54.44 | — |
| string/case-convert | 2000 | 27.88 | 3.27 | 3.27 | — |
| string/substring | 10000 | 9.89 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.03 | 16.30 | 16.26 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 11.01 | 10.99 | 28.08 |
| array/map-filter | 30000 | 4.20 | 2.50 | 2.70 | — |
| array/indexOf | 1000 | 3950.29 | 2638.42 | 2641.08 | — |
| dom/create-elements | 2000 | 17.59 | 455.13 | — | — |
| dom/set-attributes | 6000 | 17.40 | 1108.96 | — | — |
| dom/read-attributes | 3000 | 18.51 | — | — | — |
| dom/modify-text | 2000 | 14.75 | 825.54 | — | — |
| mixed/csv-parse | 11000 | 140.06 | 28.73 | 28.61 | — |
| mixed/text-search | 40000 | 9.72 | 6.57 | 6.56 | 27.22 |
| mixed/fibonacci | 10000 | 12.02 | 28.33 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.71 | 1.72 | 5.74 |
| mixed/sieve | 200000 | 7.94 | 10.49 | 10.81 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.36x slower | 1.19x slower | — |
| string/concat-long | 1.21x faster | 1.21x faster | — |
| string/indexOf | 1.16x faster | 1.16x faster | 1.22x faster |
| string/includes | 1.10x slower | 1.10x slower | 1.25x faster |
| string/split | 1.01x faster | 1.01x faster | — |
| string/replace | 1.87x faster | 1.87x faster | — |
| string/case-convert | 8.51x faster | 8.52x faster | — |
| string/substring | 3.22x faster | 3.22x faster | — |
| string/trim | 1.04x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.77x faster | 2.74x faster | — |
| array/sort-i32 | 2.00x faster | 2.00x faster | — |
| array/map-filter | 1.68x faster | 1.55x faster | — |
| array/reduce | 2.67x faster | 2.68x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 21.58x faster | 21.40x faster | 4.25x slower |
| dom/create-elements | 25.88x slower | — | — |
| dom/set-attributes | 63.74x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 55.97x slower | — | — |
| mixed/csv-parse | 4.88x faster | 4.90x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.80x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 1.32x slower | 1.33x slower | 4.43x slower |
| mixed/sieve | 1.32x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.03x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.5KB | 1.5KB | — |
| string/concat-long | 18.8KB | 18.8KB | — |
| string/indexOf | 18.9KB | 18.9KB | 10.4KB |
| string/includes | 19.0KB | 19.0KB | 10.4KB |
| string/split | 26.7KB | 26.7KB | — |
| string/replace | 27.5KB | 27.5KB | — |
| string/case-convert | 26.3KB | 26.3KB | — |
| string/substring | 1.0KB | 1.0KB | — |
| string/trim | 26.3KB | 26.3KB | — |
| string/startsWith-endsWith | 27.3KB | 27.3KB | 1.7KB |
| array/push-pop | 25.3KB | 25.3KB | — |
| array/sort-i32 | 28.0KB | 28.0KB | — |
| array/map-filter | 29.1KB | 29.1KB | — |
| array/reduce | 27.6KB | 27.6KB | — |
| array/indexOf | 26.4KB | 26.4KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.8KB | 27.8KB | — |
| array/find | 61.8KB | 61.8KB | 634B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 991B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1403.8ms | 574.2ms | — |
| string/concat-long | 1022.3ms | 956.6ms | — |
| string/indexOf | 955.5ms | 935.7ms | 557.4ms |
| string/includes | 960.5ms | 978.1ms | 552.0ms |
| string/split | 1100.3ms | 1053.7ms | — |
| string/replace | 1095.9ms | 1140.1ms | — |
| string/case-convert | 1056.4ms | 1028.7ms | — |
| string/substring | 509.2ms | 494.9ms | — |
| string/trim | 1016.2ms | 1037.0ms | — |
| string/startsWith-endsWith | 1048.4ms | 1052.3ms | 620.1ms |
| array/push-pop | 1021.8ms | 998.9ms | — |
| array/sort-i32 | 1124.0ms | 1080.0ms | — |
| array/map-filter | 1152.5ms | 1135.9ms | — |
| array/reduce | 1105.0ms | 1106.9ms | — |
| array/indexOf | 1033.2ms | 1030.6ms | — |
| array/slice | 1023.6ms | 1022.2ms | — |
| array/reverse | 1010.9ms | 1003.5ms | — |
| array/forEach | 1085.8ms | 1100.4ms | — |
| array/find | 2361.0ms | 2393.2ms | 546.4ms |
| dom/create-elements | 653.5ms | — | — |
| dom/set-attributes | 582.2ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 573.8ms | — | — |
| mixed/csv-parse | 1055.8ms | 1045.9ms | — |
| mixed/text-search | 1052.2ms | 1088.5ms | 643.1ms |
| mixed/fibonacci | 544.5ms | 531.3ms | 481.1ms |
| mixed/matrix-multiply | 1059.3ms | 1066.3ms | 526.8ms |
| mixed/sieve | 1065.4ms | 1093.5ms | — |
