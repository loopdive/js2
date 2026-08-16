# js2wasm Benchmark Results

Date: 2026-08-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.045ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.062ms | 0.012ms | 0.021ms | gc-native |
| string/includes | 0.019ms | 0.130ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.415ms | 5.09ms | 0.449ms | FAILED | js |
| string/replace | 0.117ms | 0.307ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.055ms | 0.234ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.996ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.296ms | 0.563ms | gc-native |
| array/push-pop | 1.40ms | 0.503ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.297ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.126ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.505ms | 0.502ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.024ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.027ms | FAILED | gc-native |
| array/find | 0.234ms | 0.015ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.037ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.563ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.479ms | 7.18ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.68ms | 0.266ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.719ms | js |
| mixed/sieve | 1.58ms | 1.41ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.78 | 4.50 | 3.85 | — |
| string/concat-long | 1000 | 3.48 | 4.48 | 3.70 | — |
| string/indexOf | 1000 | 19.13 | 62.47 | 12.27 | 20.94 |
| string/includes | 1000 | 19.18 | 129.54 | 14.71 | 71.22 |
| string/split | 10000 | 41.47 | 509.12 | 44.86 | — |
| string/replace | 1000 | 116.73 | 307.34 | 56.14 | — |
| string/case-convert | 2000 | 27.75 | 116.78 | 2.51 | — |
| string/substring | 10000 | 9.85 | 3.76 | 3.08 | — |
| string/trim | 10000 | 16.95 | 99.58 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 17.83 | 14.79 | 28.13 |
| array/map-filter | 30000 | 4.19 | 2.33 | 2.31 | — |
| array/indexOf | 1000 | 3956.85 | 2634.61 | 2634.92 | — |
| dom/create-elements | 2000 | 18.72 | 77.29 | — | — |
| dom/set-attributes | 6000 | 17.41 | 93.84 | — | — |
| dom/read-attributes | 3000 | 18.96 | 40.80 | — | — |
| dom/modify-text | 2000 | 14.31 | 53.39 | — | — |
| mixed/csv-parse | 11000 | 43.59 | 652.46 | 28.69 | — |
| mixed/text-search | 40000 | 9.71 | 42.03 | 6.65 | 27.45 |
| mixed/fibonacci | 10000 | 12.17 | 29.18 | 29.20 | 28.69 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 7.91 | 7.04 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.62x slower | 1.38x slower | — |
| string/concat-long | 1.29x slower | 1.06x slower | — |
| string/indexOf | 3.27x slower | 1.56x faster | 1.09x slower |
| string/includes | 6.75x slower | 1.30x faster | 3.71x slower |
| string/split | 12.28x slower | 1.08x slower | — |
| string/replace | 2.63x slower | 2.08x faster | — |
| string/case-convert | 4.21x slower | 11.07x faster | — |
| string/substring | 2.62x faster | 3.20x faster | — |
| string/trim | 5.88x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.78x faster | 2.79x faster | — |
| array/sort-i32 | 2.67x faster | 2.70x faster | — |
| array/map-filter | 1.80x faster | 1.81x faster | — |
| array/reduce | 4.24x faster | 4.26x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.10x slower | 1.12x slower | — |
| array/reverse | 2.22x faster | 2.21x faster | — |
| array/forEach | 1.75x faster | 1.76x faster | — |
| array/find | 15.18x faster | 15.02x faster | 4.61x slower |
| dom/create-elements | 4.13x slower | — | — |
| dom/set-attributes | 5.39x slower | — | — |
| dom/read-attributes | 2.15x slower | — | — |
| dom/modify-text | 3.73x slower | — | — |
| mixed/csv-parse | 14.97x slower | 1.52x faster | — |
| mixed/text-search | 4.33x slower | 1.46x faster | 2.83x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.36x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.57x slower |
| mixed/sieve | 1.12x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.09x faster |
| string/includes | 8.81x faster |
| string/split | 11.35x faster |
| string/replace | 5.47x faster |
| string/case-convert | 46.58x faster |
| string/substring | 1.22x faster |
| string/trim | 5.34x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.75x faster |
| mixed/text-search | 6.32x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
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
| string/concat-short | 1285.1ms | 1061.4ms | — |
| string/concat-long | 647.8ms | 944.4ms | — |
| string/indexOf | 654.0ms | 949.7ms | 829.1ms |
| string/includes | 645.2ms | 971.0ms | 818.9ms |
| string/split | 803.9ms | 973.5ms | — |
| string/replace | 766.3ms | 1046.3ms | — |
| string/case-convert | 771.1ms | 843.3ms | — |
| string/substring | 652.5ms | 750.1ms | — |
| string/trim | 739.9ms | 963.2ms | — |
| string/startsWith-endsWith | 756.3ms | 933.7ms | 901.3ms |
| array/push-pop | 741.8ms | 859.4ms | — |
| array/sort-i32 | 878.5ms | 981.9ms | — |
| array/map-filter | 939.3ms | 975.8ms | — |
| array/reduce | 822.3ms | 902.7ms | — |
| array/indexOf | 852.0ms | 912.0ms | — |
| array/slice | 756.1ms | 833.0ms | — |
| array/reverse | 752.3ms | 830.4ms | — |
| array/forEach | 865.9ms | 924.7ms | — |
| array/find | 738.7ms | 833.7ms | 825.1ms |
| dom/create-elements | 612.6ms | — | — |
| dom/set-attributes | 676.6ms | — | — |
| dom/read-attributes | 701.2ms | — | — |
| dom/modify-text | 599.1ms | — | — |
| mixed/csv-parse | 802.7ms | 960.3ms | — |
| mixed/text-search | 802.9ms | 986.6ms | 938.8ms |
| mixed/fibonacci | 751.0ms | 813.3ms | 765.9ms |
| mixed/matrix-multiply | 858.3ms | 937.5ms | 787.4ms |
| mixed/sieve | 820.1ms | 905.3ms | — |
