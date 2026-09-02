# js2wasm Benchmark Results

Date: 2026-09-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.052ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.107ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.422ms | 7.63ms | 2.69ms | FAILED | js |
| string/replace | 0.095ms | 0.574ms | 0.288ms | FAILED | js |
| string/case-convert | 0.058ms | 0.532ms | 0.246ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.22ms | 2.38ms | FAILED | js |
| string/startsWith-endsWith | 0.414ms | 2.49ms | 2.43ms | 0.562ms | js |
| array/push-pop | 1.64ms | 0.599ms | 0.599ms | FAILED | gc-native |
| array/sort-i32 | 0.838ms | 0.306ms | 0.551ms | FAILED | host-call |
| array/map-filter | 0.132ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 2.38ms | 0.603ms | 0.601ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.98ms | 3.98ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | gc-native |
| dom/create-elements | 0.038ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.555ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.135ms | — | — | js |
| dom/modify-text | 0.030ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.467ms | 7.98ms | 0.575ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.13ms | 2.39ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 63.15ms | 67.87ms | 0.720ms | js |
| mixed/sieve | 1.78ms | 2.37ms | 2.28ms | FAILED | js |

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
| string/concat-short | 10000 | 3.41 | 5.17 | 4.89 | — |
| string/concat-long | 1000 | 3.98 | 5.02 | 3.43 | — |
| string/indexOf | 1000 | 18.90 | 60.94 | 12.29 | 16.12 |
| string/includes | 1000 | 18.67 | 106.74 | 13.82 | 16.58 |
| string/split | 10000 | 42.16 | 763.35 | 268.70 | — |
| string/replace | 1000 | 95.41 | 574.14 | 287.51 | — |
| string/case-convert | 2000 | 28.98 | 265.83 | 123.19 | — |
| string/substring | 10000 | 10.40 | 4.00 | 3.44 | — |
| string/trim | 10000 | 17.28 | 322.35 | 237.67 | — |
| string/startsWith-endsWith | 20000 | 20.68 | 124.69 | 121.70 | 28.12 |
| array/map-filter | 30000 | 4.41 | 2.17 | 2.17 | — |
| array/indexOf | 1000 | 4459.07 | 2864.88 | 2863.09 | — |
| dom/create-elements | 2000 | 19.21 | 77.30 | — | — |
| dom/set-attributes | 6000 | 18.25 | 92.56 | — | — |
| dom/read-attributes | 3000 | 19.82 | 44.96 | — | — |
| dom/modify-text | 2000 | 14.98 | 56.81 | — | — |
| mixed/csv-parse | 11000 | 42.45 | 725.26 | 52.24 | — |
| mixed/text-search | 40000 | 10.08 | 103.24 | 59.70 | 28.24 |
| mixed/fibonacci | 10000 | 12.53 | 32.77 | 32.78 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.47 | 505.22 | 542.95 | 5.76 |
| mixed/sieve | 200000 | 8.91 | 11.87 | 11.38 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.52x slower | 1.44x slower | — |
| string/concat-long | 1.26x slower | 1.16x faster | — |
| string/indexOf | 3.22x slower | 1.54x faster | 1.17x faster |
| string/includes | 5.72x slower | 1.35x faster | 1.13x faster |
| string/split | 18.11x slower | 6.37x slower | — |
| string/replace | 6.02x slower | 3.01x slower | — |
| string/case-convert | 9.17x slower | 4.25x slower | — |
| string/substring | 2.60x faster | 3.02x faster | — |
| string/trim | 18.66x slower | 13.76x slower | — |
| string/startsWith-endsWith | 6.03x slower | 5.89x slower | 1.36x slower |
| array/push-pop | 2.73x faster | 2.73x faster | — |
| array/sort-i32 | 2.74x faster | 1.52x faster | — |
| array/map-filter | 2.03x faster | 2.03x faster | — |
| array/reduce | 3.95x faster | 3.97x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 1.97x faster | 1.90x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.80x faster | 1.80x faster | — |
| array/find | 18.45x faster | 18.58x faster | 4.44x slower |
| dom/create-elements | 4.02x slower | — | — |
| dom/set-attributes | 5.07x slower | — | — |
| dom/read-attributes | 2.27x slower | — | — |
| dom/modify-text | 3.79x slower | — | — |
| mixed/csv-parse | 17.09x slower | 1.23x slower | — |
| mixed/text-search | 10.24x slower | 5.92x slower | 2.80x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 2.59x slower |
| mixed/matrix-multiply | 344.04x slower | 369.74x slower | 3.92x slower |
| mixed/sieve | 1.33x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.46x faster |
| string/indexOf | 4.96x faster |
| string/includes | 7.72x faster |
| string/split | 2.84x faster |
| string/replace | 2.00x faster |
| string/case-convert | 2.16x faster |
| string/substring | 1.16x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.80x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.88x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.07x slower |
| mixed/sieve | 1.04x faster |

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
| string/concat-short | 1559.8ms | 1029.1ms | — |
| string/concat-long | 744.6ms | 941.7ms | — |
| string/indexOf | 652.3ms | 909.3ms | 815.7ms |
| string/includes | 640.6ms | 928.3ms | 806.6ms |
| string/split | 726.7ms | 970.3ms | — |
| string/replace | 770.8ms | 1018.2ms | — |
| string/case-convert | 771.7ms | 847.2ms | — |
| string/substring | 654.8ms | 753.1ms | — |
| string/trim | 731.6ms | 915.7ms | — |
| string/startsWith-endsWith | 727.9ms | 926.6ms | 855.1ms |
| array/push-pop | 771.0ms | 845.4ms | — |
| array/sort-i32 | 906.3ms | 944.1ms | — |
| array/map-filter | 921.8ms | 974.7ms | — |
| array/reduce | 837.3ms | 930.3ms | — |
| array/indexOf | 826.6ms | 916.6ms | — |
| array/slice | 741.1ms | 825.5ms | — |
| array/reverse | 728.7ms | 835.9ms | — |
| array/forEach | 844.4ms | 995.9ms | — |
| array/find | 718.9ms | 803.7ms | 780.5ms |
| dom/create-elements | 666.3ms | — | — |
| dom/set-attributes | 679.2ms | — | — |
| dom/read-attributes | 663.5ms | — | — |
| dom/modify-text | 650.4ms | — | — |
| mixed/csv-parse | 761.8ms | 931.4ms | — |
| mixed/text-search | 768.9ms | 942.3ms | 877.1ms |
| mixed/fibonacci | 758.4ms | 788.9ms | 759.0ms |
| mixed/matrix-multiply | 881.0ms | 973.3ms | 774.0ms |
| mixed/sieve | 845.5ms | 920.0ms | — |
