# js2wasm Benchmark Results

Date: 2026-08-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.044ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.077ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.155ms | 0.021ms | FAILED | js |
| string/split | 0.425ms | 5.72ms | 0.450ms | FAILED | js |
| string/replace | 0.104ms | 0.326ms | 0.081ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.263ms | 0.120ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 1.06ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.80ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.45ms | 0.507ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.789ms | 0.333ms | 0.333ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.547ms | 0.549ms | FAILED | js |
| array/reduce | 2.14ms | 0.502ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.95ms | 3.78ms | 3.78ms | FAILED | host-call |
| array/slice | 0.025ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.82ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.239ms | 0.017ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.041ms | 0.294ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.357ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.168ms | — | — | js |
| dom/modify-text | 0.048ms | 0.156ms | — | — | js |
| mixed/csv-parse | 0.482ms | 8.53ms | 0.804ms | FAILED | js |
| mixed/text-search | 0.390ms | 2.64ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.158ms | 0.191ms | 0.191ms | 0.721ms | js |
| mixed/sieve | 1.59ms | 1.39ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.13 | 4.45 | 3.86 | — |
| string/concat-long | 1000 | 3.57 | 4.58 | 4.64 | — |
| string/indexOf | 1000 | 19.12 | 77.00 | 20.85 | — |
| string/includes | 1000 | 19.21 | 154.94 | 20.50 | — |
| string/split | 10000 | 42.49 | 572.48 | 44.99 | — |
| string/replace | 1000 | 103.81 | 325.89 | 80.60 | — |
| string/case-convert | 2000 | 27.80 | 131.29 | 60.11 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 105.83 | 24.35 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 139.89 | 14.33 | — |
| array/map-filter | 30000 | 4.31 | 18.23 | 18.31 | — |
| array/indexOf | 1000 | 3950.40 | 3777.96 | 3778.56 | — |
| dom/create-elements | 2000 | 20.29 | 146.87 | — | — |
| dom/set-attributes | 6000 | 17.16 | 59.45 | — | — |
| dom/read-attributes | 3000 | 18.10 | 56.14 | — | — |
| dom/modify-text | 2000 | 23.88 | 78.00 | — | — |
| mixed/csv-parse | 11000 | 43.85 | 775.02 | 73.11 | — |
| mixed/text-search | 40000 | 9.75 | 66.07 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 4.41 | 4.39 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.52 | 1.53 | 5.77 |
| mixed/sieve | 200000 | 7.94 | 6.94 | 6.90 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.23x slower | — |
| string/concat-long | 1.28x slower | 1.30x slower | — |
| string/indexOf | 4.03x slower | 1.09x slower | — |
| string/includes | 8.07x slower | 1.07x slower | — |
| string/split | 13.47x slower | 1.06x slower | — |
| string/replace | 3.14x slower | 1.29x faster | — |
| string/case-convert | 4.72x slower | 2.16x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 6.23x slower | 1.43x slower | — |
| string/startsWith-endsWith | 6.96x slower | 1.40x faster | — |
| array/push-pop | 2.86x faster | 2.89x faster | — |
| array/sort-i32 | 2.37x faster | 2.37x faster | — |
| array/map-filter | 4.23x slower | 4.25x slower | — |
| array/reduce | 4.26x faster | 4.23x faster | — |
| array/indexOf | 1.05x faster | 1.05x faster | — |
| array/slice | 1.05x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 14.45x faster | 14.53x faster | 4.51x slower |
| dom/create-elements | 7.24x slower | — | — |
| dom/set-attributes | 3.46x slower | — | — |
| dom/read-attributes | 3.10x slower | — | — |
| dom/modify-text | 3.27x slower | — | — |
| mixed/csv-parse | 17.67x slower | 1.67x slower | — |
| mixed/text-search | 6.78x slower | 1.19x faster | — |
| mixed/fibonacci | 2.76x faster | 2.77x faster | 2.79x faster |
| mixed/matrix-multiply | 1.21x slower | 1.21x slower | 4.56x slower |
| mixed/sieve | 1.14x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 3.69x faster |
| string/includes | 7.56x faster |
| string/split | 12.73x faster |
| string/replace | 4.04x faster |
| string/case-convert | 2.18x faster |
| string/substring | 1.22x faster |
| string/trim | 4.35x faster |
| string/startsWith-endsWith | 9.76x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 10.60x faster |
| mixed/text-search | 8.05x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.0KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
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
| mixed/csv-parse | 2.2KB | 4.8KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1323.2ms | 1105.4ms | — |
| string/concat-long | 644.1ms | 945.1ms | — |
| string/indexOf | 773.5ms | 1034.1ms | — |
| string/includes | 765.8ms | 985.1ms | — |
| string/split | 782.5ms | 944.7ms | — |
| string/replace | 806.6ms | 1113.0ms | — |
| string/case-convert | 845.3ms | 1110.8ms | — |
| string/substring | 654.3ms | 685.0ms | — |
| string/trim | 737.9ms | 997.5ms | — |
| string/startsWith-endsWith | 731.6ms | 971.6ms | — |
| array/push-pop | 750.8ms | 824.6ms | — |
| array/sort-i32 | 912.5ms | 971.4ms | — |
| array/map-filter | 916.4ms | 970.1ms | — |
| array/reduce | 813.9ms | 862.6ms | — |
| array/indexOf | 801.3ms | 891.8ms | — |
| array/slice | 778.6ms | 849.0ms | — |
| array/reverse | 770.1ms | 836.6ms | — |
| array/forEach | 889.2ms | 969.6ms | — |
| array/find | 761.8ms | 855.4ms | 841.9ms |
| dom/create-elements | 605.3ms | — | — |
| dom/set-attributes | 689.6ms | — | — |
| dom/read-attributes | 665.2ms | — | — |
| dom/modify-text | 682.7ms | — | — |
| mixed/csv-parse | 818.7ms | 1032.7ms | — |
| mixed/text-search | 743.5ms | 1032.4ms | — |
| mixed/fibonacci | 756.4ms | 785.1ms | 722.4ms |
| mixed/matrix-multiply | 848.7ms | 942.5ms | 791.8ms |
| mixed/sieve | 837.1ms | 868.2ms | — |
