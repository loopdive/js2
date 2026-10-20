# js2wasm Benchmark Results

Date: 2026-10-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.054ms | 0.068ms | 0.068ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.016ms | 0.014ms | 0.014ms | 0.013ms | linear-memory |
| string/includes | 0.015ms | 0.018ms | 0.018ms | 0.020ms | js |
| string/split | 0.320ms | 0.397ms | 0.397ms | FAILED | js |
| string/replace | 0.095ms | 0.047ms | 0.047ms | FAILED | gc-native |
| string/case-convert | 0.048ms | 0.005ms | 0.005ms | FAILED | host-call |
| string/substring | 0.103ms | 0.030ms | 0.030ms | FAILED | gc-native |
| string/trim | 0.147ms | 0.143ms | 0.142ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.439ms | 0.194ms | 0.194ms | 0.498ms | gc-native |
| array/push-pop | 1.43ms | 0.466ms | 0.470ms | FAILED | host-call |
| array/sort-i32 | 0.612ms | 0.404ms | 0.406ms | FAILED | host-call |
| array/map-filter | 0.137ms | 0.080ms | 0.086ms | FAILED | host-call |
| array/reduce | 1.39ms | 0.472ms | 0.467ms | FAILED | gc-native |
| array/indexOf | 5.01ms | 2.46ms | 2.50ms | FAILED | host-call |
| array/slice | 0.033ms | 0.037ms | 0.035ms | FAILED | js |
| array/reverse | 7.79ms | 3.48ms | 3.54ms | FAILED | host-call |
| array/forEach | 0.058ms | 0.039ms | 0.039ms | FAILED | host-call |
| array/find | 0.276ms | 0.013ms | 0.013ms | 0.924ms | host-call |
| dom/create-elements | 0.065ms | 0.829ms | — | — | js |
| dom/set-attributes | 0.128ms | 5.80ms | — | — | js |
| dom/read-attributes | 0.072ms | FAILED | — | — | js |
| dom/modify-text | 0.058ms | 1.63ms | — | — | js |
| mixed/csv-parse | 0.383ms | 0.303ms | 0.295ms | FAILED | gc-native |
| mixed/text-search | 0.410ms | 0.269ms | 0.248ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.197ms | 0.202ms | 0.202ms | js |
| mixed/matrix-multiply | 0.178ms | 0.209ms | 0.213ms | 0.682ms | js |
| mixed/sieve | 1.59ms | 2.40ms | 2.30ms | FAILED | js |

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
| string/concat-short | 10000 | 5.43 | 6.83 | 6.79 | — |
| string/concat-long | 1000 | 5.20 | 5.82 | 5.67 | — |
| string/indexOf | 1000 | 15.53 | 14.47 | 14.46 | 13.07 |
| string/includes | 1000 | 15.41 | 17.99 | 17.82 | 20.02 |
| string/split | 10000 | 32.03 | 39.71 | 39.73 | — |
| string/replace | 1000 | 94.60 | 46.95 | 46.77 | — |
| string/case-convert | 2000 | 23.99 | 2.71 | 2.75 | — |
| string/substring | 10000 | 10.29 | 3.05 | 2.99 | — |
| string/trim | 10000 | 14.67 | 14.31 | 14.22 | — |
| string/startsWith-endsWith | 20000 | 21.96 | 9.70 | 9.68 | 24.88 |
| array/map-filter | 30000 | 4.55 | 2.67 | 2.86 | — |
| array/indexOf | 1000 | 5014.64 | 2462.76 | 2503.93 | — |
| dom/create-elements | 2000 | 32.43 | 414.62 | — | — |
| dom/set-attributes | 6000 | 21.39 | 967.22 | — | — |
| dom/read-attributes | 3000 | 23.84 | — | — | — |
| dom/modify-text | 2000 | 29.08 | 812.98 | — | — |
| mixed/csv-parse | 11000 | 34.78 | 27.58 | 26.84 | — |
| mixed/text-search | 40000 | 10.25 | 6.71 | 6.19 | 27.22 |
| mixed/fibonacci | 10000 | 12.52 | 19.71 | 20.16 | 20.21 |
| mixed/matrix-multiply | 125000 | 1.42 | 1.67 | 1.70 | 5.46 |
| mixed/sieve | 200000 | 7.93 | 12.02 | 11.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.26x slower | 1.25x slower | — |
| string/concat-long | 1.12x slower | 1.09x slower | — |
| string/indexOf | 1.07x faster | 1.07x faster | 1.19x faster |
| string/includes | 1.17x slower | 1.16x slower | 1.30x slower |
| string/split | 1.24x slower | 1.24x slower | — |
| string/replace | 2.01x faster | 2.02x faster | — |
| string/case-convert | 8.86x faster | 8.72x faster | — |
| string/substring | 3.38x faster | 3.45x faster | — |
| string/trim | 1.02x faster | 1.03x faster | — |
| string/startsWith-endsWith | 2.26x faster | 2.27x faster | 1.13x slower |
| array/push-pop | 3.07x faster | 3.04x faster | — |
| array/sort-i32 | 1.51x faster | 1.51x faster | — |
| array/map-filter | 1.71x faster | 1.59x faster | — |
| array/reduce | 2.94x faster | 2.97x faster | — |
| array/indexOf | 2.04x faster | 2.00x faster | — |
| array/slice | 1.15x slower | 1.07x slower | — |
| array/reverse | 2.24x faster | 2.20x faster | — |
| array/forEach | 1.51x faster | 1.50x faster | — |
| array/find | 21.43x faster | 21.25x faster | 3.34x slower |
| dom/create-elements | 12.78x slower | — | — |
| dom/set-attributes | 45.22x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 27.96x slower | — | — |
| mixed/csv-parse | 1.26x faster | 1.30x faster | — |
| mixed/text-search | 1.53x faster | 1.66x faster | 2.65x slower |
| mixed/fibonacci | 1.57x slower | 1.61x slower | 1.61x slower |
| mixed/matrix-multiply | 1.17x slower | 1.20x slower | 3.83x slower |
| mixed/sieve | 1.52x slower | 1.45x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x faster |
| string/split | 1.00x slower |
| string/replace | 1.00x faster |
| string/case-convert | 1.02x slower |
| string/substring | 1.02x faster |
| string/trim | 1.01x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.07x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.02x slower |
| array/slice | 1.07x faster |
| array/reverse | 1.02x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.03x faster |
| mixed/text-search | 1.08x faster |
| mixed/fibonacci | 1.02x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.04x faster |

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
| array/indexOf | 26.4KB | 26.4KB | — |
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
| string/concat-short | 1298.2ms | 588.7ms | — |
| string/concat-long | 1012.2ms | 933.6ms | — |
| string/indexOf | 930.8ms | 918.4ms | 558.0ms |
| string/includes | 935.8ms | 912.0ms | 545.3ms |
| string/split | 1027.9ms | 1002.6ms | — |
| string/replace | 1074.0ms | 1103.4ms | — |
| string/case-convert | 985.8ms | 976.1ms | — |
| string/substring | 504.8ms | 529.8ms | — |
| string/trim | 963.0ms | 985.4ms | — |
| string/startsWith-endsWith | 1018.0ms | 1009.9ms | 605.3ms |
| array/push-pop | 976.5ms | 972.8ms | — |
| array/sort-i32 | 1064.1ms | 1041.6ms | — |
| array/map-filter | 1116.0ms | 1108.6ms | — |
| array/reduce | 1055.5ms | 1036.9ms | — |
| array/indexOf | 996.0ms | 1002.0ms | — |
| array/slice | 951.7ms | 971.3ms | — |
| array/reverse | 946.6ms | 964.2ms | — |
| array/forEach | 1034.9ms | 1015.3ms | — |
| array/find | 2176.4ms | 2180.8ms | 541.7ms |
| dom/create-elements | 658.0ms | — | — |
| dom/set-attributes | 585.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 571.6ms | — | — |
| mixed/csv-parse | 995.5ms | 1012.7ms | — |
| mixed/text-search | 1010.3ms | 1045.3ms | 616.7ms |
| mixed/fibonacci | 541.7ms | 519.6ms | 471.2ms |
| mixed/matrix-multiply | 1025.4ms | 995.1ms | 522.9ms |
| mixed/sieve | 1025.6ms | 1021.8ms | — |
