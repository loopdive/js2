# js2wasm Benchmark Results

Date: 2026-08-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.037ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.094ms | 0.012ms | 0.032ms | gc-native |
| string/split | 0.335ms | 3.69ms | 0.393ms | FAILED | js |
| string/replace | 0.075ms | 0.173ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.046ms | 0.179ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.724ms | 0.153ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.87ms | 0.238ms | 0.433ms | gc-native |
| array/push-pop | 1.32ms | 0.478ms | 0.478ms | FAILED | gc-native |
| array/sort-i32 | 0.654ms | 0.241ms | 0.246ms | FAILED | host-call |
| array/map-filter | 0.107ms | 0.052ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.94ms | 0.484ms | 0.474ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 1.47ms | 1.47ms | FAILED | host-call |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.045ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.220ms | 0.012ms | 0.012ms | 0.937ms | host-call |
| dom/create-elements | 0.030ms | 0.119ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.381ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.103ms | — | — | js |
| dom/modify-text | 0.023ms | 0.087ms | — | — | js |
| mixed/csv-parse | 0.365ms | 5.28ms | 0.475ms | FAILED | js |
| mixed/text-search | 0.304ms | 1.76ms | 0.228ms | 0.861ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.101ms | 0.101ms | 0.070ms | linear-memory |
| mixed/matrix-multiply | 0.146ms | 0.163ms | 0.163ms | 0.563ms | js |
| mixed/sieve | 1.40ms | 1.19ms | 1.14ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.42 | 3.73 | 3.31 | — |
| string/concat-long | 1000 | 3.22 | 4.03 | 2.95 | — |
| string/indexOf | 1000 | 14.77 | 47.17 | 10.09 | 13.48 |
| string/includes | 1000 | 14.58 | 93.83 | 11.50 | 32.13 |
| string/split | 10000 | 33.53 | 368.71 | 39.29 | — |
| string/replace | 1000 | 75.39 | 172.63 | 54.42 | — |
| string/case-convert | 2000 | 23.05 | 89.70 | 2.12 | — |
| string/substring | 10000 | 8.09 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.39 | 72.40 | 15.31 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 93.49 | 11.89 | 21.63 |
| array/map-filter | 30000 | 3.57 | 1.74 | 1.74 | — |
| array/indexOf | 1000 | 3460.61 | 1468.17 | 1472.82 | — |
| dom/create-elements | 2000 | 15.21 | 59.71 | — | — |
| dom/set-attributes | 6000 | 14.38 | 63.51 | — | — |
| dom/read-attributes | 3000 | 16.61 | 34.46 | — | — |
| dom/modify-text | 2000 | 11.68 | 43.51 | — | — |
| mixed/csv-parse | 11000 | 33.17 | 479.75 | 43.14 | — |
| mixed/text-search | 40000 | 7.60 | 44.02 | 5.70 | 21.53 |
| mixed/fibonacci | 10000 | 9.71 | 10.08 | 10.08 | 7.01 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.30 | 1.30 | 4.50 |
| mixed/sieve | 200000 | 7.01 | 5.97 | 5.70 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.37x slower | — |
| string/concat-long | 1.25x slower | 1.09x faster | — |
| string/indexOf | 3.19x slower | 1.46x faster | 1.10x faster |
| string/includes | 6.43x slower | 1.27x faster | 2.20x slower |
| string/split | 11.00x slower | 1.17x slower | — |
| string/replace | 2.29x slower | 1.39x faster | — |
| string/case-convert | 3.89x slower | 10.86x faster | — |
| string/substring | 2.62x faster | 3.03x faster | — |
| string/trim | 5.41x slower | 1.14x slower | — |
| string/startsWith-endsWith | 5.84x slower | 1.35x faster | 1.35x slower |
| array/push-pop | 2.76x faster | 2.76x faster | — |
| array/sort-i32 | 2.71x faster | 2.65x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 4.01x faster | 4.09x faster | — |
| array/indexOf | 2.36x faster | 2.35x faster | — |
| array/slice | 2.34x faster | 2.31x faster | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.96x faster | 1.96x faster | — |
| array/find | 18.16x faster | 17.75x faster | 4.26x slower |
| dom/create-elements | 3.93x slower | — | — |
| dom/set-attributes | 4.42x slower | — | — |
| dom/read-attributes | 2.07x slower | — | — |
| dom/modify-text | 3.73x slower | — | — |
| mixed/csv-parse | 14.46x slower | 1.30x slower | — |
| mixed/text-search | 5.79x slower | 1.33x faster | 2.83x slower |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 1.38x faster |
| mixed/matrix-multiply | 1.12x slower | 1.11x slower | 3.85x slower |
| mixed/sieve | 1.17x faster | 1.23x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.36x faster |
| string/indexOf | 4.67x faster |
| string/includes | 8.16x faster |
| string/split | 9.38x faster |
| string/replace | 3.17x faster |
| string/case-convert | 42.26x faster |
| string/substring | 1.16x faster |
| string/trim | 4.73x faster |
| string/startsWith-endsWith | 7.86x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.02x slower |
| mixed/csv-parse | 11.12x faster |
| mixed/text-search | 7.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.05x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 928B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 2.2KB | 2.5KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 996.4ms | 851.9ms | — |
| string/concat-long | 477.7ms | 744.0ms | — |
| string/indexOf | 615.5ms | 761.6ms | 659.5ms |
| string/includes | 617.4ms | 743.1ms | 661.5ms |
| string/split | 584.1ms | 742.3ms | — |
| string/replace | 638.1ms | 823.4ms | — |
| string/case-convert | 608.3ms | 648.6ms | — |
| string/substring | 504.6ms | 559.8ms | — |
| string/trim | 563.5ms | 930.9ms | — |
| string/startsWith-endsWith | 580.9ms | 764.8ms | 685.7ms |
| array/push-pop | 593.2ms | 636.9ms | — |
| array/sort-i32 | 739.5ms | 775.6ms | — |
| array/map-filter | 722.2ms | 783.7ms | — |
| array/reduce | 650.5ms | 696.1ms | — |
| array/indexOf | 711.5ms | 769.1ms | — |
| array/slice | 595.0ms | 656.1ms | — |
| array/reverse | 593.7ms | 620.4ms | — |
| array/forEach | 718.2ms | 706.3ms | — |
| array/find | 559.8ms | 638.5ms | 632.8ms |
| dom/create-elements | 491.4ms | — | — |
| dom/set-attributes | 556.2ms | — | — |
| dom/read-attributes | 582.0ms | — | — |
| dom/modify-text | 482.7ms | — | — |
| mixed/csv-parse | 635.2ms | 757.7ms | — |
| mixed/text-search | 606.0ms | 765.5ms | 747.1ms |
| mixed/fibonacci | 627.8ms | 657.4ms | 614.4ms |
| mixed/matrix-multiply | 660.4ms | 694.5ms | 664.5ms |
| mixed/sieve | 651.2ms | 690.5ms | — |
