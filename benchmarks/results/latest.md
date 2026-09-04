# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.131ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.427ms | 8.33ms | 2.92ms | FAILED | js |
| string/replace | 0.104ms | 0.721ms | 0.322ms | FAILED | js |
| string/case-convert | 0.056ms | 0.553ms | 0.260ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.74ms | 2.73ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.82ms | 2.98ms | 0.561ms | js |
| array/push-pop | 1.38ms | 0.505ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.798ms | 0.292ms | 0.387ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.069ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.13ms | 0.500ms | 0.498ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.553ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.127ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 1.21ms | 8.75ms | 0.637ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 4.98ms | 2.81ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.286ms | js |
| mixed/matrix-multiply | 0.157ms | 74.21ms | 75.09ms | 0.716ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 3.10 | 4.84 | 4.37 | — |
| string/concat-long | 1000 | 3.86 | 4.47 | 3.59 | — |
| string/indexOf | 1000 | 19.16 | 63.50 | 13.29 | 15.15 |
| string/includes | 1000 | 19.21 | 131.28 | 14.67 | 16.05 |
| string/split | 10000 | 42.74 | 833.41 | 292.08 | — |
| string/replace | 1000 | 104.13 | 720.51 | 321.90 | — |
| string/case-convert | 2000 | 27.86 | 276.73 | 130.22 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.96 | 374.39 | 273.15 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 141.22 | 148.84 | 28.04 |
| array/map-filter | 30000 | 4.26 | 2.32 | 2.31 | — |
| array/indexOf | 1000 | 3950.40 | 2644.83 | 2641.02 | — |
| dom/create-elements | 2000 | 17.88 | 77.00 | — | — |
| dom/set-attributes | 6000 | 17.21 | 92.11 | — | — |
| dom/read-attributes | 3000 | 18.21 | 42.21 | — | — |
| dom/modify-text | 2000 | 14.28 | 54.16 | — | — |
| mixed/csv-parse | 11000 | 109.91 | 795.13 | 57.88 | — |
| mixed/text-search | 40000 | 9.72 | 124.48 | 70.35 | 27.12 |
| mixed/fibonacci | 10000 | 12.02 | 28.30 | 28.30 | 28.63 |
| mixed/matrix-multiply | 125000 | 1.26 | 593.65 | 600.75 | 5.73 |
| mixed/sieve | 200000 | 7.82 | 10.57 | 10.46 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.41x slower | — |
| string/concat-long | 1.16x slower | 1.08x faster | — |
| string/indexOf | 3.31x slower | 1.44x faster | 1.26x faster |
| string/includes | 6.84x slower | 1.31x faster | 1.20x faster |
| string/split | 19.50x slower | 6.83x slower | — |
| string/replace | 6.92x slower | 3.09x slower | — |
| string/case-convert | 9.93x slower | 4.67x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 22.07x slower | 16.10x slower | — |
| string/startsWith-endsWith | 7.04x slower | 7.42x slower | 1.40x slower |
| array/push-pop | 2.72x faster | 2.74x faster | — |
| array/sort-i32 | 2.74x faster | 2.06x faster | — |
| array/map-filter | 1.84x faster | 1.84x faster | — |
| array/reduce | 4.25x faster | 4.27x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.86x faster | 1.87x faster | — |
| array/find | 16.20x faster | 16.25x faster | 4.24x slower |
| dom/create-elements | 4.31x slower | — | — |
| dom/set-attributes | 5.35x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.79x slower | — | — |
| mixed/csv-parse | 7.23x slower | 1.90x faster | — |
| mixed/text-search | 12.81x slower | 7.24x slower | 2.79x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.38x slower |
| mixed/matrix-multiply | 471.51x slower | 477.15x slower | 4.55x slower |
| mixed/sieve | 1.35x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 4.78x faster |
| string/includes | 8.95x faster |
| string/split | 2.85x faster |
| string/replace | 2.24x faster |
| string/case-convert | 2.13x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.33x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.74x faster |
| mixed/text-search | 1.77x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1657.5ms | 1083.9ms | — |
| string/concat-long | 770.6ms | 940.0ms | — |
| string/indexOf | 651.9ms | 961.9ms | 846.7ms |
| string/includes | 642.0ms | 965.0ms | 827.2ms |
| string/split | 774.8ms | 961.3ms | — |
| string/replace | 771.1ms | 1085.0ms | — |
| string/case-convert | 800.7ms | 857.2ms | — |
| string/substring | 654.7ms | 752.4ms | — |
| string/trim | 740.6ms | 936.7ms | — |
| string/startsWith-endsWith | 759.6ms | 946.7ms | 879.1ms |
| array/push-pop | 780.0ms | 876.2ms | — |
| array/sort-i32 | 913.0ms | 1011.2ms | — |
| array/map-filter | 936.1ms | 1010.5ms | — |
| array/reduce | 862.8ms | 957.2ms | — |
| array/indexOf | 838.7ms | 931.1ms | — |
| array/slice | 771.5ms | 842.9ms | — |
| array/reverse | 762.3ms | 820.4ms | — |
| array/forEach | 869.3ms | 949.2ms | — |
| array/find | 760.2ms | 840.8ms | 804.6ms |
| dom/create-elements | 662.0ms | — | — |
| dom/set-attributes | 677.8ms | — | — |
| dom/read-attributes | 670.0ms | — | — |
| dom/modify-text | 659.6ms | — | — |
| mixed/csv-parse | 812.3ms | 935.2ms | — |
| mixed/text-search | 770.1ms | 951.9ms | 885.0ms |
| mixed/fibonacci | 706.5ms | 795.7ms | 730.9ms |
| mixed/matrix-multiply | 910.4ms | 967.6ms | 811.5ms |
| mixed/sieve | 849.5ms | 913.0ms | — |
