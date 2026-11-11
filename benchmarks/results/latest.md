# js2wasm Benchmark Results

Date: 2026-11-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.013ms | 0.013ms | 0.031ms | gc-native |
| string/includes | 0.015ms | 0.015ms | 0.015ms | 0.020ms | js |
| string/split | 0.350ms | 0.390ms | 0.391ms | FAILED | js |
| string/replace | 0.076ms | 0.042ms | 0.043ms | FAILED | host-call |
| string/case-convert | 0.047ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.081ms | 0.027ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 0.137ms | 0.137ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.181ms | 0.181ms | 0.434ms | host-call |
| array/push-pop | 1.37ms | 0.499ms | 0.494ms | FAILED | gc-native |
| array/sort-i32 | 0.659ms | 0.311ms | 0.323ms | FAILED | host-call |
| array/map-filter | 0.110ms | 0.058ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.31ms | 0.496ms | 0.494ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 4.62ms | 4.62ms | FAILED | js |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 2.79ms | 2.80ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.213ms | 0.009ms | 0.009ms | 0.946ms | host-call |
| dom/create-elements | 0.031ms | 0.691ms | — | — | js |
| dom/set-attributes | 0.086ms | 5.08ms | — | — | js |
| dom/read-attributes | 0.048ms | FAILED | — | — | js |
| dom/modify-text | 0.024ms | 1.26ms | — | — | js |
| mixed/csv-parse | 0.742ms | 0.243ms | 0.240ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 0.226ms | 0.226ms | 0.889ms | host-call |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 0.166ms | 0.166ms | 0.566ms | js |
| mixed/sieve | 1.46ms | 1.83ms | 1.84ms | FAILED | js |

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
| string/concat-short | 10000 | 2.39 | 3.95 | 3.84 | — |
| string/concat-long | 1000 | 3.40 | 2.57 | 2.50 | — |
| string/indexOf | 1000 | 14.77 | 12.62 | 12.60 | 31.38 |
| string/includes | 1000 | 14.54 | 15.49 | 15.49 | 19.94 |
| string/split | 10000 | 35.00 | 39.04 | 39.07 | — |
| string/replace | 1000 | 75.79 | 42.04 | 42.60 | — |
| string/case-convert | 2000 | 23.41 | 2.87 | 2.87 | — |
| string/substring | 10000 | 8.13 | 2.67 | 2.67 | — |
| string/trim | 10000 | 13.52 | 13.69 | 13.68 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 9.05 | 9.06 | 21.72 |
| array/map-filter | 30000 | 3.68 | 1.92 | 2.06 | — |
| array/indexOf | 1000 | 3462.23 | 4621.28 | 4619.01 | — |
| dom/create-elements | 2000 | 15.50 | 345.60 | — | — |
| dom/set-attributes | 6000 | 14.38 | 847.14 | — | — |
| dom/read-attributes | 3000 | 16.14 | — | — | — |
| dom/modify-text | 2000 | 12.06 | 631.96 | — | — |
| mixed/csv-parse | 11000 | 67.46 | 22.12 | 21.82 | — |
| mixed/text-search | 40000 | 7.81 | 5.65 | 5.65 | 22.21 |
| mixed/fibonacci | 10000 | 9.72 | 25.42 | 25.41 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.32 | 1.33 | 4.53 |
| mixed/sieve | 200000 | 7.30 | 9.14 | 9.21 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.66x slower | 1.61x slower | — |
| string/concat-long | 1.32x faster | 1.36x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 2.12x slower |
| string/includes | 1.07x slower | 1.07x slower | 1.37x slower |
| string/split | 1.12x slower | 1.12x slower | — |
| string/replace | 1.80x faster | 1.78x faster | — |
| string/case-convert | 8.17x faster | 8.16x faster | — |
| string/substring | 3.05x faster | 3.05x faster | — |
| string/trim | 1.01x slower | 1.01x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.36x slower |
| array/push-pop | 2.74x faster | 2.76x faster | — |
| array/sort-i32 | 2.12x faster | 2.04x faster | — |
| array/map-filter | 1.91x faster | 1.78x faster | — |
| array/reduce | 2.65x faster | 2.66x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.25x faster | 2.24x faster | — |
| array/reverse | 2.46x faster | 2.45x faster | — |
| array/forEach | 1.04x faster | 1.04x faster | — |
| array/find | 24.03x faster | 23.89x faster | 4.44x slower |
| dom/create-elements | 22.30x slower | — | — |
| dom/set-attributes | 58.90x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 52.38x slower | — | — |
| mixed/csv-parse | 3.05x faster | 3.09x faster | — |
| mixed/text-search | 1.38x faster | 1.38x faster | 2.84x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.86x slower |
| mixed/sieve | 1.25x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x slower |
| string/replace | 1.01x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.04x slower |
| array/map-filter | 1.07x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x slower |
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
| string/concat-short | 1151.7ms | 471.9ms | — |
| string/concat-long | 887.6ms | 790.3ms | — |
| string/indexOf | 789.3ms | 774.2ms | 466.6ms |
| string/includes | 811.7ms | 781.7ms | 466.3ms |
| string/split | 893.6ms | 864.1ms | — |
| string/replace | 919.2ms | 903.4ms | — |
| string/case-convert | 857.7ms | 877.7ms | — |
| string/substring | 435.0ms | 430.6ms | — |
| string/trim | 844.7ms | 875.1ms | — |
| string/startsWith-endsWith | 867.2ms | 848.7ms | 516.9ms |
| array/push-pop | 837.9ms | 844.5ms | — |
| array/sort-i32 | 1469.5ms | 1448.9ms | — |
| array/map-filter | 1527.4ms | 1482.5ms | — |
| array/reduce | 1467.0ms | 1446.1ms | — |
| array/indexOf | 862.8ms | 866.7ms | — |
| array/slice | 837.5ms | 824.6ms | — |
| array/reverse | 841.3ms | 831.5ms | — |
| array/forEach | 1437.9ms | 1446.9ms | — |
| array/find | 2387.1ms | 2364.0ms | 463.4ms |
| dom/create-elements | 522.7ms | — | — |
| dom/set-attributes | 519.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 514.5ms | — | — |
| mixed/csv-parse | 862.1ms | 854.8ms | — |
| mixed/text-search | 844.4ms | 877.4ms | 514.3ms |
| mixed/fibonacci | 463.2ms | 443.8ms | 410.0ms |
| mixed/matrix-multiply | 887.5ms | 876.0ms | 447.3ms |
| mixed/sieve | 871.2ms | 878.1ms | — |
