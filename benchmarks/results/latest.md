# js2wasm Benchmark Results

Date: 2026-09-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.117ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.412ms | 8.24ms | 2.84ms | FAILED | js |
| string/replace | 0.103ms | 0.662ms | 0.333ms | FAILED | js |
| string/case-convert | 0.055ms | 0.607ms | 0.252ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.83ms | 2.69ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.82ms | 2.82ms | 0.561ms | js |
| array/push-pop | 1.41ms | 0.507ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 1.26ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.071ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.13ms | 0.499ms | 0.506ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.027ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.500ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.493ms | 8.65ms | 0.625ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.87ms | 2.77ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 1.32ms | js |
| mixed/matrix-multiply | 0.158ms | 75.07ms | 76.68ms | 0.716ms | js |
| mixed/sieve | 1.53ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 2.81 | 4.84 | 4.42 | — |
| string/concat-long | 1000 | 3.60 | 4.61 | 3.83 | — |
| string/indexOf | 1000 | 19.14 | 64.22 | 12.30 | 16.21 |
| string/includes | 1000 | 19.19 | 116.69 | 14.80 | 15.60 |
| string/split | 10000 | 41.20 | 824.12 | 283.65 | — |
| string/replace | 1000 | 103.44 | 662.44 | 333.34 | — |
| string/case-convert | 2000 | 27.74 | 303.34 | 125.76 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.97 | 382.65 | 268.86 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 141.18 | 140.76 | 28.07 |
| array/map-filter | 30000 | 2.37 | 2.34 | 2.36 | — |
| array/indexOf | 1000 | 3950.06 | 2641.31 | 2641.45 | — |
| dom/create-elements | 2000 | 17.50 | 76.00 | — | — |
| dom/set-attributes | 6000 | 17.30 | 83.33 | — | — |
| dom/read-attributes | 3000 | 18.66 | 40.38 | — | — |
| dom/modify-text | 2000 | 14.75 | 53.58 | — | — |
| mixed/csv-parse | 11000 | 44.81 | 786.10 | 56.79 | — |
| mixed/text-search | 40000 | 9.74 | 121.72 | 69.27 | 27.03 |
| mixed/fibonacci | 10000 | 12.18 | 28.30 | 28.30 | 132.04 |
| mixed/matrix-multiply | 125000 | 1.27 | 600.60 | 613.40 | 5.73 |
| mixed/sieve | 200000 | 7.64 | 10.58 | 10.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.72x slower | 1.57x slower | — |
| string/concat-long | 1.28x slower | 1.06x slower | — |
| string/indexOf | 3.35x slower | 1.56x faster | 1.18x faster |
| string/includes | 6.08x slower | 1.30x faster | 1.23x faster |
| string/split | 20.00x slower | 6.88x slower | — |
| string/replace | 6.40x slower | 3.22x slower | — |
| string/case-convert | 10.94x slower | 4.53x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 22.55x slower | 15.84x slower | — |
| string/startsWith-endsWith | 7.03x slower | 7.01x slower | 1.40x slower |
| array/push-pop | 2.78x faster | 2.80x faster | — |
| array/sort-i32 | 1.59x slower | 2.71x faster | — |
| array/map-filter | 1.01x faster | 1.00x faster | — |
| array/reduce | 4.27x faster | 4.21x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.11x faster | 3.11x faster | — |
| array/find | 15.86x faster | 16.08x faster | 4.25x slower |
| dom/create-elements | 4.34x slower | — | — |
| dom/set-attributes | 4.82x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 17.54x slower | 1.27x slower | — |
| mixed/text-search | 12.49x slower | 7.11x slower | 2.77x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 10.84x slower |
| mixed/matrix-multiply | 474.08x slower | 484.18x slower | 4.52x slower |
| mixed/sieve | 1.38x slower | 1.38x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.22x faster |
| string/includes | 7.88x faster |
| string/split | 2.91x faster |
| string/replace | 1.99x faster |
| string/case-convert | 2.41x faster |
| string/substring | 1.22x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 4.29x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.84x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1673.8ms | 1069.8ms | — |
| string/concat-long | 756.2ms | 989.6ms | — |
| string/indexOf | 695.1ms | 980.5ms | 853.6ms |
| string/includes | 669.1ms | 980.8ms | 847.3ms |
| string/split | 776.4ms | 1006.6ms | — |
| string/replace | 780.4ms | 1032.2ms | — |
| string/case-convert | 785.5ms | 877.0ms | — |
| string/substring | 668.7ms | 747.5ms | — |
| string/trim | 754.9ms | 956.5ms | — |
| string/startsWith-endsWith | 758.9ms | 969.9ms | 904.4ms |
| array/push-pop | 786.5ms | 890.9ms | — |
| array/sort-i32 | 968.3ms | 1008.1ms | — |
| array/map-filter | 957.2ms | 997.3ms | — |
| array/reduce | 872.7ms | 953.3ms | — |
| array/indexOf | 877.1ms | 961.1ms | — |
| array/slice | 788.0ms | 875.0ms | — |
| array/reverse | 799.9ms | 887.1ms | — |
| array/forEach | 862.9ms | 996.8ms | — |
| array/find | 744.0ms | 874.3ms | 830.1ms |
| dom/create-elements | 715.4ms | — | — |
| dom/set-attributes | 715.7ms | — | — |
| dom/read-attributes | 700.4ms | — | — |
| dom/modify-text | 670.4ms | — | — |
| mixed/csv-parse | 815.1ms | 972.4ms | — |
| mixed/text-search | 783.1ms | 1006.6ms | 897.6ms |
| mixed/fibonacci | 750.7ms | 781.2ms | 772.8ms |
| mixed/matrix-multiply | 921.5ms | 1006.7ms | 801.8ms |
| mixed/sieve | 884.1ms | 962.7ms | — |
