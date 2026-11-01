# js2wasm Benchmark Results

Date: 2026-11-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.040ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.002ms | 0.002ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.014ms | gc-native |
| string/includes | 0.015ms | 0.015ms | 0.015ms | 0.032ms | js |
| string/split | 0.331ms | 0.391ms | 0.391ms | FAILED | js |
| string/replace | 0.076ms | 0.042ms | 0.042ms | FAILED | host-call |
| string/case-convert | 0.048ms | 0.006ms | 0.006ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | host-call |
| string/trim | 0.134ms | 0.148ms | 0.137ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.180ms | 0.180ms | 0.433ms | gc-native |
| array/push-pop | 1.38ms | 0.498ms | 0.498ms | FAILED | host-call |
| array/sort-i32 | 0.662ms | 0.333ms | 0.342ms | FAILED | host-call |
| array/map-filter | 0.109ms | 0.058ms | 0.063ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.497ms | 0.496ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 4.62ms | 4.61ms | FAILED | js |
| array/slice | 0.032ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 2.79ms | 2.80ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.041ms | 0.041ms | FAILED | gc-native |
| array/find | 0.214ms | 0.009ms | 0.009ms | 0.949ms | host-call |
| dom/create-elements | 0.030ms | 0.833ms | — | — | js |
| dom/set-attributes | 0.087ms | 5.13ms | — | — | js |
| dom/read-attributes | 0.049ms | FAILED | — | — | js |
| dom/modify-text | 0.023ms | 1.27ms | — | — | js |
| mixed/csv-parse | 0.957ms | 0.243ms | 0.242ms | FAILED | gc-native |
| mixed/text-search | 0.313ms | 0.227ms | 0.226ms | 0.860ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 0.166ms | 0.166ms | 0.566ms | js |
| mixed/sieve | 1.47ms | 1.83ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 3.08 | 3.99 | 3.86 | — |
| string/concat-long | 1000 | 3.21 | 2.50 | 2.47 | — |
| string/indexOf | 1000 | 14.79 | 12.66 | 12.63 | 13.90 |
| string/includes | 1000 | 14.53 | 15.48 | 15.45 | 32.36 |
| string/split | 10000 | 33.12 | 39.08 | 39.07 | — |
| string/replace | 1000 | 76.30 | 41.97 | 42.01 | — |
| string/case-convert | 2000 | 23.81 | 2.86 | 2.86 | — |
| string/substring | 10000 | 8.10 | 2.66 | 2.66 | — |
| string/trim | 10000 | 13.38 | 14.82 | 13.72 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 9.02 | 9.02 | 21.65 |
| array/map-filter | 30000 | 3.63 | 1.92 | 2.09 | — |
| array/indexOf | 1000 | 3463.52 | 4623.41 | 4613.76 | — |
| dom/create-elements | 2000 | 15.14 | 416.37 | — | — |
| dom/set-attributes | 6000 | 14.46 | 855.36 | — | — |
| dom/read-attributes | 3000 | 16.41 | — | — | — |
| dom/modify-text | 2000 | 11.50 | 636.37 | — | — |
| mixed/csv-parse | 11000 | 86.97 | 22.11 | 21.96 | — |
| mixed/text-search | 40000 | 7.82 | 5.67 | 5.65 | 21.51 |
| mixed/fibonacci | 10000 | 9.73 | 25.40 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.33 | 1.33 | 4.53 |
| mixed/sieve | 200000 | 7.33 | 9.15 | 9.14 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.30x slower | 1.25x slower | — |
| string/concat-long | 1.28x faster | 1.30x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.06x faster |
| string/includes | 1.07x slower | 1.06x slower | 2.23x slower |
| string/split | 1.18x slower | 1.18x slower | — |
| string/replace | 1.82x faster | 1.82x faster | — |
| string/case-convert | 8.31x faster | 8.31x faster | — |
| string/substring | 3.04x faster | 3.04x faster | — |
| string/trim | 1.11x slower | 1.03x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.35x slower |
| array/push-pop | 2.77x faster | 2.77x faster | — |
| array/sort-i32 | 1.99x faster | 1.93x faster | — |
| array/map-filter | 1.89x faster | 1.74x faster | — |
| array/reduce | 2.70x faster | 2.70x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.20x faster | 2.21x faster | — |
| array/reverse | 2.46x faster | 2.45x faster | — |
| array/forEach | 1.04x faster | 1.04x faster | — |
| array/find | 24.24x faster | 24.10x faster | 4.44x slower |
| dom/create-elements | 27.50x slower | — | — |
| dom/set-attributes | 59.16x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 55.33x slower | — | — |
| mixed/csv-parse | 3.93x faster | 3.96x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.75x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.86x slower |
| mixed/sieve | 1.25x slower | 1.25x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.08x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.01x faster |
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
| string/concat-short | 1148.6ms | 485.3ms | — |
| string/concat-long | 844.6ms | 786.1ms | — |
| string/indexOf | 787.3ms | 791.2ms | 448.8ms |
| string/includes | 795.4ms | 750.2ms | 461.5ms |
| string/split | 852.2ms | 840.5ms | — |
| string/replace | 893.3ms | 901.0ms | — |
| string/case-convert | 829.5ms | 877.4ms | — |
| string/substring | 423.0ms | 426.4ms | — |
| string/trim | 811.6ms | 831.5ms | — |
| string/startsWith-endsWith | 870.8ms | 853.9ms | 520.0ms |
| array/push-pop | 850.9ms | 852.3ms | — |
| array/sort-i32 | 908.0ms | 889.4ms | — |
| array/map-filter | 966.3ms | 942.7ms | — |
| array/reduce | 918.9ms | 901.6ms | — |
| array/indexOf | 878.0ms | 833.0ms | — |
| array/slice | 820.5ms | 831.3ms | — |
| array/reverse | 831.9ms | 828.3ms | — |
| array/forEach | 861.1ms | 869.9ms | — |
| array/find | 2422.0ms | 2340.5ms | 444.0ms |
| dom/create-elements | 523.5ms | — | — |
| dom/set-attributes | 553.6ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 526.6ms | — | — |
| mixed/csv-parse | 868.6ms | 858.6ms | — |
| mixed/text-search | 863.0ms | 862.9ms | 516.3ms |
| mixed/fibonacci | 445.1ms | 444.3ms | 422.6ms |
| mixed/matrix-multiply | 880.1ms | 861.8ms | 451.4ms |
| mixed/sieve | 885.7ms | 862.6ms | — |
