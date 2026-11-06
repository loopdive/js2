# js2wasm Benchmark Results

Date: 2026-11-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.003ms | 0.003ms | FAILED | host-call |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.024ms | host-call |
| string/includes | 0.015ms | 0.016ms | 0.016ms | 0.029ms | js |
| string/split | 0.328ms | 0.392ms | 0.390ms | FAILED | js |
| string/replace | 0.076ms | 0.042ms | 0.042ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.082ms | 0.027ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 0.137ms | 0.140ms | FAILED | js |
| string/startsWith-endsWith | 0.321ms | 0.181ms | 0.181ms | 0.434ms | host-call |
| array/push-pop | 1.40ms | 0.504ms | 0.506ms | FAILED | host-call |
| array/sort-i32 | 0.658ms | 0.336ms | 0.333ms | FAILED | gc-native |
| array/map-filter | 0.110ms | 0.058ms | 0.063ms | FAILED | host-call |
| array/reduce | 1.35ms | 0.504ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 3.47ms | 4.63ms | 4.63ms | FAILED | js |
| array/slice | 0.036ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 2.80ms | 2.80ms | FAILED | host-call |
| array/forEach | 0.077ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.213ms | 0.009ms | 0.009ms | 0.946ms | host-call |
| dom/create-elements | 0.031ms | 0.718ms | — | — | js |
| dom/set-attributes | 0.086ms | 5.00ms | — | — | js |
| dom/read-attributes | 0.051ms | FAILED | — | — | js |
| dom/modify-text | 0.024ms | 1.28ms | — | — | js |
| mixed/csv-parse | 0.363ms | 0.243ms | 0.242ms | FAILED | gc-native |
| mixed/text-search | 0.315ms | 0.227ms | 0.226ms | 0.886ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 0.166ms | 0.166ms | 0.571ms | js |
| mixed/sieve | 1.48ms | 1.82ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 2.63 | 3.95 | 3.85 | — |
| string/concat-long | 1000 | 3.42 | 2.54 | 2.54 | — |
| string/indexOf | 1000 | 14.80 | 12.69 | 12.72 | 24.29 |
| string/includes | 1000 | 14.58 | 15.82 | 15.80 | 29.06 |
| string/split | 10000 | 32.79 | 39.18 | 39.03 | — |
| string/replace | 1000 | 75.60 | 42.41 | 42.37 | — |
| string/case-convert | 2000 | 22.55 | 2.87 | 2.87 | — |
| string/substring | 10000 | 8.15 | 2.67 | 2.66 | — |
| string/trim | 10000 | 13.49 | 13.67 | 14.02 | — |
| string/startsWith-endsWith | 20000 | 16.03 | 9.03 | 9.03 | 21.72 |
| array/map-filter | 30000 | 3.65 | 1.93 | 2.10 | — |
| array/indexOf | 1000 | 3468.42 | 4626.64 | 4627.21 | — |
| dom/create-elements | 2000 | 15.68 | 359.07 | — | — |
| dom/set-attributes | 6000 | 14.38 | 833.68 | — | — |
| dom/read-attributes | 3000 | 17.13 | — | — | — |
| dom/modify-text | 2000 | 11.99 | 642.42 | — | — |
| mixed/csv-parse | 11000 | 32.99 | 22.12 | 21.98 | — |
| mixed/text-search | 40000 | 7.88 | 5.68 | 5.66 | 22.15 |
| mixed/fibonacci | 10000 | 9.73 | 25.41 | 25.41 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.18 | 1.33 | 1.33 | 4.56 |
| mixed/sieve | 200000 | 7.42 | 9.10 | 9.16 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.46x slower | — |
| string/concat-long | 1.35x faster | 1.35x faster | — |
| string/indexOf | 1.17x faster | 1.16x faster | 1.64x slower |
| string/includes | 1.09x slower | 1.08x slower | 1.99x slower |
| string/split | 1.19x slower | 1.19x slower | — |
| string/replace | 1.78x faster | 1.78x faster | — |
| string/case-convert | 7.87x faster | 7.87x faster | — |
| string/substring | 3.06x faster | 3.07x faster | — |
| string/trim | 1.01x slower | 1.04x slower | — |
| string/startsWith-endsWith | 1.78x faster | 1.77x faster | 1.35x slower |
| array/push-pop | 2.78x faster | 2.76x faster | — |
| array/sort-i32 | 1.96x faster | 1.98x faster | — |
| array/map-filter | 1.89x faster | 1.74x faster | — |
| array/reduce | 2.69x faster | 2.69x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.34x faster | 2.36x faster | — |
| array/reverse | 2.45x faster | 2.45x faster | — |
| array/forEach | 1.88x faster | 1.87x faster | — |
| array/find | 23.86x faster | 22.99x faster | 4.43x slower |
| dom/create-elements | 22.89x slower | — | — |
| dom/set-attributes | 57.97x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 53.57x slower | — | — |
| mixed/csv-parse | 1.49x faster | 1.50x faster | — |
| mixed/text-search | 1.39x faster | 1.39x faster | 2.81x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.88x slower |
| mixed/sieve | 1.23x slower | 1.23x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.00x slower |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.03x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.09x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.04x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
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
| string/concat-short | 1170.1ms | 485.6ms | — |
| string/concat-long | 865.5ms | 776.6ms | — |
| string/indexOf | 787.3ms | 814.0ms | 489.8ms |
| string/includes | 772.2ms | 793.3ms | 488.5ms |
| string/split | 884.8ms | 868.8ms | — |
| string/replace | 923.5ms | 917.9ms | — |
| string/case-convert | 876.2ms | 866.9ms | — |
| string/substring | 438.3ms | 439.5ms | — |
| string/trim | 880.3ms | 856.9ms | — |
| string/startsWith-endsWith | 914.2ms | 879.6ms | 545.2ms |
| array/push-pop | 862.7ms | 865.6ms | — |
| array/sort-i32 | 942.9ms | 913.6ms | — |
| array/map-filter | 980.5ms | 963.8ms | — |
| array/reduce | 917.6ms | 902.5ms | — |
| array/indexOf | 897.2ms | 893.6ms | — |
| array/slice | 855.6ms | 877.5ms | — |
| array/reverse | 865.7ms | 860.9ms | — |
| array/forEach | 900.0ms | 889.4ms | — |
| array/find | 2505.2ms | 2459.3ms | 480.7ms |
| dom/create-elements | 578.1ms | — | — |
| dom/set-attributes | 522.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 517.9ms | — | — |
| mixed/csv-parse | 883.0ms | 884.3ms | — |
| mixed/text-search | 882.0ms | 901.3ms | 539.1ms |
| mixed/fibonacci | 460.9ms | 476.8ms | 417.7ms |
| mixed/matrix-multiply | 908.0ms | 922.1ms | 462.1ms |
| mixed/sieve | 909.8ms | 894.6ms | — |
