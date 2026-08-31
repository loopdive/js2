# js2wasm Benchmark Results

Date: 2026-08-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.055ms | 0.053ms | 0.068ms | FAILED | host-call |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.014ms | 0.045ms | 0.010ms | 0.022ms | gc-native |
| string/includes | 0.014ms | 0.090ms | 0.013ms | 0.017ms | gc-native |
| string/split | 0.311ms | 7.03ms | 2.22ms | FAILED | js |
| string/replace | 0.091ms | 0.456ms | 0.252ms | FAILED | js |
| string/case-convert | 0.045ms | 0.417ms | 0.204ms | FAILED | js |
| string/substring | 0.095ms | 0.033ms | 0.028ms | FAILED | gc-native |
| string/trim | 0.151ms | 3.00ms | 2.13ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 2.31ms | 2.29ms | 0.536ms | js |
| array/push-pop | 1.40ms | 0.470ms | 0.473ms | FAILED | host-call |
| array/sort-i32 | 0.611ms | 0.320ms | 0.559ms | FAILED | host-call |
| array/map-filter | 0.136ms | 0.079ms | 0.078ms | FAILED | gc-native |
| array/reduce | 2.01ms | 0.467ms | 0.462ms | FAILED | gc-native |
| array/indexOf | 5.05ms | 2.49ms | 2.47ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.041ms | 0.039ms | FAILED | js |
| array/reverse | 7.93ms | 3.57ms | 3.57ms | FAILED | gc-native |
| array/forEach | 0.060ms | 0.025ms | 0.024ms | FAILED | gc-native |
| array/find | 0.278ms | 0.016ms | 0.016ms | 0.928ms | host-call |
| dom/create-elements | 0.066ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.128ms | 0.459ms | — | — | js |
| dom/read-attributes | 0.072ms | 0.112ms | — | — | js |
| dom/modify-text | 0.059ms | 0.099ms | — | — | js |
| mixed/csv-parse | 0.381ms | 6.69ms | 0.527ms | FAILED | js |
| mixed/text-search | 0.396ms | 3.63ms | 2.32ms | 1.10ms | js |
| mixed/fibonacci | 0.129ms | 0.203ms | 0.203ms | 1.000ms | js |
| mixed/matrix-multiply | 0.180ms | 56.56ms | 56.29ms | 0.680ms | js |
| mixed/sieve | 1.58ms | 2.32ms | 2.30ms | FAILED | js |

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
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 5.48 | 5.30 | 6.84 | — |
| string/concat-long | 1000 | 5.04 | 5.49 | 6.41 | — |
| string/indexOf | 1000 | 14.40 | 45.43 | 10.21 | 22.29 |
| string/includes | 1000 | 14.34 | 90.22 | 12.54 | 17.07 |
| string/split | 10000 | 31.07 | 702.77 | 221.90 | — |
| string/replace | 1000 | 90.73 | 455.94 | 251.64 | — |
| string/case-convert | 2000 | 22.35 | 208.48 | 102.08 | — |
| string/substring | 10000 | 9.53 | 3.33 | 2.79 | — |
| string/trim | 10000 | 15.13 | 299.71 | 213.46 | — |
| string/startsWith-endsWith | 20000 | 21.44 | 115.65 | 114.38 | 26.81 |
| array/map-filter | 30000 | 4.54 | 2.63 | 2.60 | — |
| array/indexOf | 1000 | 5054.56 | 2486.83 | 2466.75 | — |
| dom/create-elements | 2000 | 32.99 | 77.72 | — | — |
| dom/set-attributes | 6000 | 21.30 | 76.46 | — | — |
| dom/read-attributes | 3000 | 24.11 | 37.26 | — | — |
| dom/modify-text | 2000 | 29.45 | 49.55 | — | — |
| mixed/csv-parse | 11000 | 34.67 | 608.54 | 47.95 | — |
| mixed/text-search | 40000 | 9.90 | 90.85 | 57.96 | 27.58 |
| mixed/fibonacci | 10000 | 12.90 | 20.32 | 20.34 | 99.96 |
| mixed/matrix-multiply | 125000 | 1.44 | 452.50 | 450.34 | 5.44 |
| mixed/sieve | 200000 | 7.90 | 11.60 | 11.52 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x faster | 1.25x slower | — |
| string/concat-long | 1.09x slower | 1.27x slower | — |
| string/indexOf | 3.16x slower | 1.41x faster | 1.55x slower |
| string/includes | 6.29x slower | 1.14x faster | 1.19x slower |
| string/split | 22.62x slower | 7.14x slower | — |
| string/replace | 5.03x slower | 2.77x slower | — |
| string/case-convert | 9.33x slower | 4.57x slower | — |
| string/substring | 2.86x faster | 3.42x faster | — |
| string/trim | 19.80x slower | 14.11x slower | — |
| string/startsWith-endsWith | 5.39x slower | 5.33x slower | 1.25x slower |
| array/push-pop | 2.98x faster | 2.96x faster | — |
| array/sort-i32 | 1.91x faster | 1.09x faster | — |
| array/map-filter | 1.72x faster | 1.74x faster | — |
| array/reduce | 4.30x faster | 4.34x faster | — |
| array/indexOf | 2.03x faster | 2.05x faster | — |
| array/slice | 1.16x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.43x faster | 2.46x faster | — |
| array/find | 16.95x faster | 16.84x faster | 3.34x slower |
| dom/create-elements | 2.36x slower | — | — |
| dom/set-attributes | 3.59x slower | — | — |
| dom/read-attributes | 1.55x slower | — | — |
| dom/modify-text | 1.68x slower | — | — |
| mixed/csv-parse | 17.55x slower | 1.38x slower | — |
| mixed/text-search | 9.18x slower | 5.85x slower | 2.79x slower |
| mixed/fibonacci | 1.58x slower | 1.58x slower | 7.75x slower |
| mixed/matrix-multiply | 314.60x slower | 313.10x slower | 3.78x slower |
| mixed/sieve | 1.47x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.29x slower |
| string/concat-long | 1.17x slower |
| string/indexOf | 4.45x faster |
| string/includes | 7.19x faster |
| string/split | 3.17x faster |
| string/replace | 1.81x faster |
| string/case-convert | 2.04x faster |
| string/substring | 1.19x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.75x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.01x faster |
| array/slice | 1.05x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 12.69x faster |
| mixed/text-search | 1.57x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.4KB | 3.0KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1401.2ms | 914.9ms | — |
| string/concat-long | 650.5ms | 832.0ms | — |
| string/indexOf | 588.0ms | 826.1ms | 720.2ms |
| string/includes | 567.9ms | 848.9ms | 735.4ms |
| string/split | 672.2ms | 852.0ms | — |
| string/replace | 689.5ms | 934.4ms | — |
| string/case-convert | 679.1ms | 761.3ms | — |
| string/substring | 570.1ms | 699.5ms | — |
| string/trim | 679.3ms | 849.6ms | — |
| string/startsWith-endsWith | 662.0ms | 839.5ms | 812.8ms |
| array/push-pop | 697.2ms | 791.1ms | — |
| array/sort-i32 | 845.2ms | 914.9ms | — |
| array/map-filter | 895.7ms | 978.3ms | — |
| array/reduce | 783.1ms | 892.1ms | — |
| array/indexOf | 782.3ms | 861.7ms | — |
| array/slice | 712.5ms | 829.6ms | — |
| array/reverse | 714.7ms | 808.5ms | — |
| array/forEach | 823.1ms | 923.6ms | — |
| array/find | 704.9ms | 786.5ms | 773.9ms |
| dom/create-elements | 632.3ms | — | — |
| dom/set-attributes | 667.4ms | — | — |
| dom/read-attributes | 637.5ms | — | — |
| dom/modify-text | 598.4ms | — | — |
| mixed/csv-parse | 722.3ms | 876.5ms | — |
| mixed/text-search | 744.0ms | 920.0ms | 867.7ms |
| mixed/fibonacci | 664.3ms | 724.1ms | 694.9ms |
| mixed/matrix-multiply | 900.1ms | 916.2ms | 759.0ms |
| mixed/sieve | 799.6ms | 858.2ms | — |
