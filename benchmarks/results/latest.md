# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.050ms | 0.014ms | 0.065ms | gc-native |
| string/split | 0.422ms | 4.50ms | 0.540ms | FAILED | js |
| string/replace | 0.096ms | 0.226ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.221ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.932ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.335ms | 0.308ms | 0.558ms | gc-native |
| array/push-pop | 1.64ms | 0.608ms | 0.602ms | FAILED | gc-native |
| array/sort-i32 | 0.850ms | 0.302ms | 0.512ms | FAILED | host-call |
| array/map-filter | 0.135ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.603ms | 0.602ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.036ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.538ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.134ms | — | — | js |
| dom/modify-text | 0.030ms | 0.123ms | — | — | js |
| mixed/csv-parse | 0.467ms | 6.47ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.36ms | 0.293ms | 1.12ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.315ms | 0.310ms | js |
| mixed/matrix-multiply | 0.186ms | 0.209ms | 0.209ms | 0.718ms | js |
| mixed/sieve | 1.76ms | 1.50ms | 1.48ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.38 | 4.94 | 4.33 | — |
| string/concat-long | 1000 | 4.29 | 5.38 | 3.44 | — |
| string/indexOf | 1000 | 19.04 | 59.75 | 12.19 | 16.73 |
| string/includes | 1000 | 18.76 | 49.93 | 13.83 | 65.35 |
| string/split | 10000 | 42.24 | 449.66 | 54.05 | — |
| string/replace | 1000 | 96.18 | 226.09 | 59.38 | — |
| string/case-convert | 2000 | 29.54 | 110.72 | 2.62 | — |
| string/substring | 10000 | 10.44 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.30 | 93.21 | 19.67 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 16.75 | 15.41 | 27.91 |
| array/map-filter | 30000 | 4.50 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4459.62 | 2861.17 | 2861.18 | — |
| dom/create-elements | 2000 | 19.14 | 77.07 | — | — |
| dom/set-attributes | 6000 | 18.32 | 89.69 | — | — |
| dom/read-attributes | 3000 | 19.98 | 44.63 | — | — |
| dom/modify-text | 2000 | 14.97 | 61.53 | — | — |
| mixed/csv-parse | 11000 | 42.49 | 588.43 | 27.92 | — |
| mixed/text-search | 40000 | 10.08 | 34.10 | 7.31 | 28.09 |
| mixed/fibonacci | 10000 | 12.53 | 31.52 | 31.51 | 30.98 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 8.80 | 7.48 | 7.39 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.28x slower | — |
| string/concat-long | 1.25x slower | 1.25x faster | — |
| string/indexOf | 3.14x slower | 1.56x faster | 1.14x faster |
| string/includes | 2.66x slower | 1.36x faster | 3.48x slower |
| string/split | 10.65x slower | 1.28x slower | — |
| string/replace | 2.35x slower | 1.62x faster | — |
| string/case-convert | 3.75x slower | 11.28x faster | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 5.39x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.35x slower |
| array/push-pop | 2.70x faster | 2.73x faster | — |
| array/sort-i32 | 2.82x faster | 1.66x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 3.97x faster | 3.97x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.26x faster | 2.15x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.83x faster | 1.82x faster | — |
| array/find | 18.16x faster | 18.40x faster | 4.43x slower |
| dom/create-elements | 4.03x slower | — | — |
| dom/set-attributes | 4.90x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 4.11x slower | — | — |
| mixed/csv-parse | 13.85x slower | 1.52x faster | — |
| mixed/text-search | 3.38x slower | 1.38x faster | 2.79x slower |
| mixed/fibonacci | 2.52x slower | 2.51x slower | 2.47x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.87x slower |
| mixed/sieve | 1.18x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.57x faster |
| string/indexOf | 4.90x faster |
| string/includes | 3.61x faster |
| string/split | 8.32x faster |
| string/replace | 3.81x faster |
| string/case-convert | 42.27x faster |
| string/substring | 1.16x faster |
| string/trim | 4.74x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.70x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 21.08x faster |
| mixed/text-search | 4.66x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| array/forEach | 2.5KB | 3.0KB | — |
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
| string/concat-short | 1234.0ms | 1058.6ms | — |
| string/concat-long | 641.7ms | 928.8ms | — |
| string/indexOf | 648.6ms | 951.3ms | 827.1ms |
| string/includes | 637.7ms | 943.4ms | 813.9ms |
| string/split | 777.7ms | 954.7ms | — |
| string/replace | 757.0ms | 1007.2ms | — |
| string/case-convert | 783.0ms | 843.1ms | — |
| string/substring | 661.0ms | 751.3ms | — |
| string/trim | 757.1ms | 978.4ms | — |
| string/startsWith-endsWith | 767.1ms | 956.9ms | 896.9ms |
| array/push-pop | 797.0ms | 834.1ms | — |
| array/sort-i32 | 882.9ms | 929.4ms | — |
| array/map-filter | 911.0ms | 1030.1ms | — |
| array/reduce | 813.3ms | 931.7ms | — |
| array/indexOf | 808.0ms | 886.5ms | — |
| array/slice | 761.1ms | 870.8ms | — |
| array/reverse | 761.8ms | 835.6ms | — |
| array/forEach | 873.6ms | 966.5ms | — |
| array/find | 768.7ms | 853.5ms | 861.7ms |
| dom/create-elements | 652.6ms | — | — |
| dom/set-attributes | 691.9ms | — | — |
| dom/read-attributes | 727.8ms | — | — |
| dom/modify-text | 592.6ms | — | — |
| mixed/csv-parse | 775.7ms | 925.8ms | — |
| mixed/text-search | 766.4ms | 974.3ms | 907.4ms |
| mixed/fibonacci | 767.1ms | 789.6ms | 781.9ms |
| mixed/matrix-multiply | 871.8ms | 927.2ms | 771.1ms |
| mixed/sieve | 833.1ms | 896.5ms | — |
