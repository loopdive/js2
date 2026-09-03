# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.039ms | 0.036ms | FAILED | gc-native |
| string/concat-long | 0.003ms | 0.003ms | 0.004ms | FAILED | js |
| string/indexOf | 0.014ms | 0.045ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.014ms | 0.089ms | 0.012ms | 0.031ms | gc-native |
| string/split | 0.299ms | 5.85ms | 2.14ms | FAILED | js |
| string/replace | 0.080ms | 0.441ms | 0.244ms | FAILED | js |
| string/case-convert | 0.042ms | 0.402ms | 0.204ms | FAILED | js |
| string/substring | 0.098ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.140ms | 2.83ms | 2.05ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.25ms | 2.23ms | 0.477ms | js |
| array/push-pop | 1.08ms | 0.365ms | 0.362ms | FAILED | gc-native |
| array/sort-i32 | 0.544ms | 0.285ms | 0.285ms | FAILED | gc-native |
| array/map-filter | 0.100ms | 0.062ms | 0.062ms | FAILED | host-call |
| array/reduce | 1.73ms | 0.413ms | 0.352ms | FAILED | gc-native |
| array/indexOf | 4.49ms | 2.23ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.017ms | 0.024ms | 0.017ms | FAILED | gc-native |
| array/reverse | 7.04ms | 3.17ms | 3.17ms | FAILED | host-call |
| array/forEach | 0.040ms | 0.022ms | 0.019ms | FAILED | gc-native |
| array/find | 0.243ms | 0.015ms | 0.012ms | 0.832ms | gc-native |
| dom/create-elements | 0.033ms | 0.136ms | — | — | js |
| dom/set-attributes | 0.089ms | 0.427ms | — | — | js |
| dom/read-attributes | 0.040ms | 0.088ms | — | — | js |
| dom/modify-text | 0.029ms | 0.077ms | — | — | js |
| mixed/csv-parse | 0.345ms | 5.75ms | 0.478ms | FAILED | js |
| mixed/text-search | 0.373ms | 3.35ms | 2.18ms | 0.975ms | js |
| mixed/fibonacci | 0.114ms | 0.181ms | 0.181ms | 0.887ms | js |
| mixed/matrix-multiply | 0.162ms | 52.40ms | 53.30ms | 0.605ms | js |
| mixed/sieve | 1.39ms | 2.06ms | 2.07ms | FAILED | js |

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
| string/concat-short | 10000 | 4.39 | 3.86 | 3.62 | — |
| string/concat-long | 1000 | 3.09 | 3.34 | 3.54 | — |
| string/indexOf | 1000 | 14.07 | 44.79 | 9.54 | 13.49 |
| string/includes | 1000 | 14.07 | 89.38 | 11.96 | 31.37 |
| string/split | 10000 | 29.89 | 584.53 | 213.69 | — |
| string/replace | 1000 | 80.02 | 440.52 | 244.48 | — |
| string/case-convert | 2000 | 21.01 | 200.92 | 102.00 | — |
| string/substring | 10000 | 9.83 | 3.17 | 2.71 | — |
| string/trim | 10000 | 14.03 | 283.21 | 204.50 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 112.48 | 111.70 | 23.85 |
| array/map-filter | 30000 | 3.34 | 2.07 | 2.07 | — |
| array/indexOf | 1000 | 4492.96 | 2225.79 | 2224.75 | — |
| dom/create-elements | 2000 | 16.52 | 67.83 | — | — |
| dom/set-attributes | 6000 | 14.84 | 71.24 | — | — |
| dom/read-attributes | 3000 | 13.17 | 29.18 | — | — |
| dom/modify-text | 2000 | 14.36 | 38.60 | — | — |
| mixed/csv-parse | 11000 | 31.35 | 523.16 | 43.48 | — |
| mixed/text-search | 40000 | 9.32 | 83.69 | 54.51 | 24.37 |
| mixed/fibonacci | 10000 | 11.45 | 18.05 | 18.06 | 88.75 |
| mixed/matrix-multiply | 125000 | 1.30 | 419.22 | 426.39 | 4.84 |
| mixed/sieve | 200000 | 6.94 | 10.30 | 10.35 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.14x faster | 1.21x faster | — |
| string/concat-long | 1.08x slower | 1.15x slower | — |
| string/indexOf | 3.18x slower | 1.47x faster | 1.04x faster |
| string/includes | 6.35x slower | 1.18x faster | 2.23x slower |
| string/split | 19.56x slower | 7.15x slower | — |
| string/replace | 5.50x slower | 3.06x slower | — |
| string/case-convert | 9.57x slower | 4.86x slower | — |
| string/substring | 3.10x faster | 3.63x faster | — |
| string/trim | 20.19x slower | 14.58x slower | — |
| string/startsWith-endsWith | 5.60x slower | 5.56x slower | 1.19x slower |
| array/push-pop | 2.95x faster | 2.97x faster | — |
| array/sort-i32 | 1.91x faster | 1.91x faster | — |
| array/map-filter | 1.62x faster | 1.61x faster | — |
| array/reduce | 4.20x faster | 4.92x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.40x slower | 1.03x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.85x faster | 2.11x faster | — |
| array/find | 16.32x faster | 21.00x faster | 3.43x slower |
| dom/create-elements | 4.11x slower | — | — |
| dom/set-attributes | 4.80x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 2.69x slower | — | — |
| mixed/csv-parse | 16.69x slower | 1.39x slower | — |
| mixed/text-search | 8.98x slower | 5.85x slower | 2.62x slower |
| mixed/fibonacci | 1.58x slower | 1.58x slower | 7.75x slower |
| mixed/matrix-multiply | 323.04x slower | 328.57x slower | 3.73x slower |
| mixed/sieve | 1.48x slower | 1.49x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.06x slower |
| string/indexOf | 4.69x faster |
| string/includes | 7.47x faster |
| string/split | 2.74x faster |
| string/replace | 1.80x faster |
| string/case-convert | 1.97x faster |
| string/substring | 1.17x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.17x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.44x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.14x faster |
| array/find | 1.29x faster |
| mixed/csv-parse | 12.03x faster |
| mixed/text-search | 1.54x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1310.1ms | 867.0ms | — |
| string/concat-long | 610.4ms | 775.0ms | — |
| string/indexOf | 533.5ms | 799.2ms | 680.2ms |
| string/includes | 531.9ms | 814.1ms | 685.0ms |
| string/split | 610.2ms | 788.2ms | — |
| string/replace | 623.3ms | 855.1ms | — |
| string/case-convert | 621.8ms | 706.2ms | — |
| string/substring | 530.4ms | 617.8ms | — |
| string/trim | 600.4ms | 784.0ms | — |
| string/startsWith-endsWith | 602.3ms | 785.8ms | 713.9ms |
| array/push-pop | 625.3ms | 710.6ms | — |
| array/sort-i32 | 746.3ms | 823.8ms | — |
| array/map-filter | 758.2ms | 815.2ms | — |
| array/reduce | 714.4ms | 800.1ms | — |
| array/indexOf | 704.1ms | 789.9ms | — |
| array/slice | 633.5ms | 705.8ms | — |
| array/reverse | 633.6ms | 697.0ms | — |
| array/forEach | 696.7ms | 817.3ms | — |
| array/find | 628.4ms | 695.4ms | 668.4ms |
| dom/create-elements | 558.5ms | — | — |
| dom/set-attributes | 563.5ms | — | — |
| dom/read-attributes | 549.5ms | — | — |
| dom/modify-text | 553.6ms | — | — |
| mixed/csv-parse | 677.6ms | 788.8ms | — |
| mixed/text-search | 635.3ms | 801.7ms | 743.3ms |
| mixed/fibonacci | 598.8ms | 650.0ms | 616.5ms |
| mixed/matrix-multiply | 754.0ms | 780.8ms | 661.2ms |
| mixed/sieve | 694.7ms | 789.0ms | — |
