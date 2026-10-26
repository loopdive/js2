# js2wasm Benchmark Results

Date: 2026-10-26
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.051ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | host-call |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.024ms | host-call |
| string/includes | 0.019ms | 0.020ms | 0.020ms | 0.030ms | js |
| string/split | 0.430ms | 0.503ms | 0.505ms | FAILED | js |
| string/replace | 0.099ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.034ms | 0.034ms | FAILED | host-call |
| string/trim | 0.173ms | 0.178ms | 0.178ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.233ms | 0.232ms | 0.559ms | gc-native |
| array/push-pop | 1.67ms | 0.602ms | 0.602ms | FAILED | host-call |
| array/sort-i32 | 0.856ms | 0.424ms | 0.438ms | FAILED | host-call |
| array/map-filter | 0.138ms | 0.073ms | 0.079ms | FAILED | host-call |
| array/reduce | 2.41ms | 0.605ms | 0.601ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 5.95ms | 5.96ms | FAILED | js |
| array/slice | 0.037ms | 0.018ms | 0.018ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.60ms | 3.60ms | FAILED | host-call |
| array/forEach | 0.096ms | 0.053ms | 0.053ms | FAILED | gc-native |
| array/find | 0.273ms | 0.011ms | 0.011ms | 1.21ms | host-call |
| dom/create-elements | 0.039ms | 0.879ms | — | — | js |
| dom/set-attributes | 0.109ms | 6.28ms | — | — | js |
| dom/read-attributes | 0.060ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | 1.63ms | — | — | js |
| mixed/csv-parse | 0.466ms | 0.308ms | 0.305ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 0.291ms | 0.292ms | 1.12ms | host-call |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.186ms | 0.213ms | 0.213ms | 0.723ms | js |
| mixed/sieve | 1.79ms | 2.31ms | 2.31ms | FAILED | js |

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
| string/concat-short | 10000 | 3.60 | 5.07 | 4.94 | — |
| string/concat-long | 1000 | 4.13 | 3.05 | 3.12 | — |
| string/indexOf | 1000 | 19.11 | 15.92 | 15.94 | 24.15 |
| string/includes | 1000 | 18.83 | 19.67 | 19.70 | 29.81 |
| string/split | 10000 | 43.02 | 50.33 | 50.53 | — |
| string/replace | 1000 | 99.47 | 54.30 | 54.24 | — |
| string/case-convert | 2000 | 29.19 | 3.69 | 3.69 | — |
| string/substring | 10000 | 10.42 | 3.43 | 3.43 | — |
| string/trim | 10000 | 17.33 | 17.80 | 17.75 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 11.63 | 11.62 | 27.95 |
| array/map-filter | 30000 | 4.60 | 2.42 | 2.62 | — |
| array/indexOf | 1000 | 4462.37 | 5954.61 | 5960.08 | — |
| dom/create-elements | 2000 | 19.51 | 439.58 | — | — |
| dom/set-attributes | 6000 | 18.17 | 1046.82 | — | — |
| dom/read-attributes | 3000 | 20.03 | — | — | — |
| dom/modify-text | 2000 | 14.90 | 815.71 | — | — |
| mixed/csv-parse | 11000 | 42.39 | 27.96 | 27.73 | — |
| mixed/text-search | 40000 | 10.07 | 7.28 | 7.30 | 28.03 |
| mixed/fibonacci | 10000 | 12.53 | 32.75 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.70 | 1.71 | 5.78 |
| mixed/sieve | 200000 | 8.97 | 11.56 | 11.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.41x slower | 1.37x slower | — |
| string/concat-long | 1.36x faster | 1.32x faster | — |
| string/indexOf | 1.20x faster | 1.20x faster | 1.26x slower |
| string/includes | 1.04x slower | 1.05x slower | 1.58x slower |
| string/split | 1.17x slower | 1.17x slower | — |
| string/replace | 1.83x faster | 1.83x faster | — |
| string/case-convert | 7.90x faster | 7.90x faster | — |
| string/substring | 3.04x faster | 3.04x faster | — |
| string/trim | 1.03x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.78x faster | 1.78x faster | 1.35x slower |
| array/push-pop | 2.78x faster | 2.78x faster | — |
| array/sort-i32 | 2.02x faster | 1.95x faster | — |
| array/map-filter | 1.90x faster | 1.75x faster | — |
| array/reduce | 3.99x faster | 4.01x faster | — |
| array/indexOf | 1.33x slower | 1.34x slower | — |
| array/slice | 2.07x faster | 2.07x faster | — |
| array/reverse | 2.46x faster | 2.46x faster | — |
| array/forEach | 1.83x faster | 1.83x faster | — |
| array/find | 25.51x faster | 24.22x faster | 4.43x slower |
| dom/create-elements | 22.53x slower | — | — |
| dom/set-attributes | 57.62x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 54.76x slower | — | — |
| mixed/csv-parse | 1.52x faster | 1.53x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.78x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.88x slower |
| mixed/sieve | 1.29x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.03x slower |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x slower |
| string/split | 1.00x slower |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.09x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.05x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x slower |
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
| string/concat-short | 1324.4ms | 539.5ms | — |
| string/concat-long | 993.9ms | 939.2ms | — |
| string/indexOf | 954.9ms | 928.7ms | 517.1ms |
| string/includes | 949.6ms | 919.8ms | 538.2ms |
| string/split | 1059.3ms | 1029.2ms | — |
| string/replace | 1132.8ms | 1067.9ms | — |
| string/case-convert | 1026.8ms | 1038.6ms | — |
| string/substring | 475.3ms | 470.8ms | — |
| string/trim | 1013.6ms | 1004.1ms | — |
| string/startsWith-endsWith | 1036.4ms | 1027.4ms | 611.1ms |
| array/push-pop | 1010.5ms | 1002.4ms | — |
| array/sort-i32 | 1108.7ms | 1072.6ms | — |
| array/map-filter | 1133.8ms | 1156.1ms | — |
| array/reduce | 1086.8ms | 1070.1ms | — |
| array/indexOf | 1055.8ms | 1006.1ms | — |
| array/slice | 1025.9ms | 1001.6ms | — |
| array/reverse | 986.5ms | 1020.0ms | — |
| array/forEach | 1054.1ms | 1045.1ms | — |
| array/find | 2962.6ms | 2874.7ms | 521.1ms |
| dom/create-elements | 609.6ms | — | — |
| dom/set-attributes | 572.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 568.3ms | — | — |
| mixed/csv-parse | 1019.7ms | 1020.5ms | — |
| mixed/text-search | 1051.3ms | 1152.0ms | 592.0ms |
| mixed/fibonacci | 502.7ms | 492.3ms | 444.0ms |
| mixed/matrix-multiply | 1030.3ms | 1047.6ms | 514.2ms |
| mixed/sieve | 1054.8ms | 1025.1ms | — |
