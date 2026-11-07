# js2wasm Benchmark Results

Date: 2026-11-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.002ms | 0.002ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.032ms | host-call |
| string/includes | 0.015ms | 0.016ms | 0.015ms | 0.021ms | js |
| string/split | 0.325ms | 0.390ms | 0.390ms | FAILED | js |
| string/replace | 0.074ms | 0.042ms | 0.042ms | FAILED | host-call |
| string/case-convert | 0.045ms | 0.006ms | 0.006ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.136ms | 0.137ms | FAILED | js |
| string/startsWith-endsWith | 0.321ms | 0.181ms | 0.181ms | 0.434ms | gc-native |
| array/push-pop | 1.38ms | 0.500ms | 0.499ms | FAILED | gc-native |
| array/sort-i32 | 0.654ms | 0.352ms | 0.326ms | FAILED | gc-native |
| array/map-filter | 0.107ms | 0.057ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.33ms | 0.499ms | 0.495ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 4.62ms | 4.62ms | FAILED | js |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.87ms | 2.79ms | 2.79ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.041ms | 0.041ms | FAILED | gc-native |
| array/find | 0.212ms | 0.009ms | 0.009ms | 0.947ms | host-call |
| dom/create-elements | 0.030ms | 0.681ms | — | — | js |
| dom/set-attributes | 0.086ms | 4.92ms | — | — | js |
| dom/read-attributes | 0.049ms | FAILED | — | — | js |
| dom/modify-text | 0.024ms | 1.26ms | — | — | js |
| mixed/csv-parse | 0.362ms | 0.243ms | 0.245ms | FAILED | host-call |
| mixed/text-search | 0.317ms | 0.227ms | 0.226ms | 0.875ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 0.166ms | 0.166ms | 0.569ms | js |
| mixed/sieve | 1.45ms | 1.84ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 2.37 | 3.86 | 3.82 | — |
| string/concat-long | 1000 | 3.25 | 2.44 | 2.44 | — |
| string/indexOf | 1000 | 14.79 | 12.58 | 12.60 | 31.53 |
| string/includes | 1000 | 14.54 | 15.50 | 15.49 | 21.15 |
| string/split | 10000 | 32.52 | 39.04 | 38.99 | — |
| string/replace | 1000 | 74.05 | 41.91 | 42.05 | — |
| string/case-convert | 2000 | 22.62 | 2.87 | 2.87 | — |
| string/substring | 10000 | 8.09 | 2.67 | 2.66 | — |
| string/trim | 10000 | 13.41 | 13.60 | 13.70 | — |
| string/startsWith-endsWith | 20000 | 16.03 | 9.04 | 9.04 | 21.72 |
| array/map-filter | 30000 | 3.58 | 1.91 | 2.06 | — |
| array/indexOf | 1000 | 3463.58 | 4621.64 | 4616.63 | — |
| dom/create-elements | 2000 | 15.02 | 340.42 | — | — |
| dom/set-attributes | 6000 | 14.31 | 819.52 | — | — |
| dom/read-attributes | 3000 | 16.41 | — | — | — |
| dom/modify-text | 2000 | 11.77 | 631.40 | — | — |
| mixed/csv-parse | 11000 | 32.94 | 22.12 | 22.23 | — |
| mixed/text-search | 40000 | 7.93 | 5.68 | 5.65 | 21.87 |
| mixed/fibonacci | 10000 | 9.72 | 25.41 | 25.44 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.33 | 1.33 | 4.55 |
| mixed/sieve | 200000 | 7.23 | 9.19 | 9.15 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.63x slower | 1.62x slower | — |
| string/concat-long | 1.33x faster | 1.33x faster | — |
| string/indexOf | 1.18x faster | 1.17x faster | 2.13x slower |
| string/includes | 1.07x slower | 1.07x slower | 1.45x slower |
| string/split | 1.20x slower | 1.20x slower | — |
| string/replace | 1.77x faster | 1.76x faster | — |
| string/case-convert | 7.89x faster | 7.89x faster | — |
| string/substring | 3.03x faster | 3.04x faster | — |
| string/trim | 1.01x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.36x slower |
| array/push-pop | 2.76x faster | 2.76x faster | — |
| array/sort-i32 | 1.86x faster | 2.01x faster | — |
| array/map-filter | 1.87x faster | 1.74x faster | — |
| array/reduce | 2.67x faster | 2.69x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.21x faster | 2.21x faster | — |
| array/reverse | 2.46x faster | 2.46x faster | — |
| array/forEach | 1.04x faster | 1.04x faster | — |
| array/find | 24.64x faster | 23.98x faster | 4.46x slower |
| dom/create-elements | 22.67x slower | — | — |
| dom/set-attributes | 57.26x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 53.64x slower | — | — |
| mixed/csv-parse | 1.49x faster | 1.48x faster | — |
| mixed/text-search | 1.40x faster | 1.40x faster | 2.76x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.60x slower |
| mixed/matrix-multiply | 1.13x slower | 1.14x slower | 3.89x slower |
| mixed/sieve | 1.27x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.00x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x faster |
| string/trim | 1.01x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.08x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.03x slower |
| mixed/csv-parse | 1.00x slower |
| mixed/text-search | 1.00x faster |
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
| string/concat-short | 1135.9ms | 462.2ms | — |
| string/concat-long | 856.1ms | 765.0ms | — |
| string/indexOf | 766.7ms | 806.7ms | 470.2ms |
| string/includes | 775.3ms | 770.9ms | 466.3ms |
| string/split | 875.6ms | 829.1ms | — |
| string/replace | 933.5ms | 881.6ms | — |
| string/case-convert | 837.6ms | 835.1ms | — |
| string/substring | 424.6ms | 412.3ms | — |
| string/trim | 826.3ms | 855.5ms | — |
| string/startsWith-endsWith | 876.5ms | 848.1ms | 531.2ms |
| array/push-pop | 860.4ms | 854.2ms | — |
| array/sort-i32 | 910.1ms | 889.3ms | — |
| array/map-filter | 953.6ms | 935.2ms | — |
| array/reduce | 899.0ms | 902.5ms | — |
| array/indexOf | 853.0ms | 836.0ms | — |
| array/slice | 816.1ms | 818.8ms | — |
| array/reverse | 826.4ms | 822.7ms | — |
| array/forEach | 856.4ms | 860.4ms | — |
| array/find | 2400.3ms | 2339.1ms | 460.2ms |
| dom/create-elements | 546.0ms | — | — |
| dom/set-attributes | 491.1ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 500.9ms | — | — |
| mixed/csv-parse | 827.5ms | 881.5ms | — |
| mixed/text-search | 875.2ms | 888.3ms | 506.4ms |
| mixed/fibonacci | 444.3ms | 439.7ms | 394.0ms |
| mixed/matrix-multiply | 872.1ms | 883.0ms | 436.6ms |
| mixed/sieve | 889.3ms | 864.9ms | — |
