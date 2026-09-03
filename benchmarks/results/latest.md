# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.039ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.013ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.103ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.412ms | 8.29ms | 2.78ms | FAILED | js |
| string/replace | 0.105ms | 0.694ms | 0.311ms | FAILED | js |
| string/case-convert | 0.056ms | 0.576ms | 0.263ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.90ms | 2.67ms | FAILED | js |
| string/startsWith-endsWith | 0.405ms | 2.82ms | 2.91ms | 0.561ms | js |
| array/push-pop | 1.51ms | 0.519ms | 0.517ms | FAILED | gc-native |
| array/sort-i32 | 0.807ms | 0.294ms | 0.295ms | FAILED | host-call |
| array/map-filter | 0.145ms | 0.074ms | 0.074ms | FAILED | gc-native |
| array/reduce | 2.24ms | 0.526ms | 0.535ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.031ms | 0.031ms | FAILED | gc-native |
| array/reverse | 7.92ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.098ms | 0.031ms | 0.030ms | FAILED | gc-native |
| array/find | 0.266ms | 0.018ms | 0.017ms | 1.09ms | gc-native |
| dom/create-elements | 0.043ms | 0.158ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.581ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.119ms | — | — | js |
| dom/modify-text | 0.034ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.62ms | 0.623ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.21ms | 3.03ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.163ms | 73.02ms | 70.75ms | 0.718ms | js |
| mixed/sieve | 1.69ms | 2.20ms | 2.18ms | FAILED | js |

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
| string/concat-short | 10000 | 3.87 | 4.83 | 4.44 | — |
| string/concat-long | 1000 | 3.81 | 4.70 | 4.41 | — |
| string/indexOf | 1000 | 19.27 | 63.81 | 12.72 | 16.90 |
| string/includes | 1000 | 19.34 | 103.17 | 15.13 | 15.42 |
| string/split | 10000 | 41.23 | 828.55 | 278.04 | — |
| string/replace | 1000 | 105.42 | 693.57 | 311.02 | — |
| string/case-convert | 2000 | 28.08 | 287.95 | 131.73 | — |
| string/substring | 10000 | 9.91 | 3.74 | 3.14 | — |
| string/trim | 10000 | 17.05 | 390.45 | 267.43 | — |
| string/startsWith-endsWith | 20000 | 20.26 | 140.88 | 145.62 | 28.06 |
| array/map-filter | 30000 | 4.84 | 2.46 | 2.45 | — |
| array/indexOf | 1000 | 3957.54 | 2647.79 | 2641.64 | — |
| dom/create-elements | 2000 | 21.28 | 78.89 | — | — |
| dom/set-attributes | 6000 | 18.31 | 96.76 | — | — |
| dom/read-attributes | 3000 | 18.92 | 39.83 | — | — |
| dom/modify-text | 2000 | 16.98 | 53.84 | — | — |
| mixed/csv-parse | 11000 | 44.21 | 783.80 | 56.62 | — |
| mixed/text-search | 40000 | 9.75 | 130.29 | 75.68 | 27.09 |
| mixed/fibonacci | 10000 | 12.17 | 28.28 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.30 | 584.15 | 565.96 | 5.74 |
| mixed/sieve | 200000 | 8.47 | 11.02 | 10.89 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.25x slower | 1.15x slower | — |
| string/concat-long | 1.23x slower | 1.16x slower | — |
| string/indexOf | 3.31x slower | 1.52x faster | 1.14x faster |
| string/includes | 5.33x slower | 1.28x faster | 1.25x faster |
| string/split | 20.10x slower | 6.74x slower | — |
| string/replace | 6.58x slower | 2.95x slower | — |
| string/case-convert | 10.25x slower | 4.69x slower | — |
| string/substring | 2.65x faster | 3.16x faster | — |
| string/trim | 22.90x slower | 15.69x slower | — |
| string/startsWith-endsWith | 6.95x slower | 7.19x slower | 1.39x slower |
| array/push-pop | 2.91x faster | 2.92x faster | — |
| array/sort-i32 | 2.74x faster | 2.74x faster | — |
| array/map-filter | 1.97x faster | 1.97x faster | — |
| array/reduce | 4.26x faster | 4.18x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.01x faster | 1.01x faster | — |
| array/reverse | 2.25x faster | 2.25x faster | — |
| array/forEach | 3.21x faster | 3.23x faster | — |
| array/find | 14.43x faster | 15.41x faster | 4.10x slower |
| dom/create-elements | 3.71x slower | — | — |
| dom/set-attributes | 5.28x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.17x slower | — | — |
| mixed/csv-parse | 17.73x slower | 1.28x slower | — |
| mixed/text-search | 13.37x slower | 7.76x slower | 2.78x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 448.97x slower | 434.99x slower | 4.41x slower |
| mixed/sieve | 1.30x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.07x faster |
| string/indexOf | 5.02x faster |
| string/includes | 6.82x faster |
| string/split | 2.98x faster |
| string/replace | 2.23x faster |
| string/case-convert | 2.19x faster |
| string/substring | 1.19x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.07x faster |
| mixed/csv-parse | 13.84x faster |
| mixed/text-search | 1.72x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x faster |
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
| array/indexOf | 1.8KB | 2.1KB | — |
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
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1741.0ms | 1107.7ms | — |
| string/concat-long | 814.3ms | 1052.7ms | — |
| string/indexOf | 703.0ms | 1045.0ms | 900.6ms |
| string/includes | 703.0ms | 1038.7ms | 871.7ms |
| string/split | 838.1ms | 1033.2ms | — |
| string/replace | 844.7ms | 1147.6ms | — |
| string/case-convert | 834.7ms | 961.9ms | — |
| string/substring | 717.6ms | 805.4ms | — |
| string/trim | 816.9ms | 1035.2ms | — |
| string/startsWith-endsWith | 828.2ms | 1006.2ms | 936.4ms |
| array/push-pop | 820.7ms | 943.3ms | — |
| array/sort-i32 | 975.2ms | 1030.7ms | — |
| array/map-filter | 984.6ms | 1027.2ms | — |
| array/reduce | 899.7ms | 1015.4ms | — |
| array/indexOf | 912.2ms | 1001.4ms | — |
| array/slice | 856.8ms | 907.1ms | — |
| array/reverse | 828.9ms | 922.4ms | — |
| array/forEach | 948.9ms | 965.1ms | — |
| array/find | 865.3ms | 933.8ms | 913.3ms |
| dom/create-elements | 756.9ms | — | — |
| dom/set-attributes | 784.1ms | — | — |
| dom/read-attributes | 751.3ms | — | — |
| dom/modify-text | 716.4ms | — | — |
| mixed/csv-parse | 872.9ms | 1044.2ms | — |
| mixed/text-search | 826.1ms | 1027.0ms | 971.9ms |
| mixed/fibonacci | 779.1ms | 850.3ms | 789.8ms |
| mixed/matrix-multiply | 935.2ms | 1029.3ms | 869.9ms |
| mixed/sieve | 920.6ms | 1012.0ms | — |
