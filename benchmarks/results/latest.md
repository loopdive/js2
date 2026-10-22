# js2wasm Benchmark Results

Date: 2026-10-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.002ms | 0.002ms | FAILED | host-call |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.019ms | gc-native |
| string/includes | 0.015ms | 0.015ms | 0.015ms | 0.032ms | js |
| string/split | 0.325ms | 0.391ms | 0.391ms | FAILED | js |
| string/replace | 0.076ms | 0.044ms | 0.044ms | FAILED | host-call |
| string/case-convert | 0.045ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.137ms | 0.137ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.180ms | 0.181ms | 0.434ms | host-call |
| array/push-pop | 1.32ms | 0.480ms | 0.478ms | FAILED | gc-native |
| array/sort-i32 | 0.657ms | 0.330ms | 0.332ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.058ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.92ms | 0.484ms | 0.480ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 4.63ms | 4.61ms | FAILED | js |
| array/slice | 0.034ms | 0.015ms | 0.015ms | FAILED | host-call |
| array/reverse | 6.86ms | 2.79ms | 2.79ms | FAILED | gc-native |
| array/forEach | 0.075ms | 0.041ms | 0.041ms | FAILED | gc-native |
| array/find | 0.213ms | 0.009ms | 0.009ms | 0.941ms | host-call |
| dom/create-elements | 0.031ms | 0.716ms | — | — | js |
| dom/set-attributes | 0.087ms | 4.95ms | — | — | js |
| dom/read-attributes | 0.050ms | FAILED | — | — | js |
| dom/modify-text | 0.024ms | 1.28ms | — | — | js |
| mixed/csv-parse | 0.370ms | 0.243ms | 0.242ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 0.226ms | 0.226ms | 0.864ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 0.166ms | 0.166ms | 0.564ms | js |
| mixed/sieve | 1.44ms | 1.82ms | 1.80ms | FAILED | js |

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
| string/concat-short | 10000 | 2.73 | 3.89 | 3.76 | — |
| string/concat-long | 1000 | 3.36 | 2.35 | 2.39 | — |
| string/indexOf | 1000 | 14.74 | 12.88 | 12.70 | 19.07 |
| string/includes | 1000 | 14.54 | 15.33 | 15.35 | 31.94 |
| string/split | 10000 | 32.51 | 39.11 | 39.09 | — |
| string/replace | 1000 | 75.87 | 43.87 | 43.92 | — |
| string/case-convert | 2000 | 22.48 | 2.86 | 2.86 | — |
| string/substring | 10000 | 8.14 | 2.67 | 2.66 | — |
| string/trim | 10000 | 13.44 | 13.68 | 13.69 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 9.01 | 9.05 | 21.68 |
| array/map-filter | 30000 | 3.62 | 1.93 | 2.08 | — |
| array/indexOf | 1000 | 3459.39 | 4626.71 | 4612.61 | — |
| dom/create-elements | 2000 | 15.36 | 357.84 | — | — |
| dom/set-attributes | 6000 | 14.45 | 824.17 | — | — |
| dom/read-attributes | 3000 | 16.57 | — | — | — |
| dom/modify-text | 2000 | 12.19 | 639.26 | — | — |
| mixed/csv-parse | 11000 | 33.66 | 22.09 | 22.00 | — |
| mixed/text-search | 40000 | 7.81 | 5.65 | 5.65 | 21.60 |
| mixed/fibonacci | 10000 | 9.71 | 25.39 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.33 | 1.33 | 4.51 |
| mixed/sieve | 200000 | 7.18 | 9.09 | 8.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.38x slower | — |
| string/concat-long | 1.43x faster | 1.41x faster | — |
| string/indexOf | 1.14x faster | 1.16x faster | 1.29x slower |
| string/includes | 1.05x slower | 1.06x slower | 2.20x slower |
| string/split | 1.20x slower | 1.20x slower | — |
| string/replace | 1.73x faster | 1.73x faster | — |
| string/case-convert | 7.85x faster | 7.85x faster | — |
| string/substring | 3.05x faster | 3.05x faster | — |
| string/trim | 1.02x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.78x faster | 1.77x faster | 1.35x slower |
| array/push-pop | 2.76x faster | 2.77x faster | — |
| array/sort-i32 | 1.99x faster | 1.98x faster | — |
| array/map-filter | 1.88x faster | 1.74x faster | — |
| array/reduce | 3.96x faster | 3.99x faster | — |
| array/indexOf | 1.34x slower | 1.33x slower | — |
| array/slice | 2.33x faster | 2.23x faster | — |
| array/reverse | 2.46x faster | 2.46x faster | — |
| array/forEach | 1.81x faster | 1.81x faster | — |
| array/find | 24.02x faster | 22.86x faster | 4.41x slower |
| dom/create-elements | 23.29x slower | — | — |
| dom/set-attributes | 57.04x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 52.45x slower | — | — |
| mixed/csv-parse | 1.52x faster | 1.53x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.77x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.60x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.85x slower |
| mixed/sieve | 1.27x slower | 1.25x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 1.01x faster |
| string/includes | 1.00x slower |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.05x slower |
| mixed/csv-parse | 1.00x faster |
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
| string/concat-short | 1081.1ms | 430.0ms | — |
| string/concat-long | 811.8ms | 759.9ms | — |
| string/indexOf | 732.7ms | 733.1ms | 424.0ms |
| string/includes | 732.7ms | 732.4ms | 413.0ms |
| string/split | 815.8ms | 825.2ms | — |
| string/replace | 827.7ms | 879.1ms | — |
| string/case-convert | 810.4ms | 793.9ms | — |
| string/substring | 388.3ms | 408.1ms | — |
| string/trim | 815.5ms | 809.1ms | — |
| string/startsWith-endsWith | 836.4ms | 819.0ms | 474.4ms |
| array/push-pop | 837.6ms | 802.2ms | — |
| array/sort-i32 | 874.8ms | 883.9ms | — |
| array/map-filter | 946.3ms | 941.1ms | — |
| array/reduce | 881.4ms | 866.0ms | — |
| array/indexOf | 849.7ms | 820.8ms | — |
| array/slice | 804.6ms | 817.1ms | — |
| array/reverse | 819.7ms | 816.0ms | — |
| array/forEach | 844.6ms | 848.2ms | — |
| array/find | 1951.5ms | 1891.5ms | 444.0ms |
| dom/create-elements | 526.0ms | — | — |
| dom/set-attributes | 482.3ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 519.3ms | — | — |
| mixed/csv-parse | 829.6ms | 824.2ms | — |
| mixed/text-search | 821.3ms | 852.9ms | 495.4ms |
| mixed/fibonacci | 429.1ms | 414.2ms | 393.2ms |
| mixed/matrix-multiply | 844.1ms | 856.4ms | 412.3ms |
| mixed/sieve | 836.1ms | 828.1ms | — |
