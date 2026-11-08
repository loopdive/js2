# js2wasm Benchmark Results

Date: 2026-11-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.002ms | 0.002ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.019ms | host-call |
| string/includes | 0.015ms | 0.016ms | 0.016ms | 0.019ms | js |
| string/split | 0.327ms | 0.394ms | 0.391ms | FAILED | js |
| string/replace | 0.074ms | 0.043ms | 0.043ms | FAILED | host-call |
| string/case-convert | 0.046ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | host-call |
| string/trim | 0.134ms | 0.136ms | 0.137ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.181ms | 0.181ms | 0.434ms | host-call |
| array/push-pop | 1.37ms | 0.495ms | 0.495ms | FAILED | host-call |
| array/sort-i32 | 0.661ms | 0.342ms | 0.339ms | FAILED | gc-native |
| array/map-filter | 0.107ms | 0.057ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.94ms | 0.496ms | 0.493ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 4.62ms | 4.62ms | FAILED | js |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 2.79ms | 2.79ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.213ms | 0.009ms | 0.009ms | 0.940ms | host-call |
| dom/create-elements | 0.030ms | 0.695ms | — | — | js |
| dom/set-attributes | 0.085ms | 4.92ms | — | — | js |
| dom/read-attributes | 0.048ms | FAILED | — | — | js |
| dom/modify-text | 0.023ms | 1.27ms | — | — | js |
| mixed/csv-parse | 0.363ms | 0.243ms | 0.240ms | FAILED | gc-native |
| mixed/text-search | 0.313ms | 0.227ms | 0.226ms | 0.881ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 0.166ms | 0.166ms | 0.568ms | js |
| mixed/sieve | 1.46ms | 1.82ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 2.80 | 3.88 | 3.83 | — |
| string/concat-long | 1000 | 3.11 | 2.44 | 2.41 | — |
| string/indexOf | 1000 | 14.74 | 12.55 | 12.56 | 19.37 |
| string/includes | 1000 | 14.51 | 15.72 | 15.74 | 19.20 |
| string/split | 10000 | 32.73 | 39.45 | 39.08 | — |
| string/replace | 1000 | 74.29 | 42.53 | 42.62 | — |
| string/case-convert | 2000 | 22.85 | 2.86 | 2.87 | — |
| string/substring | 10000 | 8.11 | 2.66 | 2.66 | — |
| string/trim | 10000 | 13.43 | 13.65 | 13.71 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 9.03 | 9.03 | 21.69 |
| array/map-filter | 30000 | 3.58 | 1.92 | 2.06 | — |
| array/indexOf | 1000 | 3462.70 | 4620.23 | 4620.83 | — |
| dom/create-elements | 2000 | 15.03 | 347.59 | — | — |
| dom/set-attributes | 6000 | 14.24 | 819.90 | — | — |
| dom/read-attributes | 3000 | 16.16 | — | — | — |
| dom/modify-text | 2000 | 11.67 | 634.08 | — | — |
| mixed/csv-parse | 11000 | 33.04 | 22.11 | 21.79 | — |
| mixed/text-search | 40000 | 7.81 | 5.67 | 5.65 | 22.02 |
| mixed/fibonacci | 10000 | 9.72 | 25.41 | 25.41 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.32 | 1.32 | 4.54 |
| mixed/sieve | 200000 | 7.28 | 9.12 | 9.16 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.37x slower | — |
| string/concat-long | 1.28x faster | 1.29x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.31x slower |
| string/includes | 1.08x slower | 1.08x slower | 1.32x slower |
| string/split | 1.21x slower | 1.19x slower | — |
| string/replace | 1.75x faster | 1.74x faster | — |
| string/case-convert | 7.97x faster | 7.97x faster | — |
| string/substring | 3.05x faster | 3.05x faster | — |
| string/trim | 1.02x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.35x slower |
| array/push-pop | 2.78x faster | 2.78x faster | — |
| array/sort-i32 | 1.94x faster | 1.95x faster | — |
| array/map-filter | 1.87x faster | 1.74x faster | — |
| array/reduce | 3.91x faster | 3.93x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.26x faster | 2.29x faster | — |
| array/reverse | 2.46x faster | 2.46x faster | — |
| array/forEach | 1.04x faster | 1.04x faster | — |
| array/find | 23.95x faster | 23.67x faster | 4.41x slower |
| dom/create-elements | 23.13x slower | — | — |
| dom/set-attributes | 57.59x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 54.32x slower | — | — |
| mixed/csv-parse | 1.49x faster | 1.52x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.82x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.89x slower |
| mixed/sieve | 1.25x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x slower |
| string/split | 1.01x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
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
| string/concat-short | 1128.7ms | 499.6ms | — |
| string/concat-long | 823.9ms | 772.8ms | — |
| string/indexOf | 784.9ms | 762.4ms | 473.7ms |
| string/includes | 790.0ms | 771.2ms | 458.2ms |
| string/split | 856.2ms | 850.2ms | — |
| string/replace | 886.7ms | 882.9ms | — |
| string/case-convert | 863.6ms | 843.1ms | — |
| string/substring | 410.0ms | 419.6ms | — |
| string/trim | 822.5ms | 838.2ms | — |
| string/startsWith-endsWith | 887.0ms | 846.1ms | 522.3ms |
| array/push-pop | 822.4ms | 827.8ms | — |
| array/sort-i32 | 1454.9ms | 1438.8ms | — |
| array/map-filter | 1500.5ms | 1502.9ms | — |
| array/reduce | 1441.7ms | 1435.6ms | — |
| array/indexOf | 851.0ms | 846.8ms | — |
| array/slice | 832.3ms | 828.8ms | — |
| array/reverse | 851.1ms | 831.5ms | — |
| array/forEach | 1414.4ms | 1434.3ms | — |
| array/find | 2387.9ms | 2394.7ms | 462.9ms |
| dom/create-elements | 555.8ms | — | — |
| dom/set-attributes | 492.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 511.0ms | — | — |
| mixed/csv-parse | 848.4ms | 854.6ms | — |
| mixed/text-search | 841.3ms | 864.7ms | 532.4ms |
| mixed/fibonacci | 469.0ms | 438.0ms | 399.0ms |
| mixed/matrix-multiply | 877.0ms | 879.0ms | 441.7ms |
| mixed/sieve | 874.9ms | 851.5ms | — |
