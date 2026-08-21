# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.045ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.021ms | gc-native |
| string/includes | 0.019ms | 0.139ms | 0.014ms | 0.072ms | gc-native |
| string/split | 0.416ms | 4.93ms | 0.452ms | FAILED | js |
| string/replace | 0.104ms | 0.327ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.231ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.892ms | 0.188ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.295ms | 0.561ms | gc-native |
| array/push-pop | 1.41ms | 0.510ms | 0.509ms | FAILED | gc-native |
| array/sort-i32 | 0.788ms | 0.293ms | 0.365ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.508ms | 0.508ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.85ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.570ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.124ms | — | — | js |
| dom/modify-text | 0.030ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.474ms | 7.38ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.67ms | 0.265ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.720ms | js |
| mixed/sieve | 1.55ms | 1.42ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.46 | 4.47 | 3.88 | — |
| string/concat-long | 1000 | 3.64 | 4.48 | 3.62 | — |
| string/indexOf | 1000 | 19.16 | 62.67 | 12.04 | 21.40 |
| string/includes | 1000 | 19.20 | 139.22 | 14.46 | 71.64 |
| string/split | 10000 | 41.57 | 493.04 | 45.18 | — |
| string/replace | 1000 | 103.57 | 326.65 | 56.34 | — |
| string/case-convert | 2000 | 27.82 | 115.54 | 2.49 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.14 | — |
| string/trim | 10000 | 17.03 | 89.20 | 18.75 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 17.90 | 14.77 | 28.06 |
| array/map-filter | 30000 | 4.27 | 2.34 | 2.35 | — |
| array/indexOf | 1000 | 3951.36 | 2635.31 | 2637.54 | — |
| dom/create-elements | 2000 | 17.74 | 77.04 | — | — |
| dom/set-attributes | 6000 | 17.30 | 94.99 | — | — |
| dom/read-attributes | 3000 | 18.67 | 41.19 | — | — |
| dom/modify-text | 2000 | 14.93 | 55.10 | — | — |
| mixed/csv-parse | 11000 | 43.06 | 670.47 | 28.75 | — |
| mixed/text-search | 40000 | 9.72 | 41.64 | 6.64 | 27.25 |
| mixed/fibonacci | 10000 | 12.19 | 29.18 | 29.15 | 28.60 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.76 |
| mixed/sieve | 200000 | 7.73 | 7.11 | 6.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.29x slower | 1.12x slower | — |
| string/concat-long | 1.23x slower | 1.01x faster | — |
| string/indexOf | 3.27x slower | 1.59x faster | 1.12x slower |
| string/includes | 7.25x slower | 1.33x faster | 3.73x slower |
| string/split | 11.86x slower | 1.09x slower | — |
| string/replace | 3.15x slower | 1.84x faster | — |
| string/case-convert | 4.15x slower | 11.17x faster | — |
| string/substring | 2.64x faster | 3.15x faster | — |
| string/trim | 5.24x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.76x faster | 2.76x faster | — |
| array/sort-i32 | 2.69x faster | 2.16x faster | — |
| array/map-filter | 1.83x faster | 1.82x faster | — |
| array/reduce | 4.26x faster | 4.27x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 16.27x faster | 15.74x faster | 4.22x slower |
| dom/create-elements | 4.34x slower | — | — |
| dom/set-attributes | 5.49x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.69x slower | — | — |
| mixed/csv-parse | 15.57x slower | 1.50x faster | — |
| mixed/text-search | 4.29x slower | 1.46x faster | 2.80x slower |
| mixed/fibonacci | 2.39x slower | 2.39x slower | 2.35x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.56x slower |
| mixed/sieve | 1.09x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.21x faster |
| string/includes | 9.63x faster |
| string/split | 10.91x faster |
| string/replace | 5.80x faster |
| string/case-convert | 46.38x faster |
| string/substring | 1.19x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.25x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.03x slower |
| mixed/csv-parse | 23.32x faster |
| mixed/text-search | 6.28x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.02x faster |

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
| string/concat-short | 1406.8ms | 1137.4ms | — |
| string/concat-long | 663.2ms | 965.7ms | — |
| string/indexOf | 692.3ms | 996.7ms | 858.9ms |
| string/includes | 668.7ms | 996.8ms | 885.6ms |
| string/split | 828.9ms | 1006.3ms | — |
| string/replace | 801.0ms | 1149.8ms | — |
| string/case-convert | 795.7ms | 900.8ms | — |
| string/substring | 674.1ms | 777.0ms | — |
| string/trim | 793.2ms | 1004.6ms | — |
| string/startsWith-endsWith | 785.0ms | 1017.5ms | 926.2ms |
| array/push-pop | 813.4ms | 868.7ms | — |
| array/sort-i32 | 916.8ms | 1005.6ms | — |
| array/map-filter | 965.8ms | 1044.6ms | — |
| array/reduce | 844.1ms | 948.4ms | — |
| array/indexOf | 886.7ms | 945.4ms | — |
| array/slice | 814.5ms | 885.4ms | — |
| array/reverse | 775.9ms | 853.2ms | — |
| array/forEach | 882.0ms | 1004.0ms | — |
| array/find | 766.3ms | 887.9ms | 847.7ms |
| dom/create-elements | 641.2ms | — | — |
| dom/set-attributes | 719.9ms | — | — |
| dom/read-attributes | 694.3ms | — | — |
| dom/modify-text | 610.9ms | — | — |
| mixed/csv-parse | 807.4ms | 956.6ms | — |
| mixed/text-search | 789.0ms | 991.7ms | 944.3ms |
| mixed/fibonacci | 787.0ms | 803.1ms | 829.3ms |
| mixed/matrix-multiply | 881.7ms | 962.7ms | 830.4ms |
| mixed/sieve | 850.5ms | 972.5ms | — |
