# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.042ms | 0.046ms | 0.047ms | FAILED | js |
| string/concat-long | 0.004ms | 0.009ms | 0.009ms | FAILED | js |
| string/indexOf | 0.018ms | 0.080ms | 0.025ms | FAILED | js |
| string/includes | 0.018ms | 0.135ms | 0.024ms | FAILED | js |
| string/split | 0.452ms | 5.74ms | 1.44ms | FAILED | js |
| string/replace | 0.045ms | 0.261ms | 0.097ms | FAILED | js |
| string/case-convert | 0.061ms | 0.275ms | 0.109ms | FAILED | js |
| string/substring | 0.120ms | 2.07ms | 1.02ms | FAILED | js |
| string/trim | 0.158ms | 1.32ms | 0.746ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 3.00ms | 0.542ms | FAILED | js |
| array/push-pop | 1.56ms | 2.22ms | 2.21ms | FAILED | js |
| array/sort-i32 | 0.712ms | 0.375ms | 0.376ms | FAILED | host-call |
| array/map-filter | 0.144ms | 0.671ms | 0.681ms | FAILED | js |
| array/reduce | 1.98ms | 2.22ms | 2.21ms | FAILED | js |
| array/indexOf | 4.81ms | 4.00ms | 4.00ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.043ms | 0.043ms | FAILED | js |
| array/reverse | 7.27ms | 4.14ms | 4.14ms | FAILED | host-call |
| array/forEach | 0.099ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.265ms | 0.493ms | 0.492ms | 4.69ms | js |
| dom/create-elements | 0.057ms | 0.291ms | — | — | js |
| dom/set-attributes | 0.123ms | 0.374ms | — | — | js |
| dom/read-attributes | 0.064ms | 0.181ms | — | — | js |
| dom/modify-text | 0.067ms | 0.172ms | — | — | js |
| mixed/csv-parse | 0.446ms | 6.76ms | 0.862ms | FAILED | js |
| mixed/text-search | 0.396ms | 5.86ms | 1.17ms | FAILED | js |
| mixed/fibonacci | 0.144ms | 0.210ms | 0.209ms | 1.03ms | js |
| mixed/matrix-multiply | 0.204ms | 0.774ms | 0.788ms | 1.94ms | js |
| mixed/sieve | 1.51ms | 1.52ms | 1.50ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 4.25 | 4.60 | 4.72 | — |
| string/concat-long | 1000 | 4.28 | 8.86 | 9.44 | — |
| string/indexOf | 1000 | 17.89 | 79.70 | 24.90 | — |
| string/includes | 1000 | 17.91 | 134.59 | 23.52 | — |
| string/split | 10000 | 45.21 | 574.01 | 143.72 | — |
| string/replace | 1000 | 45.28 | 261.20 | 96.83 | — |
| string/case-convert | 2000 | 30.27 | 137.52 | 54.43 | — |
| string/substring | 10000 | 12.02 | 207.01 | 101.75 | — |
| string/trim | 10000 | 15.76 | 132.10 | 74.60 | — |
| string/startsWith-endsWith | 20000 | 20.14 | 149.94 | 27.09 | — |
| mixed/csv-parse | 11000 | 40.52 | 614.67 | 78.34 | — |
| mixed/text-search | 40000 | 9.90 | 146.38 | 29.19 | — |
| mixed/fibonacci | 10000 | 14.39 | 20.96 | 20.95 | 102.88 |
| mixed/matrix-multiply | 125000 | 1.63 | 6.19 | 6.31 | 15.55 |
| mixed/sieve | 200000 | 7.55 | 7.61 | 7.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.08x slower | 1.11x slower | — |
| string/concat-long | 2.07x slower | 2.20x slower | — |
| string/indexOf | 4.46x slower | 1.39x slower | — |
| string/includes | 7.51x slower | 1.31x slower | — |
| string/split | 12.70x slower | 3.18x slower | — |
| string/replace | 5.77x slower | 2.14x slower | — |
| string/case-convert | 4.54x slower | 1.80x slower | — |
| string/substring | 17.22x slower | 8.46x slower | — |
| string/trim | 8.38x slower | 4.73x slower | — |
| string/startsWith-endsWith | 7.44x slower | 1.35x slower | — |
| array/push-pop | 1.42x slower | 1.41x slower | — |
| array/sort-i32 | 1.90x faster | 1.90x faster | — |
| array/map-filter | 4.65x slower | 4.72x slower | — |
| array/reduce | 1.12x slower | 1.12x slower | — |
| array/indexOf | 1.20x faster | 1.20x faster | — |
| array/slice | 1.16x slower | 1.17x slower | — |
| array/reverse | 1.76x faster | 1.75x faster | — |
| array/forEach | 1.16x slower | 1.16x slower | — |
| array/find | 1.86x slower | 1.86x slower | 17.69x slower |
| dom/create-elements | 5.12x slower | — | — |
| dom/set-attributes | 3.03x slower | — | — |
| dom/read-attributes | 2.81x slower | — | — |
| dom/modify-text | 2.55x slower | — | — |
| mixed/csv-parse | 15.17x slower | 1.93x slower | — |
| mixed/text-search | 14.78x slower | 2.95x slower | — |
| mixed/fibonacci | 1.46x slower | 1.46x slower | 7.15x slower |
| mixed/matrix-multiply | 3.80x slower | 3.87x slower | 9.54x slower |
| mixed/sieve | 1.01x slower | 1.01x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.06x slower |
| string/indexOf | 3.20x faster |
| string/includes | 5.72x faster |
| string/split | 3.99x faster |
| string/replace | 2.70x faster |
| string/case-convert | 2.53x faster |
| string/substring | 2.03x faster |
| string/trim | 1.77x faster |
| string/startsWith-endsWith | 5.53x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.02x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 7.85x faster |
| mixed/text-search | 5.02x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1227.5ms | 1144.3ms | — |
| string/concat-long | 598.5ms | 970.4ms | — |
| string/indexOf | 731.7ms | 1005.2ms | — |
| string/includes | 717.4ms | 973.4ms | — |
| string/split | 791.6ms | 1052.4ms | — |
| string/replace | 766.9ms | 1069.4ms | — |
| string/case-convert | 790.2ms | 1068.3ms | — |
| string/substring | 682.4ms | 971.4ms | — |
| string/trim | 769.1ms | 964.8ms | — |
| string/startsWith-endsWith | 774.5ms | 978.7ms | — |
| array/push-pop | 733.1ms | 768.5ms | — |
| array/sort-i32 | 901.8ms | 966.6ms | — |
| array/map-filter | 916.5ms | 1005.1ms | — |
| array/reduce | 841.9ms | 885.1ms | — |
| array/indexOf | 727.7ms | 829.5ms | — |
| array/slice | 746.8ms | 779.0ms | — |
| array/reverse | 722.3ms | 771.8ms | — |
| array/forEach | 845.5ms | 898.2ms | — |
| array/find | 864.4ms | 891.6ms | 797.7ms |
| dom/create-elements | 571.6ms | — | — |
| dom/set-attributes | 677.7ms | — | — |
| dom/read-attributes | 637.1ms | — | — |
| dom/modify-text | 662.9ms | — | — |
| mixed/csv-parse | 828.2ms | 964.4ms | — |
| mixed/text-search | 790.3ms | 970.6ms | — |
| mixed/fibonacci | 761.5ms | 896.7ms | 757.0ms |
| mixed/matrix-multiply | 890.6ms | 944.6ms | 804.7ms |
| mixed/sieve | 795.3ms | 869.0ms | — |
