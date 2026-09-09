# js2wasm Benchmark Results

Date: 2026-09-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.055ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.025ms | gc-native |
| string/includes | 0.019ms | 0.102ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.421ms | 7.72ms | 2.60ms | FAILED | js |
| string/replace | 0.099ms | 0.570ms | 0.276ms | FAILED | js |
| string/case-convert | 0.058ms | 0.548ms | 0.239ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.33ms | 2.34ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.45ms | 2.45ms | 0.560ms | js |
| array/push-pop | 1.65ms | 0.596ms | 0.599ms | FAILED | host-call |
| array/sort-i32 | 0.848ms | 0.298ms | 0.300ms | FAILED | host-call |
| array/map-filter | 0.136ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.62ms | 0.598ms | 0.600ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.093ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.039ms | 0.165ms | — | — | js |
| dom/set-attributes | 0.111ms | 0.518ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.136ms | — | — | js |
| dom/modify-text | 0.030ms | 0.119ms | — | — | js |
| mixed/csv-parse | 0.466ms | 8.27ms | 1.10ms | FAILED | js |
| mixed/text-search | 0.403ms | 3.76ms | 2.41ms | 1.11ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.334ms | js |
| mixed/matrix-multiply | 0.185ms | 65.24ms | 66.36ms | 0.720ms | js |
| mixed/sieve | 1.81ms | 2.29ms | 2.29ms | FAILED | js |

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
| string/concat-short | 10000 | 3.45 | 5.45 | 5.01 | — |
| string/concat-long | 1000 | 4.18 | 5.36 | 3.63 | — |
| string/indexOf | 1000 | 19.37 | 60.23 | 12.31 | 25.36 |
| string/includes | 1000 | 19.16 | 102.28 | 13.78 | 16.63 |
| string/split | 10000 | 42.11 | 772.43 | 260.26 | — |
| string/replace | 1000 | 99.42 | 570.26 | 275.95 | — |
| string/case-convert | 2000 | 28.99 | 273.96 | 119.35 | — |
| string/substring | 10000 | 10.46 | 3.98 | 3.44 | — |
| string/trim | 10000 | 17.31 | 332.74 | 234.16 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 122.45 | 122.42 | 27.98 |
| array/map-filter | 30000 | 4.52 | 2.22 | 2.19 | — |
| array/indexOf | 1000 | 4457.22 | 2862.90 | 2861.79 | — |
| dom/create-elements | 2000 | 19.54 | 82.69 | — | — |
| dom/set-attributes | 6000 | 18.44 | 86.26 | — | — |
| dom/read-attributes | 3000 | 20.00 | 45.41 | — | — |
| dom/modify-text | 2000 | 15.04 | 59.62 | — | — |
| mixed/csv-parse | 11000 | 42.40 | 751.53 | 99.60 | — |
| mixed/text-search | 40000 | 10.07 | 93.94 | 60.22 | 27.72 |
| mixed/fibonacci | 10000 | 12.53 | 32.75 | 32.79 | 33.39 |
| mixed/matrix-multiply | 125000 | 1.48 | 521.96 | 530.88 | 5.76 |
| mixed/sieve | 200000 | 9.05 | 11.46 | 11.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.45x slower | — |
| string/concat-long | 1.28x slower | 1.15x faster | — |
| string/indexOf | 3.11x slower | 1.57x faster | 1.31x slower |
| string/includes | 5.34x slower | 1.39x faster | 1.15x faster |
| string/split | 18.35x slower | 6.18x slower | — |
| string/replace | 5.74x slower | 2.78x slower | — |
| string/case-convert | 9.45x slower | 4.12x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.22x slower | 13.53x slower | — |
| string/startsWith-endsWith | 5.94x slower | 5.93x slower | 1.36x slower |
| array/push-pop | 2.78x faster | 2.76x faster | — |
| array/sort-i32 | 2.84x faster | 2.82x faster | — |
| array/map-filter | 2.04x faster | 2.06x faster | — |
| array/reduce | 2.71x faster | 2.70x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.21x faster | 2.11x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.23x faster | 3.26x faster | — |
| array/find | 17.88x faster | 18.08x faster | 4.43x slower |
| dom/create-elements | 4.23x slower | — | — |
| dom/set-attributes | 4.68x slower | — | — |
| dom/read-attributes | 2.27x slower | — | — |
| dom/modify-text | 3.96x slower | — | — |
| mixed/csv-parse | 17.73x slower | 2.35x slower | — |
| mixed/text-search | 9.33x slower | 5.98x slower | 2.75x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.67x slower |
| mixed/matrix-multiply | 352.68x slower | 358.71x slower | 3.89x slower |
| mixed/sieve | 1.27x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.48x faster |
| string/indexOf | 4.89x faster |
| string/includes | 7.42x faster |
| string/split | 2.97x faster |
| string/replace | 2.07x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.16x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 7.55x faster |
| mixed/text-search | 1.56x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
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
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
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
| string/concat-short | 1619.8ms | 1047.9ms | — |
| string/concat-long | 749.1ms | 946.5ms | — |
| string/indexOf | 657.1ms | 940.6ms | 823.1ms |
| string/includes | 654.5ms | 944.3ms | 820.1ms |
| string/split | 757.4ms | 970.7ms | — |
| string/replace | 817.3ms | 1060.1ms | — |
| string/case-convert | 779.5ms | 887.1ms | — |
| string/substring | 665.3ms | 751.8ms | — |
| string/trim | 753.5ms | 934.2ms | — |
| string/startsWith-endsWith | 765.3ms | 975.4ms | 874.4ms |
| array/push-pop | 784.5ms | 853.8ms | — |
| array/sort-i32 | 924.4ms | 971.8ms | — |
| array/map-filter | 930.5ms | 1036.4ms | — |
| array/reduce | 896.9ms | 848.8ms | — |
| array/indexOf | 859.6ms | 929.9ms | — |
| array/slice | 772.8ms | 880.4ms | — |
| array/reverse | 809.5ms | 880.5ms | — |
| array/forEach | 909.6ms | 1001.2ms | — |
| array/find | 781.2ms | 845.3ms | 818.6ms |
| dom/create-elements | 733.4ms | — | — |
| dom/set-attributes | 721.7ms | — | — |
| dom/read-attributes | 710.7ms | — | — |
| dom/modify-text | 702.9ms | — | — |
| mixed/csv-parse | 798.1ms | 932.7ms | — |
| mixed/text-search | 781.0ms | 931.0ms | 922.6ms |
| mixed/fibonacci | 777.0ms | 789.9ms | 793.4ms |
| mixed/matrix-multiply | 900.5ms | 970.1ms | 791.1ms |
| mixed/sieve | 849.7ms | 924.8ms | — |
