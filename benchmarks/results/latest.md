# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.056ms | 0.056ms | 0.067ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.017ms | 0.052ms | 0.011ms | 0.016ms | gc-native |
| string/includes | 0.016ms | 0.099ms | 0.014ms | 0.020ms | gc-native |
| string/split | 0.387ms | 6.96ms | 2.52ms | FAILED | js |
| string/replace | 0.101ms | 0.524ms | 0.293ms | FAILED | js |
| string/case-convert | 0.051ms | 0.489ms | 0.234ms | FAILED | js |
| string/substring | 0.108ms | 0.038ms | 0.033ms | FAILED | gc-native |
| string/trim | 0.171ms | 3.22ms | 2.41ms | FAILED | js |
| string/startsWith-endsWith | 0.485ms | 2.61ms | 2.78ms | 0.566ms | js |
| array/push-pop | 1.47ms | 0.497ms | 0.493ms | FAILED | gc-native |
| array/sort-i32 | 0.651ms | 0.340ms | 0.340ms | FAILED | host-call |
| array/map-filter | 0.141ms | 0.082ms | 0.082ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.490ms | 0.489ms | FAILED | gc-native |
| array/indexOf | 5.39ms | 2.67ms | 2.66ms | FAILED | gc-native |
| array/slice | 0.039ms | 0.053ms | 0.042ms | FAILED | js |
| array/reverse | 8.46ms | 3.81ms | 3.81ms | FAILED | gc-native |
| array/forEach | 0.060ms | 0.025ms | 0.025ms | FAILED | gc-native |
| array/find | 0.293ms | 0.017ms | 0.017ms | 0.990ms | host-call |
| dom/create-elements | 0.065ms | 0.174ms | — | — | js |
| dom/set-attributes | 0.130ms | 0.483ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.114ms | — | — | js |
| dom/modify-text | 0.060ms | 0.105ms | — | — | js |
| mixed/csv-parse | 0.408ms | 6.95ms | 0.558ms | FAILED | js |
| mixed/text-search | 0.439ms | 4.07ms | 2.54ms | 1.17ms | js |
| mixed/fibonacci | 0.137ms | 0.217ms | 0.217ms | 1.07ms | js |
| mixed/matrix-multiply | 0.189ms | 62.48ms | 62.77ms | 0.722ms | js |
| mixed/sieve | 1.65ms | 2.64ms | 2.46ms | FAILED | js |

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
| string/concat-short | 10000 | 5.62 | 5.64 | 6.71 | — |
| string/concat-long | 1000 | 5.44 | 5.55 | 6.35 | — |
| string/indexOf | 1000 | 16.58 | 52.28 | 11.38 | 15.79 |
| string/includes | 1000 | 16.41 | 99.32 | 14.17 | 19.75 |
| string/split | 10000 | 38.74 | 695.54 | 251.80 | — |
| string/replace | 1000 | 100.66 | 523.92 | 292.71 | — |
| string/case-convert | 2000 | 25.66 | 244.65 | 116.93 | — |
| string/substring | 10000 | 10.81 | 3.81 | 3.26 | — |
| string/trim | 10000 | 17.10 | 321.74 | 240.68 | — |
| string/startsWith-endsWith | 20000 | 24.23 | 130.51 | 138.78 | 28.29 |
| array/map-filter | 30000 | 4.70 | 2.75 | 2.74 | — |
| array/indexOf | 1000 | 5385.57 | 2665.34 | 2663.82 | — |
| dom/create-elements | 2000 | 32.71 | 86.81 | — | — |
| dom/set-attributes | 6000 | 21.59 | 80.45 | — | — |
| dom/read-attributes | 3000 | 24.42 | 37.84 | — | — |
| dom/modify-text | 2000 | 29.83 | 52.44 | — | — |
| mixed/csv-parse | 11000 | 37.07 | 631.70 | 50.70 | — |
| mixed/text-search | 40000 | 10.96 | 101.79 | 63.50 | 29.32 |
| mixed/fibonacci | 10000 | 13.72 | 21.69 | 21.68 | 106.98 |
| mixed/matrix-multiply | 125000 | 1.51 | 499.86 | 502.13 | 5.77 |
| mixed/sieve | 200000 | 8.27 | 13.20 | 12.32 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.00x slower | 1.19x slower | — |
| string/concat-long | 1.02x slower | 1.17x slower | — |
| string/indexOf | 3.15x slower | 1.46x faster | 1.05x faster |
| string/includes | 6.05x slower | 1.16x faster | 1.20x slower |
| string/split | 17.95x slower | 6.50x slower | — |
| string/replace | 5.21x slower | 2.91x slower | — |
| string/case-convert | 9.53x slower | 4.56x slower | — |
| string/substring | 2.84x faster | 3.31x faster | — |
| string/trim | 18.81x slower | 14.07x slower | — |
| string/startsWith-endsWith | 5.39x slower | 5.73x slower | 1.17x slower |
| array/push-pop | 2.96x faster | 2.99x faster | — |
| array/sort-i32 | 1.91x faster | 1.91x faster | — |
| array/map-filter | 1.71x faster | 1.71x faster | — |
| array/reduce | 4.37x faster | 4.38x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.37x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.37x faster | 2.38x faster | — |
| array/find | 17.12x faster | 17.10x faster | 3.38x slower |
| dom/create-elements | 2.65x slower | — | — |
| dom/set-attributes | 3.73x slower | — | — |
| dom/read-attributes | 1.55x slower | — | — |
| dom/modify-text | 1.76x slower | — | — |
| mixed/csv-parse | 17.04x slower | 1.37x slower | — |
| mixed/text-search | 9.28x slower | 5.79x slower | 2.67x slower |
| mixed/fibonacci | 1.58x slower | 1.58x slower | 7.80x slower |
| mixed/matrix-multiply | 330.31x slower | 331.81x slower | 3.82x slower |
| mixed/sieve | 1.60x slower | 1.49x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x slower |
| string/concat-long | 1.14x slower |
| string/indexOf | 4.59x faster |
| string/includes | 7.01x faster |
| string/split | 2.76x faster |
| string/replace | 1.79x faster |
| string/case-convert | 2.09x faster |
| string/substring | 1.17x faster |
| string/trim | 1.34x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.28x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 12.46x faster |
| mixed/text-search | 1.60x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.07x faster |

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
| string/concat-short | 1598.4ms | 1094.8ms | — |
| string/concat-long | 741.6ms | 952.7ms | — |
| string/indexOf | 652.1ms | 954.4ms | 828.2ms |
| string/includes | 642.6ms | 955.6ms | 819.8ms |
| string/split | 749.6ms | 964.2ms | — |
| string/replace | 742.7ms | 994.6ms | — |
| string/case-convert | 773.2ms | 854.6ms | — |
| string/substring | 625.1ms | 716.5ms | — |
| string/trim | 718.2ms | 979.6ms | — |
| string/startsWith-endsWith | 754.1ms | 946.7ms | 882.4ms |
| array/push-pop | 743.0ms | 835.1ms | — |
| array/sort-i32 | 928.9ms | 977.2ms | — |
| array/map-filter | 929.0ms | 1012.3ms | — |
| array/reduce | 863.9ms | 936.3ms | — |
| array/indexOf | 814.4ms | 917.3ms | — |
| array/slice | 767.3ms | 882.2ms | — |
| array/reverse | 748.2ms | 883.6ms | — |
| array/forEach | 896.1ms | 998.7ms | — |
| array/find | 751.2ms | 857.7ms | 838.0ms |
| dom/create-elements | 684.1ms | — | — |
| dom/set-attributes | 707.0ms | — | — |
| dom/read-attributes | 688.6ms | — | — |
| dom/modify-text | 660.4ms | — | — |
| mixed/csv-parse | 764.8ms | 930.6ms | — |
| mixed/text-search | 779.7ms | 974.7ms | 894.3ms |
| mixed/fibonacci | 713.2ms | 758.5ms | 718.3ms |
| mixed/matrix-multiply | 905.2ms | 973.6ms | 799.2ms |
| mixed/sieve | 834.7ms | 942.3ms | — |
