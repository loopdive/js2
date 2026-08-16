# js2wasm Benchmark Results

Date: 2026-08-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.044ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.013ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.138ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.408ms | 4.93ms | 0.449ms | FAILED | js |
| string/replace | 0.110ms | 0.306ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.227ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.887ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.297ms | 0.560ms | gc-native |
| array/push-pop | 1.40ms | 0.502ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.295ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.13ms | 0.504ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.64ms | FAILED | host-call |
| array/slice | 0.024ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.157ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.550ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.129ms | — | — | js |
| dom/modify-text | 0.028ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.482ms | 7.41ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.85ms | 0.267ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.289ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.721ms | js |
| mixed/sieve | 1.56ms | 1.41ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.93 | 4.39 | 3.73 | — |
| string/concat-long | 1000 | 3.54 | 4.51 | 3.53 | — |
| string/indexOf | 1000 | 19.16 | 62.85 | 13.12 | 15.82 |
| string/includes | 1000 | 19.16 | 138.06 | 14.66 | 70.71 |
| string/split | 10000 | 40.83 | 493.06 | 44.86 | — |
| string/replace | 1000 | 110.31 | 305.86 | 56.26 | — |
| string/case-convert | 2000 | 27.79 | 113.72 | 2.51 | — |
| string/substring | 10000 | 9.87 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.01 | 88.68 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 17.91 | 14.83 | 28.01 |
| array/map-filter | 30000 | 4.31 | 2.36 | 2.33 | — |
| array/indexOf | 1000 | 3950.18 | 2634.41 | 2636.96 | — |
| dom/create-elements | 2000 | 17.60 | 78.54 | — | — |
| dom/set-attributes | 6000 | 16.95 | 91.67 | — | — |
| dom/read-attributes | 3000 | 18.87 | 43.07 | — | — |
| dom/modify-text | 2000 | 14.06 | 52.96 | — | — |
| mixed/csv-parse | 11000 | 43.79 | 673.62 | 28.50 | — |
| mixed/text-search | 40000 | 9.71 | 46.17 | 6.67 | 27.39 |
| mixed/fibonacci | 10000 | 12.17 | 29.16 | 29.15 | 28.88 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.77 |
| mixed/sieve | 200000 | 7.82 | 7.04 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.28x slower | — |
| string/concat-long | 1.27x slower | 1.00x faster | — |
| string/indexOf | 3.28x slower | 1.46x faster | 1.21x faster |
| string/includes | 7.20x slower | 1.31x faster | 3.69x slower |
| string/split | 12.08x slower | 1.10x slower | — |
| string/replace | 2.77x slower | 1.96x faster | — |
| string/case-convert | 4.09x slower | 11.07x faster | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 5.21x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.78x faster | 2.77x faster | — |
| array/sort-i32 | 2.67x faster | 2.68x faster | — |
| array/map-filter | 1.83x faster | 1.85x faster | — |
| array/reduce | 4.23x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.05x faster | 3.08x faster | — |
| array/find | 15.89x faster | 16.06x faster | 4.26x slower |
| dom/create-elements | 4.46x slower | — | — |
| dom/set-attributes | 5.41x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.77x slower | — | — |
| mixed/csv-parse | 15.38x slower | 1.54x faster | — |
| mixed/text-search | 4.76x slower | 1.46x faster | 2.82x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.37x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.57x slower |
| mixed/sieve | 1.11x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 4.79x faster |
| string/includes | 9.42x faster |
| string/split | 10.99x faster |
| string/replace | 5.44x faster |
| string/case-convert | 45.32x faster |
| string/substring | 1.22x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 23.63x faster |
| mixed/text-search | 6.92x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1316.4ms | 1093.8ms | — |
| string/concat-long | 640.5ms | 949.5ms | — |
| string/indexOf | 682.9ms | 963.0ms | 836.6ms |
| string/includes | 662.3ms | 953.5ms | 825.7ms |
| string/split | 780.5ms | 950.0ms | — |
| string/replace | 767.1ms | 1074.8ms | — |
| string/case-convert | 805.6ms | 853.7ms | — |
| string/substring | 647.8ms | 772.9ms | — |
| string/trim | 747.8ms | 1003.3ms | — |
| string/startsWith-endsWith | 777.2ms | 1000.6ms | 897.3ms |
| array/push-pop | 761.4ms | 808.7ms | — |
| array/sort-i32 | 901.6ms | 1009.6ms | — |
| array/map-filter | 938.3ms | 984.5ms | — |
| array/reduce | 813.1ms | 930.6ms | — |
| array/indexOf | 834.8ms | 905.4ms | — |
| array/slice | 742.5ms | 842.2ms | — |
| array/reverse | 745.9ms | 825.8ms | — |
| array/forEach | 866.0ms | 961.2ms | — |
| array/find | 753.6ms | 846.9ms | 834.6ms |
| dom/create-elements | 612.2ms | — | — |
| dom/set-attributes | 672.8ms | — | — |
| dom/read-attributes | 664.4ms | — | — |
| dom/modify-text | 577.6ms | — | — |
| mixed/csv-parse | 783.1ms | 915.4ms | — |
| mixed/text-search | 761.7ms | 1005.6ms | 889.8ms |
| mixed/fibonacci | 739.7ms | 773.7ms | 762.1ms |
| mixed/matrix-multiply | 843.2ms | 903.0ms | 812.1ms |
| mixed/sieve | 889.9ms | 918.4ms | — |
