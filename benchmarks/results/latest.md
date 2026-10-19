# js2wasm Benchmark Results

Date: 2026-10-19
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.025ms | 0.046ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.017ms | 0.017ms | 0.021ms | host-call |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.034ms | js |
| string/split | 0.426ms | 0.414ms | 0.412ms | FAILED | gc-native |
| string/replace | 0.105ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.400ms | 0.228ms | 0.220ms | 0.561ms | gc-native |
| array/push-pop | 1.56ms | 0.546ms | 0.542ms | FAILED | gc-native |
| array/sort-i32 | 0.788ms | 0.393ms | 0.397ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.076ms | 0.082ms | FAILED | host-call |
| array/reduce | 1.46ms | 0.539ms | 0.540ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.029ms | 0.030ms | 0.030ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.253ms | 0.012ms | 0.012ms | 1.09ms | host-call |
| dom/create-elements | 0.035ms | 0.946ms | — | — | js |
| dom/set-attributes | 0.106ms | 6.77ms | — | — | js |
| dom/read-attributes | 0.055ms | FAILED | — | — | js |
| dom/modify-text | 0.033ms | 1.75ms | — | — | js |
| mixed/csv-parse | 0.483ms | 0.318ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.266ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.162ms | 0.214ms | 0.213ms | 0.738ms | js |
| mixed/sieve | 1.70ms | 3.23ms | 2.89ms | FAILED | js |

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
| string/concat-short | 10000 | 2.53 | 4.55 | 4.40 | — |
| string/concat-long | 1000 | 3.60 | 3.06 | 3.02 | — |
| string/indexOf | 1000 | 19.19 | 16.51 | 16.64 | 20.62 |
| string/includes | 1000 | 19.23 | 21.03 | 20.95 | 34.31 |
| string/split | 10000 | 42.59 | 41.36 | 41.17 | — |
| string/replace | 1000 | 104.97 | 54.22 | 54.17 | — |
| string/case-convert | 2000 | 27.79 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.87 | 3.07 | 3.07 | — |
| string/trim | 10000 | 16.97 | 16.32 | 16.29 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 11.42 | 11.02 | 28.05 |
| array/map-filter | 30000 | 4.32 | 2.53 | 2.74 | — |
| array/indexOf | 1000 | 3953.73 | 2639.62 | 2642.32 | — |
| dom/create-elements | 2000 | 17.66 | 472.91 | — | — |
| dom/set-attributes | 6000 | 17.74 | 1127.74 | — | — |
| dom/read-attributes | 3000 | 18.27 | — | — | — |
| dom/modify-text | 2000 | 16.61 | 874.27 | — | — |
| mixed/csv-parse | 11000 | 43.89 | 28.86 | 28.67 | — |
| mixed/text-search | 40000 | 9.75 | 6.64 | 6.58 | 27.06 |
| mixed/fibonacci | 10000 | 12.03 | 28.34 | 28.34 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.71 | 1.71 | 5.90 |
| mixed/sieve | 200000 | 8.50 | 16.16 | 14.46 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.80x slower | 1.74x slower | — |
| string/concat-long | 1.18x faster | 1.19x faster | — |
| string/indexOf | 1.16x faster | 1.15x faster | 1.07x slower |
| string/includes | 1.09x slower | 1.09x slower | 1.78x slower |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.94x faster | 1.94x faster | — |
| string/case-convert | 8.48x faster | 8.48x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.75x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.85x faster | 2.87x faster | — |
| array/sort-i32 | 2.00x faster | 1.99x faster | — |
| array/map-filter | 1.71x faster | 1.58x faster | — |
| array/reduce | 2.71x faster | 2.70x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.05x faster | 1.05x faster | — |
| array/find | 20.73x faster | 20.71x faster | 4.29x slower |
| dom/create-elements | 26.77x slower | — | — |
| dom/set-attributes | 63.56x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 52.64x slower | — | — |
| mixed/csv-parse | 1.52x faster | 1.53x faster | — |
| mixed/text-search | 1.47x faster | 1.48x faster | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.33x slower |
| mixed/matrix-multiply | 1.32x slower | 1.32x slower | 4.55x slower |
| mixed/sieve | 1.90x slower | 1.70x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.01x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.04x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.01x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.12x faster |

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
| string/concat-short | 1508.7ms | 616.4ms | — |
| string/concat-long | 1102.9ms | 1021.3ms | — |
| string/indexOf | 1047.0ms | 1017.0ms | 611.9ms |
| string/includes | 1038.2ms | 1024.6ms | 609.2ms |
| string/split | 1204.5ms | 1113.1ms | — |
| string/replace | 1172.1ms | 1146.5ms | — |
| string/case-convert | 1130.3ms | 1089.0ms | — |
| string/substring | 557.3ms | 537.8ms | — |
| string/trim | 1093.5ms | 1127.9ms | — |
| string/startsWith-endsWith | 1156.0ms | 1167.6ms | 716.7ms |
| array/push-pop | 1111.7ms | 1106.4ms | — |
| array/sort-i32 | 1158.4ms | 1143.2ms | — |
| array/map-filter | 1243.5ms | 1231.3ms | — |
| array/reduce | 1194.7ms | 1164.6ms | — |
| array/indexOf | 1174.8ms | 1159.2ms | — |
| array/slice | 1125.6ms | 1114.5ms | — |
| array/reverse | 1094.4ms | 1096.3ms | — |
| array/forEach | 1143.8ms | 1162.6ms | — |
| array/find | 2432.9ms | 2456.8ms | 642.0ms |
| dom/create-elements | 685.6ms | — | — |
| dom/set-attributes | 653.2ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 671.5ms | — | — |
| mixed/csv-parse | 1141.5ms | 1155.7ms | — |
| mixed/text-search | 1149.2ms | 1169.1ms | 685.6ms |
| mixed/fibonacci | 592.2ms | 579.1ms | 528.9ms |
| mixed/matrix-multiply | 1154.5ms | 1124.8ms | 573.0ms |
| mixed/sieve | 1165.6ms | 1176.6ms | — |
