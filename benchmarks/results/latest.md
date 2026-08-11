# js2wasm Benchmark Results

Date: 2026-08-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.045ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.069ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.125ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.424ms | 5.15ms | 0.451ms | FAILED | js |
| string/replace | 0.104ms | 0.313ms | 0.070ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.236ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.102ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.961ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.286ms | 0.561ms | gc-native |
| array/push-pop | 1.40ms | 0.504ms | 0.511ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.300ms | 0.304ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.068ms | 0.068ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.503ms | 0.503ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.504ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.126ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.483ms | 7.64ms | 0.313ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.60ms | 0.267ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.235ms | 0.235ms | 1.17ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.722ms | js |
| mixed/sieve | 1.53ms | 1.39ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.17 | 4.51 | 3.91 | — |
| string/concat-long | 1000 | 3.55 | 4.53 | 3.69 | — |
| string/indexOf | 1000 | 19.16 | 68.82 | 12.43 | 14.61 |
| string/includes | 1000 | 19.17 | 124.56 | 14.55 | 19.30 |
| string/split | 10000 | 42.35 | 514.57 | 45.06 | — |
| string/replace | 1000 | 103.51 | 313.24 | 69.93 | — |
| string/case-convert | 2000 | 27.77 | 117.76 | 2.51 | — |
| string/substring | 10000 | 10.22 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.97 | 96.14 | 18.66 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 17.90 | 14.31 | 28.04 |
| array/map-filter | 30000 | 4.26 | 2.27 | 2.28 | — |
| array/indexOf | 1000 | 3955.68 | 2636.65 | 2637.73 | — |
| dom/create-elements | 2000 | 17.83 | 77.25 | — | — |
| dom/set-attributes | 6000 | 17.13 | 83.98 | — | — |
| dom/read-attributes | 3000 | 18.43 | 41.99 | — | — |
| dom/modify-text | 2000 | 14.38 | 53.08 | — | — |
| mixed/csv-parse | 11000 | 43.90 | 694.19 | 28.49 | — |
| mixed/text-search | 40000 | 9.73 | 39.95 | 6.66 | 27.33 |
| mixed/fibonacci | 10000 | 12.02 | 23.46 | 23.49 | 117.41 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.68 | 5.78 |
| mixed/sieve | 200000 | 7.67 | 6.95 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.23x slower | — |
| string/concat-long | 1.28x slower | 1.04x slower | — |
| string/indexOf | 3.59x slower | 1.54x faster | 1.31x faster |
| string/includes | 6.50x slower | 1.32x faster | 1.01x slower |
| string/split | 12.15x slower | 1.06x slower | — |
| string/replace | 3.03x slower | 1.48x faster | — |
| string/case-convert | 4.24x slower | 11.08x faster | — |
| string/substring | 2.72x faster | 3.32x faster | — |
| string/trim | 5.66x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.40x faster | 1.40x slower |
| array/push-pop | 2.77x faster | 2.74x faster | — |
| array/sort-i32 | 2.63x faster | 2.60x faster | — |
| array/map-filter | 1.87x faster | 1.87x faster | — |
| array/reduce | 4.30x faster | 4.30x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 15.83x faster | 16.00x faster | 4.25x slower |
| dom/create-elements | 4.33x slower | — | — |
| dom/set-attributes | 4.90x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.69x slower | — | — |
| mixed/csv-parse | 15.81x slower | 1.54x faster | — |
| mixed/text-search | 4.10x slower | 1.46x faster | 2.81x slower |
| mixed/fibonacci | 1.95x slower | 1.95x slower | 9.77x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.58x slower |
| mixed/sieve | 1.10x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 5.54x faster |
| string/includes | 8.56x faster |
| string/split | 11.42x faster |
| string/replace | 4.48x faster |
| string/case-convert | 47.01x faster |
| string/substring | 1.22x faster |
| string/trim | 5.15x faster |
| string/startsWith-endsWith | 1.25x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 24.37x faster |
| mixed/text-search | 6.00x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1297.2ms | 1143.2ms | — |
| string/concat-long | 651.6ms | 972.5ms | — |
| string/indexOf | 797.5ms | 974.8ms | 831.1ms |
| string/includes | 771.6ms | 980.5ms | 851.1ms |
| string/split | 749.7ms | 979.8ms | — |
| string/replace | 816.9ms | 1077.6ms | — |
| string/case-convert | 913.5ms | 852.6ms | — |
| string/substring | 644.1ms | 764.0ms | — |
| string/trim | 754.0ms | 1016.4ms | — |
| string/startsWith-endsWith | 750.6ms | 989.5ms | 873.1ms |
| array/push-pop | 752.1ms | 802.6ms | — |
| array/sort-i32 | 955.3ms | 967.6ms | — |
| array/map-filter | 909.1ms | 1020.0ms | — |
| array/reduce | 830.8ms | 874.6ms | — |
| array/indexOf | 935.7ms | 947.5ms | — |
| array/slice | 745.6ms | 821.4ms | — |
| array/reverse | 763.6ms | 827.7ms | — |
| array/forEach | 864.6ms | 936.0ms | — |
| array/find | 742.3ms | 828.2ms | 824.6ms |
| dom/create-elements | 629.7ms | — | — |
| dom/set-attributes | 693.5ms | — | — |
| dom/read-attributes | 662.7ms | — | — |
| dom/modify-text | 607.3ms | — | — |
| mixed/csv-parse | 769.7ms | 960.8ms | — |
| mixed/text-search | 760.1ms | 996.3ms | 901.0ms |
| mixed/fibonacci | 789.9ms | 892.7ms | 789.1ms |
| mixed/matrix-multiply | 863.9ms | 906.3ms | 809.3ms |
| mixed/sieve | 833.6ms | 909.1ms | — |
