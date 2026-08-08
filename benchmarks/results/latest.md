# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.062ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.125ms | 0.024ms | FAILED | js |
| string/split | 0.437ms | 5.37ms | 0.505ms | FAILED | js |
| string/replace | 0.094ms | 0.232ms | 0.073ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.234ms | 0.113ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.941ms | 0.271ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.45ms | 0.308ms | FAILED | gc-native |
| array/push-pop | 1.67ms | 0.598ms | 0.593ms | FAILED | gc-native |
| array/sort-i32 | 0.842ms | 0.316ms | 0.306ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.060ms | 0.060ms | FAILED | host-call |
| array/reduce | 2.37ms | 0.602ms | 0.598ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 3.79ms | 3.79ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.280ms | 0.015ms | 0.015ms | 1.20ms | host-call |
| dom/create-elements | 0.038ms | 0.172ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.494ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.151ms | — | — | js |
| dom/modify-text | 0.050ms | 0.129ms | — | — | js |
| mixed/csv-parse | 0.473ms | 8.10ms | 0.593ms | FAILED | js |
| mixed/text-search | 0.409ms | 2.27ms | 0.357ms | FAILED | gc-native |
| mixed/fibonacci | 0.125ms | 0.130ms | 0.130ms | 0.092ms | linear-memory |
| mixed/matrix-multiply | 0.184ms | 0.199ms | 0.199ms | 0.719ms | js |
| mixed/sieve | 1.74ms | 1.50ms | 1.48ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.28 | 4.84 | 4.17 | — |
| string/concat-long | 1000 | 4.30 | 5.33 | 4.68 | — |
| string/indexOf | 1000 | 18.94 | 61.58 | 23.54 | — |
| string/includes | 1000 | 18.68 | 125.28 | 23.68 | — |
| string/split | 10000 | 43.74 | 536.69 | 50.48 | — |
| string/replace | 1000 | 93.89 | 231.60 | 72.58 | — |
| string/case-convert | 2000 | 29.40 | 116.84 | 56.57 | — |
| string/substring | 10000 | 10.39 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.27 | 94.13 | 27.09 | — |
| string/startsWith-endsWith | 20000 | 20.59 | 122.36 | 15.42 | — |
| array/map-filter | 30000 | 4.42 | 2.00 | 2.01 | — |
| array/indexOf | 1000 | 4455.13 | 3786.43 | 3785.01 | — |
| dom/create-elements | 2000 | 18.86 | 86.23 | — | — |
| dom/set-attributes | 6000 | 17.93 | 82.36 | — | — |
| dom/read-attributes | 3000 | 19.04 | 50.27 | — | — |
| dom/modify-text | 2000 | 25.07 | 64.48 | — | — |
| mixed/csv-parse | 11000 | 42.96 | 736.67 | 53.94 | — |
| mixed/text-search | 40000 | 10.22 | 56.68 | 8.92 | — |
| mixed/fibonacci | 10000 | 12.54 | 13.01 | 13.00 | 9.18 |
| mixed/matrix-multiply | 125000 | 1.47 | 1.59 | 1.59 | 5.75 |
| mixed/sieve | 200000 | 8.69 | 7.49 | 7.41 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.27x slower | — |
| string/concat-long | 1.24x slower | 1.09x slower | — |
| string/indexOf | 3.25x slower | 1.24x slower | — |
| string/includes | 6.71x slower | 1.27x slower | — |
| string/split | 12.27x slower | 1.15x slower | — |
| string/replace | 2.47x slower | 1.29x faster | — |
| string/case-convert | 3.97x slower | 1.92x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.45x slower | 1.57x slower | — |
| string/startsWith-endsWith | 5.94x slower | 1.34x faster | — |
| array/push-pop | 2.79x faster | 2.82x faster | — |
| array/sort-i32 | 2.66x faster | 2.75x faster | — |
| array/map-filter | 2.21x faster | 2.20x faster | — |
| array/reduce | 3.93x faster | 3.96x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.07x faster | 1.99x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.81x faster | 1.82x faster | — |
| array/find | 18.23x faster | 18.08x faster | 4.29x slower |
| dom/create-elements | 4.57x slower | — | — |
| dom/set-attributes | 4.59x slower | — | — |
| dom/read-attributes | 2.64x slower | — | — |
| dom/modify-text | 2.57x slower | — | — |
| mixed/csv-parse | 17.15x slower | 1.26x slower | — |
| mixed/text-search | 5.55x slower | 1.15x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 1.37x faster |
| mixed/matrix-multiply | 1.08x slower | 1.08x slower | 3.91x slower |
| mixed/sieve | 1.16x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.14x faster |
| string/indexOf | 2.62x faster |
| string/includes | 5.29x faster |
| string/split | 10.63x faster |
| string/replace | 3.19x faster |
| string/case-convert | 2.07x faster |
| string/substring | 1.16x faster |
| string/trim | 3.47x faster |
| string/startsWith-endsWith | 7.93x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.66x faster |
| mixed/text-search | 6.36x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1223.6ms | 1049.7ms | — |
| string/concat-long | 608.0ms | 928.2ms | — |
| string/indexOf | 764.3ms | 958.9ms | — |
| string/includes | 778.2ms | 941.0ms | — |
| string/split | 739.8ms | 942.6ms | — |
| string/replace | 824.3ms | 1069.0ms | — |
| string/case-convert | 773.0ms | 1062.8ms | — |
| string/substring | 621.4ms | 706.9ms | — |
| string/trim | 707.3ms | 989.4ms | — |
| string/startsWith-endsWith | 730.3ms | 1001.2ms | — |
| array/push-pop | 742.0ms | 788.8ms | — |
| array/sort-i32 | 897.4ms | 939.0ms | — |
| array/map-filter | 881.3ms | 967.8ms | — |
| array/reduce | 778.1ms | 862.1ms | — |
| array/indexOf | 817.3ms | 866.1ms | — |
| array/slice | 720.3ms | 809.9ms | — |
| array/reverse | 732.9ms | 778.1ms | — |
| array/forEach | 837.2ms | 887.7ms | — |
| array/find | 710.1ms | 798.8ms | 798.7ms |
| dom/create-elements | 584.9ms | — | — |
| dom/set-attributes | 677.6ms | — | — |
| dom/read-attributes | 645.1ms | — | — |
| dom/modify-text | 705.9ms | — | — |
| mixed/csv-parse | 760.2ms | 973.2ms | — |
| mixed/text-search | 714.3ms | 938.8ms | — |
| mixed/fibonacci | 760.4ms | 806.7ms | 710.1ms |
| mixed/matrix-multiply | 813.3ms | 847.2ms | 795.4ms |
| mixed/sieve | 809.8ms | 838.5ms | — |
