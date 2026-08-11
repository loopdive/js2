# js2wasm Benchmark Results

Date: 2026-08-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.037ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.018ms | gc-native |
| string/includes | 0.015ms | 0.033ms | 0.011ms | 0.014ms | gc-native |
| string/split | 0.328ms | 3.50ms | 0.392ms | FAILED | js |
| string/replace | 0.075ms | 0.178ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.177ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.722ms | 0.153ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.266ms | 0.238ms | 0.438ms | gc-native |
| array/push-pop | 1.31ms | 0.477ms | 0.476ms | FAILED | gc-native |
| array/sort-i32 | 0.655ms | 0.240ms | 0.259ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.052ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.28ms | 0.475ms | 0.479ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.014ms | 0.013ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.212ms | 0.012ms | 0.012ms | 0.867ms | host-call |
| dom/create-elements | 0.192ms | 0.126ms | — | — | host-call |
| dom/set-attributes | 0.089ms | 0.430ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.105ms | — | — | js |
| dom/modify-text | 0.025ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.363ms | 5.30ms | 0.245ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 1.05ms | 0.227ms | 0.866ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.212ms | 0.212ms | 0.219ms | js |
| mixed/matrix-multiply | 0.146ms | 0.163ms | 0.163ms | 0.561ms | js |
| mixed/sieve | 1.39ms | 1.16ms | 1.16ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.66 | 3.72 | 3.25 | — |
| string/concat-long | 1000 | 3.28 | 4.29 | 2.91 | — |
| string/indexOf | 1000 | 14.75 | 47.11 | 9.91 | 18.39 |
| string/includes | 1000 | 14.54 | 33.20 | 11.30 | 13.87 |
| string/split | 10000 | 32.82 | 349.99 | 39.22 | — |
| string/replace | 1000 | 74.67 | 178.17 | 54.48 | — |
| string/case-convert | 2000 | 22.55 | 88.47 | 2.03 | — |
| string/substring | 10000 | 8.11 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.40 | 72.16 | 15.26 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 13.28 | 11.88 | 21.92 |
| array/map-filter | 30000 | 3.59 | 1.74 | 1.73 | — |
| array/indexOf | 1000 | 3460.08 | 2223.73 | 2222.26 | — |
| dom/create-elements | 2000 | 95.99 | 63.15 | — | — |
| dom/set-attributes | 6000 | 14.76 | 71.72 | — | — |
| dom/read-attributes | 3000 | 16.21 | 34.94 | — | — |
| dom/modify-text | 2000 | 12.49 | 44.51 | — | — |
| mixed/csv-parse | 11000 | 32.97 | 481.93 | 22.24 | — |
| mixed/text-search | 40000 | 7.81 | 26.37 | 5.68 | 21.65 |
| mixed/fibonacci | 10000 | 9.72 | 21.17 | 21.17 | 21.93 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.30 | 1.30 | 4.49 |
| mixed/sieve | 200000 | 6.93 | 5.80 | 5.80 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.22x slower | — |
| string/concat-long | 1.31x slower | 1.13x faster | — |
| string/indexOf | 3.19x slower | 1.49x faster | 1.25x slower |
| string/includes | 2.28x slower | 1.29x faster | 1.05x faster |
| string/split | 10.66x slower | 1.19x slower | — |
| string/replace | 2.39x slower | 1.37x faster | — |
| string/case-convert | 3.92x slower | 11.10x faster | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 5.39x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.21x faster | 1.35x faster | 1.37x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.73x faster | 2.53x faster | — |
| array/map-filter | 2.07x faster | 2.08x faster | — |
| array/reduce | 2.70x faster | 2.67x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.21x faster | 2.29x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.87x faster | 1.87x faster | — |
| array/find | 17.82x faster | 17.58x faster | 4.08x slower |
| dom/create-elements | 1.52x faster | — | — |
| dom/set-attributes | 4.86x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.56x slower | — | — |
| mixed/csv-parse | 14.62x slower | 1.48x faster | — |
| mixed/text-search | 3.38x slower | 1.37x faster | 2.77x slower |
| mixed/fibonacci | 2.18x slower | 2.18x slower | 2.26x slower |
| mixed/matrix-multiply | 1.11x slower | 1.11x slower | 3.84x slower |
| mixed/sieve | 1.20x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.48x faster |
| string/indexOf | 4.76x faster |
| string/includes | 2.94x faster |
| string/split | 8.92x faster |
| string/replace | 3.27x faster |
| string/case-convert | 43.55x faster |
| string/substring | 1.16x faster |
| string/trim | 4.73x faster |
| string/startsWith-endsWith | 1.12x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.08x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 21.67x faster |
| mixed/text-search | 4.64x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 961.2ms | 861.0ms | — |
| string/concat-long | 505.3ms | 764.6ms | — |
| string/indexOf | 629.3ms | 764.8ms | 670.3ms |
| string/includes | 618.7ms | 755.8ms | 677.8ms |
| string/split | 598.2ms | 762.4ms | — |
| string/replace | 647.8ms | 840.5ms | — |
| string/case-convert | 635.2ms | 649.0ms | — |
| string/substring | 522.8ms | 566.1ms | — |
| string/trim | 581.7ms | 775.2ms | — |
| string/startsWith-endsWith | 601.2ms | 760.6ms | 706.0ms |
| array/push-pop | 608.7ms | 662.2ms | — |
| array/sort-i32 | 748.7ms | 769.9ms | — |
| array/map-filter | 696.1ms | 789.4ms | — |
| array/reduce | 634.4ms | 727.8ms | — |
| array/indexOf | 691.4ms | 758.9ms | — |
| array/slice | 602.4ms | 655.6ms | — |
| array/reverse | 594.2ms | 648.2ms | — |
| array/forEach | 662.5ms | 716.8ms | — |
| array/find | 603.9ms | 640.8ms | 640.3ms |
| dom/create-elements | 531.8ms | — | — |
| dom/set-attributes | 564.4ms | — | — |
| dom/read-attributes | 550.9ms | — | — |
| dom/modify-text | 499.6ms | — | — |
| mixed/csv-parse | 648.3ms | 789.6ms | — |
| mixed/text-search | 600.7ms | 757.3ms | 690.3ms |
| mixed/fibonacci | 649.3ms | 662.4ms | 607.7ms |
| mixed/matrix-multiply | 664.9ms | 711.5ms | 609.4ms |
| mixed/sieve | 642.7ms | 679.2ms | — |
