# js2wasm Benchmark Results

Date: 2026-09-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.047ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.114ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.435ms | 8.44ms | 2.83ms | FAILED | js |
| string/replace | 0.104ms | 0.705ms | 0.310ms | FAILED | js |
| string/case-convert | 0.056ms | 0.572ms | 0.251ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.95ms | 2.78ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.88ms | 2.90ms | 0.561ms | js |
| array/push-pop | 1.41ms | 0.503ms | 0.509ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.497ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.18ms | 0.500ms | 0.501ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.572ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.48ms | 0.596ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.99ms | 2.81ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 73.62ms | 73.50ms | 0.718ms | js |
| mixed/sieve | 1.62ms | 2.13ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.66 | 4.71 | 4.55 | — |
| string/concat-long | 1000 | 3.63 | 4.58 | 3.62 | — |
| string/indexOf | 1000 | 19.15 | 64.36 | 12.27 | 15.32 |
| string/includes | 1000 | 19.18 | 114.30 | 14.71 | 15.98 |
| string/split | 10000 | 43.50 | 843.54 | 282.54 | — |
| string/replace | 1000 | 103.78 | 704.83 | 309.80 | — |
| string/case-convert | 2000 | 27.89 | 285.94 | 125.48 | — |
| string/substring | 10000 | 9.91 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.01 | 394.90 | 277.55 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 143.79 | 145.23 | 28.05 |
| array/map-filter | 30000 | 4.48 | 2.35 | 2.32 | — |
| array/indexOf | 1000 | 3956.45 | 2642.92 | 2641.68 | — |
| dom/create-elements | 2000 | 18.00 | 77.05 | — | — |
| dom/set-attributes | 6000 | 17.39 | 95.32 | — | — |
| dom/read-attributes | 3000 | 18.49 | 40.91 | — | — |
| dom/modify-text | 2000 | 14.51 | 57.69 | — | — |
| mixed/csv-parse | 11000 | 44.19 | 770.51 | 54.15 | — |
| mixed/text-search | 40000 | 9.75 | 124.77 | 70.18 | 27.19 |
| mixed/fibonacci | 10000 | 12.18 | 28.30 | 28.32 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 588.97 | 587.99 | 5.74 |
| mixed/sieve | 200000 | 8.12 | 10.64 | 10.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.29x slower | 1.24x slower | — |
| string/concat-long | 1.26x slower | 1.00x faster | — |
| string/indexOf | 3.36x slower | 1.56x faster | 1.25x faster |
| string/includes | 5.96x slower | 1.30x faster | 1.20x faster |
| string/split | 19.39x slower | 6.50x slower | — |
| string/replace | 6.79x slower | 2.99x slower | — |
| string/case-convert | 10.25x slower | 4.50x slower | — |
| string/substring | 2.64x faster | 3.23x faster | — |
| string/trim | 23.21x slower | 16.31x slower | — |
| string/startsWith-endsWith | 7.18x slower | 7.25x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.78x faster | — |
| array/sort-i32 | 1.60x faster | 2.71x faster | — |
| array/map-filter | 1.91x faster | 1.93x faster | — |
| array/reduce | 4.36x faster | 4.35x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.03x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.83x faster | 1.85x faster | — |
| array/find | 15.91x faster | 16.01x faster | 4.25x slower |
| dom/create-elements | 4.28x slower | — | — |
| dom/set-attributes | 5.48x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.98x slower | — | — |
| mixed/csv-parse | 17.44x slower | 1.23x slower | — |
| mixed/text-search | 12.79x slower | 7.19x slower | 2.79x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 466.75x slower | 465.98x slower | 4.55x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.26x faster |
| string/indexOf | 5.24x faster |
| string/includes | 7.77x faster |
| string/split | 2.99x faster |
| string/replace | 2.28x faster |
| string/case-convert | 2.28x faster |
| string/substring | 1.22x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.70x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.23x faster |
| mixed/text-search | 1.78x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1757.3ms | 1105.7ms | — |
| string/concat-long | 801.1ms | 994.6ms | — |
| string/indexOf | 690.2ms | 973.5ms | 868.9ms |
| string/includes | 681.2ms | 1010.8ms | 863.7ms |
| string/split | 787.5ms | 993.2ms | — |
| string/replace | 814.9ms | 1102.8ms | — |
| string/case-convert | 813.3ms | 894.7ms | — |
| string/substring | 693.6ms | 826.5ms | — |
| string/trim | 787.6ms | 992.2ms | — |
| string/startsWith-endsWith | 781.4ms | 1018.1ms | 953.6ms |
| array/push-pop | 787.5ms | 922.0ms | — |
| array/sort-i32 | 960.4ms | 1068.1ms | — |
| array/map-filter | 969.1ms | 1045.4ms | — |
| array/reduce | 881.1ms | 962.9ms | — |
| array/indexOf | 858.5ms | 967.2ms | — |
| array/slice | 803.0ms | 917.6ms | — |
| array/reverse | 799.2ms | 898.0ms | — |
| array/forEach | 933.9ms | 1078.3ms | — |
| array/find | 799.9ms | 910.0ms | 848.1ms |
| dom/create-elements | 740.8ms | — | — |
| dom/set-attributes | 724.0ms | — | — |
| dom/read-attributes | 711.8ms | — | — |
| dom/modify-text | 704.6ms | — | — |
| mixed/csv-parse | 807.6ms | 997.6ms | — |
| mixed/text-search | 802.9ms | 1028.7ms | 939.0ms |
| mixed/fibonacci | 777.5ms | 863.2ms | 773.0ms |
| mixed/matrix-multiply | 955.6ms | 1006.3ms | 858.6ms |
| mixed/sieve | 911.1ms | 968.2ms | — |
