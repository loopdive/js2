# js2wasm Benchmark Results

Date: 2026-08-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.424ms | 5.05ms | 0.449ms | FAILED | js |
| string/replace | 0.103ms | 0.289ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.055ms | 0.228ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.101ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.888ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.357ms | 0.298ms | 0.563ms | gc-native |
| array/push-pop | 1.38ms | 0.497ms | 0.492ms | FAILED | gc-native |
| array/sort-i32 | 0.786ms | 0.293ms | 0.296ms | FAILED | host-call |
| array/map-filter | 0.070ms | 0.069ms | 0.069ms | FAILED | host-call |
| array/reduce | 2.10ms | 0.493ms | 0.496ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.085ms | 0.028ms | 0.027ms | FAILED | gc-native |
| array/find | 0.252ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.040ms | 0.167ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.554ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.484ms | 7.06ms | 0.313ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.67ms | 0.263ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.119ms | 0.293ms | 0.292ms | 0.290ms | js |
| mixed/matrix-multiply | 0.157ms | 0.209ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.57ms | 1.39ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.36 | 4.46 | 3.68 | — |
| string/concat-long | 1000 | 3.53 | 4.47 | 3.49 | — |
| string/indexOf | 1000 | 19.11 | 62.56 | 11.92 | 14.64 |
| string/includes | 1000 | 19.14 | 50.59 | 15.33 | 15.37 |
| string/split | 10000 | 42.35 | 504.54 | 44.85 | — |
| string/replace | 1000 | 103.08 | 289.24 | 71.03 | — |
| string/case-convert | 2000 | 27.74 | 114.11 | 2.51 | — |
| string/substring | 10000 | 10.14 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.94 | 88.82 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 17.84 | 14.92 | 28.14 |
| array/map-filter | 30000 | 2.34 | 2.31 | 2.31 | — |
| array/indexOf | 1000 | 3948.17 | 2632.75 | 2634.72 | — |
| dom/create-elements | 2000 | 19.85 | 83.44 | — | — |
| dom/set-attributes | 6000 | 16.92 | 92.31 | — | — |
| dom/read-attributes | 3000 | 18.58 | 40.47 | — | — |
| dom/modify-text | 2000 | 14.28 | 54.84 | — | — |
| mixed/csv-parse | 11000 | 44.03 | 641.73 | 28.42 | — |
| mixed/text-search | 40000 | 9.72 | 41.76 | 6.58 | 27.31 |
| mixed/fibonacci | 10000 | 11.86 | 29.30 | 29.25 | 29.02 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 7.84 | 6.97 | 6.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.33x slower | 1.10x slower | — |
| string/concat-long | 1.26x slower | 1.01x faster | — |
| string/indexOf | 3.27x slower | 1.60x faster | 1.30x faster |
| string/includes | 2.64x slower | 1.25x faster | 1.25x faster |
| string/split | 11.91x slower | 1.06x slower | — |
| string/replace | 2.81x slower | 1.45x faster | — |
| string/case-convert | 4.11x slower | 11.07x faster | — |
| string/substring | 2.71x faster | 3.30x faster | — |
| string/trim | 5.24x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.13x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.78x faster | 2.81x faster | — |
| array/sort-i32 | 2.68x faster | 2.66x faster | — |
| array/map-filter | 1.01x faster | 1.01x faster | — |
| array/reduce | 4.26x faster | 4.24x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.09x faster | 3.12x faster | — |
| array/find | 16.02x faster | 16.13x faster | 4.27x slower |
| dom/create-elements | 4.20x slower | — | — |
| dom/set-attributes | 5.46x slower | — | — |
| dom/read-attributes | 2.18x slower | — | — |
| dom/modify-text | 3.84x slower | — | — |
| mixed/csv-parse | 14.58x slower | 1.55x faster | — |
| mixed/text-search | 4.29x slower | 1.48x faster | 2.81x slower |
| mixed/fibonacci | 2.47x slower | 2.47x slower | 2.45x slower |
| mixed/matrix-multiply | 1.33x slower | 1.34x slower | 4.56x slower |
| mixed/sieve | 1.12x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.25x faster |
| string/includes | 3.30x faster |
| string/split | 11.25x faster |
| string/replace | 4.07x faster |
| string/case-convert | 45.55x faster |
| string/substring | 1.22x faster |
| string/trim | 4.77x faster |
| string/startsWith-endsWith | 1.20x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.58x faster |
| mixed/text-search | 6.34x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.6KB | 3.9KB | — |
| string/case-convert | 1.4KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.8KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.6KB | 1.9KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 405B | 405B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1292.1ms | 1116.0ms | — |
| string/concat-long | 601.6ms | 956.4ms | — |
| string/indexOf | 624.7ms | 974.5ms | 817.2ms |
| string/includes | 635.4ms | 990.3ms | 823.7ms |
| string/split | 739.4ms | 962.7ms | — |
| string/replace | 760.0ms | 1072.0ms | — |
| string/case-convert | 765.9ms | 845.4ms | — |
| string/substring | 624.4ms | 716.6ms | — |
| string/trim | 733.0ms | 942.1ms | — |
| string/startsWith-endsWith | 782.5ms | 964.2ms | 883.2ms |
| array/push-pop | 745.1ms | 818.7ms | — |
| array/sort-i32 | 860.0ms | 914.8ms | — |
| array/map-filter | 916.5ms | 1015.5ms | — |
| array/reduce | 804.6ms | 861.2ms | — |
| array/indexOf | 805.5ms | 862.4ms | — |
| array/slice | 767.1ms | 820.1ms | — |
| array/reverse | 746.2ms | 782.8ms | — |
| array/forEach | 844.0ms | 923.4ms | — |
| array/find | 757.1ms | 828.7ms | 806.6ms |
| dom/create-elements | 619.3ms | — | — |
| dom/set-attributes | 717.1ms | — | — |
| dom/read-attributes | 674.1ms | — | — |
| dom/modify-text | 618.6ms | — | — |
| mixed/csv-parse | 781.9ms | 982.8ms | — |
| mixed/text-search | 744.6ms | 1005.4ms | 889.9ms |
| mixed/fibonacci | 824.4ms | 902.5ms | 798.7ms |
| mixed/matrix-multiply | 843.9ms | 879.5ms | 811.5ms |
| mixed/sieve | 826.4ms | 872.8ms | — |
