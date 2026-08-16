# js2wasm Benchmark Results

Date: 2026-08-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.046ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.062ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.014ms | 0.021ms | gc-native |
| string/split | 0.412ms | 4.94ms | 0.448ms | FAILED | js |
| string/replace | 0.109ms | 0.298ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.055ms | 0.239ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.893ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.296ms | 0.563ms | gc-native |
| array/push-pop | 1.39ms | 0.490ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.295ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.070ms | 0.069ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.12ms | 0.496ms | 0.501ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.015ms | 0.992ms | gc-native |
| dom/create-elements | 0.230ms | 0.162ms | — | — | host-call |
| dom/set-attributes | 0.104ms | 0.500ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.122ms | — | — | js |
| dom/modify-text | 0.030ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.488ms | 7.06ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.74ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.712ms | js |
| mixed/sieve | 1.52ms | 1.38ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.01 | 4.60 | 3.69 | — |
| string/concat-long | 1000 | 3.54 | 4.55 | 3.47 | — |
| string/indexOf | 1000 | 19.12 | 62.48 | 11.90 | 14.56 |
| string/includes | 1000 | 19.16 | 50.55 | 14.48 | 20.87 |
| string/split | 10000 | 41.15 | 493.55 | 44.80 | — |
| string/replace | 1000 | 108.62 | 298.12 | 56.17 | — |
| string/case-convert | 2000 | 27.73 | 119.68 | 2.50 | — |
| string/substring | 10000 | 9.83 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.96 | 89.35 | 18.65 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 17.84 | 14.78 | 28.13 |
| array/map-filter | 30000 | 2.33 | 2.30 | 2.29 | — |
| array/indexOf | 1000 | 3946.02 | 2633.47 | 2632.44 | — |
| dom/create-elements | 2000 | 115.14 | 81.02 | — | — |
| dom/set-attributes | 6000 | 17.39 | 83.31 | — | — |
| dom/read-attributes | 3000 | 19.68 | 40.72 | — | — |
| dom/modify-text | 2000 | 14.95 | 53.75 | — | — |
| mixed/csv-parse | 11000 | 44.38 | 642.17 | 28.70 | — |
| mixed/text-search | 40000 | 9.76 | 43.54 | 6.64 | 27.11 |
| mixed/fibonacci | 10000 | 12.18 | 29.19 | 29.17 | 28.66 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.69 |
| mixed/sieve | 200000 | 7.59 | 6.91 | 6.94 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.22x slower | — |
| string/concat-long | 1.28x slower | 1.02x faster | — |
| string/indexOf | 3.27x slower | 1.61x faster | 1.31x faster |
| string/includes | 2.64x slower | 1.32x faster | 1.09x slower |
| string/split | 11.99x slower | 1.09x slower | — |
| string/replace | 2.74x slower | 1.93x faster | — |
| string/case-convert | 4.32x slower | 11.07x faster | — |
| string/substring | 2.61x faster | 3.20x faster | — |
| string/trim | 5.27x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.83x faster | 2.77x faster | — |
| array/sort-i32 | 2.69x faster | 2.71x faster | — |
| array/map-filter | 1.02x faster | 1.02x faster | — |
| array/reduce | 4.27x faster | 4.23x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.73x faster | 1.74x faster | — |
| array/find | 16.25x faster | 16.48x faster | 3.90x slower |
| dom/create-elements | 1.42x faster | — | — |
| dom/set-attributes | 4.79x slower | — | — |
| dom/read-attributes | 2.07x slower | — | — |
| dom/modify-text | 3.60x slower | — | — |
| mixed/csv-parse | 14.47x slower | 1.55x faster | — |
| mixed/text-search | 4.46x slower | 1.47x faster | 2.78x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.52x slower |
| mixed/sieve | 1.10x faster | 1.09x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.25x faster |
| string/concat-long | 1.31x faster |
| string/indexOf | 5.25x faster |
| string/includes | 3.49x faster |
| string/split | 11.02x faster |
| string/replace | 5.31x faster |
| string/case-convert | 47.78x faster |
| string/substring | 1.22x faster |
| string/trim | 4.79x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.37x faster |
| mixed/text-search | 6.56x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1272.6ms | 1074.9ms | — |
| string/concat-long | 624.3ms | 933.7ms | — |
| string/indexOf | 628.5ms | 937.2ms | 801.2ms |
| string/includes | 648.6ms | 951.9ms | 832.9ms |
| string/split | 781.7ms | 944.0ms | — |
| string/replace | 749.6ms | 1007.0ms | — |
| string/case-convert | 757.4ms | 845.5ms | — |
| string/substring | 623.7ms | 726.5ms | — |
| string/trim | 733.1ms | 904.5ms | — |
| string/startsWith-endsWith | 732.7ms | 964.5ms | 895.3ms |
| array/push-pop | 768.1ms | 851.0ms | — |
| array/sort-i32 | 885.8ms | 955.5ms | — |
| array/map-filter | 888.1ms | 1015.1ms | — |
| array/reduce | 815.0ms | 907.4ms | — |
| array/indexOf | 879.9ms | 906.5ms | — |
| array/slice | 741.3ms | 828.1ms | — |
| array/reverse | 747.9ms | 795.8ms | — |
| array/forEach | 832.9ms | 944.1ms | — |
| array/find | 744.7ms | 827.8ms | 831.0ms |
| dom/create-elements | 641.7ms | — | — |
| dom/set-attributes | 702.9ms | — | — |
| dom/read-attributes | 688.5ms | — | — |
| dom/modify-text | 604.7ms | — | — |
| mixed/csv-parse | 793.1ms | 928.6ms | — |
| mixed/text-search | 766.0ms | 964.9ms | 865.9ms |
| mixed/fibonacci | 729.6ms | 757.1ms | 770.7ms |
| mixed/matrix-multiply | 857.4ms | 942.2ms | 778.8ms |
| mixed/sieve | 818.3ms | 869.3ms | — |
