# js2wasm Benchmark Results

Date: 2026-08-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.044ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.079ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.151ms | 0.021ms | FAILED | js |
| string/split | 0.423ms | 0.220ms | 0.226ms | FAILED | host-call |
| string/replace | 0.049ms | 0.013ms | 0.014ms | FAILED | host-call |
| string/case-convert | 0.060ms | 0.014ms | 0.015ms | FAILED | host-call |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.221ms | 0.227ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 0.223ms | 0.228ms | FAILED | host-call |
| array/push-pop | 1.45ms | 0.502ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.787ms | 0.336ms | 0.334ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.546ms | 0.549ms | FAILED | js |
| array/reduce | 2.14ms | 0.505ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.94ms | 0.012ms | 0.012ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.238ms | 0.017ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.034ms | 0.299ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.364ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.172ms | — | — | js |
| dom/modify-text | 0.046ms | 0.162ms | — | — | js |
| mixed/csv-parse | 0.480ms | 0.953ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.326ms | 0.314ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.046ms | gc-native |
| mixed/matrix-multiply | 0.157ms | 0.448ms | 0.448ms | 0.717ms | js |
| mixed/sieve | 1.61ms | 1.40ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.08 | 4.40 | 3.74 | — |
| string/concat-long | 1000 | 3.56 | 4.51 | 4.57 | — |
| string/indexOf | 1000 | 19.11 | 79.24 | 21.06 | — |
| string/includes | 1000 | 19.14 | 150.56 | 20.96 | — |
| string/split | 10000 | 42.33 | 22.04 | 22.62 | — |
| string/replace | 1000 | 49.10 | 13.48 | 14.30 | — |
| string/case-convert | 2000 | 30.17 | 6.81 | 7.34 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.91 | 22.06 | 22.70 | — |
| string/startsWith-endsWith | 20000 | 19.49 | 11.13 | 11.39 | — |
| mixed/csv-parse | 11000 | 43.61 | 86.61 | 27.82 | — |
| mixed/text-search | 40000 | 9.76 | 8.15 | 7.86 | — |
| mixed/fibonacci | 10000 | 12.18 | 4.40 | 4.40 | 4.58 |
| mixed/matrix-multiply | 125000 | 1.26 | 3.58 | 3.58 | 5.74 |
| mixed/sieve | 200000 | 8.06 | 7.01 | 6.99 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.22x slower | — |
| string/concat-long | 1.27x slower | 1.28x slower | — |
| string/indexOf | 4.15x slower | 1.10x slower | — |
| string/includes | 7.87x slower | 1.09x slower | — |
| string/split | 1.92x faster | 1.87x faster | — |
| string/replace | 3.64x faster | 3.43x faster | — |
| string/case-convert | 4.43x faster | 4.11x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 1.30x slower | 1.34x slower | — |
| string/startsWith-endsWith | 1.75x faster | 1.71x faster | — |
| array/push-pop | 2.89x faster | 2.90x faster | — |
| array/sort-i32 | 2.34x faster | 2.36x faster | — |
| array/map-filter | 4.28x slower | 4.29x slower | — |
| array/reduce | 4.24x faster | 4.23x faster | — |
| array/indexOf | 317.63x faster | 324.57x faster | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 14.38x faster | 14.26x faster | 4.53x slower |
| dom/create-elements | 8.68x slower | — | — |
| dom/set-attributes | 3.54x slower | — | — |
| dom/read-attributes | 3.20x slower | — | — |
| dom/modify-text | 3.49x slower | — | — |
| mixed/csv-parse | 1.99x slower | 1.57x faster | — |
| mixed/text-search | 1.20x faster | 1.24x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 2.66x faster |
| mixed/matrix-multiply | 2.85x slower | 2.85x slower | 4.57x slower |
| mixed/sieve | 1.15x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 3.76x faster |
| string/includes | 7.18x faster |
| string/split | 1.03x slower |
| string/replace | 1.06x slower |
| string/case-convert | 1.08x slower |
| string/substring | 1.22x faster |
| string/trim | 1.03x slower |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.02x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 3.11x faster |
| mixed/text-search | 1.04x faster |
| mixed/fibonacci | 1.00x faster |
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
| string/concat-short | 1311.7ms | 1121.9ms | — |
| string/concat-long | 632.2ms | 982.0ms | — |
| string/indexOf | 766.8ms | 973.3ms | — |
| string/includes | 748.1ms | 1003.1ms | — |
| string/split | 800.3ms | 945.6ms | — |
| string/replace | 798.0ms | 897.6ms | — |
| string/case-convert | 814.6ms | 877.8ms | — |
| string/substring | 653.6ms | 705.8ms | — |
| string/trim | 767.8ms | 914.1ms | — |
| string/startsWith-endsWith | 801.6ms | 929.3ms | — |
| array/push-pop | 780.7ms | 843.5ms | — |
| array/sort-i32 | 938.4ms | 1024.7ms | — |
| array/map-filter | 924.3ms | 973.2ms | — |
| array/reduce | 809.8ms | 888.0ms | — |
| array/indexOf | 724.8ms | 795.3ms | — |
| array/slice | 739.3ms | 802.5ms | — |
| array/reverse | 726.7ms | 785.5ms | — |
| array/forEach | 847.3ms | 961.3ms | — |
| array/find | 742.8ms | 805.1ms | 848.8ms |
| dom/create-elements | 611.0ms | — | — |
| dom/set-attributes | 721.7ms | — | — |
| dom/read-attributes | 682.4ms | — | — |
| dom/modify-text | 675.7ms | — | — |
| mixed/csv-parse | 816.6ms | 1062.1ms | — |
| mixed/text-search | 839.4ms | 911.5ms | — |
| mixed/fibonacci | 735.3ms | 789.8ms | 726.7ms |
| mixed/matrix-multiply | 848.2ms | 881.4ms | 805.2ms |
| mixed/sieve | 815.6ms | 876.5ms | — |
