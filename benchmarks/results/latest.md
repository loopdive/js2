# js2wasm Benchmark Results

Date: 2026-09-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.048ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.131ms | 0.015ms | 0.020ms | gc-native |
| string/split | 0.438ms | 8.33ms | 2.83ms | FAILED | js |
| string/replace | 0.112ms | 0.687ms | 0.314ms | FAILED | js |
| string/case-convert | 0.056ms | 0.582ms | 0.263ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.90ms | 2.67ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.96ms | 2.98ms | 0.562ms | js |
| array/push-pop | 1.41ms | 0.505ms | 0.503ms | FAILED | gc-native |
| array/sort-i32 | 0.789ms | 0.348ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.126ms | 0.072ms | 0.073ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.510ms | 0.505ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.036ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.571ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.124ms | — | — | js |
| dom/modify-text | 0.035ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.474ms | 8.67ms | 0.602ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.92ms | 2.81ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.283ms | js |
| mixed/matrix-multiply | 0.157ms | 72.95ms | 72.73ms | 0.718ms | js |
| mixed/sieve | 1.58ms | 2.14ms | 2.16ms | FAILED | js |

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
| string/concat-short | 10000 | 3.20 | 4.75 | 4.87 | — |
| string/concat-long | 1000 | 3.60 | 4.55 | 3.63 | — |
| string/indexOf | 1000 | 19.14 | 63.59 | 12.25 | 14.59 |
| string/includes | 1000 | 19.24 | 131.28 | 14.56 | 19.63 |
| string/split | 10000 | 43.79 | 832.72 | 282.51 | — |
| string/replace | 1000 | 111.64 | 687.18 | 314.37 | — |
| string/case-convert | 2000 | 27.83 | 291.09 | 131.66 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.00 | 389.52 | 267.30 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 148.00 | 149.23 | 28.09 |
| array/map-filter | 30000 | 4.19 | 2.39 | 2.44 | — |
| array/indexOf | 1000 | 3949.48 | 2642.66 | 2640.64 | — |
| dom/create-elements | 2000 | 18.04 | 77.33 | — | — |
| dom/set-attributes | 6000 | 17.33 | 95.10 | — | — |
| dom/read-attributes | 3000 | 18.87 | 41.25 | — | — |
| dom/modify-text | 2000 | 17.49 | 53.49 | — | — |
| mixed/csv-parse | 11000 | 43.05 | 788.44 | 54.69 | — |
| mixed/text-search | 40000 | 9.75 | 123.07 | 70.30 | 27.20 |
| mixed/fibonacci | 10000 | 12.18 | 28.31 | 28.31 | 28.26 |
| mixed/matrix-multiply | 125000 | 1.26 | 583.57 | 581.82 | 5.74 |
| mixed/sieve | 200000 | 7.90 | 10.68 | 10.79 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.52x slower | — |
| string/concat-long | 1.26x slower | 1.01x slower | — |
| string/indexOf | 3.32x slower | 1.56x faster | 1.31x faster |
| string/includes | 6.82x slower | 1.32x faster | 1.02x slower |
| string/split | 19.02x slower | 6.45x slower | — |
| string/replace | 6.16x slower | 2.82x slower | — |
| string/case-convert | 10.46x slower | 4.73x slower | — |
| string/substring | 2.64x faster | 3.20x faster | — |
| string/trim | 22.91x slower | 15.72x slower | — |
| string/startsWith-endsWith | 7.38x slower | 7.44x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.81x faster | — |
| array/sort-i32 | 2.27x faster | 2.69x faster | — |
| array/map-filter | 1.76x faster | 1.72x faster | — |
| array/reduce | 4.22x faster | 4.26x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.74x faster | 1.75x faster | — |
| array/find | 16.15x faster | 16.01x faster | 4.25x slower |
| dom/create-elements | 4.29x slower | — | — |
| dom/set-attributes | 5.49x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.06x slower | — | — |
| mixed/csv-parse | 18.31x slower | 1.27x slower | — |
| mixed/text-search | 12.62x slower | 7.21x slower | 2.79x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 2.32x slower |
| mixed/matrix-multiply | 464.57x slower | 463.17x slower | 4.57x slower |
| mixed/sieve | 1.35x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.19x faster |
| string/includes | 9.02x faster |
| string/split | 2.95x faster |
| string/replace | 2.19x faster |
| string/case-convert | 2.21x faster |
| string/substring | 1.22x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.19x faster |
| array/map-filter | 1.02x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.42x faster |
| mixed/text-search | 1.75x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1670.1ms | 1082.8ms | — |
| string/concat-long | 749.9ms | 991.8ms | — |
| string/indexOf | 667.5ms | 985.8ms | 859.8ms |
| string/includes | 662.4ms | 962.0ms | 836.6ms |
| string/split | 800.6ms | 1022.5ms | — |
| string/replace | 780.5ms | 1045.5ms | — |
| string/case-convert | 781.0ms | 885.2ms | — |
| string/substring | 675.6ms | 760.6ms | — |
| string/trim | 752.6ms | 980.2ms | — |
| string/startsWith-endsWith | 768.6ms | 976.8ms | 917.6ms |
| array/push-pop | 798.7ms | 897.5ms | — |
| array/sort-i32 | 942.3ms | 1030.2ms | — |
| array/map-filter | 968.6ms | 1084.8ms | — |
| array/reduce | 884.8ms | 956.6ms | — |
| array/indexOf | 836.0ms | 961.9ms | — |
| array/slice | 765.4ms | 884.1ms | — |
| array/reverse | 798.5ms | 852.2ms | — |
| array/forEach | 880.3ms | 1028.7ms | — |
| array/find | 778.9ms | 869.9ms | 850.5ms |
| dom/create-elements | 692.8ms | — | — |
| dom/set-attributes | 743.6ms | — | — |
| dom/read-attributes | 727.9ms | — | — |
| dom/modify-text | 708.3ms | — | — |
| mixed/csv-parse | 816.1ms | 990.9ms | — |
| mixed/text-search | 804.3ms | 1039.8ms | 954.8ms |
| mixed/fibonacci | 760.3ms | 804.5ms | 763.5ms |
| mixed/matrix-multiply | 903.4ms | 962.9ms | 796.7ms |
| mixed/sieve | 857.7ms | 959.4ms | — |
