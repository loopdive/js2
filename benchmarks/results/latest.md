# js2wasm Benchmark Results

Date: 2026-09-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.047ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.067ms | 0.012ms | 0.021ms | gc-native |
| string/includes | 0.019ms | 0.137ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.425ms | 8.27ms | 2.78ms | FAILED | js |
| string/replace | 0.105ms | 0.701ms | 0.322ms | FAILED | js |
| string/case-convert | 0.056ms | 0.591ms | 0.282ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.98ms | 2.90ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.02ms | 3.22ms | 0.561ms | js |
| array/push-pop | 1.41ms | 0.506ms | 0.503ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.295ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.069ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.506ms | 0.508ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | 0.102ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.220ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.482ms | 8.65ms | 0.621ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.14ms | 2.70ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 74.77ms | 79.91ms | 0.718ms | js |
| mixed/sieve | 1.59ms | 2.11ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.48 | 4.69 | 4.41 | — |
| string/concat-long | 1000 | 3.75 | 4.47 | 3.57 | — |
| string/indexOf | 1000 | 19.10 | 66.69 | 12.21 | 21.17 |
| string/includes | 1000 | 19.14 | 136.82 | 14.81 | 15.40 |
| string/split | 10000 | 42.51 | 826.55 | 278.30 | — |
| string/replace | 1000 | 104.83 | 700.74 | 321.56 | — |
| string/case-convert | 2000 | 27.75 | 295.68 | 141.14 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.96 | 397.80 | 289.98 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 151.04 | 160.79 | 28.04 |
| array/map-filter | 30000 | 4.30 | 2.31 | 2.35 | — |
| array/indexOf | 1000 | 3953.00 | 2641.78 | 2638.88 | — |
| dom/create-elements | 2000 | 17.71 | 50.78 | — | — |
| dom/set-attributes | 6000 | 17.45 | 36.71 | — | — |
| dom/read-attributes | 3000 | 19.00 | 40.51 | — | — |
| dom/modify-text | 2000 | 14.52 | 54.62 | — | — |
| mixed/csv-parse | 11000 | 43.85 | 785.95 | 56.49 | — |
| mixed/text-search | 40000 | 9.73 | 128.60 | 67.58 | 27.48 |
| mixed/fibonacci | 10000 | 12.03 | 28.31 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 598.17 | 639.32 | 5.75 |
| mixed/sieve | 200000 | 7.93 | 10.53 | 10.52 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.35x slower | 1.27x slower | — |
| string/concat-long | 1.19x slower | 1.05x faster | — |
| string/indexOf | 3.49x slower | 1.56x faster | 1.11x slower |
| string/includes | 7.15x slower | 1.29x faster | 1.24x faster |
| string/split | 19.44x slower | 6.55x slower | — |
| string/replace | 6.68x slower | 3.07x slower | — |
| string/case-convert | 10.65x slower | 5.09x slower | — |
| string/substring | 2.64x faster | 3.22x faster | — |
| string/trim | 23.45x slower | 17.09x slower | — |
| string/startsWith-endsWith | 7.54x slower | 8.03x slower | 1.40x slower |
| array/push-pop | 2.78x faster | 2.80x faster | — |
| array/sort-i32 | 2.68x faster | 2.70x faster | — |
| array/map-filter | 1.86x faster | 1.83x faster | — |
| array/reduce | 4.27x faster | 4.26x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.78x faster | — |
| array/find | 16.16x faster | 16.19x faster | 4.25x slower |
| dom/create-elements | 2.87x slower | — | — |
| dom/set-attributes | 2.10x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 17.92x slower | 1.29x slower | — |
| mixed/text-search | 13.21x slower | 6.94x slower | 2.82x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.33x slower |
| mixed/matrix-multiply | 471.61x slower | 504.05x slower | 4.53x slower |
| mixed/sieve | 1.33x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.46x faster |
| string/includes | 9.24x faster |
| string/split | 2.97x faster |
| string/replace | 2.18x faster |
| string/case-convert | 2.09x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.91x faster |
| mixed/text-search | 1.90x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.07x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1135.2ms | 621.6ms | — |
| string/concat-long | 429.4ms | 652.6ms | — |
| string/indexOf | 384.2ms | 708.1ms | 568.5ms |
| string/includes | 368.8ms | 655.4ms | 532.4ms |
| string/split | 513.6ms | 702.8ms | — |
| string/replace | 492.0ms | 755.9ms | — |
| string/case-convert | 500.9ms | 602.9ms | — |
| string/substring | 395.7ms | 514.1ms | — |
| string/trim | 504.2ms | 694.4ms | — |
| string/startsWith-endsWith | 500.2ms | 700.0ms | 633.6ms |
| array/push-pop | 494.6ms | 610.9ms | — |
| array/sort-i32 | 681.6ms | 702.4ms | — |
| array/map-filter | 659.2ms | 733.3ms | — |
| array/reduce | 621.7ms | 702.3ms | — |
| array/indexOf | 584.0ms | 673.2ms | — |
| array/slice | 511.5ms | 620.4ms | — |
| array/reverse | 491.6ms | 592.7ms | — |
| array/forEach | 649.4ms | 648.6ms | — |
| array/find | 501.7ms | 589.2ms | 543.7ms |
| dom/create-elements | 411.8ms | — | — |
| dom/set-attributes | 377.6ms | — | — |
| dom/read-attributes | 375.0ms | — | — |
| dom/modify-text | 374.4ms | — | — |
| mixed/csv-parse | 504.0ms | 678.3ms | — |
| mixed/text-search | 485.1ms | 696.8ms | 602.5ms |
| mixed/fibonacci | 442.2ms | 480.6ms | 459.1ms |
| mixed/matrix-multiply | 647.1ms | 713.9ms | 525.7ms |
| mixed/sieve | 585.6ms | 663.6ms | — |
