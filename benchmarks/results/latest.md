# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.045ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.020ms | gc-native |
| string/includes | 0.019ms | 0.047ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.424ms | 4.86ms | 0.452ms | FAILED | js |
| string/replace | 0.109ms | 0.299ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.231ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.890ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.296ms | 0.561ms | gc-native |
| array/push-pop | 1.40ms | 0.507ms | 0.502ms | FAILED | gc-native |
| array/sort-i32 | 0.796ms | 0.293ms | 0.295ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.501ms | 0.503ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.015ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.153ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.501ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.136ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.488ms | 7.18ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.67ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.293ms | 0.292ms | 0.291ms | js |
| mixed/matrix-multiply | 0.158ms | 0.209ms | 0.210ms | 0.715ms | js |
| mixed/sieve | 1.54ms | 1.40ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.84 | 4.47 | 3.83 | — |
| string/concat-long | 1000 | 3.58 | 4.49 | 3.69 | — |
| string/indexOf | 1000 | 19.13 | 64.91 | 12.17 | 19.80 |
| string/includes | 1000 | 19.19 | 46.81 | 14.70 | 15.95 |
| string/split | 10000 | 42.43 | 485.74 | 45.16 | — |
| string/replace | 1000 | 109.48 | 298.99 | 56.37 | — |
| string/case-convert | 2000 | 29.13 | 115.67 | 2.50 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.96 | 88.96 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 17.87 | 14.78 | 28.04 |
| array/map-filter | 30000 | 4.25 | 2.33 | 2.32 | — |
| array/indexOf | 1000 | 3951.20 | 2633.28 | 2632.46 | — |
| dom/create-elements | 2000 | 17.52 | 76.72 | — | — |
| dom/set-attributes | 6000 | 17.13 | 83.57 | — | — |
| dom/read-attributes | 3000 | 18.18 | 45.44 | — | — |
| dom/modify-text | 2000 | 14.63 | 54.20 | — | — |
| mixed/csv-parse | 11000 | 44.35 | 652.90 | 28.55 | — |
| mixed/text-search | 40000 | 9.72 | 41.78 | 6.64 | 26.92 |
| mixed/fibonacci | 10000 | 12.18 | 29.32 | 29.24 | 29.06 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.68 | 1.68 | 5.72 |
| mixed/sieve | 200000 | 7.71 | 7.01 | 7.00 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.57x slower | 1.35x slower | — |
| string/concat-long | 1.26x slower | 1.03x slower | — |
| string/indexOf | 3.39x slower | 1.57x faster | 1.03x slower |
| string/includes | 2.44x slower | 1.30x faster | 1.20x faster |
| string/split | 11.45x slower | 1.06x slower | — |
| string/replace | 2.73x slower | 1.94x faster | — |
| string/case-convert | 3.97x slower | 11.64x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.25x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.77x faster | 2.79x faster | — |
| array/sort-i32 | 2.72x faster | 2.69x faster | — |
| array/map-filter | 1.82x faster | 1.83x faster | — |
| array/reduce | 4.26x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 16.41x faster | 16.19x faster | 4.24x slower |
| dom/create-elements | 4.38x slower | — | — |
| dom/set-attributes | 4.88x slower | — | — |
| dom/read-attributes | 2.50x slower | — | — |
| dom/modify-text | 3.71x slower | — | — |
| mixed/csv-parse | 14.72x slower | 1.55x faster | — |
| mixed/text-search | 4.30x slower | 1.46x faster | 2.77x slower |
| mixed/fibonacci | 2.41x slower | 2.40x slower | 2.39x slower |
| mixed/matrix-multiply | 1.32x slower | 1.32x slower | 4.52x slower |
| mixed/sieve | 1.10x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.33x faster |
| string/includes | 3.18x faster |
| string/split | 10.76x faster |
| string/replace | 5.30x faster |
| string/case-convert | 46.21x faster |
| string/substring | 1.22x faster |
| string/trim | 4.77x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.87x faster |
| mixed/text-search | 6.29x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1327.1ms | 1092.7ms | — |
| string/concat-long | 651.0ms | 933.7ms | — |
| string/indexOf | 676.9ms | 944.8ms | 890.7ms |
| string/includes | 663.1ms | 968.7ms | 851.1ms |
| string/split | 791.1ms | 953.2ms | — |
| string/replace | 766.2ms | 1056.2ms | — |
| string/case-convert | 759.2ms | 909.3ms | — |
| string/substring | 663.6ms | 766.3ms | — |
| string/trim | 752.2ms | 960.8ms | — |
| string/startsWith-endsWith | 767.5ms | 969.6ms | 891.7ms |
| array/push-pop | 805.6ms | 835.8ms | — |
| array/sort-i32 | 906.9ms | 986.5ms | — |
| array/map-filter | 906.9ms | 1005.8ms | — |
| array/reduce | 840.6ms | 912.0ms | — |
| array/indexOf | 856.1ms | 908.9ms | — |
| array/slice | 761.0ms | 825.4ms | — |
| array/reverse | 743.8ms | 818.5ms | — |
| array/forEach | 835.2ms | 922.9ms | — |
| array/find | 730.3ms | 838.6ms | 838.8ms |
| dom/create-elements | 610.6ms | — | — |
| dom/set-attributes | 688.0ms | — | — |
| dom/read-attributes | 688.9ms | — | — |
| dom/modify-text | 601.1ms | — | — |
| mixed/csv-parse | 797.9ms | 918.8ms | — |
| mixed/text-search | 782.2ms | 1032.0ms | 894.4ms |
| mixed/fibonacci | 757.5ms | 833.4ms | 784.2ms |
| mixed/matrix-multiply | 860.6ms | 913.2ms | 808.1ms |
| mixed/sieve | 857.9ms | 957.7ms | — |
