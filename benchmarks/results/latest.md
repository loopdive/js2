# js2wasm Benchmark Results

Date: 2026-09-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.130ms | 0.015ms | 0.024ms | gc-native |
| string/split | 0.434ms | 8.33ms | 2.75ms | FAILED | js |
| string/replace | 0.110ms | 0.696ms | 0.319ms | FAILED | js |
| string/case-convert | 0.056ms | 0.543ms | 0.259ms | FAILED | js |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.82ms | 2.61ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.85ms | 2.86ms | 0.568ms | js |
| array/push-pop | 1.39ms | 0.499ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.791ms | 0.292ms | 0.296ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.069ms | 0.069ms | FAILED | host-call |
| array/reduce | 2.13ms | 0.495ms | 0.496ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.015ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | 0.170ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.495ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.120ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.487ms | 8.51ms | 0.607ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.86ms | 2.78ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 1.32ms | js |
| mixed/matrix-multiply | 0.157ms | 71.88ms | 74.03ms | 0.716ms | js |
| mixed/sieve | 1.55ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.40 | 4.74 | 4.40 | — |
| string/concat-long | 1000 | 3.55 | 4.54 | 3.55 | — |
| string/indexOf | 1000 | 19.14 | 63.60 | 12.25 | 14.73 |
| string/includes | 1000 | 19.18 | 130.24 | 14.77 | 23.87 |
| string/split | 10000 | 43.37 | 833.24 | 274.84 | — |
| string/replace | 1000 | 109.53 | 696.29 | 318.55 | — |
| string/case-convert | 2000 | 27.92 | 271.47 | 129.37 | — |
| string/substring | 10000 | 9.83 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.00 | 381.57 | 261.48 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 142.37 | 143.00 | 28.38 |
| array/map-filter | 30000 | 4.31 | 2.31 | 2.31 | — |
| array/indexOf | 1000 | 3948.71 | 2640.97 | 2639.92 | — |
| dom/create-elements | 2000 | 17.44 | 85.02 | — | — |
| dom/set-attributes | 6000 | 17.25 | 82.56 | — | — |
| dom/read-attributes | 3000 | 18.86 | 39.92 | — | — |
| dom/modify-text | 2000 | 14.55 | 54.75 | — | — |
| mixed/csv-parse | 11000 | 44.24 | 773.59 | 55.20 | — |
| mixed/text-search | 40000 | 9.74 | 121.57 | 69.39 | 27.43 |
| mixed/fibonacci | 10000 | 12.17 | 28.29 | 28.32 | 132.25 |
| mixed/matrix-multiply | 125000 | 1.26 | 575.06 | 592.27 | 5.73 |
| mixed/sieve | 200000 | 7.75 | 10.58 | 10.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.30x slower | — |
| string/concat-long | 1.28x slower | 1.00x faster | — |
| string/indexOf | 3.32x slower | 1.56x faster | 1.30x faster |
| string/includes | 6.79x slower | 1.30x faster | 1.24x slower |
| string/split | 19.21x slower | 6.34x slower | — |
| string/replace | 6.36x slower | 2.91x slower | — |
| string/case-convert | 9.72x slower | 4.63x slower | — |
| string/substring | 2.61x faster | 3.20x faster | — |
| string/trim | 22.45x slower | 15.39x slower | — |
| string/startsWith-endsWith | 7.10x slower | 7.13x slower | 1.42x slower |
| array/push-pop | 2.79x faster | 2.76x faster | — |
| array/sort-i32 | 2.71x faster | 2.68x faster | — |
| array/map-filter | 1.87x faster | 1.87x faster | — |
| array/reduce | 4.30x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.73x faster | — |
| array/find | 15.95x faster | 16.42x faster | 4.25x slower |
| dom/create-elements | 4.88x slower | — | — |
| dom/set-attributes | 4.79x slower | — | — |
| dom/read-attributes | 2.12x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 17.49x slower | 1.25x slower | — |
| mixed/text-search | 12.48x slower | 7.12x slower | 2.82x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 10.86x slower |
| mixed/matrix-multiply | 456.57x slower | 470.23x slower | 4.55x slower |
| mixed/sieve | 1.36x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.19x faster |
| string/includes | 8.82x faster |
| string/split | 3.03x faster |
| string/replace | 2.19x faster |
| string/case-convert | 2.10x faster |
| string/substring | 1.22x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.03x faster |
| mixed/csv-parse | 14.02x faster |
| mixed/text-search | 1.75x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
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
| string/concat-short | 1653.9ms | 1069.8ms | — |
| string/concat-long | 752.3ms | 943.8ms | — |
| string/indexOf | 660.4ms | 992.1ms | 844.3ms |
| string/includes | 646.1ms | 966.8ms | 837.1ms |
| string/split | 767.8ms | 953.6ms | — |
| string/replace | 837.2ms | 1063.7ms | — |
| string/case-convert | 776.9ms | 896.9ms | — |
| string/substring | 668.9ms | 793.9ms | — |
| string/trim | 755.9ms | 947.5ms | — |
| string/startsWith-endsWith | 760.5ms | 939.6ms | 892.4ms |
| array/push-pop | 758.8ms | 841.2ms | — |
| array/sort-i32 | 942.9ms | 993.2ms | — |
| array/map-filter | 915.6ms | 1012.6ms | — |
| array/reduce | 864.2ms | 871.2ms | — |
| array/indexOf | 821.5ms | 961.7ms | — |
| array/slice | 769.3ms | 860.0ms | — |
| array/reverse | 763.8ms | 843.8ms | — |
| array/forEach | 890.0ms | 1008.6ms | — |
| array/find | 776.0ms | 861.2ms | 819.8ms |
| dom/create-elements | 704.0ms | — | — |
| dom/set-attributes | 706.3ms | — | — |
| dom/read-attributes | 678.9ms | — | — |
| dom/modify-text | 687.0ms | — | — |
| mixed/csv-parse | 781.9ms | 976.9ms | — |
| mixed/text-search | 770.9ms | 984.3ms | 928.2ms |
| mixed/fibonacci | 752.4ms | 799.8ms | 761.2ms |
| mixed/matrix-multiply | 910.0ms | 979.0ms | 833.5ms |
| mixed/sieve | 854.1ms | 939.0ms | — |
