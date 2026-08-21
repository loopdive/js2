# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.046ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.138ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.425ms | 4.84ms | 0.449ms | FAILED | js |
| string/replace | 0.109ms | 0.306ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.057ms | 0.238ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.968ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.295ms | 0.563ms | gc-native |
| array/push-pop | 1.43ms | 0.507ms | 0.510ms | FAILED | host-call |
| array/sort-i32 | 0.798ms | 0.294ms | 0.296ms | FAILED | host-call |
| array/map-filter | 0.075ms | 0.071ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.21ms | 0.521ms | 0.511ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.63ms | 2.64ms | FAILED | host-call |
| array/slice | 0.027ms | 0.029ms | 0.028ms | FAILED | js |
| array/reverse | 7.85ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.050ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/find | 0.255ms | 0.017ms | 0.017ms | 1.07ms | gc-native |
| dom/create-elements | 0.037ms | 0.160ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.495ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.129ms | — | — | js |
| dom/modify-text | 0.031ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.994ms | 7.05ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.68ms | 0.265ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 1.18ms | js |
| mixed/matrix-multiply | 0.160ms | 0.213ms | 0.210ms | 0.716ms | js |
| mixed/sieve | 1.60ms | 1.41ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.00 | 4.55 | 3.97 | — |
| string/concat-long | 1000 | 3.67 | 4.63 | 3.83 | — |
| string/indexOf | 1000 | 19.22 | 62.95 | 12.32 | 16.68 |
| string/includes | 1000 | 19.25 | 137.58 | 14.76 | 15.58 |
| string/split | 10000 | 42.48 | 484.22 | 44.91 | — |
| string/replace | 1000 | 108.63 | 305.90 | 56.75 | — |
| string/case-convert | 2000 | 28.33 | 118.93 | 2.51 | — |
| string/substring | 10000 | 9.87 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.06 | 96.83 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 17.87 | 14.77 | 28.13 |
| array/map-filter | 30000 | 2.50 | 2.37 | 2.41 | — |
| array/indexOf | 1000 | 3958.16 | 2634.75 | 2635.73 | — |
| dom/create-elements | 2000 | 18.54 | 79.81 | — | — |
| dom/set-attributes | 6000 | 17.56 | 82.54 | — | — |
| dom/read-attributes | 3000 | 18.59 | 43.12 | — | — |
| dom/modify-text | 2000 | 15.35 | 53.24 | — | — |
| mixed/csv-parse | 11000 | 90.39 | 641.14 | 28.62 | — |
| mixed/text-search | 40000 | 9.76 | 41.93 | 6.63 | 26.99 |
| mixed/fibonacci | 10000 | 12.17 | 29.17 | 29.23 | 117.90 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.70 | 1.68 | 5.73 |
| mixed/sieve | 200000 | 8.00 | 7.05 | 7.02 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.52x slower | 1.33x slower | — |
| string/concat-long | 1.26x slower | 1.04x slower | — |
| string/indexOf | 3.28x slower | 1.56x faster | 1.15x faster |
| string/includes | 7.15x slower | 1.30x faster | 1.24x faster |
| string/split | 11.40x slower | 1.06x slower | — |
| string/replace | 2.82x slower | 1.91x faster | — |
| string/case-convert | 4.20x slower | 11.29x faster | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 5.68x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.82x faster | 2.81x faster | — |
| array/sort-i32 | 2.71x faster | 2.70x faster | — |
| array/map-filter | 1.05x faster | 1.04x faster | — |
| array/reduce | 4.24x faster | 4.32x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.02x slower | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.80x faster | 1.73x faster | — |
| array/find | 14.84x faster | 15.14x faster | 4.21x slower |
| dom/create-elements | 4.30x slower | — | — |
| dom/set-attributes | 4.70x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.47x slower | — | — |
| mixed/csv-parse | 7.09x slower | 3.16x faster | — |
| mixed/text-search | 4.30x slower | 1.47x faster | 2.77x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 9.68x slower |
| mixed/matrix-multiply | 1.33x slower | 1.31x slower | 4.48x slower |
| mixed/sieve | 1.14x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.11x faster |
| string/includes | 9.32x faster |
| string/split | 10.78x faster |
| string/replace | 5.39x faster |
| string/case-convert | 47.38x faster |
| string/substring | 1.22x faster |
| string/trim | 5.20x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.02x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.04x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 22.40x faster |
| mixed/text-search | 6.32x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
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
| string/concat-short | 1326.4ms | 1084.7ms | — |
| string/concat-long | 651.4ms | 967.3ms | — |
| string/indexOf | 669.1ms | 957.5ms | 837.5ms |
| string/includes | 653.6ms | 976.5ms | 855.1ms |
| string/split | 758.3ms | 989.6ms | — |
| string/replace | 808.4ms | 1066.1ms | — |
| string/case-convert | 794.5ms | 888.0ms | — |
| string/substring | 678.4ms | 791.6ms | — |
| string/trim | 758.0ms | 992.5ms | — |
| string/startsWith-endsWith | 778.7ms | 974.8ms | 886.2ms |
| array/push-pop | 784.2ms | 857.2ms | — |
| array/sort-i32 | 929.3ms | 983.9ms | — |
| array/map-filter | 938.8ms | 1011.4ms | — |
| array/reduce | 887.7ms | 1034.1ms | — |
| array/indexOf | 870.1ms | 942.3ms | — |
| array/slice | 801.7ms | 866.0ms | — |
| array/reverse | 763.2ms | 861.0ms | — |
| array/forEach | 897.5ms | 960.1ms | — |
| array/find | 753.1ms | 845.0ms | 857.5ms |
| dom/create-elements | 642.1ms | — | — |
| dom/set-attributes | 715.9ms | — | — |
| dom/read-attributes | 697.2ms | — | — |
| dom/modify-text | 626.5ms | — | — |
| mixed/csv-parse | 816.6ms | 923.0ms | — |
| mixed/text-search | 789.7ms | 979.8ms | 906.4ms |
| mixed/fibonacci | 764.4ms | 834.4ms | 791.2ms |
| mixed/matrix-multiply | 855.8ms | 955.7ms | 808.1ms |
| mixed/sieve | 867.4ms | 905.7ms | — |
