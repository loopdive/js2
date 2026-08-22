# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.046ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.019ms | gc-native |
| string/includes | 0.019ms | 0.134ms | 0.015ms | 0.018ms | gc-native |
| string/split | 0.425ms | 4.94ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.298ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.255ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.899ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.300ms | 0.561ms | gc-native |
| array/push-pop | 1.43ms | 0.519ms | 0.511ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.294ms | 0.314ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.508ms | 0.508ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.067ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.042ms | 0.162ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.482ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.124ms | — | — | js |
| dom/modify-text | 0.030ms | 0.127ms | — | — | js |
| mixed/csv-parse | 0.477ms | 7.39ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.60ms | 0.266ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 1.18ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.720ms | js |
| mixed/sieve | 1.55ms | 1.42ms | 1.44ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.18 | 4.59 | 3.88 | — |
| string/concat-long | 1000 | 3.58 | 4.53 | 3.65 | — |
| string/indexOf | 1000 | 19.19 | 62.57 | 12.38 | 19.18 |
| string/includes | 1000 | 19.23 | 133.67 | 14.94 | 18.19 |
| string/split | 10000 | 42.54 | 493.56 | 44.90 | — |
| string/replace | 1000 | 103.63 | 298.50 | 56.36 | — |
| string/case-convert | 2000 | 27.93 | 127.50 | 2.52 | — |
| string/substring | 10000 | 9.87 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.06 | 89.86 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 17.85 | 14.99 | 28.06 |
| array/map-filter | 30000 | 4.26 | 2.36 | 2.36 | — |
| array/indexOf | 1000 | 3955.16 | 2636.21 | 2635.44 | — |
| dom/create-elements | 2000 | 21.10 | 80.90 | — | — |
| dom/set-attributes | 6000 | 17.64 | 80.27 | — | — |
| dom/read-attributes | 3000 | 18.33 | 41.23 | — | — |
| dom/modify-text | 2000 | 15.12 | 63.62 | — | — |
| mixed/csv-parse | 11000 | 43.36 | 671.85 | 28.67 | — |
| mixed/text-search | 40000 | 9.72 | 39.99 | 6.64 | 28.18 |
| mixed/fibonacci | 10000 | 12.18 | 29.15 | 29.16 | 118.03 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.68 | 1.68 | 5.76 |
| mixed/sieve | 200000 | 7.74 | 7.08 | 7.22 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.22x slower | — |
| string/concat-long | 1.26x slower | 1.02x slower | — |
| string/indexOf | 3.26x slower | 1.55x faster | 1.00x faster |
| string/includes | 6.95x slower | 1.29x faster | 1.06x faster |
| string/split | 11.60x slower | 1.06x slower | — |
| string/replace | 2.88x slower | 1.84x faster | — |
| string/case-convert | 4.57x slower | 11.09x faster | — |
| string/substring | 2.62x faster | 3.22x faster | — |
| string/trim | 5.27x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.34x faster | 1.40x slower |
| array/push-pop | 2.76x faster | 2.80x faster | — |
| array/sort-i32 | 2.69x faster | 2.52x faster | — |
| array/map-filter | 1.80x faster | 1.80x faster | — |
| array/reduce | 4.24x faster | 4.24x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.04x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.39x faster | 2.39x faster | — |
| array/find | 15.80x faster | 15.96x faster | 4.25x slower |
| dom/create-elements | 3.83x slower | — | — |
| dom/set-attributes | 4.55x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 4.21x slower | — | — |
| mixed/csv-parse | 15.50x slower | 1.51x faster | — |
| mixed/text-search | 4.11x slower | 1.46x faster | 2.90x slower |
| mixed/fibonacci | 2.39x slower | 2.39x slower | 9.69x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.55x slower |
| mixed/sieve | 1.09x faster | 1.07x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.06x faster |
| string/includes | 8.95x faster |
| string/split | 10.99x faster |
| string/replace | 5.30x faster |
| string/case-convert | 50.64x faster |
| string/substring | 1.23x faster |
| string/trim | 4.82x faster |
| string/startsWith-endsWith | 1.19x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.07x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 23.43x faster |
| mixed/text-search | 6.02x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.02x slower |

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
| string/concat-short | 1423.3ms | 1117.1ms | — |
| string/concat-long | 658.6ms | 963.4ms | — |
| string/indexOf | 677.3ms | 985.1ms | 876.9ms |
| string/includes | 696.2ms | 981.0ms | 861.1ms |
| string/split | 816.3ms | 1029.1ms | — |
| string/replace | 800.1ms | 1064.3ms | — |
| string/case-convert | 827.6ms | 910.5ms | — |
| string/substring | 678.7ms | 793.0ms | — |
| string/trim | 742.6ms | 946.9ms | — |
| string/startsWith-endsWith | 765.7ms | 1006.8ms | 918.3ms |
| array/push-pop | 790.5ms | 908.9ms | — |
| array/sort-i32 | 962.2ms | 986.7ms | — |
| array/map-filter | 962.1ms | 1057.9ms | — |
| array/reduce | 842.1ms | 976.0ms | — |
| array/indexOf | 872.4ms | 964.2ms | — |
| array/slice | 779.8ms | 879.9ms | — |
| array/reverse | 795.5ms | 898.7ms | — |
| array/forEach | 891.6ms | 994.7ms | — |
| array/find | 759.9ms | 875.0ms | 846.0ms |
| dom/create-elements | 636.5ms | — | — |
| dom/set-attributes | 713.8ms | — | — |
| dom/read-attributes | 704.6ms | — | — |
| dom/modify-text | 609.1ms | — | — |
| mixed/csv-parse | 802.3ms | 927.2ms | — |
| mixed/text-search | 788.2ms | 1046.1ms | 915.0ms |
| mixed/fibonacci | 817.3ms | 825.0ms | 812.7ms |
| mixed/matrix-multiply | 864.6ms | 960.2ms | 814.1ms |
| mixed/sieve | 877.5ms | 911.2ms | — |
