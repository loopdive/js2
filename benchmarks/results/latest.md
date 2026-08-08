# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.045ms | 0.036ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.157ms | 0.023ms | FAILED | js |
| string/split | 0.424ms | 5.62ms | 0.449ms | FAILED | js |
| string/replace | 0.107ms | 0.321ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.060ms | 0.244ms | 0.111ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.908ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.67ms | 0.289ms | FAILED | gc-native |
| array/push-pop | 1.50ms | 0.505ms | 0.506ms | FAILED | host-call |
| array/sort-i32 | 0.789ms | 0.301ms | 0.301ms | FAILED | host-call |
| array/map-filter | 0.138ms | 0.063ms | 0.063ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.515ms | 0.510ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | host-call |
| array/slice | 0.027ms | 0.028ms | 0.030ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.058ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.265ms | 0.017ms | 0.017ms | 1.08ms | gc-native |
| dom/create-elements | 0.037ms | 0.177ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.557ms | — | — | js |
| dom/read-attributes | 0.122ms | 0.145ms | — | — | js |
| dom/modify-text | 0.051ms | 0.127ms | — | — | js |
| mixed/csv-parse | 0.483ms | 8.48ms | 0.602ms | FAILED | js |
| mixed/text-search | 0.388ms | 2.61ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.087ms | linear-memory |
| mixed/matrix-multiply | 0.160ms | 0.191ms | 0.191ms | 0.721ms | js |
| mixed/sieve | 1.63ms | 1.41ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.96 | 4.50 | 3.62 | — |
| string/concat-long | 1000 | 3.76 | 4.84 | 4.61 | — |
| string/indexOf | 1000 | 19.15 | 66.07 | 23.97 | — |
| string/includes | 1000 | 19.18 | 156.61 | 23.47 | — |
| string/split | 10000 | 42.39 | 561.81 | 44.95 | — |
| string/replace | 1000 | 106.82 | 321.18 | 82.10 | — |
| string/case-convert | 2000 | 29.76 | 122.07 | 55.66 | — |
| string/substring | 10000 | 9.92 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.04 | 90.80 | 24.34 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 133.49 | 14.43 | — |
| array/map-filter | 30000 | 4.58 | 2.09 | 2.10 | — |
| array/indexOf | 1000 | 3949.98 | 3550.50 | 3551.49 | — |
| dom/create-elements | 2000 | 18.72 | 88.55 | — | — |
| dom/set-attributes | 6000 | 17.28 | 92.78 | — | — |
| dom/read-attributes | 3000 | 40.70 | 48.22 | — | — |
| dom/modify-text | 2000 | 25.62 | 63.29 | — | — |
| mixed/csv-parse | 11000 | 43.90 | 771.33 | 54.72 | — |
| mixed/text-search | 40000 | 9.71 | 65.23 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 11.82 | 11.82 | 8.71 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.53 | 1.53 | 5.77 |
| mixed/sieve | 200000 | 8.14 | 7.07 | 7.02 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.52x slower | 1.22x slower | — |
| string/concat-long | 1.29x slower | 1.23x slower | — |
| string/indexOf | 3.45x slower | 1.25x slower | — |
| string/includes | 8.16x slower | 1.22x slower | — |
| string/split | 13.25x slower | 1.06x slower | — |
| string/replace | 3.01x slower | 1.30x faster | — |
| string/case-convert | 4.10x slower | 1.87x slower | — |
| string/substring | 2.65x faster | 3.23x faster | — |
| string/trim | 5.33x slower | 1.43x slower | — |
| string/startsWith-endsWith | 6.66x slower | 1.39x faster | — |
| array/push-pop | 2.97x faster | 2.97x faster | — |
| array/sort-i32 | 2.62x faster | 2.62x faster | — |
| array/map-filter | 2.19x faster | 2.19x faster | — |
| array/reduce | 4.22x faster | 4.26x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.05x slower | 1.13x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.07x faster | 2.07x faster | — |
| array/find | 15.74x faster | 15.77x faster | 4.06x slower |
| dom/create-elements | 4.73x slower | — | — |
| dom/set-attributes | 5.37x slower | — | — |
| dom/read-attributes | 1.18x slower | — | — |
| dom/modify-text | 2.47x slower | — | — |
| mixed/csv-parse | 17.57x slower | 1.25x slower | — |
| mixed/text-search | 6.72x slower | 1.18x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 1.40x faster |
| mixed/matrix-multiply | 1.19x slower | 1.19x slower | 4.50x slower |
| mixed/sieve | 1.15x faster | 1.16x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.24x faster |
| string/concat-long | 1.05x faster |
| string/indexOf | 2.76x faster |
| string/includes | 6.67x faster |
| string/split | 12.50x faster |
| string/replace | 3.91x faster |
| string/case-convert | 2.19x faster |
| string/substring | 1.22x faster |
| string/trim | 3.73x faster |
| string/startsWith-endsWith | 9.25x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.08x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.10x faster |
| mixed/text-search | 7.96x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1368.6ms | 1182.7ms | — |
| string/concat-long | 675.3ms | 1009.8ms | — |
| string/indexOf | 830.3ms | 1072.0ms | — |
| string/includes | 800.9ms | 1031.9ms | — |
| string/split | 793.9ms | 1012.2ms | — |
| string/replace | 851.8ms | 1167.5ms | — |
| string/case-convert | 807.1ms | 1116.6ms | — |
| string/substring | 653.9ms | 740.2ms | — |
| string/trim | 745.0ms | 1006.6ms | — |
| string/startsWith-endsWith | 740.8ms | 1002.0ms | — |
| array/push-pop | 784.9ms | 840.5ms | — |
| array/sort-i32 | 958.5ms | 1029.0ms | — |
| array/map-filter | 928.1ms | 1052.2ms | — |
| array/reduce | 860.2ms | 946.5ms | — |
| array/indexOf | 869.8ms | 954.8ms | — |
| array/slice | 804.8ms | 885.5ms | — |
| array/reverse | 802.1ms | 853.1ms | — |
| array/forEach | 887.0ms | 968.7ms | — |
| array/find | 800.5ms | 868.9ms | 873.6ms |
| dom/create-elements | 647.5ms | — | — |
| dom/set-attributes | 779.7ms | — | — |
| dom/read-attributes | 742.9ms | — | — |
| dom/modify-text | 728.2ms | — | — |
| mixed/csv-parse | 825.4ms | 1013.9ms | — |
| mixed/text-search | 792.5ms | 1080.8ms | — |
| mixed/fibonacci | 820.9ms | 876.1ms | 738.5ms |
| mixed/matrix-multiply | 874.1ms | 934.7ms | 812.1ms |
| mixed/sieve | 886.5ms | 932.7ms | — |
