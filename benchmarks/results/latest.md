# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.050ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.131ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.425ms | 5.09ms | 0.448ms | FAILED | js |
| string/replace | 0.108ms | 0.302ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.239ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.921ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.358ms | 0.295ms | 0.560ms | gc-native |
| array/push-pop | 1.39ms | 0.500ms | 0.500ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.293ms | 0.297ms | FAILED | host-call |
| array/map-filter | 0.070ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.500ms | 0.500ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.085ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.015ms | 0.995ms | gc-native |
| dom/create-elements | 0.224ms | FAILED | — | — | js |
| dom/set-attributes | 0.106ms | FAILED | — | — | js |
| dom/read-attributes | 0.055ms | FAILED | — | — | js |
| dom/modify-text | 0.031ms | FAILED | — | — | js |
| mixed/csv-parse | 0.476ms | 7.85ms | 0.317ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.86ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.293ms | 0.287ms | js |
| mixed/matrix-multiply | 0.163ms | 0.214ms | 0.212ms | 0.716ms | js |
| mixed/sieve | 1.54ms | 1.40ms | 1.38ms | FAILED | gc-native |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.10 | 5.03 | 3.71 | — |
| string/concat-long | 1000 | 3.57 | 4.54 | 3.55 | — |
| string/indexOf | 1000 | 19.15 | 62.56 | 12.33 | 15.25 |
| string/includes | 1000 | 19.17 | 130.53 | 14.68 | 15.37 |
| string/split | 10000 | 42.48 | 508.70 | 44.84 | — |
| string/replace | 1000 | 108.07 | 301.94 | 56.32 | — |
| string/case-convert | 2000 | 27.81 | 119.45 | 2.50 | — |
| string/substring | 10000 | 9.85 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.96 | 92.12 | 18.62 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 17.89 | 14.77 | 28.01 |
| array/map-filter | 30000 | 2.33 | 2.32 | 2.31 | — |
| array/indexOf | 1000 | 3948.71 | 2633.18 | 2633.85 | — |
| dom/create-elements | 2000 | 111.91 | — | — | — |
| dom/set-attributes | 6000 | 17.65 | — | — | — |
| dom/read-attributes | 3000 | 18.44 | — | — | — |
| dom/modify-text | 2000 | 15.27 | — | — | — |
| mixed/csv-parse | 11000 | 43.32 | 713.30 | 28.84 | — |
| mixed/text-search | 40000 | 9.70 | 46.46 | 6.66 | 27.23 |
| mixed/fibonacci | 10000 | 12.18 | 29.17 | 29.25 | 28.66 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.71 | 1.70 | 5.73 |
| mixed/sieve | 200000 | 7.68 | 7.00 | 6.92 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.62x slower | 1.20x slower | — |
| string/concat-long | 1.27x slower | 1.01x faster | — |
| string/indexOf | 3.27x slower | 1.55x faster | 1.26x faster |
| string/includes | 6.81x slower | 1.31x faster | 1.25x faster |
| string/split | 11.98x slower | 1.06x slower | — |
| string/replace | 2.79x slower | 1.92x faster | — |
| string/case-convert | 4.30x slower | 11.11x faster | — |
| string/substring | 2.62x faster | 3.21x faster | — |
| string/trim | 5.43x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.78x faster | 2.78x faster | — |
| array/sort-i32 | 2.69x faster | 2.65x faster | — |
| array/map-filter | 1.01x faster | 1.01x faster | — |
| array/reduce | 4.28x faster | 4.27x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.09x faster | 3.09x faster | — |
| array/find | 15.99x faster | 16.38x faster | 3.94x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 16.47x slower | 1.50x faster | — |
| mixed/text-search | 4.79x slower | 1.46x faster | 2.81x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.32x slower | 1.30x slower | 4.40x slower |
| mixed/sieve | 1.10x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.35x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.08x faster |
| string/includes | 8.89x faster |
| string/split | 11.35x faster |
| string/replace | 5.36x faster |
| string/case-convert | 47.74x faster |
| string/substring | 1.22x faster |
| string/trim | 4.95x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 24.74x faster |
| mixed/text-search | 6.98x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1302.1ms | 1071.7ms | — |
| string/concat-long | 631.4ms | 941.4ms | — |
| string/indexOf | 653.1ms | 938.3ms | 864.8ms |
| string/includes | 642.3ms | 958.3ms | 822.7ms |
| string/split | 748.3ms | 1026.1ms | — |
| string/replace | 805.9ms | 1043.6ms | — |
| string/case-convert | 769.8ms | 824.1ms | — |
| string/substring | 631.6ms | 730.1ms | — |
| string/trim | 737.5ms | 966.0ms | — |
| string/startsWith-endsWith | 748.6ms | 945.5ms | 878.4ms |
| array/push-pop | 778.3ms | 853.5ms | — |
| array/sort-i32 | 923.2ms | 959.1ms | — |
| array/map-filter | 936.2ms | 995.5ms | — |
| array/reduce | 824.9ms | 920.2ms | — |
| array/indexOf | 836.5ms | 886.2ms | — |
| array/slice | 753.5ms | 828.5ms | — |
| array/reverse | 764.5ms | 822.3ms | — |
| array/forEach | 841.7ms | 984.2ms | — |
| array/find | 743.4ms | 831.7ms | 815.2ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 814.5ms | 911.6ms | — |
| mixed/text-search | 765.7ms | 961.1ms | 875.0ms |
| mixed/fibonacci | 739.9ms | 780.5ms | 770.6ms |
| mixed/matrix-multiply | 855.6ms | 900.6ms | 772.6ms |
| mixed/sieve | 831.9ms | 881.9ms | — |
