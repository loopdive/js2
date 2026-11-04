# js2wasm Benchmark Results

Date: 2026-11-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.051ms | 0.056ms | 0.056ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.005ms | FAILED | js |
| string/indexOf | 0.018ms | 0.016ms | 0.016ms | 0.022ms | gc-native |
| string/includes | 0.018ms | 0.019ms | 0.019ms | 0.020ms | js |
| string/split | 0.415ms | 0.423ms | 0.425ms | FAILED | js |
| string/replace | 0.108ms | 0.052ms | 0.052ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.100ms | 0.036ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.159ms | 0.163ms | 0.163ms | FAILED | js |
| string/startsWith-endsWith | 0.430ms | 0.213ms | 0.213ms | 0.578ms | host-call |
| array/push-pop | 1.46ms | 0.543ms | 0.530ms | FAILED | gc-native |
| array/sort-i32 | 0.716ms | 0.402ms | 0.402ms | FAILED | gc-native |
| array/map-filter | 0.148ms | 0.086ms | 0.092ms | FAILED | host-call |
| array/reduce | 2.12ms | 0.529ms | 0.528ms | FAILED | gc-native |
| array/indexOf | 4.83ms | 5.63ms | 5.64ms | FAILED | js |
| array/slice | 0.043ms | 0.037ms | 0.039ms | FAILED | host-call |
| array/reverse | 7.27ms | 4.09ms | 4.09ms | FAILED | gc-native |
| array/forEach | 0.077ms | 0.040ms | 0.040ms | FAILED | gc-native |
| array/find | 0.267ms | 0.014ms | 0.014ms | 0.997ms | gc-native |
| dom/create-elements | 0.061ms | 0.951ms | — | — | js |
| dom/set-attributes | 0.129ms | 6.47ms | — | — | js |
| dom/read-attributes | 0.071ms | FAILED | — | — | js |
| dom/modify-text | 0.053ms | 1.65ms | — | — | js |
| mixed/csv-parse | 0.466ms | 0.304ms | 0.304ms | FAILED | host-call |
| mixed/text-search | 0.392ms | 0.266ms | 0.265ms | 1.23ms | gc-native |
| mixed/fibonacci | 0.133ms | 0.353ms | 0.353ms | 0.352ms | js |
| mixed/matrix-multiply | 0.206ms | 0.206ms | 0.206ms | 0.778ms | host-call |
| mixed/sieve | 1.63ms | 2.27ms | 2.25ms | FAILED | js |

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
| string/concat-short | 10000 | 5.09 | 5.62 | 5.63 | — |
| string/concat-long | 1000 | 4.59 | 5.57 | 5.48 | — |
| string/indexOf | 1000 | 18.18 | 15.88 | 15.84 | 21.94 |
| string/includes | 1000 | 18.04 | 18.87 | 19.15 | 20.43 |
| string/split | 10000 | 41.49 | 42.30 | 42.55 | — |
| string/replace | 1000 | 107.84 | 51.98 | 52.05 | — |
| string/case-convert | 2000 | 28.09 | 3.03 | 3.04 | — |
| string/substring | 10000 | 10.01 | 3.59 | 3.59 | — |
| string/trim | 10000 | 15.92 | 16.32 | 16.32 | — |
| string/startsWith-endsWith | 20000 | 21.49 | 10.63 | 10.66 | 28.88 |
| array/map-filter | 30000 | 4.93 | 2.88 | 3.05 | — |
| array/indexOf | 1000 | 4834.75 | 5632.25 | 5642.61 | — |
| dom/create-elements | 2000 | 30.25 | 475.67 | — | — |
| dom/set-attributes | 6000 | 21.48 | 1078.92 | — | — |
| dom/read-attributes | 3000 | 23.66 | — | — | — |
| dom/modify-text | 2000 | 26.52 | 825.84 | — | — |
| mixed/csv-parse | 11000 | 42.33 | 27.64 | 27.67 | — |
| mixed/text-search | 40000 | 9.80 | 6.65 | 6.63 | 30.64 |
| mixed/fibonacci | 10000 | 13.33 | 35.31 | 35.31 | 35.17 |
| mixed/matrix-multiply | 125000 | 1.65 | 1.65 | 1.65 | 6.22 |
| mixed/sieve | 200000 | 8.17 | 11.35 | 11.27 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.10x slower | 1.11x slower | — |
| string/concat-long | 1.21x slower | 1.19x slower | — |
| string/indexOf | 1.14x faster | 1.15x faster | 1.21x slower |
| string/includes | 1.05x slower | 1.06x slower | 1.13x slower |
| string/split | 1.02x slower | 1.03x slower | — |
| string/replace | 2.07x faster | 2.07x faster | — |
| string/case-convert | 9.26x faster | 9.24x faster | — |
| string/substring | 2.78x faster | 2.78x faster | — |
| string/trim | 1.03x slower | 1.03x slower | — |
| string/startsWith-endsWith | 2.02x faster | 2.02x faster | 1.34x slower |
| array/push-pop | 2.70x faster | 2.76x faster | — |
| array/sort-i32 | 1.78x faster | 1.78x faster | — |
| array/map-filter | 1.71x faster | 1.61x faster | — |
| array/reduce | 4.01x faster | 4.02x faster | — |
| array/indexOf | 1.16x slower | 1.17x slower | — |
| array/slice | 1.16x faster | 1.10x faster | — |
| array/reverse | 1.78x faster | 1.78x faster | — |
| array/forEach | 1.94x faster | 1.94x faster | — |
| array/find | 19.19x faster | 19.20x faster | 3.74x slower |
| dom/create-elements | 15.72x slower | — | — |
| dom/set-attributes | 50.23x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 31.14x slower | — | — |
| mixed/csv-parse | 1.53x faster | 1.53x faster | — |
| mixed/text-search | 1.47x faster | 1.48x faster | 3.13x slower |
| mixed/fibonacci | 2.65x slower | 2.65x slower | 2.64x slower |
| mixed/matrix-multiply | 1.00x faster | 1.00x slower | 3.78x slower |
| mixed/sieve | 1.39x slower | 1.38x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x slower |
| string/concat-long | 1.02x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x slower |
| string/split | 1.01x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.06x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 1.00x slower |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x slower |
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
| string/concat-short | 1418.2ms | 616.2ms | — |
| string/concat-long | 1120.2ms | 1048.0ms | — |
| string/indexOf | 1026.2ms | 1009.4ms | 600.6ms |
| string/includes | 1052.1ms | 1050.7ms | 616.6ms |
| string/split | 1195.7ms | 1142.6ms | — |
| string/replace | 1180.3ms | 1204.4ms | — |
| string/case-convert | 1120.3ms | 1140.6ms | — |
| string/substring | 561.9ms | 540.6ms | — |
| string/trim | 1135.5ms | 1091.2ms | — |
| string/startsWith-endsWith | 1160.0ms | 1150.8ms | 670.7ms |
| array/push-pop | 1106.0ms | 1118.4ms | — |
| array/sort-i32 | 1205.6ms | 1162.1ms | — |
| array/map-filter | 1279.8ms | 1244.4ms | — |
| array/reduce | 1195.0ms | 1184.2ms | — |
| array/indexOf | 1136.9ms | 1127.2ms | — |
| array/slice | 1096.0ms | 1117.6ms | — |
| array/reverse | 1113.7ms | 1081.7ms | — |
| array/forEach | 1162.1ms | 1157.3ms | — |
| array/find | 3162.0ms | 3120.2ms | 583.3ms |
| dom/create-elements | 692.7ms | — | — |
| dom/set-attributes | 662.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 657.2ms | — | — |
| mixed/csv-parse | 1134.8ms | 1145.0ms | — |
| mixed/text-search | 1130.6ms | 1166.9ms | 702.9ms |
| mixed/fibonacci | 611.3ms | 577.9ms | 528.1ms |
| mixed/matrix-multiply | 1183.7ms | 1159.3ms | 572.3ms |
| mixed/sieve | 1165.7ms | 1175.8ms | — |
