# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.050ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.062ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.119ms | 0.024ms | FAILED | js |
| string/split | 0.446ms | 4.98ms | 0.506ms | FAILED | js |
| string/replace | 0.096ms | 0.219ms | 0.073ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.235ms | 0.113ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.933ms | 0.336ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.42ms | 0.307ms | FAILED | gc-native |
| array/push-pop | 1.68ms | 0.607ms | 0.603ms | FAILED | gc-native |
| array/sort-i32 | 0.846ms | 0.362ms | 0.307ms | FAILED | gc-native |
| array/map-filter | 0.136ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.60ms | 0.599ms | 0.600ms | FAILED | host-call |
| array/indexOf | 4.46ms | 3.79ms | 3.78ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.093ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.282ms | 0.016ms | 0.016ms | 1.21ms | host-call |
| dom/create-elements | 0.039ms | 0.166ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.525ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.151ms | — | — | js |
| dom/modify-text | 0.052ms | 0.129ms | — | — | js |
| mixed/csv-parse | 0.481ms | 7.64ms | 0.589ms | FAILED | js |
| mixed/text-search | 0.403ms | 2.26ms | 0.357ms | FAILED | gc-native |
| mixed/fibonacci | 0.125ms | 0.130ms | 0.130ms | 0.050ms | linear-memory |
| mixed/matrix-multiply | 0.186ms | 0.201ms | 0.200ms | 0.722ms | js |
| mixed/sieve | 1.78ms | 1.48ms | 1.48ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.33 | 5.02 | 3.84 | — |
| string/concat-long | 1000 | 3.98 | 5.15 | 4.73 | — |
| string/indexOf | 1000 | 19.02 | 62.25 | 23.56 | — |
| string/includes | 1000 | 18.74 | 118.85 | 23.59 | — |
| string/split | 10000 | 44.59 | 497.74 | 50.55 | — |
| string/replace | 1000 | 95.76 | 219.12 | 72.74 | — |
| string/case-convert | 2000 | 28.98 | 117.47 | 56.31 | — |
| string/substring | 10000 | 10.41 | 4.00 | 3.44 | — |
| string/trim | 10000 | 17.28 | 93.32 | 33.65 | — |
| string/startsWith-endsWith | 20000 | 20.66 | 121.15 | 15.33 | — |
| array/map-filter | 30000 | 4.53 | 2.18 | 2.18 | — |
| array/indexOf | 1000 | 4461.08 | 3787.11 | 3784.93 | — |
| dom/create-elements | 2000 | 19.48 | 83.18 | — | — |
| dom/set-attributes | 6000 | 18.09 | 87.45 | — | — |
| dom/read-attributes | 3000 | 19.57 | 50.46 | — | — |
| dom/modify-text | 2000 | 25.92 | 64.32 | — | — |
| mixed/csv-parse | 11000 | 43.69 | 694.11 | 53.54 | — |
| mixed/text-search | 40000 | 10.08 | 56.45 | 8.93 | — |
| mixed/fibonacci | 10000 | 12.52 | 13.00 | 13.00 | 5.05 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.60 | 1.60 | 5.78 |
| mixed/sieve | 200000 | 8.91 | 7.38 | 7.42 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.15x slower | — |
| string/concat-long | 1.29x slower | 1.19x slower | — |
| string/indexOf | 3.27x slower | 1.24x slower | — |
| string/includes | 6.34x slower | 1.26x slower | — |
| string/split | 11.16x slower | 1.13x slower | — |
| string/replace | 2.29x slower | 1.32x faster | — |
| string/case-convert | 4.05x slower | 1.94x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.40x slower | 1.95x slower | — |
| string/startsWith-endsWith | 5.86x slower | 1.35x faster | — |
| array/push-pop | 2.77x faster | 2.80x faster | — |
| array/sort-i32 | 2.34x faster | 2.75x faster | — |
| array/map-filter | 2.08x faster | 2.08x faster | — |
| array/reduce | 2.67x faster | 2.67x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.18x faster | 2.10x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.23x faster | 3.24x faster | — |
| array/find | 17.90x faster | 17.84x faster | 4.27x slower |
| dom/create-elements | 4.27x slower | — | — |
| dom/set-attributes | 4.83x slower | — | — |
| dom/read-attributes | 2.58x slower | — | — |
| dom/modify-text | 2.48x slower | — | — |
| mixed/csv-parse | 15.89x slower | 1.23x slower | — |
| mixed/text-search | 5.60x slower | 1.13x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 2.48x faster |
| mixed/matrix-multiply | 1.08x slower | 1.08x slower | 3.88x slower |
| mixed/sieve | 1.21x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.31x faster |
| string/concat-long | 1.09x faster |
| string/indexOf | 2.64x faster |
| string/includes | 5.04x faster |
| string/split | 9.85x faster |
| string/replace | 3.01x faster |
| string/case-convert | 2.09x faster |
| string/substring | 1.16x faster |
| string/trim | 2.77x faster |
| string/startsWith-endsWith | 7.90x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.18x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 12.97x faster |
| mixed/text-search | 6.32x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1290.6ms | 1080.4ms | — |
| string/concat-long | 630.0ms | 968.4ms | — |
| string/indexOf | 776.0ms | 1019.6ms | — |
| string/includes | 795.7ms | 1031.2ms | — |
| string/split | 741.0ms | 959.4ms | — |
| string/replace | 835.6ms | 1070.8ms | — |
| string/case-convert | 815.4ms | 1255.4ms | — |
| string/substring | 657.2ms | 750.3ms | — |
| string/trim | 732.9ms | 993.8ms | — |
| string/startsWith-endsWith | 727.7ms | 963.2ms | — |
| array/push-pop | 739.1ms | 845.1ms | — |
| array/sort-i32 | 903.5ms | 1020.0ms | — |
| array/map-filter | 907.5ms | 984.3ms | — |
| array/reduce | 847.2ms | 863.6ms | — |
| array/indexOf | 808.7ms | 880.1ms | — |
| array/slice | 753.0ms | 827.6ms | — |
| array/reverse | 734.7ms | 793.0ms | — |
| array/forEach | 854.0ms | 938.4ms | — |
| array/find | 724.5ms | 808.5ms | 837.3ms |
| dom/create-elements | 626.2ms | — | — |
| dom/set-attributes | 721.2ms | — | — |
| dom/read-attributes | 682.5ms | — | — |
| dom/modify-text | 681.8ms | — | — |
| mixed/csv-parse | 753.0ms | 1004.2ms | — |
| mixed/text-search | 742.1ms | 1031.6ms | — |
| mixed/fibonacci | 788.3ms | 813.6ms | 735.5ms |
| mixed/matrix-multiply | 823.8ms | 855.0ms | 784.0ms |
| mixed/sieve | 809.7ms | 859.7ms | — |
