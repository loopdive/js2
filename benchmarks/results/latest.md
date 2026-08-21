# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.046ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.019ms | gc-native |
| string/includes | 0.019ms | 0.135ms | 0.015ms | 0.070ms | gc-native |
| string/split | 0.413ms | 4.95ms | 0.449ms | FAILED | js |
| string/replace | 0.118ms | 0.301ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.242ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.955ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 0.358ms | 0.295ms | 0.560ms | gc-native |
| array/push-pop | 1.43ms | 0.505ms | 0.507ms | FAILED | host-call |
| array/sort-i32 | 0.777ms | 0.294ms | 0.298ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.18ms | 0.513ms | 0.508ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.017ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.159ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.568ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.505ms | 7.56ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 1.67ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.287ms | js |
| mixed/matrix-multiply | 0.163ms | 0.211ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.59ms | 1.41ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.49 | 4.59 | 3.79 | — |
| string/concat-long | 1000 | 3.56 | 4.55 | 3.62 | — |
| string/indexOf | 1000 | 19.17 | 63.01 | 12.33 | 18.55 |
| string/includes | 1000 | 19.21 | 134.90 | 14.87 | 70.43 |
| string/split | 10000 | 41.30 | 494.94 | 44.89 | — |
| string/replace | 1000 | 117.71 | 300.94 | 56.51 | — |
| string/case-convert | 2000 | 27.84 | 121.04 | 2.52 | — |
| string/substring | 10000 | 9.89 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.04 | 95.54 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.14 | 17.92 | 14.76 | 28.00 |
| array/map-filter | 30000 | 4.24 | 2.38 | 2.35 | — |
| array/indexOf | 1000 | 3952.74 | 2635.68 | 2636.65 | — |
| dom/create-elements | 2000 | 17.91 | 79.52 | — | — |
| dom/set-attributes | 6000 | 17.57 | 94.71 | — | — |
| dom/read-attributes | 3000 | 18.77 | 40.63 | — | — |
| dom/modify-text | 2000 | 14.50 | 53.48 | — | — |
| mixed/csv-parse | 11000 | 45.91 | 686.98 | 28.67 | — |
| mixed/text-search | 40000 | 9.70 | 41.72 | 6.64 | 27.36 |
| mixed/fibonacci | 10000 | 12.18 | 29.17 | 29.17 | 28.67 |
| mixed/matrix-multiply | 125000 | 1.30 | 1.68 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 7.95 | 7.06 | 6.96 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.31x slower | 1.09x slower | — |
| string/concat-long | 1.28x slower | 1.02x slower | — |
| string/indexOf | 3.29x slower | 1.56x faster | 1.03x faster |
| string/includes | 7.02x slower | 1.29x faster | 3.67x slower |
| string/split | 11.98x slower | 1.09x slower | — |
| string/replace | 2.56x slower | 2.08x faster | — |
| string/case-convert | 4.35x slower | 11.06x faster | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 5.61x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.39x slower |
| array/push-pop | 2.84x faster | 2.83x faster | — |
| array/sort-i32 | 2.64x faster | 2.61x faster | — |
| array/map-filter | 1.78x faster | 1.81x faster | — |
| array/reduce | 4.25x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.73x faster | — |
| array/find | 15.32x faster | 15.75x faster | 4.24x slower |
| dom/create-elements | 4.44x slower | — | — |
| dom/set-attributes | 5.39x slower | — | — |
| dom/read-attributes | 2.17x slower | — | — |
| dom/modify-text | 3.69x slower | — | — |
| mixed/csv-parse | 14.96x slower | 1.60x faster | — |
| mixed/text-search | 4.30x slower | 1.46x faster | 2.82x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.29x slower | 1.29x slower | 4.40x slower |
| mixed/sieve | 1.13x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.26x faster |
| string/indexOf | 5.11x faster |
| string/includes | 9.07x faster |
| string/split | 11.02x faster |
| string/replace | 5.33x faster |
| string/case-convert | 48.07x faster |
| string/substring | 1.23x faster |
| string/trim | 5.12x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.03x faster |
| mixed/csv-parse | 23.96x faster |
| mixed/text-search | 6.28x faster |
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
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.0KB | — |
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
| string/concat-short | 1318.9ms | 1117.5ms | — |
| string/concat-long | 643.5ms | 977.9ms | — |
| string/indexOf | 670.5ms | 951.6ms | 841.3ms |
| string/includes | 691.3ms | 1020.6ms | 854.2ms |
| string/split | 794.9ms | 987.4ms | — |
| string/replace | 768.4ms | 1046.6ms | — |
| string/case-convert | 828.0ms | 898.0ms | — |
| string/substring | 665.1ms | 775.2ms | — |
| string/trim | 743.6ms | 971.4ms | — |
| string/startsWith-endsWith | 788.2ms | 983.0ms | 914.3ms |
| array/push-pop | 774.3ms | 837.2ms | — |
| array/sort-i32 | 916.9ms | 984.7ms | — |
| array/map-filter | 956.0ms | 1036.2ms | — |
| array/reduce | 846.7ms | 989.0ms | — |
| array/indexOf | 883.8ms | 953.9ms | — |
| array/slice | 771.6ms | 877.3ms | — |
| array/reverse | 751.9ms | 858.1ms | — |
| array/forEach | 884.8ms | 1045.0ms | — |
| array/find | 783.8ms | 904.4ms | 876.7ms |
| dom/create-elements | 636.0ms | — | — |
| dom/set-attributes | 716.1ms | — | — |
| dom/read-attributes | 686.4ms | — | — |
| dom/modify-text | 601.3ms | — | — |
| mixed/csv-parse | 815.3ms | 973.8ms | — |
| mixed/text-search | 801.5ms | 1001.9ms | 911.2ms |
| mixed/fibonacci | 758.4ms | 781.0ms | 793.6ms |
| mixed/matrix-multiply | 860.4ms | 931.5ms | 822.4ms |
| mixed/sieve | 913.1ms | 961.4ms | — |
