# js2wasm Benchmark Results

Date: 2026-08-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.047ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.426ms | 8.04ms | 2.83ms | FAILED | js |
| string/replace | 0.112ms | 0.936ms | 0.314ms | FAILED | js |
| string/case-convert | 0.056ms | 0.611ms | 0.265ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.85ms | 2.75ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.93ms | 2.86ms | 0.564ms | js |
| array/push-pop | 1.43ms | 0.512ms | 0.506ms | FAILED | gc-native |
| array/sort-i32 | 0.801ms | 0.390ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.132ms | 0.072ms | 0.071ms | FAILED | gc-native |
| array/reduce | 1.34ms | 0.502ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.027ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | 0.160ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.489ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.125ms | — | — | js |
| dom/modify-text | 0.030ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.481ms | 8.44ms | 0.605ms | FAILED | js |
| mixed/text-search | 0.380ms | 4.91ms | 2.87ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 72.42ms | 74.48ms | 0.714ms | js |
| mixed/sieve | 1.58ms | 2.13ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.16 | 4.69 | 4.39 | — |
| string/concat-long | 1000 | 3.89 | 4.64 | 3.75 | — |
| string/indexOf | 1000 | 19.20 | 65.13 | 12.33 | 15.60 |
| string/includes | 1000 | 19.21 | 50.71 | 14.79 | 15.40 |
| string/split | 10000 | 42.57 | 803.62 | 283.38 | — |
| string/replace | 1000 | 111.98 | 935.71 | 313.84 | — |
| string/case-convert | 2000 | 27.82 | 305.66 | 132.43 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.99 | 385.06 | 274.74 | — |
| string/startsWith-endsWith | 20000 | 20.10 | 146.37 | 143.03 | 28.18 |
| array/map-filter | 30000 | 4.39 | 2.41 | 2.37 | — |
| array/indexOf | 1000 | 3956.07 | 2635.95 | 2636.07 | — |
| dom/create-elements | 2000 | 17.52 | 79.97 | — | — |
| dom/set-attributes | 6000 | 17.36 | 81.51 | — | — |
| dom/read-attributes | 3000 | 18.49 | 41.63 | — | — |
| dom/modify-text | 2000 | 14.77 | 55.85 | — | — |
| mixed/csv-parse | 11000 | 43.75 | 767.22 | 55.01 | — |
| mixed/text-search | 40000 | 9.49 | 122.81 | 71.76 | 26.99 |
| mixed/fibonacci | 10000 | 12.18 | 28.30 | 28.32 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 579.33 | 595.82 | 5.71 |
| mixed/sieve | 200000 | 7.91 | 10.64 | 10.53 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.39x slower | — |
| string/concat-long | 1.19x slower | 1.04x faster | — |
| string/indexOf | 3.39x slower | 1.56x faster | 1.23x faster |
| string/includes | 2.64x slower | 1.30x faster | 1.25x faster |
| string/split | 18.88x slower | 6.66x slower | — |
| string/replace | 8.36x slower | 2.80x slower | — |
| string/case-convert | 10.99x slower | 4.76x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 22.66x slower | 16.17x slower | — |
| string/startsWith-endsWith | 7.28x slower | 7.11x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.83x faster | — |
| array/sort-i32 | 2.06x faster | 2.73x faster | — |
| array/map-filter | 1.82x faster | 1.85x faster | — |
| array/reduce | 2.67x faster | 2.66x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.74x faster | — |
| array/find | 15.48x faster | 15.93x faster | 4.23x slower |
| dom/create-elements | 4.56x slower | — | — |
| dom/set-attributes | 4.69x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.78x slower | — | — |
| mixed/csv-parse | 17.54x slower | 1.26x slower | — |
| mixed/text-search | 12.94x slower | 7.56x slower | 2.84x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 456.50x slower | 469.50x slower | 4.50x slower |
| mixed/sieve | 1.34x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.28x faster |
| string/includes | 3.43x faster |
| string/split | 2.84x faster |
| string/replace | 2.98x faster |
| string/case-convert | 2.31x faster |
| string/substring | 1.22x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.33x faster |
| array/map-filter | 1.02x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.03x faster |
| mixed/csv-parse | 13.95x faster |
| mixed/text-search | 1.71x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.4KB | 3.0KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1631.6ms | 1051.0ms | — |
| string/concat-long | 760.1ms | 980.3ms | — |
| string/indexOf | 652.0ms | 997.8ms | 848.1ms |
| string/includes | 665.9ms | 998.4ms | 840.9ms |
| string/split | 779.9ms | 1001.2ms | — |
| string/replace | 787.1ms | 1065.0ms | — |
| string/case-convert | 785.8ms | 877.1ms | — |
| string/substring | 653.1ms | 764.2ms | — |
| string/trim | 770.0ms | 976.8ms | — |
| string/startsWith-endsWith | 767.9ms | 1005.9ms | 937.0ms |
| array/push-pop | 774.2ms | 907.7ms | — |
| array/sort-i32 | 945.7ms | 1029.9ms | — |
| array/map-filter | 945.0ms | 1036.9ms | — |
| array/reduce | 884.2ms | 961.8ms | — |
| array/indexOf | 839.6ms | 972.0ms | — |
| array/slice | 796.4ms | 897.0ms | — |
| array/reverse | 751.6ms | 873.6ms | — |
| array/forEach | 893.5ms | 1000.4ms | — |
| array/find | 762.5ms | 862.0ms | 810.3ms |
| dom/create-elements | 700.4ms | — | — |
| dom/set-attributes | 723.0ms | — | — |
| dom/read-attributes | 690.0ms | — | — |
| dom/modify-text | 673.8ms | — | — |
| mixed/csv-parse | 813.2ms | 978.3ms | — |
| mixed/text-search | 807.2ms | 963.3ms | 915.4ms |
| mixed/fibonacci | 769.3ms | 821.4ms | 759.7ms |
| mixed/matrix-multiply | 892.8ms | 957.0ms | 822.0ms |
| mixed/sieve | 889.5ms | 936.6ms | — |
