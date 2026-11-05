# js2wasm Benchmark Results

Date: 2026-11-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.044ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.018ms | host-call |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.021ms | js |
| string/split | 0.424ms | 0.412ms | 0.414ms | FAILED | host-call |
| string/replace | 0.109ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.401ms | 0.228ms | 0.228ms | 0.560ms | host-call |
| array/push-pop | 1.52ms | 0.548ms | 0.547ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.397ms | 0.395ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.076ms | 0.082ms | FAILED | host-call |
| array/reduce | 1.46ms | 0.535ms | 0.538ms | FAILED | host-call |
| array/indexOf | 3.95ms | 5.23ms | 5.23ms | FAILED | js |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.254ms | 0.012ms | 0.012ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.949ms | — | — | js |
| dom/set-attributes | 0.104ms | 6.88ms | — | — | js |
| dom/read-attributes | 0.057ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.73ms | — | — | js |
| mixed/csv-parse | 0.482ms | 0.317ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.263ms | 0.263ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.214ms | 0.729ms | js |
| mixed/sieve | 1.68ms | 2.17ms | 2.17ms | FAILED | js |

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
| string/concat-short | 10000 | 3.29 | 4.44 | 4.38 | — |
| string/concat-long | 1000 | 3.60 | 3.14 | 3.02 | — |
| string/indexOf | 1000 | 19.23 | 16.41 | 16.43 | 18.28 |
| string/includes | 1000 | 19.30 | 20.80 | 20.68 | 21.42 |
| string/split | 10000 | 42.45 | 41.22 | 41.40 | — |
| string/replace | 1000 | 109.15 | 54.22 | 54.01 | — |
| string/case-convert | 2000 | 27.78 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.88 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.04 | 16.34 | 16.29 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 11.38 | 11.39 | 27.98 |
| array/map-filter | 30000 | 4.35 | 2.52 | 2.73 | — |
| array/indexOf | 1000 | 3953.50 | 5229.89 | 5229.47 | — |
| dom/create-elements | 2000 | 17.75 | 474.61 | — | — |
| dom/set-attributes | 6000 | 17.38 | 1145.87 | — | — |
| dom/read-attributes | 3000 | 18.90 | — | — | — |
| dom/modify-text | 2000 | 14.65 | 865.11 | — | — |
| mixed/csv-parse | 11000 | 43.79 | 28.86 | 28.72 | — |
| mixed/text-search | 40000 | 9.75 | 6.58 | 6.57 | 27.40 |
| mixed/fibonacci | 10000 | 12.03 | 28.33 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.71 | 1.71 | 5.83 |
| mixed/sieve | 200000 | 8.40 | 10.86 | 10.85 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.35x slower | 1.33x slower | — |
| string/concat-long | 1.15x faster | 1.19x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.05x faster |
| string/includes | 1.08x slower | 1.07x slower | 1.11x slower |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 2.01x faster | 2.02x faster | — |
| string/case-convert | 8.48x faster | 8.48x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.04x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.76x faster | 1.76x faster | 1.39x slower |
| array/push-pop | 2.77x faster | 2.77x faster | — |
| array/sort-i32 | 2.00x faster | 2.01x faster | — |
| array/map-filter | 1.73x faster | 1.59x faster | — |
| array/reduce | 2.72x faster | 2.71x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.08x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 21.25x faster | 21.08x faster | 4.26x slower |
| dom/create-elements | 26.74x slower | — | — |
| dom/set-attributes | 65.92x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 59.07x slower | — | — |
| mixed/csv-parse | 1.52x faster | 1.53x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.81x slower |
| mixed/fibonacci | 2.36x slower | 2.35x slower | 2.33x slower |
| mixed/matrix-multiply | 1.35x slower | 1.35x slower | 4.61x slower |
| mixed/sieve | 1.29x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.04x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.01x faster |
| string/split | 1.00x slower |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1450.6ms | 600.5ms | — |
| string/concat-long | 1088.2ms | 1002.0ms | — |
| string/indexOf | 1012.9ms | 1040.7ms | 600.1ms |
| string/includes | 1044.9ms | 1043.4ms | 596.6ms |
| string/split | 1155.7ms | 1106.0ms | — |
| string/replace | 1161.5ms | 1136.0ms | — |
| string/case-convert | 1097.8ms | 1105.3ms | — |
| string/substring | 551.5ms | 542.1ms | — |
| string/trim | 1093.6ms | 1083.1ms | — |
| string/startsWith-endsWith | 1127.0ms | 1103.1ms | 675.5ms |
| array/push-pop | 1121.0ms | 1095.1ms | — |
| array/sort-i32 | 1192.4ms | 1172.5ms | — |
| array/map-filter | 1255.2ms | 1199.2ms | — |
| array/reduce | 1160.6ms | 1133.6ms | — |
| array/indexOf | 1100.4ms | 1094.1ms | — |
| array/slice | 1071.0ms | 1097.1ms | — |
| array/reverse | 1087.7ms | 1096.4ms | — |
| array/forEach | 1151.3ms | 1120.1ms | — |
| array/find | 3123.2ms | 3069.5ms | 601.6ms |
| dom/create-elements | 690.0ms | — | — |
| dom/set-attributes | 669.0ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 663.0ms | — | — |
| mixed/csv-parse | 1106.1ms | 1126.1ms | — |
| mixed/text-search | 1110.4ms | 1152.6ms | 671.6ms |
| mixed/fibonacci | 601.9ms | 584.3ms | 508.9ms |
| mixed/matrix-multiply | 1162.6ms | 1134.0ms | 565.0ms |
| mixed/sieve | 1162.2ms | 1136.6ms | — |
