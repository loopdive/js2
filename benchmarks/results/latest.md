# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.023ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.134ms | 0.024ms | FAILED | js |
| string/split | 0.424ms | 5.64ms | 0.450ms | FAILED | js |
| string/replace | 0.114ms | 0.313ms | 0.081ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.246ms | 0.112ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 1.10ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.86ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.47ms | 0.516ms | 0.514ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.302ms | 0.304ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.068ms | 0.068ms | FAILED | gc-native |
| array/reduce | 1.35ms | 0.511ms | 0.512ms | FAILED | host-call |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | host-call |
| array/slice | 0.026ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.239ms | 0.017ms | 0.017ms | 0.998ms | host-call |
| dom/create-elements | 0.208ms | 0.174ms | — | — | host-call |
| dom/set-attributes | 0.105ms | 0.557ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.140ms | — | — | js |
| dom/modify-text | 0.049ms | 0.123ms | — | — | js |
| mixed/csv-parse | 0.492ms | 8.46ms | 0.619ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.59ms | 0.329ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.047ms | linear-memory |
| mixed/matrix-multiply | 0.158ms | 0.192ms | 0.191ms | 0.715ms | js |
| mixed/sieve | 1.57ms | 1.39ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.35 | 4.55 | 3.69 | — |
| string/concat-long | 1000 | 3.60 | 4.56 | 4.46 | — |
| string/indexOf | 1000 | 19.15 | 65.98 | 23.93 | — |
| string/includes | 1000 | 19.18 | 134.46 | 23.52 | — |
| string/split | 10000 | 42.40 | 564.26 | 45.03 | — |
| string/replace | 1000 | 114.26 | 312.99 | 81.10 | — |
| string/case-convert | 2000 | 27.89 | 122.82 | 55.75 | — |
| string/substring | 10000 | 9.90 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.03 | 109.89 | 24.33 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 143.08 | 14.36 | — |
| array/map-filter | 30000 | 4.22 | 2.26 | 2.26 | — |
| array/indexOf | 1000 | 3951.75 | 3549.25 | 3551.45 | — |
| dom/create-elements | 2000 | 103.94 | 86.85 | — | — |
| dom/set-attributes | 6000 | 17.47 | 92.81 | — | — |
| dom/read-attributes | 3000 | 18.58 | 46.60 | — | — |
| dom/modify-text | 2000 | 24.71 | 61.47 | — | — |
| mixed/csv-parse | 11000 | 44.75 | 768.64 | 56.23 | — |
| mixed/text-search | 40000 | 9.72 | 64.65 | 8.23 | — |
| mixed/fibonacci | 10000 | 12.18 | 11.82 | 11.82 | 4.72 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.53 | 1.53 | 5.72 |
| mixed/sieve | 200000 | 7.85 | 6.94 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.94x slower | 1.57x slower | — |
| string/concat-long | 1.27x slower | 1.24x slower | — |
| string/indexOf | 3.45x slower | 1.25x slower | — |
| string/includes | 7.01x slower | 1.23x slower | — |
| string/split | 13.31x slower | 1.06x slower | — |
| string/replace | 2.74x slower | 1.41x faster | — |
| string/case-convert | 4.40x slower | 2.00x slower | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 6.45x slower | 1.43x slower | — |
| string/startsWith-endsWith | 7.14x slower | 1.40x faster | — |
| array/push-pop | 2.85x faster | 2.86x faster | — |
| array/sort-i32 | 2.62x faster | 2.61x faster | — |
| array/map-filter | 1.87x faster | 1.87x faster | — |
| array/reduce | 2.65x faster | 2.64x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.04x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 14.28x faster | 13.84x faster | 4.18x slower |
| dom/create-elements | 1.20x faster | — | — |
| dom/set-attributes | 5.31x slower | — | — |
| dom/read-attributes | 2.51x slower | — | — |
| dom/modify-text | 2.49x slower | — | — |
| mixed/csv-parse | 17.18x slower | 1.26x slower | — |
| mixed/text-search | 6.65x slower | 1.18x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 2.58x faster |
| mixed/matrix-multiply | 1.21x slower | 1.21x slower | 4.52x slower |
| mixed/sieve | 1.13x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 2.76x faster |
| string/includes | 5.72x faster |
| string/split | 12.53x faster |
| string/replace | 3.86x faster |
| string/case-convert | 2.20x faster |
| string/substring | 1.22x faster |
| string/trim | 4.52x faster |
| string/startsWith-endsWith | 9.97x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.03x slower |
| mixed/csv-parse | 13.67x faster |
| mixed/text-search | 7.85x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
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
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1336.7ms | 1119.6ms | — |
| string/concat-long | 636.2ms | 1000.5ms | — |
| string/indexOf | 791.8ms | 1008.4ms | — |
| string/includes | 789.7ms | 1012.1ms | — |
| string/split | 785.9ms | 988.9ms | — |
| string/replace | 833.1ms | 1111.5ms | — |
| string/case-convert | 801.7ms | 1143.5ms | — |
| string/substring | 648.7ms | 754.5ms | — |
| string/trim | 746.8ms | 1047.1ms | — |
| string/startsWith-endsWith | 787.9ms | 1020.1ms | — |
| array/push-pop | 778.8ms | 833.1ms | — |
| array/sort-i32 | 971.0ms | 1035.7ms | — |
| array/map-filter | 948.1ms | 1047.8ms | — |
| array/reduce | 855.4ms | 896.1ms | — |
| array/indexOf | 830.9ms | 919.2ms | — |
| array/slice | 771.5ms | 866.3ms | — |
| array/reverse | 801.4ms | 818.1ms | — |
| array/forEach | 862.4ms | 951.4ms | — |
| array/find | 746.6ms | 809.5ms | 854.0ms |
| dom/create-elements | 647.3ms | — | — |
| dom/set-attributes | 759.0ms | — | — |
| dom/read-attributes | 744.2ms | — | — |
| dom/modify-text | 673.0ms | — | — |
| mixed/csv-parse | 794.6ms | 1032.9ms | — |
| mixed/text-search | 788.8ms | 1028.2ms | — |
| mixed/fibonacci | 805.3ms | 870.7ms | 738.1ms |
| mixed/matrix-multiply | 859.4ms | 878.3ms | 804.9ms |
| mixed/sieve | 815.8ms | 917.8ms | — |
