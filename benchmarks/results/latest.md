# js2wasm Benchmark Results

Date: 2026-08-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.048ms | 0.051ms | 0.055ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.059ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.018ms | 0.099ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.383ms | 7.59ms | 2.70ms | FAILED | js |
| string/replace | 0.110ms | 0.610ms | 0.318ms | FAILED | js |
| string/case-convert | 0.058ms | 0.594ms | 0.253ms | FAILED | js |
| string/substring | 0.106ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.163ms | 3.63ms | 2.68ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 2.91ms | 2.91ms | 0.579ms | js |
| array/push-pop | 1.42ms | 0.503ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.715ms | 0.543ms | 0.313ms | FAILED | gc-native |
| array/map-filter | 0.148ms | 0.086ms | 0.085ms | FAILED | gc-native |
| array/reduce | 2.04ms | 0.510ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 4.83ms | 2.75ms | 2.75ms | FAILED | gc-native |
| array/slice | 0.042ms | 0.038ms | 0.035ms | FAILED | gc-native |
| array/reverse | 7.27ms | 3.65ms | 3.65ms | FAILED | gc-native |
| array/forEach | 0.101ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.266ms | 0.018ms | 0.017ms | 0.986ms | gc-native |
| dom/create-elements | 0.057ms | 0.182ms | — | — | js |
| dom/set-attributes | 0.127ms | 0.535ms | — | — | js |
| dom/read-attributes | 0.069ms | 0.140ms | — | — | js |
| dom/modify-text | 0.055ms | 0.125ms | — | — | js |
| mixed/csv-parse | 1.78ms | 8.02ms | 0.585ms | FAILED | gc-native |
| mixed/text-search | 0.380ms | 4.33ms | 2.79ms | 1.21ms | js |
| mixed/fibonacci | 0.134ms | 0.353ms | 0.353ms | 1.07ms | js |
| mixed/matrix-multiply | 0.205ms | 67.02ms | 67.65ms | 0.773ms | js |
| mixed/sieve | 1.52ms | 2.22ms | 2.28ms | FAILED | js |

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
| string/concat-short | 10000 | 4.80 | 5.13 | 5.53 | — |
| string/concat-long | 1000 | 4.68 | 4.76 | 5.86 | — |
| string/indexOf | 1000 | 17.99 | 58.87 | 12.32 | 14.81 |
| string/includes | 1000 | 18.14 | 99.35 | 13.88 | 15.16 |
| string/split | 10000 | 38.35 | 758.67 | 270.15 | — |
| string/replace | 1000 | 110.25 | 609.69 | 318.11 | — |
| string/case-convert | 2000 | 29.02 | 297.23 | 126.72 | — |
| string/substring | 10000 | 10.59 | 4.19 | 3.59 | — |
| string/trim | 10000 | 16.28 | 362.92 | 268.13 | — |
| string/startsWith-endsWith | 20000 | 21.47 | 145.41 | 145.29 | 28.97 |
| array/map-filter | 30000 | 4.92 | 2.86 | 2.85 | — |
| array/indexOf | 1000 | 4833.99 | 2753.42 | 2749.90 | — |
| dom/create-elements | 2000 | 28.59 | 91.23 | — | — |
| dom/set-attributes | 6000 | 21.12 | 89.11 | — | — |
| dom/read-attributes | 3000 | 23.16 | 46.57 | — | — |
| dom/modify-text | 2000 | 27.71 | 62.46 | — | — |
| mixed/csv-parse | 11000 | 161.87 | 728.89 | 53.22 | — |
| mixed/text-search | 40000 | 9.49 | 108.35 | 69.71 | 30.37 |
| mixed/fibonacci | 10000 | 13.40 | 35.27 | 35.28 | 106.58 |
| mixed/matrix-multiply | 125000 | 1.64 | 536.17 | 541.21 | 6.18 |
| mixed/sieve | 200000 | 7.60 | 11.10 | 11.42 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x slower | 1.15x slower | — |
| string/concat-long | 1.02x slower | 1.25x slower | — |
| string/indexOf | 3.27x slower | 1.46x faster | 1.21x faster |
| string/includes | 5.48x slower | 1.31x faster | 1.20x faster |
| string/split | 19.79x slower | 7.05x slower | — |
| string/replace | 5.53x slower | 2.89x slower | — |
| string/case-convert | 10.24x slower | 4.37x slower | — |
| string/substring | 2.53x faster | 2.95x faster | — |
| string/trim | 22.29x slower | 16.46x slower | — |
| string/startsWith-endsWith | 6.77x slower | 6.77x slower | 1.35x slower |
| array/push-pop | 2.82x faster | 2.83x faster | — |
| array/sort-i32 | 1.32x faster | 2.29x faster | — |
| array/map-filter | 1.72x faster | 1.73x faster | — |
| array/reduce | 4.00x faster | 4.06x faster | — |
| array/indexOf | 1.76x faster | 1.76x faster | — |
| array/slice | 1.10x faster | 1.19x faster | — |
| array/reverse | 1.99x faster | 1.99x faster | — |
| array/forEach | 3.54x faster | 3.49x faster | — |
| array/find | 15.00x faster | 15.44x faster | 3.70x slower |
| dom/create-elements | 3.19x slower | — | — |
| dom/set-attributes | 4.22x slower | — | — |
| dom/read-attributes | 2.01x slower | — | — |
| dom/modify-text | 2.25x slower | — | — |
| mixed/csv-parse | 4.50x slower | 3.04x faster | — |
| mixed/text-search | 11.41x slower | 7.34x slower | 3.20x slower |
| mixed/fibonacci | 2.63x slower | 2.63x slower | 7.95x slower |
| mixed/matrix-multiply | 326.32x slower | 329.39x slower | 3.76x slower |
| mixed/sieve | 1.46x slower | 1.50x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x slower |
| string/concat-long | 1.23x slower |
| string/indexOf | 4.78x faster |
| string/includes | 7.16x faster |
| string/split | 2.81x faster |
| string/replace | 1.92x faster |
| string/case-convert | 2.35x faster |
| string/substring | 1.17x faster |
| string/trim | 1.35x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.74x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.08x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.03x faster |
| mixed/csv-parse | 13.70x faster |
| mixed/text-search | 1.55x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.03x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.4KB | 3.0KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1622.7ms | 1054.2ms | — |
| string/concat-long | 744.8ms | 962.0ms | — |
| string/indexOf | 643.0ms | 960.6ms | 827.6ms |
| string/includes | 674.4ms | 993.3ms | 831.5ms |
| string/split | 749.9ms | 984.1ms | — |
| string/replace | 776.4ms | 1101.8ms | — |
| string/case-convert | 776.0ms | 861.5ms | — |
| string/substring | 628.9ms | 785.4ms | — |
| string/trim | 721.4ms | 978.2ms | — |
| string/startsWith-endsWith | 762.2ms | 991.8ms | 922.5ms |
| array/push-pop | 779.1ms | 861.9ms | — |
| array/sort-i32 | 972.9ms | 1032.1ms | — |
| array/map-filter | 964.2ms | 1006.1ms | — |
| array/reduce | 847.2ms | 980.7ms | — |
| array/indexOf | 889.5ms | 971.5ms | — |
| array/slice | 784.2ms | 871.7ms | — |
| array/reverse | 748.0ms | 870.4ms | — |
| array/forEach | 900.0ms | 971.3ms | — |
| array/find | 761.2ms | 861.8ms | 839.8ms |
| dom/create-elements | 701.7ms | — | — |
| dom/set-attributes | 735.0ms | — | — |
| dom/read-attributes | 686.1ms | — | — |
| dom/modify-text | 670.9ms | — | — |
| mixed/csv-parse | 789.6ms | 971.6ms | — |
| mixed/text-search | 823.2ms | 987.6ms | 917.2ms |
| mixed/fibonacci | 768.0ms | 805.1ms | 740.6ms |
| mixed/matrix-multiply | 922.5ms | 1006.1ms | 807.0ms |
| mixed/sieve | 883.7ms | 973.0ms | — |
