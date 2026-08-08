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
| string/includes | 0.019ms | 0.123ms | 0.023ms | FAILED | js |
| string/split | 0.422ms | 5.05ms | 0.506ms | FAILED | js |
| string/replace | 0.096ms | 0.221ms | 0.072ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.239ms | 0.112ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.174ms | 0.932ms | 0.265ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.43ms | 0.307ms | FAILED | gc-native |
| array/push-pop | 1.68ms | 0.597ms | 0.590ms | FAILED | gc-native |
| array/sort-i32 | 0.845ms | 0.314ms | 0.311ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.061ms | 0.060ms | FAILED | gc-native |
| array/reduce | 2.37ms | 0.597ms | 0.598ms | FAILED | host-call |
| array/indexOf | 4.46ms | 3.79ms | 3.79ms | FAILED | host-call |
| array/slice | 0.033ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 8.83ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.280ms | 0.016ms | 0.016ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.162ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.572ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.150ms | — | — | js |
| dom/modify-text | 0.050ms | 0.128ms | — | — | js |
| mixed/csv-parse | 0.469ms | 7.90ms | 0.602ms | FAILED | js |
| mixed/text-search | 0.402ms | 2.25ms | 0.356ms | FAILED | gc-native |
| mixed/fibonacci | 0.125ms | 0.130ms | 0.130ms | 0.091ms | linear-memory |
| mixed/matrix-multiply | 0.184ms | 0.200ms | 0.200ms | 0.723ms | js |
| mixed/sieve | 1.77ms | 1.50ms | 1.47ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.26 | 4.76 | 4.24 | — |
| string/concat-long | 1000 | 4.21 | 5.24 | 4.91 | — |
| string/indexOf | 1000 | 19.01 | 61.83 | 23.65 | — |
| string/includes | 1000 | 18.74 | 122.94 | 23.47 | — |
| string/split | 10000 | 42.24 | 505.27 | 50.56 | — |
| string/replace | 1000 | 96.44 | 221.16 | 72.37 | — |
| string/case-convert | 2000 | 29.05 | 119.47 | 56.19 | — |
| string/substring | 10000 | 10.41 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.38 | 93.21 | 26.50 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 121.71 | 15.33 | — |
| array/map-filter | 30000 | 4.47 | 2.02 | 2.00 | — |
| array/indexOf | 1000 | 4457.57 | 3785.54 | 3785.77 | — |
| dom/create-elements | 2000 | 18.90 | 80.91 | — | — |
| dom/set-attributes | 6000 | 17.75 | 95.37 | — | — |
| dom/read-attributes | 3000 | 19.10 | 50.14 | — | — |
| dom/modify-text | 2000 | 25.09 | 64.19 | — | — |
| mixed/csv-parse | 11000 | 42.59 | 718.52 | 54.74 | — |
| mixed/text-search | 40000 | 10.06 | 56.28 | 8.90 | — |
| mixed/fibonacci | 10000 | 12.53 | 13.00 | 13.00 | 9.06 |
| mixed/matrix-multiply | 125000 | 1.47 | 1.60 | 1.60 | 5.79 |
| mixed/sieve | 200000 | 8.86 | 7.50 | 7.33 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.30x slower | — |
| string/concat-long | 1.24x slower | 1.17x slower | — |
| string/indexOf | 3.25x slower | 1.24x slower | — |
| string/includes | 6.56x slower | 1.25x slower | — |
| string/split | 11.96x slower | 1.20x slower | — |
| string/replace | 2.29x slower | 1.33x faster | — |
| string/case-convert | 4.11x slower | 1.93x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.36x slower | 1.53x slower | — |
| string/startsWith-endsWith | 5.89x slower | 1.35x faster | — |
| array/push-pop | 2.81x faster | 2.85x faster | — |
| array/sort-i32 | 2.69x faster | 2.72x faster | — |
| array/map-filter | 2.21x faster | 2.23x faster | — |
| array/reduce | 3.98x faster | 3.97x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.08x faster | 2.03x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.90x faster | 1.90x faster | — |
| array/find | 17.98x faster | 18.02x faster | 4.30x slower |
| dom/create-elements | 4.28x slower | — | — |
| dom/set-attributes | 5.37x slower | — | — |
| dom/read-attributes | 2.63x slower | — | — |
| dom/modify-text | 2.56x slower | — | — |
| mixed/csv-parse | 16.87x slower | 1.29x slower | — |
| mixed/text-search | 5.59x slower | 1.13x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 1.38x faster |
| mixed/matrix-multiply | 1.08x slower | 1.09x slower | 3.92x slower |
| mixed/sieve | 1.18x faster | 1.21x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x faster |
| string/concat-long | 1.07x faster |
| string/indexOf | 2.61x faster |
| string/includes | 5.24x faster |
| string/split | 9.99x faster |
| string/replace | 3.06x faster |
| string/case-convert | 2.13x faster |
| string/substring | 1.16x faster |
| string/trim | 3.52x faster |
| string/startsWith-endsWith | 7.94x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.13x faster |
| mixed/text-search | 6.32x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x faster |

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
| string/concat-short | 1206.8ms | 1071.3ms | — |
| string/concat-long | 600.3ms | 948.8ms | — |
| string/indexOf | 768.2ms | 954.9ms | — |
| string/includes | 747.4ms | 954.4ms | — |
| string/split | 737.6ms | 918.4ms | — |
| string/replace | 808.0ms | 1065.2ms | — |
| string/case-convert | 774.3ms | 1097.9ms | — |
| string/substring | 623.4ms | 703.3ms | — |
| string/trim | 721.7ms | 977.6ms | — |
| string/startsWith-endsWith | 730.9ms | 971.2ms | — |
| array/push-pop | 726.3ms | 791.6ms | — |
| array/sort-i32 | 901.5ms | 933.0ms | — |
| array/map-filter | 859.5ms | 946.3ms | — |
| array/reduce | 820.2ms | 855.1ms | — |
| array/indexOf | 817.6ms | 864.7ms | — |
| array/slice | 748.6ms | 814.7ms | — |
| array/reverse | 729.0ms | 792.6ms | — |
| array/forEach | 837.7ms | 931.8ms | — |
| array/find | 733.5ms | 801.9ms | 797.6ms |
| dom/create-elements | 596.6ms | — | — |
| dom/set-attributes | 680.2ms | — | — |
| dom/read-attributes | 682.5ms | — | — |
| dom/modify-text | 676.5ms | — | — |
| mixed/csv-parse | 752.6ms | 983.0ms | — |
| mixed/text-search | 725.2ms | 996.2ms | — |
| mixed/fibonacci | 774.7ms | 830.6ms | 716.7ms |
| mixed/matrix-multiply | 844.1ms | 856.9ms | 777.8ms |
| mixed/sieve | 789.4ms | 880.9ms | — |
