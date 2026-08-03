# js2wasm Benchmark Results

Date: 2026-08-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.044ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.076ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.152ms | 0.021ms | FAILED | js |
| string/split | 0.429ms | 0.220ms | 0.226ms | FAILED | host-call |
| string/replace | 0.047ms | 0.013ms | 0.014ms | FAILED | host-call |
| string/case-convert | 0.060ms | 0.014ms | 0.015ms | FAILED | host-call |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.220ms | 0.227ms | FAILED | js |
| string/startsWith-endsWith | 0.389ms | 0.223ms | 0.228ms | FAILED | host-call |
| array/push-pop | 1.45ms | 0.510ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.340ms | 0.334ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.549ms | 0.549ms | FAILED | js |
| array/reduce | 1.34ms | 0.511ms | 0.508ms | FAILED | gc-native |
| array/indexOf | 3.94ms | 0.013ms | 0.012ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.233ms | 0.017ms | 0.017ms | 0.996ms | gc-native |
| dom/create-elements | 0.208ms | 0.310ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.370ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.171ms | — | — | js |
| dom/modify-text | 0.048ms | 0.163ms | — | — | js |
| mixed/csv-parse | 0.468ms | 0.497ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 0.323ms | 0.313ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.158ms | 0.448ms | 0.449ms | 0.719ms | js |
| mixed/sieve | 1.55ms | 1.40ms | 1.40ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
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
| string/concat-short | 10000 | 3.34 | 4.41 | 3.71 | — |
| string/concat-long | 1000 | 3.55 | 4.49 | 4.55 | — |
| string/indexOf | 1000 | 19.11 | 76.39 | 20.90 | — |
| string/includes | 1000 | 19.16 | 152.02 | 20.54 | — |
| string/split | 10000 | 42.86 | 22.01 | 22.61 | — |
| string/replace | 1000 | 47.34 | 13.47 | 14.31 | — |
| string/case-convert | 2000 | 30.16 | 6.81 | 7.33 | — |
| string/substring | 10000 | 9.83 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.94 | 22.02 | 22.71 | — |
| string/startsWith-endsWith | 20000 | 19.47 | 11.13 | 11.39 | — |
| mixed/csv-parse | 11000 | 42.53 | 45.22 | 28.61 | — |
| mixed/text-search | 40000 | 9.79 | 8.08 | 7.83 | — |
| mixed/fibonacci | 10000 | 12.17 | 4.40 | 4.40 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.26 | 3.59 | 3.59 | 5.75 |
| mixed/sieve | 200000 | 7.76 | 6.98 | 6.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.32x slower | 1.11x slower | — |
| string/concat-long | 1.26x slower | 1.28x slower | — |
| string/indexOf | 4.00x slower | 1.09x slower | — |
| string/includes | 7.93x slower | 1.07x slower | — |
| string/split | 1.95x faster | 1.90x faster | — |
| string/replace | 3.51x faster | 3.31x faster | — |
| string/case-convert | 4.43x faster | 4.12x faster | — |
| string/substring | 2.62x faster | 3.20x faster | — |
| string/trim | 1.30x slower | 1.34x slower | — |
| string/startsWith-endsWith | 1.75x faster | 1.71x faster | — |
| array/push-pop | 2.86x faster | 2.89x faster | — |
| array/sort-i32 | 2.33x faster | 2.37x faster | — |
| array/map-filter | 4.09x slower | 4.10x slower | — |
| array/reduce | 2.62x faster | 2.64x faster | — |
| array/indexOf | 312.54x faster | 316.85x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.73x faster | — |
| array/find | 13.71x faster | 13.96x faster | 4.27x slower |
| dom/create-elements | 1.49x slower | — | — |
| dom/set-attributes | 3.55x slower | — | — |
| dom/read-attributes | 3.07x slower | — | — |
| dom/modify-text | 3.37x slower | — | — |
| mixed/csv-parse | 1.06x slower | 1.49x faster | — |
| mixed/text-search | 1.21x faster | 1.25x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 2.79x faster |
| mixed/matrix-multiply | 2.84x slower | 2.84x slower | 4.55x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 3.66x faster |
| string/includes | 7.40x faster |
| string/split | 1.03x slower |
| string/replace | 1.06x slower |
| string/case-convert | 1.08x slower |
| string/substring | 1.22x faster |
| string/trim | 1.03x slower |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.01x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 1.58x faster |
| mixed/text-search | 1.03x faster |
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
| string/split | 1.6KB | 2.7KB | — |
| string/replace | 1.5KB | 2.5KB | — |
| string/case-convert | 1.4KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 1.9KB | — |
| string/startsWith-endsWith | 1.6KB | 2.8KB | — |
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
| mixed/csv-parse | 1.9KB | 4.0KB | — |
| mixed/text-search | 1.7KB | 3.2KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1303.2ms | 1135.1ms | — |
| string/concat-long | 679.5ms | 980.5ms | — |
| string/indexOf | 773.9ms | 1018.8ms | — |
| string/includes | 760.4ms | 1040.7ms | — |
| string/split | 852.8ms | 939.3ms | — |
| string/replace | 847.9ms | 900.5ms | — |
| string/case-convert | 814.5ms | 932.3ms | — |
| string/substring | 670.6ms | 760.9ms | — |
| string/trim | 810.1ms | 930.4ms | — |
| string/startsWith-endsWith | 812.3ms | 904.1ms | — |
| array/push-pop | 753.9ms | 828.5ms | — |
| array/sort-i32 | 961.3ms | 998.4ms | — |
| array/map-filter | 917.8ms | 1026.2ms | — |
| array/reduce | 858.1ms | 900.8ms | — |
| array/indexOf | 740.5ms | 835.3ms | — |
| array/slice | 778.1ms | 817.9ms | — |
| array/reverse | 738.5ms | 814.8ms | — |
| array/forEach | 851.5ms | 950.4ms | — |
| array/find | 731.5ms | 847.6ms | 843.1ms |
| dom/create-elements | 634.3ms | — | — |
| dom/set-attributes | 716.1ms | — | — |
| dom/read-attributes | 693.5ms | — | — |
| dom/modify-text | 702.4ms | — | — |
| mixed/csv-parse | 844.0ms | 1054.5ms | — |
| mixed/text-search | 803.5ms | 921.8ms | — |
| mixed/fibonacci | 756.8ms | 761.9ms | 711.7ms |
| mixed/matrix-multiply | 822.5ms | 917.9ms | 802.0ms |
| mixed/sieve | 855.1ms | 872.7ms | — |
