# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.047ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.130ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.411ms | 8.43ms | 2.89ms | FAILED | js |
| string/replace | 0.111ms | 0.684ms | 0.305ms | FAILED | js |
| string/case-convert | 0.056ms | 0.589ms | 0.249ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 3.75ms | 2.74ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.67ms | 2.98ms | 0.561ms | js |
| array/push-pop | 1.39ms | 0.499ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.292ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.069ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.13ms | 0.501ms | 0.504ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.034ms | 0.150ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.520ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.495ms | 8.87ms | 0.612ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.38ms | 2.56ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.290ms | js |
| mixed/matrix-multiply | 0.158ms | 70.62ms | 71.85ms | 0.718ms | js |
| mixed/sieve | 1.59ms | 2.13ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.06 | 4.70 | 4.05 | — |
| string/concat-long | 1000 | 3.55 | 4.45 | 3.59 | — |
| string/indexOf | 1000 | 19.13 | 63.57 | 12.30 | 14.95 |
| string/includes | 1000 | 19.21 | 130.07 | 14.77 | 15.38 |
| string/split | 10000 | 41.13 | 842.53 | 289.29 | — |
| string/replace | 1000 | 110.62 | 683.89 | 305.07 | — |
| string/case-convert | 2000 | 27.78 | 294.47 | 124.61 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.94 | 374.83 | 274.13 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 133.69 | 148.80 | 28.06 |
| array/map-filter | 30000 | 4.29 | 2.31 | 2.32 | — |
| array/indexOf | 1000 | 3951.63 | 2640.51 | 2641.93 | — |
| dom/create-elements | 2000 | 17.12 | 75.18 | — | — |
| dom/set-attributes | 6000 | 17.27 | 86.67 | — | — |
| dom/read-attributes | 3000 | 18.10 | 40.39 | — | — |
| dom/modify-text | 2000 | 14.32 | 53.13 | — | — |
| mixed/csv-parse | 11000 | 44.98 | 806.47 | 55.62 | — |
| mixed/text-search | 40000 | 9.70 | 134.49 | 64.11 | 27.38 |
| mixed/fibonacci | 10000 | 12.17 | 28.31 | 28.31 | 29.00 |
| mixed/matrix-multiply | 125000 | 1.26 | 564.92 | 574.84 | 5.75 |
| mixed/sieve | 200000 | 7.93 | 10.63 | 10.59 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.32x slower | — |
| string/concat-long | 1.25x slower | 1.01x slower | — |
| string/indexOf | 3.32x slower | 1.56x faster | 1.28x faster |
| string/includes | 6.77x slower | 1.30x faster | 1.25x faster |
| string/split | 20.48x slower | 7.03x slower | — |
| string/replace | 6.18x slower | 2.76x slower | — |
| string/case-convert | 10.60x slower | 4.49x slower | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 22.13x slower | 16.19x slower | — |
| string/startsWith-endsWith | 6.67x slower | 7.42x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.78x faster | — |
| array/sort-i32 | 2.70x faster | 2.70x faster | — |
| array/map-filter | 1.86x faster | 1.85x faster | — |
| array/reduce | 4.26x faster | 4.23x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.72x faster | — |
| array/find | 15.90x faster | 16.25x faster | 4.23x slower |
| dom/create-elements | 4.39x slower | — | — |
| dom/set-attributes | 5.02x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 3.71x slower | — | — |
| mixed/csv-parse | 17.93x slower | 1.24x slower | — |
| mixed/text-search | 13.86x slower | 6.61x slower | 2.82x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.38x slower |
| mixed/matrix-multiply | 448.27x slower | 456.15x slower | 4.56x slower |
| mixed/sieve | 1.34x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.17x faster |
| string/includes | 8.80x faster |
| string/split | 2.91x faster |
| string/replace | 2.24x faster |
| string/case-convert | 2.36x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.11x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.02x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 14.50x faster |
| mixed/text-search | 2.10x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1700.4ms | 1065.0ms | — |
| string/concat-long | 761.6ms | 958.2ms | — |
| string/indexOf | 654.3ms | 958.3ms | 850.0ms |
| string/includes | 655.3ms | 968.3ms | 814.5ms |
| string/split | 783.9ms | 971.1ms | — |
| string/replace | 773.8ms | 1053.3ms | — |
| string/case-convert | 773.4ms | 862.3ms | — |
| string/substring | 640.1ms | 748.5ms | — |
| string/trim | 745.9ms | 961.4ms | — |
| string/startsWith-endsWith | 762.3ms | 951.1ms | 908.6ms |
| array/push-pop | 769.2ms | 865.6ms | — |
| array/sort-i32 | 906.7ms | 973.7ms | — |
| array/map-filter | 957.9ms | 1003.3ms | — |
| array/reduce | 872.5ms | 895.9ms | — |
| array/indexOf | 858.4ms | 952.3ms | — |
| array/slice | 781.6ms | 871.3ms | — |
| array/reverse | 777.0ms | 864.0ms | — |
| array/forEach | 883.4ms | 1031.7ms | — |
| array/find | 764.6ms | 873.2ms | 825.8ms |
| dom/create-elements | 680.7ms | — | — |
| dom/set-attributes | 717.7ms | — | — |
| dom/read-attributes | 722.9ms | — | — |
| dom/modify-text | 673.7ms | — | — |
| mixed/csv-parse | 782.3ms | 988.6ms | — |
| mixed/text-search | 795.2ms | 983.2ms | 886.5ms |
| mixed/fibonacci | 716.5ms | 779.2ms | 745.4ms |
| mixed/matrix-multiply | 891.6ms | 989.3ms | 804.2ms |
| mixed/sieve | 860.8ms | 915.9ms | — |
