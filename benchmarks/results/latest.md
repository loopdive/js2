# js2wasm Benchmark Results

Date: 2026-10-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.002ms | 0.002ms | FAILED | host-call |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.013ms | linear-memory |
| string/includes | 0.015ms | 0.015ms | 0.015ms | 0.013ms | linear-memory |
| string/split | 0.333ms | 0.392ms | 0.390ms | FAILED | js |
| string/replace | 0.074ms | 0.042ms | 0.042ms | FAILED | host-call |
| string/case-convert | 0.048ms | 0.006ms | 0.006ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | host-call |
| string/trim | 0.134ms | 0.141ms | 0.137ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.181ms | 0.180ms | 0.433ms | gc-native |
| array/push-pop | 1.33ms | 0.495ms | 0.492ms | FAILED | gc-native |
| array/sort-i32 | 0.656ms | 0.332ms | 0.330ms | FAILED | gc-native |
| array/map-filter | 0.108ms | 0.057ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.31ms | 0.491ms | 0.493ms | FAILED | host-call |
| array/indexOf | 3.46ms | 4.62ms | 4.62ms | FAILED | js |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.87ms | 2.79ms | 2.80ms | FAILED | host-call |
| array/forEach | 0.042ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.213ms | 0.009ms | 0.009ms | 0.941ms | host-call |
| dom/create-elements | 0.030ms | 0.688ms | — | — | js |
| dom/set-attributes | 0.085ms | 4.91ms | — | — | js |
| dom/read-attributes | 0.049ms | FAILED | — | — | js |
| dom/modify-text | 0.022ms | 1.30ms | — | — | js |
| mixed/csv-parse | 0.738ms | 0.243ms | 0.241ms | FAILED | gc-native |
| mixed/text-search | 0.313ms | 0.226ms | 0.226ms | 0.873ms | host-call |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.263ms | js |
| mixed/matrix-multiply | 0.146ms | 0.166ms | 0.166ms | 0.565ms | js |
| mixed/sieve | 1.51ms | 1.83ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 2.62 | 3.96 | 3.79 | — |
| string/concat-long | 1000 | 3.10 | 2.38 | 2.40 | — |
| string/indexOf | 1000 | 14.78 | 12.64 | 12.62 | 12.59 |
| string/includes | 1000 | 14.54 | 15.39 | 15.42 | 12.91 |
| string/split | 10000 | 33.34 | 39.16 | 38.95 | — |
| string/replace | 1000 | 73.87 | 41.86 | 41.95 | — |
| string/case-convert | 2000 | 24.01 | 2.87 | 2.87 | — |
| string/substring | 10000 | 8.09 | 2.67 | 2.67 | — |
| string/trim | 10000 | 13.39 | 14.06 | 13.68 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 9.03 | 9.02 | 21.63 |
| array/map-filter | 30000 | 3.60 | 1.90 | 2.05 | — |
| array/indexOf | 1000 | 3464.71 | 4623.56 | 4621.77 | — |
| dom/create-elements | 2000 | 14.89 | 343.81 | — | — |
| dom/set-attributes | 6000 | 14.20 | 818.78 | — | — |
| dom/read-attributes | 3000 | 16.38 | — | — | — |
| dom/modify-text | 2000 | 10.96 | 650.34 | — | — |
| mixed/csv-parse | 11000 | 67.06 | 22.05 | 21.89 | — |
| mixed/text-search | 40000 | 7.82 | 5.65 | 5.66 | 21.81 |
| mixed/fibonacci | 10000 | 9.71 | 25.41 | 25.41 | 26.35 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.33 | 1.33 | 4.52 |
| mixed/sieve | 200000 | 7.56 | 9.17 | 9.17 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.44x slower | — |
| string/concat-long | 1.30x faster | 1.29x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.17x faster |
| string/includes | 1.06x slower | 1.06x slower | 1.13x faster |
| string/split | 1.17x slower | 1.17x slower | — |
| string/replace | 1.76x faster | 1.76x faster | — |
| string/case-convert | 8.38x faster | 8.38x faster | — |
| string/substring | 3.03x faster | 3.03x faster | — |
| string/trim | 1.05x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.78x faster | 1.35x slower |
| array/push-pop | 2.69x faster | 2.71x faster | — |
| array/sort-i32 | 1.97x faster | 1.99x faster | — |
| array/map-filter | 1.90x faster | 1.75x faster | — |
| array/reduce | 2.67x faster | 2.66x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.21x faster | 2.20x faster | — |
| array/reverse | 2.46x faster | 2.45x faster | — |
| array/forEach | 1.03x faster | 1.03x faster | — |
| array/find | 24.26x faster | 24.04x faster | 4.42x slower |
| dom/create-elements | 23.09x slower | — | — |
| dom/set-attributes | 57.68x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 59.33x slower | — | — |
| mixed/csv-parse | 3.04x faster | 3.06x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.79x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 2.71x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.87x slower |
| mixed/sieve | 1.21x slower | 1.21x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x slower |
| string/split | 1.01x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.03x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1127.8ms | 469.7ms | — |
| string/concat-long | 831.0ms | 770.3ms | — |
| string/indexOf | 766.3ms | 778.3ms | 439.1ms |
| string/includes | 776.8ms | 757.1ms | 469.8ms |
| string/split | 852.1ms | 832.0ms | — |
| string/replace | 906.9ms | 865.7ms | — |
| string/case-convert | 819.7ms | 834.8ms | — |
| string/substring | 465.8ms | 402.1ms | — |
| string/trim | 813.1ms | 826.9ms | — |
| string/startsWith-endsWith | 848.9ms | 848.9ms | 528.6ms |
| array/push-pop | 836.0ms | 831.5ms | — |
| array/sort-i32 | 903.5ms | 868.2ms | — |
| array/map-filter | 926.1ms | 928.1ms | — |
| array/reduce | 885.7ms | 883.1ms | — |
| array/indexOf | 866.2ms | 845.4ms | — |
| array/slice | 825.0ms | 840.0ms | — |
| array/reverse | 836.6ms | 824.2ms | — |
| array/forEach | 872.3ms | 887.2ms | — |
| array/find | 2428.2ms | 2372.8ms | 455.1ms |
| dom/create-elements | 522.5ms | — | — |
| dom/set-attributes | 525.2ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 524.5ms | — | — |
| mixed/csv-parse | 839.8ms | 854.0ms | — |
| mixed/text-search | 846.2ms | 883.4ms | 503.4ms |
| mixed/fibonacci | 457.4ms | 427.3ms | 400.6ms |
| mixed/matrix-multiply | 859.5ms | 855.5ms | 434.5ms |
| mixed/sieve | 863.2ms | 879.0ms | — |
