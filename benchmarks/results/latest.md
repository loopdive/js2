# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.050ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.130ms | 0.023ms | FAILED | js |
| string/split | 0.420ms | 5.65ms | 1.57ms | FAILED | js |
| string/replace | 0.047ms | 0.219ms | 0.078ms | FAILED | js |
| string/case-convert | 0.062ms | 0.233ms | 0.112ms | FAILED | js |
| string/substring | 0.105ms | 1.96ms | 0.926ms | FAILED | js |
| string/trim | 0.189ms | 1.38ms | 0.724ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.68ms | 0.531ms | FAILED | js |
| array/push-pop | 1.71ms | 2.57ms | 2.53ms | FAILED | js |
| array/sort-i32 | 0.842ms | 0.415ms | 0.408ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.689ms | 0.691ms | FAILED | js |
| array/reduce | 2.37ms | 2.53ms | 2.56ms | FAILED | js |
| array/indexOf | 4.45ms | 3.85ms | 3.85ms | FAILED | host-call |
| array/slice | 0.035ms | 0.025ms | 0.024ms | FAILED | gc-native |
| array/reverse | 8.84ms | 3.69ms | 3.69ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.123ms | 0.123ms | FAILED | js |
| array/find | 0.282ms | 0.510ms | 0.510ms | 4.93ms | js |
| dom/create-elements | 0.040ms | 0.244ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.376ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.178ms | — | — | js |
| dom/modify-text | 0.052ms | 0.163ms | — | — | js |
| mixed/csv-parse | 0.947ms | 6.73ms | 0.800ms | FAILED | gc-native |
| mixed/text-search | 0.408ms | 5.36ms | 1.17ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.305ms | 0.304ms | 0.302ms | js |
| mixed/matrix-multiply | 0.185ms | 0.566ms | 0.565ms | 2.04ms | js |
| mixed/sieve | 1.83ms | 1.51ms | 1.51ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.61 | 5.04 | 4.33 | — |
| string/concat-long | 1000 | 4.15 | 8.43 | 9.15 | — |
| string/indexOf | 1000 | 19.03 | 81.16 | 23.74 | — |
| string/includes | 1000 | 18.73 | 129.84 | 22.52 | — |
| string/split | 10000 | 42.04 | 564.80 | 156.73 | — |
| string/replace | 1000 | 46.75 | 218.56 | 78.03 | — |
| string/case-convert | 2000 | 31.11 | 116.48 | 56.14 | — |
| string/substring | 10000 | 10.53 | 196.23 | 92.56 | — |
| string/trim | 10000 | 18.90 | 137.54 | 72.42 | — |
| string/startsWith-endsWith | 20000 | 21.42 | 133.79 | 26.55 | — |
| mixed/csv-parse | 11000 | 86.06 | 612.18 | 72.73 | — |
| mixed/text-search | 40000 | 10.19 | 134.06 | 29.14 | — |
| mixed/fibonacci | 10000 | 12.53 | 30.48 | 30.36 | 30.22 |
| mixed/matrix-multiply | 125000 | 1.48 | 4.52 | 4.52 | 16.35 |
| mixed/sieve | 200000 | 9.17 | 7.57 | 7.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.20x slower | — |
| string/concat-long | 2.03x slower | 2.21x slower | — |
| string/indexOf | 4.27x slower | 1.25x slower | — |
| string/includes | 6.93x slower | 1.20x slower | — |
| string/split | 13.43x slower | 3.73x slower | — |
| string/replace | 4.67x slower | 1.67x slower | — |
| string/case-convert | 3.74x slower | 1.80x slower | — |
| string/substring | 18.63x slower | 8.79x slower | — |
| string/trim | 7.28x slower | 3.83x slower | — |
| string/startsWith-endsWith | 6.25x slower | 1.24x slower | — |
| array/push-pop | 1.50x slower | 1.48x slower | — |
| array/sort-i32 | 2.03x faster | 2.06x faster | — |
| array/map-filter | 5.14x slower | 5.15x slower | — |
| array/reduce | 1.07x slower | 1.08x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.41x faster | 1.49x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.32x slower | 2.32x slower | — |
| array/find | 1.81x slower | 1.81x slower | 17.49x slower |
| dom/create-elements | 6.12x slower | — | — |
| dom/set-attributes | 3.46x slower | — | — |
| dom/read-attributes | 3.02x slower | — | — |
| dom/modify-text | 3.16x slower | — | — |
| mixed/csv-parse | 7.11x slower | 1.18x faster | — |
| mixed/text-search | 13.15x slower | 2.86x slower | — |
| mixed/fibonacci | 2.43x slower | 2.42x slower | 2.41x slower |
| mixed/matrix-multiply | 3.05x slower | 3.04x slower | 11.02x slower |
| mixed/sieve | 1.21x faster | 1.21x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.42x faster |
| string/includes | 5.77x faster |
| string/split | 3.60x faster |
| string/replace | 2.80x faster |
| string/case-convert | 2.07x faster |
| string/substring | 2.12x faster |
| string/trim | 1.90x faster |
| string/startsWith-endsWith | 5.04x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.06x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.42x faster |
| mixed/text-search | 4.60x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1316.0ms | 1143.0ms | — |
| string/concat-long | 634.3ms | 1047.6ms | — |
| string/indexOf | 787.7ms | 1025.3ms | — |
| string/includes | 755.6ms | 1050.2ms | — |
| string/split | 841.1ms | 1011.6ms | — |
| string/replace | 813.6ms | 1134.7ms | — |
| string/case-convert | 825.3ms | 1095.0ms | — |
| string/substring | 716.8ms | 970.0ms | — |
| string/trim | 793.8ms | 984.5ms | — |
| string/startsWith-endsWith | 789.0ms | 1036.2ms | — |
| array/push-pop | 769.4ms | 824.8ms | — |
| array/sort-i32 | 972.0ms | 1002.0ms | — |
| array/map-filter | 913.8ms | 1009.4ms | — |
| array/reduce | 837.8ms | 896.6ms | — |
| array/indexOf | 765.0ms | 806.6ms | — |
| array/slice | 744.9ms | 788.4ms | — |
| array/reverse | 771.7ms | 798.1ms | — |
| array/forEach | 890.5ms | 964.6ms | — |
| array/find | 909.0ms | 943.2ms | 847.2ms |
| dom/create-elements | 623.1ms | — | — |
| dom/set-attributes | 707.4ms | — | — |
| dom/read-attributes | 676.6ms | — | — |
| dom/modify-text | 685.2ms | — | — |
| mixed/csv-parse | 854.2ms | 1032.1ms | — |
| mixed/text-search | 828.4ms | 1029.9ms | — |
| mixed/fibonacci | 799.1ms | 923.3ms | 815.2ms |
| mixed/matrix-multiply | 888.6ms | 925.1ms | 822.7ms |
| mixed/sieve | 841.0ms | 955.2ms | — |
