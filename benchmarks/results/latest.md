# js2wasm Benchmark Results

Date: 2026-10-19
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.043ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.425ms | 0.410ms | 0.413ms | FAILED | host-call |
| string/replace | 0.102ms | 0.054ms | 0.055ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.403ms | 0.220ms | 0.220ms | 0.561ms | host-call |
| array/push-pop | 1.44ms | 0.515ms | 0.521ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.396ms | 0.409ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.076ms | 0.082ms | FAILED | host-call |
| array/reduce | 2.23ms | 0.528ms | 0.520ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.028ms | 0.032ms | 0.031ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.050ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.233ms | 0.013ms | 0.013ms | 1.09ms | host-call |
| dom/create-elements | 0.042ms | 0.935ms | — | — | js |
| dom/set-attributes | 0.106ms | 6.75ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.032ms | 1.74ms | — | — | js |
| mixed/csv-parse | 0.484ms | 0.318ms | 0.318ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.263ms | 0.263ms | 1.11ms | host-call |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.165ms | 0.214ms | 0.213ms | 0.718ms | js |
| mixed/sieve | 1.95ms | 2.14ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.21 | 4.28 | 4.60 | — |
| string/concat-long | 1000 | 3.75 | 3.23 | 3.16 | — |
| string/indexOf | 1000 | 19.24 | 16.32 | 16.29 | 14.79 |
| string/includes | 1000 | 19.22 | 20.98 | 20.82 | 15.42 |
| string/split | 10000 | 42.45 | 41.00 | 41.28 | — |
| string/replace | 1000 | 101.81 | 54.29 | 54.65 | — |
| string/case-convert | 2000 | 27.89 | 3.28 | 3.27 | — |
| string/substring | 10000 | 9.94 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.05 | 16.26 | 16.33 | — |
| string/startsWith-endsWith | 20000 | 20.13 | 11.01 | 11.01 | 28.06 |
| array/map-filter | 30000 | 4.47 | 2.55 | 2.75 | — |
| array/indexOf | 1000 | 3955.01 | 2642.20 | 2644.36 | — |
| dom/create-elements | 2000 | 21.04 | 467.71 | — | — |
| dom/set-attributes | 6000 | 17.67 | 1125.75 | — | — |
| dom/read-attributes | 3000 | 18.71 | — | — | — |
| dom/modify-text | 2000 | 16.06 | 869.23 | — | — |
| mixed/csv-parse | 11000 | 44.02 | 28.94 | 28.91 | — |
| mixed/text-search | 40000 | 9.75 | 6.57 | 6.59 | 27.68 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.31 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.32 | 1.71 | 1.70 | 5.74 |
| mixed/sieve | 200000 | 9.73 | 10.68 | 10.72 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.33x slower | 1.43x slower | — |
| string/concat-long | 1.16x faster | 1.19x faster | — |
| string/indexOf | 1.18x faster | 1.18x faster | 1.30x faster |
| string/includes | 1.09x slower | 1.08x slower | 1.25x faster |
| string/split | 1.04x faster | 1.03x faster | — |
| string/replace | 1.88x faster | 1.86x faster | — |
| string/case-convert | 8.49x faster | 8.52x faster | — |
| string/substring | 3.23x faster | 3.23x faster | — |
| string/trim | 1.05x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.83x faster | 1.83x faster | 1.39x slower |
| array/push-pop | 2.80x faster | 2.77x faster | — |
| array/sort-i32 | 2.00x faster | 1.94x faster | — |
| array/map-filter | 1.76x faster | 1.63x faster | — |
| array/reduce | 4.23x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.14x slower | 1.10x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.01x faster | 1.01x faster | — |
| array/find | 18.53x faster | 17.86x faster | 4.66x slower |
| dom/create-elements | 22.23x slower | — | — |
| dom/set-attributes | 63.71x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 54.13x slower | — | — |
| mixed/csv-parse | 1.52x faster | 1.52x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.84x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 1.30x slower | 1.29x slower | 4.34x slower |
| mixed/sieve | 1.10x slower | 1.10x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x slower |
| string/concat-long | 1.02x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x faster |
| string/split | 1.01x slower |
| string/replace | 1.01x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.04x slower |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x slower |

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
| array/sort-i32 | 27.8KB | 27.8KB | — |
| array/map-filter | 28.9KB | 29.0KB | — |
| array/reduce | 27.4KB | 27.4KB | — |
| array/indexOf | 26.4KB | 26.4KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.6KB | 27.6KB | — |
| array/find | 61.8KB | 61.8KB | 634B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 991B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1381.4ms | 560.9ms | — |
| string/concat-long | 1074.2ms | 982.3ms | — |
| string/indexOf | 991.1ms | 972.5ms | 542.7ms |
| string/includes | 965.1ms | 971.1ms | 572.6ms |
| string/split | 1080.8ms | 1071.5ms | — |
| string/replace | 1138.9ms | 1107.4ms | — |
| string/case-convert | 1068.0ms | 1093.9ms | — |
| string/substring | 511.0ms | 508.9ms | — |
| string/trim | 1050.4ms | 1055.1ms | — |
| string/startsWith-endsWith | 1086.4ms | 1067.0ms | 641.2ms |
| array/push-pop | 1039.1ms | 1060.9ms | — |
| array/sort-i32 | 1209.7ms | 1163.8ms | — |
| array/map-filter | 1240.6ms | 1171.9ms | — |
| array/reduce | 1153.6ms | 1147.0ms | — |
| array/indexOf | 1121.4ms | 1109.5ms | — |
| array/slice | 1067.5ms | 1041.4ms | — |
| array/reverse | 1079.0ms | 1044.0ms | — |
| array/forEach | 1122.3ms | 1100.2ms | — |
| array/find | 2489.9ms | 2469.4ms | 575.8ms |
| dom/create-elements | 705.4ms | — | — |
| dom/set-attributes | 631.4ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 621.0ms | — | — |
| mixed/csv-parse | 1107.2ms | 1078.8ms | — |
| mixed/text-search | 1108.9ms | 1154.0ms | 657.9ms |
| mixed/fibonacci | 580.8ms | 536.3ms | 494.8ms |
| mixed/matrix-multiply | 1121.1ms | 1096.8ms | 542.6ms |
| mixed/sieve | 1084.2ms | 1104.4ms | — |
