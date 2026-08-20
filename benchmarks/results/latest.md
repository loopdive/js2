# js2wasm Benchmark Results

Date: 2026-08-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.046ms | 0.049ms | 0.054ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.057ms | 0.012ms | 0.063ms | gc-native |
| string/includes | 0.018ms | 0.038ms | 0.014ms | 0.038ms | gc-native |
| string/split | 0.386ms | 4.92ms | 0.419ms | FAILED | js |
| string/replace | 0.106ms | 0.271ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.057ms | 0.279ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.163ms | 0.830ms | 0.181ms | FAILED | js |
| string/startsWith-endsWith | 0.431ms | 0.305ms | 0.279ms | 0.580ms | gc-native |
| array/push-pop | 1.39ms | 0.508ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.717ms | 0.310ms | 0.315ms | FAILED | host-call |
| array/map-filter | 0.150ms | 0.086ms | 0.086ms | FAILED | gc-native |
| array/reduce | 1.33ms | 0.502ms | 0.504ms | FAILED | host-call |
| array/indexOf | 4.83ms | 2.76ms | 2.75ms | FAILED | gc-native |
| array/slice | 0.043ms | 0.036ms | 0.039ms | FAILED | host-call |
| array/reverse | 7.28ms | 3.64ms | 3.64ms | FAILED | gc-native |
| array/forEach | 0.078ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.267ms | 0.017ms | 0.017ms | 0.990ms | host-call |
| dom/create-elements | 0.062ms | 0.180ms | — | — | js |
| dom/set-attributes | 0.127ms | 0.530ms | — | — | js |
| dom/read-attributes | 0.069ms | 0.143ms | — | — | js |
| dom/modify-text | 0.052ms | 0.122ms | — | — | js |
| mixed/csv-parse | 0.479ms | 6.85ms | 0.303ms | FAILED | gc-native |
| mixed/text-search | 0.379ms | 1.52ms | 0.265ms | 1.23ms | gc-native |
| mixed/fibonacci | 0.133ms | 0.301ms | 0.300ms | 0.298ms | js |
| mixed/matrix-multiply | 0.205ms | 0.202ms | 0.202ms | 0.772ms | host-call |
| mixed/sieve | 1.53ms | 1.52ms | 1.53ms | FAILED | host-call |

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
| string/concat-short | 10000 | 4.59 | 4.91 | 5.35 | — |
| string/concat-long | 1000 | 4.61 | 4.99 | 5.92 | — |
| string/indexOf | 1000 | 18.08 | 57.37 | 12.39 | 62.63 |
| string/includes | 1000 | 18.03 | 38.48 | 13.76 | 37.98 |
| string/split | 10000 | 38.59 | 492.44 | 41.95 | — |
| string/replace | 1000 | 105.84 | 271.00 | 58.80 | — |
| string/case-convert | 2000 | 28.51 | 139.59 | 2.63 | — |
| string/substring | 10000 | 9.92 | 4.20 | 3.64 | — |
| string/trim | 10000 | 16.26 | 83.05 | 18.06 | — |
| string/startsWith-endsWith | 20000 | 21.53 | 15.23 | 13.94 | 29.00 |
| array/map-filter | 30000 | 4.99 | 2.86 | 2.86 | — |
| array/indexOf | 1000 | 4830.47 | 2755.10 | 2751.70 | — |
| dom/create-elements | 2000 | 31.13 | 90.18 | — | — |
| dom/set-attributes | 6000 | 21.16 | 88.27 | — | — |
| dom/read-attributes | 3000 | 23.02 | 47.61 | — | — |
| dom/modify-text | 2000 | 25.85 | 60.83 | — | — |
| mixed/csv-parse | 11000 | 43.58 | 622.40 | 27.53 | — |
| mixed/text-search | 40000 | 9.47 | 37.98 | 6.63 | 30.84 |
| mixed/fibonacci | 10000 | 13.28 | 30.14 | 29.99 | 29.83 |
| mixed/matrix-multiply | 125000 | 1.64 | 1.61 | 1.62 | 6.18 |
| mixed/sieve | 200000 | 7.65 | 7.58 | 7.67 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x slower | 1.17x slower | — |
| string/concat-long | 1.08x slower | 1.28x slower | — |
| string/indexOf | 3.17x slower | 1.46x faster | 3.46x slower |
| string/includes | 2.13x slower | 1.31x faster | 2.11x slower |
| string/split | 12.76x slower | 1.09x slower | — |
| string/replace | 2.56x slower | 1.80x faster | — |
| string/case-convert | 4.90x slower | 10.84x faster | — |
| string/substring | 2.37x faster | 2.73x faster | — |
| string/trim | 5.11x slower | 1.11x slower | — |
| string/startsWith-endsWith | 1.41x faster | 1.54x faster | 1.35x slower |
| array/push-pop | 2.74x faster | 2.78x faster | — |
| array/sort-i32 | 2.31x faster | 2.28x faster | — |
| array/map-filter | 1.75x faster | 1.75x faster | — |
| array/reduce | 2.65x faster | 2.64x faster | — |
| array/indexOf | 1.75x faster | 1.76x faster | — |
| array/slice | 1.19x faster | 1.11x faster | — |
| array/reverse | 2.00x faster | 2.00x faster | — |
| array/forEach | 2.73x faster | 2.72x faster | — |
| array/find | 15.45x faster | 15.33x faster | 3.71x slower |
| dom/create-elements | 2.90x slower | — | — |
| dom/set-attributes | 4.17x slower | — | — |
| dom/read-attributes | 2.07x slower | — | — |
| dom/modify-text | 2.35x slower | — | — |
| mixed/csv-parse | 14.28x slower | 1.58x faster | — |
| mixed/text-search | 4.01x slower | 1.43x faster | 3.26x slower |
| mixed/fibonacci | 2.27x slower | 2.26x slower | 2.25x slower |
| mixed/matrix-multiply | 1.01x faster | 1.01x faster | 3.78x slower |
| mixed/sieve | 1.01x faster | 1.00x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x slower |
| string/concat-long | 1.19x slower |
| string/indexOf | 4.63x faster |
| string/includes | 2.80x faster |
| string/split | 11.74x faster |
| string/replace | 4.61x faster |
| string/case-convert | 53.08x faster |
| string/substring | 1.15x faster |
| string/trim | 4.60x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.08x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.61x faster |
| mixed/text-search | 5.73x faster |
| mixed/fibonacci | 1.01x faster |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1252.9ms | 1092.2ms | — |
| string/concat-long | 650.3ms | 984.5ms | — |
| string/indexOf | 701.1ms | 994.3ms | 889.7ms |
| string/includes | 693.7ms | 1021.9ms | 867.0ms |
| string/split | 768.6ms | 983.7ms | — |
| string/replace | 789.6ms | 1139.2ms | — |
| string/case-convert | 807.2ms | 869.7ms | — |
| string/substring | 655.4ms | 744.8ms | — |
| string/trim | 780.0ms | 970.2ms | — |
| string/startsWith-endsWith | 786.7ms | 982.1ms | 930.1ms |
| array/push-pop | 777.4ms | 856.2ms | — |
| array/sort-i32 | 921.3ms | 979.2ms | — |
| array/map-filter | 955.7ms | 1023.3ms | — |
| array/reduce | 867.4ms | 949.5ms | — |
| array/indexOf | 874.8ms | 936.3ms | — |
| array/slice | 778.5ms | 885.8ms | — |
| array/reverse | 768.1ms | 837.5ms | — |
| array/forEach | 909.6ms | 1008.8ms | — |
| array/find | 771.3ms | 841.1ms | 861.0ms |
| dom/create-elements | 621.4ms | — | — |
| dom/set-attributes | 714.5ms | — | — |
| dom/read-attributes | 673.1ms | — | — |
| dom/modify-text | 576.4ms | — | — |
| mixed/csv-parse | 815.0ms | 948.4ms | — |
| mixed/text-search | 827.0ms | 1032.7ms | 924.9ms |
| mixed/fibonacci | 753.1ms | 849.7ms | 834.8ms |
| mixed/matrix-multiply | 878.2ms | 982.0ms | 823.4ms |
| mixed/sieve | 878.0ms | 917.7ms | — |
