# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.042ms | 0.046ms | 0.047ms | FAILED | js |
| string/concat-long | 0.004ms | 0.009ms | 0.009ms | FAILED | js |
| string/indexOf | 0.018ms | 0.079ms | 0.025ms | FAILED | js |
| string/includes | 0.018ms | 0.130ms | 0.023ms | FAILED | js |
| string/split | 0.381ms | 6.71ms | 1.43ms | FAILED | js |
| string/replace | 0.045ms | 0.259ms | 0.100ms | FAILED | js |
| string/case-convert | 0.060ms | 0.274ms | 0.108ms | FAILED | js |
| string/substring | 0.098ms | 2.06ms | 1.02ms | FAILED | js |
| string/trim | 0.156ms | 1.34ms | 0.738ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 2.94ms | 0.543ms | FAILED | js |
| array/push-pop | 1.47ms | 2.21ms | 2.18ms | FAILED | js |
| array/sort-i32 | 0.710ms | 0.377ms | 0.374ms | FAILED | gc-native |
| array/map-filter | 0.143ms | 0.675ms | 0.680ms | FAILED | js |
| array/reduce | 1.37ms | 2.19ms | 2.18ms | FAILED | js |
| array/indexOf | 4.82ms | 3.98ms | 3.99ms | FAILED | host-call |
| array/slice | 0.036ms | 0.042ms | 0.042ms | FAILED | js |
| array/reverse | 7.26ms | 4.14ms | 4.14ms | FAILED | host-call |
| array/forEach | 0.075ms | 0.116ms | 0.115ms | FAILED | js |
| array/find | 0.264ms | 0.492ms | 0.491ms | 4.69ms | js |
| dom/create-elements | 0.254ms | 0.292ms | — | — | js |
| dom/set-attributes | 0.122ms | 0.378ms | — | — | js |
| dom/read-attributes | 0.068ms | 0.189ms | — | — | js |
| dom/modify-text | 0.068ms | 0.175ms | — | — | js |
| mixed/csv-parse | 0.461ms | 6.68ms | 0.856ms | FAILED | js |
| mixed/text-search | 0.395ms | 6.18ms | 1.16ms | FAILED | js |
| mixed/fibonacci | 0.144ms | 0.209ms | 0.209ms | 0.208ms | js |
| mixed/matrix-multiply | 0.203ms | 0.786ms | 0.781ms | 1.95ms | js |
| mixed/sieve | 1.62ms | 1.49ms | 1.49ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
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
| string/concat-short | 10000 | 4.23 | 4.55 | 4.67 | — |
| string/concat-long | 1000 | 4.07 | 8.95 | 9.41 | — |
| string/indexOf | 1000 | 17.89 | 78.63 | 24.90 | — |
| string/includes | 1000 | 17.94 | 130.16 | 23.48 | — |
| string/split | 10000 | 38.14 | 671.49 | 143.29 | — |
| string/replace | 1000 | 44.51 | 258.65 | 99.65 | — |
| string/case-convert | 2000 | 30.23 | 137.11 | 53.91 | — |
| string/substring | 10000 | 9.85 | 206.14 | 101.59 | — |
| string/trim | 10000 | 15.61 | 133.99 | 73.78 | — |
| string/startsWith-endsWith | 20000 | 20.13 | 147.02 | 27.17 | — |
| mixed/csv-parse | 11000 | 41.88 | 606.83 | 77.82 | — |
| mixed/text-search | 40000 | 9.88 | 154.62 | 28.96 | — |
| mixed/fibonacci | 10000 | 14.38 | 20.95 | 20.95 | 20.85 |
| mixed/matrix-multiply | 125000 | 1.63 | 6.29 | 6.25 | 15.57 |
| mixed/sieve | 200000 | 8.08 | 7.44 | 7.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.08x slower | 1.10x slower | — |
| string/concat-long | 2.20x slower | 2.31x slower | — |
| string/indexOf | 4.40x slower | 1.39x slower | — |
| string/includes | 7.26x slower | 1.31x slower | — |
| string/split | 17.61x slower | 3.76x slower | — |
| string/replace | 5.81x slower | 2.24x slower | — |
| string/case-convert | 4.53x slower | 1.78x slower | — |
| string/substring | 20.93x slower | 10.31x slower | — |
| string/trim | 8.58x slower | 4.73x slower | — |
| string/startsWith-endsWith | 7.30x slower | 1.35x slower | — |
| array/push-pop | 1.50x slower | 1.48x slower | — |
| array/sort-i32 | 1.88x faster | 1.90x faster | — |
| array/map-filter | 4.73x slower | 4.77x slower | — |
| array/reduce | 1.60x slower | 1.59x slower | — |
| array/indexOf | 1.21x faster | 1.21x faster | — |
| array/slice | 1.18x slower | 1.16x slower | — |
| array/reverse | 1.75x faster | 1.75x faster | — |
| array/forEach | 1.55x slower | 1.54x slower | — |
| array/find | 1.86x slower | 1.86x slower | 17.76x slower |
| dom/create-elements | 1.15x slower | — | — |
| dom/set-attributes | 3.09x slower | — | — |
| dom/read-attributes | 2.78x slower | — | — |
| dom/modify-text | 2.57x slower | — | — |
| mixed/csv-parse | 14.49x slower | 1.86x slower | — |
| mixed/text-search | 15.65x slower | 2.93x slower | — |
| mixed/fibonacci | 1.46x slower | 1.46x slower | 1.45x slower |
| mixed/matrix-multiply | 3.87x slower | 3.84x slower | 9.57x slower |
| mixed/sieve | 1.09x faster | 1.08x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.05x slower |
| string/indexOf | 3.16x faster |
| string/includes | 5.54x faster |
| string/split | 4.69x faster |
| string/replace | 2.60x faster |
| string/case-convert | 2.54x faster |
| string/substring | 2.03x faster |
| string/trim | 1.82x faster |
| string/startsWith-endsWith | 5.41x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 7.80x faster |
| mixed/text-search | 5.34x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1130.6ms | 1097.6ms | — |
| string/concat-long | 591.4ms | 997.3ms | — |
| string/indexOf | 746.8ms | 1016.5ms | — |
| string/includes | 734.0ms | 1021.5ms | — |
| string/split | 790.4ms | 1016.5ms | — |
| string/replace | 799.4ms | 1080.8ms | — |
| string/case-convert | 804.5ms | 1059.2ms | — |
| string/substring | 676.5ms | 976.2ms | — |
| string/trim | 770.3ms | 973.0ms | — |
| string/startsWith-endsWith | 794.2ms | 975.1ms | — |
| array/push-pop | 738.5ms | 786.6ms | — |
| array/sort-i32 | 912.3ms | 972.8ms | — |
| array/map-filter | 918.5ms | 954.4ms | — |
| array/reduce | 839.3ms | 891.5ms | — |
| array/indexOf | 753.1ms | 828.7ms | — |
| array/slice | 750.2ms | 814.3ms | — |
| array/reverse | 727.0ms | 795.2ms | — |
| array/forEach | 850.1ms | 921.3ms | — |
| array/find | 834.4ms | 903.0ms | 778.8ms |
| dom/create-elements | 594.6ms | — | — |
| dom/set-attributes | 690.4ms | — | — |
| dom/read-attributes | 652.0ms | — | — |
| dom/modify-text | 665.3ms | — | — |
| mixed/csv-parse | 826.3ms | 1007.5ms | — |
| mixed/text-search | 786.1ms | 997.7ms | — |
| mixed/fibonacci | 747.0ms | 851.8ms | 741.5ms |
| mixed/matrix-multiply | 847.9ms | 916.4ms | 779.0ms |
| mixed/sieve | 767.6ms | 810.6ms | — |
