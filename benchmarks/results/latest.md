# js2wasm Benchmark Results

Date: 2026-09-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.049ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.020ms | gc-native |
| string/includes | 0.019ms | 0.137ms | 0.015ms | 0.027ms | gc-native |
| string/split | 0.427ms | 8.33ms | 2.89ms | FAILED | js |
| string/replace | 0.106ms | 0.668ms | 0.325ms | FAILED | js |
| string/case-convert | 0.056ms | 0.599ms | 0.253ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 3.87ms | 2.70ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.81ms | 2.93ms | 0.563ms | js |
| array/push-pop | 1.43ms | 0.516ms | 0.519ms | FAILED | host-call |
| array/sort-i32 | 0.791ms | 0.462ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 1.42ms | 0.507ms | 0.512ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.037ms | 0.153ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.507ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.127ms | — | — | js |
| dom/modify-text | 0.030ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.473ms | 8.73ms | 0.916ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.70ms | 2.87ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 76.35ms | 75.80ms | 0.725ms | js |
| mixed/sieve | 1.62ms | 2.16ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.47 | 4.89 | 4.65 | — |
| string/concat-long | 1000 | 3.53 | 4.51 | 3.84 | — |
| string/indexOf | 1000 | 19.20 | 63.59 | 12.09 | 19.54 |
| string/includes | 1000 | 19.19 | 136.99 | 14.76 | 27.21 |
| string/split | 10000 | 42.72 | 832.97 | 289.12 | — |
| string/replace | 1000 | 106.40 | 668.33 | 324.88 | — |
| string/case-convert | 2000 | 27.82 | 299.61 | 126.45 | — |
| string/substring | 10000 | 9.89 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.14 | 387.07 | 269.78 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 140.28 | 146.35 | 28.15 |
| array/map-filter | 30000 | 4.25 | 2.38 | 2.37 | — |
| array/indexOf | 1000 | 3954.06 | 2646.29 | 2644.33 | — |
| dom/create-elements | 2000 | 18.55 | 76.69 | — | — |
| dom/set-attributes | 6000 | 17.36 | 84.44 | — | — |
| dom/read-attributes | 3000 | 18.15 | 42.33 | — | — |
| dom/modify-text | 2000 | 14.96 | 57.26 | — | — |
| mixed/csv-parse | 11000 | 43.00 | 793.66 | 83.23 | — |
| mixed/text-search | 40000 | 9.75 | 117.51 | 71.85 | 26.90 |
| mixed/fibonacci | 10000 | 12.17 | 28.33 | 28.33 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 610.82 | 606.37 | 5.80 |
| mixed/sieve | 200000 | 8.12 | 10.82 | 10.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.41x slower | 1.34x slower | — |
| string/concat-long | 1.28x slower | 1.09x slower | — |
| string/indexOf | 3.31x slower | 1.59x faster | 1.02x slower |
| string/includes | 7.14x slower | 1.30x faster | 1.42x slower |
| string/split | 19.50x slower | 6.77x slower | — |
| string/replace | 6.28x slower | 3.05x slower | — |
| string/case-convert | 10.77x slower | 4.55x slower | — |
| string/substring | 2.65x faster | 3.21x faster | — |
| string/trim | 22.58x slower | 15.74x slower | — |
| string/startsWith-endsWith | 7.00x slower | 7.30x slower | 1.40x slower |
| array/push-pop | 2.78x faster | 2.76x faster | — |
| array/sort-i32 | 1.71x faster | 2.69x faster | — |
| array/map-filter | 1.79x faster | 1.79x faster | — |
| array/reduce | 2.80x faster | 2.77x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.04x slower | 1.01x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.77x faster | — |
| array/find | 15.65x faster | 15.87x faster | 4.25x slower |
| dom/create-elements | 4.13x slower | — | — |
| dom/set-attributes | 4.86x slower | — | — |
| dom/read-attributes | 2.33x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 18.46x slower | 1.94x slower | — |
| mixed/text-search | 12.05x slower | 7.37x slower | 2.76x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 482.52x slower | 479.00x slower | 4.58x slower |
| mixed/sieve | 1.33x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.17x faster |
| string/indexOf | 5.26x faster |
| string/includes | 9.28x faster |
| string/split | 2.88x faster |
| string/replace | 2.06x faster |
| string/case-convert | 2.37x faster |
| string/substring | 1.21x faster |
| string/trim | 1.43x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.57x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 9.54x faster |
| mixed/text-search | 1.64x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.02x faster |

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
| string/concat-short | 1720.1ms | 1111.1ms | — |
| string/concat-long | 789.6ms | 986.0ms | — |
| string/indexOf | 681.7ms | 968.1ms | 848.7ms |
| string/includes | 686.2ms | 913.8ms | 839.6ms |
| string/split | 801.2ms | 995.7ms | — |
| string/replace | 829.4ms | 1075.5ms | — |
| string/case-convert | 788.6ms | 894.8ms | — |
| string/substring | 683.6ms | 768.8ms | — |
| string/trim | 801.6ms | 1000.1ms | — |
| string/startsWith-endsWith | 784.6ms | 1035.5ms | 924.8ms |
| array/push-pop | 828.1ms | 912.7ms | — |
| array/sort-i32 | 949.7ms | 1078.4ms | — |
| array/map-filter | 972.9ms | 1053.6ms | — |
| array/reduce | 937.1ms | 1023.4ms | — |
| array/indexOf | 878.1ms | 985.1ms | — |
| array/slice | 797.1ms | 904.3ms | — |
| array/reverse | 790.1ms | 843.7ms | — |
| array/forEach | 940.5ms | 1017.0ms | — |
| array/find | 773.7ms | 877.2ms | 865.0ms |
| dom/create-elements | 736.0ms | — | — |
| dom/set-attributes | 747.7ms | — | — |
| dom/read-attributes | 708.0ms | — | — |
| dom/modify-text | 707.3ms | — | — |
| mixed/csv-parse | 824.2ms | 998.7ms | — |
| mixed/text-search | 808.1ms | 1041.8ms | 981.5ms |
| mixed/fibonacci | 800.1ms | 854.9ms | 801.7ms |
| mixed/matrix-multiply | 922.9ms | 1035.0ms | 837.8ms |
| mixed/sieve | 906.7ms | 1017.7ms | — |
