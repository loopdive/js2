# js2wasm Benchmark Results

Date: 2026-08-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.044ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.412ms | 4.97ms | 0.449ms | FAILED | js |
| string/replace | 0.107ms | 0.307ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.055ms | 0.245ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 1.00ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.366ms | 0.298ms | 0.561ms | gc-native |
| array/push-pop | 1.40ms | 0.503ms | 0.499ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 1.39ms | 0.509ms | 0.506ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.026ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.559ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 1.22ms | 7.19ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.59ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.157ms | 0.210ms | 0.210ms | 0.712ms | js |
| mixed/sieve | 1.52ms | 1.40ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.38 | 4.45 | 3.88 | — |
| string/concat-long | 1000 | 3.65 | 4.51 | 3.63 | — |
| string/indexOf | 1000 | 19.17 | 63.15 | 12.31 | 15.73 |
| string/includes | 1000 | 19.31 | 50.62 | 14.82 | 15.38 |
| string/split | 10000 | 41.15 | 497.02 | 44.94 | — |
| string/replace | 1000 | 106.93 | 307.32 | 55.98 | — |
| string/case-convert | 2000 | 27.72 | 122.38 | 2.52 | — |
| string/substring | 10000 | 9.84 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.95 | 100.49 | 18.67 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 18.30 | 14.90 | 28.04 |
| array/map-filter | 30000 | 4.38 | 2.36 | 2.36 | — |
| array/indexOf | 1000 | 3949.75 | 2633.42 | 2634.17 | — |
| dom/create-elements | 2000 | 17.48 | 77.32 | — | — |
| dom/set-attributes | 6000 | 17.43 | 93.20 | — | — |
| dom/read-attributes | 3000 | 18.42 | 40.95 | — | — |
| dom/modify-text | 2000 | 14.61 | 52.99 | — | — |
| mixed/csv-parse | 11000 | 110.96 | 653.65 | 28.71 | — |
| mixed/text-search | 40000 | 9.73 | 39.82 | 6.64 | 27.16 |
| mixed/fibonacci | 10000 | 12.17 | 29.23 | 29.17 | 28.66 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.68 | 1.68 | 5.70 |
| mixed/sieve | 200000 | 7.60 | 7.02 | 7.02 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.31x slower | 1.15x slower | — |
| string/concat-long | 1.24x slower | 1.01x faster | — |
| string/indexOf | 3.29x slower | 1.56x faster | 1.22x faster |
| string/includes | 2.62x slower | 1.30x faster | 1.25x faster |
| string/split | 12.08x slower | 1.09x slower | — |
| string/replace | 2.87x slower | 1.91x faster | — |
| string/case-convert | 4.41x slower | 11.00x faster | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 5.93x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.10x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.79x faster | 2.81x faster | — |
| array/sort-i32 | 2.70x faster | 2.71x faster | — |
| array/map-filter | 1.85x faster | 1.86x faster | — |
| array/reduce | 2.73x faster | 2.74x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.04x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.76x faster | — |
| array/find | 15.69x faster | 16.17x faster | 4.22x slower |
| dom/create-elements | 4.42x slower | — | — |
| dom/set-attributes | 5.35x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 5.89x slower | 3.87x faster | — |
| mixed/text-search | 4.09x slower | 1.46x faster | 2.79x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.54x slower |
| mixed/sieve | 1.08x faster | 1.08x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.13x faster |
| string/includes | 3.42x faster |
| string/split | 11.06x faster |
| string/replace | 5.49x faster |
| string/case-convert | 48.57x faster |
| string/substring | 1.22x faster |
| string/trim | 5.38x faster |
| string/startsWith-endsWith | 1.23x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.03x faster |
| mixed/csv-parse | 22.77x faster |
| mixed/text-search | 5.99x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1326.4ms | 1066.2ms | — |
| string/concat-long | 634.1ms | 965.1ms | — |
| string/indexOf | 682.9ms | 975.3ms | 867.9ms |
| string/includes | 671.4ms | 993.6ms | 837.7ms |
| string/split | 769.6ms | 948.9ms | — |
| string/replace | 772.1ms | 1109.4ms | — |
| string/case-convert | 752.6ms | 856.3ms | — |
| string/substring | 638.1ms | 726.4ms | — |
| string/trim | 740.2ms | 945.7ms | — |
| string/startsWith-endsWith | 752.6ms | 950.2ms | 920.5ms |
| array/push-pop | 779.8ms | 844.5ms | — |
| array/sort-i32 | 898.0ms | 958.3ms | — |
| array/map-filter | 912.6ms | 1034.9ms | — |
| array/reduce | 872.7ms | 915.6ms | — |
| array/indexOf | 848.7ms | 934.2ms | — |
| array/slice | 755.1ms | 865.6ms | — |
| array/reverse | 744.3ms | 835.9ms | — |
| array/forEach | 875.1ms | 946.1ms | — |
| array/find | 753.2ms | 863.4ms | 831.8ms |
| dom/create-elements | 627.2ms | — | — |
| dom/set-attributes | 710.2ms | — | — |
| dom/read-attributes | 663.3ms | — | — |
| dom/modify-text | 593.0ms | — | — |
| mixed/csv-parse | 783.8ms | 939.6ms | — |
| mixed/text-search | 775.5ms | 1027.2ms | 899.0ms |
| mixed/fibonacci | 743.6ms | 811.1ms | 811.0ms |
| mixed/matrix-multiply | 870.4ms | 910.5ms | 801.8ms |
| mixed/sieve | 828.1ms | 931.6ms | — |
