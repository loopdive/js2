# js2wasm Benchmark Results

Date: 2026-08-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.073ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.013ms | 0.064ms | gc-native |
| string/includes | 0.019ms | 0.048ms | 0.015ms | 0.026ms | gc-native |
| string/split | 0.423ms | 4.98ms | 0.450ms | FAILED | js |
| string/replace | 0.104ms | 0.315ms | 0.073ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.239ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.889ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.297ms | 0.563ms | gc-native |
| array/push-pop | 1.42ms | 0.504ms | 0.503ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.305ms | 0.303ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.068ms | 0.068ms | FAILED | gc-native |
| array/reduce | 1.34ms | 0.505ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.034ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.595ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.122ms | — | — | js |
| dom/modify-text | 0.028ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.990ms | 7.47ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.84ms | 0.264ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.235ms | 0.235ms | 0.249ms | js |
| mixed/matrix-multiply | 0.162ms | 0.210ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.54ms | 1.39ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.84 | 7.29 | 3.84 | — |
| string/concat-long | 1000 | 3.56 | 4.46 | 3.74 | — |
| string/indexOf | 1000 | 19.19 | 64.43 | 12.69 | 64.00 |
| string/includes | 1000 | 19.15 | 48.14 | 14.53 | 25.98 |
| string/split | 10000 | 42.34 | 497.52 | 44.98 | — |
| string/replace | 1000 | 104.45 | 315.18 | 73.42 | — |
| string/case-convert | 2000 | 27.95 | 119.50 | 2.58 | — |
| string/substring | 10000 | 9.92 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.05 | 88.86 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 17.89 | 14.83 | 28.16 |
| array/map-filter | 30000 | 4.28 | 2.26 | 2.25 | — |
| array/indexOf | 1000 | 3948.50 | 2637.30 | 2635.92 | — |
| dom/create-elements | 2000 | 17.05 | 76.12 | — | — |
| dom/set-attributes | 6000 | 17.31 | 99.22 | — | — |
| dom/read-attributes | 3000 | 17.93 | 40.56 | — | — |
| dom/modify-text | 2000 | 14.16 | 52.79 | — | — |
| mixed/csv-parse | 11000 | 90.03 | 678.91 | 28.69 | — |
| mixed/text-search | 40000 | 9.73 | 45.96 | 6.60 | 27.05 |
| mixed/fibonacci | 10000 | 12.17 | 23.48 | 23.46 | 24.94 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.68 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 7.70 | 6.95 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.57x slower | 1.35x slower | — |
| string/concat-long | 1.25x slower | 1.05x slower | — |
| string/indexOf | 3.36x slower | 1.51x faster | 3.34x slower |
| string/includes | 2.51x slower | 1.32x faster | 1.36x slower |
| string/split | 11.75x slower | 1.06x slower | — |
| string/replace | 3.02x slower | 1.42x faster | — |
| string/case-convert | 4.28x slower | 10.83x faster | — |
| string/substring | 2.64x faster | 3.23x faster | — |
| string/trim | 5.21x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.81x faster | 2.82x faster | — |
| array/sort-i32 | 2.60x faster | 2.62x faster | — |
| array/map-filter | 1.89x faster | 1.90x faster | — |
| array/reduce | 2.65x faster | 2.65x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.08x faster | 3.09x faster | — |
| array/find | 15.72x faster | 15.96x faster | 4.24x slower |
| dom/create-elements | 4.47x slower | — | — |
| dom/set-attributes | 5.73x slower | — | — |
| dom/read-attributes | 2.26x slower | — | — |
| dom/modify-text | 3.73x slower | — | — |
| mixed/csv-parse | 7.54x slower | 3.14x faster | — |
| mixed/text-search | 4.72x slower | 1.47x faster | 2.78x slower |
| mixed/fibonacci | 1.93x slower | 1.93x slower | 2.05x slower |
| mixed/matrix-multiply | 1.30x slower | 1.29x slower | 4.42x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.90x faster |
| string/concat-long | 1.19x faster |
| string/indexOf | 5.08x faster |
| string/includes | 3.31x faster |
| string/split | 11.06x faster |
| string/replace | 4.29x faster |
| string/case-convert | 46.30x faster |
| string/substring | 1.22x faster |
| string/trim | 4.77x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 23.67x faster |
| mixed/text-search | 6.97x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 348B | 348B | 340B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1316.6ms | 1147.6ms | — |
| string/concat-long | 652.1ms | 1019.9ms | — |
| string/indexOf | 835.8ms | 1050.1ms | 877.3ms |
| string/includes | 836.4ms | 1024.1ms | 880.9ms |
| string/split | 773.2ms | 1029.7ms | — |
| string/replace | 896.8ms | 1146.9ms | — |
| string/case-convert | 864.3ms | 899.4ms | — |
| string/substring | 670.5ms | 787.6ms | — |
| string/trim | 779.3ms | 985.0ms | — |
| string/startsWith-endsWith | 745.2ms | 999.1ms | 928.5ms |
| array/push-pop | 773.0ms | 861.9ms | — |
| array/sort-i32 | 958.6ms | 1050.7ms | — |
| array/map-filter | 920.0ms | 1009.8ms | — |
| array/reduce | 877.2ms | 874.8ms | — |
| array/indexOf | 961.7ms | 997.7ms | — |
| array/slice | 774.5ms | 872.4ms | — |
| array/reverse | 769.1ms | 825.6ms | — |
| array/forEach | 855.0ms | 959.1ms | — |
| array/find | 741.5ms | 841.3ms | 835.6ms |
| dom/create-elements | 608.3ms | — | — |
| dom/set-attributes | 716.4ms | — | — |
| dom/read-attributes | 697.8ms | — | — |
| dom/modify-text | 616.4ms | — | — |
| mixed/csv-parse | 783.8ms | 1030.0ms | — |
| mixed/text-search | 751.5ms | 1010.1ms | 907.6ms |
| mixed/fibonacci | 812.8ms | 836.8ms | 779.6ms |
| mixed/matrix-multiply | 837.0ms | 888.7ms | 781.7ms |
| mixed/sieve | 789.0ms | 903.1ms | — |
