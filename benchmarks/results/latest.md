# js2wasm Benchmark Results

Date: 2026-08-19
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.050ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.059ms | 0.012ms | 0.061ms | gc-native |
| string/includes | 0.019ms | 0.042ms | 0.014ms | 0.066ms | gc-native |
| string/split | 0.417ms | 4.34ms | 0.515ms | FAILED | js |
| string/replace | 0.095ms | 0.212ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.221ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.925ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.336ms | 0.308ms | 0.571ms | gc-native |
| array/push-pop | 1.67ms | 0.590ms | 0.603ms | FAILED | host-call |
| array/sort-i32 | 0.840ms | 0.306ms | 0.298ms | FAILED | gc-native |
| array/map-filter | 0.136ms | 0.066ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.58ms | 0.598ms | 0.600ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.036ms | 0.017ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.094ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.037ms | 0.164ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.198ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.128ms | — | — | js |
| dom/modify-text | 0.030ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.948ms | 6.46ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.30ms | 0.292ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.306ms | 0.315ms | 0.302ms | js |
| mixed/matrix-multiply | 0.185ms | 0.210ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.73ms | 1.48ms | 1.49ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.28 | 5.03 | 4.15 | — |
| string/concat-long | 1000 | 4.17 | 5.35 | 3.39 | — |
| string/indexOf | 1000 | 18.97 | 59.50 | 12.19 | 60.67 |
| string/includes | 1000 | 18.74 | 41.91 | 13.78 | 66.28 |
| string/split | 10000 | 41.65 | 433.58 | 51.53 | — |
| string/replace | 1000 | 95.09 | 211.66 | 59.59 | — |
| string/case-convert | 2000 | 29.15 | 110.44 | 2.61 | — |
| string/substring | 10000 | 10.44 | 4.00 | 3.43 | — |
| string/trim | 10000 | 17.29 | 92.46 | 19.68 | — |
| string/startsWith-endsWith | 20000 | 20.62 | 16.79 | 15.39 | 28.56 |
| array/map-filter | 30000 | 4.52 | 2.19 | 2.18 | — |
| array/indexOf | 1000 | 4456.55 | 2860.24 | 2860.37 | — |
| dom/create-elements | 2000 | 18.70 | 82.18 | — | — |
| dom/set-attributes | 6000 | 18.11 | 32.97 | — | — |
| dom/read-attributes | 3000 | 19.50 | 42.69 | — | — |
| dom/modify-text | 2000 | 14.82 | 55.76 | — | — |
| mixed/csv-parse | 11000 | 86.18 | 587.56 | 27.86 | — |
| mixed/text-search | 40000 | 10.07 | 32.52 | 7.31 | 28.23 |
| mixed/fibonacci | 10000 | 12.53 | 30.59 | 31.47 | 30.24 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 8.65 | 7.38 | 7.44 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.26x slower | — |
| string/concat-long | 1.28x slower | 1.23x faster | — |
| string/indexOf | 3.14x slower | 1.56x faster | 3.20x slower |
| string/includes | 2.24x slower | 1.36x faster | 3.54x slower |
| string/split | 10.41x slower | 1.24x slower | — |
| string/replace | 2.23x slower | 1.60x faster | — |
| string/case-convert | 3.79x slower | 11.16x faster | — |
| string/substring | 2.61x faster | 3.04x faster | — |
| string/trim | 5.35x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.38x slower |
| array/push-pop | 2.83x faster | 2.77x faster | — |
| array/sort-i32 | 2.74x faster | 2.82x faster | — |
| array/map-filter | 2.07x faster | 2.08x faster | — |
| array/reduce | 2.64x faster | 2.63x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.13x faster | 2.27x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.27x faster | 3.28x faster | — |
| array/find | 18.39x faster | 18.37x faster | 4.46x slower |
| dom/create-elements | 4.40x slower | — | — |
| dom/set-attributes | 1.82x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 6.82x slower | 3.09x faster | — |
| mixed/text-search | 3.23x slower | 1.38x faster | 2.80x slower |
| mixed/fibonacci | 2.44x slower | 2.51x slower | 2.41x slower |
| mixed/matrix-multiply | 1.13x slower | 1.14x slower | 3.88x slower |
| mixed/sieve | 1.17x faster | 1.16x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.58x faster |
| string/indexOf | 4.88x faster |
| string/includes | 3.04x faster |
| string/split | 8.41x faster |
| string/replace | 3.55x faster |
| string/case-convert | 42.27x faster |
| string/substring | 1.17x faster |
| string/trim | 4.70x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.07x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 21.09x faster |
| mixed/text-search | 4.45x faster |
| mixed/fibonacci | 1.03x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

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
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
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
| string/concat-short | 1273.5ms | 1047.6ms | — |
| string/concat-long | 615.3ms | 899.2ms | — |
| string/indexOf | 667.7ms | 967.2ms | 818.6ms |
| string/includes | 692.2ms | 957.0ms | 814.9ms |
| string/split | 749.1ms | 955.8ms | — |
| string/replace | 761.2ms | 1069.0ms | — |
| string/case-convert | 746.0ms | 829.2ms | — |
| string/substring | 638.7ms | 748.3ms | — |
| string/trim | 756.1ms | 918.1ms | — |
| string/startsWith-endsWith | 735.9ms | 948.4ms | 891.7ms |
| array/push-pop | 748.5ms | 817.2ms | — |
| array/sort-i32 | 882.4ms | 932.5ms | — |
| array/map-filter | 916.0ms | 949.1ms | — |
| array/reduce | 845.6ms | 878.9ms | — |
| array/indexOf | 835.7ms | 894.7ms | — |
| array/slice | 751.1ms | 830.1ms | — |
| array/reverse | 736.5ms | 849.1ms | — |
| array/forEach | 872.8ms | 927.4ms | — |
| array/find | 725.7ms | 844.3ms | 807.1ms |
| dom/create-elements | 601.4ms | — | — |
| dom/set-attributes | 694.8ms | — | — |
| dom/read-attributes | 670.8ms | — | — |
| dom/modify-text | 582.3ms | — | — |
| mixed/csv-parse | 787.8ms | 927.6ms | — |
| mixed/text-search | 737.2ms | 929.2ms | 851.7ms |
| mixed/fibonacci | 728.9ms | 770.9ms | 764.0ms |
| mixed/matrix-multiply | 799.0ms | 869.0ms | 779.5ms |
| mixed/sieve | 843.7ms | 880.1ms | — |
