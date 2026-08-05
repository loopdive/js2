# js2wasm Benchmark Results

Date: 2026-08-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.049ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.077ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.152ms | 0.021ms | FAILED | js |
| string/split | 0.412ms | 5.71ms | 0.449ms | FAILED | js |
| string/replace | 0.111ms | 0.328ms | 0.085ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.268ms | 0.120ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.902ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.81ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.48ms | 0.508ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.333ms | 0.335ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.549ms | 0.551ms | FAILED | js |
| array/reduce | 2.15ms | 0.505ms | 0.507ms | FAILED | host-call |
| array/indexOf | 3.95ms | 3.78ms | 3.78ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.240ms | 0.017ms | 0.017ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.292ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.368ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.170ms | — | — | js |
| dom/modify-text | 0.048ms | 0.159ms | — | — | js |
| mixed/csv-parse | 0.473ms | 8.50ms | 0.818ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.42ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.087ms | host-call |
| mixed/matrix-multiply | 0.157ms | 0.191ms | 0.191ms | 0.722ms | js |
| mixed/sieve | 1.57ms | 1.39ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.96 | 4.87 | 3.96 | — |
| string/concat-long | 1000 | 3.78 | 4.48 | 4.59 | — |
| string/indexOf | 1000 | 19.18 | 77.24 | 20.94 | — |
| string/includes | 1000 | 19.19 | 151.78 | 20.91 | — |
| string/split | 10000 | 41.20 | 571.03 | 44.93 | — |
| string/replace | 1000 | 110.52 | 328.25 | 85.08 | — |
| string/case-convert | 2000 | 27.88 | 133.81 | 60.10 | — |
| string/substring | 10000 | 9.91 | 3.76 | 3.08 | — |
| string/trim | 10000 | 17.06 | 90.18 | 24.34 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 140.26 | 14.35 | — |
| array/map-filter | 30000 | 4.32 | 18.29 | 18.35 | — |
| array/indexOf | 1000 | 3947.18 | 3777.61 | 3778.39 | — |
| dom/create-elements | 2000 | 17.89 | 145.81 | — | — |
| dom/set-attributes | 6000 | 17.71 | 61.34 | — | — |
| dom/read-attributes | 3000 | 17.91 | 56.70 | — | — |
| dom/modify-text | 2000 | 23.98 | 79.68 | — | — |
| mixed/csv-parse | 11000 | 42.97 | 773.06 | 74.32 | — |
| mixed/text-search | 40000 | 9.74 | 60.40 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 4.40 | 4.40 | 8.70 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.53 | 1.53 | 5.77 |
| mixed/sieve | 200000 | 7.87 | 6.95 | 7.01 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.65x slower | 1.34x slower | — |
| string/concat-long | 1.19x slower | 1.21x slower | — |
| string/indexOf | 4.03x slower | 1.09x slower | — |
| string/includes | 7.91x slower | 1.09x slower | — |
| string/split | 13.86x slower | 1.09x slower | — |
| string/replace | 2.97x slower | 1.30x faster | — |
| string/case-convert | 4.80x slower | 2.16x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.29x slower | 1.43x slower | — |
| string/startsWith-endsWith | 7.00x slower | 1.40x faster | — |
| array/push-pop | 2.92x faster | 2.94x faster | — |
| array/sort-i32 | 2.37x faster | 2.36x faster | — |
| array/map-filter | 4.23x slower | 4.25x slower | — |
| array/reduce | 4.26x faster | 4.24x faster | — |
| array/indexOf | 1.04x faster | 1.04x faster | — |
| array/slice | 1.05x slower | 1.11x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.07x faster | 3.08x faster | — |
| array/find | 14.35x faster | 14.43x faster | 4.49x slower |
| dom/create-elements | 8.15x slower | — | — |
| dom/set-attributes | 3.46x slower | — | — |
| dom/read-attributes | 3.17x slower | — | — |
| dom/modify-text | 3.32x slower | — | — |
| mixed/csv-parse | 17.99x slower | 1.73x slower | — |
| mixed/text-search | 6.20x slower | 1.19x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 1.40x faster |
| mixed/matrix-multiply | 1.22x slower | 1.22x slower | 4.59x slower |
| mixed/sieve | 1.13x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.02x slower |
| string/indexOf | 3.69x faster |
| string/includes | 7.26x faster |
| string/split | 12.71x faster |
| string/replace | 3.86x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.22x faster |
| string/trim | 3.70x faster |
| string/startsWith-endsWith | 9.77x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.06x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 10.40x faster |
| mixed/text-search | 7.36x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| array/indexOf | 1.1KB | 1.4KB | — |
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
| string/concat-short | 1338.6ms | 1145.8ms | — |
| string/concat-long | 647.1ms | 957.7ms | — |
| string/indexOf | 768.4ms | 996.6ms | — |
| string/includes | 774.1ms | 974.7ms | — |
| string/split | 779.4ms | 966.9ms | — |
| string/replace | 878.2ms | 1147.9ms | — |
| string/case-convert | 814.7ms | 1130.1ms | — |
| string/substring | 674.3ms | 842.6ms | — |
| string/trim | 784.4ms | 1043.5ms | — |
| string/startsWith-endsWith | 752.1ms | 1007.9ms | — |
| array/push-pop | 786.5ms | 881.8ms | — |
| array/sort-i32 | 971.7ms | 1015.5ms | — |
| array/map-filter | 905.2ms | 997.5ms | — |
| array/reduce | 828.7ms | 877.6ms | — |
| array/indexOf | 825.8ms | 909.1ms | — |
| array/slice | 782.5ms | 848.2ms | — |
| array/reverse | 792.5ms | 838.7ms | — |
| array/forEach | 845.1ms | 919.5ms | — |
| array/find | 745.9ms | 809.0ms | 840.2ms |
| dom/create-elements | 605.8ms | — | — |
| dom/set-attributes | 722.7ms | — | — |
| dom/read-attributes | 690.6ms | — | — |
| dom/modify-text | 701.3ms | — | — |
| mixed/csv-parse | 797.9ms | 1022.1ms | — |
| mixed/text-search | 794.4ms | 1034.1ms | — |
| mixed/fibonacci | 759.9ms | 792.2ms | 761.0ms |
| mixed/matrix-multiply | 869.6ms | 896.0ms | 818.8ms |
| mixed/sieve | 870.7ms | 893.2ms | — |
