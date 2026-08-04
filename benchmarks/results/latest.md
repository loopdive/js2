# js2wasm Benchmark Results

Date: 2026-08-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.046ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.080ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.147ms | 0.021ms | FAILED | js |
| string/split | 0.420ms | 5.52ms | 0.449ms | FAILED | js |
| string/replace | 0.111ms | 0.333ms | 0.086ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.270ms | 0.120ms | FAILED | js |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 1.04ms | 0.246ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.80ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.44ms | 0.499ms | 0.508ms | FAILED | host-call |
| array/sort-i32 | 0.798ms | 0.333ms | 0.340ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.545ms | 0.547ms | FAILED | js |
| array/reduce | 1.33ms | 0.508ms | 0.511ms | FAILED | host-call |
| array/indexOf | 3.94ms | 0.013ms | 0.013ms | FAILED | host-call |
| array/slice | 0.025ms | 0.028ms | 0.026ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.239ms | 0.018ms | 0.018ms | 1.08ms | gc-native |
| dom/create-elements | 0.034ms | 0.301ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.390ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.181ms | — | — | js |
| dom/modify-text | 0.047ms | 0.174ms | — | — | js |
| mixed/csv-parse | 0.488ms | 8.62ms | 0.814ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.63ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.087ms | host-call |
| mixed/matrix-multiply | 0.157ms | 0.190ms | 0.190ms | 0.717ms | js |
| mixed/sieve | 1.52ms | 1.39ms | 1.37ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.78 | 4.61 | 4.03 | — |
| string/concat-long | 1000 | 3.59 | 4.50 | 4.69 | — |
| string/indexOf | 1000 | 19.12 | 80.50 | 20.80 | — |
| string/includes | 1000 | 19.16 | 147.40 | 20.52 | — |
| string/split | 10000 | 42.02 | 552.00 | 44.94 | — |
| string/replace | 1000 | 110.54 | 332.92 | 85.74 | — |
| string/case-convert | 2000 | 27.81 | 135.03 | 60.18 | — |
| string/substring | 10000 | 9.85 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.00 | 103.85 | 24.64 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 140.08 | 14.34 | — |
| mixed/csv-parse | 11000 | 44.37 | 783.23 | 73.97 | — |
| mixed/text-search | 40000 | 9.71 | 65.66 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 4.40 | 4.40 | 8.67 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.52 | 1.52 | 5.74 |
| mixed/sieve | 200000 | 7.62 | 6.93 | 6.86 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.66x slower | 1.45x slower | — |
| string/concat-long | 1.25x slower | 1.31x slower | — |
| string/indexOf | 4.21x slower | 1.09x slower | — |
| string/includes | 7.69x slower | 1.07x slower | — |
| string/split | 13.14x slower | 1.07x slower | — |
| string/replace | 3.01x slower | 1.29x faster | — |
| string/case-convert | 4.86x slower | 2.16x slower | — |
| string/substring | 2.62x faster | 3.20x faster | — |
| string/trim | 6.11x slower | 1.45x slower | — |
| string/startsWith-endsWith | 6.98x slower | 1.40x faster | — |
| array/push-pop | 2.88x faster | 2.83x faster | — |
| array/sort-i32 | 2.39x faster | 2.35x faster | — |
| array/map-filter | 4.25x slower | 4.27x slower | — |
| array/reduce | 2.62x faster | 2.60x faster | — |
| array/indexOf | 314.24x faster | 307.10x faster | — |
| array/slice | 1.13x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.74x faster | — |
| array/find | 13.39x faster | 13.57x faster | 4.51x slower |
| dom/create-elements | 8.80x slower | — | — |
| dom/set-attributes | 3.81x slower | — | — |
| dom/read-attributes | 3.33x slower | — | — |
| dom/modify-text | 3.71x slower | — | — |
| mixed/csv-parse | 17.65x slower | 1.67x slower | — |
| mixed/text-search | 6.76x slower | 1.18x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 1.41x faster |
| mixed/matrix-multiply | 1.21x slower | 1.21x slower | 4.56x slower |
| mixed/sieve | 1.10x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.04x slower |
| string/indexOf | 3.87x faster |
| string/includes | 7.18x faster |
| string/split | 12.28x faster |
| string/replace | 3.88x faster |
| string/case-convert | 2.24x faster |
| string/substring | 1.22x faster |
| string/trim | 4.21x faster |
| string/startsWith-endsWith | 9.77x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.02x slower |
| array/slice | 1.07x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 10.59x faster |
| mixed/text-search | 8.01x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

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
| array/indexOf | 834B | 1.1KB | — |
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
| string/concat-short | 1348.6ms | 1136.8ms | — |
| string/concat-long | 636.0ms | 962.2ms | — |
| string/indexOf | 755.8ms | 994.9ms | — |
| string/includes | 759.6ms | 991.8ms | — |
| string/split | 760.9ms | 983.6ms | — |
| string/replace | 852.8ms | 1102.8ms | — |
| string/case-convert | 849.0ms | 1177.7ms | — |
| string/substring | 658.3ms | 768.1ms | — |
| string/trim | 734.9ms | 1023.5ms | — |
| string/startsWith-endsWith | 764.5ms | 992.2ms | — |
| array/push-pop | 745.6ms | 828.0ms | — |
| array/sort-i32 | 945.8ms | 975.6ms | — |
| array/map-filter | 934.2ms | 1014.6ms | — |
| array/reduce | 870.3ms | 922.2ms | — |
| array/indexOf | 757.3ms | 842.2ms | — |
| array/slice | 790.2ms | 811.6ms | — |
| array/reverse | 772.4ms | 812.8ms | — |
| array/forEach | 868.0ms | 924.8ms | — |
| array/find | 740.8ms | 824.0ms | 827.2ms |
| dom/create-elements | 611.3ms | — | — |
| dom/set-attributes | 735.5ms | — | — |
| dom/read-attributes | 691.5ms | — | — |
| dom/modify-text | 671.7ms | — | — |
| mixed/csv-parse | 813.5ms | 1023.1ms | — |
| mixed/text-search | 767.7ms | 1022.3ms | — |
| mixed/fibonacci | 768.4ms | 782.3ms | 737.4ms |
| mixed/matrix-multiply | 860.4ms | 891.1ms | 797.1ms |
| mixed/sieve | 849.0ms | 880.8ms | — |
