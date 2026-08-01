# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.046ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.083ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.156ms | 0.023ms | FAILED | js |
| string/split | 0.426ms | 6.04ms | 1.36ms | FAILED | js |
| string/replace | 0.054ms | 0.291ms | 0.102ms | FAILED | js |
| string/case-convert | 0.061ms | 0.246ms | 0.106ms | FAILED | js |
| string/substring | 0.101ms | 1.93ms | 0.907ms | FAILED | js |
| string/trim | 0.170ms | 1.32ms | 0.647ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 3.00ms | 0.524ms | FAILED | js |
| array/push-pop | 1.45ms | 2.21ms | 2.22ms | FAILED | js |
| array/sort-i32 | 0.795ms | 0.396ms | 0.393ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.645ms | 0.645ms | FAILED | js |
| array/reduce | 2.16ms | 2.20ms | 2.19ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.027ms | 0.036ms | 0.037ms | FAILED | js |
| array/reverse | 7.84ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.239ms | 0.459ms | 0.458ms | 4.86ms | js |
| dom/create-elements | 0.038ms | 0.298ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.367ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.173ms | — | — | js |
| dom/modify-text | 0.050ms | 0.172ms | — | — | js |
| mixed/csv-parse | 0.485ms | 7.58ms | 0.829ms | FAILED | js |
| mixed/text-search | 0.393ms | 6.09ms | 1.04ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.262ms | 0.261ms | 1.15ms | js |
| mixed/matrix-multiply | 0.158ms | 0.555ms | 0.555ms | 2.13ms | js |
| mixed/sieve | 1.55ms | 1.40ms | 1.40ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.16 | 4.63 | 3.94 | — |
| string/concat-long | 1000 | 3.73 | 7.54 | 8.25 | — |
| string/indexOf | 1000 | 19.20 | 83.20 | 23.75 | — |
| string/includes | 1000 | 19.25 | 156.22 | 22.62 | — |
| string/split | 10000 | 42.62 | 604.05 | 135.51 | — |
| string/replace | 1000 | 53.54 | 290.77 | 101.98 | — |
| string/case-convert | 2000 | 30.26 | 122.98 | 53.18 | — |
| string/substring | 10000 | 10.06 | 193.25 | 90.74 | — |
| string/trim | 10000 | 16.98 | 131.73 | 64.70 | — |
| string/startsWith-endsWith | 20000 | 19.52 | 150.13 | 26.20 | — |
| mixed/csv-parse | 11000 | 44.10 | 689.12 | 75.32 | — |
| mixed/text-search | 40000 | 9.83 | 152.21 | 26.12 | — |
| mixed/fibonacci | 10000 | 12.18 | 26.17 | 26.12 | 114.68 |
| mixed/matrix-multiply | 125000 | 1.27 | 4.44 | 4.44 | 17.01 |
| mixed/sieve | 200000 | 7.73 | 7.01 | 7.02 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.25x slower | — |
| string/concat-long | 2.02x slower | 2.21x slower | — |
| string/indexOf | 4.33x slower | 1.24x slower | — |
| string/includes | 8.11x slower | 1.17x slower | — |
| string/split | 14.17x slower | 3.18x slower | — |
| string/replace | 5.43x slower | 1.90x slower | — |
| string/case-convert | 4.06x slower | 1.76x slower | — |
| string/substring | 19.21x slower | 9.02x slower | — |
| string/trim | 7.76x slower | 3.81x slower | — |
| string/startsWith-endsWith | 7.69x slower | 1.34x slower | — |
| array/push-pop | 1.53x slower | 1.53x slower | — |
| array/sort-i32 | 2.01x faster | 2.02x faster | — |
| array/map-filter | 4.98x slower | 4.98x slower | — |
| array/reduce | 1.02x slower | 1.01x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.31x slower | 1.37x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.35x slower | 2.35x slower | — |
| array/find | 1.92x slower | 1.91x slower | 20.31x slower |
| dom/create-elements | 7.94x slower | — | — |
| dom/set-attributes | 3.50x slower | — | — |
| dom/read-attributes | 3.13x slower | — | — |
| dom/modify-text | 3.42x slower | — | — |
| mixed/csv-parse | 15.63x slower | 1.71x slower | — |
| mixed/text-search | 15.49x slower | 2.66x slower | — |
| mixed/fibonacci | 2.15x slower | 2.14x slower | 9.42x slower |
| mixed/matrix-multiply | 3.50x slower | 3.50x slower | 13.42x slower |
| mixed/sieve | 1.10x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.50x faster |
| string/includes | 6.91x faster |
| string/split | 4.46x faster |
| string/replace | 2.85x faster |
| string/case-convert | 2.31x faster |
| string/substring | 2.13x faster |
| string/trim | 2.04x faster |
| string/startsWith-endsWith | 5.73x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.15x faster |
| mixed/text-search | 5.83x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1359.7ms | 1213.4ms | — |
| string/concat-long | 667.8ms | 1070.2ms | — |
| string/indexOf | 813.7ms | 1087.1ms | — |
| string/includes | 794.3ms | 1134.5ms | — |
| string/split | 902.2ms | 1109.9ms | — |
| string/replace | 901.5ms | 1153.5ms | — |
| string/case-convert | 877.6ms | 1149.1ms | — |
| string/substring | 776.9ms | 1013.0ms | — |
| string/trim | 837.5ms | 1099.6ms | — |
| string/startsWith-endsWith | 860.0ms | 1079.4ms | — |
| array/push-pop | 795.7ms | 884.7ms | — |
| array/sort-i32 | 1027.5ms | 1081.1ms | — |
| array/map-filter | 1005.3ms | 1048.9ms | — |
| array/reduce | 910.9ms | 948.7ms | — |
| array/indexOf | 813.9ms | 872.2ms | — |
| array/slice | 795.3ms | 896.3ms | — |
| array/reverse | 820.8ms | 838.1ms | — |
| array/forEach | 918.4ms | 999.6ms | — |
| array/find | 901.6ms | 960.5ms | 854.6ms |
| dom/create-elements | 667.5ms | — | — |
| dom/set-attributes | 786.2ms | — | — |
| dom/read-attributes | 766.6ms | — | — |
| dom/modify-text | 742.1ms | — | — |
| mixed/csv-parse | 965.0ms | 1077.2ms | — |
| mixed/text-search | 866.7ms | 1086.8ms | — |
| mixed/fibonacci | 823.3ms | 1017.2ms | 839.4ms |
| mixed/matrix-multiply | 982.9ms | 999.9ms | 872.6ms |
| mixed/sieve | 858.4ms | 948.9ms | — |
