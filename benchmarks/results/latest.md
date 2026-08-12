# js2wasm Benchmark Results

Date: 2026-08-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.050ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.013ms | 0.038ms | gc-native |
| string/includes | 0.019ms | 0.106ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.451ms | 4.51ms | 0.506ms | FAILED | js |
| string/replace | 0.094ms | 0.215ms | 0.068ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.234ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.937ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.338ms | 0.311ms | 0.559ms | gc-native |
| array/push-pop | 1.63ms | 0.598ms | 0.597ms | FAILED | gc-native |
| array/sort-i32 | 0.840ms | 0.313ms | 0.307ms | FAILED | gc-native |
| array/map-filter | 0.137ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 2.37ms | 0.593ms | 0.594ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | host-call |
| dom/create-elements | 0.038ms | 0.153ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.527ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.133ms | — | — | js |
| dom/modify-text | 0.029ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.485ms | 6.82ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.36ms | 0.293ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.272ms | 0.273ms | 1.26ms | js |
| mixed/matrix-multiply | 0.184ms | 0.210ms | 0.210ms | 0.718ms | js |
| mixed/sieve | 1.77ms | 1.50ms | 1.49ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.29 | 4.98 | 4.21 | — |
| string/concat-long | 1000 | 4.32 | 4.99 | 3.57 | — |
| string/indexOf | 1000 | 18.95 | 62.89 | 12.56 | 38.49 |
| string/includes | 1000 | 18.74 | 105.57 | 14.37 | 16.56 |
| string/split | 10000 | 45.12 | 450.91 | 50.64 | — |
| string/replace | 1000 | 93.70 | 215.08 | 68.18 | — |
| string/case-convert | 2000 | 28.95 | 117.18 | 2.63 | — |
| string/substring | 10000 | 10.50 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.26 | 93.67 | 19.69 | — |
| string/startsWith-endsWith | 20000 | 20.64 | 16.92 | 15.57 | 27.94 |
| array/map-filter | 30000 | 4.57 | 2.16 | 2.16 | — |
| array/indexOf | 1000 | 4457.80 | 2863.08 | 2862.68 | — |
| dom/create-elements | 2000 | 19.02 | 76.59 | — | — |
| dom/set-attributes | 6000 | 18.01 | 87.78 | — | — |
| dom/read-attributes | 3000 | 19.31 | 44.26 | — | — |
| dom/modify-text | 2000 | 14.64 | 56.90 | — | — |
| mixed/csv-parse | 11000 | 44.13 | 620.34 | 27.93 | — |
| mixed/text-search | 40000 | 10.06 | 34.09 | 7.34 | 28.15 |
| mixed/fibonacci | 10000 | 12.53 | 27.23 | 27.29 | 126.27 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.68 | 1.68 | 5.74 |
| mixed/sieve | 200000 | 8.85 | 7.51 | 7.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.52x slower | 1.28x slower | — |
| string/concat-long | 1.16x slower | 1.21x faster | — |
| string/indexOf | 3.32x slower | 1.51x faster | 2.03x slower |
| string/includes | 5.63x slower | 1.30x faster | 1.13x faster |
| string/split | 9.99x slower | 1.12x slower | — |
| string/replace | 2.30x slower | 1.37x faster | — |
| string/case-convert | 4.05x slower | 11.00x faster | — |
| string/substring | 2.63x faster | 3.06x faster | — |
| string/trim | 5.43x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.22x faster | 1.33x faster | 1.35x slower |
| array/push-pop | 2.73x faster | 2.73x faster | — |
| array/sort-i32 | 2.69x faster | 2.74x faster | — |
| array/map-filter | 2.12x faster | 2.12x faster | — |
| array/reduce | 4.00x faster | 4.00x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.02x faster | 2.01x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.84x faster | — |
| array/find | 18.45x faster | 18.37x faster | 4.44x slower |
| dom/create-elements | 4.03x slower | — | — |
| dom/set-attributes | 4.87x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.89x slower | — | — |
| mixed/csv-parse | 14.06x slower | 1.58x faster | — |
| mixed/text-search | 3.39x slower | 1.37x faster | 2.80x slower |
| mixed/fibonacci | 2.17x slower | 2.18x slower | 10.07x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.89x slower |
| mixed/sieve | 1.18x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.40x faster |
| string/indexOf | 5.01x faster |
| string/includes | 7.35x faster |
| string/split | 8.90x faster |
| string/replace | 3.15x faster |
| string/case-convert | 44.52x faster |
| string/substring | 1.16x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 22.21x faster |
| mixed/text-search | 4.65x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
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
| mixed/fibonacci | 348B | 348B | 340B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1232.6ms | 1072.0ms | — |
| string/concat-long | 610.6ms | 962.8ms | — |
| string/indexOf | 745.4ms | 1010.6ms | 827.8ms |
| string/includes | 749.4ms | 982.7ms | 818.9ms |
| string/split | 709.5ms | 933.8ms | — |
| string/replace | 796.5ms | 1025.9ms | — |
| string/case-convert | 810.3ms | 839.0ms | — |
| string/substring | 623.8ms | 710.2ms | — |
| string/trim | 711.8ms | 933.2ms | — |
| string/startsWith-endsWith | 719.1ms | 952.9ms | 856.8ms |
| array/push-pop | 756.8ms | 804.1ms | — |
| array/sort-i32 | 898.6ms | 955.4ms | — |
| array/map-filter | 857.2ms | 957.0ms | — |
| array/reduce | 801.0ms | 845.8ms | — |
| array/indexOf | 859.0ms | 919.3ms | — |
| array/slice | 722.1ms | 769.8ms | — |
| array/reverse | 743.6ms | 793.7ms | — |
| array/forEach | 808.3ms | 872.4ms | — |
| array/find | 738.9ms | 814.5ms | 797.0ms |
| dom/create-elements | 593.9ms | — | — |
| dom/set-attributes | 713.2ms | — | — |
| dom/read-attributes | 675.4ms | — | — |
| dom/modify-text | 588.5ms | — | — |
| mixed/csv-parse | 775.4ms | 931.0ms | — |
| mixed/text-search | 729.4ms | 944.3ms | 871.1ms |
| mixed/fibonacci | 774.5ms | 853.8ms | 751.5ms |
| mixed/matrix-multiply | 826.6ms | 847.6ms | 767.0ms |
| mixed/sieve | 802.7ms | 853.6ms | — |
