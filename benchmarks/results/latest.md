# js2wasm Benchmark Results

Date: 2026-08-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.012ms | 0.076ms | gc-native |
| string/includes | 0.019ms | 0.043ms | 0.014ms | 0.065ms | gc-native |
| string/split | 0.413ms | 4.48ms | 0.506ms | FAILED | js |
| string/replace | 0.095ms | 0.217ms | 0.069ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.228ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.926ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.349ms | 0.308ms | 0.552ms | gc-native |
| array/push-pop | 1.63ms | 0.600ms | 0.599ms | FAILED | gc-native |
| array/sort-i32 | 0.846ms | 0.311ms | 0.309ms | FAILED | gc-native |
| array/map-filter | 0.140ms | 0.065ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.40ms | 0.605ms | 0.601ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.87ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.094ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | 0.156ms | — | — | js |
| dom/set-attributes | 0.121ms | 0.541ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.474ms | 6.69ms | 0.308ms | FAILED | gc-native |
| mixed/text-search | 0.404ms | 1.31ms | 0.291ms | 1.11ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.272ms | 0.272ms | 0.282ms | js |
| mixed/matrix-multiply | 0.187ms | 0.210ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.77ms | 1.49ms | 1.49ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.30 | 4.83 | 4.27 | — |
| string/concat-long | 1000 | 4.29 | 5.09 | 3.53 | — |
| string/indexOf | 1000 | 18.98 | 60.84 | 12.40 | 75.86 |
| string/includes | 1000 | 18.73 | 42.78 | 14.43 | 65.17 |
| string/split | 10000 | 41.28 | 447.51 | 50.59 | — |
| string/replace | 1000 | 94.73 | 217.42 | 69.15 | — |
| string/case-convert | 2000 | 28.94 | 113.83 | 2.64 | — |
| string/substring | 10000 | 10.41 | 4.00 | 3.44 | — |
| string/trim | 10000 | 17.34 | 92.61 | 19.67 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 17.43 | 15.42 | 27.61 |
| array/map-filter | 30000 | 4.66 | 2.18 | 2.19 | — |
| array/indexOf | 1000 | 4458.13 | 2866.05 | 2863.12 | — |
| dom/create-elements | 2000 | 19.05 | 77.87 | — | — |
| dom/set-attributes | 6000 | 20.20 | 90.11 | — | — |
| dom/read-attributes | 3000 | 19.66 | 44.70 | — | — |
| dom/modify-text | 2000 | 14.70 | 56.78 | — | — |
| mixed/csv-parse | 11000 | 43.08 | 608.17 | 28.00 | — |
| mixed/text-search | 40000 | 10.11 | 32.68 | 7.28 | 27.72 |
| mixed/fibonacci | 10000 | 12.53 | 27.22 | 27.24 | 28.22 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 8.84 | 7.43 | 7.44 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.29x slower | — |
| string/concat-long | 1.19x slower | 1.22x faster | — |
| string/indexOf | 3.21x slower | 1.53x faster | 4.00x slower |
| string/includes | 2.28x slower | 1.30x faster | 3.48x slower |
| string/split | 10.84x slower | 1.23x slower | — |
| string/replace | 2.30x slower | 1.37x faster | — |
| string/case-convert | 3.93x slower | 10.98x faster | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 5.34x slower | 1.13x slower | — |
| string/startsWith-endsWith | 1.18x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.71x faster | 2.71x faster | — |
| array/sort-i32 | 2.72x faster | 2.73x faster | — |
| array/map-filter | 2.14x faster | 2.13x faster | — |
| array/reduce | 3.97x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.17x faster | 2.07x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.27x faster | 3.27x faster | — |
| array/find | 18.44x faster | 18.40x faster | 4.42x slower |
| dom/create-elements | 4.09x slower | — | — |
| dom/set-attributes | 4.46x slower | — | — |
| dom/read-attributes | 2.27x slower | — | — |
| dom/modify-text | 3.86x slower | — | — |
| mixed/csv-parse | 14.12x slower | 1.54x faster | — |
| mixed/text-search | 3.23x slower | 1.39x faster | 2.74x slower |
| mixed/fibonacci | 2.17x slower | 2.17x slower | 2.25x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.84x slower |
| mixed/sieve | 1.19x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.44x faster |
| string/indexOf | 4.91x faster |
| string/includes | 2.97x faster |
| string/split | 8.85x faster |
| string/replace | 3.14x faster |
| string/case-convert | 43.19x faster |
| string/substring | 1.16x faster |
| string/trim | 4.71x faster |
| string/startsWith-endsWith | 1.13x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 21.72x faster |
| mixed/text-search | 4.49x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 348B | 348B | 340B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1237.1ms | 1038.8ms | — |
| string/concat-long | 615.5ms | 958.2ms | — |
| string/indexOf | 798.3ms | 984.6ms | 824.7ms |
| string/includes | 766.3ms | 961.1ms | 802.3ms |
| string/split | 749.1ms | 1001.0ms | — |
| string/replace | 839.6ms | 1055.9ms | — |
| string/case-convert | 793.2ms | 793.1ms | — |
| string/substring | 627.0ms | 713.1ms | — |
| string/trim | 720.0ms | 961.4ms | — |
| string/startsWith-endsWith | 734.0ms | 935.6ms | 887.3ms |
| array/push-pop | 746.5ms | 808.7ms | — |
| array/sort-i32 | 883.8ms | 973.5ms | — |
| array/map-filter | 867.5ms | 963.9ms | — |
| array/reduce | 804.2ms | 858.0ms | — |
| array/indexOf | 869.7ms | 934.9ms | — |
| array/slice | 737.1ms | 817.0ms | — |
| array/reverse | 738.8ms | 825.0ms | — |
| array/forEach | 828.7ms | 898.5ms | — |
| array/find | 738.1ms | 824.3ms | 802.6ms |
| dom/create-elements | 605.8ms | — | — |
| dom/set-attributes | 703.3ms | — | — |
| dom/read-attributes | 674.3ms | — | — |
| dom/modify-text | 599.6ms | — | — |
| mixed/csv-parse | 760.2ms | 946.6ms | — |
| mixed/text-search | 732.2ms | 990.2ms | 905.1ms |
| mixed/fibonacci | 815.0ms | 827.4ms | 782.6ms |
| mixed/matrix-multiply | 827.6ms | 907.8ms | 769.6ms |
| mixed/sieve | 803.4ms | 845.6ms | — |
