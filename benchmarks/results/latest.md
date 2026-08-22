# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.055ms | 0.055ms | 0.067ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.016ms | 0.050ms | 0.011ms | 0.056ms | gc-native |
| string/includes | 0.016ms | 0.035ms | 0.014ms | 0.037ms | gc-native |
| string/split | 0.349ms | 4.23ms | 0.405ms | FAILED | js |
| string/replace | 0.098ms | 0.245ms | 0.052ms | FAILED | gc-native |
| string/case-convert | 0.051ms | 0.174ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.115ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.158ms | 0.705ms | 0.164ms | FAILED | js |
| string/startsWith-endsWith | 0.469ms | 0.326ms | 0.257ms | 0.550ms | gc-native |
| array/push-pop | 1.47ms | 0.481ms | 0.490ms | FAILED | host-call |
| array/sort-i32 | 0.631ms | 0.330ms | 0.329ms | FAILED | gc-native |
| array/map-filter | 0.140ms | 0.080ms | 0.079ms | FAILED | gc-native |
| array/reduce | 1.38ms | 0.477ms | 0.474ms | FAILED | gc-native |
| array/indexOf | 5.23ms | 2.57ms | 2.57ms | FAILED | gc-native |
| array/slice | 0.040ms | 0.038ms | 0.041ms | FAILED | host-call |
| array/reverse | 8.19ms | 3.68ms | 3.68ms | FAILED | gc-native |
| array/forEach | 0.059ms | 0.025ms | 0.025ms | FAILED | gc-native |
| array/find | 0.284ms | 0.016ms | 0.017ms | 0.953ms | host-call |
| dom/create-elements | 0.063ms | 0.158ms | — | — | js |
| dom/set-attributes | 0.130ms | 0.481ms | — | — | js |
| dom/read-attributes | 0.071ms | 0.111ms | — | — | js |
| dom/modify-text | 0.058ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.385ms | 5.87ms | 0.294ms | FAILED | gc-native |
| mixed/text-search | 0.433ms | 1.20ms | 0.254ms | 1.14ms | gc-native |
| mixed/fibonacci | 0.134ms | 0.208ms | 0.208ms | 0.207ms | js |
| mixed/matrix-multiply | 0.184ms | 0.220ms | 0.220ms | 0.701ms | js |
| mixed/sieve | 1.63ms | 1.57ms | 1.56ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 5.46 | 5.50 | 6.71 | — |
| string/concat-long | 1000 | 5.31 | 5.45 | 6.37 | — |
| string/indexOf | 1000 | 16.19 | 50.27 | 11.25 | 56.49 |
| string/includes | 1000 | 16.27 | 35.06 | 13.98 | 36.76 |
| string/split | 10000 | 34.94 | 423.40 | 40.54 | — |
| string/replace | 1000 | 97.89 | 244.70 | 52.04 | — |
| string/case-convert | 2000 | 25.45 | 87.09 | 2.41 | — |
| string/substring | 10000 | 11.47 | 3.69 | 3.14 | — |
| string/trim | 10000 | 15.80 | 70.52 | 16.44 | — |
| string/startsWith-endsWith | 20000 | 23.45 | 16.29 | 12.84 | 27.51 |
| array/map-filter | 30000 | 4.67 | 2.66 | 2.64 | — |
| array/indexOf | 1000 | 5226.15 | 2574.84 | 2573.95 | — |
| dom/create-elements | 2000 | 31.55 | 78.78 | — | — |
| dom/set-attributes | 6000 | 21.70 | 80.13 | — | — |
| dom/read-attributes | 3000 | 23.61 | 36.98 | — | — |
| dom/modify-text | 2000 | 29.17 | 53.04 | — | — |
| mixed/csv-parse | 11000 | 35.01 | 533.80 | 26.77 | — |
| mixed/text-search | 40000 | 10.82 | 30.05 | 6.36 | 28.38 |
| mixed/fibonacci | 10000 | 13.40 | 20.79 | 20.78 | 20.68 |
| mixed/matrix-multiply | 125000 | 1.47 | 1.76 | 1.76 | 5.61 |
| mixed/sieve | 200000 | 8.14 | 7.84 | 7.82 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.01x slower | 1.23x slower | — |
| string/concat-long | 1.03x slower | 1.20x slower | — |
| string/indexOf | 3.10x slower | 1.44x faster | 3.49x slower |
| string/includes | 2.16x slower | 1.16x faster | 2.26x slower |
| string/split | 12.12x slower | 1.16x slower | — |
| string/replace | 2.50x slower | 1.88x faster | — |
| string/case-convert | 3.42x slower | 10.54x faster | — |
| string/substring | 3.11x faster | 3.65x faster | — |
| string/trim | 4.46x slower | 1.04x slower | — |
| string/startsWith-endsWith | 1.44x faster | 1.83x faster | 1.17x slower |
| array/push-pop | 3.05x faster | 2.99x faster | — |
| array/sort-i32 | 1.91x faster | 1.92x faster | — |
| array/map-filter | 1.76x faster | 1.77x faster | — |
| array/reduce | 2.90x faster | 2.92x faster | — |
| array/indexOf | 2.03x faster | 2.03x faster | — |
| array/slice | 1.03x faster | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.40x faster | 2.41x faster | — |
| array/find | 17.25x faster | 17.18x faster | 3.35x slower |
| dom/create-elements | 2.50x slower | — | — |
| dom/set-attributes | 3.69x slower | — | — |
| dom/read-attributes | 1.57x slower | — | — |
| dom/modify-text | 1.82x slower | — | — |
| mixed/csv-parse | 15.25x slower | 1.31x faster | — |
| mixed/text-search | 2.78x slower | 1.70x faster | 2.62x slower |
| mixed/fibonacci | 1.55x slower | 1.55x slower | 1.54x slower |
| mixed/matrix-multiply | 1.20x slower | 1.20x slower | 3.82x slower |
| mixed/sieve | 1.04x faster | 1.04x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x slower |
| string/concat-long | 1.17x slower |
| string/indexOf | 4.47x faster |
| string/includes | 2.51x faster |
| string/split | 10.44x faster |
| string/replace | 4.70x faster |
| string/case-convert | 36.07x faster |
| string/substring | 1.17x faster |
| string/trim | 4.29x faster |
| string/startsWith-endsWith | 1.27x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.06x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 19.94x faster |
| mixed/text-search | 4.73x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

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
| array/forEach | 2.5KB | 3.1KB | — |
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
| string/concat-short | 1195.3ms | 1008.2ms | — |
| string/concat-long | 612.2ms | 920.1ms | — |
| string/indexOf | 645.7ms | 942.7ms | 811.1ms |
| string/includes | 638.9ms | 922.3ms | 818.4ms |
| string/split | 725.1ms | 918.9ms | — |
| string/replace | 718.0ms | 987.8ms | — |
| string/case-convert | 738.2ms | 805.9ms | — |
| string/substring | 615.4ms | 688.6ms | — |
| string/trim | 727.0ms | 926.4ms | — |
| string/startsWith-endsWith | 718.3ms | 921.6ms | 868.5ms |
| array/push-pop | 714.0ms | 804.9ms | — |
| array/sort-i32 | 859.9ms | 939.6ms | — |
| array/map-filter | 910.1ms | 949.5ms | — |
| array/reduce | 797.6ms | 906.6ms | — |
| array/indexOf | 827.2ms | 901.2ms | — |
| array/slice | 711.3ms | 769.3ms | — |
| array/reverse | 697.5ms | 772.9ms | — |
| array/forEach | 821.7ms | 911.8ms | — |
| array/find | 718.4ms | 759.4ms | 769.1ms |
| dom/create-elements | 602.0ms | — | — |
| dom/set-attributes | 654.5ms | — | — |
| dom/read-attributes | 640.9ms | — | — |
| dom/modify-text | 537.3ms | — | — |
| mixed/csv-parse | 754.0ms | 879.2ms | — |
| mixed/text-search | 723.3ms | 923.1ms | 842.1ms |
| mixed/fibonacci | 697.9ms | 729.9ms | 741.8ms |
| mixed/matrix-multiply | 809.1ms | 877.2ms | 771.7ms |
| mixed/sieve | 814.2ms | 893.9ms | — |
