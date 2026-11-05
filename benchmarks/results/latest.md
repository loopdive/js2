# js2wasm Benchmark Results

Date: 2026-11-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.042ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.412ms | 0.413ms | 0.416ms | FAILED | js |
| string/replace | 0.111ms | 0.055ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.098ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.223ms | 0.561ms | host-call |
| array/push-pop | 1.48ms | 0.533ms | 0.533ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.397ms | 0.397ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.076ms | 0.082ms | FAILED | host-call |
| array/reduce | 2.29ms | 0.544ms | 0.549ms | FAILED | host-call |
| array/indexOf | 3.96ms | 5.23ms | 5.23ms | FAILED | js |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.049ms | 0.049ms | FAILED | gc-native |
| array/find | 0.255ms | 0.012ms | 0.012ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.939ms | — | — | js |
| dom/set-attributes | 0.106ms | 6.77ms | — | — | js |
| dom/read-attributes | 0.060ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | 1.67ms | — | — | js |
| mixed/csv-parse | 0.480ms | 0.319ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.396ms | 0.263ms | 0.263ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.229ms | 0.213ms | 0.727ms | js |
| mixed/sieve | 1.69ms | 2.14ms | 2.17ms | FAILED | js |

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
| dom/read-attributes | host-call | warmup | dereferencing a null pointer |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.91 | 4.22 | 4.38 | — |
| string/concat-long | 1000 | 3.57 | 3.01 | 3.01 | — |
| string/indexOf | 1000 | 19.18 | 16.21 | 16.18 | 15.09 |
| string/includes | 1000 | 19.22 | 20.95 | 20.81 | 15.37 |
| string/split | 10000 | 41.18 | 41.27 | 41.56 | — |
| string/replace | 1000 | 111.14 | 54.79 | 53.98 | — |
| string/case-convert | 2000 | 27.79 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.84 | 3.07 | 3.08 | — |
| string/trim | 10000 | 16.98 | 16.31 | 16.26 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 11.01 | 11.14 | 28.06 |
| array/map-filter | 30000 | 4.32 | 2.53 | 2.73 | — |
| array/indexOf | 1000 | 3955.90 | 5233.21 | 5232.88 | — |
| dom/create-elements | 2000 | 17.93 | 469.63 | — | — |
| dom/set-attributes | 6000 | 17.70 | 1128.24 | — | — |
| dom/read-attributes | 3000 | 19.86 | — | — | — |
| dom/modify-text | 2000 | 14.76 | 834.81 | — | — |
| mixed/csv-parse | 11000 | 43.63 | 28.97 | 28.69 | — |
| mixed/text-search | 40000 | 9.89 | 6.58 | 6.58 | 27.45 |
| mixed/fibonacci | 10000 | 12.19 | 28.30 | 28.31 | 28.10 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.83 | 1.71 | 5.82 |
| mixed/sieve | 200000 | 8.43 | 10.72 | 10.87 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.50x slower | — |
| string/concat-long | 1.18x faster | 1.19x faster | — |
| string/indexOf | 1.18x faster | 1.19x faster | 1.27x faster |
| string/includes | 1.09x slower | 1.08x slower | 1.25x faster |
| string/split | 1.00x slower | 1.01x slower | — |
| string/replace | 2.03x faster | 2.06x faster | — |
| string/case-convert | 8.48x faster | 8.48x faster | — |
| string/substring | 3.21x faster | 3.20x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.80x faster | 1.40x slower |
| array/push-pop | 2.77x faster | 2.77x faster | — |
| array/sort-i32 | 1.98x faster | 1.98x faster | — |
| array/map-filter | 1.71x faster | 1.58x faster | — |
| array/reduce | 4.22x faster | 4.17x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.08x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.00x faster | 1.00x faster | — |
| array/find | 21.62x faster | 20.47x faster | 4.25x slower |
| dom/create-elements | 26.19x slower | — | — |
| dom/set-attributes | 63.72x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 56.56x slower | — | — |
| mixed/csv-parse | 1.51x faster | 1.52x faster | — |
| mixed/text-search | 1.50x faster | 1.50x faster | 2.78x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 1.45x slower | 1.35x slower | 4.59x slower |
| mixed/sieve | 1.27x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x slower |
| string/concat-long | 1.00x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x faster |
| string/split | 1.01x slower |
| string/replace | 1.02x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.06x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.07x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.5KB | 1.5KB | — |
| string/concat-long | 18.8KB | 18.8KB | — |
| string/indexOf | 18.9KB | 18.9KB | 10.4KB |
| string/includes | 19.0KB | 19.0KB | 10.4KB |
| string/split | 26.7KB | 26.7KB | — |
| string/replace | 27.5KB | 27.5KB | — |
| string/case-convert | 26.3KB | 26.3KB | — |
| string/substring | 1.0KB | 1.0KB | — |
| string/trim | 26.3KB | 26.3KB | — |
| string/startsWith-endsWith | 27.3KB | 27.3KB | 1.7KB |
| array/push-pop | 25.3KB | 25.3KB | — |
| array/sort-i32 | 28.0KB | 28.0KB | — |
| array/map-filter | 29.1KB | 29.1KB | — |
| array/reduce | 27.6KB | 27.6KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.8KB | 27.8KB | — |
| array/find | 61.8KB | 61.8KB | 666B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 1019B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1457.9ms | 617.1ms | — |
| string/concat-long | 1080.9ms | 994.9ms | — |
| string/indexOf | 1013.4ms | 1017.3ms | 605.2ms |
| string/includes | 1025.2ms | 996.5ms | 586.0ms |
| string/split | 1103.0ms | 1111.0ms | — |
| string/replace | 1155.1ms | 1159.1ms | — |
| string/case-convert | 1089.1ms | 1091.2ms | — |
| string/substring | 552.7ms | 553.6ms | — |
| string/trim | 1077.8ms | 1062.4ms | — |
| string/startsWith-endsWith | 1125.6ms | 1084.8ms | 671.4ms |
| array/push-pop | 1075.4ms | 1094.7ms | — |
| array/sort-i32 | 1149.3ms | 1135.3ms | — |
| array/map-filter | 1269.5ms | 1224.4ms | — |
| array/reduce | 1158.0ms | 1168.4ms | — |
| array/indexOf | 1135.9ms | 1116.0ms | — |
| array/slice | 1102.1ms | 1104.4ms | — |
| array/reverse | 1095.8ms | 1114.0ms | — |
| array/forEach | 1162.5ms | 1151.1ms | — |
| array/find | 3170.2ms | 3142.5ms | 597.9ms |
| dom/create-elements | 698.3ms | — | — |
| dom/set-attributes | 687.9ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 689.6ms | — | — |
| mixed/csv-parse | 1144.0ms | 1124.9ms | — |
| mixed/text-search | 1132.0ms | 1177.1ms | 702.6ms |
| mixed/fibonacci | 618.0ms | 604.7ms | 522.3ms |
| mixed/matrix-multiply | 1154.1ms | 1157.7ms | 582.4ms |
| mixed/sieve | 1153.9ms | 1159.0ms | — |
