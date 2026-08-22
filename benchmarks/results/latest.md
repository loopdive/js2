# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.046ms | 0.051ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.056ms | 0.013ms | 0.025ms | gc-native |
| string/includes | 0.018ms | 0.105ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.395ms | 4.97ms | 0.421ms | FAILED | js |
| string/replace | 0.108ms | 0.268ms | 0.058ms | FAILED | gc-native |
| string/case-convert | 0.057ms | 0.280ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.157ms | 0.853ms | 0.185ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 0.305ms | 0.274ms | 0.580ms | gc-native |
| array/push-pop | 1.44ms | 0.492ms | 0.490ms | FAILED | gc-native |
| array/sort-i32 | 0.716ms | 0.314ms | 0.312ms | FAILED | gc-native |
| array/map-filter | 0.145ms | 0.085ms | 0.085ms | FAILED | host-call |
| array/reduce | 1.29ms | 0.494ms | 0.496ms | FAILED | host-call |
| array/indexOf | 4.83ms | 2.75ms | 2.75ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.035ms | 0.036ms | FAILED | host-call |
| array/reverse | 7.26ms | 3.63ms | 3.64ms | FAILED | host-call |
| array/forEach | 0.101ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.265ms | 0.017ms | 0.017ms | 0.985ms | gc-native |
| dom/create-elements | 0.057ms | 0.183ms | — | — | js |
| dom/set-attributes | 0.126ms | 0.513ms | — | — | js |
| dom/read-attributes | 0.068ms | 0.138ms | — | — | js |
| dom/modify-text | 0.051ms | 0.117ms | — | — | js |
| mixed/csv-parse | 0.468ms | 6.81ms | 0.301ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 1.51ms | 0.265ms | 1.22ms | gc-native |
| mixed/fibonacci | 0.134ms | 0.300ms | 0.300ms | 0.301ms | js |
| mixed/matrix-multiply | 0.203ms | 0.201ms | 0.201ms | 0.772ms | host-call |
| mixed/sieve | 1.48ms | 1.50ms | 1.52ms | FAILED | js |

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
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 4.43 | 4.56 | 5.05 | — |
| string/concat-long | 1000 | 4.46 | 4.70 | 5.62 | — |
| string/indexOf | 1000 | 17.99 | 56.50 | 12.62 | 24.50 |
| string/includes | 1000 | 18.04 | 105.46 | 13.73 | 16.75 |
| string/split | 10000 | 39.51 | 497.35 | 42.07 | — |
| string/replace | 1000 | 107.80 | 268.01 | 57.70 | — |
| string/case-convert | 2000 | 28.37 | 139.83 | 2.65 | — |
| string/substring | 10000 | 10.53 | 4.19 | 3.59 | — |
| string/trim | 10000 | 15.75 | 85.34 | 18.47 | — |
| string/startsWith-endsWith | 20000 | 21.45 | 15.26 | 13.72 | 29.02 |
| array/map-filter | 30000 | 4.83 | 2.82 | 2.82 | — |
| array/indexOf | 1000 | 4827.16 | 2749.32 | 2745.97 | — |
| dom/create-elements | 2000 | 28.44 | 91.55 | — | — |
| dom/set-attributes | 6000 | 21.03 | 85.51 | — | — |
| dom/read-attributes | 3000 | 22.56 | 46.07 | — | — |
| dom/modify-text | 2000 | 25.59 | 58.50 | — | — |
| mixed/csv-parse | 11000 | 42.58 | 619.21 | 27.34 | — |
| mixed/text-search | 40000 | 9.79 | 37.79 | 6.63 | 30.53 |
| mixed/fibonacci | 10000 | 13.38 | 30.00 | 29.97 | 30.11 |
| mixed/matrix-multiply | 125000 | 1.63 | 1.61 | 1.61 | 6.18 |
| mixed/sieve | 200000 | 7.41 | 7.50 | 7.59 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x slower | 1.14x slower | — |
| string/concat-long | 1.05x slower | 1.26x slower | — |
| string/indexOf | 3.14x slower | 1.43x faster | 1.36x slower |
| string/includes | 5.84x slower | 1.31x faster | 1.08x faster |
| string/split | 12.59x slower | 1.06x slower | — |
| string/replace | 2.49x slower | 1.87x faster | — |
| string/case-convert | 4.93x slower | 10.72x faster | — |
| string/substring | 2.51x faster | 2.93x faster | — |
| string/trim | 5.42x slower | 1.17x slower | — |
| string/startsWith-endsWith | 1.41x faster | 1.56x faster | 1.35x slower |
| array/push-pop | 2.93x faster | 2.94x faster | — |
| array/sort-i32 | 2.28x faster | 2.30x faster | — |
| array/map-filter | 1.71x faster | 1.71x faster | — |
| array/reduce | 2.62x faster | 2.61x faster | — |
| array/indexOf | 1.76x faster | 1.76x faster | — |
| array/slice | 1.07x faster | 1.05x faster | — |
| array/reverse | 2.00x faster | 2.00x faster | — |
| array/forEach | 3.56x faster | 3.58x faster | — |
| array/find | 15.42x faster | 15.65x faster | 3.71x slower |
| dom/create-elements | 3.22x slower | — | — |
| dom/set-attributes | 4.07x slower | — | — |
| dom/read-attributes | 2.04x slower | — | — |
| dom/modify-text | 2.29x slower | — | — |
| mixed/csv-parse | 14.54x slower | 1.56x faster | — |
| mixed/text-search | 3.86x slower | 1.48x faster | 3.12x slower |
| mixed/fibonacci | 2.24x slower | 2.24x slower | 2.25x slower |
| mixed/matrix-multiply | 1.01x faster | 1.01x faster | 3.80x slower |
| mixed/sieve | 1.01x slower | 1.02x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x slower |
| string/concat-long | 1.20x slower |
| string/indexOf | 4.48x faster |
| string/includes | 7.68x faster |
| string/split | 11.82x faster |
| string/replace | 4.64x faster |
| string/case-convert | 52.83x faster |
| string/substring | 1.17x faster |
| string/trim | 4.62x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.65x faster |
| mixed/text-search | 5.70x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1202.8ms | 1047.8ms | — |
| string/concat-long | 619.7ms | 921.9ms | — |
| string/indexOf | 629.7ms | 946.3ms | 801.6ms |
| string/includes | 630.0ms | 930.7ms | 868.4ms |
| string/split | 745.5ms | 955.8ms | — |
| string/replace | 762.9ms | 1051.4ms | — |
| string/case-convert | 806.3ms | 841.6ms | — |
| string/substring | 632.3ms | 713.0ms | — |
| string/trim | 747.2ms | 949.4ms | — |
| string/startsWith-endsWith | 745.5ms | 967.6ms | 934.7ms |
| array/push-pop | 772.3ms | 837.6ms | — |
| array/sort-i32 | 885.6ms | 972.3ms | — |
| array/map-filter | 895.0ms | 1008.2ms | — |
| array/reduce | 834.2ms | 925.5ms | — |
| array/indexOf | 827.6ms | 921.9ms | — |
| array/slice | 727.6ms | 813.2ms | — |
| array/reverse | 732.7ms | 829.8ms | — |
| array/forEach | 863.9ms | 1011.4ms | — |
| array/find | 752.0ms | 861.4ms | 836.3ms |
| dom/create-elements | 614.8ms | — | — |
| dom/set-attributes | 711.4ms | — | — |
| dom/read-attributes | 671.0ms | — | — |
| dom/modify-text | 588.3ms | — | — |
| mixed/csv-parse | 796.9ms | 928.2ms | — |
| mixed/text-search | 748.7ms | 988.3ms | 895.4ms |
| mixed/fibonacci | 748.5ms | 809.6ms | 779.8ms |
| mixed/matrix-multiply | 842.9ms | 893.5ms | 765.7ms |
| mixed/sieve | 848.5ms | 892.8ms | — |
