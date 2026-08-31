# js2wasm Benchmark Results

Date: 2026-08-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.051ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.105ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.421ms | 7.80ms | 2.52ms | FAILED | js |
| string/replace | 0.095ms | 0.594ms | 0.274ms | FAILED | js |
| string/case-convert | 0.058ms | 0.527ms | 0.240ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.05ms | 2.31ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.45ms | 2.43ms | 0.557ms | js |
| array/push-pop | 1.66ms | 0.614ms | 0.614ms | FAILED | gc-native |
| array/sort-i32 | 0.840ms | 0.303ms | 0.554ms | FAILED | host-call |
| array/map-filter | 0.138ms | 0.067ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.64ms | 0.605ms | 0.614ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.27ms | host-call |
| dom/create-elements | 0.038ms | 0.157ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.508ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.135ms | — | — | js |
| dom/modify-text | 0.030ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.469ms | 8.57ms | 0.533ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.28ms | 2.41ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.185ms | 62.06ms | 62.35ms | 0.718ms | js |
| mixed/sieve | 1.77ms | 2.31ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.42 | 5.11 | 4.98 | — |
| string/concat-long | 1000 | 4.01 | 5.35 | 3.65 | — |
| string/indexOf | 1000 | 18.99 | 60.44 | 12.28 | 22.22 |
| string/includes | 1000 | 18.72 | 105.02 | 13.82 | 16.76 |
| string/split | 10000 | 42.13 | 779.88 | 252.20 | — |
| string/replace | 1000 | 94.89 | 594.40 | 273.97 | — |
| string/case-convert | 2000 | 29.04 | 263.29 | 120.22 | — |
| string/substring | 10000 | 10.49 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.28 | 304.54 | 230.85 | — |
| string/startsWith-endsWith | 20000 | 20.64 | 122.52 | 121.60 | 27.83 |
| array/map-filter | 30000 | 4.59 | 2.22 | 2.21 | — |
| array/indexOf | 1000 | 4456.90 | 2860.26 | 2859.11 | — |
| dom/create-elements | 2000 | 18.88 | 78.42 | — | — |
| dom/set-attributes | 6000 | 17.91 | 84.70 | — | — |
| dom/read-attributes | 3000 | 19.52 | 45.09 | — | — |
| dom/modify-text | 2000 | 14.80 | 57.00 | — | — |
| mixed/csv-parse | 11000 | 42.62 | 779.30 | 48.44 | — |
| mixed/text-search | 40000 | 10.08 | 106.95 | 60.18 | 28.29 |
| mixed/fibonacci | 10000 | 12.52 | 32.73 | 32.73 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.48 | 496.46 | 498.78 | 5.75 |
| mixed/sieve | 200000 | 8.85 | 11.56 | 11.61 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.46x slower | — |
| string/concat-long | 1.33x slower | 1.10x faster | — |
| string/indexOf | 3.18x slower | 1.55x faster | 1.17x slower |
| string/includes | 5.61x slower | 1.35x faster | 1.12x faster |
| string/split | 18.51x slower | 5.99x slower | — |
| string/replace | 6.26x slower | 2.89x slower | — |
| string/case-convert | 9.07x slower | 4.14x slower | — |
| string/substring | 2.63x faster | 3.06x faster | — |
| string/trim | 17.63x slower | 13.36x slower | — |
| string/startsWith-endsWith | 5.94x slower | 5.89x slower | 1.35x slower |
| array/push-pop | 2.70x faster | 2.70x faster | — |
| array/sort-i32 | 2.77x faster | 1.51x faster | — |
| array/map-filter | 2.07x faster | 2.08x faster | — |
| array/reduce | 2.71x faster | 2.67x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.24x faster | 2.18x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.82x faster | — |
| array/find | 18.47x faster | 18.42x faster | 4.65x slower |
| dom/create-elements | 4.15x slower | — | — |
| dom/set-attributes | 4.73x slower | — | — |
| dom/read-attributes | 2.31x slower | — | — |
| dom/modify-text | 3.85x slower | — | — |
| mixed/csv-parse | 18.28x slower | 1.14x slower | — |
| mixed/text-search | 10.62x slower | 5.97x slower | 2.81x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 335.89x slower | 337.46x slower | 3.89x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.47x faster |
| string/indexOf | 4.92x faster |
| string/includes | 7.60x faster |
| string/split | 3.09x faster |
| string/replace | 2.17x faster |
| string/case-convert | 2.19x faster |
| string/substring | 1.16x faster |
| string/trim | 1.32x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.83x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 16.09x faster |
| mixed/text-search | 1.78x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1651.8ms | 1026.8ms | — |
| string/concat-long | 747.2ms | 945.4ms | — |
| string/indexOf | 657.1ms | 958.2ms | 820.1ms |
| string/includes | 658.5ms | 954.0ms | 841.4ms |
| string/split | 767.0ms | 937.2ms | — |
| string/replace | 827.6ms | 1033.1ms | — |
| string/case-convert | 764.5ms | 833.8ms | — |
| string/substring | 654.1ms | 747.2ms | — |
| string/trim | 736.0ms | 928.7ms | — |
| string/startsWith-endsWith | 739.0ms | 942.3ms | 921.2ms |
| array/push-pop | 773.9ms | 846.3ms | — |
| array/sort-i32 | 921.1ms | 979.9ms | — |
| array/map-filter | 942.5ms | 1036.1ms | — |
| array/reduce | 861.9ms | 962.9ms | — |
| array/indexOf | 865.1ms | 936.6ms | — |
| array/slice | 770.4ms | 875.8ms | — |
| array/reverse | 776.8ms | 832.2ms | — |
| array/forEach | 867.2ms | 982.3ms | — |
| array/find | 767.3ms | 835.9ms | 837.4ms |
| dom/create-elements | 682.5ms | — | — |
| dom/set-attributes | 711.0ms | — | — |
| dom/read-attributes | 708.3ms | — | — |
| dom/modify-text | 656.0ms | — | — |
| mixed/csv-parse | 761.9ms | 950.2ms | — |
| mixed/text-search | 769.3ms | 941.0ms | 882.7ms |
| mixed/fibonacci | 720.0ms | 766.3ms | 751.9ms |
| mixed/matrix-multiply | 870.0ms | 985.1ms | 799.3ms |
| mixed/sieve | 835.0ms | 900.9ms | — |
