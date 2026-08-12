# js2wasm Benchmark Results

Date: 2026-08-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.013ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.110ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.421ms | 4.38ms | 0.504ms | FAILED | js |
| string/replace | 0.097ms | 0.229ms | 0.069ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.235ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.933ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.335ms | 0.308ms | 0.554ms | gc-native |
| array/push-pop | 1.64ms | 0.596ms | 0.594ms | FAILED | gc-native |
| array/sort-i32 | 0.845ms | 0.307ms | 0.435ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 2.38ms | 0.600ms | 0.593ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.035ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.83ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | host-call |
| dom/create-elements | 0.048ms | 0.147ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.488ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.112ms | — | — | js |
| mixed/csv-parse | 0.969ms | 6.81ms | 0.308ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.30ms | 0.292ms | 1.14ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.273ms | 0.273ms | 0.282ms | js |
| mixed/matrix-multiply | 0.185ms | 0.209ms | 0.209ms | 0.717ms | js |
| mixed/sieve | 1.75ms | 1.48ms | 1.49ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.35 | 4.87 | 4.30 | — |
| string/concat-long | 1000 | 4.08 | 5.04 | 3.55 | — |
| string/indexOf | 1000 | 18.97 | 60.51 | 12.51 | 16.61 |
| string/includes | 1000 | 18.71 | 109.60 | 14.26 | 16.57 |
| string/split | 10000 | 42.10 | 438.06 | 50.43 | — |
| string/replace | 1000 | 96.54 | 228.82 | 68.57 | — |
| string/case-convert | 2000 | 28.97 | 117.48 | 2.61 | — |
| string/substring | 10000 | 10.41 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.27 | 93.30 | 19.66 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 16.76 | 15.41 | 27.72 |
| array/map-filter | 30000 | 4.48 | 2.17 | 2.17 | — |
| array/indexOf | 1000 | 4457.00 | 2864.41 | 2864.38 | — |
| dom/create-elements | 2000 | 23.93 | 73.40 | — | — |
| dom/set-attributes | 6000 | 17.83 | 81.37 | — | — |
| dom/read-attributes | 3000 | 19.44 | 44.52 | — | — |
| dom/modify-text | 2000 | 14.58 | 55.94 | — | — |
| mixed/csv-parse | 11000 | 88.13 | 618.97 | 28.01 | — |
| mixed/text-search | 40000 | 10.07 | 32.57 | 7.29 | 28.54 |
| mixed/fibonacci | 10000 | 12.54 | 27.29 | 27.31 | 28.23 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.67 | 1.67 | 5.74 |
| mixed/sieve | 200000 | 8.75 | 7.38 | 7.44 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.28x slower | — |
| string/concat-long | 1.24x slower | 1.15x faster | — |
| string/indexOf | 3.19x slower | 1.52x faster | 1.14x faster |
| string/includes | 5.86x slower | 1.31x faster | 1.13x faster |
| string/split | 10.40x slower | 1.20x slower | — |
| string/replace | 2.37x slower | 1.41x faster | — |
| string/case-convert | 4.05x slower | 11.08x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.40x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.75x faster | 2.76x faster | — |
| array/sort-i32 | 2.75x faster | 1.94x faster | — |
| array/map-filter | 2.07x faster | 2.07x faster | — |
| array/reduce | 3.96x faster | 4.01x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.05x faster | 2.05x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.81x faster | 1.81x faster | — |
| array/find | 18.38x faster | 18.31x faster | 4.45x slower |
| dom/create-elements | 3.07x slower | — | — |
| dom/set-attributes | 4.56x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.84x slower | — | — |
| mixed/csv-parse | 7.02x slower | 3.15x faster | — |
| mixed/text-search | 3.23x slower | 1.38x faster | 2.83x slower |
| mixed/fibonacci | 2.18x slower | 2.18x slower | 2.25x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.88x slower |
| mixed/sieve | 1.19x faster | 1.18x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.42x faster |
| string/indexOf | 4.84x faster |
| string/includes | 7.69x faster |
| string/split | 8.69x faster |
| string/replace | 3.34x faster |
| string/case-convert | 44.94x faster |
| string/substring | 1.16x faster |
| string/trim | 4.75x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.41x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 22.10x faster |
| mixed/text-search | 4.47x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1257.4ms | 1058.4ms | — |
| string/concat-long | 616.1ms | 950.1ms | — |
| string/indexOf | 782.9ms | 945.6ms | 808.5ms |
| string/includes | 767.6ms | 937.9ms | 834.5ms |
| string/split | 750.5ms | 940.5ms | — |
| string/replace | 836.8ms | 1072.0ms | — |
| string/case-convert | 774.0ms | 824.4ms | — |
| string/substring | 627.3ms | 712.6ms | — |
| string/trim | 717.0ms | 965.7ms | — |
| string/startsWith-endsWith | 726.7ms | 973.5ms | 868.9ms |
| array/push-pop | 735.9ms | 819.2ms | — |
| array/sort-i32 | 913.2ms | 993.7ms | — |
| array/map-filter | 889.1ms | 972.5ms | — |
| array/reduce | 795.2ms | 879.1ms | — |
| array/indexOf | 875.6ms | 943.9ms | — |
| array/slice | 739.6ms | 788.7ms | — |
| array/reverse | 736.4ms | 786.6ms | — |
| array/forEach | 831.7ms | 952.4ms | — |
| array/find | 727.7ms | 815.3ms | 834.8ms |
| dom/create-elements | 609.2ms | — | — |
| dom/set-attributes | 730.4ms | — | — |
| dom/read-attributes | 686.8ms | — | — |
| dom/modify-text | 605.3ms | — | — |
| mixed/csv-parse | 769.7ms | 994.5ms | — |
| mixed/text-search | 742.3ms | 987.3ms | 878.1ms |
| mixed/fibonacci | 807.2ms | 837.6ms | 780.8ms |
| mixed/matrix-multiply | 818.9ms | 897.0ms | 775.4ms |
| mixed/sieve | 836.4ms | 858.7ms | — |
