# js2wasm Benchmark Results

Date: 2026-08-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.048ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.076ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.118ms | 0.020ms | FAILED | js |
| string/split | 0.414ms | 5.09ms | 0.537ms | FAILED | js |
| string/replace | 0.094ms | 0.218ms | 0.076ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.244ms | 0.125ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.927ms | 0.267ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.44ms | 0.307ms | FAILED | gc-native |
| array/push-pop | 1.72ms | 0.611ms | 0.612ms | FAILED | host-call |
| array/sort-i32 | 0.851ms | 0.362ms | 0.340ms | FAILED | gc-native |
| array/map-filter | 0.136ms | 0.566ms | 0.569ms | FAILED | js |
| array/reduce | 1.58ms | 0.598ms | 0.605ms | FAILED | host-call |
| array/indexOf | 4.46ms | 4.24ms | 4.26ms | FAILED | host-call |
| array/slice | 0.034ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.091ms | 0.029ms | 0.028ms | FAILED | gc-native |
| array/find | 0.281ms | 0.015ms | 0.015ms | 1.11ms | gc-native |
| dom/create-elements | 0.236ms | 0.261ms | — | — | js |
| dom/set-attributes | 0.111ms | 0.365ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.174ms | — | — | js |
| dom/modify-text | 0.054ms | 0.160ms | — | — | js |
| mixed/csv-parse | 0.469ms | 7.33ms | 0.770ms | FAILED | js |
| mixed/text-search | 0.403ms | 2.26ms | 0.356ms | FAILED | gc-native |
| mixed/fibonacci | 0.125ms | 0.048ms | 0.048ms | 0.050ms | host-call |
| mixed/matrix-multiply | 0.184ms | 0.200ms | 0.200ms | 0.718ms | js |
| mixed/sieve | 1.76ms | 1.48ms | 1.48ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.03 | 4.79 | 4.19 | — |
| string/concat-long | 1000 | 4.04 | 5.02 | 4.64 | — |
| string/indexOf | 1000 | 18.96 | 75.58 | 20.92 | — |
| string/includes | 1000 | 18.72 | 118.31 | 20.29 | — |
| string/split | 10000 | 41.40 | 508.76 | 53.74 | — |
| string/replace | 1000 | 94.20 | 218.11 | 76.38 | — |
| string/case-convert | 2000 | 29.00 | 121.77 | 62.59 | — |
| string/substring | 10000 | 10.41 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.27 | 92.68 | 26.71 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 122.10 | 15.35 | — |
| array/map-filter | 30000 | 4.53 | 18.85 | 18.98 | — |
| array/indexOf | 1000 | 4458.44 | 4239.62 | 4260.92 | — |
| dom/create-elements | 2000 | 117.77 | 130.49 | — | — |
| dom/set-attributes | 6000 | 18.51 | 60.83 | — | — |
| dom/read-attributes | 3000 | 20.14 | 58.01 | — | — |
| dom/modify-text | 2000 | 26.78 | 80.23 | — | — |
| mixed/csv-parse | 11000 | 42.61 | 666.45 | 70.00 | — |
| mixed/text-search | 40000 | 10.07 | 56.39 | 8.91 | — |
| mixed/fibonacci | 10000 | 12.53 | 4.79 | 4.80 | 5.01 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.60 | 1.60 | 5.75 |
| mixed/sieve | 200000 | 8.78 | 7.39 | 7.39 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.38x slower | — |
| string/concat-long | 1.24x slower | 1.15x slower | — |
| string/indexOf | 3.99x slower | 1.10x slower | — |
| string/includes | 6.32x slower | 1.08x slower | — |
| string/split | 12.29x slower | 1.30x slower | — |
| string/replace | 2.32x slower | 1.23x faster | — |
| string/case-convert | 4.20x slower | 2.16x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.37x slower | 1.55x slower | — |
| string/startsWith-endsWith | 5.91x slower | 1.35x faster | — |
| array/push-pop | 2.81x faster | 2.81x faster | — |
| array/sort-i32 | 2.35x faster | 2.50x faster | — |
| array/map-filter | 4.16x slower | 4.19x slower | — |
| array/reduce | 2.65x faster | 2.62x faster | — |
| array/indexOf | 1.05x faster | 1.05x faster | — |
| array/slice | 2.13x faster | 2.07x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.16x faster | 3.20x faster | — |
| array/find | 18.63x faster | 18.67x faster | 3.97x slower |
| dom/create-elements | 1.11x slower | — | — |
| dom/set-attributes | 3.29x slower | — | — |
| dom/read-attributes | 2.88x slower | — | — |
| dom/modify-text | 3.00x slower | — | — |
| mixed/csv-parse | 15.64x slower | 1.64x slower | — |
| mixed/text-search | 5.60x slower | 1.13x faster | — |
| mixed/fibonacci | 2.61x faster | 2.61x faster | 2.50x faster |
| mixed/matrix-multiply | 1.09x slower | 1.09x slower | 3.89x slower |
| mixed/sieve | 1.19x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.08x faster |
| string/indexOf | 3.61x faster |
| string/includes | 5.83x faster |
| string/split | 9.47x faster |
| string/replace | 2.86x faster |
| string/case-convert | 1.95x faster |
| string/substring | 1.16x faster |
| string/trim | 3.47x faster |
| string/startsWith-endsWith | 7.96x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.06x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.01x slower |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.52x faster |
| mixed/text-search | 6.33x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.0KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.8KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1264.2ms | 1066.2ms | — |
| string/concat-long | 620.9ms | 920.8ms | — |
| string/indexOf | 756.9ms | 1019.3ms | — |
| string/includes | 758.1ms | 992.4ms | — |
| string/split | 738.0ms | 934.9ms | — |
| string/replace | 782.4ms | 1086.5ms | — |
| string/case-convert | 750.1ms | 1158.1ms | — |
| string/substring | 639.7ms | 714.2ms | — |
| string/trim | 710.3ms | 976.9ms | — |
| string/startsWith-endsWith | 732.4ms | 974.4ms | — |
| array/push-pop | 757.7ms | 821.7ms | — |
| array/sort-i32 | 908.5ms | 971.2ms | — |
| array/map-filter | 889.0ms | 961.3ms | — |
| array/reduce | 832.1ms | 863.9ms | — |
| array/indexOf | 808.6ms | 842.2ms | — |
| array/slice | 742.0ms | 826.6ms | — |
| array/reverse | 756.7ms | 772.2ms | — |
| array/forEach | 837.5ms | 891.9ms | — |
| array/find | 731.5ms | 806.7ms | 811.8ms |
| dom/create-elements | 635.4ms | — | — |
| dom/set-attributes | 692.4ms | — | — |
| dom/read-attributes | 681.2ms | — | — |
| dom/modify-text | 694.5ms | — | — |
| mixed/csv-parse | 776.8ms | 966.4ms | — |
| mixed/text-search | 741.2ms | 950.3ms | — |
| mixed/fibonacci | 721.2ms | 740.9ms | 702.0ms |
| mixed/matrix-multiply | 790.1ms | 842.7ms | 751.2ms |
| mixed/sieve | 788.5ms | 826.2ms | — |
