# js2wasm Benchmark Results

Date: 2026-08-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.079ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.143ms | 0.021ms | FAILED | js |
| string/split | 0.425ms | 5.53ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.336ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.267ms | 0.120ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.176ms | 0.908ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.73ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.45ms | 0.507ms | 0.507ms | FAILED | gc-native |
| array/sort-i32 | 0.794ms | 0.337ms | 0.334ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.546ms | 0.547ms | FAILED | js |
| array/reduce | 1.33ms | 0.500ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.94ms | 0.012ms | 0.012ms | FAILED | host-call |
| array/slice | 0.025ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.239ms | 0.017ms | 0.017ms | 0.995ms | gc-native |
| dom/create-elements | 0.186ms | 0.310ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.372ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.174ms | — | — | js |
| dom/modify-text | 0.050ms | 0.164ms | — | — | js |
| mixed/csv-parse | 0.489ms | 8.79ms | 0.811ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.53ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.157ms | 0.191ms | 0.191ms | 0.717ms | js |
| mixed/sieve | 1.57ms | 1.38ms | 1.38ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.84 | 4.54 | 3.71 | — |
| string/concat-long | 1000 | 3.65 | 4.48 | 4.43 | — |
| string/indexOf | 1000 | 19.13 | 79.04 | 20.70 | — |
| string/includes | 1000 | 19.18 | 143.27 | 20.59 | — |
| string/split | 10000 | 42.55 | 553.12 | 44.91 | — |
| string/replace | 1000 | 104.22 | 336.14 | 82.03 | — |
| string/case-convert | 2000 | 29.66 | 133.72 | 60.19 | — |
| string/substring | 10000 | 9.87 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.59 | 90.76 | 24.35 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 136.45 | 14.33 | — |
| mixed/csv-parse | 11000 | 44.46 | 799.11 | 73.70 | — |
| mixed/text-search | 40000 | 9.72 | 63.13 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 4.40 | 4.40 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.53 | 1.53 | 5.73 |
| mixed/sieve | 200000 | 7.86 | 6.88 | 6.92 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.60x slower | 1.31x slower | — |
| string/concat-long | 1.23x slower | 1.21x slower | — |
| string/indexOf | 4.13x slower | 1.08x slower | — |
| string/includes | 7.47x slower | 1.07x slower | — |
| string/split | 13.00x slower | 1.06x slower | — |
| string/replace | 3.23x slower | 1.27x faster | — |
| string/case-convert | 4.51x slower | 2.03x slower | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 5.16x slower | 1.38x slower | — |
| string/startsWith-endsWith | 6.81x slower | 1.40x faster | — |
| array/push-pop | 2.86x faster | 2.87x faster | — |
| array/sort-i32 | 2.36x faster | 2.38x faster | — |
| array/map-filter | 4.27x slower | 4.28x slower | — |
| array/reduce | 2.67x faster | 2.62x faster | — |
| array/indexOf | 322.75x faster | 319.43x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.74x faster | — |
| array/find | 14.29x faster | 14.41x faster | 4.16x slower |
| dom/create-elements | 1.67x slower | — | — |
| dom/set-attributes | 3.55x slower | — | — |
| dom/read-attributes | 3.14x slower | — | — |
| dom/modify-text | 3.28x slower | — | — |
| mixed/csv-parse | 17.97x slower | 1.66x slower | — |
| mixed/text-search | 6.49x slower | 1.19x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 2.79x faster |
| mixed/matrix-multiply | 1.21x slower | 1.22x slower | 4.55x slower |
| mixed/sieve | 1.14x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 3.82x faster |
| string/includes | 6.96x faster |
| string/split | 12.32x faster |
| string/replace | 4.10x faster |
| string/case-convert | 2.22x faster |
| string/substring | 1.23x faster |
| string/trim | 3.73x faster |
| string/startsWith-endsWith | 9.52x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.01x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 10.84x faster |
| mixed/text-search | 7.70x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1291.9ms | 1100.0ms | — |
| string/concat-long | 653.1ms | 959.0ms | — |
| string/indexOf | 785.3ms | 1019.8ms | — |
| string/includes | 777.5ms | 1020.2ms | — |
| string/split | 751.9ms | 993.0ms | — |
| string/replace | 857.9ms | 1103.8ms | — |
| string/case-convert | 791.5ms | 1160.5ms | — |
| string/substring | 672.4ms | 766.3ms | — |
| string/trim | 729.1ms | 1030.3ms | — |
| string/startsWith-endsWith | 746.1ms | 1016.0ms | — |
| array/push-pop | 769.6ms | 857.2ms | — |
| array/sort-i32 | 948.3ms | 980.3ms | — |
| array/map-filter | 931.8ms | 1005.4ms | — |
| array/reduce | 855.8ms | 888.2ms | — |
| array/indexOf | 739.7ms | 828.7ms | — |
| array/slice | 764.4ms | 836.0ms | — |
| array/reverse | 749.1ms | 829.7ms | — |
| array/forEach | 841.9ms | 950.9ms | — |
| array/find | 750.9ms | 836.5ms | 837.1ms |
| dom/create-elements | 709.7ms | — | — |
| dom/set-attributes | 715.7ms | — | — |
| dom/read-attributes | 686.1ms | — | — |
| dom/modify-text | 697.2ms | — | — |
| mixed/csv-parse | 786.1ms | 988.9ms | — |
| mixed/text-search | 749.0ms | 987.3ms | — |
| mixed/fibonacci | 741.0ms | 762.1ms | 718.7ms |
| mixed/matrix-multiply | 845.4ms | 869.8ms | 762.7ms |
| mixed/sieve | 802.7ms | 870.7ms | — |
