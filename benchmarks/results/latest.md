# js2wasm Benchmark Results

Date: 2026-11-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.052ms | 0.069ms | 0.066ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.014ms | 0.013ms | 0.013ms | 0.029ms | host-call |
| string/includes | 0.014ms | 0.016ms | 0.016ms | 0.031ms | js |
| string/split | 0.287ms | 0.354ms | 0.354ms | FAILED | js |
| string/replace | 0.086ms | 0.043ms | 0.043ms | FAILED | host-call |
| string/case-convert | 0.043ms | 0.005ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.091ms | 0.027ms | 0.027ms | FAILED | host-call |
| string/trim | 0.136ms | 0.128ms | 0.128ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.402ms | 0.173ms | 0.173ms | 0.472ms | host-call |
| array/push-pop | 1.33ms | 0.440ms | 0.437ms | FAILED | gc-native |
| array/sort-i32 | 0.551ms | 0.359ms | 0.361ms | FAILED | host-call |
| array/map-filter | 0.125ms | 0.072ms | 0.078ms | FAILED | host-call |
| array/reduce | 1.28ms | 0.436ms | 0.436ms | FAILED | host-call |
| array/indexOf | 4.50ms | 5.31ms | 5.31ms | FAILED | js |
| array/slice | 0.037ms | 0.042ms | 0.040ms | FAILED | js |
| array/reverse | 7.05ms | 3.17ms | 3.17ms | FAILED | host-call |
| array/forEach | 0.078ms | 0.035ms | 0.035ms | FAILED | gc-native |
| array/find | 0.249ms | 0.013ms | 0.012ms | 0.836ms | gc-native |
| dom/create-elements | 0.063ms | 0.843ms | — | — | js |
| dom/set-attributes | 0.119ms | 5.28ms | — | — | js |
| dom/read-attributes | 0.068ms | FAILED | — | — | js |
| dom/modify-text | 0.059ms | 1.41ms | — | — | js |
| mixed/csv-parse | 0.343ms | 0.267ms | 0.265ms | FAILED | gc-native |
| mixed/text-search | 0.367ms | 0.229ms | 0.226ms | 0.984ms | gc-native |
| mixed/fibonacci | 0.113ms | 0.181ms | 0.181ms | 0.180ms | js |
| mixed/matrix-multiply | 0.162ms | 0.196ms | 0.192ms | 0.616ms | js |
| mixed/sieve | 1.50ms | 2.10ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 5.23 | 6.92 | 6.56 | — |
| string/concat-long | 1000 | 5.14 | 5.48 | 5.51 | — |
| string/indexOf | 1000 | 13.96 | 13.04 | 13.06 | 28.61 |
| string/includes | 1000 | 13.78 | 16.06 | 15.99 | 31.49 |
| string/split | 10000 | 28.67 | 35.41 | 35.39 | — |
| string/replace | 1000 | 86.29 | 42.54 | 42.62 | — |
| string/case-convert | 2000 | 21.52 | 2.50 | 2.48 | — |
| string/substring | 10000 | 9.09 | 2.71 | 2.71 | — |
| string/trim | 10000 | 13.61 | 12.81 | 12.80 | — |
| string/startsWith-endsWith | 20000 | 20.12 | 8.64 | 8.65 | 23.60 |
| array/map-filter | 30000 | 4.16 | 2.41 | 2.59 | — |
| array/indexOf | 1000 | 4495.86 | 5308.81 | 5307.74 | — |
| dom/create-elements | 2000 | 31.39 | 421.64 | — | — |
| dom/set-attributes | 6000 | 19.87 | 879.84 | — | — |
| dom/read-attributes | 3000 | 22.83 | — | — | — |
| dom/modify-text | 2000 | 29.31 | 702.61 | — | — |
| mixed/csv-parse | 11000 | 31.17 | 24.23 | 24.05 | — |
| mixed/text-search | 40000 | 9.17 | 5.72 | 5.65 | 24.60 |
| mixed/fibonacci | 10000 | 11.33 | 18.06 | 18.05 | 17.97 |
| mixed/matrix-multiply | 125000 | 1.29 | 1.57 | 1.54 | 4.92 |
| mixed/sieve | 200000 | 7.49 | 10.51 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.32x slower | 1.26x slower | — |
| string/concat-long | 1.07x slower | 1.07x slower | — |
| string/indexOf | 1.07x faster | 1.07x faster | 2.05x slower |
| string/includes | 1.17x slower | 1.16x slower | 2.28x slower |
| string/split | 1.23x slower | 1.23x slower | — |
| string/replace | 2.03x faster | 2.02x faster | — |
| string/case-convert | 8.61x faster | 8.68x faster | — |
| string/substring | 3.36x faster | 3.36x faster | — |
| string/trim | 1.06x faster | 1.06x faster | — |
| string/startsWith-endsWith | 2.33x faster | 2.33x faster | 1.17x slower |
| array/push-pop | 3.01x faster | 3.03x faster | — |
| array/sort-i32 | 1.53x faster | 1.53x faster | — |
| array/map-filter | 1.72x faster | 1.60x faster | — |
| array/reduce | 2.95x faster | 2.95x faster | — |
| array/indexOf | 1.18x slower | 1.18x slower | — |
| array/slice | 1.14x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.22x faster | 2.23x faster | — |
| array/find | 19.85x faster | 20.03x faster | 3.36x slower |
| dom/create-elements | 13.43x slower | — | — |
| dom/set-attributes | 44.27x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 23.97x slower | — | — |
| mixed/csv-parse | 1.29x faster | 1.30x faster | — |
| mixed/text-search | 1.60x faster | 1.62x faster | 2.68x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.59x slower |
| mixed/matrix-multiply | 1.21x slower | 1.19x slower | 3.80x slower |
| mixed/sieve | 1.40x slower | 1.41x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.01x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.01x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x faster |
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
| string/concat-short | 1182.7ms | 497.5ms | — |
| string/concat-long | 903.2ms | 845.6ms | — |
| string/indexOf | 842.1ms | 814.5ms | 504.2ms |
| string/includes | 846.8ms | 847.2ms | 511.9ms |
| string/split | 900.1ms | 924.7ms | — |
| string/replace | 962.5ms | 942.2ms | — |
| string/case-convert | 893.3ms | 887.5ms | — |
| string/substring | 451.8ms | 440.8ms | — |
| string/trim | 907.2ms | 888.8ms | — |
| string/startsWith-endsWith | 906.6ms | 933.8ms | 573.8ms |
| array/push-pop | 903.4ms | 884.6ms | — |
| array/sort-i32 | 962.2ms | 958.8ms | — |
| array/map-filter | 1019.1ms | 1002.1ms | — |
| array/reduce | 944.4ms | 948.0ms | — |
| array/indexOf | 977.0ms | 907.4ms | — |
| array/slice | 890.5ms | 921.2ms | — |
| array/reverse | 903.3ms | 899.7ms | — |
| array/forEach | 952.6ms | 946.9ms | — |
| array/find | 2574.2ms | 2505.0ms | 503.8ms |
| dom/create-elements | 603.1ms | — | — |
| dom/set-attributes | 543.8ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 549.1ms | — | — |
| mixed/csv-parse | 929.6ms | 921.9ms | — |
| mixed/text-search | 934.4ms | 942.6ms | 546.5ms |
| mixed/fibonacci | 500.2ms | 473.2ms | 421.1ms |
| mixed/matrix-multiply | 935.3ms | 940.5ms | 472.9ms |
| mixed/sieve | 927.2ms | 941.8ms | — |
