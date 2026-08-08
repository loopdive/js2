# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.159ms | 0.023ms | FAILED | js |
| string/split | 0.425ms | 5.54ms | 0.449ms | FAILED | js |
| string/replace | 0.109ms | 0.315ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.252ms | 0.119ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.911ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.86ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.46ms | 0.507ms | 0.505ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.302ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.068ms | 0.068ms | FAILED | gc-native |
| array/reduce | 1.39ms | 0.507ms | 0.506ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.239ms | 0.017ms | 0.017ms | 0.994ms | gc-native |
| dom/create-elements | 0.202ms | 0.181ms | — | — | host-call |
| dom/set-attributes | 0.105ms | 0.587ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.145ms | — | — | js |
| dom/modify-text | 0.048ms | 0.122ms | — | — | js |
| mixed/csv-parse | 0.494ms | 8.55ms | 0.617ms | FAILED | js |
| mixed/text-search | 0.389ms | 2.67ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.107ms | linear-memory |
| mixed/matrix-multiply | 0.157ms | 0.191ms | 0.191ms | 0.719ms | js |
| mixed/sieve | 1.57ms | 1.39ms | 1.37ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.89 | 4.49 | 3.67 | — |
| string/concat-long | 1000 | 3.58 | 4.54 | 4.51 | — |
| string/indexOf | 1000 | 19.15 | 65.73 | 23.88 | — |
| string/includes | 1000 | 19.18 | 159.12 | 23.45 | — |
| string/split | 10000 | 42.53 | 553.73 | 44.86 | — |
| string/replace | 1000 | 108.65 | 314.82 | 81.99 | — |
| string/case-convert | 2000 | 27.89 | 126.16 | 59.45 | — |
| string/substring | 10000 | 9.86 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.95 | 91.08 | 24.33 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 142.98 | 14.37 | — |
| array/map-filter | 30000 | 4.35 | 2.28 | 2.28 | — |
| array/indexOf | 1000 | 3953.70 | 3549.54 | 3548.87 | — |
| dom/create-elements | 2000 | 101.15 | 90.60 | — | — |
| dom/set-attributes | 6000 | 17.43 | 97.82 | — | — |
| dom/read-attributes | 3000 | 19.82 | 48.29 | — | — |
| dom/modify-text | 2000 | 24.21 | 61.20 | — | — |
| mixed/csv-parse | 11000 | 44.92 | 777.70 | 56.13 | — |
| mixed/text-search | 40000 | 9.73 | 66.72 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.17 | 11.83 | 11.83 | 10.73 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.53 | 1.53 | 5.75 |
| mixed/sieve | 200000 | 7.86 | 6.94 | 6.85 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.27x slower | — |
| string/concat-long | 1.27x slower | 1.26x slower | — |
| string/indexOf | 3.43x slower | 1.25x slower | — |
| string/includes | 8.29x slower | 1.22x slower | — |
| string/split | 13.02x slower | 1.05x slower | — |
| string/replace | 2.90x slower | 1.33x faster | — |
| string/case-convert | 4.52x slower | 2.13x slower | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 5.37x slower | 1.44x slower | — |
| string/startsWith-endsWith | 7.14x slower | 1.39x faster | — |
| array/push-pop | 2.88x faster | 2.89x faster | — |
| array/sort-i32 | 2.63x faster | 2.64x faster | — |
| array/map-filter | 1.91x faster | 1.91x faster | — |
| array/reduce | 2.74x faster | 2.75x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.07x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.74x faster | — |
| array/find | 14.15x faster | 14.45x faster | 4.16x slower |
| dom/create-elements | 1.12x faster | — | — |
| dom/set-attributes | 5.61x slower | — | — |
| dom/read-attributes | 2.44x slower | — | — |
| dom/modify-text | 2.53x slower | — | — |
| mixed/csv-parse | 17.31x slower | 1.25x slower | — |
| mixed/text-search | 6.85x slower | 1.19x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 1.13x faster |
| mixed/matrix-multiply | 1.22x slower | 1.22x slower | 4.59x slower |
| mixed/sieve | 1.13x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 2.75x faster |
| string/includes | 6.79x faster |
| string/split | 12.34x faster |
| string/replace | 3.84x faster |
| string/case-convert | 2.12x faster |
| string/substring | 1.22x faster |
| string/trim | 3.74x faster |
| string/startsWith-endsWith | 9.95x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 13.85x faster |
| mixed/text-search | 8.13x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1301.3ms | 1130.1ms | — |
| string/concat-long | 646.1ms | 980.8ms | — |
| string/indexOf | 800.6ms | 1010.0ms | — |
| string/includes | 757.1ms | 1000.8ms | — |
| string/split | 768.5ms | 996.9ms | — |
| string/replace | 839.1ms | 1101.2ms | — |
| string/case-convert | 777.8ms | 1127.8ms | — |
| string/substring | 647.3ms | 745.8ms | — |
| string/trim | 735.4ms | 1027.5ms | — |
| string/startsWith-endsWith | 735.5ms | 1018.0ms | — |
| array/push-pop | 769.1ms | 861.4ms | — |
| array/sort-i32 | 986.0ms | 1032.7ms | — |
| array/map-filter | 929.9ms | 1038.8ms | — |
| array/reduce | 837.6ms | 872.8ms | — |
| array/indexOf | 855.8ms | 912.4ms | — |
| array/slice | 753.8ms | 835.8ms | — |
| array/reverse | 775.4ms | 845.0ms | — |
| array/forEach | 865.3ms | 943.3ms | — |
| array/find | 751.5ms | 831.7ms | 825.3ms |
| dom/create-elements | 642.8ms | — | — |
| dom/set-attributes | 756.4ms | — | — |
| dom/read-attributes | 709.9ms | — | — |
| dom/modify-text | 705.9ms | — | — |
| mixed/csv-parse | 797.4ms | 1021.4ms | — |
| mixed/text-search | 752.5ms | 1028.6ms | — |
| mixed/fibonacci | 781.6ms | 862.9ms | 740.5ms |
| mixed/matrix-multiply | 859.5ms | 899.0ms | 811.9ms |
| mixed/sieve | 836.2ms | 893.7ms | — |
