# js2wasm Benchmark Results

Date: 2026-09-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.049ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.134ms | 0.015ms | 0.021ms | gc-native |
| string/split | 0.429ms | 8.44ms | 2.76ms | FAILED | js |
| string/replace | 0.104ms | 0.687ms | 0.319ms | FAILED | js |
| string/case-convert | 0.056ms | 0.594ms | 0.254ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.98ms | 2.68ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.90ms | 3.01ms | 0.560ms | js |
| array/push-pop | 1.45ms | 0.515ms | 0.513ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.294ms | 0.372ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.503ms | 0.503ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.65ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.087ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.590ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.030ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.65ms | 0.620ms | FAILED | js |
| mixed/text-search | 0.392ms | 5.07ms | 2.78ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 71.75ms | 71.84ms | 0.722ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.52 | 4.91 | 4.33 | — |
| string/concat-long | 1000 | 3.61 | 4.64 | 3.86 | — |
| string/indexOf | 1000 | 19.19 | 65.31 | 12.41 | 14.65 |
| string/includes | 1000 | 19.21 | 134.24 | 14.55 | 21.05 |
| string/split | 10000 | 42.92 | 843.57 | 276.18 | — |
| string/replace | 1000 | 103.73 | 686.62 | 319.22 | — |
| string/case-convert | 2000 | 27.82 | 297.07 | 126.89 | — |
| string/substring | 10000 | 9.86 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.00 | 397.77 | 268.22 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 144.99 | 150.40 | 28.01 |
| array/map-filter | 30000 | 4.30 | 2.36 | 2.37 | — |
| array/indexOf | 1000 | 3949.74 | 2646.51 | 2645.29 | — |
| dom/create-elements | 2000 | 17.54 | 77.69 | — | — |
| dom/set-attributes | 6000 | 17.60 | 98.39 | — | — |
| dom/read-attributes | 3000 | 18.64 | 40.40 | — | — |
| dom/modify-text | 2000 | 14.78 | 53.69 | — | — |
| mixed/csv-parse | 11000 | 44.22 | 786.32 | 56.39 | — |
| mixed/text-search | 40000 | 9.79 | 126.72 | 69.60 | 27.30 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 574.02 | 574.75 | 5.77 |
| mixed/sieve | 200000 | 7.78 | 10.54 | 10.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.23x slower | — |
| string/concat-long | 1.28x slower | 1.07x slower | — |
| string/indexOf | 3.40x slower | 1.55x faster | 1.31x faster |
| string/includes | 6.99x slower | 1.32x faster | 1.10x slower |
| string/split | 19.65x slower | 6.43x slower | — |
| string/replace | 6.62x slower | 3.08x slower | — |
| string/case-convert | 10.68x slower | 4.56x slower | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 23.40x slower | 15.78x slower | — |
| string/startsWith-endsWith | 7.23x slower | 7.50x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.82x faster | — |
| array/sort-i32 | 2.69x faster | 2.13x faster | — |
| array/map-filter | 1.82x faster | 1.81x faster | — |
| array/reduce | 4.27x faster | 4.27x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.09x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.08x faster | 3.10x faster | — |
| array/find | 15.66x faster | 16.03x faster | 4.23x slower |
| dom/create-elements | 4.43x slower | — | — |
| dom/set-attributes | 5.59x slower | — | — |
| dom/read-attributes | 2.17x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 17.78x slower | 1.28x slower | — |
| mixed/text-search | 12.94x slower | 7.11x slower | 2.79x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 455.10x slower | 455.68x slower | 4.58x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.26x faster |
| string/includes | 9.23x faster |
| string/split | 3.05x faster |
| string/replace | 2.15x faster |
| string/case-convert | 2.34x faster |
| string/substring | 1.22x faster |
| string/trim | 1.48x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.27x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 13.94x faster |
| mixed/text-search | 1.82x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 980B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.2KB | 10.4KB |
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
| array/indexOf | 1.8KB | 2.2KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.1KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1743.7ms | 1109.0ms | — |
| string/concat-long | 785.5ms | 1022.7ms | — |
| string/indexOf | 702.8ms | 1007.9ms | 870.1ms |
| string/includes | 680.7ms | 1016.8ms | 863.2ms |
| string/split | 793.9ms | 1048.5ms | — |
| string/replace | 812.0ms | 1076.0ms | — |
| string/case-convert | 802.9ms | 906.2ms | — |
| string/substring | 681.7ms | 827.6ms | — |
| string/trim | 778.6ms | 1001.3ms | — |
| string/startsWith-endsWith | 776.1ms | 1006.1ms | 906.2ms |
| array/push-pop | 813.4ms | 879.8ms | — |
| array/sort-i32 | 974.9ms | 1022.9ms | — |
| array/map-filter | 978.8ms | 1046.4ms | — |
| array/reduce | 901.5ms | 1006.4ms | — |
| array/indexOf | 871.0ms | 1006.6ms | — |
| array/slice | 820.5ms | 898.3ms | — |
| array/reverse | 798.6ms | 915.6ms | — |
| array/forEach | 904.0ms | 1037.0ms | — |
| array/find | 793.8ms | 884.4ms | 836.6ms |
| dom/create-elements | 705.7ms | — | — |
| dom/set-attributes | 719.7ms | — | — |
| dom/read-attributes | 700.3ms | — | — |
| dom/modify-text | 693.0ms | — | — |
| mixed/csv-parse | 810.9ms | 1010.4ms | — |
| mixed/text-search | 768.5ms | 979.9ms | 915.0ms |
| mixed/fibonacci | 743.1ms | 803.0ms | 768.5ms |
| mixed/matrix-multiply | 905.8ms | 979.7ms | 826.7ms |
| mixed/sieve | 872.2ms | 924.7ms | — |
