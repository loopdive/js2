# js2wasm Benchmark Results

Date: 2026-08-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.045ms | 0.036ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.079ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.156ms | 0.021ms | FAILED | js |
| string/split | 0.413ms | 5.69ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.348ms | 0.084ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.256ms | 0.120ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.925ms | 0.246ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.88ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.50ms | 0.514ms | 0.513ms | FAILED | gc-native |
| array/sort-i32 | 0.796ms | 0.334ms | 0.334ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.549ms | 0.551ms | FAILED | js |
| array/reduce | 1.38ms | 0.512ms | 0.512ms | FAILED | host-call |
| array/indexOf | 3.94ms | 0.013ms | 0.013ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.240ms | 0.017ms | 0.017ms | 1.09ms | host-call |
| dom/create-elements | 0.036ms | 0.292ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.364ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.175ms | — | — | js |
| dom/modify-text | 0.048ms | 0.164ms | — | — | js |
| mixed/csv-parse | 0.481ms | 8.54ms | 0.811ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.51ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.087ms | host-call |
| mixed/matrix-multiply | 0.158ms | 0.191ms | 0.207ms | 0.732ms | js |
| mixed/sieve | 1.60ms | 1.41ms | 1.39ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.83 | 4.52 | 3.62 | — |
| string/concat-long | 1000 | 3.58 | 4.50 | 4.43 | — |
| string/indexOf | 1000 | 19.14 | 79.01 | 20.94 | — |
| string/includes | 1000 | 19.18 | 155.58 | 20.79 | — |
| string/split | 10000 | 41.31 | 569.47 | 44.95 | — |
| string/replace | 1000 | 104.18 | 347.89 | 84.32 | — |
| string/case-convert | 2000 | 27.93 | 128.01 | 60.21 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.00 | 92.50 | 24.60 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 144.21 | 14.31 | — |
| mixed/csv-parse | 11000 | 43.74 | 776.59 | 73.73 | — |
| mixed/text-search | 40000 | 9.72 | 62.77 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.17 | 4.40 | 4.40 | 8.69 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.53 | 1.66 | 5.86 |
| mixed/sieve | 200000 | 8.01 | 7.04 | 6.97 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.60x slower | 1.28x slower | — |
| string/concat-long | 1.26x slower | 1.24x slower | — |
| string/indexOf | 4.13x slower | 1.09x slower | — |
| string/includes | 8.11x slower | 1.08x slower | — |
| string/split | 13.78x slower | 1.09x slower | — |
| string/replace | 3.34x slower | 1.24x faster | — |
| string/case-convert | 4.58x slower | 2.16x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.44x slower | 1.45x slower | — |
| string/startsWith-endsWith | 7.19x slower | 1.40x faster | — |
| array/push-pop | 2.92x faster | 2.93x faster | — |
| array/sort-i32 | 2.38x faster | 2.38x faster | — |
| array/map-filter | 4.19x slower | 4.21x slower | — |
| array/reduce | 2.70x faster | 2.70x faster | — |
| array/indexOf | 310.22x faster | 301.91x faster | — |
| array/slice | 1.06x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.86x faster | 1.86x faster | — |
| array/find | 13.97x faster | 13.95x faster | 4.53x slower |
| dom/create-elements | 8.08x slower | — | — |
| dom/set-attributes | 3.51x slower | — | — |
| dom/read-attributes | 3.14x slower | — | — |
| dom/modify-text | 3.39x slower | — | — |
| mixed/csv-parse | 17.75x slower | 1.69x slower | — |
| mixed/text-search | 6.46x slower | 1.18x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 1.40x faster |
| mixed/matrix-multiply | 1.21x slower | 1.32x slower | 4.64x slower |
| mixed/sieve | 1.14x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.25x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 3.77x faster |
| string/includes | 7.48x faster |
| string/split | 12.67x faster |
| string/replace | 4.13x faster |
| string/case-convert | 2.13x faster |
| string/substring | 1.21x faster |
| string/trim | 3.76x faster |
| string/startsWith-endsWith | 10.07x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.03x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 10.53x faster |
| mixed/text-search | 7.65x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.0KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 834B | 1.1KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.8KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1341.0ms | 1123.8ms | — |
| string/concat-long | 633.1ms | 1018.6ms | — |
| string/indexOf | 796.5ms | 1046.7ms | — |
| string/includes | 781.1ms | 1027.8ms | — |
| string/split | 770.7ms | 1006.4ms | — |
| string/replace | 850.0ms | 1162.7ms | — |
| string/case-convert | 814.3ms | 1195.2ms | — |
| string/substring | 663.1ms | 760.3ms | — |
| string/trim | 750.8ms | 998.6ms | — |
| string/startsWith-endsWith | 745.2ms | 1009.5ms | — |
| array/push-pop | 772.4ms | 838.4ms | — |
| array/sort-i32 | 942.4ms | 1000.2ms | — |
| array/map-filter | 924.7ms | 1052.1ms | — |
| array/reduce | 880.6ms | 912.6ms | — |
| array/indexOf | 775.5ms | 846.7ms | — |
| array/slice | 794.5ms | 865.9ms | — |
| array/reverse | 787.4ms | 863.9ms | — |
| array/forEach | 859.9ms | 997.2ms | — |
| array/find | 769.8ms | 843.7ms | 846.4ms |
| dom/create-elements | 635.6ms | — | — |
| dom/set-attributes | 740.2ms | — | — |
| dom/read-attributes | 680.7ms | — | — |
| dom/modify-text | 689.8ms | — | — |
| mixed/csv-parse | 809.2ms | 1021.6ms | — |
| mixed/text-search | 773.9ms | 1081.1ms | — |
| mixed/fibonacci | 779.3ms | 806.1ms | 753.6ms |
| mixed/matrix-multiply | 861.2ms | 919.8ms | 834.3ms |
| mixed/sieve | 840.7ms | 907.2ms | — |
