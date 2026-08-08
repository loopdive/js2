# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.052ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.150ms | 0.023ms | FAILED | js |
| string/split | 0.412ms | 5.45ms | 0.451ms | FAILED | js |
| string/replace | 0.104ms | 0.304ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.233ms | 0.110ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.966ms | 0.248ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.72ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.44ms | 0.509ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.299ms | 0.298ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.063ms | 0.062ms | FAILED | gc-native |
| array/reduce | 1.39ms | 0.509ms | 0.505ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | host-call |
| array/slice | 0.026ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.239ms | 0.017ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.172ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.569ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.137ms | — | — | js |
| dom/modify-text | 0.047ms | 0.124ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.50ms | 0.605ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.59ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.163ms | 0.207ms | 0.190ms | 0.719ms | js |
| mixed/sieve | 1.56ms | 1.40ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.18 | 5.15 | 3.99 | — |
| string/concat-long | 1000 | 3.52 | 4.47 | 4.61 | — |
| string/indexOf | 1000 | 19.13 | 66.06 | 23.88 | — |
| string/includes | 1000 | 19.17 | 150.48 | 23.43 | — |
| string/split | 10000 | 41.17 | 544.50 | 45.08 | — |
| string/replace | 1000 | 104.25 | 303.68 | 81.98 | — |
| string/case-convert | 2000 | 28.01 | 116.70 | 55.16 | — |
| string/substring | 10000 | 9.88 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.95 | 96.57 | 24.85 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 136.01 | 14.31 | — |
| array/map-filter | 30000 | 4.25 | 2.10 | 2.06 | — |
| array/indexOf | 1000 | 3947.60 | 3547.66 | 3548.34 | — |
| dom/create-elements | 2000 | 17.52 | 86.04 | — | — |
| dom/set-attributes | 6000 | 17.67 | 94.77 | — | — |
| dom/read-attributes | 3000 | 18.10 | 45.50 | — | — |
| dom/modify-text | 2000 | 23.54 | 62.09 | — | — |
| mixed/csv-parse | 11000 | 44.22 | 773.15 | 54.97 | — |
| mixed/text-search | 40000 | 9.73 | 64.80 | 8.19 | — |
| mixed/fibonacci | 10000 | 12.17 | 11.82 | 11.82 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.65 | 1.52 | 5.75 |
| mixed/sieve | 200000 | 7.82 | 6.99 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.62x slower | 1.26x slower | — |
| string/concat-long | 1.27x slower | 1.31x slower | — |
| string/indexOf | 3.45x slower | 1.25x slower | — |
| string/includes | 7.85x slower | 1.22x slower | — |
| string/split | 13.23x slower | 1.10x slower | — |
| string/replace | 2.91x slower | 1.27x faster | — |
| string/case-convert | 4.17x slower | 1.97x slower | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 5.70x slower | 1.47x slower | — |
| string/startsWith-endsWith | 6.78x slower | 1.40x faster | — |
| array/push-pop | 2.83x faster | 2.88x faster | — |
| array/sort-i32 | 2.65x faster | 2.66x faster | — |
| array/map-filter | 2.03x faster | 2.06x faster | — |
| array/reduce | 2.72x faster | 2.74x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.05x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.77x faster | — |
| array/find | 14.47x faster | 14.38x faster | 4.51x slower |
| dom/create-elements | 4.91x slower | — | — |
| dom/set-attributes | 5.36x slower | — | — |
| dom/read-attributes | 2.51x slower | — | — |
| dom/modify-text | 2.64x slower | — | — |
| mixed/csv-parse | 17.48x slower | 1.24x slower | — |
| mixed/text-search | 6.66x slower | 1.19x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 2.79x faster |
| mixed/matrix-multiply | 1.27x slower | 1.17x slower | 4.42x slower |
| mixed/sieve | 1.12x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.29x faster |
| string/concat-long | 1.03x slower |
| string/indexOf | 2.77x faster |
| string/includes | 6.42x faster |
| string/split | 12.08x faster |
| string/replace | 3.70x faster |
| string/case-convert | 2.12x faster |
| string/substring | 1.22x faster |
| string/trim | 3.89x faster |
| string/startsWith-endsWith | 9.50x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.02x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.07x faster |
| mixed/text-search | 7.91x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.09x faster |
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
| string/concat-short | 1371.6ms | 1142.2ms | — |
| string/concat-long | 667.3ms | 993.0ms | — |
| string/indexOf | 786.7ms | 1001.6ms | — |
| string/includes | 775.6ms | 1012.2ms | — |
| string/split | 754.0ms | 967.1ms | — |
| string/replace | 830.1ms | 1082.7ms | — |
| string/case-convert | 794.9ms | 1226.5ms | — |
| string/substring | 662.6ms | 719.1ms | — |
| string/trim | 734.1ms | 1008.8ms | — |
| string/startsWith-endsWith | 759.0ms | 1013.9ms | — |
| array/push-pop | 775.2ms | 832.1ms | — |
| array/sort-i32 | 942.6ms | 993.4ms | — |
| array/map-filter | 901.0ms | 1029.0ms | — |
| array/reduce | 864.4ms | 935.8ms | — |
| array/indexOf | 860.6ms | 905.1ms | — |
| array/slice | 771.3ms | 843.9ms | — |
| array/reverse | 774.2ms | 818.9ms | — |
| array/forEach | 843.1ms | 919.5ms | — |
| array/find | 752.6ms | 813.8ms | 853.7ms |
| dom/create-elements | 623.5ms | — | — |
| dom/set-attributes | 710.5ms | — | — |
| dom/read-attributes | 688.3ms | — | — |
| dom/modify-text | 686.3ms | — | — |
| mixed/csv-parse | 795.3ms | 1012.0ms | — |
| mixed/text-search | 749.3ms | 1062.2ms | — |
| mixed/fibonacci | 795.0ms | 841.9ms | 755.9ms |
| mixed/matrix-multiply | 844.2ms | 889.4ms | 811.9ms |
| mixed/sieve | 859.7ms | 886.8ms | — |
