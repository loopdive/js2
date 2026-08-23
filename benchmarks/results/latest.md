# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.049ms | 0.054ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.060ms | 0.012ms | 0.026ms | gc-native |
| string/includes | 0.018ms | 0.105ms | 0.014ms | 0.022ms | gc-native |
| string/split | 0.388ms | 4.95ms | 0.419ms | FAILED | js |
| string/replace | 0.107ms | 0.264ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.057ms | 0.278ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.159ms | 0.853ms | 0.181ms | FAILED | js |
| string/startsWith-endsWith | 0.430ms | 0.305ms | 0.275ms | 0.578ms | gc-native |
| array/push-pop | 1.34ms | 0.492ms | 0.492ms | FAILED | gc-native |
| array/sort-i32 | 0.716ms | 0.312ms | 0.311ms | FAILED | gc-native |
| array/map-filter | 0.147ms | 0.085ms | 0.084ms | FAILED | gc-native |
| array/reduce | 1.27ms | 0.489ms | 0.489ms | FAILED | gc-native |
| array/indexOf | 4.83ms | 2.75ms | 2.74ms | FAILED | gc-native |
| array/slice | 0.039ms | 0.035ms | 0.034ms | FAILED | gc-native |
| array/reverse | 7.28ms | 3.63ms | 3.62ms | FAILED | gc-native |
| array/forEach | 0.076ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.264ms | 0.017ms | 0.017ms | 0.981ms | host-call |
| dom/create-elements | 0.057ms | FAILED | — | — | js |
| dom/set-attributes | 0.126ms | FAILED | — | — | js |
| dom/read-attributes | 0.068ms | FAILED | — | — | js |
| dom/modify-text | 0.051ms | FAILED | — | — | js |
| mixed/csv-parse | 0.449ms | 7.19ms | 0.302ms | FAILED | gc-native |
| mixed/text-search | 0.393ms | 1.52ms | 0.264ms | 1.21ms | gc-native |
| mixed/fibonacci | 0.134ms | 0.300ms | 0.300ms | 0.298ms | js |
| mixed/matrix-multiply | 0.204ms | 0.204ms | 0.204ms | 0.773ms | js |
| mixed/sieve | 1.50ms | 1.50ms | 1.49ms | FAILED | gc-native |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 4.35 | 4.91 | 5.36 | — |
| string/concat-long | 1000 | 4.30 | 4.70 | 5.58 | — |
| string/indexOf | 1000 | 17.98 | 60.14 | 12.20 | 26.46 |
| string/includes | 1000 | 18.08 | 104.95 | 13.72 | 22.11 |
| string/split | 10000 | 38.76 | 495.14 | 41.93 | — |
| string/replace | 1000 | 106.85 | 263.97 | 58.61 | — |
| string/case-convert | 2000 | 28.50 | 138.78 | 2.62 | — |
| string/substring | 10000 | 9.84 | 4.19 | 3.59 | — |
| string/trim | 10000 | 15.87 | 85.30 | 18.09 | — |
| string/startsWith-endsWith | 20000 | 21.49 | 15.27 | 13.73 | 28.91 |
| array/map-filter | 30000 | 4.89 | 2.82 | 2.80 | — |
| array/indexOf | 1000 | 4827.79 | 2746.30 | 2744.94 | — |
| dom/create-elements | 2000 | 28.61 | — | — | — |
| dom/set-attributes | 6000 | 20.95 | — | — | — |
| dom/read-attributes | 3000 | 22.58 | — | — | — |
| dom/modify-text | 2000 | 25.49 | — | — | — |
| mixed/csv-parse | 11000 | 40.79 | 653.27 | 27.48 | — |
| mixed/text-search | 40000 | 9.83 | 38.01 | 6.59 | 30.33 |
| mixed/fibonacci | 10000 | 13.37 | 30.01 | 29.97 | 29.81 |
| mixed/matrix-multiply | 125000 | 1.63 | 1.63 | 1.63 | 6.18 |
| mixed/sieve | 200000 | 7.52 | 7.50 | 7.46 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.13x slower | 1.23x slower | — |
| string/concat-long | 1.09x slower | 1.30x slower | — |
| string/indexOf | 3.34x slower | 1.47x faster | 1.47x slower |
| string/includes | 5.81x slower | 1.32x faster | 1.22x slower |
| string/split | 12.77x slower | 1.08x slower | — |
| string/replace | 2.47x slower | 1.82x faster | — |
| string/case-convert | 4.87x slower | 10.86x faster | — |
| string/substring | 2.35x faster | 2.74x faster | — |
| string/trim | 5.38x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.41x faster | 1.57x faster | 1.34x slower |
| array/push-pop | 2.72x faster | 2.72x faster | — |
| array/sort-i32 | 2.30x faster | 2.30x faster | — |
| array/map-filter | 1.73x faster | 1.75x faster | — |
| array/reduce | 2.60x faster | 2.60x faster | — |
| array/indexOf | 1.76x faster | 1.76x faster | — |
| array/slice | 1.11x faster | 1.14x faster | — |
| array/reverse | 2.01x faster | 2.01x faster | — |
| array/forEach | 2.72x faster | 2.71x faster | — |
| array/find | 15.88x faster | 15.72x faster | 3.71x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 16.01x slower | 1.48x faster | — |
| mixed/text-search | 3.87x slower | 1.49x faster | 3.09x slower |
| mixed/fibonacci | 2.24x slower | 2.24x slower | 2.23x slower |
| mixed/matrix-multiply | 1.00x slower | 1.00x slower | 3.80x slower |
| mixed/sieve | 1.00x faster | 1.01x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x slower |
| string/concat-long | 1.19x slower |
| string/indexOf | 4.93x faster |
| string/includes | 7.65x faster |
| string/split | 11.81x faster |
| string/replace | 4.50x faster |
| string/case-convert | 52.88x faster |
| string/substring | 1.17x faster |
| string/trim | 4.71x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 23.77x faster |
| mixed/text-search | 5.77x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1236.4ms | 1055.1ms | — |
| string/concat-long | 603.7ms | 913.4ms | — |
| string/indexOf | 624.3ms | 925.0ms | 830.3ms |
| string/includes | 628.6ms | 974.8ms | 838.3ms |
| string/split | 727.6ms | 975.6ms | — |
| string/replace | 730.7ms | 1021.4ms | — |
| string/case-convert | 779.7ms | 852.2ms | — |
| string/substring | 640.4ms | 724.0ms | — |
| string/trim | 735.3ms | 940.5ms | — |
| string/startsWith-endsWith | 757.7ms | 964.8ms | 894.5ms |
| array/push-pop | 762.9ms | 805.4ms | — |
| array/sort-i32 | 919.7ms | 985.7ms | — |
| array/map-filter | 887.8ms | 1026.4ms | — |
| array/reduce | 867.7ms | 931.1ms | — |
| array/indexOf | 817.0ms | 882.9ms | — |
| array/slice | 758.8ms | 833.7ms | — |
| array/reverse | 734.2ms | 812.1ms | — |
| array/forEach | 863.1ms | 949.2ms | — |
| array/find | 710.5ms | 787.8ms | 818.5ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 756.3ms | 901.3ms | — |
| mixed/text-search | 727.9ms | 946.4ms | 871.0ms |
| mixed/fibonacci | 733.5ms | 756.5ms | 791.0ms |
| mixed/matrix-multiply | 846.6ms | 916.0ms | 763.8ms |
| mixed/sieve | 836.0ms | 879.2ms | — |
