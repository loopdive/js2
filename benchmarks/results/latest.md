# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.049ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.047ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.425ms | 8.17ms | 3.53ms | FAILED | js |
| string/replace | 0.110ms | 0.681ms | 0.315ms | FAILED | js |
| string/case-convert | 0.056ms | 0.613ms | 0.268ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 3.74ms | 2.73ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.75ms | 2.99ms | 0.561ms | js |
| array/push-pop | 1.44ms | 0.506ms | 0.509ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.295ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.072ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.19ms | 0.509ms | 0.510ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.65ms | FAILED | host-call |
| array/slice | 0.029ms | 0.030ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.038ms | 0.163ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.507ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.125ms | — | — | js |
| dom/modify-text | 0.032ms | 0.112ms | — | — | js |
| mixed/csv-parse | 1.04ms | 8.62ms | 1.09ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.75ms | 2.87ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.160ms | 69.86ms | 72.61ms | 0.726ms | js |
| mixed/sieve | 1.62ms | 2.15ms | 2.16ms | FAILED | js |

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
| string/concat-short | 10000 | 3.21 | 4.94 | 4.54 | — |
| string/concat-long | 1000 | 3.69 | 4.65 | 3.87 | — |
| string/indexOf | 1000 | 19.19 | 64.31 | 12.49 | 14.62 |
| string/includes | 1000 | 19.27 | 46.90 | 14.89 | 15.42 |
| string/split | 10000 | 42.47 | 817.31 | 352.89 | — |
| string/replace | 1000 | 110.38 | 681.47 | 315.08 | — |
| string/case-convert | 2000 | 27.93 | 306.52 | 133.80 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.05 | 374.37 | 273.43 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 137.65 | 149.46 | 28.05 |
| array/map-filter | 30000 | 4.37 | 2.40 | 2.41 | — |
| array/indexOf | 1000 | 3953.32 | 2649.09 | 2649.50 | — |
| dom/create-elements | 2000 | 18.84 | 81.39 | — | — |
| dom/set-attributes | 6000 | 17.65 | 84.43 | — | — |
| dom/read-attributes | 3000 | 19.06 | 41.78 | — | — |
| dom/modify-text | 2000 | 15.87 | 55.87 | — | — |
| mixed/csv-parse | 11000 | 94.10 | 783.49 | 99.13 | — |
| mixed/text-search | 40000 | 9.75 | 118.86 | 71.74 | 27.43 |
| mixed/fibonacci | 10000 | 12.17 | 28.33 | 28.33 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.28 | 558.91 | 580.91 | 5.81 |
| mixed/sieve | 200000 | 8.08 | 10.77 | 10.82 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.41x slower | — |
| string/concat-long | 1.26x slower | 1.05x slower | — |
| string/indexOf | 3.35x slower | 1.54x faster | 1.31x faster |
| string/includes | 2.43x slower | 1.29x faster | 1.25x faster |
| string/split | 19.24x slower | 8.31x slower | — |
| string/replace | 6.17x slower | 2.85x slower | — |
| string/case-convert | 10.98x slower | 4.79x slower | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 21.95x slower | 16.03x slower | — |
| string/startsWith-endsWith | 6.86x slower | 7.44x slower | 1.40x slower |
| array/push-pop | 2.85x faster | 2.84x faster | — |
| array/sort-i32 | 2.70x faster | 2.70x faster | — |
| array/map-filter | 1.82x faster | 1.82x faster | — |
| array/reduce | 4.30x faster | 4.30x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.02x slower | 1.00x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.74x faster | 1.77x faster | — |
| array/find | 16.09x faster | 15.82x faster | 4.22x slower |
| dom/create-elements | 4.32x slower | — | — |
| dom/set-attributes | 4.78x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.52x slower | — | — |
| mixed/csv-parse | 8.33x slower | 1.05x slower | — |
| mixed/text-search | 12.19x slower | 7.36x slower | 2.81x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 437.82x slower | 455.05x slower | 4.55x slower |
| mixed/sieve | 1.33x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.15x faster |
| string/includes | 3.15x faster |
| string/split | 2.32x faster |
| string/replace | 2.16x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.09x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.02x slower |
| mixed/csv-parse | 7.90x faster |
| mixed/text-search | 1.66x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1756.0ms | 1124.6ms | — |
| string/concat-long | 791.6ms | 1003.1ms | — |
| string/indexOf | 720.6ms | 1016.0ms | 901.5ms |
| string/includes | 698.8ms | 1018.4ms | 886.9ms |
| string/split | 805.9ms | 1029.3ms | — |
| string/replace | 813.6ms | 1056.2ms | — |
| string/case-convert | 842.7ms | 913.6ms | — |
| string/substring | 690.8ms | 802.1ms | — |
| string/trim | 788.6ms | 974.5ms | — |
| string/startsWith-endsWith | 781.3ms | 982.5ms | 945.5ms |
| array/push-pop | 797.8ms | 901.2ms | — |
| array/sort-i32 | 976.8ms | 1005.2ms | — |
| array/map-filter | 988.6ms | 1085.7ms | — |
| array/reduce | 915.8ms | 995.1ms | — |
| array/indexOf | 900.3ms | 1026.3ms | — |
| array/slice | 834.7ms | 935.1ms | — |
| array/reverse | 810.3ms | 924.7ms | — |
| array/forEach | 926.4ms | 1036.0ms | — |
| array/find | 810.8ms | 912.1ms | 874.8ms |
| dom/create-elements | 773.1ms | — | — |
| dom/set-attributes | 781.6ms | — | — |
| dom/read-attributes | 771.0ms | — | — |
| dom/modify-text | 725.5ms | — | — |
| mixed/csv-parse | 835.2ms | 1056.5ms | — |
| mixed/text-search | 823.6ms | 1046.8ms | 954.3ms |
| mixed/fibonacci | 801.0ms | 887.2ms | 820.3ms |
| mixed/matrix-multiply | 937.4ms | 1007.8ms | 867.8ms |
| mixed/sieve | 931.7ms | 1046.6ms | — |
