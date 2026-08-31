# js2wasm Benchmark Results

Date: 2026-08-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.047ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.020ms | gc-native |
| string/includes | 0.019ms | 0.132ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.413ms | 8.04ms | 2.72ms | FAILED | js |
| string/replace | 0.104ms | 0.820ms | 0.314ms | FAILED | js |
| string/case-convert | 0.056ms | 0.559ms | 0.265ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.72ms | 2.72ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.88ms | 2.89ms | 0.565ms | js |
| array/push-pop | 1.43ms | 0.511ms | 0.514ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.383ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.137ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.509ms | 0.513ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.262ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.488ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.485ms | 8.99ms | 0.606ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.21ms | 2.58ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.160ms | 70.78ms | 69.68ms | 0.719ms | js |
| mixed/sieve | 1.62ms | 2.13ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.57 | 4.73 | 4.35 | — |
| string/concat-long | 1000 | 3.65 | 4.46 | 3.90 | — |
| string/indexOf | 1000 | 19.15 | 63.54 | 12.34 | 19.71 |
| string/includes | 1000 | 19.21 | 131.52 | 14.82 | 15.43 |
| string/split | 10000 | 41.29 | 804.36 | 271.70 | — |
| string/replace | 1000 | 104.43 | 820.25 | 314.29 | — |
| string/case-convert | 2000 | 27.80 | 279.26 | 132.60 | — |
| string/substring | 10000 | 9.88 | 3.73 | 3.08 | — |
| string/trim | 10000 | 17.00 | 372.48 | 271.56 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 144.01 | 144.59 | 28.26 |
| array/map-filter | 30000 | 4.57 | 2.36 | 2.35 | — |
| array/indexOf | 1000 | 3950.70 | 2634.26 | 2633.69 | — |
| dom/create-elements | 2000 | 17.31 | 76.17 | — | — |
| dom/set-attributes | 6000 | 17.49 | 81.35 | — | — |
| dom/read-attributes | 3000 | 18.87 | 40.78 | — | — |
| dom/modify-text | 2000 | 14.38 | 57.15 | — | — |
| mixed/csv-parse | 11000 | 44.09 | 817.10 | 55.14 | — |
| mixed/text-search | 40000 | 9.71 | 130.32 | 64.44 | 27.46 |
| mixed/fibonacci | 10000 | 12.17 | 28.31 | 28.30 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.28 | 566.22 | 557.43 | 5.75 |
| mixed/sieve | 200000 | 8.08 | 10.64 | 10.70 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.33x slower | 1.22x slower | — |
| string/concat-long | 1.22x slower | 1.07x slower | — |
| string/indexOf | 3.32x slower | 1.55x faster | 1.03x slower |
| string/includes | 6.85x slower | 1.30x faster | 1.24x faster |
| string/split | 19.48x slower | 6.58x slower | — |
| string/replace | 7.85x slower | 3.01x slower | — |
| string/case-convert | 10.05x slower | 4.77x slower | — |
| string/substring | 2.65x faster | 3.21x faster | — |
| string/trim | 21.91x slower | 15.98x slower | — |
| string/startsWith-endsWith | 7.18x slower | 7.21x slower | 1.41x slower |
| array/push-pop | 2.80x faster | 2.78x faster | — |
| array/sort-i32 | 2.07x faster | 2.69x faster | — |
| array/map-filter | 1.94x faster | 1.95x faster | — |
| array/reduce | 4.22x faster | 4.19x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.01x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.82x faster | 1.83x faster | — |
| array/find | 16.76x faster | 16.60x faster | 4.10x slower |
| dom/create-elements | 4.40x slower | — | — |
| dom/set-attributes | 4.65x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.97x slower | — | — |
| mixed/csv-parse | 18.53x slower | 1.25x slower | — |
| mixed/text-search | 13.42x slower | 6.64x slower | 2.83x slower |
| mixed/fibonacci | 2.33x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 443.41x slower | 436.53x slower | 4.50x slower |
| mixed/sieve | 1.32x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.14x faster |
| string/indexOf | 5.15x faster |
| string/includes | 8.87x faster |
| string/split | 2.96x faster |
| string/replace | 2.61x faster |
| string/case-convert | 2.11x faster |
| string/substring | 1.21x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.30x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.06x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.82x faster |
| mixed/text-search | 2.02x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x faster |
| mixed/sieve | 1.01x slower |

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
| array/indexOf | 1.7KB | 2.0KB | — |
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
| mixed/matrix-multiply | 2.4KB | 3.0KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1738.1ms | 1109.3ms | — |
| string/concat-long | 783.3ms | 982.9ms | — |
| string/indexOf | 663.9ms | 984.8ms | 864.9ms |
| string/includes | 685.0ms | 987.5ms | 851.7ms |
| string/split | 790.6ms | 1021.1ms | — |
| string/replace | 763.9ms | 1108.2ms | — |
| string/case-convert | 795.6ms | 888.4ms | — |
| string/substring | 683.1ms | 800.4ms | — |
| string/trim | 780.9ms | 1020.3ms | — |
| string/startsWith-endsWith | 801.2ms | 1016.3ms | 920.9ms |
| array/push-pop | 801.7ms | 923.2ms | — |
| array/sort-i32 | 984.7ms | 1046.7ms | — |
| array/map-filter | 970.8ms | 1055.2ms | — |
| array/reduce | 868.1ms | 984.1ms | — |
| array/indexOf | 880.3ms | 973.1ms | — |
| array/slice | 778.4ms | 889.6ms | — |
| array/reverse | 767.8ms | 860.6ms | — |
| array/forEach | 907.2ms | 998.5ms | — |
| array/find | 778.9ms | 886.8ms | 850.1ms |
| dom/create-elements | 716.3ms | — | — |
| dom/set-attributes | 720.4ms | — | — |
| dom/read-attributes | 700.4ms | — | — |
| dom/modify-text | 683.2ms | — | — |
| mixed/csv-parse | 804.5ms | 965.7ms | — |
| mixed/text-search | 804.6ms | 1024.8ms | 914.8ms |
| mixed/fibonacci | 762.8ms | 795.8ms | 765.8ms |
| mixed/matrix-multiply | 889.6ms | 1003.5ms | 824.4ms |
| mixed/sieve | 871.4ms | 948.4ms | — |
