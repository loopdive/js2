# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.048ms | 0.054ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.059ms | 0.012ms | 0.018ms | gc-native |
| string/includes | 0.018ms | 0.125ms | 0.014ms | 0.021ms | gc-native |
| string/split | 0.425ms | 7.61ms | 2.81ms | FAILED | js |
| string/replace | 0.108ms | 0.562ms | 0.313ms | FAILED | js |
| string/case-convert | 0.058ms | 0.588ms | 0.258ms | FAILED | js |
| string/substring | 0.105ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.164ms | 3.69ms | 2.93ms | FAILED | js |
| string/startsWith-endsWith | 0.430ms | 2.94ms | 2.94ms | 0.579ms | js |
| array/push-pop | 1.41ms | 0.493ms | 0.494ms | FAILED | host-call |
| array/sort-i32 | 0.713ms | 0.310ms | 0.315ms | FAILED | host-call |
| array/map-filter | 0.146ms | 0.085ms | 0.085ms | FAILED | gc-native |
| array/reduce | 2.00ms | 0.504ms | 0.500ms | FAILED | gc-native |
| array/indexOf | 4.83ms | 2.76ms | 2.77ms | FAILED | host-call |
| array/slice | 0.039ms | 0.034ms | 0.036ms | FAILED | host-call |
| array/reverse | 7.27ms | 3.64ms | 3.66ms | FAILED | host-call |
| array/forEach | 0.100ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.265ms | 0.018ms | 0.017ms | 0.985ms | gc-native |
| dom/create-elements | 0.285ms | 0.186ms | — | — | host-call |
| dom/set-attributes | 0.125ms | 0.557ms | — | — | js |
| dom/read-attributes | 0.072ms | 0.143ms | — | — | js |
| dom/modify-text | 0.051ms | 0.125ms | — | — | js |
| mixed/csv-parse | 0.467ms | 7.92ms | 0.593ms | FAILED | js |
| mixed/text-search | 0.395ms | 4.49ms | 2.77ms | 1.22ms | js |
| mixed/fibonacci | 0.134ms | 0.353ms | 0.353ms | 0.351ms | js |
| mixed/matrix-multiply | 0.204ms | 68.61ms | 69.25ms | 0.774ms | js |
| mixed/sieve | 1.51ms | 2.20ms | 2.21ms | FAILED | js |

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
| string/concat-short | 10000 | 4.47 | 4.84 | 5.37 | — |
| string/concat-long | 1000 | 4.33 | 4.72 | 5.79 | — |
| string/indexOf | 1000 | 18.07 | 58.80 | 12.25 | 18.43 |
| string/includes | 1000 | 18.08 | 125.41 | 13.91 | 21.24 |
| string/split | 10000 | 42.45 | 761.01 | 280.71 | — |
| string/replace | 1000 | 108.32 | 561.93 | 313.36 | — |
| string/case-convert | 2000 | 28.93 | 294.02 | 128.99 | — |
| string/substring | 10000 | 10.53 | 4.20 | 3.59 | — |
| string/trim | 10000 | 16.41 | 369.02 | 292.99 | — |
| string/startsWith-endsWith | 20000 | 21.48 | 146.92 | 146.80 | 28.94 |
| array/map-filter | 30000 | 4.87 | 2.84 | 2.82 | — |
| array/indexOf | 1000 | 4827.91 | 2760.24 | 2766.49 | — |
| dom/create-elements | 2000 | 142.51 | 93.22 | — | — |
| dom/set-attributes | 6000 | 20.78 | 92.77 | — | — |
| dom/read-attributes | 3000 | 24.08 | 47.76 | — | — |
| dom/modify-text | 2000 | 25.69 | 62.50 | — | — |
| mixed/csv-parse | 11000 | 42.42 | 719.55 | 53.93 | — |
| mixed/text-search | 40000 | 9.87 | 112.20 | 69.20 | 30.54 |
| mixed/fibonacci | 10000 | 13.39 | 35.27 | 35.29 | 35.15 |
| mixed/matrix-multiply | 125000 | 1.63 | 548.85 | 554.01 | 6.19 |
| mixed/sieve | 200000 | 7.54 | 10.98 | 11.03 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.08x slower | 1.20x slower | — |
| string/concat-long | 1.09x slower | 1.34x slower | — |
| string/indexOf | 3.25x slower | 1.47x faster | 1.02x slower |
| string/includes | 6.94x slower | 1.30x faster | 1.17x slower |
| string/split | 17.93x slower | 6.61x slower | — |
| string/replace | 5.19x slower | 2.89x slower | — |
| string/case-convert | 10.16x slower | 4.46x slower | — |
| string/substring | 2.51x faster | 2.94x faster | — |
| string/trim | 22.48x slower | 17.85x slower | — |
| string/startsWith-endsWith | 6.84x slower | 6.83x slower | 1.35x slower |
| array/push-pop | 2.85x faster | 2.85x faster | — |
| array/sort-i32 | 2.30x faster | 2.27x faster | — |
| array/map-filter | 1.72x faster | 1.73x faster | — |
| array/reduce | 3.97x faster | 4.01x faster | — |
| array/indexOf | 1.75x faster | 1.75x faster | — |
| array/slice | 1.13x faster | 1.09x faster | — |
| array/reverse | 2.00x faster | 1.99x faster | — |
| array/forEach | 3.54x faster | 3.54x faster | — |
| array/find | 14.39x faster | 15.50x faster | 3.72x slower |
| dom/create-elements | 1.53x faster | — | — |
| dom/set-attributes | 4.46x slower | — | — |
| dom/read-attributes | 1.98x slower | — | — |
| dom/modify-text | 2.43x slower | — | — |
| mixed/csv-parse | 16.96x slower | 1.27x slower | — |
| mixed/text-search | 11.37x slower | 7.01x slower | 3.09x slower |
| mixed/fibonacci | 2.63x slower | 2.64x slower | 2.62x slower |
| mixed/matrix-multiply | 336.62x slower | 339.79x slower | 3.80x slower |
| mixed/sieve | 1.46x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x slower |
| string/concat-long | 1.23x slower |
| string/indexOf | 4.80x faster |
| string/includes | 9.01x faster |
| string/split | 2.71x faster |
| string/replace | 1.79x faster |
| string/case-convert | 2.28x faster |
| string/substring | 1.17x faster |
| string/trim | 1.26x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.08x faster |
| mixed/csv-parse | 13.34x faster |
| mixed/text-search | 1.62x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 980B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.2KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.2KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.1KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1564.4ms | 1019.1ms | — |
| string/concat-long | 741.8ms | 946.9ms | — |
| string/indexOf | 652.3ms | 969.2ms | 815.1ms |
| string/includes | 630.8ms | 969.4ms | 818.1ms |
| string/split | 767.8ms | 937.1ms | — |
| string/replace | 782.4ms | 1017.7ms | — |
| string/case-convert | 761.8ms | 877.3ms | — |
| string/substring | 634.7ms | 764.6ms | — |
| string/trim | 760.2ms | 940.8ms | — |
| string/startsWith-endsWith | 742.4ms | 967.4ms | 872.6ms |
| array/push-pop | 757.4ms | 864.6ms | — |
| array/sort-i32 | 941.3ms | 994.5ms | — |
| array/map-filter | 965.3ms | 1036.8ms | — |
| array/reduce | 870.2ms | 994.1ms | — |
| array/indexOf | 852.4ms | 939.9ms | — |
| array/slice | 768.4ms | 878.4ms | — |
| array/reverse | 759.0ms | 866.6ms | — |
| array/forEach | 893.2ms | 989.9ms | — |
| array/find | 734.0ms | 848.6ms | 825.2ms |
| dom/create-elements | 698.4ms | — | — |
| dom/set-attributes | 702.4ms | — | — |
| dom/read-attributes | 682.9ms | — | — |
| dom/modify-text | 669.1ms | — | — |
| mixed/csv-parse | 792.8ms | 965.0ms | — |
| mixed/text-search | 759.0ms | 999.1ms | 903.6ms |
| mixed/fibonacci | 713.8ms | 836.3ms | 746.3ms |
| mixed/matrix-multiply | 872.3ms | 972.1ms | 775.9ms |
| mixed/sieve | 852.1ms | 894.9ms | — |
