# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.054ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.015ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.131ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.429ms | 5.17ms | 0.450ms | FAILED | js |
| string/replace | 0.105ms | 0.302ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.244ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.101ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.178ms | 0.890ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.296ms | 0.561ms | gc-native |
| array/push-pop | 1.41ms | 0.508ms | 0.512ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.294ms | 0.328ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.500ms | 0.502ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 0.996ms | gc-native |
| dom/create-elements | 0.206ms | 0.174ms | — | — | host-call |
| dom/set-attributes | 0.106ms | 0.552ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.123ms | — | — | js |
| dom/modify-text | 0.034ms | 0.107ms | — | — | js |
| mixed/csv-parse | 1.39ms | 7.26ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.81ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.289ms | js |
| mixed/matrix-multiply | 0.157ms | 0.225ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.62ms | 1.41ms | 1.42ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.15 | 5.40 | 3.77 | — |
| string/concat-long | 1000 | 3.59 | 4.52 | 3.62 | — |
| string/indexOf | 1000 | 19.11 | 62.84 | 15.13 | 15.65 |
| string/includes | 1000 | 19.22 | 131.46 | 14.86 | 15.41 |
| string/split | 10000 | 42.86 | 516.92 | 45.03 | — |
| string/replace | 1000 | 105.12 | 301.67 | 56.32 | — |
| string/case-convert | 2000 | 28.09 | 121.95 | 2.51 | — |
| string/substring | 10000 | 10.08 | 3.74 | 3.14 | — |
| string/trim | 10000 | 17.76 | 88.99 | 18.68 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 17.89 | 14.81 | 28.04 |
| array/map-filter | 30000 | 4.22 | 2.35 | 2.37 | — |
| array/indexOf | 1000 | 3949.38 | 2632.93 | 2635.73 | — |
| dom/create-elements | 2000 | 102.80 | 86.91 | — | — |
| dom/set-attributes | 6000 | 17.74 | 92.03 | — | — |
| dom/read-attributes | 3000 | 19.25 | 41.08 | — | — |
| dom/modify-text | 2000 | 16.99 | 53.67 | — | — |
| mixed/csv-parse | 11000 | 126.46 | 660.19 | 28.77 | — |
| mixed/text-search | 40000 | 9.75 | 45.13 | 6.66 | 26.93 |
| mixed/fibonacci | 10000 | 12.19 | 29.24 | 29.23 | 28.89 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.80 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 8.09 | 7.04 | 7.08 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.71x slower | 1.20x slower | — |
| string/concat-long | 1.26x slower | 1.01x slower | — |
| string/indexOf | 3.29x slower | 1.26x faster | 1.22x faster |
| string/includes | 6.84x slower | 1.29x faster | 1.25x faster |
| string/split | 12.06x slower | 1.05x slower | — |
| string/replace | 2.87x slower | 1.87x faster | — |
| string/case-convert | 4.34x slower | 11.21x faster | — |
| string/substring | 2.70x faster | 3.21x faster | — |
| string/trim | 5.01x slower | 1.05x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.78x faster | 2.76x faster | — |
| array/sort-i32 | 2.69x faster | 2.41x faster | — |
| array/map-filter | 1.80x faster | 1.78x faster | — |
| array/reduce | 4.30x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.75x faster | — |
| array/find | 15.79x faster | 15.85x faster | 3.94x slower |
| dom/create-elements | 1.18x faster | — | — |
| dom/set-attributes | 5.19x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.16x slower | — | — |
| mixed/csv-parse | 5.22x slower | 4.40x faster | — |
| mixed/text-search | 4.63x slower | 1.46x faster | 2.76x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.37x slower |
| mixed/matrix-multiply | 1.43x slower | 1.33x slower | 4.56x slower |
| mixed/sieve | 1.15x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.43x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 4.15x faster |
| string/includes | 8.85x faster |
| string/split | 11.48x faster |
| string/replace | 5.36x faster |
| string/case-convert | 48.67x faster |
| string/substring | 1.19x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.12x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 22.95x faster |
| mixed/text-search | 6.78x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x faster |
| mixed/sieve | 1.01x slower |

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
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
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
| string/concat-short | 1335.8ms | 1118.3ms | — |
| string/concat-long | 628.2ms | 947.0ms | — |
| string/indexOf | 683.0ms | 948.6ms | 868.5ms |
| string/includes | 653.6ms | 967.2ms | 847.8ms |
| string/split | 824.1ms | 912.3ms | — |
| string/replace | 771.7ms | 1066.6ms | — |
| string/case-convert | 772.2ms | 892.1ms | — |
| string/substring | 646.6ms | 736.6ms | — |
| string/trim | 754.1ms | 977.2ms | — |
| string/startsWith-endsWith | 766.6ms | 988.2ms | 896.5ms |
| array/push-pop | 770.2ms | 825.4ms | — |
| array/sort-i32 | 920.3ms | 1012.2ms | — |
| array/map-filter | 918.1ms | 1003.0ms | — |
| array/reduce | 841.1ms | 909.4ms | — |
| array/indexOf | 834.9ms | 924.4ms | — |
| array/slice | 748.7ms | 845.1ms | — |
| array/reverse | 746.9ms | 825.0ms | — |
| array/forEach | 850.6ms | 983.0ms | — |
| array/find | 769.2ms | 836.6ms | 837.3ms |
| dom/create-elements | 653.9ms | — | — |
| dom/set-attributes | 729.5ms | — | — |
| dom/read-attributes | 730.9ms | — | — |
| dom/modify-text | 638.9ms | — | — |
| mixed/csv-parse | 800.5ms | 980.6ms | — |
| mixed/text-search | 803.1ms | 989.7ms | 916.4ms |
| mixed/fibonacci | 748.3ms | 775.0ms | 800.6ms |
| mixed/matrix-multiply | 836.7ms | 904.2ms | 788.9ms |
| mixed/sieve | 844.2ms | 916.0ms | — |
