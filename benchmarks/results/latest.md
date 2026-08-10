# js2wasm Benchmark Results

Date: 2026-08-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.045ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.013ms | 0.020ms | gc-native |
| string/includes | 0.019ms | 0.104ms | 0.015ms | 0.041ms | gc-native |
| string/split | 0.421ms | 4.46ms | 0.505ms | FAILED | js |
| string/replace | 0.097ms | 0.221ms | 0.069ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.226ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.925ms | 0.196ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.343ms | 0.311ms | 0.560ms | gc-native |
| array/push-pop | 1.70ms | 0.608ms | 0.611ms | FAILED | host-call |
| array/sort-i32 | 0.844ms | 0.473ms | 0.311ms | FAILED | gc-native |
| array/map-filter | 0.138ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.47ms | 0.609ms | 0.613ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.87ms | FAILED | host-call |
| array/slice | 0.039ms | 0.017ms | 0.018ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.98ms | 3.98ms | FAILED | host-call |
| array/forEach | 0.055ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.273ms | 0.016ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.039ms | 0.156ms | — | — | js |
| dom/set-attributes | 0.115ms | 0.559ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.136ms | — | — | js |
| dom/modify-text | 0.030ms | 0.115ms | — | — | js |
| mixed/csv-parse | 1.14ms | 6.73ms | 0.308ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.37ms | 0.293ms | 1.11ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.273ms | 0.273ms | 0.283ms | js |
| mixed/matrix-multiply | 0.191ms | 0.211ms | 0.211ms | 0.726ms | js |
| mixed/sieve | 1.86ms | 1.49ms | 1.47ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.03 | 4.54 | 4.29 | — |
| string/concat-long | 1000 | 4.18 | 5.43 | 3.75 | — |
| string/indexOf | 1000 | 19.00 | 60.86 | 12.63 | 20.14 |
| string/includes | 1000 | 18.75 | 103.82 | 15.24 | 41.17 |
| string/split | 10000 | 42.14 | 446.31 | 50.46 | — |
| string/replace | 1000 | 96.97 | 220.72 | 69.33 | — |
| string/case-convert | 2000 | 29.01 | 113.11 | 2.61 | — |
| string/substring | 10000 | 10.48 | 4.00 | 3.44 | — |
| string/trim | 10000 | 17.34 | 92.53 | 19.64 | — |
| string/startsWith-endsWith | 20000 | 20.61 | 17.13 | 15.56 | 28.00 |
| array/map-filter | 30000 | 4.60 | 2.21 | 2.20 | — |
| array/indexOf | 1000 | 4464.15 | 2863.73 | 2865.42 | — |
| dom/create-elements | 2000 | 19.74 | 77.96 | — | — |
| dom/set-attributes | 6000 | 19.16 | 93.17 | — | — |
| dom/read-attributes | 3000 | 20.87 | 45.41 | — | — |
| dom/modify-text | 2000 | 14.90 | 57.43 | — | — |
| mixed/csv-parse | 11000 | 103.35 | 611.60 | 28.00 | — |
| mixed/text-search | 40000 | 10.07 | 34.29 | 7.32 | 27.82 |
| mixed/fibonacci | 10000 | 12.53 | 27.31 | 27.29 | 28.26 |
| mixed/matrix-multiply | 125000 | 1.52 | 1.69 | 1.69 | 5.81 |
| mixed/sieve | 200000 | 9.31 | 7.47 | 7.36 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.42x slower | — |
| string/concat-long | 1.30x slower | 1.11x faster | — |
| string/indexOf | 3.20x slower | 1.50x faster | 1.06x slower |
| string/includes | 5.54x slower | 1.23x faster | 2.20x slower |
| string/split | 10.59x slower | 1.20x slower | — |
| string/replace | 2.28x slower | 1.40x faster | — |
| string/case-convert | 3.90x slower | 11.10x faster | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 5.34x slower | 1.13x slower | — |
| string/startsWith-endsWith | 1.20x faster | 1.32x faster | 1.36x slower |
| array/push-pop | 2.79x faster | 2.77x faster | — |
| array/sort-i32 | 1.78x faster | 2.72x faster | — |
| array/map-filter | 2.08x faster | 2.09x faster | — |
| array/reduce | 4.06x faster | 4.04x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.28x faster | 2.18x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.89x faster | 1.90x faster | — |
| array/find | 17.53x faster | 18.26x faster | 4.43x slower |
| dom/create-elements | 3.95x slower | — | — |
| dom/set-attributes | 4.86x slower | — | — |
| dom/read-attributes | 2.18x slower | — | — |
| dom/modify-text | 3.86x slower | — | — |
| mixed/csv-parse | 5.92x slower | 3.69x faster | — |
| mixed/text-search | 3.40x slower | 1.38x faster | 2.76x slower |
| mixed/fibonacci | 2.18x slower | 2.18x slower | 2.26x slower |
| mixed/matrix-multiply | 1.11x slower | 1.11x slower | 3.81x slower |
| mixed/sieve | 1.25x faster | 1.27x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.82x faster |
| string/includes | 6.81x faster |
| string/split | 8.84x faster |
| string/replace | 3.18x faster |
| string/case-convert | 43.28x faster |
| string/substring | 1.16x faster |
| string/trim | 4.71x faster |
| string/startsWith-endsWith | 1.10x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.52x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.04x faster |
| mixed/csv-parse | 21.84x faster |
| mixed/text-search | 4.68x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 350B | 350B | 342B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1250.6ms | 1142.8ms | — |
| string/concat-long | 651.2ms | 999.2ms | — |
| string/indexOf | 777.2ms | 1044.3ms | 829.8ms |
| string/includes | 785.9ms | 1003.7ms | 855.3ms |
| string/split | 757.8ms | 989.7ms | — |
| string/replace | 855.6ms | 1105.2ms | — |
| string/case-convert | 796.5ms | 869.5ms | — |
| string/substring | 669.8ms | 786.6ms | — |
| string/trim | 748.7ms | 986.9ms | — |
| string/startsWith-endsWith | 765.7ms | 979.3ms | 921.2ms |
| array/push-pop | 793.7ms | 862.6ms | — |
| array/sort-i32 | 940.9ms | 1049.9ms | — |
| array/map-filter | 943.6ms | 1026.9ms | — |
| array/reduce | 832.3ms | 895.9ms | — |
| array/indexOf | 941.8ms | 983.2ms | — |
| array/slice | 786.9ms | 839.8ms | — |
| array/reverse | 786.0ms | 849.9ms | — |
| array/forEach | 871.6ms | 970.5ms | — |
| array/find | 753.6ms | 849.4ms | 911.6ms |
| dom/create-elements | 639.9ms | — | — |
| dom/set-attributes | 709.6ms | — | — |
| dom/read-attributes | 702.2ms | — | — |
| dom/modify-text | 618.4ms | — | — |
| mixed/csv-parse | 780.0ms | 1015.5ms | — |
| mixed/text-search | 751.3ms | 983.4ms | 887.0ms |
| mixed/fibonacci | 809.3ms | 906.9ms | 840.4ms |
| mixed/matrix-multiply | 840.5ms | 906.9ms | 808.0ms |
| mixed/sieve | 838.0ms | 912.9ms | — |
