# js2wasm Benchmark Results

Date: 2026-11-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.046ms | 0.046ms | 0.045ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.013ms | 0.013ms | 0.013ms | 0.011ms | linear-memory |
| string/includes | 0.013ms | 0.016ms | 0.015ms | 0.015ms | js |
| string/split | 0.271ms | 0.357ms | 0.341ms | FAILED | js |
| string/replace | 0.069ms | 0.043ms | 0.044ms | FAILED | host-call |
| string/case-convert | 0.045ms | 0.005ms | 0.005ms | FAILED | host-call |
| string/substring | 0.135ms | 0.026ms | 0.027ms | FAILED | host-call |
| string/trim | 0.247ms | 0.130ms | 0.126ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.397ms | 0.165ms | 0.164ms | 0.435ms | gc-native |
| array/push-pop | 1.33ms | 0.452ms | 0.433ms | FAILED | gc-native |
| array/sort-i32 | 0.510ms | 0.357ms | 0.351ms | FAILED | gc-native |
| array/map-filter | 0.124ms | 0.077ms | 0.080ms | FAILED | host-call |
| array/reduce | 1.30ms | 0.432ms | 0.433ms | FAILED | host-call |
| array/indexOf | 4.32ms | 5.09ms | 4.96ms | FAILED | js |
| array/slice | 0.045ms | 0.043ms | 0.042ms | FAILED | gc-native |
| array/reverse | 5.50ms | 3.02ms | 3.03ms | FAILED | host-call |
| array/forEach | 0.057ms | 0.036ms | 0.038ms | FAILED | host-call |
| array/find | 0.247ms | 0.014ms | 0.014ms | 0.782ms | gc-native |
| dom/create-elements | 0.066ms | 0.707ms | — | — | js |
| dom/set-attributes | 0.117ms | 4.73ms | — | — | js |
| dom/read-attributes | 0.072ms | FAILED | — | — | js |
| dom/modify-text | 0.059ms | 1.19ms | — | — | js |
| mixed/csv-parse | 0.319ms | 0.226ms | 0.241ms | FAILED | host-call |
| mixed/text-search | 0.338ms | 0.209ms | 0.206ms | 0.887ms | gc-native |
| mixed/fibonacci | 0.105ms | 0.182ms | 0.165ms | 0.172ms | js |
| mixed/matrix-multiply | 0.151ms | 0.187ms | 0.188ms | 0.552ms | js |
| mixed/sieve | 1.39ms | 2.04ms | 1.98ms | FAILED | js |

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
| string/concat-short | 10000 | 4.56 | 4.61 | 4.51 | — |
| string/concat-long | 1000 | 3.78 | 5.77 | 5.70 | — |
| string/indexOf | 1000 | 13.33 | 12.76 | 12.53 | 10.80 |
| string/includes | 1000 | 12.83 | 15.52 | 14.82 | 14.52 |
| string/split | 10000 | 27.06 | 35.67 | 34.09 | — |
| string/replace | 1000 | 69.16 | 43.24 | 44.01 | — |
| string/case-convert | 2000 | 22.56 | 2.70 | 2.71 | — |
| string/substring | 10000 | 13.45 | 2.59 | 2.69 | — |
| string/trim | 10000 | 24.66 | 12.97 | 12.59 | — |
| string/startsWith-endsWith | 20000 | 19.86 | 8.25 | 8.22 | 21.77 |
| array/map-filter | 30000 | 4.13 | 2.57 | 2.66 | — |
| array/indexOf | 1000 | 4323.12 | 5091.05 | 4963.66 | — |
| dom/create-elements | 2000 | 32.92 | 353.70 | — | — |
| dom/set-attributes | 6000 | 19.52 | 788.50 | — | — |
| dom/read-attributes | 3000 | 24.02 | — | — | — |
| dom/modify-text | 2000 | 29.56 | 594.32 | — | — |
| mixed/csv-parse | 11000 | 28.99 | 20.56 | 21.89 | — |
| mixed/text-search | 40000 | 8.44 | 5.23 | 5.15 | 22.17 |
| mixed/fibonacci | 10000 | 10.48 | 18.23 | 16.46 | 17.22 |
| mixed/matrix-multiply | 125000 | 1.21 | 1.50 | 1.51 | 4.41 |
| mixed/sieve | 200000 | 6.96 | 10.19 | 9.89 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.01x slower | 1.01x faster | — |
| string/concat-long | 1.53x slower | 1.51x slower | — |
| string/indexOf | 1.05x faster | 1.06x faster | 1.23x faster |
| string/includes | 1.21x slower | 1.15x slower | 1.13x slower |
| string/split | 1.32x slower | 1.26x slower | — |
| string/replace | 1.60x faster | 1.57x faster | — |
| string/case-convert | 8.34x faster | 8.34x faster | — |
| string/substring | 5.19x faster | 5.01x faster | — |
| string/trim | 1.90x faster | 1.96x faster | — |
| string/startsWith-endsWith | 2.41x faster | 2.42x faster | 1.10x slower |
| array/push-pop | 2.94x faster | 3.07x faster | — |
| array/sort-i32 | 1.43x faster | 1.45x faster | — |
| array/map-filter | 1.61x faster | 1.56x faster | — |
| array/reduce | 3.01x faster | 3.00x faster | — |
| array/indexOf | 1.18x slower | 1.15x slower | — |
| array/slice | 1.05x faster | 1.08x faster | — |
| array/reverse | 1.82x faster | 1.81x faster | — |
| array/forEach | 1.59x faster | 1.49x faster | — |
| array/find | 17.07x faster | 17.73x faster | 3.16x slower |
| dom/create-elements | 10.75x slower | — | — |
| dom/set-attributes | 40.40x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 20.11x slower | — | — |
| mixed/csv-parse | 1.41x faster | 1.32x faster | — |
| mixed/text-search | 1.61x faster | 1.64x faster | 2.63x slower |
| mixed/fibonacci | 1.74x slower | 1.57x slower | 1.64x slower |
| mixed/matrix-multiply | 1.24x slower | 1.25x slower | 3.66x slower |
| mixed/sieve | 1.46x slower | 1.42x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.02x faster |
| string/includes | 1.05x faster |
| string/split | 1.05x faster |
| string/replace | 1.02x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.04x slower |
| string/trim | 1.03x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.04x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.03x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.03x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.07x slower |
| array/find | 1.04x faster |
| mixed/csv-parse | 1.06x slower |
| mixed/text-search | 1.02x faster |
| mixed/fibonacci | 1.11x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.03x faster |

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
| string/concat-short | 1117.2ms | 488.6ms | — |
| string/concat-long | 835.0ms | 806.2ms | — |
| string/indexOf | 810.8ms | 801.1ms | 462.2ms |
| string/includes | 777.9ms | 757.3ms | 466.6ms |
| string/split | 879.9ms | 892.0ms | — |
| string/replace | 921.7ms | 902.4ms | — |
| string/case-convert | 856.8ms | 858.5ms | — |
| string/substring | 448.1ms | 438.4ms | — |
| string/trim | 869.3ms | 850.8ms | — |
| string/startsWith-endsWith | 844.9ms | 875.3ms | 541.9ms |
| array/push-pop | 845.8ms | 833.9ms | — |
| array/sort-i32 | 905.1ms | 887.2ms | — |
| array/map-filter | 931.8ms | 923.9ms | — |
| array/reduce | 888.4ms | 890.2ms | — |
| array/indexOf | 875.8ms | 842.1ms | — |
| array/slice | 818.8ms | 835.7ms | — |
| array/reverse | 831.7ms | 853.9ms | — |
| array/forEach | 885.2ms | 879.8ms | — |
| array/find | 2401.9ms | 2288.3ms | 479.5ms |
| dom/create-elements | 569.5ms | — | — |
| dom/set-attributes | 536.1ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 508.3ms | — | — |
| mixed/csv-parse | 829.0ms | 886.3ms | — |
| mixed/text-search | 901.8ms | 878.5ms | 531.6ms |
| mixed/fibonacci | 472.3ms | 456.0ms | 395.9ms |
| mixed/matrix-multiply | 888.6ms | 867.8ms | 438.7ms |
| mixed/sieve | 857.7ms | 839.8ms | — |
