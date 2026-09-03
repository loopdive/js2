# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.047ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.128ms | 0.015ms | 0.022ms | gc-native |
| string/split | 0.424ms | 8.29ms | 2.76ms | FAILED | js |
| string/replace | 0.107ms | 0.687ms | 0.322ms | FAILED | js |
| string/case-convert | 0.058ms | 0.625ms | 0.281ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.77ms | 2.69ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.88ms | 3.13ms | 0.561ms | js |
| array/push-pop | 1.43ms | 0.509ms | 0.511ms | FAILED | host-call |
| array/sort-i32 | 0.791ms | 0.551ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.514ms | 0.506ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.030ms | 0.030ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.038ms | 0.156ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.584ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.120ms | — | — | js |
| dom/modify-text | 0.032ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.474ms | 8.86ms | 0.607ms | FAILED | js |
| mixed/text-search | 0.381ms | 4.78ms | 2.94ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.164ms | 79.14ms | 78.63ms | 0.719ms | js |
| mixed/sieve | 1.57ms | 2.14ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.13 | 4.67 | 4.42 | — |
| string/concat-long | 1000 | 3.58 | 4.48 | 3.73 | — |
| string/indexOf | 1000 | 19.20 | 63.62 | 12.35 | 14.70 |
| string/includes | 1000 | 19.24 | 127.76 | 14.84 | 21.60 |
| string/split | 10000 | 42.40 | 828.97 | 275.80 | — |
| string/replace | 1000 | 107.23 | 687.43 | 321.71 | — |
| string/case-convert | 2000 | 29.06 | 312.73 | 140.41 | — |
| string/substring | 10000 | 9.89 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 376.76 | 268.69 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 143.95 | 156.75 | 28.03 |
| array/map-filter | 30000 | 4.31 | 2.38 | 2.38 | — |
| array/indexOf | 1000 | 3952.46 | 2645.22 | 2641.61 | — |
| dom/create-elements | 2000 | 19.01 | 78.10 | — | — |
| dom/set-attributes | 6000 | 17.55 | 97.40 | — | — |
| dom/read-attributes | 3000 | 18.33 | 40.04 | — | — |
| dom/modify-text | 2000 | 16.14 | 53.48 | — | — |
| mixed/csv-parse | 11000 | 43.06 | 805.86 | 55.22 | — |
| mixed/text-search | 40000 | 9.53 | 119.54 | 73.51 | 27.51 |
| mixed/fibonacci | 10000 | 12.18 | 28.30 | 28.32 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.31 | 633.12 | 629.01 | 5.76 |
| mixed/sieve | 200000 | 7.87 | 10.72 | 10.67 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.41x slower | — |
| string/concat-long | 1.25x slower | 1.04x slower | — |
| string/indexOf | 3.31x slower | 1.55x faster | 1.31x faster |
| string/includes | 6.64x slower | 1.30x faster | 1.12x slower |
| string/split | 19.55x slower | 6.50x slower | — |
| string/replace | 6.41x slower | 3.00x slower | — |
| string/case-convert | 10.76x slower | 4.83x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 22.16x slower | 15.81x slower | — |
| string/startsWith-endsWith | 7.18x slower | 7.82x slower | 1.40x slower |
| array/push-pop | 2.82x faster | 2.81x faster | — |
| array/sort-i32 | 1.44x faster | 2.69x faster | — |
| array/map-filter | 1.81x faster | 1.81x faster | — |
| array/reduce | 4.20x faster | 4.27x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.12x slower | 1.13x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 15.64x faster | 15.80x faster | 4.25x slower |
| dom/create-elements | 4.11x slower | — | — |
| dom/set-attributes | 5.55x slower | — | — |
| dom/read-attributes | 2.18x slower | — | — |
| dom/modify-text | 3.31x slower | — | — |
| mixed/csv-parse | 18.72x slower | 1.28x slower | — |
| mixed/text-search | 12.55x slower | 7.72x slower | 2.89x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 481.72x slower | 478.60x slower | 4.38x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.15x faster |
| string/includes | 8.61x faster |
| string/split | 3.01x faster |
| string/replace | 2.14x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.22x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.09x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.88x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.59x faster |
| mixed/text-search | 1.63x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x faster |

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
| array/indexOf | 1.8KB | 2.1KB | — |
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
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1704.4ms | 1106.7ms | — |
| string/concat-long | 780.7ms | 959.1ms | — |
| string/indexOf | 698.5ms | 974.6ms | 859.5ms |
| string/includes | 667.5ms | 1017.1ms | 855.2ms |
| string/split | 790.1ms | 1007.3ms | — |
| string/replace | 788.4ms | 1089.0ms | — |
| string/case-convert | 798.2ms | 875.5ms | — |
| string/substring | 693.9ms | 794.6ms | — |
| string/trim | 753.7ms | 1025.5ms | — |
| string/startsWith-endsWith | 814.0ms | 1018.0ms | 958.3ms |
| array/push-pop | 827.9ms | 927.6ms | — |
| array/sort-i32 | 1007.8ms | 1079.7ms | — |
| array/map-filter | 1003.6ms | 1053.4ms | — |
| array/reduce | 899.0ms | 1025.4ms | — |
| array/indexOf | 900.4ms | 964.3ms | — |
| array/slice | 807.5ms | 900.0ms | — |
| array/reverse | 813.6ms | 890.4ms | — |
| array/forEach | 912.0ms | 1008.6ms | — |
| array/find | 800.5ms | 872.8ms | 871.6ms |
| dom/create-elements | 728.4ms | — | — |
| dom/set-attributes | 785.6ms | — | — |
| dom/read-attributes | 734.5ms | — | — |
| dom/modify-text | 718.2ms | — | — |
| mixed/csv-parse | 836.2ms | 991.8ms | — |
| mixed/text-search | 843.6ms | 1043.4ms | 977.3ms |
| mixed/fibonacci | 801.2ms | 867.2ms | 808.4ms |
| mixed/matrix-multiply | 949.9ms | 1040.8ms | 862.4ms |
| mixed/sieve | 947.7ms | 969.4ms | — |
