# js2wasm Benchmark Results

Date: 2026-08-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.047ms | 0.054ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.062ms | 0.024ms | FAILED | js |
| string/includes | 0.018ms | 0.130ms | 0.024ms | FAILED | js |
| string/split | 0.382ms | 5.41ms | 0.420ms | FAILED | js |
| string/replace | 0.107ms | 0.279ms | 0.075ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.295ms | 0.123ms | FAILED | js |
| string/substring | 0.105ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.159ms | 0.868ms | 0.231ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 2.88ms | 0.273ms | FAILED | gc-native |
| array/push-pop | 1.55ms | 0.499ms | 0.496ms | FAILED | gc-native |
| array/sort-i32 | 0.712ms | 0.308ms | 0.303ms | FAILED | gc-native |
| array/map-filter | 0.147ms | 0.139ms | 0.139ms | FAILED | gc-native |
| array/reduce | 1.99ms | 0.498ms | 0.504ms | FAILED | host-call |
| array/indexOf | 4.83ms | 3.97ms | 3.95ms | FAILED | gc-native |
| array/slice | 0.039ms | 0.035ms | 0.037ms | FAILED | host-call |
| array/reverse | 10.13ms | 3.69ms | 3.68ms | FAILED | gc-native |
| array/forEach | 0.100ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.265ms | 0.018ms | 0.018ms | 0.985ms | gc-native |
| dom/create-elements | 0.065ms | 0.208ms | — | — | js |
| dom/set-attributes | 0.126ms | 0.622ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.168ms | — | — | js |
| dom/modify-text | 0.070ms | 0.142ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.82ms | 0.708ms | FAILED | js |
| mixed/text-search | 0.394ms | 2.60ms | 0.338ms | FAILED | gc-native |
| mixed/fibonacci | 0.144ms | 0.129ms | 0.129ms | 0.038ms | linear-memory |
| mixed/matrix-multiply | 0.205ms | 0.191ms | 0.191ms | 0.771ms | gc-native |
| mixed/sieve | 1.51ms | 1.52ms | 1.51ms | FAILED | js |

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
| string/concat-short | 10000 | 4.46 | 4.65 | 5.38 | — |
| string/concat-long | 1000 | 4.52 | 4.61 | 5.67 | — |
| string/indexOf | 1000 | 17.90 | 61.51 | 23.79 | — |
| string/includes | 1000 | 17.94 | 129.77 | 23.90 | — |
| string/split | 10000 | 38.20 | 541.10 | 41.97 | — |
| string/replace | 1000 | 106.87 | 279.47 | 74.54 | — |
| string/case-convert | 2000 | 28.12 | 147.38 | 61.38 | — |
| string/substring | 10000 | 10.55 | 4.19 | 3.59 | — |
| string/trim | 10000 | 15.85 | 86.80 | 23.05 | — |
| string/startsWith-endsWith | 20000 | 21.46 | 144.24 | 13.63 | — |
| array/map-filter | 30000 | 4.89 | 4.64 | 4.62 | — |
| array/indexOf | 1000 | 4828.64 | 3965.66 | 3952.02 | — |
| dom/create-elements | 2000 | 32.67 | 103.79 | — | — |
| dom/set-attributes | 6000 | 21.01 | 103.59 | — | — |
| dom/read-attributes | 3000 | 24.21 | 55.99 | — | — |
| dom/modify-text | 2000 | 35.24 | 70.97 | — | — |
| mixed/csv-parse | 11000 | 44.21 | 802.15 | 64.34 | — |
| mixed/text-search | 40000 | 9.85 | 65.12 | 8.45 | — |
| mixed/fibonacci | 10000 | 14.43 | 12.88 | 12.89 | 3.76 |
| mixed/matrix-multiply | 125000 | 1.64 | 1.53 | 1.53 | 6.17 |
| mixed/sieve | 200000 | 7.55 | 7.59 | 7.55 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.04x slower | 1.20x slower | — |
| string/concat-long | 1.02x slower | 1.26x slower | — |
| string/indexOf | 3.44x slower | 1.33x slower | — |
| string/includes | 7.23x slower | 1.33x slower | — |
| string/split | 14.16x slower | 1.10x slower | — |
| string/replace | 2.61x slower | 1.43x faster | — |
| string/case-convert | 5.24x slower | 2.18x slower | — |
| string/substring | 2.52x faster | 2.94x faster | — |
| string/trim | 5.48x slower | 1.45x slower | — |
| string/startsWith-endsWith | 6.72x slower | 1.57x faster | — |
| array/push-pop | 3.10x faster | 3.12x faster | — |
| array/sort-i32 | 2.31x faster | 2.35x faster | — |
| array/map-filter | 1.05x faster | 1.06x faster | — |
| array/reduce | 4.00x faster | 3.95x faster | — |
| array/indexOf | 1.22x faster | 1.22x faster | — |
| array/slice | 1.11x faster | 1.08x faster | — |
| array/reverse | 2.75x faster | 2.75x faster | — |
| array/forEach | 3.51x faster | 3.55x faster | — |
| array/find | 14.54x faster | 14.64x faster | 3.72x slower |
| dom/create-elements | 3.18x slower | — | — |
| dom/set-attributes | 4.93x slower | — | — |
| dom/read-attributes | 2.31x slower | — | — |
| dom/modify-text | 2.01x slower | — | — |
| mixed/csv-parse | 18.15x slower | 1.46x slower | — |
| mixed/text-search | 6.61x slower | 1.17x faster | — |
| mixed/fibonacci | 1.12x faster | 1.12x faster | 3.84x faster |
| mixed/matrix-multiply | 1.07x faster | 1.07x faster | 3.77x slower |
| mixed/sieve | 1.00x slower | 1.00x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x slower |
| string/concat-long | 1.23x slower |
| string/indexOf | 2.59x faster |
| string/includes | 5.43x faster |
| string/split | 12.89x faster |
| string/replace | 3.75x faster |
| string/case-convert | 2.40x faster |
| string/substring | 1.17x faster |
| string/trim | 3.77x faster |
| string/startsWith-endsWith | 10.59x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 12.47x faster |
| mixed/text-search | 7.70x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
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
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1216.8ms | 1082.8ms | — |
| string/concat-long | 618.5ms | 966.1ms | — |
| string/indexOf | 770.1ms | 1035.9ms | — |
| string/includes | 779.8ms | 986.5ms | — |
| string/split | 749.7ms | 990.4ms | — |
| string/replace | 833.2ms | 1091.9ms | — |
| string/case-convert | 802.8ms | 1233.5ms | — |
| string/substring | 633.5ms | 731.6ms | — |
| string/trim | 719.9ms | 1009.5ms | — |
| string/startsWith-endsWith | 723.8ms | 1006.8ms | — |
| array/push-pop | 759.3ms | 866.0ms | — |
| array/sort-i32 | 958.4ms | 999.1ms | — |
| array/map-filter | 920.5ms | 1003.2ms | — |
| array/reduce | 825.7ms | 877.8ms | — |
| array/indexOf | 842.5ms | 921.3ms | — |
| array/slice | 784.8ms | 858.8ms | — |
| array/reverse | 772.0ms | 807.2ms | — |
| array/forEach | 844.5ms | 968.1ms | — |
| array/find | 751.0ms | 817.4ms | 828.0ms |
| dom/create-elements | 635.4ms | — | — |
| dom/set-attributes | 705.3ms | — | — |
| dom/read-attributes | 662.4ms | — | — |
| dom/modify-text | 686.3ms | — | — |
| mixed/csv-parse | 793.8ms | 1010.1ms | — |
| mixed/text-search | 749.9ms | 1042.1ms | — |
| mixed/fibonacci | 812.3ms | 808.7ms | 730.2ms |
| mixed/matrix-multiply | 809.1ms | 865.4ms | 778.0ms |
| mixed/sieve | 802.9ms | 876.4ms | — |
