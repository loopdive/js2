# js2wasm Benchmark Results

Date: 2026-08-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.052ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.013ms | 0.021ms | gc-native |
| string/includes | 0.019ms | 0.106ms | 0.014ms | 0.065ms | gc-native |
| string/split | 0.424ms | 4.52ms | 0.505ms | FAILED | js |
| string/replace | 0.097ms | 0.227ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.224ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.174ms | 0.935ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.343ms | 0.308ms | 0.553ms | gc-native |
| array/push-pop | 1.71ms | 0.610ms | 0.609ms | FAILED | gc-native |
| array/sort-i32 | 0.837ms | 0.311ms | 0.548ms | FAILED | host-call |
| array/map-filter | 0.139ms | 0.067ms | 0.067ms | FAILED | host-call |
| array/reduce | 2.42ms | 0.608ms | 0.620ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.041ms | 0.019ms | 0.018ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.055ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.20ms | host-call |
| dom/create-elements | 0.043ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.111ms | 0.543ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.134ms | — | — | js |
| dom/modify-text | 0.033ms | 0.116ms | — | — | js |
| mixed/csv-parse | 0.467ms | 7.07ms | 0.309ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.43ms | 0.293ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.306ms | 0.306ms | 1.27ms | js |
| mixed/matrix-multiply | 0.188ms | 0.210ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.85ms | 1.51ms | 1.52ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.65 | 5.19 | 4.52 | — |
| string/concat-long | 1000 | 4.45 | 5.44 | 3.81 | — |
| string/indexOf | 1000 | 19.02 | 60.24 | 12.70 | 20.87 |
| string/includes | 1000 | 18.76 | 105.71 | 14.15 | 65.47 |
| string/split | 10000 | 42.37 | 452.17 | 50.52 | — |
| string/replace | 1000 | 96.98 | 227.26 | 59.83 | — |
| string/case-convert | 2000 | 29.28 | 111.87 | 2.62 | — |
| string/substring | 10000 | 10.51 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.36 | 93.51 | 19.67 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 17.16 | 15.41 | 27.66 |
| array/map-filter | 30000 | 4.63 | 2.22 | 2.22 | — |
| array/indexOf | 1000 | 4461.46 | 2862.44 | 2863.05 | — |
| dom/create-elements | 2000 | 21.26 | 77.65 | — | — |
| dom/set-attributes | 6000 | 18.43 | 90.42 | — | — |
| dom/read-attributes | 3000 | 19.97 | 44.58 | — | — |
| dom/modify-text | 2000 | 16.64 | 57.80 | — | — |
| mixed/csv-parse | 11000 | 42.46 | 642.87 | 28.06 | — |
| mixed/text-search | 40000 | 10.08 | 35.73 | 7.31 | 27.43 |
| mixed/fibonacci | 10000 | 12.53 | 30.57 | 30.65 | 126.88 |
| mixed/matrix-multiply | 125000 | 1.50 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 9.23 | 7.55 | 7.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.24x slower | — |
| string/concat-long | 1.22x slower | 1.17x faster | — |
| string/indexOf | 3.17x slower | 1.50x faster | 1.10x slower |
| string/includes | 5.64x slower | 1.33x faster | 3.49x slower |
| string/split | 10.67x slower | 1.19x slower | — |
| string/replace | 2.34x slower | 1.62x faster | — |
| string/case-convert | 3.82x slower | 11.18x faster | — |
| string/substring | 2.64x faster | 3.06x faster | — |
| string/trim | 5.38x slower | 1.13x slower | — |
| string/startsWith-endsWith | 1.20x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.81x faster | 2.82x faster | — |
| array/sort-i32 | 2.69x faster | 1.53x faster | — |
| array/map-filter | 2.09x faster | 2.08x faster | — |
| array/reduce | 3.99x faster | 3.90x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.17x faster | 2.24x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.90x faster | 1.89x faster | — |
| array/find | 18.24x faster | 18.19x faster | 4.40x slower |
| dom/create-elements | 3.65x slower | — | — |
| dom/set-attributes | 4.91x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 3.47x slower | — | — |
| mixed/csv-parse | 15.14x slower | 1.51x faster | — |
| mixed/text-search | 3.55x slower | 1.38x faster | 2.72x slower |
| mixed/fibonacci | 2.44x slower | 2.45x slower | 10.13x slower |
| mixed/matrix-multiply | 1.12x slower | 1.12x slower | 3.83x slower |
| mixed/sieve | 1.22x faster | 1.22x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.74x faster |
| string/includes | 7.47x faster |
| string/split | 8.95x faster |
| string/replace | 3.80x faster |
| string/case-convert | 42.70x faster |
| string/substring | 1.16x faster |
| string/trim | 4.75x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.76x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 22.91x faster |
| mixed/text-search | 4.89x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1278.2ms | 1081.9ms | — |
| string/concat-long | 651.4ms | 990.6ms | — |
| string/indexOf | 682.1ms | 994.3ms | 871.8ms |
| string/includes | 668.6ms | 1036.2ms | 864.7ms |
| string/split | 809.1ms | 978.3ms | — |
| string/replace | 797.2ms | 1059.8ms | — |
| string/case-convert | 792.4ms | 858.5ms | — |
| string/substring | 677.7ms | 771.3ms | — |
| string/trim | 791.4ms | 975.6ms | — |
| string/startsWith-endsWith | 778.3ms | 1015.3ms | 910.7ms |
| array/push-pop | 801.0ms | 854.0ms | — |
| array/sort-i32 | 937.6ms | 1020.7ms | — |
| array/map-filter | 971.2ms | 1026.8ms | — |
| array/reduce | 861.4ms | 972.4ms | — |
| array/indexOf | 858.1ms | 915.7ms | — |
| array/slice | 785.1ms | 845.9ms | — |
| array/reverse | 773.4ms | 842.2ms | — |
| array/forEach | 907.0ms | 960.8ms | — |
| array/find | 767.1ms | 851.9ms | 831.1ms |
| dom/create-elements | 622.7ms | — | — |
| dom/set-attributes | 726.2ms | — | — |
| dom/read-attributes | 708.1ms | — | — |
| dom/modify-text | 603.7ms | — | — |
| mixed/csv-parse | 817.9ms | 962.6ms | — |
| mixed/text-search | 774.5ms | 1011.1ms | 902.4ms |
| mixed/fibonacci | 756.8ms | 783.2ms | 823.8ms |
| mixed/matrix-multiply | 888.1ms | 930.5ms | 806.7ms |
| mixed/sieve | 892.8ms | 925.3ms | — |
