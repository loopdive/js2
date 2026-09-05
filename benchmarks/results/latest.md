# js2wasm Benchmark Results

Date: 2026-09-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.051ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.413ms | 8.29ms | 2.65ms | FAILED | js |
| string/replace | 0.113ms | 0.720ms | 0.315ms | FAILED | js |
| string/case-convert | 0.056ms | 0.618ms | 0.263ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.91ms | 2.80ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.79ms | 2.79ms | 0.560ms | js |
| array/push-pop | 1.43ms | 0.512ms | 0.506ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.293ms | 0.433ms | FAILED | host-call |
| array/map-filter | 0.072ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.502ms | 0.507ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.030ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.042ms | 0.167ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.509ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.124ms | — | — | js |
| dom/modify-text | 0.030ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.482ms | 8.65ms | 0.623ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.00ms | 2.83ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.290ms | js |
| mixed/matrix-multiply | 0.158ms | 72.71ms | 72.99ms | 0.719ms | js |
| mixed/sieve | 1.59ms | 2.11ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.24 | 5.08 | 4.20 | — |
| string/concat-long | 1000 | 3.57 | 4.58 | 3.67 | — |
| string/indexOf | 1000 | 19.20 | 65.85 | 12.34 | 14.65 |
| string/includes | 1000 | 19.24 | 50.86 | 14.82 | 15.41 |
| string/split | 10000 | 41.27 | 829.03 | 265.21 | — |
| string/replace | 1000 | 113.14 | 720.22 | 314.81 | — |
| string/case-convert | 2000 | 27.81 | 308.87 | 131.62 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.01 | 390.53 | 280.16 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 139.33 | 139.61 | 28.01 |
| array/map-filter | 30000 | 2.41 | 2.36 | 2.37 | — |
| array/indexOf | 1000 | 3948.74 | 2642.08 | 2640.80 | — |
| dom/create-elements | 2000 | 21.17 | 83.68 | — | — |
| dom/set-attributes | 6000 | 17.28 | 84.88 | — | — |
| dom/read-attributes | 3000 | 17.91 | 41.50 | — | — |
| dom/modify-text | 2000 | 14.90 | 53.18 | — | — |
| mixed/csv-parse | 11000 | 43.82 | 786.56 | 56.62 | — |
| mixed/text-search | 40000 | 9.74 | 125.02 | 70.79 | 27.17 |
| mixed/fibonacci | 10000 | 12.18 | 28.31 | 28.31 | 28.96 |
| mixed/matrix-multiply | 125000 | 1.26 | 581.67 | 583.93 | 5.75 |
| mixed/sieve | 200000 | 7.96 | 10.56 | 10.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.57x slower | 1.29x slower | — |
| string/concat-long | 1.28x slower | 1.03x slower | — |
| string/indexOf | 3.43x slower | 1.56x faster | 1.31x faster |
| string/includes | 2.64x slower | 1.30x faster | 1.25x faster |
| string/split | 20.09x slower | 6.43x slower | — |
| string/replace | 6.37x slower | 2.78x slower | — |
| string/case-convert | 11.11x slower | 4.73x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 22.96x slower | 16.47x slower | — |
| string/startsWith-endsWith | 6.95x slower | 6.96x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.82x faster | — |
| array/sort-i32 | 2.71x faster | 1.83x faster | — |
| array/map-filter | 1.02x faster | 1.02x faster | — |
| array/reduce | 4.29x faster | 4.25x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.14x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.76x faster | — |
| array/find | 15.93x faster | 15.91x faster | 4.26x slower |
| dom/create-elements | 3.95x slower | — | — |
| dom/set-attributes | 4.91x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.57x slower | — | — |
| mixed/csv-parse | 17.95x slower | 1.29x slower | — |
| mixed/text-search | 12.83x slower | 7.27x slower | 2.79x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.38x slower |
| mixed/matrix-multiply | 460.57x slower | 462.36x slower | 4.55x slower |
| mixed/sieve | 1.33x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.34x faster |
| string/includes | 3.43x faster |
| string/split | 3.13x faster |
| string/replace | 2.29x faster |
| string/case-convert | 2.35x faster |
| string/substring | 1.22x faster |
| string/trim | 1.39x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.48x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.89x faster |
| mixed/text-search | 1.77x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1706.0ms | 1123.3ms | — |
| string/concat-long | 796.1ms | 989.1ms | — |
| string/indexOf | 671.9ms | 1001.9ms | 841.2ms |
| string/includes | 682.7ms | 1002.6ms | 859.7ms |
| string/split | 793.1ms | 1014.8ms | — |
| string/replace | 797.8ms | 1094.4ms | — |
| string/case-convert | 802.3ms | 890.1ms | — |
| string/substring | 685.3ms | 797.7ms | — |
| string/trim | 784.9ms | 982.0ms | — |
| string/startsWith-endsWith | 805.3ms | 1005.8ms | 930.8ms |
| array/push-pop | 798.9ms | 916.7ms | — |
| array/sort-i32 | 948.6ms | 977.6ms | — |
| array/map-filter | 964.4ms | 1032.6ms | — |
| array/reduce | 871.6ms | 964.7ms | — |
| array/indexOf | 883.5ms | 961.7ms | — |
| array/slice | 791.1ms | 881.0ms | — |
| array/reverse | 760.9ms | 869.9ms | — |
| array/forEach | 909.6ms | 925.7ms | — |
| array/find | 781.5ms | 844.5ms | 868.4ms |
| dom/create-elements | 707.8ms | — | — |
| dom/set-attributes | 702.3ms | — | — |
| dom/read-attributes | 708.7ms | — | — |
| dom/modify-text | 692.5ms | — | — |
| mixed/csv-parse | 798.3ms | 945.1ms | — |
| mixed/text-search | 785.4ms | 988.3ms | 896.2ms |
| mixed/fibonacci | 759.3ms | 795.9ms | 761.4ms |
| mixed/matrix-multiply | 899.0ms | 967.6ms | 806.4ms |
| mixed/sieve | 867.9ms | 985.4ms | — |
