# js2wasm Benchmark Results

Date: 2026-08-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.124ms | 0.014ms | 0.066ms | gc-native |
| string/split | 0.425ms | 4.68ms | 0.505ms | FAILED | js |
| string/replace | 0.097ms | 0.225ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.229ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.939ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.349ms | 0.309ms | 0.559ms | gc-native |
| array/push-pop | 1.67ms | 0.604ms | 0.612ms | FAILED | host-call |
| array/sort-i32 | 0.834ms | 0.295ms | 0.453ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.065ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.41ms | 0.600ms | 0.599ms | FAILED | gc-native |
| array/indexOf | 4.45ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.035ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.271ms | 0.015ms | 0.014ms | 1.21ms | gc-native |
| dom/create-elements | 0.037ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.493ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.132ms | — | — | js |
| dom/modify-text | 0.029ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.472ms | 6.90ms | 0.308ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.31ms | 0.292ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.306ms | 0.310ms | js |
| mixed/matrix-multiply | 0.185ms | 0.210ms | 0.210ms | 0.717ms | js |
| mixed/sieve | 1.77ms | 1.49ms | 1.48ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.31 | 4.88 | 3.88 | — |
| string/concat-long | 1000 | 4.31 | 5.06 | 3.64 | — |
| string/indexOf | 1000 | 18.93 | 59.65 | 12.24 | 16.22 |
| string/includes | 1000 | 18.68 | 124.31 | 13.79 | 65.62 |
| string/split | 10000 | 42.49 | 468.21 | 50.49 | — |
| string/replace | 1000 | 97.28 | 225.48 | 59.36 | — |
| string/case-convert | 2000 | 29.32 | 114.67 | 2.61 | — |
| string/substring | 10000 | 10.41 | 3.98 | 3.44 | — |
| string/trim | 10000 | 17.33 | 93.94 | 19.70 | — |
| string/startsWith-endsWith | 20000 | 20.60 | 17.43 | 15.44 | 27.95 |
| array/map-filter | 30000 | 4.46 | 2.18 | 2.20 | — |
| array/indexOf | 1000 | 4454.70 | 2860.26 | 2861.49 | — |
| dom/create-elements | 2000 | 18.61 | 76.18 | — | — |
| dom/set-attributes | 6000 | 17.95 | 82.21 | — | — |
| dom/read-attributes | 3000 | 18.99 | 43.96 | — | — |
| dom/modify-text | 2000 | 14.70 | 55.81 | — | — |
| mixed/csv-parse | 11000 | 42.95 | 627.36 | 27.96 | — |
| mixed/text-search | 40000 | 10.08 | 32.85 | 7.29 | 28.21 |
| mixed/fibonacci | 10000 | 12.53 | 31.50 | 30.58 | 30.98 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 8.84 | 7.43 | 7.41 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.17x slower | — |
| string/concat-long | 1.17x slower | 1.19x faster | — |
| string/indexOf | 3.15x slower | 1.55x faster | 1.17x faster |
| string/includes | 6.65x slower | 1.35x faster | 3.51x slower |
| string/split | 11.02x slower | 1.19x slower | — |
| string/replace | 2.32x slower | 1.64x faster | — |
| string/case-convert | 3.91x slower | 11.22x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.42x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.18x faster | 1.33x faster | 1.36x slower |
| array/push-pop | 2.76x faster | 2.73x faster | — |
| array/sort-i32 | 2.83x faster | 1.84x faster | — |
| array/map-filter | 2.04x faster | 2.03x faster | — |
| array/reduce | 4.02x faster | 4.02x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.19x faster | 2.09x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.84x faster | — |
| array/find | 18.44x faster | 18.74x faster | 4.45x slower |
| dom/create-elements | 4.09x slower | — | — |
| dom/set-attributes | 4.58x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.80x slower | — | — |
| mixed/csv-parse | 14.61x slower | 1.54x faster | — |
| mixed/text-search | 3.26x slower | 1.38x faster | 2.80x slower |
| mixed/fibonacci | 2.51x slower | 2.44x slower | 2.47x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.88x slower |
| mixed/sieve | 1.19x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.26x faster |
| string/concat-long | 1.39x faster |
| string/indexOf | 4.87x faster |
| string/includes | 9.01x faster |
| string/split | 9.27x faster |
| string/replace | 3.80x faster |
| string/case-convert | 43.91x faster |
| string/substring | 1.16x faster |
| string/trim | 4.77x faster |
| string/startsWith-endsWith | 1.13x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.54x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 22.44x faster |
| mixed/text-search | 4.50x faster |
| mixed/fibonacci | 1.03x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1267.1ms | 1025.4ms | — |
| string/concat-long | 630.2ms | 939.0ms | — |
| string/indexOf | 642.0ms | 924.6ms | 813.7ms |
| string/includes | 644.0ms | 952.1ms | 864.2ms |
| string/split | 766.3ms | 958.7ms | — |
| string/replace | 747.7ms | 990.4ms | — |
| string/case-convert | 789.4ms | 858.8ms | — |
| string/substring | 632.6ms | 715.9ms | — |
| string/trim | 725.2ms | 960.4ms | — |
| string/startsWith-endsWith | 771.8ms | 925.4ms | 865.0ms |
| array/push-pop | 751.8ms | 809.5ms | — |
| array/sort-i32 | 869.4ms | 963.2ms | — |
| array/map-filter | 893.3ms | 978.4ms | — |
| array/reduce | 818.4ms | 862.9ms | — |
| array/indexOf | 811.4ms | 923.8ms | — |
| array/slice | 750.8ms | 846.7ms | — |
| array/reverse | 753.9ms | 843.0ms | — |
| array/forEach | 865.2ms | 950.7ms | — |
| array/find | 755.9ms | 830.0ms | 828.6ms |
| dom/create-elements | 609.4ms | — | — |
| dom/set-attributes | 701.0ms | — | — |
| dom/read-attributes | 669.9ms | — | — |
| dom/modify-text | 579.4ms | — | — |
| mixed/csv-parse | 780.9ms | 895.4ms | — |
| mixed/text-search | 740.9ms | 986.0ms | 869.9ms |
| mixed/fibonacci | 767.3ms | 792.0ms | 810.9ms |
| mixed/matrix-multiply | 821.3ms | 915.7ms | 782.4ms |
| mixed/sieve | 883.8ms | 893.5ms | — |
