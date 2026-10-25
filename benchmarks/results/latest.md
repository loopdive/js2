# js2wasm Benchmark Results

Date: 2026-10-25
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.048ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.017ms | 0.017ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.024ms | js |
| string/split | 0.428ms | 0.412ms | 0.416ms | FAILED | host-call |
| string/replace | 0.114ms | 0.054ms | 0.054ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.402ms | 0.220ms | 0.220ms | 0.561ms | gc-native |
| array/push-pop | 1.44ms | 0.512ms | 0.513ms | FAILED | host-call |
| array/sort-i32 | 0.794ms | 0.397ms | 0.397ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.077ms | 0.082ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.513ms | 0.516ms | FAILED | host-call |
| array/indexOf | 3.95ms | 5.25ms | 5.25ms | FAILED | js |
| array/slice | 0.028ms | 0.030ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.088ms | 0.049ms | 0.050ms | FAILED | host-call |
| array/find | 0.256ms | 0.012ms | 0.012ms | 1.08ms | host-call |
| dom/create-elements | 0.043ms | 0.971ms | — | — | js |
| dom/set-attributes | 0.104ms | 6.75ms | — | — | js |
| dom/read-attributes | 0.058ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | 1.71ms | — | — | js |
| mixed/csv-parse | 0.489ms | 0.318ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 0.263ms | 0.263ms | 1.08ms | host-call |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 0.214ms | 0.214ms | 0.720ms | js |
| mixed/sieve | 1.58ms | 2.14ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 2.90 | 4.78 | 4.63 | — |
| string/concat-long | 1000 | 3.77 | 3.18 | 3.14 | — |
| string/indexOf | 1000 | 19.18 | 16.61 | 16.58 | 14.86 |
| string/includes | 1000 | 19.22 | 21.02 | 21.05 | 24.37 |
| string/split | 10000 | 42.76 | 41.22 | 41.59 | — |
| string/replace | 1000 | 113.79 | 54.11 | 54.31 | — |
| string/case-convert | 2000 | 27.87 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.93 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.06 | 16.27 | 16.32 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 11.00 | 11.00 | 28.06 |
| array/map-filter | 30000 | 4.29 | 2.55 | 2.74 | — |
| array/indexOf | 1000 | 3953.59 | 5246.04 | 5247.60 | — |
| dom/create-elements | 2000 | 21.50 | 485.36 | — | — |
| dom/set-attributes | 6000 | 17.42 | 1125.83 | — | — |
| dom/read-attributes | 3000 | 19.21 | — | — | — |
| dom/modify-text | 2000 | 15.23 | 854.34 | — | — |
| mixed/csv-parse | 11000 | 44.44 | 28.94 | 28.60 | — |
| mixed/text-search | 40000 | 9.78 | 6.57 | 6.57 | 26.93 |
| mixed/fibonacci | 10000 | 12.18 | 28.33 | 28.32 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.71 | 1.71 | 5.76 |
| mixed/sieve | 200000 | 7.89 | 10.71 | 10.65 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.65x slower | 1.60x slower | — |
| string/concat-long | 1.19x faster | 1.20x faster | — |
| string/indexOf | 1.15x faster | 1.16x faster | 1.29x faster |
| string/includes | 1.09x slower | 1.10x slower | 1.27x slower |
| string/split | 1.04x faster | 1.03x faster | — |
| string/replace | 2.10x faster | 2.10x faster | — |
| string/case-convert | 8.50x faster | 8.51x faster | — |
| string/substring | 3.23x faster | 3.24x faster | — |
| string/trim | 1.05x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.83x faster | 1.83x faster | 1.40x slower |
| array/push-pop | 2.81x faster | 2.80x faster | — |
| array/sort-i32 | 2.00x faster | 2.00x faster | — |
| array/map-filter | 1.68x faster | 1.57x faster | — |
| array/reduce | 4.19x faster | 4.17x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 1.07x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.78x faster | 1.76x faster | — |
| array/find | 21.13x faster | 20.62x faster | 4.22x slower |
| dom/create-elements | 22.58x slower | — | — |
| dom/set-attributes | 64.64x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 56.10x slower | — | — |
| mixed/csv-parse | 1.54x faster | 1.55x faster | — |
| mixed/text-search | 1.49x faster | 1.49x faster | 2.75x slower |
| mixed/fibonacci | 2.33x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.52x slower |
| mixed/sieve | 1.36x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x slower |
| string/split | 1.01x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x faster |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.07x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.02x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1417.3ms | 572.7ms | — |
| string/concat-long | 1069.1ms | 974.6ms | — |
| string/indexOf | 982.3ms | 961.5ms | 580.6ms |
| string/includes | 989.1ms | 966.2ms | 558.5ms |
| string/split | 1083.8ms | 1092.4ms | — |
| string/replace | 1121.3ms | 1130.4ms | — |
| string/case-convert | 1054.3ms | 1076.0ms | — |
| string/substring | 504.4ms | 506.7ms | — |
| string/trim | 1071.5ms | 1059.6ms | — |
| string/startsWith-endsWith | 1097.5ms | 1080.9ms | 631.2ms |
| array/push-pop | 1052.3ms | 1036.5ms | — |
| array/sort-i32 | 1145.0ms | 1123.7ms | — |
| array/map-filter | 1193.9ms | 1205.2ms | — |
| array/reduce | 1112.3ms | 1131.5ms | — |
| array/indexOf | 1092.2ms | 1083.0ms | — |
| array/slice | 1052.0ms | 1041.7ms | — |
| array/reverse | 1062.0ms | 1011.0ms | — |
| array/forEach | 1107.1ms | 1104.5ms | — |
| array/find | 2399.8ms | 2364.3ms | 557.8ms |
| dom/create-elements | 674.9ms | — | — |
| dom/set-attributes | 609.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 602.4ms | — | — |
| mixed/csv-parse | 1083.7ms | 1096.1ms | — |
| mixed/text-search | 1130.6ms | 1113.9ms | 641.4ms |
| mixed/fibonacci | 550.2ms | 531.0ms | 481.4ms |
| mixed/matrix-multiply | 1122.9ms | 1081.8ms | 524.7ms |
| mixed/sieve | 1094.0ms | 1092.4ms | — |
