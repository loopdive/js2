# js2wasm Benchmark Results

Date: 2026-09-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.047ms | 0.049ms | 0.056ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.058ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.018ms | 0.102ms | 0.014ms | 0.020ms | gc-native |
| string/split | 0.412ms | 7.61ms | 2.72ms | FAILED | js |
| string/replace | 0.110ms | 0.563ms | 0.314ms | FAILED | js |
| string/case-convert | 0.057ms | 0.583ms | 0.250ms | FAILED | js |
| string/substring | 0.101ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.163ms | 3.66ms | 2.69ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.89ms | 2.90ms | 0.577ms | js |
| array/push-pop | 1.50ms | 0.511ms | 0.509ms | FAILED | gc-native |
| array/sort-i32 | 0.719ms | 0.310ms | 0.612ms | FAILED | host-call |
| array/map-filter | 0.153ms | 0.086ms | 0.087ms | FAILED | host-call |
| array/reduce | 2.01ms | 0.500ms | 0.499ms | FAILED | gc-native |
| array/indexOf | 4.83ms | 2.76ms | 2.77ms | FAILED | host-call |
| array/slice | 0.044ms | 0.039ms | 0.039ms | FAILED | gc-native |
| array/reverse | 7.27ms | 3.65ms | 3.65ms | FAILED | gc-native |
| array/forEach | 0.078ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.268ms | 0.018ms | 0.018ms | 0.986ms | host-call |
| dom/create-elements | 0.067ms | 0.179ms | — | — | js |
| dom/set-attributes | 0.129ms | 0.540ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.141ms | — | — | js |
| dom/modify-text | 0.059ms | 0.127ms | — | — | js |
| mixed/csv-parse | 0.447ms | 8.02ms | 0.602ms | FAILED | js |
| mixed/text-search | 0.392ms | 4.45ms | 2.76ms | 1.23ms | js |
| mixed/fibonacci | 0.134ms | 0.353ms | 0.353ms | 1.07ms | js |
| mixed/matrix-multiply | 0.205ms | 68.31ms | 68.53ms | 0.773ms | js |
| mixed/sieve | 1.53ms | 2.20ms | 2.23ms | FAILED | js |

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
| string/concat-short | 10000 | 4.66 | 4.93 | 5.65 | — |
| string/concat-long | 1000 | 4.65 | 4.79 | 6.14 | — |
| string/indexOf | 1000 | 18.12 | 58.11 | 12.65 | 14.94 |
| string/includes | 1000 | 18.13 | 101.95 | 14.42 | 19.60 |
| string/split | 10000 | 41.15 | 761.47 | 272.21 | — |
| string/replace | 1000 | 110.19 | 563.41 | 313.91 | — |
| string/case-convert | 2000 | 28.44 | 291.39 | 124.88 | — |
| string/substring | 10000 | 10.06 | 4.20 | 3.59 | — |
| string/trim | 10000 | 16.25 | 365.79 | 268.58 | — |
| string/startsWith-endsWith | 20000 | 21.40 | 144.30 | 144.85 | 28.86 |
| array/map-filter | 30000 | 5.11 | 2.86 | 2.90 | — |
| array/indexOf | 1000 | 4827.59 | 2758.81 | 2766.70 | — |
| dom/create-elements | 2000 | 33.33 | 89.48 | — | — |
| dom/set-attributes | 6000 | 21.54 | 89.93 | — | — |
| dom/read-attributes | 3000 | 24.46 | 46.88 | — | — |
| dom/modify-text | 2000 | 29.63 | 63.49 | — | — |
| mixed/csv-parse | 11000 | 40.68 | 729.18 | 54.74 | — |
| mixed/text-search | 40000 | 9.80 | 111.25 | 68.98 | 30.67 |
| mixed/fibonacci | 10000 | 13.39 | 35.29 | 35.28 | 106.58 |
| mixed/matrix-multiply | 125000 | 1.64 | 546.45 | 548.23 | 6.18 |
| mixed/sieve | 200000 | 7.66 | 11.02 | 11.15 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.06x slower | 1.21x slower | — |
| string/concat-long | 1.03x slower | 1.32x slower | — |
| string/indexOf | 3.21x slower | 1.43x faster | 1.21x faster |
| string/includes | 5.62x slower | 1.26x faster | 1.08x slower |
| string/split | 18.50x slower | 6.61x slower | — |
| string/replace | 5.11x slower | 2.85x slower | — |
| string/case-convert | 10.25x slower | 4.39x slower | — |
| string/substring | 2.39x faster | 2.80x faster | — |
| string/trim | 22.51x slower | 16.53x slower | — |
| string/startsWith-endsWith | 6.74x slower | 6.77x slower | 1.35x slower |
| array/push-pop | 2.94x faster | 2.95x faster | — |
| array/sort-i32 | 2.32x faster | 1.18x faster | — |
| array/map-filter | 1.79x faster | 1.76x faster | — |
| array/reduce | 4.02x faster | 4.03x faster | — |
| array/indexOf | 1.75x faster | 1.74x faster | — |
| array/slice | 1.12x faster | 1.13x faster | — |
| array/reverse | 1.99x faster | 1.99x faster | — |
| array/forEach | 2.70x faster | 2.70x faster | — |
| array/find | 15.15x faster | 15.11x faster | 3.68x slower |
| dom/create-elements | 2.69x slower | — | — |
| dom/set-attributes | 4.18x slower | — | — |
| dom/read-attributes | 1.92x slower | — | — |
| dom/modify-text | 2.14x slower | — | — |
| mixed/csv-parse | 17.93x slower | 1.35x slower | — |
| mixed/text-search | 11.35x slower | 7.04x slower | 3.13x slower |
| mixed/fibonacci | 2.64x slower | 2.63x slower | 7.96x slower |
| mixed/matrix-multiply | 333.16x slower | 334.25x slower | 3.77x slower |
| mixed/sieve | 1.44x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x slower |
| string/concat-long | 1.28x slower |
| string/indexOf | 4.59x faster |
| string/includes | 7.07x faster |
| string/split | 2.80x faster |
| string/replace | 1.79x faster |
| string/case-convert | 2.33x faster |
| string/substring | 1.17x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.97x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.32x faster |
| mixed/text-search | 1.61x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 980B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.2KB | 10.4KB |
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
| array/indexOf | 1.8KB | 2.2KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.1KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1615.6ms | 1067.1ms | — |
| string/concat-long | 754.1ms | 975.4ms | — |
| string/indexOf | 677.5ms | 999.1ms | 833.8ms |
| string/includes | 673.4ms | 1015.4ms | 847.5ms |
| string/split | 804.5ms | 1001.7ms | — |
| string/replace | 814.2ms | 1121.3ms | — |
| string/case-convert | 814.4ms | 933.8ms | — |
| string/substring | 694.2ms | 803.0ms | — |
| string/trim | 801.0ms | 1020.6ms | — |
| string/startsWith-endsWith | 789.5ms | 1016.4ms | 946.5ms |
| array/push-pop | 808.3ms | 909.1ms | — |
| array/sort-i32 | 994.4ms | 991.0ms | — |
| array/map-filter | 1003.8ms | 1073.4ms | — |
| array/reduce | 884.4ms | 954.6ms | — |
| array/indexOf | 859.5ms | 972.5ms | — |
| array/slice | 790.4ms | 870.4ms | — |
| array/reverse | 771.8ms | 897.3ms | — |
| array/forEach | 919.9ms | 1103.5ms | — |
| array/find | 788.3ms | 903.6ms | 855.6ms |
| dom/create-elements | 707.3ms | — | — |
| dom/set-attributes | 712.9ms | — | — |
| dom/read-attributes | 728.1ms | — | — |
| dom/modify-text | 702.8ms | — | — |
| mixed/csv-parse | 841.5ms | 1080.3ms | — |
| mixed/text-search | 796.3ms | 1051.3ms | 930.5ms |
| mixed/fibonacci | 779.9ms | 830.8ms | 749.6ms |
| mixed/matrix-multiply | 945.6ms | 995.2ms | 821.0ms |
| mixed/sieve | 859.0ms | 927.7ms | — |
