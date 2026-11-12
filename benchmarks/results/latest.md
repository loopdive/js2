# js2wasm Benchmark Results

Date: 2026-11-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.046ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.020ms | host-call |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.017ms | linear-memory |
| string/split | 0.412ms | 0.412ms | 0.414ms | FAILED | host-call |
| string/replace | 0.112ms | 0.054ms | 0.054ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.401ms | 0.221ms | 0.220ms | 0.560ms | gc-native |
| array/push-pop | 1.52ms | 0.539ms | 0.534ms | FAILED | gc-native |
| array/sort-i32 | 0.822ms | 0.397ms | 0.397ms | FAILED | host-call |
| array/map-filter | 0.140ms | 0.077ms | 0.083ms | FAILED | host-call |
| array/reduce | 1.50ms | 0.545ms | 0.539ms | FAILED | gc-native |
| array/indexOf | 3.97ms | 5.24ms | 5.24ms | FAILED | js |
| array/slice | 0.027ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.095ms | 0.049ms | 0.049ms | FAILED | gc-native |
| array/find | 0.263ms | 0.013ms | 0.013ms | 1.09ms | host-call |
| dom/create-elements | 0.037ms | 1.12ms | — | — | js |
| dom/set-attributes | 0.106ms | 6.89ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.031ms | 1.69ms | — | — | js |
| mixed/csv-parse | 0.476ms | 0.317ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.266ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 0.213ms | 0.214ms | 0.723ms | js |
| mixed/sieve | 1.68ms | 2.14ms | 2.16ms | FAILED | js |

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
| string/concat-short | 10000 | 3.09 | 4.57 | 4.59 | — |
| string/concat-long | 1000 | 3.62 | 3.12 | 3.10 | — |
| string/indexOf | 1000 | 19.23 | 16.42 | 16.46 | 20.00 |
| string/includes | 1000 | 19.24 | 21.02 | 21.17 | 16.52 |
| string/split | 10000 | 41.23 | 41.21 | 41.36 | — |
| string/replace | 1000 | 111.88 | 54.38 | 54.46 | — |
| string/case-convert | 2000 | 27.86 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.93 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.07 | 16.31 | 16.30 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 11.03 | 11.01 | 27.99 |
| array/map-filter | 30000 | 4.66 | 2.55 | 2.78 | — |
| array/indexOf | 1000 | 3967.49 | 5243.45 | 5237.76 | — |
| dom/create-elements | 2000 | 18.51 | 558.34 | — | — |
| dom/set-attributes | 6000 | 17.71 | 1148.91 | — | — |
| dom/read-attributes | 3000 | 18.56 | — | — | — |
| dom/modify-text | 2000 | 15.68 | 845.43 | — | — |
| mixed/csv-parse | 11000 | 43.28 | 28.86 | 28.74 | — |
| mixed/text-search | 40000 | 9.76 | 6.66 | 6.57 | 27.09 |
| mixed/fibonacci | 10000 | 12.02 | 28.30 | 28.31 | 28.12 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.71 | 1.71 | 5.79 |
| mixed/sieve | 200000 | 8.40 | 10.72 | 10.79 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.48x slower | — |
| string/concat-long | 1.16x faster | 1.17x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.04x slower |
| string/includes | 1.09x slower | 1.10x slower | 1.16x faster |
| string/split | 1.00x faster | 1.00x slower | — |
| string/replace | 2.06x faster | 2.05x faster | — |
| string/case-convert | 8.50x faster | 8.50x faster | — |
| string/substring | 3.23x faster | 3.23x faster | — |
| string/trim | 1.05x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.39x slower |
| array/push-pop | 2.83x faster | 2.85x faster | — |
| array/sort-i32 | 2.07x faster | 2.07x faster | — |
| array/map-filter | 1.82x faster | 1.68x faster | — |
| array/reduce | 2.74x faster | 2.78x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.05x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.92x faster | 1.92x faster | — |
| array/find | 20.67x faster | 20.20x faster | 4.14x slower |
| dom/create-elements | 30.17x slower | — | — |
| dom/set-attributes | 64.86x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 53.92x slower | — | — |
| mixed/csv-parse | 1.50x faster | 1.51x faster | — |
| mixed/text-search | 1.47x faster | 1.49x faster | 2.78x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 1.34x slower | 1.35x slower | 4.56x slower |
| mixed/sieve | 1.28x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x slower |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.01x slower |
| string/split | 1.00x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.09x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.02x slower |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.01x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
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
| array/sort-i32 | 28.1KB | 28.1KB | — |
| array/map-filter | 29.2KB | 29.3KB | — |
| array/reduce | 27.7KB | 27.7KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.9KB | 27.9KB | — |
| array/find | 61.9KB | 61.9KB | 666B |
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
| string/concat-short | 1559.9ms | 615.1ms | — |
| string/concat-long | 1137.8ms | 1054.1ms | — |
| string/indexOf | 1045.1ms | 1055.1ms | 617.4ms |
| string/includes | 1069.7ms | 1022.2ms | 629.5ms |
| string/split | 1152.9ms | 1098.8ms | — |
| string/replace | 1183.2ms | 1188.0ms | — |
| string/case-convert | 1124.7ms | 1111.8ms | — |
| string/substring | 559.8ms | 557.5ms | — |
| string/trim | 1107.5ms | 1119.4ms | — |
| string/startsWith-endsWith | 1162.7ms | 1138.1ms | 685.5ms |
| array/push-pop | 1097.9ms | 1101.5ms | — |
| array/sort-i32 | 1966.1ms | 1985.9ms | — |
| array/map-filter | 2046.3ms | 2001.3ms | — |
| array/reduce | 1961.3ms | 1935.9ms | — |
| array/indexOf | 1160.9ms | 1134.7ms | — |
| array/slice | 1100.0ms | 1105.0ms | — |
| array/reverse | 1117.5ms | 1123.1ms | — |
| array/forEach | 1963.6ms | 1932.7ms | — |
| array/find | 3209.3ms | 3147.3ms | 615.1ms |
| dom/create-elements | 743.1ms | — | — |
| dom/set-attributes | 702.9ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 701.2ms | — | — |
| mixed/csv-parse | 1179.1ms | 1177.9ms | — |
| mixed/text-search | 1170.8ms | 1181.1ms | 705.0ms |
| mixed/fibonacci | 625.9ms | 596.2ms | 552.3ms |
| mixed/matrix-multiply | 1183.2ms | 1170.2ms | 588.8ms |
| mixed/sieve | 1156.1ms | 1158.7ms | — |
