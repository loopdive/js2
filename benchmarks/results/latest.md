# js2wasm Benchmark Results

Date: 2026-08-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.045ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.135ms | 0.023ms | FAILED | js |
| string/split | 0.412ms | 5.58ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.296ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.242ms | 0.111ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.902ms | 0.244ms | FAILED | js |
| string/startsWith-endsWith | 0.404ms | 2.86ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.50ms | 0.509ms | 0.511ms | FAILED | host-call |
| array/sort-i32 | 0.791ms | 0.304ms | 0.299ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.064ms | 0.064ms | FAILED | gc-native |
| array/reduce | 1.37ms | 0.518ms | 0.516ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | gc-native |
| array/slice | 0.028ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/reverse | 7.83ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.240ms | 0.017ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.037ms | 0.170ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.582ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.140ms | — | — | js |
| dom/modify-text | 0.048ms | 0.126ms | — | — | js |
| mixed/csv-parse | 0.477ms | 8.65ms | 0.613ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.70ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.107ms | linear-memory |
| mixed/matrix-multiply | 0.158ms | 0.191ms | 0.193ms | 0.723ms | js |
| mixed/sieve | 1.58ms | 1.41ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.56 | 4.52 | 4.02 | — |
| string/concat-long | 1000 | 3.76 | 4.56 | 4.93 | — |
| string/indexOf | 1000 | 19.20 | 66.12 | 24.10 | — |
| string/includes | 1000 | 19.25 | 135.17 | 23.49 | — |
| string/split | 10000 | 41.18 | 558.03 | 44.91 | — |
| string/replace | 1000 | 103.78 | 296.03 | 81.88 | — |
| string/case-convert | 2000 | 27.95 | 121.14 | 55.48 | — |
| string/substring | 10000 | 9.94 | 3.76 | 3.08 | — |
| string/trim | 10000 | 17.07 | 90.18 | 24.41 | — |
| string/startsWith-endsWith | 20000 | 20.19 | 143.23 | 14.32 | — |
| array/map-filter | 30000 | 4.27 | 2.13 | 2.12 | — |
| array/indexOf | 1000 | 3952.94 | 3552.58 | 3549.89 | — |
| dom/create-elements | 2000 | 18.29 | 84.82 | — | — |
| dom/set-attributes | 6000 | 17.54 | 96.97 | — | — |
| dom/read-attributes | 3000 | 18.76 | 46.81 | — | — |
| dom/modify-text | 2000 | 24.11 | 62.84 | — | — |
| mixed/csv-parse | 11000 | 43.32 | 786.12 | 55.76 | — |
| mixed/text-search | 40000 | 9.73 | 67.55 | 8.19 | — |
| mixed/fibonacci | 10000 | 12.18 | 11.83 | 11.82 | 10.72 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.53 | 1.54 | 5.79 |
| mixed/sieve | 200000 | 7.92 | 7.05 | 6.99 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.27x slower | 1.13x slower | — |
| string/concat-long | 1.21x slower | 1.31x slower | — |
| string/indexOf | 3.44x slower | 1.26x slower | — |
| string/includes | 7.02x slower | 1.22x slower | — |
| string/split | 13.55x slower | 1.09x slower | — |
| string/replace | 2.85x slower | 1.27x faster | — |
| string/case-convert | 4.33x slower | 1.99x slower | — |
| string/substring | 2.64x faster | 3.23x faster | — |
| string/trim | 5.28x slower | 1.43x slower | — |
| string/startsWith-endsWith | 7.09x slower | 1.41x faster | — |
| array/push-pop | 2.94x faster | 2.93x faster | — |
| array/sort-i32 | 2.61x faster | 2.64x faster | — |
| array/map-filter | 2.01x faster | 2.02x faster | — |
| array/reduce | 2.65x faster | 2.66x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.01x faster | 1.02x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.75x faster | — |
| array/find | 14.05x faster | 13.91x faster | 4.52x slower |
| dom/create-elements | 4.64x slower | — | — |
| dom/set-attributes | 5.53x slower | — | — |
| dom/read-attributes | 2.50x slower | — | — |
| dom/modify-text | 2.61x slower | — | — |
| mixed/csv-parse | 18.15x slower | 1.29x slower | — |
| mixed/text-search | 6.94x slower | 1.19x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 1.14x faster |
| mixed/matrix-multiply | 1.21x slower | 1.22x slower | 4.57x slower |
| mixed/sieve | 1.12x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 2.74x faster |
| string/includes | 5.75x faster |
| string/split | 12.43x faster |
| string/replace | 3.62x faster |
| string/case-convert | 2.18x faster |
| string/substring | 1.22x faster |
| string/trim | 3.70x faster |
| string/startsWith-endsWith | 10.01x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.10x faster |
| mixed/text-search | 8.25x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1389.4ms | 1170.2ms | — |
| string/concat-long | 672.1ms | 1033.7ms | — |
| string/indexOf | 839.0ms | 1059.0ms | — |
| string/includes | 830.7ms | 1070.4ms | — |
| string/split | 804.3ms | 1010.8ms | — |
| string/replace | 854.3ms | 1272.9ms | — |
| string/case-convert | 848.0ms | 1191.0ms | — |
| string/substring | 689.9ms | 799.9ms | — |
| string/trim | 787.3ms | 1073.5ms | — |
| string/startsWith-endsWith | 788.9ms | 1078.9ms | — |
| array/push-pop | 810.7ms | 880.7ms | — |
| array/sort-i32 | 984.6ms | 1011.0ms | — |
| array/map-filter | 937.0ms | 1068.7ms | — |
| array/reduce | 873.5ms | 931.6ms | — |
| array/indexOf | 878.2ms | 951.7ms | — |
| array/slice | 776.2ms | 858.1ms | — |
| array/reverse | 797.0ms | 872.4ms | — |
| array/forEach | 881.0ms | 963.6ms | — |
| array/find | 764.7ms | 871.7ms | 866.4ms |
| dom/create-elements | 636.5ms | — | — |
| dom/set-attributes | 748.5ms | — | — |
| dom/read-attributes | 717.3ms | — | — |
| dom/modify-text | 725.2ms | — | — |
| mixed/csv-parse | 823.0ms | 1024.5ms | — |
| mixed/text-search | 768.1ms | 1048.8ms | — |
| mixed/fibonacci | 855.3ms | 898.6ms | 765.6ms |
| mixed/matrix-multiply | 919.7ms | 914.6ms | 841.0ms |
| mixed/sieve | 907.4ms | 931.0ms | — |
