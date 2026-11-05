# js2wasm Benchmark Results

Date: 2026-11-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.019ms | host-call |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 3.16ms | 0.411ms | 0.409ms | FAILED | gc-native |
| string/replace | 0.108ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.560ms | gc-native |
| array/push-pop | 1.49ms | 0.541ms | 0.541ms | FAILED | gc-native |
| array/sort-i32 | 0.794ms | 0.392ms | 0.393ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.43ms | 0.537ms | 0.534ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 5.24ms | 5.23ms | FAILED | js |
| array/slice | 0.027ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.253ms | 0.012ms | 0.012ms | 1.09ms | gc-native |
| dom/create-elements | 0.035ms | 1.11ms | — | — | js |
| dom/set-attributes | 0.106ms | 6.76ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.028ms | 1.72ms | — | — | js |
| mixed/csv-parse | 0.488ms | 0.317ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.394ms | 0.263ms | 0.263ms | 1.08ms | host-call |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 0.217ms | 0.214ms | 0.726ms | js |
| mixed/sieve | 1.62ms | 2.16ms | 2.15ms | FAILED | js |

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
| string/concat-short | 10000 | 3.33 | 4.87 | 4.34 | — |
| string/concat-long | 1000 | 3.56 | 2.96 | 2.91 | — |
| string/indexOf | 1000 | 19.17 | 16.27 | 16.28 | 18.85 |
| string/includes | 1000 | 19.16 | 20.79 | 20.79 | 15.41 |
| string/split | 10000 | 316.17 | 41.11 | 40.92 | — |
| string/replace | 1000 | 107.68 | 54.20 | 53.93 | — |
| string/case-convert | 2000 | 27.83 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.87 | 3.08 | 3.07 | — |
| string/trim | 10000 | 17.01 | 16.28 | 16.31 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 11.01 | 11.01 | 27.98 |
| array/map-filter | 30000 | 4.28 | 2.50 | 2.71 | — |
| array/indexOf | 1000 | 3953.89 | 5240.81 | 5231.72 | — |
| dom/create-elements | 2000 | 17.36 | 556.13 | — | — |
| dom/set-attributes | 6000 | 17.60 | 1127.24 | — | — |
| dom/read-attributes | 3000 | 18.53 | — | — | — |
| dom/modify-text | 2000 | 14.13 | 860.89 | — | — |
| mixed/csv-parse | 11000 | 44.38 | 28.85 | 28.65 | — |
| mixed/text-search | 40000 | 9.86 | 6.58 | 6.58 | 27.08 |
| mixed/fibonacci | 10000 | 12.03 | 28.33 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.74 | 1.71 | 5.81 |
| mixed/sieve | 200000 | 8.12 | 10.80 | 10.77 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.30x slower | — |
| string/concat-long | 1.20x faster | 1.22x faster | — |
| string/indexOf | 1.18x faster | 1.18x faster | 1.02x faster |
| string/includes | 1.08x slower | 1.08x slower | 1.24x faster |
| string/split | 7.69x faster | 7.73x faster | — |
| string/replace | 1.99x faster | 2.00x faster | — |
| string/case-convert | 8.49x faster | 8.49x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.75x faster | 2.75x faster | — |
| array/sort-i32 | 2.03x faster | 2.02x faster | — |
| array/map-filter | 1.71x faster | 1.58x faster | — |
| array/reduce | 2.66x faster | 2.67x faster | — |
| array/indexOf | 1.33x slower | 1.32x slower | — |
| array/slice | 1.03x slower | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 21.45x faster | 21.98x faster | 4.29x slower |
| dom/create-elements | 32.03x slower | — | — |
| dom/set-attributes | 64.04x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 60.94x slower | — | — |
| mixed/csv-parse | 1.54x faster | 1.55x faster | — |
| mixed/text-search | 1.50x faster | 1.50x faster | 2.75x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.33x slower |
| mixed/matrix-multiply | 1.38x slower | 1.36x slower | 4.63x slower |
| mixed/sieve | 1.33x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x slower |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x faster |
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
| string/concat-short | 1466.6ms | 608.9ms | — |
| string/concat-long | 1081.1ms | 992.7ms | — |
| string/indexOf | 997.5ms | 982.7ms | 582.7ms |
| string/includes | 973.0ms | 993.0ms | 584.8ms |
| string/split | 1118.4ms | 1106.9ms | — |
| string/replace | 1113.5ms | 1152.6ms | — |
| string/case-convert | 1065.6ms | 1071.1ms | — |
| string/substring | 542.9ms | 540.9ms | — |
| string/trim | 1055.0ms | 1081.4ms | — |
| string/startsWith-endsWith | 1097.7ms | 1092.1ms | 683.5ms |
| array/push-pop | 1098.1ms | 1097.3ms | — |
| array/sort-i32 | 1164.6ms | 1133.9ms | — |
| array/map-filter | 1251.3ms | 1248.4ms | — |
| array/reduce | 1169.2ms | 1156.8ms | — |
| array/indexOf | 1124.1ms | 1115.1ms | — |
| array/slice | 1095.4ms | 1090.0ms | — |
| array/reverse | 1116.6ms | 1104.7ms | — |
| array/forEach | 1142.4ms | 1135.8ms | — |
| array/find | 3179.4ms | 3062.8ms | 587.3ms |
| dom/create-elements | 687.9ms | — | — |
| dom/set-attributes | 678.4ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 587.7ms | — | — |
| mixed/csv-parse | 1107.6ms | 1118.5ms | — |
| mixed/text-search | 1107.9ms | 1131.1ms | 664.7ms |
| mixed/fibonacci | 574.3ms | 547.9ms | 507.9ms |
| mixed/matrix-multiply | 1116.2ms | 1138.8ms | 578.1ms |
| mixed/sieve | 1111.9ms | 1099.4ms | — |
