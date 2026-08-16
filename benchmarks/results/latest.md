# js2wasm Benchmark Results

Date: 2026-08-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.045ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.131ms | 0.014ms | 0.016ms | gc-native |
| string/split | 0.425ms | 4.87ms | 0.451ms | FAILED | js |
| string/replace | 0.111ms | 0.302ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.241ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.903ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.358ms | 0.295ms | 0.561ms | gc-native |
| array/push-pop | 1.38ms | 0.499ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.792ms | 0.296ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.125ms | 0.069ms | 0.069ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.503ms | 0.498ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 0.994ms | gc-native |
| dom/create-elements | 0.253ms | 0.161ms | — | — | host-call |
| dom/set-attributes | 0.103ms | 0.477ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.123ms | — | — | js |
| dom/modify-text | 0.033ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.498ms | 7.01ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.70ms | 0.265ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.289ms | js |
| mixed/matrix-multiply | 0.157ms | 0.225ms | 0.209ms | 0.713ms | js |
| mixed/sieve | 1.55ms | 1.39ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.77 | 4.54 | 3.79 | — |
| string/concat-long | 1000 | 3.53 | 4.49 | 3.50 | — |
| string/indexOf | 1000 | 19.15 | 62.52 | 12.01 | 14.56 |
| string/includes | 1000 | 19.18 | 131.10 | 14.46 | 16.47 |
| string/split | 10000 | 42.47 | 487.37 | 45.10 | — |
| string/replace | 1000 | 110.62 | 301.94 | 56.32 | — |
| string/case-convert | 2000 | 28.20 | 120.66 | 2.51 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.95 | 90.31 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 17.88 | 14.76 | 28.06 |
| array/map-filter | 30000 | 4.17 | 2.31 | 2.32 | — |
| array/indexOf | 1000 | 3948.61 | 2633.32 | 2632.64 | — |
| dom/create-elements | 2000 | 126.36 | 80.63 | — | — |
| dom/set-attributes | 6000 | 17.17 | 79.46 | — | — |
| dom/read-attributes | 3000 | 18.67 | 41.11 | — | — |
| dom/modify-text | 2000 | 16.42 | 54.96 | — | — |
| mixed/csv-parse | 11000 | 45.26 | 637.00 | 28.69 | — |
| mixed/text-search | 40000 | 9.73 | 42.62 | 6.63 | 27.02 |
| mixed/fibonacci | 10000 | 12.17 | 29.24 | 29.23 | 28.86 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.80 | 1.68 | 5.71 |
| mixed/sieve | 200000 | 7.76 | 6.95 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.64x slower | 1.37x slower | — |
| string/concat-long | 1.27x slower | 1.01x faster | — |
| string/indexOf | 3.27x slower | 1.59x faster | 1.31x faster |
| string/includes | 6.83x slower | 1.33x faster | 1.16x faster |
| string/split | 11.48x slower | 1.06x slower | — |
| string/replace | 2.73x slower | 1.96x faster | — |
| string/case-convert | 4.28x slower | 11.25x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.33x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.75x faster | 2.73x faster | — |
| array/sort-i32 | 2.67x faster | 2.71x faster | — |
| array/map-filter | 1.80x faster | 1.80x faster | — |
| array/reduce | 4.28x faster | 4.32x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.11x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.73x faster | — |
| array/find | 15.96x faster | 16.25x faster | 3.93x slower |
| dom/create-elements | 1.57x faster | — | — |
| dom/set-attributes | 4.63x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.35x slower | — | — |
| mixed/csv-parse | 14.08x slower | 1.58x faster | — |
| mixed/text-search | 4.38x slower | 1.47x faster | 2.78x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.37x slower |
| mixed/matrix-multiply | 1.43x slower | 1.33x slower | 4.54x slower |
| mixed/sieve | 1.12x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.21x faster |
| string/includes | 9.07x faster |
| string/split | 10.81x faster |
| string/replace | 5.36x faster |
| string/case-convert | 48.12x faster |
| string/substring | 1.22x faster |
| string/trim | 4.84x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 22.21x faster |
| mixed/text-search | 6.43x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.08x faster |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1314.7ms | 1101.6ms | — |
| string/concat-long | 636.2ms | 962.2ms | — |
| string/indexOf | 642.1ms | 945.5ms | 840.5ms |
| string/includes | 644.0ms | 963.1ms | 824.4ms |
| string/split | 748.1ms | 921.8ms | — |
| string/replace | 763.4ms | 1024.8ms | — |
| string/case-convert | 772.7ms | 816.9ms | — |
| string/substring | 651.7ms | 734.2ms | — |
| string/trim | 721.4ms | 977.9ms | — |
| string/startsWith-endsWith | 751.0ms | 974.0ms | 883.3ms |
| array/push-pop | 777.0ms | 834.7ms | — |
| array/sort-i32 | 896.2ms | 966.6ms | — |
| array/map-filter | 916.5ms | 945.8ms | — |
| array/reduce | 816.9ms | 903.0ms | — |
| array/indexOf | 844.7ms | 913.9ms | — |
| array/slice | 780.4ms | 848.0ms | — |
| array/reverse | 741.5ms | 801.4ms | — |
| array/forEach | 849.7ms | 959.8ms | — |
| array/find | 744.8ms | 819.1ms | 817.5ms |
| dom/create-elements | 650.2ms | — | — |
| dom/set-attributes | 701.0ms | — | — |
| dom/read-attributes | 687.6ms | — | — |
| dom/modify-text | 594.3ms | — | — |
| mixed/csv-parse | 797.5ms | 942.6ms | — |
| mixed/text-search | 755.5ms | 1007.2ms | 913.2ms |
| mixed/fibonacci | 737.1ms | 776.2ms | 781.9ms |
| mixed/matrix-multiply | 822.1ms | 900.3ms | 781.5ms |
| mixed/sieve | 829.3ms | 880.4ms | — |
