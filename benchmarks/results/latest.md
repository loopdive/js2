# js2wasm Benchmark Results

Date: 2026-08-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.048ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.062ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.123ms | 0.024ms | FAILED | js |
| string/split | 0.434ms | 4.97ms | 0.505ms | FAILED | js |
| string/replace | 0.095ms | 0.214ms | 0.072ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.235ms | 0.113ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.936ms | 0.264ms | FAILED | js |
| string/startsWith-endsWith | 0.414ms | 2.48ms | 0.307ms | FAILED | gc-native |
| array/push-pop | 1.69ms | 0.609ms | 0.601ms | FAILED | gc-native |
| array/sort-i32 | 0.865ms | 0.314ms | 0.308ms | FAILED | gc-native |
| array/map-filter | 0.137ms | 0.062ms | 0.061ms | FAILED | gc-native |
| array/reduce | 2.42ms | 0.632ms | 0.609ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 3.79ms | 3.79ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.018ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.98ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.283ms | 0.016ms | 0.016ms | 1.21ms | gc-native |
| dom/create-elements | 0.040ms | 0.177ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.563ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.152ms | — | — | js |
| dom/modify-text | 0.052ms | 0.128ms | — | — | js |
| mixed/csv-parse | 0.505ms | 7.88ms | 0.606ms | FAILED | js |
| mixed/text-search | 0.392ms | 2.25ms | 0.356ms | FAILED | gc-native |
| mixed/fibonacci | 0.125ms | 0.130ms | 0.130ms | 0.048ms | linear-memory |
| mixed/matrix-multiply | 0.188ms | 0.201ms | 0.201ms | 0.721ms | js |
| mixed/sieve | 1.85ms | 1.50ms | 1.50ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.03 | 4.78 | 4.31 | — |
| string/concat-long | 1000 | 4.32 | 5.45 | 5.01 | — |
| string/indexOf | 1000 | 19.03 | 61.81 | 23.92 | — |
| string/includes | 1000 | 18.73 | 123.35 | 23.71 | — |
| string/split | 10000 | 43.39 | 496.85 | 50.49 | — |
| string/replace | 1000 | 94.70 | 213.51 | 72.35 | — |
| string/case-convert | 2000 | 29.02 | 117.52 | 56.28 | — |
| string/substring | 10000 | 10.45 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.26 | 93.63 | 26.36 | — |
| string/startsWith-endsWith | 20000 | 20.68 | 123.77 | 15.33 | — |
| array/map-filter | 30000 | 4.58 | 2.05 | 2.04 | — |
| array/indexOf | 1000 | 4459.65 | 3789.02 | 3787.37 | — |
| dom/create-elements | 2000 | 19.93 | 88.47 | — | — |
| dom/set-attributes | 6000 | 18.25 | 93.80 | — | — |
| dom/read-attributes | 3000 | 19.55 | 50.50 | — | — |
| dom/modify-text | 2000 | 26.00 | 64.17 | — | — |
| mixed/csv-parse | 11000 | 45.88 | 715.94 | 55.09 | — |
| mixed/text-search | 40000 | 9.80 | 56.19 | 8.89 | — |
| mixed/fibonacci | 10000 | 12.54 | 13.00 | 13.00 | 4.76 |
| mixed/matrix-multiply | 125000 | 1.50 | 1.61 | 1.61 | 5.76 |
| mixed/sieve | 200000 | 9.23 | 7.49 | 7.48 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.42x slower | — |
| string/concat-long | 1.26x slower | 1.16x slower | — |
| string/indexOf | 3.25x slower | 1.26x slower | — |
| string/includes | 6.58x slower | 1.27x slower | — |
| string/split | 11.45x slower | 1.16x slower | — |
| string/replace | 2.25x slower | 1.31x faster | — |
| string/case-convert | 4.05x slower | 1.94x slower | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 5.42x slower | 1.53x slower | — |
| string/startsWith-endsWith | 5.98x slower | 1.35x faster | — |
| array/push-pop | 2.78x faster | 2.82x faster | — |
| array/sort-i32 | 2.75x faster | 2.81x faster | — |
| array/map-filter | 2.23x faster | 2.24x faster | — |
| array/reduce | 3.82x faster | 3.96x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.18x faster | 2.07x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.89x faster | 1.87x faster | — |
| array/find | 17.73x faster | 18.06x faster | 4.27x slower |
| dom/create-elements | 4.44x slower | — | — |
| dom/set-attributes | 5.14x slower | — | — |
| dom/read-attributes | 2.58x slower | — | — |
| dom/modify-text | 2.47x slower | — | — |
| mixed/csv-parse | 15.60x slower | 1.20x slower | — |
| mixed/text-search | 5.73x slower | 1.10x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 2.63x faster |
| mixed/matrix-multiply | 1.07x slower | 1.07x slower | 3.83x slower |
| mixed/sieve | 1.23x faster | 1.24x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.09x faster |
| string/indexOf | 2.58x faster |
| string/includes | 5.20x faster |
| string/split | 9.84x faster |
| string/replace | 2.95x faster |
| string/case-convert | 2.09x faster |
| string/substring | 1.16x faster |
| string/trim | 3.55x faster |
| string/startsWith-endsWith | 8.07x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.04x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 13.00x faster |
| mixed/text-search | 6.32x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1227.7ms | 1078.1ms | — |
| string/concat-long | 618.9ms | 938.4ms | — |
| string/indexOf | 759.2ms | 985.2ms | — |
| string/includes | 746.5ms | 977.5ms | — |
| string/split | 741.2ms | 963.9ms | — |
| string/replace | 800.7ms | 1064.5ms | — |
| string/case-convert | 821.0ms | 1131.2ms | — |
| string/substring | 647.0ms | 703.6ms | — |
| string/trim | 728.6ms | 1017.0ms | — |
| string/startsWith-endsWith | 724.6ms | 980.9ms | — |
| array/push-pop | 770.3ms | 805.9ms | — |
| array/sort-i32 | 933.6ms | 983.4ms | — |
| array/map-filter | 900.7ms | 996.0ms | — |
| array/reduce | 814.5ms | 930.6ms | — |
| array/indexOf | 849.1ms | 910.3ms | — |
| array/slice | 769.2ms | 829.5ms | — |
| array/reverse | 765.0ms | 789.3ms | — |
| array/forEach | 847.6ms | 917.6ms | — |
| array/find | 740.1ms | 804.6ms | 808.1ms |
| dom/create-elements | 614.5ms | — | — |
| dom/set-attributes | 727.3ms | — | — |
| dom/read-attributes | 682.7ms | — | — |
| dom/modify-text | 683.3ms | — | — |
| mixed/csv-parse | 800.5ms | 965.8ms | — |
| mixed/text-search | 774.5ms | 997.8ms | — |
| mixed/fibonacci | 774.0ms | 817.9ms | 714.8ms |
| mixed/matrix-multiply | 810.0ms | 865.6ms | 789.2ms |
| mixed/sieve | 801.7ms | 869.0ms | — |
